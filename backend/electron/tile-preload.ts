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
  // Early exit — don't expose any capabilities (wrapped in IIFE since top-level return is invalid)
} else {

const sourceAddress = `peek://${tileId}/${tileEntry}`;

// ─── Token Validation (Synchronous bootstrap) ────────────────────────

// We validate the token asynchronously but build the API synchronously
// with placeholder functions that queue until validation completes.
// The tile must call initialize() which awaits validation.

let tokenValid = false;
let grantedCapabilities: Record<string, unknown> = {};
let validationPromise: Promise<boolean> | undefined;

function validateToken(): Promise<boolean> {
  if (validationPromise !== undefined) return validationPromise;

  const promise = ipcRenderer.invoke('tile:validate-token', {
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

  validationPromise = promise;
  return promise;
}

// ─── Capability-Violation Logger (Phase 1) ───────────────────────────
//
// v1-compat shims delegate directly to legacy IPC handlers that do not
// perform capability enforcement. As part of the tile-preload trimming
// plan (docs/tile-preload-trimming-plan.md), we log the first call to
// each (tileId, surface.method) pair so we can measure real usage and
// verify zero-hit before deletion in Phase 4.
//
// Rules (see trimming plan Phase 1):
// - Log once per (tileId, "surface.method") pair.
// - NEVER throw, NEVER change behaviour — observational only.
// - Applies only to v1-compat surfaces that will be removed or replaced
//   by strict-mode equivalents. Strict surfaces (pubsub, window.open/
//   close/getInfo, filesystem, network, theme, sync, scopes, commands)
//   are NOT wrapped.

const compatSeen = new Set<string>();

function logCompatViolation(surface: string, method: string): void {
  const key = `${tileId}::${surface}.${method}`;
  if (compatSeen.has(key)) return;
  compatSeen.add(key);
  try {
    // Intentional console.warn — these land in the tile's devtools and in
    // the main-process renderer-log handler. Phase 5 will promote these
    // to a pubsub topic or a throw under TILE_STRICT=true.
    console.warn(`[tile-compat] tile=${tileId} called shim api.${surface}.${method}(...) — no strict enforcement`);
  } catch (_err) {
    // Logging must never throw.
  }
}

/**
 * Wrap a zero-or-more-arg function so its first invocation logs a
 * capability-violation warning. Preserves `this`, arguments, and return
 * value exactly. Errors in the wrapped call propagate unchanged.
 */
function wrapCompat<F extends (...args: unknown[]) => unknown>(
  surface: string,
  method: string,
  fn: F,
): F {
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    logCompatViolation(surface, method);
    return fn.apply(this, args);
  };
  return wrapped as F;
}

/**
 * Wrap every own method of an object with wrapCompat under the given
 * surface name. Non-function properties are copied through unchanged.
 */
function wrapCompatObject<T extends Record<string, unknown>>(surface: string, obj: T): T {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === 'function') {
      out[key] = wrapCompat(surface, key, val as (...args: unknown[]) => unknown);
    } else {
      out[key] = val;
    }
  }
  return out as T;
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
   * Register a shutdown handler.
   *
   * The underlying IPC listener is installed exactly once. Subsequent calls
   * replace the stored callback — repeated `api.onShutdown(cb)` invocations
   * do NOT accumulate listeners on the `tile:shutdown` channel. This matters
   * for hot-reload scenarios and features that re-register on every init.
   */
  let shutdownCallback: (() => void) | null = null;
  let shutdownListenerInstalled = false;
  api.onShutdown = (callback: () => void) => {
    shutdownCallback = typeof callback === 'function' ? callback : null;
    if (!shutdownListenerInstalled) {
      shutdownListenerInstalled = true;
      ipcRenderer.on('tile:shutdown', () => {
        try {
          shutdownCallback?.();
        } catch (err) {
          console.error('[tile-preload] onShutdown callback threw:', err);
        }
      });
    }
  };

  // ── Scopes (always available for reference) ──

  api.scopes = {
    SELF: 2,
    GLOBAL: 3,
  };

  // ── PubSub (if granted) ──
  //
  // Publish supports two call shapes:
  //   api.publish(topic, data, scope?)        // v1-style
  //   api.pubsub.publish(topic, data, scope?) // v2-style (kept for clarity)
  // Subscribe supports an optional scope tail argument — callers like editor use
  // `api.subscribe('editor:open', handler, api.scopes.GLOBAL)`. Scope is only
  // advisory for the client — capability-based enforcement happens in main.

  function publishImpl(topic: string, data: unknown, scope?: number) {
    if (!tokenValid) {
      console.warn('[tile-preload] publish called before initialize()');
      return;
    }
    ipcRenderer.send('tile:pubsub:publish', {
      token: tileToken,
      source: sourceAddress,
      scope: scope || 2,
      topic,
      data,
    });
  }

  function subscribeImpl(topic: string, callback: (data: unknown) => void, _scope?: number) {
    if (!tokenValid) {
      console.warn('[tile-preload] subscribe called before initialize()');
      return () => {};
    }
    ipcRenderer.send('tile:pubsub:subscribe', {
      token: tileToken,
      source: sourceAddress,
      topic,
    });

    const handler = (_event: unknown, msg: unknown) => {
      callback(msg);
    };
    ipcRenderer.on(`pubsub:${topic}`, handler);

    return () => {
      ipcRenderer.removeListener(`pubsub:${topic}`, handler);
      ipcRenderer.send('tile:pubsub:unsubscribe', {
        token: tileToken,
        source: sourceAddress,
        topic,
      });
    };
  }

  // Top-level `api.publish` / `api.subscribe` are v1-compat aliases for
  // `api.pubsub.publish` / `api.pubsub.subscribe`. Log usage to drive the
  // Phase 4 removal (see tile-preload-trimming-plan.md).
  api.publish = wrapCompat('publish', '(top-level)', publishImpl as (...args: unknown[]) => unknown);
  api.subscribe = wrapCompat('subscribe', '(top-level)', subscribeImpl as (...args: unknown[]) => unknown);

  api.pubsub = {
    publish: publishImpl,
    subscribe: subscribeImpl,
  };

  // ── Commands (if granted) ──
  //
  // Supports two registration shapes to match existing feature code:
  //
  //   api.commands.register(name, handler)
  //     Minimal v2 signature — just attaches a handler for cmd:execute:{name}.
  //
  //   api.commands.register({name, description, execute, scope, modes, params, ...})
  //     v1-compatible signature. Re-publishes cmd:register so the cmd panel
  //     picks it up (matches preload.js behaviour) and wires the execute
  //     handler identically.
  //
  // Both flow through the shared pubsub-based cmd:execute:{name} / :result
  // protocol, so lazy-tile replay and the cmd panel proxy work unchanged.

  // Per-command handler registry. Prevents duplicate IPC listeners if a tile
  // re-registers the same command (swap handler in-place instead of adding a
  // second `pubsub:cmd:execute:{name}` listener).
  const registeredCommands = new Map<string, (params: unknown) => unknown>();

  api.commands = {
    register: (nameOrCommand: unknown, maybeHandler?: (params: unknown) => unknown) => {
      if (!tokenValid) {
        console.warn('[tile-preload] commands.register called before initialize()');
        return;
      }

      let name: string;
      let handler: (params: unknown) => unknown;
      let description = '';
      let scope: string | undefined;
      let modes: string[] | undefined;
      let accepts: unknown;
      let produces: unknown;
      let params: unknown;

      if (typeof nameOrCommand === 'string') {
        name = nameOrCommand;
        if (typeof maybeHandler !== 'function') {
          console.error('[tile-preload] commands.register(name, handler): handler must be a function');
          return;
        }
        handler = maybeHandler;
      } else if (nameOrCommand && typeof nameOrCommand === 'object') {
        const cmd = nameOrCommand as {
          name?: string;
          description?: string;
          execute?: (params: unknown) => unknown;
          scope?: string;
          modes?: string[];
          accepts?: unknown;
          produces?: unknown;
          params?: unknown;
        };
        if (!cmd.name || typeof cmd.execute !== 'function') {
          console.error('[tile-preload] commands.register: name and execute are required');
          return;
        }
        name = cmd.name;
        handler = cmd.execute;
        description = cmd.description || '';
        scope = cmd.scope;
        modes = cmd.modes;
        accepts = cmd.accepts;
        produces = cmd.produces;
        params = cmd.params;
      } else {
        console.error('[tile-preload] commands.register: invalid arguments');
        return;
      }

      // Deduplicate: if this command was already registered, swap the handler
      // in-place (no new IPC listener, no new pubsub subscribe) and skip the
      // rest of the setup. This prevents listener accumulation when a tile
      // re-registers the same command (e.g. after hot reload).
      const alreadyRegistered = registeredCommands.has(name);
      registeredCommands.set(name, handler);
      if (alreadyRegistered) {
        return;
      }

      ipcRenderer.send('tile:command:register', {
        token: tileToken,
        tileId,
        name,
      });

      // When called with the object form, also publish cmd:register so the
      // cmd panel picks up this command even though the manifest may only
      // have declared metadata (matches the v1 preload flow).
      if (typeof nameOrCommand === 'object') {
        ipcRenderer.send('tile:pubsub:publish', {
          token: tileToken,
          source: sourceAddress,
          scope: 3, // GLOBAL
          topic: 'cmd:register',
          data: {
            name,
            description,
            source: sourceAddress,
            scope: scope || 'global',
            modes: modes || [],
            accepts: accepts || [],
            produces: produces || [],
            params: params || [],
          },
        });
      }

      // Listen for command execution via pubsub relay (`pubsub:cmd:execute:{name}`).
      // Subscribe so main process forwards the topic to us.
      const execTopic = `cmd:execute:${name}`;
      ipcRenderer.send('tile:pubsub:subscribe', {
        token: tileToken,
        source: sourceAddress,
        topic: execTopic,
      });

      ipcRenderer.on(`pubsub:${execTopic}`, async (_event: unknown, msg: { expectResult?: boolean; resultTopic?: string; [k: string]: unknown }) => {
        // Look up the current handler by name — honours in-place swaps.
        const currentHandler = registeredCommands.get(name);
        if (!currentHandler) return;
        let result: unknown;
        let error: string | null = null;
        try {
          result = await currentHandler(msg);
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          console.error(`[tile-preload] command ${name} threw:`, err);
        }

        // Publish result if the invoker asked for one (chaining / proxy resolution).
        if (msg && msg.expectResult && msg.resultTopic) {
          ipcRenderer.send('tile:pubsub:publish', {
            token: tileToken,
            source: sourceAddress,
            scope: 3,
            topic: msg.resultTopic,
            data: error ? { error } : result,
          });
        }

        // Also notify tile:command:result (useful for tile-level bookkeeping)
        ipcRenderer.send('tile:command:result', {
          token: tileToken,
          name,
          result,
          error: error || undefined,
        });
      });
    },
  };

  // ── Window ────────────────────────────────────────────────────────
  //
  // Dual-path implementation mirroring api.shortcuts / api.context:
  //
  //   - STRICT: when the tile's manifest declared a `window` capability
  //     (`true` or `{ create?, query?, manage?, urls? }`), route through
  //     `tile:window:*`. The main-process handlers validate the token +
  //     capability shape + per-op gates + URL allowlist.
  //
  //   - V1-COMPAT: when no window capability was declared, fall back to
  //     the legacy `window-open` / `window-close` / `window-list` IPC
  //     channels. Those channels remain available for the Phase 3/4
  //     migration per the tile-preload trimming plan.
  //
  // The decision is made per-call because `grantedCapabilities` is
  // populated asynchronously by `initialize()`.

  function hasWindowCapability(): boolean {
    const wc = grantedCapabilities?.window;
    if (wc === true) return true;
    if (wc && typeof wc === 'object') return true;
    return false;
  }

  api.window = {
    /**
     * Open a new window. Routes through strict IPC when the tile has
     * declared a `window` capability; otherwise falls back to the
     * un-gated legacy `window-open` channel.
     */
    open: (url: string, options?: Record<string, unknown>) => {
      if (!tokenValid) return Promise.reject(new Error('Not initialized'));
      if (hasWindowCapability()) {
        return ipcRenderer.invoke('tile:window:open', {
          token: tileToken,
          url,
          options,
        });
      }
      return ipcRenderer.invoke('window-open', {
        source: sourceAddress,
        url,
        options: options || {},
      });
    },

    /**
     * Close a window. With no id, closes the caller's own tile window.
     * With an id, closes the target window (requires `window.manage`
     * under strict mode). Falls back to legacy `window-close` when no
     * window capability is declared.
     */
    close: (id?: number) => {
      if (hasWindowCapability()) {
        ipcRenderer.send('tile:window:close', {
          token: tileToken,
          id,
        });
        return;
      }
      if (id == null) {
        // No strict grant, no id — best-effort: try legacy close on the
        // caller's own window via window-close is unsafe without an id,
        // so drop the call silently (matches previous behavior).
        return;
      }
      ipcRenderer.invoke('window-close', { id });
    },

    /**
     * Get info about the current window. Routes through strict IPC when
     * the tile has declared the capability; otherwise falls back to a
     * best-effort minimal object (v1 tiles did not have this API).
     */
    getInfo: () => {
      if (hasWindowCapability()) {
        return ipcRenderer.invoke('tile:window:info', {
          token: tileToken,
        });
      }
      // No legacy equivalent — return an error consistent with the
      // strict path's shape.
      return Promise.resolve({ error: 'window capability not granted' });
    },

    /**
     * List open windows. Strict-only — requires `window.query`. In
     * v1-compat mode this falls back to `window-list` for parity.
     */
    list: () => {
      if (hasWindowCapability()) {
        return ipcRenderer.invoke('tile:window:list', {
          token: tileToken,
        });
      }
      return ipcRenderer.invoke('window-list', {});
    },
  };

  // ── Datastore (if granted) ──
  //
  // Strict surfaces (get/set/query) route through `tile:datastore:*` which
  // enforces per-table capability. Everything below the divider is a
  // v1-compat helper that delegates to legacy IPC handlers without
  // capability checks — these are wrapped with wrapCompat to log first-use
  // per tile (see Phase 1 of the trimming plan).

  const datastoreStrict = {
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

  const datastoreCompat = {
    // ─── v1-compat datastore helpers ──────────────────────────────────
    // These delegate directly to the core datastore IPC handlers. The v1
    // preload exposed these for every extension; many features call them.
    // Capability gating happens at the manifest level — if the tile was
    // granted the 'datastore' capability with the right tables, we trust
    // it to call these. The main-process handlers do full validation
    // and enforcement.

    addAddress: (uri: string, options?: unknown) =>
      ipcRenderer.invoke('datastore-add-address', { uri, options }),
    getAddress: (id: string) =>
      ipcRenderer.invoke('datastore-get-address', { id }),
    updateAddress: (id: string, updates: unknown) =>
      ipcRenderer.invoke('datastore-update-address', { id, updates }),
    queryAddresses: (filter?: unknown) =>
      ipcRenderer.invoke('datastore-query-addresses', { filter }),
    addVisit: (addressId: string, options?: unknown) =>
      ipcRenderer.invoke('datastore-add-visit', { addressId, options }),
    queryVisits: (filter?: unknown) =>
      ipcRenderer.invoke('datastore-query-visits', { filter }),
    addContent: (options: unknown) =>
      ipcRenderer.invoke('datastore-add-content', { options }),
    queryContent: (filter?: unknown) =>
      ipcRenderer.invoke('datastore-query-content', { filter }),
    getTable: (tableName: string) =>
      ipcRenderer.invoke('datastore-get-table', { tableName }),
    setRow: (tableName: string, rowId: string, rowData: unknown) =>
      ipcRenderer.invoke('datastore-set-row', { tableName, rowId, rowData }),
    getRow: (tableName: string, rowId: string) =>
      ipcRenderer.invoke('datastore-get-row', { tableName, rowId }),
    getStats: () =>
      ipcRenderer.invoke('datastore-get-stats'),

    // Tag operations
    getOrCreateTag: (name: string) =>
      ipcRenderer.invoke('datastore-get-or-create-tag', { name }),
    tagAddress: (addressId: string, tagId: string) =>
      ipcRenderer.invoke('datastore-tag-address', { addressId, tagId }),
    untagAddress: (addressId: string, tagId: string) =>
      ipcRenderer.invoke('datastore-untag-address', { addressId, tagId }),
    getTagsByFrecency: (domain?: string) =>
      ipcRenderer.invoke('datastore-get-tags-by-frecency', { domain }),
    renameTag: (tagId: string, newName: string) =>
      ipcRenderer.invoke('datastore-rename-tag', { tagId, newName }),
    updateTagColor: (tagId: string, color: string) =>
      ipcRenderer.invoke('datastore-update-tag-color', { tagId, color }),
    deleteTag: (tagId: string) =>
      ipcRenderer.invoke('datastore-delete-tag', { tagId }),
    getAddressTags: (addressId: string) =>
      ipcRenderer.invoke('datastore-get-address-tags', { addressId }),
    getAddressesByTag: (tagId: string) =>
      ipcRenderer.invoke('datastore-get-addresses-by-tag', { tagId }),
    getUntaggedAddresses: () =>
      ipcRenderer.invoke('datastore-get-untagged-addresses', {}),

    // Item operations
    addItem: (type: string, options: unknown = {}) =>
      ipcRenderer.invoke('datastore-add-item', { type, options }),
    getItem: (id: string) =>
      ipcRenderer.invoke('datastore-get-item', { id }),
    updateItem: (id: string, options: unknown) =>
      ipcRenderer.invoke('datastore-update-item', { id, options }),
    deleteItem: (id: string) =>
      ipcRenderer.invoke('datastore-delete-item', { id }),
    hardDeleteItem: (id: string) =>
      ipcRenderer.invoke('datastore-hard-delete-item', { id }),
    updateItemTitle: (id: string, title: string) =>
      ipcRenderer.invoke('datastore-update-item-title', { id, title }),
    updateItemFavicon: (id: string, favicon: string) =>
      ipcRenderer.invoke('datastore-update-item-favicon', { id, favicon }),
    queryItems: (filter: unknown = {}) =>
      ipcRenderer.invoke('datastore-query-items', { filter }),
    tagItem: (itemId: string, tagId: string) =>
      ipcRenderer.invoke('datastore-tag-item', { itemId, tagId }),
    untagItem: (itemId: string, tagId: string) =>
      ipcRenderer.invoke('datastore-untag-item', { itemId, tagId }),
    getItemTags: (itemId: string) =>
      ipcRenderer.invoke('datastore-get-item-tags', { itemId }),
    getItemsByTag: (tagId: string) =>
      ipcRenderer.invoke('datastore-get-items-by-tag', { tagId }),
    getHistory: (filter: unknown = {}) =>
      ipcRenderer.invoke('datastore-get-history', filter),
    recordItemVisit: (data: unknown) =>
      ipcRenderer.invoke('datastore-record-item-visit', data),
    getItemVisits: (data: unknown) =>
      ipcRenderer.invoke('datastore-get-item-visits', data),
    queryItemVisits: (data: unknown = {}) =>
      ipcRenderer.invoke('datastore-query-item-visits', data),
    trackNavigation: (data: unknown) =>
      ipcRenderer.invoke('datastore-track-navigation', data),
    queryItemsByFrecency: (data: unknown = {}) =>
      ipcRenderer.invoke('datastore-query-items-by-frecency', data),

    // Item events
    addItemEvent: (data: unknown) =>
      ipcRenderer.invoke('datastore-add-item-event', data),
    getItemEvent: (data: unknown) =>
      ipcRenderer.invoke('datastore-get-item-event', data),
    queryItemEvents: (data: unknown = {}) =>
      ipcRenderer.invoke('datastore-query-item-events', data),
    deleteItemEvent: (data: unknown) =>
      ipcRenderer.invoke('datastore-delete-item-event', data),
    deleteItemEvents: (data: unknown) =>
      ipcRenderer.invoke('datastore-delete-item-events', data),
    getLatestItemEvent: (data: unknown) =>
      ipcRenderer.invoke('datastore-get-latest-item-event', data),
    countItemEvents: (data: unknown) =>
      ipcRenderer.invoke('datastore-count-item-events', data),
  };

  // Wrap each compat method with first-use logging (observational only).
  api.datastore = {
    ...datastoreStrict,
    ...wrapCompatObject('datastore', datastoreCompat as unknown as Record<string, unknown>),
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

  // Settings: `get`/`set` are strict (routed through tile:settings:*).
  // `getKey`/`setKey` are v1-compat wrappers that massage the response
  // shape — wrapped to log first-use per tile.
  api.settings = {
    /**
     * Get a setting value (returns raw value, no wrapper)
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

    /**
     * v1 compatibility alias — get returns {success, data} shape
     * matching legacy preload's settings.getKey().
     */
    getKey: wrapCompat('settings', 'getKey', async (key: unknown) => {
      if (!tokenValid) return { success: false, error: 'Not initialized' };
      const result = await ipcRenderer.invoke('tile:settings:get', {
        token: tileToken,
        key,
      });
      if (result.error) return { success: false, error: result.error };
      return { success: true, data: result.value };
    }),

    /**
     * v1 compatibility alias — set returns {success, error?} shape
     * matching legacy preload's settings.setKey().
     */
    setKey: wrapCompat('settings', 'setKey', async (key: unknown, value: unknown) => {
      if (!tokenValid) return { success: false, error: 'Not initialized' };
      const result = await ipcRenderer.invoke('tile:settings:set', {
        token: tileToken,
        key,
        value,
      });
      if (result.error) return { success: false, error: result.error };
      return { success: true };
    }),
  };

  // ── Shortcuts ─────────────────────────────────────────────────────
  //
  // Dual-path implementation:
  //
  //   - STRICT: when the tile's manifest declared a `shortcuts` capability
  //     (`true` or `{ keys: [...] }`), route through `tile:shortcuts:*`.
  //     The main-process handlers validate the token + capability + keys
  //     allowlist. This is the path consuming features get automatically
  //     once their manifest declares `capabilities.shortcuts`.
  //
  //   - V1-COMPAT: when no shortcuts capability was declared (or the token
  //     hasn't been validated yet), fall back to the legacy
  //     `registershortcut` / `unregistershortcut` IPC channels. Those
  //     channels remain available for the Phase 3/4 migration per the
  //     tile-preload trimming plan.
  //
  // The decision is made per-call (not at API-build time) because
  // `grantedCapabilities` is populated asynchronously by `initialize()`.

  function rndm(): string {
    return Math.random().toString(36).slice(2);
  }

  function hasShortcutsCapability(): boolean {
    // Treat the capability as declared when it's `true` or an object.
    // `false` / `undefined` / `null` fall back to v1-compat.
    const sc = grantedCapabilities?.shortcuts;
    if (sc === true) return true;
    if (sc && typeof sc === 'object') return true;
    return false;
  }

  function registerShortcutStrict(
    shortcut: unknown,
    cb: unknown,
    options: unknown,
  ): void {
    const opts = (options || {}) as { global?: boolean; mode?: string };
    const callback = cb as () => void;
    const isGlobal = opts.global === true;
    const replyTopic = `${shortcut}${rndm()}`;
    ipcRenderer.send('tile:shortcuts:register', {
      token: tileToken,
      source: sourceAddress,
      shortcut,
      replyTopic,
      global: isGlobal,
      mode: opts.mode,
    });
    ipcRenderer.on(replyTopic, (_event: unknown, msg: { error?: string } | undefined) => {
      if (msg && typeof msg === 'object' && 'error' in msg && msg.error) {
        // Rejection — surface to devtools but don't throw (match v1 behaviour
        // where the IPC would simply never fire the callback).
        console.warn(`[tile-preload] strict shortcuts.register rejected for ${shortcut}:`, msg.error);
        return;
      }
      callback();
    });
  }

  function unregisterShortcutStrict(
    shortcut: unknown,
    options: unknown,
  ): void {
    const opts = (options || {}) as { global?: boolean; mode?: string };
    const isGlobal = opts.global === true;
    ipcRenderer.send('tile:shortcuts:unregister', {
      token: tileToken,
      source: sourceAddress,
      shortcut,
      global: isGlobal,
      mode: opts.mode,
    });
  }

  function registerShortcutCompat(
    shortcut: unknown,
    cb: unknown,
    options: unknown,
  ): void {
    const opts = (options || {}) as { global?: boolean; mode?: string };
    const callback = cb as () => void;
    const isGlobal = opts.global === true;
    const replyTopic = `${shortcut}${rndm()}`;
    ipcRenderer.send('registershortcut', {
      source: sourceAddress,
      shortcut,
      replyTopic,
      global: isGlobal,
      mode: opts.mode,
    });
    ipcRenderer.on(replyTopic, () => callback());
  }

  function unregisterShortcutCompat(
    shortcut: unknown,
    options: unknown,
  ): void {
    const opts = (options || {}) as { global?: boolean; mode?: string };
    const isGlobal = opts.global === true;
    ipcRenderer.send('unregistershortcut', {
      source: sourceAddress,
      shortcut,
      global: isGlobal,
      mode: opts.mode,
    });
  }

  api.shortcuts = {
    // NOTE: wrapCompat still wraps the top-level entry to log v1-shape calls
    // while the trimming plan is in Phase 1/2. The wrapper delegates to the
    // strict IPC when the tile has the capability, falling back to the legacy
    // channel otherwise. Callers do not need to change their code — their
    // manifest declaration controls which path runs.
    register: wrapCompat('shortcuts', 'register', (
      shortcut: unknown,
      cb: unknown,
      options: unknown,
    ) => {
      if (hasShortcutsCapability()) {
        registerShortcutStrict(shortcut, cb, options);
      } else {
        registerShortcutCompat(shortcut, cb, options);
      }
    }),
    unregister: wrapCompat('shortcuts', 'unregister', (
      shortcut: unknown,
      options: unknown,
    ) => {
      if (hasShortcutsCapability()) {
        unregisterShortcutStrict(shortcut, options);
      } else {
        unregisterShortcutCompat(shortcut, options);
      }
    }),
  };

  // ── Files (v1-compat) ─────────────────────────────────────────────
  const filesCompat = {
    save: (content: string, options: { filename?: string; mimeType?: string } = {}) =>
      ipcRenderer.invoke('file-save-dialog', {
        content,
        filename: options.filename,
        mimeType: options.mimeType,
      }),
    open: () => ipcRenderer.invoke('file-open-dialog'),
    readFromPath: (filePath: string) =>
      ipcRenderer.invoke('file-read-from-path', { filePath }),
    writeToPath: (filePath: string, content: string) =>
      ipcRenderer.invoke('file-write-to-path', { filePath, content }),
  };
  api.files = wrapCompatObject('files', filesCompat as unknown as Record<string, unknown>);

  // ── Modes (v1-compat) ─────────────────────────────────────────────
  const modesCompat = {
    getWindowMode: (windowId: number | null = null) =>
      ipcRenderer.invoke('modes:getWindowMode', { windowId }),
    setMajorMode: (mode: string, windowId: number | null = null) =>
      ipcRenderer.invoke('modes:setMajorMode', { mode, windowId }),
    listModes: () => ipcRenderer.invoke('modes:listModes'),
    getCommandContext: () => ipcRenderer.invoke('modes:getCommandContext'),
    onModeChange: (callback: (state: { major: string }, windowId?: number) => void) => {
      subscribeImpl('modes:changed', (msg: unknown) => {
        const m = msg as { major?: string; windowId?: number };
        callback({ major: m.major || 'default' }, m.windowId);
      }, 3);
    },
  };
  api.modes = wrapCompatObject('modes', modesCompat as unknown as Record<string, unknown>);

  // ── Context ───────────────────────────────────────────────────────
  //
  // Dual-path implementation mirroring api.shortcuts:
  //
  //   - STRICT: when the tile's manifest declared a `context` capability
  //     (`true` or `{ read?, write?, modes?, queryWindows? }`), route
  //     through `tile:context:*`. Main-process handlers validate the
  //     token + capability shape + per-op gates.
  //
  //   - V1-COMPAT: when no context capability was declared, fall back
  //     to the legacy `context-*` IPC channels. Those remain available
  //     through the Phase 3/4 migration window.
  //
  // The decision is made per-call because `grantedCapabilities` is
  // populated asynchronously by `initialize()`.

  function hasContextCapability(): boolean {
    const cc = grantedCapabilities?.context;
    if (cc === true) return true;
    if (cc && typeof cc === 'object') return true;
    return false;
  }

  const contextCompat = {
    get: (key: string, windowId: number | null = null) =>
      ipcRenderer.invoke('context-get', { key, windowId }),
    set: (key: string, value: unknown, metadata?: unknown, windowId?: number | null) =>
      ipcRenderer.invoke('context-set', { key, value, metadata, windowId }),
    history: (key: string, limit?: number) =>
      ipcRenderer.invoke('context-history', { key, limit }),
    snapshot: (windowId?: number | null) =>
      ipcRenderer.invoke('context-snapshot', { windowId }),
    windowsWithValue: (key: string, value: unknown) =>
      ipcRenderer.invoke('context-windows-with-value', { key, value }),
    windowsInSpace: (spaceId: string) =>
      ipcRenderer.invoke('context-windows-in-space', { spaceId }),
  };

  const contextStrict = {
    get: (key: string, windowId: number | null = null) =>
      ipcRenderer.invoke('tile:context:get', { token: tileToken, key, windowId }),
    set: (key: string, value: unknown, metadata?: Record<string, unknown>, windowId?: number | null) =>
      ipcRenderer.invoke('tile:context:set', { token: tileToken, key, value, metadata, windowId }),
    history: (key: string, limit?: number) =>
      ipcRenderer.invoke('tile:context:history', { token: tileToken, key, limit }),
    snapshot: (windowId?: number | null) =>
      ipcRenderer.invoke('tile:context:snapshot', { token: tileToken, windowId }),
    windowsWithValue: (key: string, value: unknown) =>
      ipcRenderer.invoke('tile:context:windows-with-value', { token: tileToken, key, value }),
    windowsInSpace: (spaceId: string) =>
      ipcRenderer.invoke('tile:context:windows-in-space', { token: tileToken, spaceId }),
  };

  api.context = {
    get: wrapCompat('context', 'get', (key: unknown, windowId: unknown) => {
      return hasContextCapability()
        ? contextStrict.get(key as string, (windowId ?? null) as number | null)
        : contextCompat.get(key as string, (windowId ?? null) as number | null);
    }),
    set: wrapCompat('context', 'set', (key: unknown, value: unknown, metadata: unknown, windowId: unknown) => {
      return hasContextCapability()
        ? contextStrict.set(key as string, value, metadata as Record<string, unknown> | undefined, (windowId ?? null) as number | null)
        : contextCompat.set(key as string, value, metadata, (windowId ?? null) as number | null);
    }),
    history: wrapCompat('context', 'history', (key: unknown, limit: unknown) => {
      return hasContextCapability()
        ? contextStrict.history(key as string, limit as number | undefined)
        : contextCompat.history(key as string, limit as number | undefined);
    }),
    snapshot: wrapCompat('context', 'snapshot', (windowId: unknown) => {
      return hasContextCapability()
        ? contextStrict.snapshot((windowId ?? null) as number | null)
        : contextCompat.snapshot((windowId ?? null) as number | null);
    }),
    windowsWithValue: wrapCompat('context', 'windowsWithValue', (key: unknown, value: unknown) => {
      return hasContextCapability()
        ? contextStrict.windowsWithValue(key as string, value)
        : contextCompat.windowsWithValue(key as string, value);
    }),
    windowsInSpace: wrapCompat('context', 'windowsInSpace', (spaceId: unknown) => {
      return hasContextCapability()
        ? contextStrict.windowsInSpace(spaceId as string)
        : contextCompat.windowsInSpace(spaceId as string);
    }),
  };

  // ── Dialogs ───────────────────────────────────────────────────────
  //
  // Strict-only API: `api.dialogs.save` / `api.dialogs.open` route
  // through `tile:dialogs:*` when the tile declared a `dialogs`
  // capability (`true` or `{ types: [...] }`). When the capability is
  // not declared the strict handler rejects with `dialogs capability
  // not granted`.
  //
  // v1-compat continues through `api.files.save` / `api.files.open`,
  // which directly hit the un-gated `file-save-dialog` / `file-open-
  // dialog` channels. The two surfaces coexist until Phase 4 removal.

  api.dialogs = {
    save: (content: unknown, options: unknown = {}) => {
      const opts = (options || {}) as { filename?: string; mimeType?: string };
      return ipcRenderer.invoke('tile:dialogs:save', {
        token: tileToken,
        content: content as string,
        filename: opts.filename,
        mimeType: opts.mimeType,
      });
    },
    open: () => ipcRenderer.invoke('tile:dialogs:open', { token: tileToken }),
  };

  // ── Features ──────────────────────────────────────────────────────
  //
  // Dual-path implementation mirroring api.shortcuts / api.context:
  //
  //   - STRICT: when the tile's manifest declared a `features` capability
  //     (`true` or `{ read?, install?, manage?, sources? }`), route through
  //     `tile:features:*`. Main-process handlers validate the token +
  //     capability shape + per-action gates + source allowlist.
  //
  //   - V1-COMPAT: when no features capability was declared, fall back
  //     to the legacy `feature-registry:*` / `feature-install:*` /
  //     `feature-browse:*` channels. Those remain available through the
  //     migration window and the settings UI continues to use them.
  //
  // The decision is made per-call because `grantedCapabilities` is
  // populated asynchronously by `initialize()`.

  function hasFeaturesCapability(): boolean {
    const fc = grantedCapabilities?.features;
    if (fc === true) return true;
    if (fc && typeof fc === 'object') return true;
    return false;
  }

  const featuresCompat = {
    list: (sourceType?: string) =>
      ipcRenderer.invoke('feature-registry:list', { token: tileToken, sourceType }),
    get: (id: string) =>
      ipcRenderer.invoke('feature-registry:get', { token: tileToken, id }),
    history: (featureId?: string, limit?: number) =>
      ipcRenderer.invoke('feature-registry:history', { token: tileToken, featureId, limit }),
    enable: (id: string, tilePreloadPath?: string) =>
      ipcRenderer.invoke('feature-registry:enable', { token: tileToken, id, tilePreloadPath }),
    disable: (id: string) =>
      ipcRenderer.invoke('feature-registry:disable', { token: tileToken, id }),
    remove: (id: string) =>
      ipcRenderer.invoke('feature-registry:remove', { token: tileToken, id }),
    installResolve: (atUri: string) =>
      ipcRenderer.invoke('feature-install:resolve', { token: tileToken, atUri }),
    previewCapabilities: (manifestCapabilities: unknown, featureId: string) =>
      ipcRenderer.invoke('feature-install:preview-capabilities', {
        token: tileToken,
        manifestCapabilities,
        featureId,
      }),
    install: (atUri: string, userApproved: boolean) =>
      ipcRenderer.invoke('feature-install:install', { token: tileToken, atUri, userApproved }),
    resolvePublisher: (query: string) =>
      ipcRenderer.invoke('feature-browse:resolve-publisher', { token: tileToken, query }),
  };

  const featuresStrict = {
    list: (sourceType?: string) =>
      ipcRenderer.invoke('tile:features:list', { token: tileToken, sourceType }),
    get: (id: string) =>
      ipcRenderer.invoke('tile:features:get', { token: tileToken, id }),
    history: (featureId?: string, limit?: number) =>
      ipcRenderer.invoke('tile:features:history', { token: tileToken, featureId, limit }),
    enable: (id: string, tilePreloadPath?: string) =>
      ipcRenderer.invoke('tile:features:enable', { token: tileToken, id, tilePreloadPath }),
    disable: (id: string) =>
      ipcRenderer.invoke('tile:features:disable', { token: tileToken, id }),
    remove: (id: string) =>
      ipcRenderer.invoke('tile:features:remove', { token: tileToken, id }),
    installResolve: (atUri: string) =>
      ipcRenderer.invoke('tile:features:install-resolve', { token: tileToken, atUri }),
    previewCapabilities: (manifestCapabilities: unknown, featureId: string) =>
      ipcRenderer.invoke('tile:features:preview-capabilities', {
        token: tileToken,
        manifestCapabilities,
        featureId,
      }),
    install: (atUri: string, userApproved: boolean) =>
      ipcRenderer.invoke('tile:features:install', { token: tileToken, atUri, userApproved }),
    resolvePublisher: (query: string) =>
      ipcRenderer.invoke('tile:features:browse-resolve-publisher', { token: tileToken, query }),
  };

  api.features = {
    list: wrapCompat('features', 'list', (sourceType: unknown) => {
      return hasFeaturesCapability()
        ? featuresStrict.list(sourceType as string | undefined)
        : featuresCompat.list(sourceType as string | undefined);
    }),
    get: wrapCompat('features', 'get', (id: unknown) => {
      return hasFeaturesCapability()
        ? featuresStrict.get(id as string)
        : featuresCompat.get(id as string);
    }),
    history: wrapCompat('features', 'history', (featureId: unknown, limit: unknown) => {
      return hasFeaturesCapability()
        ? featuresStrict.history(featureId as string | undefined, limit as number | undefined)
        : featuresCompat.history(featureId as string | undefined, limit as number | undefined);
    }),
    enable: wrapCompat('features', 'enable', (id: unknown, tilePreloadPath: unknown) => {
      return hasFeaturesCapability()
        ? featuresStrict.enable(id as string, tilePreloadPath as string | undefined)
        : featuresCompat.enable(id as string, tilePreloadPath as string | undefined);
    }),
    disable: wrapCompat('features', 'disable', (id: unknown) => {
      return hasFeaturesCapability()
        ? featuresStrict.disable(id as string)
        : featuresCompat.disable(id as string);
    }),
    remove: wrapCompat('features', 'remove', (id: unknown) => {
      return hasFeaturesCapability()
        ? featuresStrict.remove(id as string)
        : featuresCompat.remove(id as string);
    }),
    installResolve: wrapCompat('features', 'installResolve', (atUri: unknown) => {
      return hasFeaturesCapability()
        ? featuresStrict.installResolve(atUri as string)
        : featuresCompat.installResolve(atUri as string);
    }),
    previewCapabilities: wrapCompat('features', 'previewCapabilities', (mc: unknown, id: unknown) => {
      return hasFeaturesCapability()
        ? featuresStrict.previewCapabilities(mc, id as string)
        : featuresCompat.previewCapabilities(mc, id as string);
    }),
    install: wrapCompat('features', 'install', (atUri: unknown, userApproved: unknown) => {
      return hasFeaturesCapability()
        ? featuresStrict.install(atUri as string, userApproved as boolean)
        : featuresCompat.install(atUri as string, userApproved as boolean);
    }),
    resolvePublisher: wrapCompat('features', 'resolvePublisher', (query: unknown) => {
      return hasFeaturesCapability()
        ? featuresStrict.resolvePublisher(query as string)
        : featuresCompat.resolvePublisher(query as string);
    }),
  };

  // ── closeWindow (v1-compat) ───────────────────────────────────────
  //
  // When the tile has declared the `window` capability, the close goes
  // through the strict handler (which enforces sender-ownership / the
  // `manage` flag). When it hasn't, we fall back to the un-gated legacy
  // channel — matching the dual-path policy of api.window.close().
  api.closeWindow = wrapCompat('closeWindow', '(call)', (id?: unknown) => {
    if (hasWindowCapability()) {
      ipcRenderer.send('tile:window:close', {
        token: tileToken,
        id: id as number | undefined,
      });
      return;
    }
    if (id == null) {
      return;
    }
    ipcRenderer.invoke('window-close', { id });
  });

  // ── Log (always available) ──

  api.log = (...args: unknown[]) => {
    ipcRenderer.send('renderer-log', { source: sourceAddress, args });
  };

  return api;
}

// ─── Expose API ──────────────────────────────────────────────────────

const api = buildAPI();
contextBridge.exposeInMainWorld('app', api);

} // end else (tileId/tileEntry/tileToken present)
