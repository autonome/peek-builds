/**
 * History command - search and open pages from saved URLs
 * URLs are sorted by recent first (createdAt descending)
 */
import windows from 'peek://app/windows.js';
import api from 'peek://app/api.js';

const debug = window.app?.debug;

// Store addCommand callback for reactive updates
let _addCommand = null;

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
 * Initialize history entries as commands
 * Each history entry becomes a searchable command
 */
/**
 * Register a single item as history commands (URL + title)
 */
const registerHistoryItem = (addCommand, item) => {
  const url = item.content;
  const title = getItemTitle(item);

  addCommand({
    name: url,
    async execute(ctx) {
      await openFromHistory(url);
    }
  });

  if (title && title !== url) {
    addCommand({
      name: title,
      async execute(ctx) {
        await openFromHistory(url);
      }
    });
  }
};

export const initializeSources = async (addCommand) => {
  _addCommand = addCommand;

  const history = await getHistory('', 200);
  const mainLog = window.app?.log || console.log;
  mainLog('[history] initializeSources: found', history.length, 'URL items');
  if (history.length > 0) {
    mainLog('[history] first 5 URLs:', history.slice(0, 5).map(i => i.content));
  } else {
    mainLog('[history] WARNING: no URL items in datastore — cmd palette will have no URL suggestions');
  }
  history.forEach(item => registerHistoryItem(addCommand, item));
  mainLog('[history] registered', history.length, 'URL commands');

  // Subscribe to new URL items so history commands stay fresh
  api.subscribe('item:created', (msg) => {
    if (msg.itemType === 'url' && _addCommand) {
      debug && console.log('[history] New URL item, registering command:', msg.content);
      _addCommand({
        name: msg.content,
        async execute() {
          await openFromHistory(msg.content);
        }
      });
    }
  }, api.scopes.GLOBAL);
};

export default {
  commands,
  initializeSources
};
