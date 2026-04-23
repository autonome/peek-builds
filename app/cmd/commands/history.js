/**
 * History command - search and open pages from saved URLs
 * URLs are sorted by recent first (createdAt descending)
 */
import windows from 'peek://app/windows.js';
import api from 'peek://app/api.js';

const debug = window.app?.debug;

// Store callbacks for reactive updates
let _addCommand = null;
let _batchApi = null;

// Cache: Set of URL content strings currently registered as commands
let _registeredUrls = new Set();
// Cache: Map of URL -> title for registered items
let _registeredTitles = new Map();
// Guard: only subscribe to reactive events once
let _subscribedToEvents = false;

/**
 * Get URL items sorted by most recent
 * Optionally filter by search term
 */
const getHistory = async (searchTerm = '', limit = 200) => {
  // Query by frecency so frequently-visited URLs rank highest
  const result = await api.datastore.queryItems({ type: 'url', sortBy: 'frecency' });
  if (!result.success) return [];

  let items = result.data;

  // Filter by search term if provided (check URL content and metadata title)
  if (searchTerm) {
    const lower = searchTerm.toLowerCase();
    items = items.filter(item => {
      const url = (item.content || '').toLowerCase();
      let title = '';
      if (item.metadata) {
        try {
          const meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata;
          title = (meta.title || '').toLowerCase();
        } catch (e) {}
      }
      return url.includes(lower) || title.includes(lower);
    });
  }

  return items.slice(0, limit);
};

/**
 * Open a URL from history
 */
const openFromHistory = async (url) => {
  try {
    const windowController = await windows.createWindow(url, {
      width: 1024,
      height: 768,
      openDevTools: window.app.debug,
      trackingSource: 'cmd',
      trackingSourceId: 'history'
    });
    console.log('Opened from history:', url, 'window:', windowController.id);
    return { success: true };
  } catch (error) {
    console.error('Failed to open from history:', error);
    return { success: false, error: error.message };
  }
};

/**
 * Get display title for an item
 */
const getItemTitle = (item) => {
  if (item.metadata) {
    try {
      const meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata;
      if (meta.title) return meta.title;
    } catch (e) {}
  }
  return item.content || 'Untitled';
};

// Commands
const commands = [
  {
    name: 'history',
    description: 'Search and open saved URLs',
    async execute(ctx) {
      if (ctx.search) {
        // Search provided - find matching URL and open it
        const matches = await getHistory(ctx.search, 1);
        if (matches.length > 0) {
          await openFromHistory(matches[0].content);
        } else {
          console.log('No history matches for:', ctx.search);
        }
      } else {
        // No search - just log recent history
        const recent = await getHistory('', 10);
        if (recent.length === 0) {
          console.log('No saved URLs yet');
        } else {
          console.log('Recent URLs:');
          recent.forEach((item, i) => {
            console.log(`${i + 1}. ${getItemTitle(item)}`);
          });
        }
      }
    }
  }
];

/**
 * Register a single item as history commands (URL + title)
 * @param {Function} addFn - Function to register the command (addCommand or addCommandSilent)
 * @param {Object} item - The history item
 */
const registerHistoryItem = (addFn, item) => {
  const url = item.content;
  const title = getItemTitle(item);

  addFn({
    name: url,
    async execute(ctx) {
      await openFromHistory(url);
    }
  });
  _registeredUrls.add(url);

  if (title && title !== url) {
    addFn({
      name: title,
      async execute(ctx) {
        await openFromHistory(url);
      }
    });
    _registeredTitles.set(url, title);
  }
};

export const initializeSources = async (addCommand, batchApi = {}) => {
  _addCommand = addCommand;
  _batchApi = batchApi;

  const mainLog = window.app?.log || console.log;
  const history = await getHistory('', 200);

  // Build set of current URL content strings for comparison
  const currentUrls = new Set(history.map(item => item.content));

  // Check if the history has changed since last registration
  const isSameSet = currentUrls.size === _registeredUrls.size &&
    [...currentUrls].every(url => _registeredUrls.has(url));

  if (isSameSet && _registeredUrls.size > 0) {
    debug && console.log('[history] no changes, skipping re-registration (' + _registeredUrls.size + ' URL commands cached)');
    return;
  }

  // History changed — compute delta
  const addedUrls = [...currentUrls].filter(url => !_registeredUrls.has(url));
  const removedUrls = [..._registeredUrls].filter(url => !currentUrls.has(url));

  // Remove commands for deleted URLs
  if (batchApi.removeCommand) {
    for (const url of removedUrls) {
      batchApi.removeCommand(url);
      const oldTitle = _registeredTitles.get(url);
      if (oldTitle) {
        batchApi.removeCommand(oldTitle);
        _registeredTitles.delete(url);
      }
      _registeredUrls.delete(url);
    }
  }

  // Use silent add for batch registration (avoids 88 individual debounced updates)
  const addFn = batchApi.addCommandSilent || addCommand;

  if (_registeredUrls.size === 0) {
    // First load — register all items
    if (history.length === 0) {
      mainLog('[history] WARNING: no URL items in datastore — cmd palette will have no URL suggestions');
    }
    history.forEach(item => registerHistoryItem(addFn, item));
    debug && console.log('[history] registered', history.length, 'URL commands');
  } else {
    // Incremental update — only register new items
    const addedItems = history.filter(item => addedUrls.includes(item.content));
    addedItems.forEach(item => registerHistoryItem(addFn, item));
    if (addedUrls.length > 0 || removedUrls.length > 0) {
      debug && console.log('[history] updated: +' + addedUrls.length + ' -' + removedUrls.length + ' URL commands (total: ' + _registeredUrls.size + ')');
    }
  }

  // Flush a single UI update after batch
  if (batchApi.flushUpdates) {
    batchApi.flushUpdates();
  }

  // Subscribe to new URL items so history commands stay fresh (only once)
  if (!_subscribedToEvents) {
    _subscribedToEvents = true;

    api.subscribe('item:created', (msg) => {
      if (msg.itemType === 'url' && _addCommand) {
        if (_registeredUrls.has(msg.content)) return; // Already registered
        debug && console.log('[history] New URL item, registering command:', msg.content);
        _registeredUrls.add(msg.content);
        _addCommand({
          name: msg.content,
          async execute() {
            await openFromHistory(msg.content);
          }
        });
      }
    });

    // Handle URL deletions
    api.subscribe('item:deleted', (msg) => {
      if (msg.itemType === 'url' && _batchApi?.removeCommand) {
        const url = msg.content;
        if (_registeredUrls.has(url)) {
          debug && console.log('[history] URL item deleted, removing command:', url);
          _batchApi.removeCommand(url);
          const oldTitle = _registeredTitles.get(url);
          if (oldTitle) {
            _batchApi.removeCommand(oldTitle);
            _registeredTitles.delete(url);
          }
          _registeredUrls.delete(url);
        }
      }
    });

    // Re-sync after sync pull (history may have changed)
    api.subscribe('sync:pull-completed', async () => {
      debug && console.log('[history] sync pull completed, re-syncing history commands');
      await initializeSources(_addCommand, _batchApi);
    });
  }
};

export default {
  commands,
  initializeSources
};
