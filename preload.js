const {
  contextBridge,
  ipcRenderer
} = require('electron');

const src = 'preload';
const preloadStart = Date.now();

const DEBUG = !!process.env.DEBUG;
// If DEBUG is "1" or "true", enable all categories; otherwise it's a comma-separated list
const DEBUG_CATEGORIES = (process.env.DEBUG && process.env.DEBUG !== '1' && process.env.DEBUG !== 'true')
  ? process.env.DEBUG
  : '';
DEBUG && console.log(src, 'init, DEBUG:', DEBUG, 'categories:', DEBUG_CATEGORIES || '(all)');
const DEBUG_LEVELS = {
  BASIC: 1,
  FIRST_RUN: 2
};

const DEBUG_LEVEL = DEBUG_LEVELS.BASIC;
//const DEBUG_LEVEL = DEBUG_LEVELS.FIRST_RUN;

const APP_SCHEME = 'peek';
const APP_PROTOCOL = `${APP_SCHEME}:`;

const sourceAddress = window.location.toString();

const rndm = () => Math.random().toString(16).slice(2);

// Command registration batching for startup performance
// Collects registrations and sends as single batch after debounce
let pendingRegistrations = [];
let registrationTimer = null;
const BATCH_DELAY_MS = 16; // ~1 frame

function flushRegistrations() {
  if (pendingRegistrations.length === 0) return;

  const batch = pendingRegistrations;
  pendingRegistrations = [];
  registrationTimer = null;

  ipcRenderer.send('publish', {
    source: sourceAddress,
    scope: 3, // GLOBAL
    topic: 'cmd:register-batch',
    data: { commands: batch }
  });

  DEBUG && console.log('[preload] commands.flush: sent batch of', batch.length, 'commands');
}

// Context detection for permission tiers
const isCore = sourceAddress.startsWith('peek://app/');

// Extension detection: supports both legacy (peek://ext/{id}/...) and hybrid (peek://{extId}/...) modes
// In hybrid mode, extension URLs are peek://{extId}/... where extId is NOT 'app' or 'ext'
const isLegacyExtension = sourceAddress.startsWith('peek://ext/');
const isHybridExtension = (() => {
  const match = sourceAddress.match(/^peek:\/\/([^/]+)/);
  if (!match) return false;
  const host = match[1];
  // Hybrid extension hosts are anything except 'app' and 'ext' (reserved for core)
  return host !== 'app' && host !== 'ext';
})();
const isExtension = isLegacyExtension || isHybridExtension;

/**
 * Get the extension ID from the current context
 * @returns {string|null} Extension ID or null if not in an extension context
 */
const getExtensionId = () => {
  if (isLegacyExtension) {
    // Legacy format: peek://ext/{id}/...
    const match = sourceAddress.match(/peek:\/\/ext\/([^/]+)/);
    return match ? match[1] : null;
  }
  if (isHybridExtension) {
    // Hybrid format: peek://{extId}/...
    const match = sourceAddress.match(/^peek:\/\/([^/]+)/);
    return match ? match[1] : null;
  }
  return null;
};

let api = {};

// Log to main process (shows in terminal)
api.log = (...args) => {
  ipcRenderer.send('renderer-log', { source: sourceAddress, args });
};

api.debug = DEBUG;
api.debugCategories = DEBUG_CATEGORIES;
api.debugLevels = DEBUG_LEVELS;
api.debugLevel = DEBUG_LEVEL;

// App info API
api.app = {
  /**
   * Get app info including version
   * @returns {Promise<{success: boolean, data?: {version: string, name: string, isPackaged: boolean}, error?: string}>}
   */
  getInfo: () => {
    return ipcRenderer.invoke('app-info');
  }
};

api.shortcuts = {
  /**
   * Register a keyboard shortcut
   * @param {string} shortcut - The shortcut key combination (e.g., 'Alt+1', 'CommandOrControl+Q')
   * @param {function} cb - Callback function when shortcut is triggered
   * @param {object} options - Optional configuration
   * @param {boolean} options.global - If true, shortcut works even when app doesn't have focus (default: false)
   * @param {string} options.mode - Only trigger in this major mode ('page', 'group', 'default')
   */
  register: (shortcut, cb, options = {}) => {
    const isGlobal = options.global === true;
    const modeStr = options.mode ? ` mode:${options.mode}` : '';
    DEBUG && console.log(src, `registering ${isGlobal ? 'global' : 'local'} shortcut ${shortcut}${modeStr} for ${window.location}`);

    const replyTopic = `${shortcut}${rndm()}`;

    ipcRenderer.send('registershortcut', {
      source: sourceAddress,
      shortcut,
      replyTopic,
      global: isGlobal,
      mode: options.mode
    });

    ipcRenderer.on(replyTopic, (ev, msg) => {
      DEBUG && console.log(src, 'shortcut execution reply');
      cb();
      DEBUG && console.log(src, 'shortcut execution reply done');
    });
  },
  /**
   * Unregister a keyboard shortcut
   * @param {string} shortcut - The shortcut to unregister
   * @param {object} options - Optional configuration (must match registration)
   * @param {boolean} options.global - If true, unregisters a global shortcut (default: false)
   * @param {string} options.mode - Mode condition (must match registration)
   */
  unregister: (shortcut, options = {}) => {
    const isGlobal = options.global === true;
    DEBUG && console.log(`unregistering ${isGlobal ? 'global' : 'local'} shortcut`, shortcut, 'for', window.location);
    ipcRenderer.send('unregistershortcut', {
      source: sourceAddress,
      shortcut,
      global: isGlobal,
      mode: options.mode
    });
  }
};

api.closeWindow = (id, callback) => {
  DEBUG && console.log(src, ['api.closewindow', id, 'for', window.location].join(', '));

  const replyTopic = `${id}${rndm()}`;

  const params = {
    source: sourceAddress,
    id
  };

  ipcRenderer.send('closewindow', {
    params,
    replyTopic
  });

  ipcRenderer.once(replyTopic, (ev, msg) => {
    DEBUG && console.log(src, 'api.closewindow', 'resp from main', msg);
    if (callback) {
      callback(msg);
    }
  });
};

api.scopes = {
  SYSTEM: 1,
  SELF: 2,
  GLOBAL: 3
};

api.publish = (topic, msg, scope = api.scopes.SELF) => {
  DEBUG && console.log(sourceAddress, 'publish', topic)

  // TODO: c'mon
  if (!topic) {
    return new Error('wtf');
  }

  ipcRenderer.send('publish', {
    source: sourceAddress,
    scope,
    topic,
    data: msg,
  });
};

api.subscribe = (topic, callback, scope = api.scopes.SELF) => {
  DEBUG && console.log(src, 'subscribe', topic)

  // TODO: c'mon
  if (!topic || !callback) {
    return new Error('wtf');
  }

  const replyTopic = `${topic}:${rndm()}`;

  ipcRenderer.send('subscribe', {
    source: sourceAddress,
    scope,
    topic,
    replyTopic
  });

  ipcRenderer.on(replyTopic, (ev, msg) => {
    DEBUG && console.log('topic', topic, msg);
    // Only set source on object messages (not undefined/null/primitives)
    if (msg && typeof msg === 'object') {
      msg.source = sourceAddress;
    }
    try {
      callback(msg);
    }
    catch(ex) {
      console.log('preload:subscribe subscriber callback errored for topic', topic, 'and source', sourceAddress, ex);
    }
  });
};

api.pubsub = {
  stats: () => {
    DEBUG && console.log('pubsub.stats');
    return ipcRenderer.invoke('pubsub-stats');
  }
};

api.window = {
  open: (url, options = {}) => {
    DEBUG && console.log('window.open', url, options);
    return ipcRenderer.invoke('window-open', {
      source: sourceAddress,
      url,
      options
    });
  },
  close: (id = null) => {
    DEBUG && console.log('window.close', id);
    if (id === null) {
      window.close();
      return;
    }
    return ipcRenderer.invoke('window-close', {
      source: sourceAddress,
      id
    });
  },
  hide: (id) => {
    DEBUG && console.log('window.hide', id);
    return ipcRenderer.invoke('window-hide', {
      source: sourceAddress,
      id
    });
  },
  show: (id) => {
    DEBUG && console.log('window.show', id);
    return ipcRenderer.invoke('window-show', {
      source: sourceAddress,
      id
    });
  },
  exists: (id) => {
    DEBUG && console.log('window.exists', id);
    return ipcRenderer.invoke('window-exists', {
      source: sourceAddress,
      id
    });
  },
  move: (id, x, y) => {
    DEBUG && console.log('window.move', id, x, y);
    return ipcRenderer.invoke('window-move', {
      source: sourceAddress,
      id,
      x,
      y
    });
  },
  resize: (width, height, id = null) => {
    DEBUG && console.log('window.resize', width, height, id);
    return ipcRenderer.invoke('window-resize', {
      source: sourceAddress,
      id,
      width,
      height
    });
  },
  getPosition: (id = null) => {
    DEBUG && console.log('window.getPosition', id);
    return ipcRenderer.invoke('window-get-position', {
      source: sourceAddress,
      id
    });
  },
  focus: (id) => {
    DEBUG && console.log('window.focus', id);
    return ipcRenderer.invoke('window-focus', {
      source: sourceAddress,
      id
    });
  },
  blur: (id) => {
    DEBUG && console.log('window.blur', id);
    return ipcRenderer.invoke('window-blur', {
      source: sourceAddress,
      id
    });
  },
  list: (options = {}) => {
    DEBUG && console.log('window.list', options);
    return ipcRenderer.invoke('window-list', {
      source: sourceAddress,
      ...options
    });
  },
  devtools: (id = null) => {
    DEBUG && console.log('window.devtools', id);
    return ipcRenderer.invoke('window-devtools', {
      source: sourceAddress,
      id
    });
  },
  getBounds: (id = null) => {
    DEBUG && console.log('window.getBounds', id);
    return ipcRenderer.invoke('window-get-bounds', {
      source: sourceAddress,
      id
    });
  },
  setBounds: (bounds) => {
    return ipcRenderer.invoke('window-set-bounds', bounds);
  },
  setIgnoreMouseEvents: (id, ignore, forward = false) => {
    DEBUG && console.log('window.setIgnoreMouseEvents', id, ignore, forward);
    return ipcRenderer.invoke('window-set-ignore-mouse-events', {
      source: sourceAddress,
      id,
      ignore,
      forward
    });
  },
  /**
   * Get the last focused visible (non-modal) window's ID
   * Use this to get the target window when operating from modal windows like cmd bar
   * @returns {Promise<number|null>} Window ID or null if not available
   */
  getFocusedVisibleWindowId: () => {
    return ipcRenderer.invoke('get-focused-visible-window-id');
  },
  /**
   * Get the current window's ID
   * @returns {Promise<number|null>} Window ID or null if not available
   */
  getWindowId: () => {
    return ipcRenderer.invoke('get-window-id');
  },
  /**
   * Check if this window was opened transiently (app wasn't focused when opened)
   * Used for IZUI policy: transient windows use different escape/mode behavior
   * @returns {Promise<boolean>} True if window is transient
   */
  isTransient: () => {
    return ipcRenderer.invoke('window-is-transient');
  },
  center: (id) => {
    DEBUG && console.log('window.center', id);
    return ipcRenderer.invoke('window-center', { source: sourceAddress, id });
  },
  centerAll: () => {
    DEBUG && console.log('window.centerAll');
    return ipcRenderer.invoke('window-center-all');
  },
  maximize: (id) => {
    DEBUG && console.log('window.maximize', id);
    return ipcRenderer.invoke('window-maximize', { source: sourceAddress, id });
  },
  fullscreen: (id) => {
    DEBUG && console.log('window.fullscreen', id);
    return ipcRenderer.invoke('window-fullscreen', { source: sourceAddress, id });
  }
};

// ============================================================================
// IZUI State Coordinator API
// ============================================================================
// Centralized IZUI state management. Preferred over api.window.isTransient()
// because it re-evaluates state on each invocation, fixing keepLive windows
// that would otherwise be stuck with stale transient state.
api.izui = {
  /**
   * Check if the current IZUI session is in transient mode
   * Re-evaluates on each call (unlike window.isTransient which is frozen at creation)
   * @returns {Promise<boolean>} True if session is transient (app wasn't focused when invoked)
   */
  isTransient: () => {
    return ipcRenderer.invoke('izui-is-transient');
  },

  /**
   * Get the effective mode for display
   * Returns 'default' for transient sessions, 'active' for focused sessions
   * @returns {Promise<string>} 'default' or 'active'
   */
  getEffectiveMode: () => {
    return ipcRenderer.invoke('izui-get-effective-mode');
  },

  /**
   * Get the current IZUI state
   * @returns {Promise<string>} 'idle' | 'transient' | 'active' | 'overlay'
   */
  getState: () => {
    return ipcRenderer.invoke('izui-get-state');
  },

  /**
   * Request this window to close/hide via the IZUI model.
   * Goes through closeOrHideWindow for proper keepLive/modal/child handling.
   * Used by navigate mode windows where renderer owns the lifecycle.
   * @returns {Promise<{success: boolean}>}
   */
  closeSelf: () => {
    return ipcRenderer.invoke('izui-close-self');
  }
};

api.modifyWindow = (winName, params) => {
  DEBUG && console.log('modifyWindow(): window', winName, params);
  //w.name = `${sourceAddress}:${rndm()}`;
  DEBUG && console.log('NAME', winName);
  ipcRenderer.send('modifywindow', {
    source: sourceAddress,
    name: winName,
    params
  });
};

// Datastore API
api.datastore = {
  addAddress: (uri, options) => {
    return ipcRenderer.invoke('datastore-add-address', { uri, options });
  },
  getAddress: (id) => {
    return ipcRenderer.invoke('datastore-get-address', { id });
  },
  updateAddress: (id, updates) => {
    return ipcRenderer.invoke('datastore-update-address', { id, updates });
  },
  queryAddresses: (filter) => {
    return ipcRenderer.invoke('datastore-query-addresses', { filter });
  },
  addVisit: (addressId, options) => {
    return ipcRenderer.invoke('datastore-add-visit', { addressId, options });
  },
  queryVisits: (filter) => {
    return ipcRenderer.invoke('datastore-query-visits', { filter });
  },
  addContent: (options) => {
    return ipcRenderer.invoke('datastore-add-content', { options });
  },
  queryContent: (filter) => {
    return ipcRenderer.invoke('datastore-query-content', { filter });
  },
  getTable: (tableName) => {
    return ipcRenderer.invoke('datastore-get-table', { tableName });
  },
  setRow: (tableName, rowId, rowData) => {
    return ipcRenderer.invoke('datastore-set-row', { tableName, rowId, rowData });
  },
  getRow: (tableName, rowId) => {
    return ipcRenderer.invoke('datastore-get-row', { tableName, rowId });
  },
  getStats: () => {
    return ipcRenderer.invoke('datastore-get-stats');
  },
  // Tag operations
  getOrCreateTag: (name) => {
    return ipcRenderer.invoke('datastore-get-or-create-tag', { name });
  },
  tagAddress: (addressId, tagId) => {
    return ipcRenderer.invoke('datastore-tag-address', { addressId, tagId });
  },
  untagAddress: (addressId, tagId) => {
    return ipcRenderer.invoke('datastore-untag-address', { addressId, tagId });
  },
  getTagsByFrecency: (domain) => {
    return ipcRenderer.invoke('datastore-get-tags-by-frecency', { domain });
  },
  getAddressTags: (addressId) => {
    return ipcRenderer.invoke('datastore-get-address-tags', { addressId });
  },
  getAddressesByTag: (tagId) => {
    return ipcRenderer.invoke('datastore-get-addresses-by-tag', { tagId });
  },
  getUntaggedAddresses: () => {
    return ipcRenderer.invoke('datastore-get-untagged-addresses', {});
  },

  // Item operations (mobile-style lightweight content: notes, tagsets, images)
  addItem: (type, options = {}) => {
    return ipcRenderer.invoke('datastore-add-item', { type, options });
  },
  getItem: (id) => {
    return ipcRenderer.invoke('datastore-get-item', { id });
  },
  updateItem: (id, options) => {
    return ipcRenderer.invoke('datastore-update-item', { id, options });
  },
  deleteItem: (id) => {
    return ipcRenderer.invoke('datastore-delete-item', { id });
  },
  hardDeleteItem: (id) => {
    return ipcRenderer.invoke('datastore-hard-delete-item', { id });
  },
  queryItems: (filter = {}) => {
    return ipcRenderer.invoke('datastore-query-items', { filter });
  },
  tagItem: (itemId, tagId) => {
    return ipcRenderer.invoke('datastore-tag-item', { itemId, tagId });
  },
  untagItem: (itemId, tagId) => {
    return ipcRenderer.invoke('datastore-untag-item', { itemId, tagId });
  },
  getItemTags: (itemId) => {
    return ipcRenderer.invoke('datastore-get-item-tags', { itemId });
  },
  getItemsByTag: (tagId) => {
    return ipcRenderer.invoke('datastore-get-items-by-tag', { tagId });
  },
  renameTag: (tagId, newName) => {
    return ipcRenderer.invoke('datastore-rename-tag', { tagId, newName });
  },
  updateTagColor: (tagId, color) => {
    return ipcRenderer.invoke('datastore-update-tag-color', { tagId, color });
  },
  deleteTag: (tagId) => {
    return ipcRenderer.invoke('datastore-delete-tag', { tagId });
  },

  // History operations (visits joined with addresses)
  getHistory: (filter = {}) => {
    return ipcRenderer.invoke('datastore-get-history', { filter });
  },

  // Item visit operations (modern URL history API)
  queryItemVisits: (filter = {}) => {
    return ipcRenderer.invoke('datastore-query-item-visits', { filter });
  },
  getItemVisits: (itemId, filter = {}) => {
    return ipcRenderer.invoke('datastore-get-item-visits', { itemId, filter });
  },
  recordItemVisit: (itemId, options = {}) => {
    return ipcRenderer.invoke('datastore-record-item-visit', { itemId, options });
  },

  // Navigation tracking (unified entry point for page loads)
  trackNavigation: (uri, options = {}) => {
    return ipcRenderer.invoke('datastore-track-navigation', { uri, options });
  },

  // Update title for a URL item (if currently empty or "Loading...")
  updateItemTitle: (url, title) => {
    return ipcRenderer.invoke('datastore-update-item-title', { url, title });
  },

  // Extract page content from a live webContents by URL
  extractPageContent: (url) => {
    return ipcRenderer.invoke('extract-page-content', { url });
  },

  // Item event operations (series & feeds)
  addItemEvent: (itemId, options = {}) => {
    return ipcRenderer.invoke('datastore-add-item-event', { itemId, options });
  },
  getItemEvent: (eventId) => {
    return ipcRenderer.invoke('datastore-get-item-event', { eventId });
  },
  queryItemEvents: (filter = {}) => {
    return ipcRenderer.invoke('datastore-query-item-events', { filter });
  },
  deleteItemEvent: (eventId) => {
    return ipcRenderer.invoke('datastore-delete-item-event', { eventId });
  },
  deleteItemEvents: (itemId) => {
    return ipcRenderer.invoke('datastore-delete-item-events', { itemId });
  },
  getLatestItemEvent: (itemId) => {
    return ipcRenderer.invoke('datastore-get-latest-item-event', { itemId });
  },
  countItemEvents: (itemId, filter = {}) => {
    return ipcRenderer.invoke('datastore-count-item-events', { itemId, filter });
  }
};

// Theme API
api.theme = {
  /**
   * Get current theme settings
   * @returns {Promise<{themeId: string, colorScheme: string, isDark: boolean, effectiveScheme: string}>}
   */
  get: () => {
    return ipcRenderer.invoke('theme:get');
  },

  /**
   * Set color scheme preference
   * @param {string} colorScheme - 'system' | 'light' | 'dark'
   * @returns {Promise<{success: boolean, colorScheme?: string, effectiveScheme?: string, error?: string}>}
   */
  setColorScheme: (colorScheme) => {
    return ipcRenderer.invoke('theme:setColorScheme', colorScheme);
  },

  /**
   * Set active theme
   * @param {string} themeId - Theme ID
   * @returns {Promise<{success: boolean, themeId?: string, error?: string}>}
   */
  setTheme: (themeId) => {
    return ipcRenderer.invoke('theme:setTheme', themeId);
  },

  /**
   * List available themes (simple list for basic UI)
   * @returns {Promise<{themes: Array<{id: string, name: string, version: string, description: string, colorSchemes: string[]}>}>}
   */
  list: () => {
    return ipcRenderer.invoke('theme:list');
  },

  /**
   * Get all themes with full details (builtin + external)
   * @returns {Promise<{success: boolean, data?: Array, error?: string}>}
   */
  getAll: () => {
    return ipcRenderer.invoke('theme:getAll');
  },

  /**
   * Open folder picker dialog to select a theme folder
   * @returns {Promise<{success: boolean, canceled?: boolean, data?: {path: string}, error?: string}>}
   */
  pickFolder: () => {
    return ipcRenderer.invoke('theme:pickFolder');
  },

  /**
   * Validate a theme folder (checks manifest.json)
   * @param {string} folderPath - Path to theme folder
   * @returns {Promise<{success: boolean, data?: {manifest: object, path: string}, error?: string}>}
   */
  validateFolder: (folderPath) => {
    return ipcRenderer.invoke('theme:validateFolder', { folderPath });
  },

  /**
   * Add a theme from a folder
   * @param {string} folderPath - Path to theme folder
   * @returns {Promise<{success: boolean, data?: {id: string, manifest: object}, error?: string}>}
   */
  add: (folderPath) => {
    return ipcRenderer.invoke('theme:add', { folderPath });
  },

  /**
   * Remove a theme
   * @param {string} id - Theme ID
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  remove: (id) => {
    return ipcRenderer.invoke('theme:remove', { id });
  },

  /**
   * Reload a theme (re-read CSS, notify windows)
   * @param {string} id - Theme ID
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  reload: (id) => {
    return ipcRenderer.invoke('theme:reload', { id });
  },

  /**
   * Subscribe to theme changes
   * @param {function} callback - Called with {colorScheme: string} when theme changes
   */
  onChange: (callback) => {
    ipcRenderer.on('theme:changed', (ev, data) => {
      callback(data);
    });
  },

  /**
   * Subscribe to theme reload events
   * @param {function} callback - Called with {themeId: string} when theme should be reloaded
   */
  onReload: (callback) => {
    ipcRenderer.on('theme:reload', (ev, data) => {
      callback(data);
    });
  },

  /**
   * Set color scheme for current window only (doesn't affect global setting)
   * When called from background.html (via commands), targets the last focused visible window.
   * @param {string} colorScheme - 'light', 'dark', 'system', or 'global' (to use global theme)
   * @returns {Promise<{success: boolean, windowId?: number, colorScheme?: string, error?: string}>}
   */
  setWindowColorScheme: async (colorScheme) => {
    // Use focused visible window ID if calling from background context,
    // otherwise use the current window ID
    let windowId = await ipcRenderer.invoke('get-focused-visible-window-id');
    if (!windowId) {
      // Fallback to current window (for direct calls from visible windows)
      windowId = await ipcRenderer.invoke('get-window-id');
    }
    if (!windowId) {
      return { success: false, error: 'No visible window to target' };
    }
    return ipcRenderer.invoke('theme:setWindowColorScheme', { windowId, colorScheme });
  }
};

// Sync API - server synchronization for bidirectional sync
api.sync = {
  /**
   * Get sync configuration
   * @returns {Promise<{success: boolean, data?: {serverUrl: string, apiKey: string, autoSync: boolean}, error?: string}>}
   */
  getConfig: () => {
    return ipcRenderer.invoke('sync-get-config');
  },

  /**
   * Set sync configuration
   * @param {object} config - { serverUrl?, apiKey?, autoSync? }
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  setConfig: (config) => {
    return ipcRenderer.invoke('sync-set-config', config);
  },

  /**
   * Pull items from server
   * @param {object} options - { since?: number } - optional timestamp to pull changes since
   * @returns {Promise<{success: boolean, data?: {pulled: number, conflicts: number}, error?: string}>}
   */
  pull: (options = {}) => {
    return ipcRenderer.invoke('sync-pull', options);
  },

  /**
   * Push local items to server
   * @param {object} options - { force?: boolean } - force push even if conflicts
   * @returns {Promise<{success: boolean, data?: {pushed: number, skipped: number}, error?: string}>}
   */
  push: (options = {}) => {
    return ipcRenderer.invoke('sync-push', options);
  },

  /**
   * Full bidirectional sync (pull then push)
   * @returns {Promise<{success: boolean, data?: {pulled: number, pushed: number, conflicts: number}, error?: string}>}
   */
  syncAll: () => {
    return ipcRenderer.invoke('sync-full');
  },

  /**
   * Get current sync status
   * @returns {Promise<{success: boolean, data?: {configured: boolean, lastSync: number, pendingCount: number}, error?: string}>}
   */
  getStatus: () => {
    return ipcRenderer.invoke('sync-status');
  }
};

// Profiles API - user profile management
api.profiles = {
  /**
   * List all profiles
   * @returns {Promise<{success: boolean, data?: Profile[], error?: string}>}
   */
  list: () => {
    return ipcRenderer.invoke('profiles:list');
  },

  /**
   * Create a new profile
   * @param {string} name - Profile name (e.g., "Work", "Personal")
   * @returns {Promise<{success: boolean, data?: Profile, error?: string}>}
   */
  create: (name) => {
    return ipcRenderer.invoke('profiles:create', { name });
  },

  /**
   * Get a specific profile by slug
   * @param {string} slug - Profile slug (e.g., "work", "personal")
   * @returns {Promise<{success: boolean, data?: Profile, error?: string}>}
   */
  get: (slug) => {
    return ipcRenderer.invoke('profiles:get', { slug });
  },

  /**
   * Delete a profile (cannot delete default or active profile)
   * @param {string} id - Profile ID
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  delete: (id) => {
    return ipcRenderer.invoke('profiles:delete', { id });
  },

  /**
   * Get the currently active profile
   * @returns {Promise<{success: boolean, data?: Profile, error?: string}>}
   */
  getCurrent: () => {
    return ipcRenderer.invoke('profiles:getCurrent');
  },

  /**
   * Switch to a different profile (causes app restart)
   * @param {string} slug - Profile slug to switch to
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  switch: (slug) => {
    return ipcRenderer.invoke('profiles:switch', { slug });
  },

  /**
   * Enable sync for a profile
   * @param {string} profileId - Profile ID
   * @param {string} apiKey - Server API key
   * @param {string} serverProfileSlug - Server profile slug to sync with
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  enableSync: (profileId, apiKey, serverProfileSlug) => {
    return ipcRenderer.invoke('profiles:enableSync', { profileId, apiKey, serverProfileSlug });
  },

  /**
   * Disable sync for a profile
   * @param {string} profileId - Profile ID
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  disableSync: (profileId) => {
    return ipcRenderer.invoke('profiles:disableSync', { profileId });
  },

  /**
   * Get sync configuration for a profile
   * @param {string} profileId - Profile ID
   * @returns {Promise<{success: boolean, data?: {apiKey: string, serverProfileSlug: string} | null, error?: string}>}
   */
  getSyncConfig: (profileId) => {
    return ipcRenderer.invoke('profiles:getSyncConfig', { profileId });
  },

  /**
   * Get the partition string for the current profile's session
   * Used for setting webview partition attribute for session isolation
   * @returns {Promise<{success: boolean, data?: {profileId: string, partition: string}, error?: string}>}
   */
  getPartition: () => {
    return ipcRenderer.invoke('profiles:getPartition');
  }
};

// ========== Dark Mode API ==========

/**
 * Dark Mode API - 3-tier dark mode system for web pages
 *
 * Tier 1 (system): Sets prefers-color-scheme: dark — sites with dark mode support switch automatically
 * Tier 2 (force): Chromium WebContentsForceDark — CIELAB-based inversion for all sites
 * Tier 3 (per-site): Dark Reader injection — TODO, not yet implemented
 */
api.darkMode = {
  /**
   * Get current dark mode setting
   * @returns {Promise<{success: boolean, data?: {mode: string, tier2Active: boolean}}>}
   */
  get: () => {
    return ipcRenderer.invoke('darkMode:get');
  },

  /**
   * Set dark mode setting
   * @param {string} mode - 'off' | 'system' | 'force'
   * @returns {Promise<{success: boolean, data?: {mode: string, restartRequired: boolean}, error?: string}>}
   */
  set: (mode) => {
    return ipcRenderer.invoke('darkMode:set', mode);
  },

  /**
   * Listen for dark mode changes
   * @param {function} callback - Called with { mode: string }
   * @returns {function} Unsubscribe function
   */
  onChange: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('darkMode:changed', handler);
    return () => ipcRenderer.removeListener('darkMode:changed', handler);
  },
};

// ========== Bundled Web Extensions API ==========

/**
 * Adblocker API - Native ad blocking powered by @ghostery/adblocker-electron
 */
api.adblocker = {
  /**
   * Get adblocker status
   * @returns {Promise<{success: boolean, data?: {initialized: boolean, enabled: boolean, blockedCount: number}, error?: string}>}
   */
  getStatus: () => {
    return ipcRenderer.invoke('adblocker:getStatus');
  },

  /**
   * Enable ad blocking
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  enable: () => {
    return ipcRenderer.invoke('adblocker:enable');
  },

  /**
   * Disable ad blocking
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  disable: () => {
    return ipcRenderer.invoke('adblocker:disable');
  },

  /**
   * Get count of blocked requests
   * @returns {Promise<{success: boolean, data?: number, error?: string}>}
   */
  getBlockedCount: () => {
    return ipcRenderer.invoke('adblocker:getBlockedCount');
  },

  /**
   * Get the per-site allowlist (sites where blocking is disabled)
   * @returns {Promise<{success: boolean, data?: string[], error?: string}>}
   */
  getAllowlist: () => {
    return ipcRenderer.invoke('adblocker:getAllowlist');
  },

  /**
   * Check if a specific site is in the allowlist
   * @param {string} hostname - The hostname to check
   * @returns {Promise<{success: boolean, data?: boolean, error?: string}>}
   */
  isSiteAllowed: (hostname) => {
    return ipcRenderer.invoke('adblocker:isSiteAllowed', { hostname });
  },

  /**
   * Add a site to the allowlist (disable blocking for that site)
   * @param {string} hostname - The hostname to allow
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  allowSite: (hostname) => {
    return ipcRenderer.invoke('adblocker:allowSite', { hostname });
  },

  /**
   * Remove a site from the allowlist (re-enable blocking for that site)
   * @param {string} hostname - The hostname to disallow
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  disallowSite: (hostname) => {
    return ipcRenderer.invoke('adblocker:disallowSite', { hostname });
  }
};

/**
 * Chrome Extensions API - Bundled Chrome extension management
 */
api.chromeExtensions = {
  /**
   * List all bundled chrome extensions
   * @returns {Promise<{success: boolean, data?: Array<{id: string, name: string, version: string, description: string, enabled: boolean, loaded: boolean}>, error?: string}>}
   */
  list: () => {
    return ipcRenderer.invoke('chrome-ext:list');
  },

  /**
   * Enable a chrome extension
   * @param {string} id - Extension ID
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  enable: (id) => {
    return ipcRenderer.invoke('chrome-ext:enable', { id });
  },

  /**
   * Disable a chrome extension
   * @param {string} id - Extension ID
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  disable: (id) => {
    return ipcRenderer.invoke('chrome-ext:disable', { id });
  },

  /**
   * Get chrome extension manager status
   * @returns {Promise<{success: boolean, data?: {initialized: boolean, discoveredCount: number, loadedCount: number}, error?: string}>}
   */
  getStatus: () => {
    return ipcRenderer.invoke('chrome-ext:getStatus');
  },

  /**
   * Get UI entry points for all loaded chrome extensions (options pages, popups)
   * @returns {Promise<{success: boolean, data?: Array<{extensionId: string, extensionName: string, type: string, title: string, url: string, width: number, height: number}>, error?: string}>}
   */
  getUiEntries: () => {
    return ipcRenderer.invoke('chrome-ext:getUiEntries');
  },

  /**
   * Open a chrome extension's options page or popup in a window
   * @param {string} id - Extension ID
   * @param {string} type - Page type to open (popup, options, newtab, etc.)
   * @returns {Promise<{success: boolean, data?: {windowId: number}, error?: string}>}
   */
  openPage: (id, type) => {
    return ipcRenderer.invoke('chrome-ext:openPage', { id, type });
  }
};

// Track per-window color scheme override (null = use global)
let windowColorSchemeOverride = null;

// Apply theme on page load
(async () => {
  try {
    const theme = await ipcRenderer.invoke('theme:get');
    if (theme && theme.colorScheme !== 'system') {
      document.documentElement.setAttribute('data-theme', theme.colorScheme);
    }

    // Listen for global color scheme changes
    ipcRenderer.on('theme:changed', (ev, { colorScheme }) => {
      // Only apply global changes if this window doesn't have an override
      if (windowColorSchemeOverride !== null) {
        DEBUG && console.log('[preload] Ignoring global theme change, window has override:', windowColorSchemeOverride);
        return;
      }
      if (colorScheme === 'system') {
        document.documentElement.removeAttribute('data-theme');
      } else {
        document.documentElement.setAttribute('data-theme', colorScheme);
      }
    });

    // Listen for window-specific color scheme changes
    ipcRenderer.on('theme:windowChanged', (ev, { colorScheme }) => {
      DEBUG && console.log('[preload] Window-specific color scheme:', colorScheme);
      if (colorScheme === 'global') {
        // Clear override, revert to global theme
        windowColorSchemeOverride = null;
        // Re-fetch and apply global theme
        ipcRenderer.invoke('theme:get').then(theme => {
          if (theme && theme.colorScheme !== 'system') {
            document.documentElement.setAttribute('data-theme', theme.colorScheme);
          } else {
            document.documentElement.removeAttribute('data-theme');
          }
        });
      } else {
        // Set window-specific override
        windowColorSchemeOverride = colorScheme;
        if (colorScheme === 'system') {
          document.documentElement.removeAttribute('data-theme');
        } else {
          document.documentElement.setAttribute('data-theme', colorScheme);
        }
      }
    });

    // Listen for theme changes (different theme selected) - reload CSS
    ipcRenderer.on('theme:themeChanged', (ev, { themeId }) => {
      DEBUG && console.log('[preload] Theme changed to:', themeId, '- reloading stylesheets');
      reloadStylesheets();
    });

    // Listen for theme reload requests
    ipcRenderer.on('theme:reload', (ev, { themeId }) => {
      DEBUG && console.log('[preload] Theme reload requested:', themeId);
      reloadStylesheets();
    });
  } catch (e) {
    // Theme not available yet (before app ready)
  }
})();

// Set data-microseason attribute for season-aware themes (e.g. 七十二候)
(() => { try {
  // 72 microseason start dates [month, day], starting from Risshun (Feb 4)
  const S = [
    [2,4],[2,9],[2,14],[2,19],[2,24],[3,1],
    [3,6],[3,11],[3,16],[3,21],[3,26],[3,31],
    [4,5],[4,10],[4,15],[4,20],[4,25],[4,30],
    [5,5],[5,10],[5,15],[5,21],[5,26],[5,31],
    [6,5],[6,11],[6,16],[6,21],[6,26],[7,1],
    [7,7],[7,12],[7,17],[7,23],[7,28],[8,2],
    [8,7],[8,12],[8,18],[8,23],[8,28],[9,2],
    [9,7],[9,12],[9,17],[9,23],[9,28],[10,3],
    [10,8],[10,13],[10,18],[10,23],[10,28],[11,2],
    [11,7],[11,12],[11,17],[11,22],[11,27],[12,2],
    [12,7],[12,12],[12,17],[12,22],[12,27],[1,1],
    [1,5],[1,10],[1,15],[1,20],[1,25],[1,30]
  ];
  // Normalize dates to "season year" starting Feb 4 = day 0
  const dim = [0,31,28,31,30,31,30,31,31,30,31,30,31];
  const doy = (m, d) => { let t = d; for (let i = 1; i < m; i++) t += dim[i]; return t; };
  const toSD = (m, d) => (doy(m, d) - 35 + 365) % 365; // 35 = doy(2,4)
  const now = new Date();
  const key = toSD(now.getMonth() + 1, now.getDate());
  let idx = 0;
  for (let i = S.length - 1; i >= 0; i--) {
    if (key >= toSD(S[i][0], S[i][1])) { idx = i; break; }
  }
  const root = document.documentElement;
  if (root) root.setAttribute('data-microseason', String(idx));
} catch (e) { console.error('[preload] microseason error:', e); } })();

// Auto-apply persisted color scheme preference for this URL
window.addEventListener('DOMContentLoaded', async () => {
  try {
    const url = window.location.href;
    // Only check for http/https URLs (not peek:// internal pages)
    if (!url || url.startsWith('peek://')) return;

    const result = await ipcRenderer.invoke('datastore-query-addresses', {});
    if (!result.success || !result.data) return;

    const addr = result.data.find(a => a.uri === url);
    if (addr && addr.metadata) {
      const meta = JSON.parse(addr.metadata);
      if (meta.colorScheme && (meta.colorScheme === 'light' || meta.colorScheme === 'dark')) {
        DEBUG && console.log('[preload] Applying persisted color scheme for URL:', meta.colorScheme);
        windowColorSchemeOverride = meta.colorScheme;
        document.documentElement.setAttribute('data-theme', meta.colorScheme);
      }
    }
  } catch (e) {
    // Ignore errors (datastore not ready, etc.)
  }
});

/**
 * Reload all stylesheets by removing and re-adding link elements
 * This forces the browser to completely re-fetch CSS including @import statements
 */
function reloadStylesheets() {
  const timestamp = Date.now();
  // Reload <link> stylesheets by removing and re-adding them
  // This is more aggressive than just changing href and ensures @imports are re-fetched
  document.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
    const href = link.getAttribute('href');
    if (href) {
      const baseHref = href.split('?')[0];
      const newHref = `${baseHref}?_t=${timestamp}`;

      // Create a new link element to force complete re-fetch
      const newLink = document.createElement('link');
      newLink.rel = 'stylesheet';
      newLink.href = newHref;

      // Replace the old link with the new one
      link.parentNode.insertBefore(newLink, link);
      link.remove();
    }
  });

  // For inline <style> with @import, we need to reload them too
  document.querySelectorAll('style').forEach(style => {
    const content = style.textContent;
    if (content && content.includes('@import')) {
      // Replace @import URLs with cache-busted versions
      const newContent = content.replace(
        /@import\s+url\(['"]?([^'")\s]+)['"]?\)/g,
        (match, url) => {
          const baseUrl = url.split('?')[0];
          return `@import url('${baseUrl}?_t=${timestamp}')`;
        }
      );
      style.textContent = newContent;
    }
  });
}

// App control API
api.quit = () => {
  ipcRenderer.send('app-quit', { source: sourceAddress });
};

api.restart = () => {
  ipcRenderer.send('app-restart', { source: sourceAddress });
};

// Command registration API for extensions
// Commands API
// The cmd extension is loaded first and its cmd:register-batch subscriber is set up synchronously.
// Extensions can call api.commands.register() directly in their init().

api.commands = {
  /**
   * Register a command with the cmd palette
   * @param {Object} command - Command object with:
   *   - name: string (required)
   *   - description: string (optional)
   *   - scope: 'global' | 'window' | 'page' (optional, defaults to 'global')
   *   - modes: string[] (optional, major modes where command is available)
   *   - canExecute: function(context) => boolean (optional, guard function)
   *   - execute: function(msg) (required)
   */
  register: (command) => {
    if (!command.name || !command.execute) {
      console.error('commands.register: name and execute are required');
      return;
    }

    // Store the execute handler locally (can't serialize functions via pubsub)
    window._cmdHandlers = window._cmdHandlers || {};
    window._cmdHandlers[command.name] = command.execute;

    // Store canExecute handler if provided
    if (command.canExecute) {
      window._cmdCanExecuteHandlers = window._cmdCanExecuteHandlers || {};
      window._cmdCanExecuteHandlers[command.name] = command.canExecute;
    }

    // Subscribe to execution requests for this command (GLOBAL scope)
    const execTopic = `cmd:execute:${command.name}`;
    const replyTopic = `${execTopic}:${rndm()}`;

    ipcRenderer.send('subscribe', {
      source: sourceAddress,
      scope: 3,
      topic: execTopic,
      replyTopic
    });

    ipcRenderer.on(replyTopic, async (ev, msg) => {
      DEBUG && console.log('cmd:execute', command.name, msg);
      const handler = window._cmdHandlers?.[command.name];
      if (handler) {
        try {
          const result = await handler(msg);
          // If caller expects a result (for chaining), publish it back
          if (msg.expectResult && msg.resultTopic) {
            ipcRenderer.send('publish', {
              source: sourceAddress,
              scope: 3,
              topic: msg.resultTopic,
              data: result
            });
          }
        } catch (err) {
          console.error('Error executing command', command.name, err);
          // Still publish result on error so panel doesn't hang
          if (msg.expectResult && msg.resultTopic) {
            ipcRenderer.send('publish', {
              source: sourceAddress,
              scope: 3,
              topic: msg.resultTopic,
              data: { error: err.message }
            });
          }
        }
      } else {
        DEBUG && console.log('cmd:execute no handler for', command.name);
      }
    });

    // Subscribe to canExecute queries for this command
    const canExecTopic = `cmd:canExecute:${command.name}`;
    const canExecReplyTopic = `${canExecTopic}:${rndm()}`;

    ipcRenderer.send('subscribe', {
      source: sourceAddress,
      scope: 3,
      topic: canExecTopic,
      replyTopic: canExecReplyTopic
    });

    ipcRenderer.on(canExecReplyTopic, async (ev, msg) => {
      const canExecuteHandler = window._cmdCanExecuteHandlers?.[command.name];
      let canExecute = true;

      if (canExecuteHandler) {
        try {
          canExecute = await canExecuteHandler(msg.context);
        } catch (err) {
          console.error('Error in canExecute for', command.name, err);
          canExecute = false;
        }
      }

      // Publish result back
      if (msg.responseTopic) {
        ipcRenderer.send('publish', {
          source: sourceAddress,
          scope: 3,
          topic: msg.responseTopic,
          data: { name: command.name, canExecute }
        });
      }
    });

    // Queue registration for batching (improves startup performance)
    pendingRegistrations.push({
      name: command.name,
      description: command.description || '',
      source: sourceAddress,
      scope: command.scope || 'global',
      modes: command.modes || [],
      hasCanExecute: !!command.canExecute,
      accepts: command.accepts || [],
      produces: command.produces || [],
      params: command.params || []
    });

    // Debounce: flush after BATCH_DELAY_MS of no new registrations
    clearTimeout(registrationTimer);
    registrationTimer = setTimeout(flushRegistrations, BATCH_DELAY_MS);

    DEBUG && console.log('[preload] commands.register:', command.name, 'scope:', command.scope || 'global');
  },

  /**
   * Flush any pending command registrations immediately
   * Useful for extensions that need commands available before debounce completes
   */
  flush: flushRegistrations,

  /**
   * Unregister a command from the cmd palette
   * @param {string} name - Command name to unregister
   */
  unregister: (name) => {
    // Remove local handler
    if (window._cmdHandlers) {
      delete window._cmdHandlers[name];
    }

    // Notify cmd to remove the command (GLOBAL scope for cross-window)
    ipcRenderer.send('publish', {
      source: sourceAddress,
      scope: 3,
      topic: 'cmd:unregister',
      data: { name }
    });

    DEBUG && console.log('[preload] commands.unregister:', name);
  },

  /**
   * List all registered commands from the cmd extension
   * Queries via pubsub cmd:query-commands and returns the result
   * @returns {Promise<{success: boolean, data?: Array<{name: string, description: string, source: string, scope?: string, modes?: string[]}>, error?: string}>}
   */
  list: () => {
    return new Promise((resolve) => {
      const responseTopic = `cmd:query-commands-response:${rndm()}`;

      const handler = (ev, msg) => {
        ipcRenderer.removeListener(responseTopic, handler);
        const commands = msg.commands || [];
        resolve({ success: true, data: commands });
      };

      // Subscribe to the unique response topic
      ipcRenderer.send('subscribe', {
        source: sourceAddress,
        scope: 3,
        topic: 'cmd:query-commands-response',
        replyTopic: responseTopic
      });
      ipcRenderer.on(responseTopic, handler);

      // Publish query request
      ipcRenderer.send('publish', {
        source: sourceAddress,
        scope: 3,
        topic: 'cmd:query-commands',
        data: {}
      });

      // Timeout after 3 seconds
      setTimeout(() => {
        ipcRenderer.removeListener(responseTopic, handler);
        resolve({ success: false, data: [], error: 'Timeout querying commands' });
      }, 3000);
    });
  },

  /**
   * Get all registered commands
   * Note: Commands are owned by cmd extension - use pubsub cmd:query-commands
   * @returns {Promise<Array>} Empty array - use pubsub directly
   * @deprecated Use commands.list() instead
   */
  getAll: async () => {
    // Commands are queried via pubsub cmd:query-commands
    // Return empty - caller should use pubsub directly
    return [];
  },

  /**
   * Get the current command context (target window, mode state, etc.)
   * Useful for determining command availability
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  getContext: () => {
    return ipcRenderer.invoke('modes:getCommandContext');
  },

  /**
   * Check if a specific command can execute in the current context
   * @param {string} name - Command name to check
   * @returns {Promise<boolean>}
   */
  canExecute: async (name) => {
    // Get current context
    const contextResult = await ipcRenderer.invoke('modes:getCommandContext');
    if (!contextResult.success) {
      return false;
    }

    // Request canExecute check from the command's source
    return new Promise((resolve) => {
      const responseTopic = `cmd:canExecute:response:${rndm()}`;

      // Subscribe to response
      const handler = (ev, msg) => {
        ipcRenderer.removeListener(responseTopic, handler);
        resolve(msg.canExecute ?? true);
      };

      // Set up one-time listener
      ipcRenderer.send('subscribe', {
        source: sourceAddress,
        scope: 3,
        topic: responseTopic,
        replyTopic: responseTopic
      });
      ipcRenderer.on(responseTopic, handler);

      // Request canExecute check
      ipcRenderer.send('publish', {
        source: sourceAddress,
        scope: 3,
        topic: `cmd:canExecute:${name}`,
        data: {
          context: contextResult.data,
          responseTopic
        }
      });

      // Timeout after 1 second - assume can execute
      setTimeout(() => {
        ipcRenderer.removeListener(responseTopic, handler);
        resolve(true);
      }, 1000);
    });
  }
};

// Extension management API
// Only available to core app (peek://app/...) and builtin extensions
// Uses pubsub to communicate with the extension loader in background.html
api.extensions = {
  /**
   * Check if caller has permission to manage extensions
   * Permission is denied for external extensions (non-builtin)
   * @returns {boolean}
   */
  _hasPermission: () => {
    // Core app always has permission
    if (sourceAddress.startsWith('peek://app/')) {
      return true;
    }
    // External extensions are not allowed to manage extensions
    // (builtin extensions run from peek://ext/ but are loaded by core)
    return false;
  },

  /**
   * Get list of running extensions (read-only, no permission check)
   * @returns {Promise<{success: boolean, data?: Array, error?: string}>}
   */
  list: () => {
    return ipcRenderer.invoke('extension-window-list');
  },

  /**
   * Get list of all registered (discovered) builtin extensions, whether running or not.
   * @returns {Promise<{success: boolean, data?: Array, error?: string}>}
   */
  listAllRegistered: () => {
    return ipcRenderer.invoke('extension-list-all-registered');
  },

  /**
   * Load an extension (permission required)
   * @param {string} id - Extension ID to load
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  load: (id) => {
    if (!api.extensions._hasPermission()) {
      return Promise.resolve({ success: false, error: 'Permission denied: only core app can manage extensions' });
    }
    return new Promise((resolve) => {
      const replyTopic = `ext:load:reply:${rndm()}`;

      ipcRenderer.send('subscribe', {
        source: sourceAddress,
        scope: 1,
        topic: replyTopic,
        replyTopic: replyTopic
      });

      const handler = (ev, msg) => {
        ipcRenderer.removeListener(replyTopic, handler);
        resolve(msg);
      };
      ipcRenderer.on(replyTopic, handler);

      ipcRenderer.send('publish', {
        source: sourceAddress,
        scope: 1,
        topic: 'ext:load',
        data: { id, replyTopic }
      });

      setTimeout(() => {
        ipcRenderer.removeListener(replyTopic, handler);
        resolve({ success: false, error: 'Timeout loading extension' });
      }, 10000);
    });
  },

  /**
   * Unload an extension (permission required)
   * @param {string} id - Extension ID to unload
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  unload: (id) => {
    if (!api.extensions._hasPermission()) {
      return Promise.resolve({ success: false, error: 'Permission denied: only core app can manage extensions' });
    }
    return new Promise((resolve) => {
      const replyTopic = `ext:unload:reply:${rndm()}`;

      ipcRenderer.send('subscribe', {
        source: sourceAddress,
        scope: 1,
        topic: replyTopic,
        replyTopic: replyTopic
      });

      const handler = (ev, msg) => {
        ipcRenderer.removeListener(replyTopic, handler);
        resolve(msg);
      };
      ipcRenderer.on(replyTopic, handler);

      ipcRenderer.send('publish', {
        source: sourceAddress,
        scope: 1,
        topic: 'ext:unload',
        data: { id, replyTopic }
      });

      setTimeout(() => {
        ipcRenderer.removeListener(replyTopic, handler);
        resolve({ success: false, error: 'Timeout unloading extension' });
      }, 10000);
    });
  },

  /**
   * Reload an extension (permission required)
   * Destroys the extension window and recreates it, reloading all code.
   * @param {string} id - Extension ID to reload
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  reload: (id) => {
    if (!api.extensions._hasPermission()) {
      return Promise.resolve({ success: false, error: 'Permission denied: only core app can manage extensions' });
    }
    return ipcRenderer.invoke('extension-reload', { id });
  },

  /**
   * Open devtools for an extension (permission required)
   * @param {string} id - Extension ID
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  devtools: (id) => {
    if (!api.extensions._hasPermission()) {
      return Promise.resolve({ success: false, error: 'Permission denied: only core app can manage extensions' });
    }
    return ipcRenderer.invoke('extension-window-devtools', { id });
  },

  /**
   * Get manifest for a running extension (read-only, no permission check)
   * @param {string} id - Extension ID
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  getManifest: (id) => {
    return new Promise((resolve) => {
      const replyTopic = `ext:manifest:reply:${rndm()}`;

      ipcRenderer.send('subscribe', {
        source: sourceAddress,
        scope: 1,
        topic: replyTopic,
        replyTopic: replyTopic
      });

      const handler = (ev, msg) => {
        ipcRenderer.removeListener(replyTopic, handler);
        resolve(msg);
      };
      ipcRenderer.on(replyTopic, handler);

      ipcRenderer.send('publish', {
        source: sourceAddress,
        scope: 1,
        topic: 'ext:manifest',
        data: { id, replyTopic }
      });

      setTimeout(() => {
        ipcRenderer.removeListener(replyTopic, handler);
        resolve({ success: false, error: 'Timeout getting manifest' });
      }, 5000);
    });
  },

  // ===== Datastore-backed extension management (persisted) =====

  /**
   * Open folder picker dialog to select an extension folder
   * @returns {Promise<{success: boolean, canceled?: boolean, data?: {path: string}, error?: string}>}
   */
  pickFolder: () => {
    return ipcRenderer.invoke('extension-pick-folder');
  },

  /**
   * Validate an extension folder (checks manifest.json)
   * @param {string} folderPath - Path to extension folder
   * @returns {Promise<{success: boolean, valid: boolean, errors?: string[], manifest?: object, error?: string}>}
   */
  validateFolder: (folderPath) => {
    return ipcRenderer.invoke('extension-validate-folder', { folderPath });
  },

  /**
   * Add extension to datastore (persisted)
   * @param {string} folderPath - Path to extension folder
   * @param {object} manifest - Parsed manifest (can be partial/invalid)
   * @param {boolean} enabled - Whether to enable immediately
   * @returns {Promise<{success: boolean, data?: {id: string}, error?: string}>}
   */
  add: (folderPath, manifest, enabled = false) => {
    if (!api.extensions._hasPermission()) {
      return Promise.resolve({ success: false, error: 'Permission denied' });
    }
    return ipcRenderer.invoke('extension-add', { folderPath, manifest, enabled });
  },

  /**
   * Remove extension from datastore
   * @param {string} id - Extension ID
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  remove: (id) => {
    if (!api.extensions._hasPermission()) {
      return Promise.resolve({ success: false, error: 'Permission denied' });
    }
    return ipcRenderer.invoke('extension-remove', { id });
  },

  /**
   * Update extension in datastore (enable/disable, etc.)
   * @param {string} id - Extension ID
   * @param {object} updates - Fields to update
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  update: (id, updates) => {
    if (!api.extensions._hasPermission()) {
      return Promise.resolve({ success: false, error: 'Permission denied' });
    }
    return ipcRenderer.invoke('extension-update', { id, updates });
  },

  /**
   * Get all extensions from datastore (includes non-running)
   * @returns {Promise<{success: boolean, data?: Array, error?: string}>}
   */
  getAll: () => {
    return ipcRenderer.invoke('extension-get-all');
  },

  /**
   * Get single extension from datastore
   * @param {string} id - Extension ID
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  get: (id) => {
    return ipcRenderer.invoke('extension-get', { id });
  },

  /**
   * Get settings schema for an extension
   * Reads schema from file specified in manifest.settingsSchema
   * @param {string} extId - Extension ID
   * @returns {Promise<{success: boolean, data?: {extId, name, schema}, error?: string}>}
   */
  getSettingsSchema: (extId) => {
    return ipcRenderer.invoke('extension-settings-schema', { extId });
  }
};

// Extension settings API (for isolated extension processes)
// Extensions can only access their own settings via datastore
api.settings = {
  /**
   * Get settings for the current extension
   * Only works from extension context (peek://ext/{id}/...)
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  get: () => {
    const extId = getExtensionId();
    if (!extId) {
      return Promise.resolve({ success: false, error: 'Not an extension context' });
    }
    return ipcRenderer.invoke('extension-settings-get', { extId });
  },

  /**
   * Save settings for the current extension
   * Only works from extension context (peek://ext/{id}/...)
   * @param {object} settings - Settings object to save (keys: prefs, items, etc.)
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  set: (settings) => {
    const extId = getExtensionId();
    if (!extId) {
      return Promise.resolve({ success: false, error: 'Not an extension context' });
    }
    return ipcRenderer.invoke('extension-settings-set', { extId, settings });
  },

  /**
   * Get a single setting key for the current extension
   * @param {string} key - Setting key (e.g., 'prefs', 'items')
   * @returns {Promise<{success: boolean, data?: any, error?: string}>}
   */
  getKey: (key) => {
    const extId = getExtensionId();
    if (!extId) {
      return Promise.resolve({ success: false, error: 'Not an extension context' });
    }
    return ipcRenderer.invoke('extension-settings-get-key', { extId, key });
  },

  /**
   * Set a single setting key for the current extension
   * @param {string} key - Setting key
   * @param {any} value - Value to set (will be JSON stringified)
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  setKey: (key, value) => {
    const extId = getExtensionId();
    if (!extId) {
      return Promise.resolve({ success: false, error: 'Not an extension context' });
    }
    return ipcRenderer.invoke('extension-settings-set-key', { extId, key, value });
  },

  /**
   * Read a single setting key from another extension (read-only)
   * Allows extensions to share preferences (e.g., tags reading editor's vim mode)
   * @param {string} extId - Target extension ID
   * @param {string} key - Setting key (e.g., 'prefs')
   * @returns {Promise<{success: boolean, data?: any, error?: string}>}
   */
  getExtKey: (extId, key) => {
    if (!extId || !key) {
      return Promise.resolve({ success: false, error: 'extId and key are required' });
    }
    return ipcRenderer.invoke('extension-settings-get-key', { extId, key });
  }
};

// Session API — allows extensions to trigger session-level operations
api.session = {
  /**
   * Save group workspace layouts (window positions per group)
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  saveGroupWorkspaces: () => {
    return ipcRenderer.invoke('save-group-workspaces');
  }
};

// Net fetch API - proxies HTTP requests through main process to bypass CORS
// Useful for extensions that need to fetch from external APIs
api.net = {
  /**
   * Fetch a URL through the main process (bypasses CORS restrictions)
   * @param {string} url - URL to fetch (http/https only)
   * @param {object} options - Fetch options (method, headers, timeout)
   * @returns {Promise<{success: boolean, data?: string, status?: number, error?: string}>}
   */
  fetch: (url, options = {}) => {
    return ipcRenderer.invoke('net-fetch', { url, options });
  }
};

// Escape handling API
// For windows with escapeMode: 'navigate' or 'auto'
// Callback should return { handled: true } if escape was handled internally
// or { handled: false } to let the window close
let _escapeCallback = null;

api.escape = {
  /**
   * Register an escape handler for this window
   * @param {function} callback - Returns { handled: true } if escape was handled
   */
  onEscape: (callback) => {
    _escapeCallback = callback;
    // The callback is purely informational — the backend consults it via
    // escape-pressed IPC and decides close/nothing based on the window's
    // declared role (set at open time), not self-declaration.
  },
  /**
   * Trigger the escape handler directly (for testing)
   * Returns the handler's response without going through IPC
   */
  trigger: async () => {
    if (_escapeCallback) {
      return await _escapeCallback();
    }
    return { handled: false };
  }
};

// OAuth loopback server — available to all pages including extensions
api.oauth = {
  startLoopback: (options) => ipcRenderer.invoke('oauth-start-loopback', options),
  awaitCallback: (port) => ipcRenderer.invoke('oauth-await-callback', { port }),
};

// Escape handler - responds to backend's escape query
// The backend intercepts ESC on keyDown via before-input-event and calls e.preventDefault(),
// so the DOM keydown event never reaches the page. This means peek-dialog's own keydown
// handler won't fire, and we handle dialog closing here in the preload instead.
//
// Order of precedence:
// 1. Open peek-dialog or native <dialog> - close the topmost one automatically
// 2. Extension's onEscape() callback - for internal navigation (search clear, filter reset, etc.)
// 3. Return { handled: false } - backend decides whether to close the window
//
// This eliminates the keyDown/keyUp race condition: since we intercept on keyDown and
// prevent DOM propagation, the dialog is still open when this handler runs.
ipcRenderer.on('escape-pressed', async (event, data) => {
  console.log('[preload:esc] escape-pressed received, hasCallback:', !!_escapeCallback, 'source:', sourceAddress);

  try {
    // Check for open dialogs first (peek-dialog or native <dialog>).
    // Find the topmost open dialog and close it. This handles ALL extensions
    // using peek-dialog without requiring per-extension workarounds.
    const openDialog = _findTopmostOpenDialog();
    if (openDialog) {
      const tag = openDialog.tagName;
      console.log('[preload:esc] Found open overlay:', tag, '- closing it');
      // Close via component API (peek-dialog, peek-drawer) or native dialog close
      if (typeof openDialog.close === 'function') {
        openDialog.close();
      }
      ipcRenderer.send(data.responseChannel, { handled: true });
      return;
    }

    // If app registered a handler (IZUI), use it
    if (_escapeCallback) {
      console.log('[preload:esc] Calling app escape handler');
      const startTime = Date.now();
      const result = await _escapeCallback();
      const elapsed = Date.now() - startTime;
      console.log('[preload:esc] App handler returned:', JSON.stringify(result), `(${elapsed}ms)`);
      ipcRenderer.send(data.responseChannel, result || { handled: false });
      return;
    }

    // No handler registered - let backend close the window
    console.log('[preload:esc] No handler registered, returning { handled: false }');
    ipcRenderer.send(data.responseChannel, { handled: false });
  } catch (err) {
    console.error('[preload:esc] Error in escape handler:', err);
    ipcRenderer.send(data.responseChannel, { handled: false });
  }
});

/**
 * Find the topmost open dialog/drawer in the document that should close on ESC.
 * Checks for peek-dialog[open], peek-drawer[open], and native dialog[open] elements.
 * Respects the closeOnEscape property (defaults to true on peek-dialog/peek-drawer).
 * Returns the element to close, or null if none found.
 */
function _findTopmostOpenDialog() {
  // Check for open peek-dialog and peek-drawer components (both reflect `open` as attribute)
  const peekOverlays = document.querySelectorAll('peek-dialog[open], peek-drawer[open]');
  if (peekOverlays.length > 0) {
    // Walk from last (topmost in DOM order) to first, respecting closeOnEscape property
    for (let i = peekOverlays.length - 1; i >= 0; i--) {
      const overlay = peekOverlays[i];
      // Default is true, so only skip if explicitly set to false
      if (overlay.closeOnEscape !== false) {
        return overlay;
      }
    }
  }

  // Check for native <dialog open> elements at document level
  const nativeDialogs = document.querySelectorAll('dialog[open]');
  if (nativeDialogs.length > 0) {
    return nativeDialogs[nativeDialogs.length - 1];
  }

  return null;
}

// ==================== Modes API ====================
// Context-aware command system
api.modes = {
  /**
   * Get the current mode state for a window
   * @param {number|null} windowId - Window ID (null = current/last focused)
   * @returns {Promise<{success: boolean, data?: {major: string}, error?: string}>}
   */
  getWindowMode: (windowId = null) => {
    return ipcRenderer.invoke('modes:getWindowMode', { windowId });
  },

  /**
   * Set the major mode for a window
   * @param {string} mode - Major mode ID ('page', 'group', 'default')
   * @param {number|null} windowId - Window ID (null = current/last focused)
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  setMajorMode: (mode, windowId = null) => {
    return ipcRenderer.invoke('modes:setMajorMode', { mode, windowId });
  },

  /**
   * Get all available modes
   * @returns {Promise<{success: boolean, data?: Array<{id: string, name: string, description: string}>, error?: string}>}
   */
  listModes: () => {
    return ipcRenderer.invoke('modes:listModes');
  },

  /**
   * Get command context for current state
   * Returns context with target window info and mode state
   * @returns {Promise<{success: boolean, data?: object, error?: string}>}
   */
  getCommandContext: () => {
    return ipcRenderer.invoke('modes:getCommandContext');
  },

  /**
   * Subscribe to mode changes
   * @param {function} callback - Called with (state, windowId) when mode changes
   */
  onModeChange: (callback) => {
    api.subscribe('modes:changed', (msg) => {
      callback({ major: msg.major }, msg.windowId);
    }, api.scopes.GLOBAL);
  }
};

// ==================== Context API ====================
// General-purpose key-value store for application context.
// "mode" is just one key in this system - extensions can define their own context keys.
api.context = {
  /**
   * Get the current context entry for a key
   * @param {string} key - Context key (e.g., 'mode')
   * @param {number|null} windowId - Window ID (null = current window)
   * @returns {Promise<{success: boolean, data?: {value: any, metadata: object, timestamp: number, source: string}, error?: string}>}
   */
  get: (key, windowId = null) => {
    return ipcRenderer.invoke('context-get', { key, windowId });
  },

  /**
   * Set a context value
   * @param {string} key - Context key (e.g., 'mode')
   * @param {any} value - Value to set
   * @param {object} options - Options
   * @param {object} [options.metadata={}] - Additional metadata
   * @param {number|null} [options.windowId=null] - Window ID (null = current window)
   * @returns {Promise<{success: boolean, data?: {id: string, prevEntryId: string|null}, error?: string}>}
   */
  set: (key, value, options = {}) => {
    return ipcRenderer.invoke('context-set', {
      key,
      value,
      metadata: options.metadata,
      windowId: options.windowId,
      source: options.source || sourceAddress
    });
  },

  /**
   * Watch for context changes on a key
   * @param {string} key - Context key to watch
   * @param {function} callback - Called with (entry, oldEntry) when context changes
   * @returns {function} Unsubscribe function
   */
  watch: (key, callback) => {
    // Use internal topic pattern for specific key watching
    const topic = 'context:changed';
    const wrappedCallback = (msg) => {
      if (msg.key === key) {
        callback({
          value: msg.value,
          metadata: msg.metadata,
          windowId: msg.windowId,
          source: msg.source,
          entryId: msg.entryId
        }, null); // oldEntry not available via pubsub
      }
    };

    api.subscribe(topic, wrappedCallback, api.scopes.GLOBAL);

    // Return unsubscribe function (note: pubsub doesn't support unsubscribe yet)
    return () => {
      DEBUG && console.log('[preload] context.watch unsubscribe not fully supported');
    };
  },

  /**
   * Query context history
   * @param {string} key - Context key
   * @param {object} options - Query options
   * @param {number} [options.since] - Start timestamp
   * @param {number} [options.until] - End timestamp
   * @param {number|null} [options.windowId] - Filter by window
   * @param {number} [options.limit] - Max entries
   * @param {string} [options.order='desc'] - Sort order ('asc' or 'desc')
   * @returns {Promise<{success: boolean, data?: Array, error?: string}>}
   */
  getHistory: (key, options = {}) => {
    return ipcRenderer.invoke('context-history', { key, ...options });
  },

  /**
   * Get context snapshot at a point in time
   * @param {number} timestamp - Point in time
   * @param {string[]} keys - Keys to include (empty = all)
   * @returns {Promise<{success: boolean, data?: Object, error?: string}>}
   */
  getSnapshot: (timestamp, keys = []) => {
    return ipcRenderer.invoke('context-snapshot', { timestamp, keys });
  },

  /**
   * Get all windows with a specific context value
   * @param {string} key - Context key
   * @param {any} value - Value to match
   * @returns {Promise<{success: boolean, data?: number[], error?: string}>}
   */
  getWindowsWithValue: (key, value) => {
    return ipcRenderer.invoke('context-windows-with-value', { key, value });
  },

  /**
   * Get all windows in a specific group
   * @param {string} groupId - Group ID
   * @returns {Promise<{success: boolean, data?: number[], error?: string}>}
   */
  getWindowsInGroup: (groupId) => {
    return ipcRenderer.invoke('context-windows-in-group', { groupId });
  },

  // ===== Mode-specific convenience methods =====

  /**
   * Get the current mode for a window
   * @param {number|null} windowId - Window ID (null = current)
   * @returns {Promise<string|null>} Mode value or null
   */
  getMode: async (windowId = null) => {
    const result = await ipcRenderer.invoke('context-get', { key: 'mode', windowId });
    return result.success && result.data ? result.data.value : null;
  },

  /**
   * Set the mode for a window
   * @param {string} mode - Mode value ('default', 'page', 'group', etc.)
   * @param {object} options - Options
   * @param {object} [options.metadata={}] - Mode metadata (e.g., groupId, groupName)
   * @param {number|null} [options.windowId=null] - Window ID
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  setMode: (mode, options = {}) => {
    return ipcRenderer.invoke('context-set', {
      key: 'mode',
      value: mode,
      metadata: options.metadata,
      windowId: options.windowId,
      source: options.source || sourceAddress
    });
  },

  /**
   * Watch for mode changes
   * @param {function} callback - Called with (mode, entry) when mode changes
   * @returns {function} Unsubscribe function
   */
  watchMode: (callback) => {
    return api.context.watch('mode', (entry) => {
      callback(entry?.value ?? null, entry);
    });
  },

  /**
   * Get all windows in a specific mode
   * @param {string} mode - Mode value
   * @returns {Promise<{success: boolean, data?: number[], error?: string}>}
   */
  getWindowsInMode: (mode) => {
    return ipcRenderer.invoke('context-windows-with-value', { key: 'mode', value: mode });
  }
};

/**
 * File operations
 */
api.files = {
  /**
   * Show native save dialog and write content to file
   * @param {string} content - Content to save
   * @param {object} options - Options { filename, mimeType }
   * @returns {Promise<{success: boolean, path?: string, canceled?: boolean, error?: string}>}
   */
  save: (content, options = {}) => {
    return ipcRenderer.invoke('file-save-dialog', {
      content,
      filename: options.filename,
      mimeType: options.mimeType
    });
  },

  /**
   * Show native open dialog, read file, and return content + metadata
   * @returns {Promise<{success: boolean, canceled?: boolean, data?: {name: string, path: string, size: number, mimeType: string, content: string|null, isText: boolean}, error?: string}>}
   */
  open: () => {
    return ipcRenderer.invoke('file-open-dialog');
  },

  /**
   * Read content directly from a file path (no dialog)
   * @param {string} filePath - Absolute path to read from
   * @returns {Promise<{success: boolean, data?: {content: string, name: string, path: string}, error?: string}>}
   */
  readFromPath: (filePath) => {
    return ipcRenderer.invoke('file-read-from-path', { filePath });
  },

  /**
   * Write content directly to a file path (no dialog)
   * @param {string} filePath - Absolute path to write to
   * @param {string} content - Content to write
   * @returns {Promise<{success: boolean, path?: string, error?: string}>}
   */
  writeToPath: (filePath, content) => {
    return ipcRenderer.invoke('file-write-to-path', { filePath, content });
  }
};

// IPC message receiving for core pages (peek://app/...)
// Used by extension host for ext:load, overlay for nav state, etc.
if (isCore) {
  api.ipc = {
    /**
     * Listen for IPC messages from main process
     * @param {string} channel - IPC channel to listen on
     * @param {function} callback - Handler for incoming messages
     */
    on: (channel, callback) => {
      ipcRenderer.on(channel, (event, ...args) => {
        callback(...args);
      });
    },
    /**
     * Send an IPC message to the main process
     * @param {string} channel - IPC channel to send on
     * @param {*} data - Data to send
     */
    send: (channel, data) => {
      ipcRenderer.send(channel, data);
    }
  };
}

// Generic IPC invoke for core pages (permission required for security)
// Used by diagnostic page and other core utilities
if (isCore) {
  /**
   * Invoke an IPC handler by channel name
   * Only available to core pages (peek://app/...)
   * @param {string} channel - IPC channel name
   * @param {any} data - Optional data to send
   * @returns {Promise<any>} - Result from IPC handler
   */
  api.invoke = (channel, data) => {
    return ipcRenderer.invoke(channel, data);
  };
}

contextBridge.exposeInMainWorld('app', api);
DEBUG && console.log(src, 'api exposed in', Date.now() - preloadStart, 'ms');

window.addEventListener('load', () => {
  DEBUG && console.log(src, 'window.load in', Date.now() - preloadStart, 'ms');
});

// ============================================================================
// Click-and-hold window dragging (unified, application-wide)
//
// Provides drag-to-move for all frameless windows. Hold the mouse button down
// for a short delay, then drag to move the window. Works in every window that
// doesn't opt out via `data-no-drag` on <body> (e.g., peek://page which has
// its own canvas-based drag system).
//
// Design (v3 rewrite):
//   - Window ID is fetched once at init (it never changes).
//   - Window position is fetched eagerly on mousedown (overlaps with hold timer).
//   - Hold delay is configurable via dragHoldDelay pref (default 1s).
//   - NO movement threshold during hold period. Mouse can move freely while
//     waiting for the hold timer to fire. When it fires, the CURRENT mouse
//     position becomes the drag origin (no jump from early movement).
//   - Text selection takes priority: if a selection appears during hold/drag,
//     the drag is cancelled.
//   - Only blocks drag when mousedown target IS a focused text input/textarea
//     or contentEditable. Other elements (buttons, labels, etc.) allow drag.
//   - Elements with data-no-drag attribute (or ancestors) never trigger drag.
//   - Button state tracked via mousedown/mouseup boolean (not e.buttons which
//     can be stale during fast cursor movement — known Chromium issue).
//   - Click suppression: after a drag, the subsequent click event is suppressed
//     to prevent accidental button/link activation.
//   - Window-level capture-phase listeners ensure events aren't lost when the
//     cursor escapes element boundaries during fast movement.
//   - requestAnimationFrame batches window-move IPC calls for smoothness.
//   - Comprehensive console.log('[DRAG]') breadcrumbs for diagnostics.
// ============================================================================
(function initWindowDrag() {
  const MOVE_THRESHOLD = 3; // px of movement required to engage drag after hold fires
  const JITTER_TOLERANCE = 3; // px of movement allowed during hold without cancelling

  // Configurable hold delay (read from prefs at init, default 1s)
  let HOLD_DELAY = 1000;

  // State
  let isDragging = false;
  let holdReady = false; // hold timer fired, waiting for movement to engage drag
  let holdTimer = null;
  let mouseButtonDown = false;
  let cachedWindowId = null;

  // Mouse positions
  let lastScreenX = 0;   // updated every mousemove while button is held
  let lastScreenY = 0;
  let holdOriginX = 0;   // screen coords at mousedown (for jitter detection during hold)
  let holdOriginY = 0;
  let dragOriginX = 0;   // screen coords at the moment drag began
  let dragOriginY = 0;
  let windowOriginX = 0; // window position at the moment drag began
  let windowOriginY = 0;

  // Eager position fetch (started on mousedown, resolved when hold fires)
  let positionPromise = null;

  // Click suppression after drag
  let suppressClick = false;

  // requestAnimationFrame dedup
  let rafPending = false;
  let rafX = 0;
  let rafY = 0;

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Should we block drag for this mousedown target? */
  const shouldBlockDrag = (target) => {
    if (!target) return false;
    // data-no-drag on element or ancestor
    if (target.closest && target.closest('[data-no-drag]')) return true;
    if (target.hasAttribute && target.hasAttribute('data-no-drag')) return true;
    // Block only when target IS a focused text input/textarea
    const tag = (target.tagName || '').toLowerCase();
    if ((tag === 'input' || tag === 'textarea') && target === document.activeElement) return true;
    // Block on contentEditable elements that are focused
    if (target.isContentEditable && target === document.activeElement) return true;
    return false;
  };

  /** Is there an active text selection? */
  const hasTextSelection = () => {
    const sel = window.getSelection();
    return sel && sel.toString().length > 0;
  };

  /** Cancel the hold timer without ending a drag in progress. */
  const cancelHold = () => {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  };

  /** End everything: cancel hold and/or stop drag. */
  const endDrag = (reason) => {
    const wasDragging = isDragging;
    const wasHoldReady = holdReady;
    cancelHold();
    holdReady = false;
    if (isDragging) {
      isDragging = false;
      suppressClick = true;
      document.body.classList.remove('is-dragging');
      document.body.style.userSelect = '';
      document.body.style.webkitUserSelect = '';
    }
    // Remove cursor classes
    if (wasDragging || wasHoldReady) {
      document.body.classList.remove('hold-ready');
    }
    positionPromise = null;
    if (wasDragging) {
      console.log('[DRAG] ended:', reason);
    }
  };

  // -------------------------------------------------------------------------
  // Core event handlers
  // -------------------------------------------------------------------------

  const onMouseDown = (e) => {
    if (e.button !== 0) return;
    mouseButtonDown = true;

    // Always record position (used by hold timer to set drag origin)
    lastScreenX = e.screenX;
    lastScreenY = e.screenY;
    holdOriginX = e.screenX;
    holdOriginY = e.screenY;

    const blocked = shouldBlockDrag(e.target);
    console.log('[DRAG] mousedown', e.target?.tagName,
      (e.target?.className?.toString?.() || '').slice(0, 40),
      '| blocked:', blocked, '| wid:', cachedWindowId);

    if (blocked) return;
    if (!cachedWindowId) {
      console.log('[DRAG] abort: no windowId');
      return;
    }

    // Eagerly fetch window position (overlaps with hold timer)
    positionPromise = ipcRenderer.invoke('window-get-position', { id: cachedWindowId })
      .catch((err) => { console.log('[DRAG] pos fetch fail:', err); return null; });

    // Start hold timer. Mouse must stay still (within jitter tolerance) during
    // the hold period. Movement cancels the timer, allowing text selection.
    holdTimer = setTimeout(async () => {
      holdTimer = null;

      if (!mouseButtonDown) {
        console.log('[DRAG] hold expired but button already released');
        positionPromise = null;
        return;
      }
      if (hasTextSelection()) {
        console.log('[DRAG] hold expired but text selected');
        positionPromise = null;
        return;
      }

      const pos = await positionPromise;
      positionPromise = null;

      if (!pos || !pos.success) {
        console.log('[DRAG] hold expired but pos fetch failed:', pos);
        return;
      }
      if (!mouseButtonDown) {
        console.log('[DRAG] hold expired but button released during await');
        return;
      }

      // Hold fired — show visual cursor feedback. Drag engages on next movement.
      dragOriginX = lastScreenX;
      dragOriginY = lastScreenY;
      windowOriginX = pos.x;
      windowOriginY = pos.y;
      holdReady = true;
      document.body.classList.add('hold-ready');

      console.log('[DRAG] HOLD READY (cursor→grab) origin=(' + dragOriginX + ',' + dragOriginY +
        ') window=(' + windowOriginX + ',' + windowOriginY + ')');
    }, HOLD_DELAY);
  };

  const onMouseMove = (e) => {
    if (!mouseButtonDown) return;

    // Always track latest mouse position (hold timer reads this)
    lastScreenX = e.screenX;
    lastScreenY = e.screenY;

    // During hold period (timer not yet fired): cancel if mouse moves beyond jitter tolerance.
    // This allows text selection to proceed normally.
    if (holdTimer && !holdReady && !isDragging) {
      const dx = Math.abs(e.screenX - holdOriginX);
      const dy = Math.abs(e.screenY - holdOriginY);
      if (dx > JITTER_TOLERANCE || dy > JITTER_TOLERANCE) {
        cancelHold();
        positionPromise = null;
        console.log('[DRAG] hold cancelled — mouse moved during hold period');
        return;
      }
    }

    // Hold timer fired (cursor is 'grab') — engage drag once movement exceeds threshold
    if (holdReady && !isDragging) {
      const dx = e.screenX - dragOriginX;
      const dy = e.screenY - dragOriginY;
      if (Math.abs(dx) < MOVE_THRESHOLD && Math.abs(dy) < MOVE_THRESHOLD) return;

      holdReady = false;
      isDragging = true;
      document.body.classList.remove('hold-ready');
      document.body.classList.add('is-dragging');
      window.getSelection()?.removeAllRanges();
      document.body.style.userSelect = 'none';
      document.body.style.webkitUserSelect = 'none';
      console.log('[DRAG] ENGAGED after movement');
    }

    if (!isDragging) return;

    // Compute new window position
    const deltaX = e.screenX - dragOriginX;
    const deltaY = e.screenY - dragOriginY;
    rafX = windowOriginX + deltaX;
    rafY = windowOriginY + deltaY;

    // Batch via requestAnimationFrame for smoothness
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        if (isDragging && cachedWindowId) {
          ipcRenderer.invoke('window-move', { id: cachedWindowId, x: rafX, y: rafY });
        }
      });
    }
  };

  const onMouseUp = (e) => {
    if (e.button !== 0) return;
    mouseButtonDown = false;

    if (isDragging) {
      console.log('[DRAG] mouseup ending drag');
    }
    endDrag('mouseup');
  };

  /** Suppress click events that fire after a drag. */
  const onClickCapture = (e) => {
    if (suppressClick) {
      suppressClick = false;
      e.stopImmediatePropagation();
      e.preventDefault();
      console.log('[DRAG] suppressed post-drag click on', e.target?.tagName);
    }
  };

  /** End drag if window loses focus — but only cancel the hold timer, not an active drag.
   * During fast dragging the cursor can momentarily leave the window, firing blur.
   * An active drag should only end on mouseup. */
  const onBlur = () => {
    cancelHold();
    // Don't cancel an active drag on blur — the window is moving under the cursor
    // and blur fires spuriously during fast drags. mouseup will end the drag.
  };

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------
  const init = async () => {
    try {
      cachedWindowId = await ipcRenderer.invoke('get-window-id');
    } catch (err) {
      console.error('[DRAG] failed to get window ID:', err);
    }

    // Read drag hold delay from prefs (in seconds, convert to ms)
    try {
      const prefs = await ipcRenderer.invoke('get-app-prefs');
      if (prefs && typeof prefs.dragHoldDelay === 'number') {
        HOLD_DELAY = Math.max(0, prefs.dragHoldDelay * 1000);
      }
    } catch (err) {
      console.warn('[DRAG] failed to read prefs, using default hold delay:', err);
    }

    // Inject drag cursor styles with !important to override element-level cursor rules
    const dragStyle = document.createElement('style');
    dragStyle.textContent = `
      body.hold-ready, body.hold-ready * { cursor: grab !important; }
      body.is-dragging, body.is-dragging * { cursor: grabbing !important; }
    `;
    document.head.appendChild(dragStyle);

    // Capture-phase on document for mousedown (need e.target for shouldBlockDrag).
    // Capture-phase on window for mousemove/mouseup (survive fast cursor escape).
    document.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('mousemove', onMouseMove, true);
    window.addEventListener('mouseup', onMouseUp, true);
    window.addEventListener('blur', onBlur);
    document.addEventListener('click', onClickCapture, true);

    console.log('[DRAG] initialized, windowId:', cachedWindowId, 'holdDelay:', HOLD_DELAY + 'ms');
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();


/*
const handleMainWindow = () => {
  window.addEventListener('load', () => {
    const replaceText = (selector, text) => {
      const element = document.getElementById(selector)
      if (element) element.innerText = text
    }

    for (const dependency of ['chrome', 'node', 'electron']) {
      replaceText(`${dependency}-version`, process.versions[dependency])
    }
  });
};
*/

/*
window.addEventListener('DOMContentLoaded', () => {
  const replaceText = (selector, text) => {
    const element = document.getElementById(selector)
    if (element) element.innerText = text
  }

  for (const dependency of ['chrome', 'node', 'electron']) {
    replaceText(`${dependency}-version`, process.versions[dependency])
  }
})
*/
