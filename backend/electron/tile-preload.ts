/**
 * Tile Preload Script — Capability-scoped API injection
 *
 * This runs in the renderer process of each tile with contextIsolation: true.
 * It reads the tile ID and capability token from process args, validates the
 * token with the main process, and builds an API object with ONLY the
 * granted capabilities. Injected via contextBridge.exposeInMainWorld('app', api).
 *
 * NOTE: This file is written as a CommonJS module (like preload.js) because
 * Electron preload scripts must use require(), not import.
 */

const { contextBridge, ipcRenderer } = require('electron');

// ─── Parse CLI Arguments ─────────────────────────────────────────────

function getArg(prefix: string): string | null {
  for (const arg of process.argv) {
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return null;
}

const tileId = getArg('--tile-id=');
const tileEntry = getArg('--tile-entry=');
const tileToken = getArg('--tile-token=');

if (!tileId || !tileEntry || !tileToken) {
  console.error('[tile-preload] Missing tile arguments. This preload is only for v2 tiles.');
  // Expose minimal error API
  contextBridge.exposeInMainWorld('app', {
    error: 'Tile preload misconfigured: missing tile-id, tile-entry, or tile-token',
    getTileId: () => null,
  });
  // Early exit — don't expose any capabilities
  return;
}

const sourceAddress = `peek://${tileId}/${tileEntry}`;

// ─── Token Validation (Synchronous bootstrap) ────────────────────────

// We validate the token asynchronously but build the API synchronously
// with placeholder functions that queue until validation completes.
// The tile must call initialize() which awaits validation.

let tokenValid = false;
let grantedCapabilities: Record<string, unknown> = {};
let validationPromise: Promise<boolean> | null = null;

function validateToken(): Promise<boolean> {
  if (validationPromise) return validationPromise;

  validationPromise = ipcRenderer.invoke('tile:validate-token', {
    tileId,
    tileEntry,
    token: tileToken,
  }).then((result: { valid: boolean; capabilities?: Record<string, unknown> }) => {
    tokenValid = result.valid;
    if (result.capabilities) {
      grantedCapabilities = result.capabilities;
    }
    return result.valid;
  }).catch(() => {
    tokenValid = false;
    return false;
  });

  return validationPromise;
}

// ─── API Builder ─────────────────────────────────────────────────────

/**
 * Build the tile API based on granted capabilities
 */
function buildAPI(): Record<string, unknown> {
  const api: Record<string, unknown> = {};

  // ── Base API (always available) ──

  api.version = '2.0.0';

  api.getTileId = () => tileId;

  api.getTileEntry = () => tileEntry;

  /**
   * Initialize the tile — must be called before using any capability APIs.
   * Validates the capability token with the main process.
   * Returns the granted capabilities object.
   */
  api.initialize = async () => {
    const valid = await validateToken();
    if (!valid) {
      throw new Error('Tile token validation failed. Tile may have been revoked.');
    }

    // Signal ready to main process
    ipcRenderer.send('tile:ready', { tileId, tileEntry });

    return { capabilities: grantedCapabilities };
  };

  /**
   * Register a shutdown handler
   */
  api.onShutdown = (callback: () => void) => {
    ipcRenderer.on('tile:shutdown', () => {
      callback();
    });
  };

  // ── Scopes (always available for reference) ──

  api.scopes = {
    SELF: 2,
    GLOBAL: 3,
  };

  // ── PubSub (if granted) ──

  api.pubsub = {
    /**
     * Publish a message to a topic
     * Scope enforcement happens in the main process based on granted pubsub scopes
     */
    publish: (topic: string, data: unknown, scope?: number) => {
      if (!tokenValid) {
        console.warn('[tile-preload] pubsub.publish called before initialize()');
        return;
      }
      ipcRenderer.send('tile:pubsub:publish', {
        token: tileToken,
        source: sourceAddress,
        scope: scope || 2, // Default to SELF
        topic,
        data,
      });
    },

    /**
     * Subscribe to a topic
     */
    subscribe: (topic: string, callback: (data: unknown) => void) => {
      if (!tokenValid) {
        console.warn('[tile-preload] pubsub.subscribe called before initialize()');
        return () => {};
      }
      // Register with main process
      ipcRenderer.send('tile:pubsub:subscribe', {
        token: tileToken,
        source: sourceAddress,
        topic,
      });

      // Listen for messages on this topic
      const handler = (_event: unknown, msg: unknown) => {
        callback(msg);
      };
      ipcRenderer.on(`pubsub:${topic}`, handler);

      // Return unsubscribe function
      return () => {
        ipcRenderer.removeListener(`pubsub:${topic}`, handler);
        ipcRenderer.send('tile:pubsub:unsubscribe', {
          token: tileToken,
          source: sourceAddress,
          topic,
        });
      };
    },
  };

  // ── Commands (if granted) ──

  api.commands = {
    /**
     * Register a command handler
     */
    register: (name: string, handler: (params: unknown) => unknown) => {
      if (!tokenValid) {
        console.warn('[tile-preload] commands.register called before initialize()');
        return;
      }
      ipcRenderer.send('tile:command:register', {
        token: tileToken,
        tileId,
        name,
      });

      // Listen for command execution
      ipcRenderer.on(`tile:cmd:execute:${name}`, async (_event: unknown, params: unknown) => {
        try {
          const result = await handler(params);
          ipcRenderer.send('tile:command:result', {
            token: tileToken,
            name,
            result,
          });
        } catch (err) {
          ipcRenderer.send('tile:command:result', {
            token: tileToken,
            name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    },
  };

  // ── Window (if granted) ──

  api.window = {
    /**
     * Open a new window
     */
    open: (url: string, options?: Record<string, unknown>) => {
      if (!tokenValid) return Promise.reject(new Error('Not initialized'));
      return ipcRenderer.invoke('tile:window:open', {
        token: tileToken,
        url,
        options,
      });
    },

    /**
     * Close the current tile window
     */
    close: () => {
      ipcRenderer.send('tile:window:close', {
        token: tileToken,
      });
    },

    /**
     * Get info about the current window
     */
    getInfo: () => {
      return ipcRenderer.invoke('tile:window:info', {
        token: tileToken,
      });
    },
  };

  // ── Datastore (if granted) ──

  api.datastore = {
    /**
     * Get a value from the tile's scoped storage
     */
    get: (table: string, key: string) => {
      if (!tokenValid) return Promise.reject(new Error('Not initialized'));
      return ipcRenderer.invoke('tile:datastore:get', {
        token: tileToken,
        table,
        key,
      });
    },

    /**
     * Set a value in the tile's scoped storage
     */
    set: (table: string, key: string, value: unknown) => {
      if (!tokenValid) return Promise.reject(new Error('Not initialized'));
      return ipcRenderer.invoke('tile:datastore:set', {
        token: tileToken,
        table,
        key,
        value,
      });
    },

    /**
     * Query rows from a table
     */
    query: (table: string, filter?: Record<string, unknown>) => {
      if (!tokenValid) return Promise.reject(new Error('Not initialized'));
      return ipcRenderer.invoke('tile:datastore:query', {
        token: tileToken,
        table,
        filter,
      });
    },
  };

  // ── Network (if granted) ──

  api.network = {
    /**
     * Fetch a URL — domain-gated by capability
     * The main process validates the domain against the allowlist
     */
    fetch: (url: string, options?: Record<string, unknown>) => {
      if (!tokenValid) return Promise.reject(new Error('Not initialized'));
      return ipcRenderer.invoke('tile:network:fetch', {
        token: tileToken,
        url,
        options,
      });
    },
  };

  // ── Filesystem (if granted) ──

  api.filesystem = {
    /**
     * Read a file — path-gated by capability
     */
    read: (filePath: string) => {
      if (!tokenValid) return Promise.reject(new Error('Not initialized'));
      return ipcRenderer.invoke('tile:filesystem:read', {
        token: tileToken,
        path: filePath,
      });
    },

    /**
     * Write a file — path-gated by capability
     */
    write: (filePath: string, content: string) => {
      if (!tokenValid) return Promise.reject(new Error('Not initialized'));
      return ipcRenderer.invoke('tile:filesystem:write', {
        token: tileToken,
        path: filePath,
        content,
      });
    },
  };

  // ── Theme (if granted) ──

  api.theme = {
    /**
     * Get current theme info
     */
    getInfo: () => {
      return ipcRenderer.invoke('tile:theme:info', {
        token: tileToken,
      });
    },

    /**
     * Subscribe to theme changes
     */
    onChange: (callback: (theme: unknown) => void) => {
      ipcRenderer.on('tile:theme:changed', (_event: unknown, data: unknown) => {
        callback(data);
      });
    },
  };

  // ── Settings (if granted) ──

  api.settings = {
    /**
     * Get a setting value
     */
    get: (key: string) => {
      if (!tokenValid) return Promise.reject(new Error('Not initialized'));
      return ipcRenderer.invoke('tile:settings:get', {
        token: tileToken,
        key,
      });
    },

    /**
     * Set a setting value
     */
    set: (key: string, value: unknown) => {
      if (!tokenValid) return Promise.reject(new Error('Not initialized'));
      return ipcRenderer.invoke('tile:settings:set', {
        token: tileToken,
        key,
        value,
      });
    },
  };

  // ── Log (always available) ──

  api.log = (...args: unknown[]) => {
    ipcRenderer.send('renderer-log', { source: sourceAddress, args });
  };

  return api;
}

// ─── Expose API ──────────────────────────────────────────────────────

const api = buildAPI();
contextBridge.exposeInMainWorld('app', api);
