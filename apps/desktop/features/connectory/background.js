/**
 * Connectory — an item tagged `event:source` is an organizer's calendar or
 * event feed, checked on a schedule, and each event not seen before is saved as
 * an item tagged `event:new`.
 *
 * The decisions all live in `events.js`, which is pure. This file is the
 * wiring: it answers the `connectory:check` schedule, fetches each source,
 * reduces an RSS/Atom body to plain entries with `DOMParser` (the one step that
 * needs a document), and applies what the plan returns through `api.datastore`.
 *
 * The identities already saved are kept in this feature's settings rather than
 * read back off the event items: removing `event:new` from an event dismisses
 * it, and deleting the item must not bring it back on the next check.
 */

import {
  EVENT_NEW_QUERY,
  EVENT_NEW_TAG,
  EVENT_SOURCE_TAG,
  UNTITLED_EVENT,
  eventMetadata,
  eventsFromFeedEntries,
  looksLikeICal,
  parseICal,
  planNewEvents,
} from './events.js';

const id = 'connectory';
const api = window.app;

/** Settings key holding `{ [sourceItemId]: uid[] }`, newest identity first. */
const SEEN_KEY = 'seen';

/** The stored identity lists, mirroring the settings key above. */
let seenBySource = {};

/**
 * Resolves once settings have been read. Handler bodies wait on it: the
 * publish that wakes this tile lands before async init finishes, and a check
 * that ran against an empty seen map would save every event again.
 */
let settingsLoaded = null;

/** Serialises checks, so a schedule fire landing on a slow check queues behind it. */
let running = Promise.resolve();

async function loadSeen() {
  try {
    const res = await api.settings.get(SEEN_KEY);
    const stored = res?.value ?? res?.data;
    seenBySource = stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...stored } : {};
  } catch (error) {
    console.error(`[ext:${id}] Failed to read ${SEEN_KEY}:`, error);
    seenBySource = {};
  }
}

async function saveSeen() {
  try {
    await api.settings.set(SEEN_KEY, seenBySource);
  } catch (error) {
    console.error(`[ext:${id}] Failed to write ${SEEN_KEY}:`, error);
  }
}

/** `metadata` comes back from the datastore as a JSON string. */
function parseMetadata(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

function tagNames(tags) {
  if (!Array.isArray(tags)) return [];
  const names = [];
  for (const tag of tags) {
    if (typeof tag === 'string') names.push(tag);
    else if (tag && typeof tag.name === 'string') names.push(tag.name);
  }
  return names;
}

/**
 * The items tagged `event:source`. Read from the whole item-tag map rather than
 * by tag id, so a profile that has never had a source does not gain the tag
 * just by being checked.
 */
async function sourceItemIds() {
  const res = await api.datastore.getAllItemTags();
  if (!res?.success) {
    console.error(`[ext:${id}] getAllItemTags failed:`, res?.error);
    return [];
  }
  const ids = [];
  for (const [itemId, tags] of Object.entries(res.data || {})) {
    if (tagNames(tags).includes(EVENT_SOURCE_TAG)) ids.push(itemId);
  }
  return ids;
}

const textOf = node => (node && typeof node.textContent === 'string' ? node.textContent.trim() : '');

/** RSS 2.0 `item`s as plain entries. */
function rssEntries(channel) {
  const entries = [];
  for (const item of channel.querySelectorAll('item')) {
    entries.push({
      id: textOf(item.querySelector('guid')),
      title: textOf(item.querySelector('title')),
      link: textOf(item.querySelector('link')),
      published: textOf(item.querySelector('pubDate')),
    });
  }
  return entries;
}

/** Atom `entry`s as plain entries. */
function atomEntries(feed) {
  const entries = [];
  for (const entry of feed.querySelectorAll('entry')) {
    const link = entry.querySelector('link[rel="alternate"]')?.getAttribute('href')
      || entry.querySelector('link')?.getAttribute('href')
      || '';
    entries.push({
      id: textOf(entry.querySelector('id')),
      title: textOf(entry.querySelector('title')),
      link: link.trim(),
      published: textOf(entry.querySelector('published')) || textOf(entry.querySelector('updated')),
    });
  }
  return entries;
}

/**
 * An RSS or Atom body reduced to plain entries, or `null` when neither parser
 * accepts it. The `DOMParser` work stops here: everything past this point is
 * the pure logic in `events.js`.
 */
function parseFeedEntries(xml) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(xml, 'text/xml');
  } catch {
    return null;
  }
  if (!doc || doc.querySelector('parsererror')) return null;
  const channel = doc.querySelector('channel');
  if (channel) return rssEntries(channel);
  const feed = doc.querySelector('feed');
  if (feed) return atomEntries(feed);
  return null;
}

/**
 * The events a response body holds, or `null` when the body is neither iCal nor
 * RSS/Atom. A calendar carrying no `VEVENT` is an accepted body with no events,
 * not a bad one.
 */
function eventsFromBody(body) {
  if (looksLikeICal(body)) return parseICal(body);
  const entries = parseFeedEntries(body);
  return entries ? eventsFromFeedEntries(entries) : null;
}

/** Record what this check made of a source, keeping its other metadata. */
async function writeSourceStatus(itemId, status) {
  try {
    const res = await api.datastore.getItem(itemId);
    const metadata = res?.success && res.data ? parseMetadata(res.data.metadata) : {};
    metadata.connectory = status;
    await api.datastore.updateItem(itemId, { metadata: JSON.stringify(metadata) });
  } catch (error) {
    console.error(`[ext:${id}] Failed to record status for ${itemId}:`, error);
  }
}

/**
 * Save one event: a URL item when it has a link, a text item titled with its
 * summary otherwise. Returns the new item's id.
 */
async function saveEvent(event) {
  const title = event.title || UNTITLED_EVENT;
  const metadata = JSON.stringify({ title, event: eventMetadata(event) });
  const added = event.url
    ? await api.datastore.addItem('url', { content: event.url, metadata })
    : await api.datastore.addItem('text', { content: title, metadata });
  if (!added?.success || !added.data?.id) {
    throw new Error(`addItem failed for ${event.uid}: ${added?.error || 'unknown error'}`);
  }
  const tag = await api.datastore.getOrCreateTag(EVENT_NEW_TAG);
  if (!tag?.success) {
    throw new Error(`getOrCreateTag failed for ${EVENT_NEW_TAG}: ${tag?.error || 'unknown error'}`);
  }
  await api.datastore.tagItem(added.data.id, tag.data.tag.id);
  return added.data.id;
}

/**
 * One source: fetch, parse, plan, save. Returns the number of events saved.
 *
 * A source that fails records its error and produces no events; the caller goes
 * on to the next one.
 */
async function checkSource(itemId, now) {
  const checkedAt = new Date(now).toISOString();
  const res = await api.datastore.getItem(itemId);
  if (!res?.success || !res.data) {
    console.error(`[ext:${id}] Failed to read source ${itemId}:`, res?.error);
    return 0;
  }

  const url = typeof res.data.content === 'string' ? res.data.content.trim() : '';
  if (!/^https?:\/\//i.test(url)) {
    await writeSourceStatus(itemId, { error: 'source item holds no http URL', checkedAt });
    return 0;
  }

  let body;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    body = await response.text();
  } catch (error) {
    await writeSourceStatus(itemId, { error: String(error?.message || error), checkedAt });
    return 0;
  }

  const events = eventsFromBody(body);
  if (!events) {
    await writeSourceStatus(itemId, { error: 'body is neither iCal nor RSS/Atom', checkedAt });
    return 0;
  }

  const { toSave, seen } = planNewEvents(itemId, events, seenBySource[itemId] || [], now);

  const failed = new Set();
  let saved = 0;
  for (const event of toSave) {
    try {
      await saveEvent(event);
      saved += 1;
    } catch (error) {
      console.error(`[ext:${id}] Failed to save event ${event.uid}:`, error);
      failed.add(event.uid);
    }
  }

  // An event whose save failed is not recorded as seen, so the next check
  // tries it again rather than losing it.
  seenBySource[itemId] = failed.size === 0 ? seen : seen.filter(uid => !failed.has(uid));
  await writeSourceStatus(itemId, { checkedAt });
  return saved;
}

/** One pass over every source. Returns the number of events saved. */
async function runCheck(now = Date.now()) {
  const itemIds = await sourceItemIds();
  if (itemIds.length === 0) return 0;

  let saved = 0;
  for (const itemId of itemIds) {
    try {
      saved += await checkSource(itemId, now);
    } catch (error) {
      console.error(`[ext:${id}] Check failed for source ${itemId}:`, error);
    }
  }

  await saveSeen();
  if (saved > 0) console.log(`[ext:${id}] Saved ${saved} new event(s)`);
  return saved;
}

const init = async () => {
  // Register the wake handlers synchronously, before any await: the publish
  // that woke this tile is delivered on the macrotask after `tile:lifecycle:
  // ready`, so a handler registered after an await misses it.
  api.commands.register({
    name: 'events',
    description: 'List events newly found in the feeds you follow',
    execute: async () => {
      // Two listeners in the search tile answer this topic — the `search`
      // command it registers, which reads `text`, and its own subscribe, which
      // reads `data.query` — and the first window open wins, so both keys
      // carry the query (`features/search/background.js`).
      api.pubsub.publish('cmd:execute:search', {
        text: EVENT_NEW_QUERY,
        data: { query: EVENT_NEW_QUERY },
      });
    },
  });

  api.pubsub.subscribe('connectory:check', async () => {
    await settingsLoaded;
    running = running.then(() => runCheck()).catch(error => {
      console.error(`[ext:${id}] Check failed:`, error);
    });
    await running;
  });

  settingsLoaded = loadSeen();
  await settingsLoaded;
};

const uninit = () => {};

export default { id, labels: { name: 'Connectory' }, init, uninit };
