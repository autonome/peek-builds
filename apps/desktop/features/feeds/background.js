/**
 * Feeds Extension - Simple RSS/Atom Feed Reader
 *
 * Demonstrates:
 * - Using the 'feed' item type for subscriptions
 * - Using item_events for feed entries
 * - Polling feeds and parsing RSS/Atom
 * - Commands for subscribing and viewing feeds
 * - Running unattended: the poll interval is declared as a schedule on the
 *   background tile in manifest.json, so main owns the timer and wakes this
 *   tile when a poll comes due. This tile holds no timer of its own, which is
 *   what lets it sleep between polls.
 */

import { registerNoun, unregisterNoun } from 'peek://cmd/nouns.js';

const api = window.app;

// ==================== Feed Parsing ====================

/**
 * Parse RSS or Atom feed XML into normalized entries
 */
function parseFeed(xml, feedUrl) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');

  // Check for parse errors
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    throw new Error('Invalid XML: ' + parseError.textContent);
  }

  // Detect feed type and parse accordingly
  const rssChannel = doc.querySelector('channel');
  const atomFeed = doc.querySelector('feed');

  if (rssChannel) {
    return parseRSS(rssChannel, feedUrl);
  } else if (atomFeed) {
    return parseAtom(atomFeed, feedUrl);
  } else {
    throw new Error('Unknown feed format');
  }
}

/**
 * Parse RSS 2.0 feed
 */
function parseRSS(channel, feedUrl) {
  const title = channel.querySelector('title')?.textContent || feedUrl;
  const items = channel.querySelectorAll('item');

  const entries = [];
  for (const item of items) {
    const link = item.querySelector('link')?.textContent;
    const guid = item.querySelector('guid')?.textContent || link;
    const pubDate = item.querySelector('pubDate')?.textContent;

    entries.push({
      guid: guid || link || `${feedUrl}#${entries.length}`,
      title: item.querySelector('title')?.textContent || 'Untitled',
      link: link || '',
      author: item.querySelector('author')?.textContent ||
              item.querySelector('dc\\:creator')?.textContent || '',
      description: item.querySelector('description')?.textContent || '',
      pubDate: pubDate ? new Date(pubDate).getTime() : Date.now()
    });
  }

  return { title, entries };
}

/**
 * Parse Atom feed
 */
function parseAtom(feed, feedUrl) {
  const title = feed.querySelector('title')?.textContent || feedUrl;
  const items = feed.querySelectorAll('entry');

  const entries = [];
  for (const item of items) {
    const link = item.querySelector('link[rel="alternate"]')?.getAttribute('href') ||
                 item.querySelector('link')?.getAttribute('href');
    const id = item.querySelector('id')?.textContent || link;
    const published = item.querySelector('published')?.textContent ||
                      item.querySelector('updated')?.textContent;

    entries.push({
      guid: id || link || `${feedUrl}#${entries.length}`,
      title: item.querySelector('title')?.textContent || 'Untitled',
      link: link || '',
      author: item.querySelector('author name')?.textContent || '',
      description: item.querySelector('summary')?.textContent ||
                   item.querySelector('content')?.textContent || '',
      pubDate: published ? new Date(published).getTime() : Date.now()
    });
  }

  return { title, entries };
}

// ==================== Feed Operations ====================

/**
 * Subscribe to a new feed
 */
async function subscribeFeed(url) {
  // Check if already subscribed
  const existing = await api.datastore.queryItems({ type: 'feed' });
  if (existing.success) {
    const alreadySubscribed = existing.data.find(f => f.content === url);
    if (alreadySubscribed) {
      return { success: false, error: 'Already subscribed to this feed' };
    }
  }

  // Fetch and parse to validate and get title
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const xml = await response.text();
    const { title } = parseFeed(xml, url);

    // Create feed item
    const result = await api.datastore.addItem('feed', {
      content: url,
      metadata: JSON.stringify({
        name: title,
        format: 'rss',
        lastPolledAt: 0,
        errorCount: 0
      })
    });

    if (result.success) {
      // Poll immediately
      await pollFeed(result.data.id, url);
      return { success: true, data: { id: result.data.id, title, url } };
    }
    return result;
  } catch (error) {
    console.error('[feeds] Subscribe error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Unsubscribe from a feed
 */
async function unsubscribeFeed(feedId) {
  // Delete all entries first
  await api.datastore.deleteItemEvents(feedId);
  // Delete the feed item
  return await api.datastore.deleteItem(feedId);
}

/**
 * Get all subscribed feeds
 */
async function getFeeds() {
  const result = await api.datastore.queryItems({ type: 'feed' });
  if (!result.success) return [];

  return result.data.map(item => {
    let metadata = {};
    try {
      metadata = JSON.parse(item.metadata || '{}');
    } catch {}
    return {
      id: item.id,
      url: item.content,
      name: metadata.name || item.content,
      lastPolledAt: metadata.lastPolledAt || 0,
      errorCount: metadata.errorCount || 0
    };
  });
}

/**
 * Poll a single feed for new entries
 */
async function pollFeed(feedId, feedUrl) {
  try {
    const response = await fetch(feedUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const xml = await response.text();
    const { title, entries } = parseFeed(xml, feedUrl);

    // Get existing entries to avoid duplicates
    const existingEvents = await api.datastore.queryItemEvents({ itemId: feedId, limit: 100 });
    const existingGuids = new Set();
    if (existingEvents.success) {
      for (const event of existingEvents.data) {
        try {
          const meta = JSON.parse(event.metadata || '{}');
          if (meta.guid) existingGuids.add(meta.guid);
        } catch {}
      }
    }

    // Add new entries
    let newCount = 0;
    for (const entry of entries) {
      if (existingGuids.has(entry.guid)) continue;

      await api.datastore.addItemEvent(feedId, {
        content: entry.link,
        occurredAt: entry.pubDate,
        metadata: JSON.stringify({
          guid: entry.guid,
          title: entry.title,
          author: entry.author,
          description: entry.description?.slice(0, 500) // Truncate long descriptions
        })
      });
      newCount++;
    }

    // Update feed metadata
    await api.datastore.updateItem(feedId, {
      metadata: JSON.stringify({
        name: title,
        format: 'rss',
        lastPolledAt: Date.now(),
        errorCount: 0
      })
    });

    return { success: true, newCount };
  } catch (error) {
    console.error('[feeds] Poll error:', feedUrl, error);

    // Increment error count
    const item = await api.datastore.getItem(feedId);
    if (item.success && item.data) {
      let metadata = {};
      try { metadata = JSON.parse(item.data.metadata || '{}'); } catch {}
      metadata.errorCount = (metadata.errorCount || 0) + 1;
      metadata.lastError = error.message;
      await api.datastore.updateItem(feedId, {
        metadata: JSON.stringify(metadata)
      });
    }

    return { success: false, error: error.message };
  }
}

/**
 * Poll all feeds
 */
async function pollAllFeeds() {
  const feeds = await getFeeds();
  for (const feed of feeds) {
    await pollFeed(feed.id, feed.url);
  }
}

/**
 * Get entries for a feed or all feeds
 */
async function getEntries(feedId = null, limit = 50) {
  const filter = { limit, order: 'desc' };

  if (feedId) {
    filter.itemId = feedId;
  } else {
    // Get all feeds to query their entries
    const feeds = await getFeeds();
    if (feeds.length === 0) return [];
    filter.itemIds = feeds.map(f => f.id);
  }

  const result = await api.datastore.queryItemEvents(filter);
  if (!result.success) return [];

  return result.data.map(event => {
    let metadata = {};
    try { metadata = JSON.parse(event.metadata || '{}'); } catch {}
    return {
      id: event.id,
      feedId: event.itemId,
      url: event.content,
      title: metadata.title || event.content,
      author: metadata.author || '',
      description: metadata.description || '',
      pubDate: event.occurredAt
    };
  });
}

// ==================== UI ====================

function openFeedsUI() {
  api.window.open('peek://feeds/feeds.html', {
    key: 'feeds-reader',
    width: 900,
    height: 700,
    title: 'Feed Reader'
  });
}

// ==================== Extension ====================

const extension = {
  id: 'feeds',
  labels: {
    name: 'Feed Reader'
  },

  registerCommands() {
    // Register noun for auto-generated browse/list/create commands
    registerNoun({
      name: 'feeds',
      singular: 'feed',
      description: 'RSS/Atom feed subscriptions',

      query: async ({ search }) => {
        const feeds = await getFeeds();
        let filtered = feeds;
        if (search) {
          const s = search.toLowerCase();
          filtered = feeds.filter(f => f.name.toLowerCase().includes(s) || f.url.toLowerCase().includes(s));
        }
        if (filtered.length === 0) {
          return { output: 'No feeds found.', mimeType: 'text/plain' };
        }
        return {
          success: true,
          output: {
            data: filtered,
            mimeType: 'application/json',
            title: `Feeds (${filtered.length})`
          }
        };
      },

      browse: async () => { openFeedsUI(); },

      create: async ({ search }) => {
        if (!search || !search.startsWith('http')) {
          openFeedsUI();
          return { success: true, message: 'Opening feed reader' };
        }
        const result = await subscribeFeed(search.trim());
        if (result.success) {
          openFeedsUI();
        }
        return result;
      },

      produces: 'application/json'
    });

    // Refresh is a verb action, not a noun capability — keep as regular command
    api.commands.register({
      name: 'refresh feeds',
      description: 'Refresh all feeds',
      execute: pollAllFeeds
    });

  },

  init() {
    // The schedule wake handler goes first and stays synchronous: the publish
    // that woke this tile is delivered as soon as the preload reports ready,
    // and a handler registered after an await would miss it.
    api.pubsub.subscribe('feeds:poll', () => pollAllFeeds());

    // Register commands (cmd loads first with its subscribers ready via 100ms head start)
    this.registerCommands();

    // Register global shortcut (Option+Shift+F to avoid conflict with lists' Option+F)
    api.shortcuts.register('Option+Shift+F', openFeedsUI, { global: true });

    // React to feed item changes from other sources
    api.pubsub.subscribe('item:created', async (msg) => {
      if (msg.itemType === 'feed') {
        const item = await api.datastore.getItem(msg.itemId);
        if (item.success && item.data) {
          await pollFeed(msg.itemId, item.data.content);
        }
      }
    });

  },

  uninit() {
    api.shortcuts.unregister('Option+Shift+F', { global: true });
    unregisterNoun('feeds');
    api.commands.unregister('refresh feeds');
  }
};

export default extension;

// Export for UI
export { getFeeds, getEntries, subscribeFeed, unsubscribeFeed, pollFeed, pollAllFeeds };
