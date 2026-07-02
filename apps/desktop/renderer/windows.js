import { openStore } from "./utils.js";
import api from './api.js';
import { trackNavigation } from './datastore/history.js';

const clear = false;

// maps app id to BrowserWindow id (background)
const windows = new Map();

/**
 * Track navigation for an address
 * @param {string} address - URL that was navigated to
 * @param {Object} params - Window parameters containing tracking options
 */
const maybeTrackNavigation = (address, params = {}) => {
  trackNavigation(address, {
    source: params.trackingSource || params.feature || 'window',
    sourceId: params.trackingSourceId || '',
    windowType: params.modal ? 'modal' : 'main',
    title: params.title || ''
  });
};

/**
 * Creates a window and handles its lifecycle
 * @param {string} address - URL to open in the window
 * @param {Object} params - Window parameters
 * @param {boolean} [params.openDevTools=false] - Whether to open DevTools for this window
 * @param {boolean} [params.detachedDevTools=true] - Whether DevTools should be detached
 * @param {string} [params.trackingSource] - Source for navigation tracking
 * @param {string} [params.trackingSourceId] - Source ID for navigation tracking
 * @returns {Promise<Object>} - Promise resolving to an object with methods to interact with the window
 */
const createWindow = async (address, params = {}) => {
  //console.log('Creating window with params:', params);

  let windowId;

  // Always use the IPC API
  if (api.window && api.window.open) {
    const result = await api.window.open(address, params);
    if (result.success) {
      windowId = result.id;

      // Track navigation on success
      maybeTrackNavigation(address, params);
    } else {
      console.error('Failed to open window:', result.error);
      throw new Error(`Failed to open window: ${result.error}`);
    }
  } else {
    console.error('API window.open not available');
    throw new Error('API window.open not available. Cannot open window.');
  }

  // Return an API for the window. Only id + focus are used by callers
  // today (settings open in app/index.js). close/hide/show/blur/move
  // were never called externally — dropped to avoid exposing broken
  // `{ id: ... }` payload shapes against the plain-number strict surface.
  return {
    id: windowId,
    focus: () => api.window.focus(windowId)
  };
};

export default {
  createWindow
};
