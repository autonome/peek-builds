/**
 * Page commands - interact with web page content in the focused page window
 *
 * Two command verbs:
 *   list <type>  — enumerate page content (images, feeds, links, entities)
 *   view <mode>  — change how the page is displayed (reader, source, devtools)
 *
 * These commands communicate with page.js via pubsub:
 *   1. Command publishes page:cmd:request with a requestId and action
 *   2. page.js receives it, runs executeJavaScript on the webview
 *   3. page.js publishes page:cmd:response with the requestId and result
 *
 * Commands are restricted to 'page' mode via the modes property.
 */
import api from 'peek://app/api.js';

let requestCounter = 0;

/**
 * Send a request to the focused page window and wait for a response.
 * @param {string} action - The action to perform (e.g., 'list-images')
 * @param {Object} params - Additional parameters
 * @param {number} timeout - Timeout in ms (default 10s)
 * @returns {Promise<Object>} The response data
 */
function pageRequest(action, params = {}, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const requestId = `page-cmd-${++requestCounter}-${Date.now()}`;
    let settled = false;

    const unsubscribe = api.subscribe('page:cmd:response', (msg) => {
      if (msg.requestId !== requestId) return;
      if (settled) return;
      settled = true;
      unsubscribe?.();
      if (msg.error) {
        reject(new Error(msg.error));
      } else {
        resolve(msg.data);
      }
    }, api.scopes.GLOBAL);

    api.publish('page:cmd:request', {
      requestId,
      action,
      ...params
    }, api.scopes.GLOBAL);

    setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      reject(new Error('No page window responded. Is a web page open?'));
    }, timeout);
  });
}

// --- List command ---

const LIST_TYPES = [
  { value: 'images', title: 'images', subtitle: 'Extract all images from the page' },
  { value: 'feeds', title: 'feeds', subtitle: 'Find RSS/Atom feeds linked from the page' },
  { value: 'links', title: 'links', subtitle: 'Extract all links from the page' },
  { value: 'entities', title: 'entities', subtitle: 'List detected entities (people, orgs, places, emails, phones)' },
];

const listCommand = {
  name: 'list',
  description: 'List page content by type',
  modes: ['page'],
  produces: ['application/json'],
  params: [{
    type: 'enum',
    options: LIST_TYPES
  }],

  async execute(ctx) {
    const subcommand = (ctx.params && ctx.params[0]) || (ctx.search || '').trim();

    if (!subcommand) {
      return {
        success: false,
        message: 'Specify what to list: images, feeds, links, or entities'
      };
    }

    const type = subcommand.toLowerCase();

    try {
      const data = await pageRequest(`list-${type}`);

      if (!data || (Array.isArray(data) && data.length === 0)) {
        return {
          success: true,
          message: `No ${type} found on this page`
        };
      }

      return {
        success: true,
        output: {
          data,
          mimeType: 'application/json',
          title: `${Array.isArray(data) ? data.length : 0} ${type} found`
        }
      };
    } catch (err) {
      return {
        success: false,
        message: err.message
      };
    }
  }
};

// --- View command ---

const VIEW_TYPES = [
  { value: 'reader', title: 'reader', subtitle: 'Toggle reader mode (strip to readable content)' },
  { value: 'source', title: 'source', subtitle: 'Show page source' },
  { value: 'devtools', title: 'devtools', subtitle: 'Open DevTools for the page' },
];

const viewCommand = {
  name: 'view',
  description: 'Change page display mode',
  modes: ['page'],
  params: [{
    type: 'enum',
    options: VIEW_TYPES
  }],

  async execute(ctx) {
    const subcommand = (ctx.params && ctx.params[0]) || (ctx.search || '').trim();

    if (!subcommand) {
      return {
        success: false,
        message: 'Specify a view mode: reader, source, or devtools'
      };
    }

    const mode = subcommand.toLowerCase();

    if (mode === 'devtools') {
      // DevTools is handled via IPC directly, not via page.js
      try {
        const result = await api.invoke('window-devtools', {});
        if (result && result.success) {
          return { success: true, message: 'DevTools opened' };
        } else {
          return { success: false, message: result?.error || 'Failed to open DevTools' };
        }
      } catch (err) {
        return { success: false, message: err.message };
      }
    }

    try {
      const data = await pageRequest(`view-${mode}`);
      if (mode === 'source' && data) {
        return {
          success: true,
          output: {
            data: data.html || data,
            mimeType: 'text/html',
            title: `Source: ${data.title || 'page'}`
          }
        };
      }
      return {
        success: true,
        message: data?.message || `View mode changed to ${mode}`
      };
    } catch (err) {
      return {
        success: false,
        message: err.message
      };
    }
  }
};

const commands = [listCommand, viewCommand];

export default { commands };
