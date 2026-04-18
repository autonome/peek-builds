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
let trustedBuiltin = false;
let grantedCapabilities: Record<string, unknown> = {};
let validationPromise: Promise<boolean> | undefined;

function validateToken(): Promise<boolean> {
  if (validationPromise !== undefined) return validationPromise;

  const promise = ipcRenderer.invoke('tile:validate-token', {
    tileId,
    tileEntry,
    token: tileToken,
  }).then((result: { valid: boolean; capabilities?: Record<string, unknown>; trustedBuiltin?: boolean }) => {
    tokenValid = result.valid;
    trustedBuiltin = result.trustedBuiltin === true;
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

// ─── Phase 4: v1-compat violation logger REMOVED ─────────────────────
// The wrapCompat / wrapCompatObject helpers and the compatSeen set were
// used during Phases 1-3 to log first-use of v1 shims. All shims have
// now been replaced with hard-fail stubs or strict-only paths, so the
// logger infrastructure is no longer needed.

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

    // Defer tile:ready to the next event-loop tick so any synchronous
    // post-initialize code in background.html (e.g. extension.init() +
    // api.commands.register()) has a chance to complete before the lazy
    // system's hasSubscriber check fires.
    const result = { capabilities: grantedCapabilities };
    setTimeout(() => {
      ipcRenderer.send('tile:ready', { tileId, tileEntry });
    }, 0);
    return result;
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
    SYSTEM: 1,
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

  // Phase 4 intent was to remove top-level api.publish / api.subscribe as
  // hard-fail stubs, but several shared libraries in app/ (app/index.js,
  // app/hud/widgets/*, app/lib/tag-action-affordances.js, app/settings/
  // settings.js) still call them directly. Restored as thin aliases to
  // api.pubsub.publish / api.pubsub.subscribe so those shared libs work
  // under tile-preload without touching every call site.
  api.publish = publishImpl;
  api.subscribe = subscribeImpl;

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

  function hasCommandsCapability(): boolean {
    const cc = grantedCapabilities?.commands;
    return cc === true;
  }

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

    /**
     * Unregister a previously-registered command. Removes the local
     * handler and publishes `cmd:unregister` so the cmd panel drops
     * it from its registry.
     *
     * Dual-path:
     *   - STRICT: when the tile declared the `commands` capability,
     *     route through the gated `tile:commands:unregister` channel.
     *   - V1-COMPAT: fall back to a direct `publish(cmd:unregister)`
     *     on GLOBAL scope — matches the v1 preload.js behaviour.
     */
    unregister: (name: unknown) => {
      if (typeof name !== 'string' || name.length === 0) {
        console.error('[tile-preload] commands.unregister: name is required');
        return;
      }
      // Drop local handler so repeated registers don't leak state.
      registeredCommands.delete(name);

      if (hasCommandsCapability() && tokenValid) {
        ipcRenderer.send('tile:commands:unregister', {
          token: tileToken,
          name,
        });
        return;
      }
      // V1-compat path: publish cmd:unregister on GLOBAL scope.
      if (tokenValid) {
        ipcRenderer.send('tile:pubsub:publish', {
          token: tileToken,
          source: sourceAddress,
          scope: 3, // GLOBAL
          topic: 'cmd:unregister',
          data: { name },
        });
      }
    },

    /**
     * List all registered commands. Mirrors the v1 preload.js behaviour
     * — publishes `cmd:query-commands` on GLOBAL scope, listens for the
     * `cmd:query-commands-response` reply. The cmd resident renderer
     * answers with the full registry.
     *
     * Resolves with `{ success: true, data: Array<{name, description,
     * source, scope?, modes?}> }` on success, or
     * `{ success: false, data: [], error }` on timeout.
     *
     * Used by tests (via bgWindow) and by admin UIs that need to
     * inspect the global registry from an outside tile.
     */
    list: () => {
      if (!tokenValid) {
        return Promise.resolve({ success: false, data: [], error: 'tile not initialized' });
      }

      return new Promise((resolve) => {
        const topic = 'cmd:query-commands-response';
        let settled = false;

        const handler = (_event: unknown, msg: unknown) => {
          if (settled) return;
          settled = true;
          ipcRenderer.removeListener(`pubsub:${topic}`, handler);
          ipcRenderer.send('tile:pubsub:unsubscribe', {
            token: tileToken,
            source: sourceAddress,
            topic,
          });
          const data = (msg as { commands?: unknown[] })?.commands || [];
          resolve({ success: true, data });
        };

        ipcRenderer.send('tile:pubsub:subscribe', {
          token: tileToken,
          source: sourceAddress,
          topic,
        });
        ipcRenderer.on(`pubsub:${topic}`, handler);

        ipcRenderer.send('tile:pubsub:publish', {
          token: tileToken,
          source: sourceAddress,
          scope: 3, // GLOBAL
          topic: 'cmd:query-commands',
          data: {},
        });

        setTimeout(() => {
          if (settled) return;
          settled = true;
          ipcRenderer.removeListener(`pubsub:${topic}`, handler);
          ipcRenderer.send('tile:pubsub:unsubscribe', {
            token: tileToken,
            source: sourceAddress,
            topic,
          });
          resolve({ success: false, data: [], error: 'Timeout querying commands' });
        }, 3000);
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

    /**
     * Check if a window with the given id is still open. Strict path
     * requires `window.manage`; otherwise falls back to the un-gated
     * legacy `window-exists` channel.
     */
    exists: (id: number) => {
      if (hasWindowCapability()) {
        return ipcRenderer.invoke('tile:window:exists', {
          token: tileToken,
          id,
        });
      }
      return ipcRenderer.invoke('window-exists', { id });
    },

    /**
     * Show a hidden window. Strict path requires `window.manage`;
     * otherwise falls back to the un-gated legacy `window-show`
     * channel.
     */
    show: (id: number) => {
      if (hasWindowCapability()) {
        return ipcRenderer.invoke('tile:window:show', {
          token: tileToken,
          id,
        });
      }
      return ipcRenderer.invoke('window-show', { id });
    },

    /**
     * Hide a visible window. Strict path requires `window.manage`;
     * otherwise falls back to the un-gated legacy `window-hide`
     * channel.
     */
    hide: (id: number) => {
      if (hasWindowCapability()) {
        return ipcRenderer.invoke('tile:window:hide', {
          token: tileToken,
          id,
        });
      }
      return ipcRenderer.invoke('window-hide', { id });
    },

    /**
     * Toggle click-through on a window. Strict path requires
     * `window.manage`; otherwise falls back to the un-gated legacy
     * `window-set-ignore-mouse-events` channel.
     */
    setIgnoreMouseEvents: (
      id: number | null | undefined,
      ignore: boolean,
      options?: { forward?: boolean },
    ) => {
      if (hasWindowCapability()) {
        return ipcRenderer.invoke('tile:window:set-ignore-mouse', {
          token: tileToken,
          id: typeof id === 'number' ? id : undefined,
          ignore,
          options,
        });
      }
      return ipcRenderer.invoke('window-set-ignore-mouse-events', {
        id: typeof id === 'number' ? id : undefined,
        ignore,
        forward: options?.forward === true,
      });
    },

    /**
     * Center a window on its display. Strict path requires
     * `window.manage`; otherwise falls back to legacy `window-center`.
     */
    center: (id?: number) => {
      if (hasWindowCapability()) {
        return ipcRenderer.invoke('tile:window:center', {
          token: tileToken,
          id,
        });
      }
      return ipcRenderer.invoke('window-center', { id });
    },

    /**
     * Center every visible window on its nearest display. Strict path
     * requires `window.manage`; otherwise falls back to legacy
     * `window-center-all`.
     */
    centerAll: () => {
      if (hasWindowCapability()) {
        return ipcRenderer.invoke('tile:window:center-all', {
          token: tileToken,
        });
      }
      return ipcRenderer.invoke('window-center-all');
    },

    /**
     * Toggle maximize on a window. Strict path requires `window.manage`;
     * otherwise falls back to legacy `window-maximize`.
     */
    maximize: (id?: number) => {
      if (hasWindowCapability()) {
        return ipcRenderer.invoke('tile:window:maximize', {
          token: tileToken,
          id,
        });
      }
      return ipcRenderer.invoke('window-maximize', { id });
    },

    /**
     * Toggle fullscreen on a window. Strict path requires `window.manage`;
     * otherwise falls back to legacy `window-fullscreen`.
     */
    fullscreen: (id?: number) => {
      if (hasWindowCapability()) {
        return ipcRenderer.invoke('tile:window:fullscreen', {
          token: tileToken,
          id,
        });
      }
      return ipcRenderer.invoke('window-fullscreen', { id });
    },

    /**
     * Get the last-focused visible window id. Read-only — strict path
     * requires `window.query`; otherwise falls back to legacy
     * `get-focused-visible-window-id`.
     */
    getFocusedVisibleWindowId: () => {
      if (hasWindowCapability()) {
        return ipcRenderer.invoke('tile:window:get-focused-visible-id', {
          token: tileToken,
        });
      }
      return ipcRenderer.invoke('get-focused-visible-window-id');
    },

    /**
     * Set the overlay focus target — captures which window should be
     * focused after an overlay closes. Strict path requires
     * `window.manage`; otherwise falls back to legacy
     * `window-set-overlay-focus-target`.
     */
    setOverlayFocusTarget: (targetWindowId: number) => {
      if (hasWindowCapability()) {
        return ipcRenderer.invoke('tile:window:set-overlay-focus-target', {
          token: tileToken,
          targetWindowId,
        });
      }
      return ipcRenderer.invoke('window-set-overlay-focus-target', {
        targetWindowId,
      });
    },

    /**
     * Pin a window across macOS Spaces. Strict path requires
     * `window.manage`; otherwise falls back to legacy
     * `window-set-visible-on-all-workspaces`.
     */
    setVisibleOnAllWorkspaces: (
      id: number | null | undefined,
      visible: boolean,
      options?: { visibleOnFullScreen?: boolean; skipTransformProcessType?: boolean },
    ) => {
      if (hasWindowCapability()) {
        return ipcRenderer.invoke('tile:window:set-visible-on-all-workspaces', {
          token: tileToken,
          id: typeof id === 'number' ? id : undefined,
          visible,
          options,
        });
      }
      return ipcRenderer.invoke('window-set-visible-on-all-workspaces', {
        id: typeof id === 'number' ? id : undefined,
        visible,
        options: options || {},
      });
    },

    /**
     * Show this tile's own window.
     *
     * No `window` capability required. The tile's token is the authority —
     * it can only affect the window it runs in. Use for tiles that start
     * hidden at boot (resident: true) and reveal themselves on command.
     */
    showSelf: () => {
      if (!tokenValid) return Promise.reject(new Error('Not initialized'));
      return ipcRenderer.invoke('tile:window:show-self', {
        token: tileToken,
      });
    },

    /**
     * Hide this tile's own window.
     *
     * Hides without destroying — the tile's state (DOM, JS heap, registered
     * commands) is preserved and the window can be shown again cheaply via
     * showSelf(). Use for "dismiss" UX where re-opening should be instant.
     *
     * No `window` capability required. The tile's token is the authority.
     */
    hideSelf: () => {
      if (!tokenValid) return Promise.reject(new Error('Not initialized'));
      return ipcRenderer.invoke('tile:window:hide-self', {
        token: tileToken,
      });
    },
  };

  // ── Datastore (if granted) ──
  //
  // Strict surfaces (get/set/query/extractPageContent) route through
  // `tile:datastore:*` which enforces per-table capability. The v1-compat
  // helper methods were removed in Phase 4 and replaced with hard-fail stubs.

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

    /**
     * Extract DOM content (html/text/title) from a live webContents by
     * URL. Gated on the `datastore` capability — the operation reads
     * from user-owned browsing state and fits the datastore domain.
     * Used by entities to harvest page content for downstream parsing.
     */
    extractPageContent: (url: string) => {
      if (!tokenValid) return Promise.reject(new Error('Not initialized'));
      return ipcRenderer.invoke('tile:datastore:extract-page-content', {
        token: tileToken,
        url,
      });
    },
  };

  // Named datastore methods that features rely on. Each routes to the
  // corresponding legacy `datastore-*` IPC channel in ipc.ts. Phase 4
  // originally turned these into hard-fail stubs, but feature code was
  // never migrated off them (Phase 3 explicitly said "keep API name"),
  // so the stubs broke every tile UI. Restored as thin routing wrappers.
  //
  // Follow-up (tracked in docs/tasks.md): build equivalent strict
  // `tile:datastore:*` handlers for the methods that don't have them
  // yet (renameTag/updateTagColor/deleteTag/queryItemVisits/getHistory/
  // updateItemTitle/updateItemFavicon/etc.), then migrate callers one
  // by one.
  api.datastore = {
    ...datastoreStrict,
    // Address helpers
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
    getStats: () => ipcRenderer.invoke('tile:datastore:get-stats', { token: tileToken }),
    // Tag helpers
    getOrCreateTag: (name: string) =>
      ipcRenderer.invoke('datastore-get-or-create-tag', { name }),
    tagAddress: (addressId: string, tagId: string) =>
      ipcRenderer.invoke('datastore-tag-address', { addressId, tagId }),
    untagAddress: (addressId: string, tagId: string) =>
      ipcRenderer.invoke('datastore-untag-address', { addressId, tagId }),
    getTagsByFrecency: (domain?: string) =>
      ipcRenderer.invoke('datastore-get-tags-by-frecency', { domain }),
    renameTag: (tagId: string, newName: string) =>
      ipcRenderer.invoke('tile:datastore:rename-tag', { token: tileToken, tagId, newName }),
    updateTagColor: (tagId: string, color: string) =>
      ipcRenderer.invoke('tile:datastore:update-tag-color', { token: tileToken, tagId, color }),
    deleteTag: (tagId: string) =>
      ipcRenderer.invoke('tile:datastore:delete-tag', { token: tileToken, tagId }),
    getAddressTags: (addressId: string) =>
      ipcRenderer.invoke('datastore-get-address-tags', { addressId }),
    getAddressesByTag: (tagId: string) =>
      ipcRenderer.invoke('datastore-get-addresses-by-tag', { tagId }),
    getUntaggedAddresses: () =>
      ipcRenderer.invoke('datastore-get-untagged-addresses', {}),
    // Item helpers
    addItem: (type: string, options: unknown = {}) =>
      ipcRenderer.invoke('datastore-add-item', { type, options }),
    getItem: (id: string) =>
      ipcRenderer.invoke('datastore-get-item', { id }),
    updateItem: (id: string, options: unknown) =>
      ipcRenderer.invoke('datastore-update-item', { id, options }),
    deleteItem: (id: string) =>
      ipcRenderer.invoke('datastore-delete-item', { id }),
    hardDeleteItem: (id: string) =>
      ipcRenderer.invoke('tile:datastore:hard-delete-item', { token: tileToken, id }),
    updateItemTitle: (url: string, title: string) =>
      ipcRenderer.invoke('tile:datastore:update-item-title', { token: tileToken, url, title }),
    updateItemFavicon: (url: string, faviconUrl: string) =>
      ipcRenderer.invoke('tile:datastore:update-item-favicon', { token: tileToken, url, faviconUrl }),
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
      ipcRenderer.invoke('tile:datastore:get-history', { token: tileToken, filter }),
    recordItemVisit: (itemId: string, options?: unknown) =>
      ipcRenderer.invoke('tile:datastore:record-item-visit', { token: tileToken, itemId, options }),
    getItemVisits: (itemId: string, filter?: unknown) =>
      ipcRenderer.invoke('tile:datastore:get-item-visits', { token: tileToken, itemId, filter }),
    queryItemVisits: (filter: unknown = {}) =>
      ipcRenderer.invoke('tile:datastore:query-item-visits', { token: tileToken, filter }),
    trackNavigation: (uri: string, options?: unknown) =>
      ipcRenderer.invoke('tile:datastore:track-navigation', { token: tileToken, uri, options }),
    queryItemsByFrecency: (filter: unknown = {}) =>
      ipcRenderer.invoke('tile:datastore:query-items-by-frecency', { token: tileToken, filter }),
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
     * Get a setting value. Returns a normalised response object that
     * satisfies BOTH the legacy `{success, data}` shape used by most
     * feature callers AND the strict `{value, error}` shape emitted by
     * `tile:settings:get`. Fields present on the returned object:
     *   success  — true when no error occurred
     *   data     — the stored value (alias for `value`)
     *   value    — the stored value (strict-IPC field, kept for callers
     *              that already destructure the strict shape)
     *   error    — error string when the call failed, undefined otherwise
     */
    get: async (key: string) => {
      if (!tokenValid) return Promise.reject(new Error('Not initialized'));
      const r = await ipcRenderer.invoke('tile:settings:get', {
        token: tileToken,
        key,
      }) as { value?: unknown; error?: string } | null;
      if (!r || r.error) {
        return { success: false, data: undefined, value: undefined, error: r?.error ?? 'unknown error' };
      }
      return { success: true, data: r.value, value: r.value, error: undefined };
    },

    /**
     * Set a setting value. Returns a normalised `{success, error}` object
     * so callers that inspect the result get a consistent shape.
     */
    set: async (key: string, value: unknown) => {
      if (!tokenValid) return Promise.reject(new Error('Not initialized'));
      const r = await ipcRenderer.invoke('tile:settings:set', {
        token: tileToken,
        key,
        value,
      }) as { error?: string } | null;
      if (!r || r.error) {
        return { success: false, error: r?.error ?? 'unknown error' };
      }
      return { success: true, error: undefined };
    },

    /**
     * Phase 4: getKey REMOVED. Use api.settings.get(key) instead.
     */
    getKey: (..._args: unknown[]) => {
      throw new Error('[tile-preload] api.settings.getKey removed in Phase 4; use api.settings.get');
    },

    /**
     * Phase 4: setKey REMOVED. Use api.settings.set(key, value) instead.
     */
    setKey: (..._args: unknown[]) => {
      throw new Error('[tile-preload] api.settings.setKey removed in Phase 4; use api.settings.set');
    },

    /**
     * Cross-tile foreign-read: fetch another tile's stored setting
     * value (read-only). Dual-path routing:
     *
     *   - STRICT: when the tile's manifest declared
     *     `settings.readForeign` or `settingsForeign`, route through
     *     `tile:settings:get-foreign`. The main-process handler checks
     *     the allowlist and scopes the DB query to the named foreign
     *     tile.
     *
     *   - V1-COMPAT: otherwise fall back to the legacy un-gated
     *     `feature-settings-get-key` channel. Preserves behaviour for
     *     manifests that haven't declared the new allowlist yet.
     *
     * The decision is made per-call because `grantedCapabilities` is
     * populated asynchronously by `initialize()`.
     */
    /**
     * Phase 4: getExtKey v1-compat fallback REMOVED. Strict path only.
     * Tile manifest must declare settings.readForeign to use this.
     *
     * Returns a normalised `{success, data, value, error}` object so that
     * callers using either the legacy `{success, data}` shape or the strict
     * `{value, error}` shape both work correctly.
     */
    getExtKey: async (extId: unknown, key: unknown) => {
      if (!extId || !key) {
        return { success: false, data: undefined, value: undefined, error: 'extId and key are required' };
      }
      if (!hasSettingsForeignCapability()) {
        throw new Error('[tile-preload] api.settings.getExtKey requires settings.readForeign capability in manifest (Phase 4: v1-compat fallback removed)');
      }
      const r = await ipcRenderer.invoke('tile:settings:get-foreign', {
        token: tileToken,
        foreignExtId: extId,
        key,
      }) as { value?: unknown; error?: string } | null;
      if (!r || r.error) {
        return { success: false, data: undefined, value: undefined, error: r?.error ?? 'unknown error' };
      }
      return { success: true, data: r.value, value: r.value, error: undefined };
    },
  };

  /**
   * True when the tile has declared a foreign-settings read allowlist via
   * either `settings: { readForeign: [...] }` or top-level
   * `settingsForeign`. The actual per-ext allowlist check happens in the
   * main-process strict handler.
   */
  function hasSettingsForeignCapability(): boolean {
    const caps = grantedCapabilities as Record<string, unknown> | null;
    if (!caps) return false;
    const s = caps.settings;
    if (s && typeof s === 'object') {
      const rf = (s as { readForeign?: unknown }).readForeign;
      if (Array.isArray(rf) && rf.length > 0) return true;
    }
    if (Array.isArray(caps.settingsForeign) && (caps.settingsForeign as unknown[]).length > 0) {
      return true;
    }
    return false;
  }

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

  // Phase 4: registerShortcutCompat / unregisterShortcutCompat REMOVED.

// Phase 4: v1-compat shortcuts fallback REMOVED. Strict path only.
  // Tiles must declare `shortcuts` in their manifest capabilities.
  api.shortcuts = {
    register: (shortcut: unknown, cb: unknown, options: unknown) => {
      if (!hasShortcutsCapability()) {
        throw new Error('[tile-preload] api.shortcuts.register requires shortcuts capability in manifest (Phase 4: v1-compat fallback removed)');
      }
      registerShortcutStrict(shortcut, cb, options);
    },
    unregister: (shortcut: unknown, options: unknown) => {
      if (!hasShortcutsCapability()) {
        throw new Error('[tile-preload] api.shortcuts.unregister requires shortcuts capability in manifest (Phase 4: v1-compat fallback removed)');
      }
      unregisterShortcutStrict(shortcut, options);
    },
  };

  // ── Files (Phase 4: v1-compat REMOVED) ───────────────────────────
  // Use api.dialogs.save / api.dialogs.open for file dialogs,
  // and api.filesystem.read / api.filesystem.write for path operations.
  api.files = {
    save: (..._args: unknown[]) => { throw new Error('[tile-preload] api.files.save removed in Phase 4; use api.dialogs.save'); },
    open: (..._args: unknown[]) => { throw new Error('[tile-preload] api.files.open removed in Phase 4; use api.dialogs.open'); },
    readFromPath: (..._args: unknown[]) => { throw new Error('[tile-preload] api.files.readFromPath removed in Phase 4; use api.filesystem.read'); },
    writeToPath: (..._args: unknown[]) => { throw new Error('[tile-preload] api.files.writeToPath removed in Phase 4; use api.filesystem.write'); },
  };

  // ── Modes (Phase 4: REMOVED — was unused per trimming plan §1 row 6) ──
  // api.modes was confirmed zero-usage. Hard-fail stubs catch any survivor.
  api.modes = {
    getWindowMode: (..._args: unknown[]) => { throw new Error('[tile-preload] api.modes removed in Phase 4 (was unused); use api.context.*'); },
    setMajorMode: (..._args: unknown[]) => { throw new Error('[tile-preload] api.modes removed in Phase 4 (was unused)'); },
    listModes: (..._args: unknown[]) => { throw new Error('[tile-preload] api.modes removed in Phase 4 (was unused)'); },
    getCommandContext: (..._args: unknown[]) => { throw new Error('[tile-preload] api.modes removed in Phase 4 (was unused)'); },
    onModeChange: (..._args: unknown[]) => { throw new Error('[tile-preload] api.modes removed in Phase 4 (was unused)'); },
  };

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
    get: (key: unknown, windowId: unknown) => {
      return hasContextCapability()
        ? contextStrict.get(key as string, (windowId ?? null) as number | null)
        : contextCompat.get(key as string, (windowId ?? null) as number | null);
    },
    set: (key: unknown, value: unknown, metadata: unknown, windowId: unknown) => {
      return hasContextCapability()
        ? contextStrict.set(key as string, value, metadata as Record<string, unknown> | undefined, (windowId ?? null) as number | null)
        : contextCompat.set(key as string, value, metadata, (windowId ?? null) as number | null);
    },
    history: (key: unknown, limit: unknown) => {
      return hasContextCapability()
        ? contextStrict.history(key as string, limit as number | undefined)
        : contextCompat.history(key as string, limit as number | undefined);
    },
    snapshot: (windowId: unknown) => {
      return hasContextCapability()
        ? contextStrict.snapshot((windowId ?? null) as number | null)
        : contextCompat.snapshot((windowId ?? null) as number | null);
    },
    windowsWithValue: (key: unknown, value: unknown) => {
      return hasContextCapability()
        ? contextStrict.windowsWithValue(key as string, value)
        : contextCompat.windowsWithValue(key as string, value);
    },
    windowsInSpace: (spaceId: unknown) => {
      return hasContextCapability()
        ? contextStrict.windowsInSpace(spaceId as string)
        : contextCompat.windowsInSpace(spaceId as string);
    },

    // ── Convenience aliases ──────────────────────────────────────────
    // These wrap the generic get/set/subscribe surface for the common
    // 'mode' key, mirroring v1 preload.js api.context.setMode / getMode
    // / watchMode / getWindowsInSpace.

    setMode: (mode: unknown, options?: { metadata?: Record<string, unknown>; windowId?: number | null }) => {
      const metadata = options?.metadata;
      const windowId = (options?.windowId ?? null) as number | null;
      return hasContextCapability()
        ? contextStrict.set('mode', mode, metadata, windowId)
        : contextCompat.set('mode', mode, metadata, windowId);
    },

    getMode: () => hasContextCapability()
      ? contextStrict.get('mode', null)
      : contextCompat.get('mode', null),

    /**
     * Watch for mode changes.
     * Subscribes to `context:changed` and fires callback with the new mode
     * value whenever the 'mode' key changes. Also performs an initial get so
     * the caller receives the current value immediately.
     * Returns an unsubscribe function.
     */
    watchMode: (callback: (mode: unknown, entry?: unknown) => void) => {
      const unsubscribe = subscribeImpl('context:changed', (msg: unknown) => {
        const m = msg as { key?: string; value?: unknown };
        if (m.key === 'mode') {
          callback(m.value ?? null, m);
        }
      });
      // Fire initial value so caller doesn't have to do a separate getMode().
      const getPromise = hasContextCapability()
        ? contextStrict.get('mode', null)
        : contextCompat.get('mode', null);
      (getPromise as Promise<unknown>).then((result: unknown) => {
        const r = result as { success?: boolean; data?: unknown; value?: unknown } | null;
        const value = r && typeof r === 'object' ? (('data' in r) ? (r as { data: unknown }).data : (r as { value: unknown }).value) : null;
        callback(value ?? null, null);
      }).catch(() => {
        callback(null, null);
      });
      return unsubscribe;
    },

    getWindowsInSpace: (spaceId: unknown) => hasContextCapability()
      ? contextStrict.windowsInSpace(spaceId as string)
      : contextCompat.windowsInSpace(spaceId as string),
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
    list: (sourceType: unknown) => {
      return hasFeaturesCapability()
        ? featuresStrict.list(sourceType as string | undefined)
        : featuresCompat.list(sourceType as string | undefined);
    },
    get: (id: unknown) => {
      return hasFeaturesCapability()
        ? featuresStrict.get(id as string)
        : featuresCompat.get(id as string);
    },
    history: (featureId: unknown, limit: unknown) => {
      return hasFeaturesCapability()
        ? featuresStrict.history(featureId as string | undefined, limit as number | undefined)
        : featuresCompat.history(featureId as string | undefined, limit as number | undefined);
    },
    enable: (id: unknown, tilePreloadPath: unknown) => {
      return hasFeaturesCapability()
        ? featuresStrict.enable(id as string, tilePreloadPath as string | undefined)
        : featuresCompat.enable(id as string, tilePreloadPath as string | undefined);
    },
    disable: (id: unknown) => {
      return hasFeaturesCapability()
        ? featuresStrict.disable(id as string)
        : featuresCompat.disable(id as string);
    },
    remove: (id: unknown) => {
      return hasFeaturesCapability()
        ? featuresStrict.remove(id as string)
        : featuresCompat.remove(id as string);
    },
    installResolve: (atUri: unknown) => {
      return hasFeaturesCapability()
        ? featuresStrict.installResolve(atUri as string)
        : featuresCompat.installResolve(atUri as string);
    },
    previewCapabilities: (mc: unknown, id: unknown) => {
      return hasFeaturesCapability()
        ? featuresStrict.previewCapabilities(mc, id as string)
        : featuresCompat.previewCapabilities(mc, id as string);
    },
    install: (atUri: unknown, userApproved: unknown) => {
      return hasFeaturesCapability()
        ? featuresStrict.install(atUri as string, userApproved as boolean)
        : featuresCompat.install(atUri as string, userApproved as boolean);
    },
    resolvePublisher: (query: unknown) => {
      return hasFeaturesCapability()
        ? featuresStrict.resolvePublisher(query as string)
        : featuresCompat.resolvePublisher(query as string);
    },

    // ── Admin surfaces (strict-only) ─────────────────────────────────
    //
    // Gated on the new sub-capability action flags added in the Apr-2026
    // features gap-fill:
    //   - update* → features.update
    //   - dev*    → features.dev
    //   - publish* → features.publish
    //   - devtoolsOpen → features.devtools
    //   - browseListByPublisher → features.browse (defaults to read)
    //
    // These are only routed through the strict channel — no v1-compat
    // shim because the legacy channels in tile-ipc.ts (`feature-update:*`
    // etc.) only check token presence, not capability. Tiles that
    // haven't declared the action will get a gate rejection from the
    // strict handler — the correct behaviour.

    updateCheckAll: () =>
      ipcRenderer.invoke('tile:features:update-check-all', { token: tileToken }),
    updateApply: (id: string, userApproved?: boolean) =>
      ipcRenderer.invoke('tile:features:update-apply', { token: tileToken, id, userApproved }),
    updateSetPolicy: (id: string, policy: 'auto' | 'notify' | 'pinned') =>
      ipcRenderer.invoke('tile:features:update-set-policy', { token: tileToken, id, policy }),

    devReload: (featureId: string) =>
      ipcRenderer.invoke('tile:features:dev-reload', { token: tileToken, featureId }),
    devValidate: (featureId: string) =>
      ipcRenderer.invoke('tile:features:dev-validate', { token: tileToken, featureId }),
    devPickDirectory: () =>
      ipcRenderer.invoke('tile:features:dev-pick-directory', { token: tileToken }),
    devCreate: (params: {
      directoryPath: string; featureId: string; featureName: string;
    }) =>
      ipcRenderer.invoke('tile:features:dev-create', {
        token: tileToken,
        directoryPath: params?.directoryPath,
        featureId: params?.featureId,
        featureName: params?.featureName,
      }),

    publishListLocal: () =>
      ipcRenderer.invoke('tile:features:publish-list-local', { token: tileToken }),
    publishReadFeatureFiles: (featureId: string) =>
      ipcRenderer.invoke('tile:features:publish-read-feature-files', { token: tileToken, featureId }),

    devtoolsOpen: (featureId: string, entryId?: string) =>
      ipcRenderer.invoke('tile:features:devtools-open', { token: tileToken, featureId, entryId }),

    browseListByPublisher: (params: {
      did: string; pdsUrl: string; cursor?: string;
    }) =>
      ipcRenderer.invoke('tile:features:browse-list-by-publisher', {
        token: tileToken,
        did: params?.did,
        pdsUrl: params?.pdsUrl,
        cursor: params?.cursor,
      }),
  };

  // ── IZUI ──────────────────────────────────────────────────────────
  //
  // Gated on the boolean `izui` capability. Routes through strict
  // `tile:izui:*` handlers which in turn call the same coordinator used
  // by the v1 `izui-*` channels. Each method returns the primitive
  // result (not an envelope) — matching the shape the existing callers
  // (`izui-manage.js`, `windows.js`, `hud/widgets/izui.js`) already use.

  function hasIzuiCapability(): boolean {
    return grantedCapabilities?.izui === true;
  }

  api.izui = {
    isTransient: async () => {
      if (!hasIzuiCapability()) {
        // Fall back to the legacy channel so existing callers keep
        // working until manifests are updated to declare `izui: true`.
        return ipcRenderer.invoke('izui-is-transient');
      }
      const result = await ipcRenderer.invoke('tile:izui:is-transient', { token: tileToken });
      if (result && typeof result === 'object' && 'transient' in result) {
        return (result as { transient: boolean }).transient;
      }
      return result;
    },
    getEffectiveMode: async () => {
      if (!hasIzuiCapability()) return ipcRenderer.invoke('izui-get-effective-mode');
      const result = await ipcRenderer.invoke('tile:izui:get-effective-mode', { token: tileToken });
      if (result && typeof result === 'object' && 'mode' in result) {
        return (result as { mode: string }).mode;
      }
      return result;
    },
    getState: async () => {
      if (!hasIzuiCapability()) return ipcRenderer.invoke('izui-get-state');
      const result = await ipcRenderer.invoke('tile:izui:get-state', { token: tileToken });
      if (result && typeof result === 'object' && 'state' in result) {
        return (result as { state: unknown }).state;
      }
      return result;
    },
    getPreOverlayFocusTarget: async () => {
      if (!hasIzuiCapability()) return ipcRenderer.invoke('izui-get-pre-overlay-focus-target');
      const result = await ipcRenderer.invoke('tile:izui:get-pre-overlay-focus-target', { token: tileToken });
      if (result && typeof result === 'object' && 'target' in result) {
        return (result as { target: unknown }).target;
      }
      return result;
    },
    closeSelf: () => {
      if (!hasIzuiCapability()) return ipcRenderer.invoke('izui-close-self');
      return ipcRenderer.invoke('tile:izui:close-self', { token: tileToken });
    },
  };

  // ── OAuth ─────────────────────────────────────────────────────────
  //
  // Dual-path implementation mirroring api.shortcuts / api.context:
  //
  //   - STRICT: when the tile's manifest declared an `oauth` capability
  //     (`true` or `{ providers: [...] }`), route through
  //     `tile:oauth:*`. Main-process handlers validate the token +
  //     capability shape + optional per-provider allowlist.
  //
  //   - V1-COMPAT: when no oauth capability was declared, fall back to
  //     the legacy `oauth-start-loopback` / `oauth-await-callback`
  //     channels. Those remain available through the Phase 3/4
  //     migration window and continue to back wonderwall / lex until
  //     they opt in.
  //
  // The decision is made per-call because `grantedCapabilities` is
  // populated asynchronously by `initialize()`.

  function hasOAuthCapability(): boolean {
    const oc = grantedCapabilities?.oauth;
    if (oc === true) return true;
    if (oc && typeof oc === 'object') return true;
    return false;
  }

  const oauthCompat = {
    startLoopback: (options?: { callbackPath?: string; timeoutMs?: number }) =>
      ipcRenderer.invoke('oauth-start-loopback', options),
    awaitCallback: (port: number) =>
      ipcRenderer.invoke('oauth-await-callback', { port }),
  };

  const oauthStrict = {
    startLoopback: (options?: { callbackPath?: string; timeoutMs?: number; provider?: string }) =>
      ipcRenderer.invoke('tile:oauth:start-loopback', {
        token: tileToken,
        callbackPath: options?.callbackPath,
        timeoutMs: options?.timeoutMs,
        provider: options?.provider,
      }),
    awaitCallback: (port: number) =>
      ipcRenderer.invoke('tile:oauth:await-callback', {
        token: tileToken,
        port,
      }),
  };

  api.oauth = {
    startLoopback: (options: unknown) => {
      const opts = (options || {}) as { callbackPath?: string; timeoutMs?: number; provider?: string };
      return hasOAuthCapability()
        ? oauthStrict.startLoopback(opts)
        : oauthCompat.startLoopback(opts);
    },
    awaitCallback: (port: unknown) => {
      return hasOAuthCapability()
        ? oauthStrict.awaitCallback(port as number)
        : oauthCompat.awaitCallback(port as number);
    },
  };

  // ── Sync ──────────────────────────────────────────────────────────
  //
  // Dual-path implementation mirroring api.shortcuts:
  //
  //   - STRICT: when the tile's manifest declared `sync: true`, route
  //     through `tile:sync:sync-all`. Main-process handler validates
  //     the token + capability (and `sync` is builtin-only at manifest
  //     resolution).
  //
  //   - V1-COMPAT: when no sync capability was declared, fall back to
  //     the legacy `sync-full` channel.

  function hasSyncCapability(): boolean {
    return grantedCapabilities?.sync === true;
  }

  api.sync = {
    syncAll: () => {
      return hasSyncCapability()
        ? ipcRenderer.invoke('tile:sync:sync-all', { token: tileToken })
        : ipcRenderer.invoke('sync-full');
    },
  };

  // ── closeWindow (Phase 4: REMOVED — was unused per trimming plan §1 row 8) ──
  // Use api.window.close() instead.
  api.closeWindow = (..._args: unknown[]) => {
    throw new Error('[tile-preload] api.closeWindow removed in Phase 4 (was unused); use api.window.close()');
  };

  // ── Screen (always available; read-only) ──────────────────────────
  //
  // Read-only display metadata. Tiles use this for initial window
  // placement sizing — no gate is appropriate since the data is
  // already exposed via the browser's `window.screen` globals. The
  // strict IPC form returns the same shape as the legacy channel so
  // callers that read `result.success && result.data` work unchanged.
  api.screen = {
    getPrimaryDisplay: () => {
      if (tokenValid) {
        return ipcRenderer.invoke('tile:screen:get-primary-display', {
          token: tileToken,
        });
      }
      // Fallback if called before initialize() — use legacy channel.
      return ipcRenderer.invoke('screen-get-primary-display');
    },
  };

  // ── Session (if granted) ──────────────────────────────────────────
  //
  // Session operations require the `session` capability. Minimal
  // surface for now — only `saveSpaceWorkspaces`. Used by
  // features/spaces and features/groups to persist per-space window
  // layouts.
  function hasSessionCapability(): boolean {
    return grantedCapabilities?.session === true;
  }

  api.session = {
    saveSpaceWorkspaces: () => {
      if (hasSessionCapability() && tokenValid) {
        return ipcRenderer.invoke('tile:session:save-space-workspaces', {
          token: tileToken,
        });
      }
      // V1-compat fallback: legacy ungated channel.
      return ipcRenderer.invoke('save-space-workspaces');
    },
  };

  // ── Escape (always available; no capability gate) ─────────────────
  //
  // Escape is a UX primitive. Every tile can register an onEscape
  // callback — it's called when the main process dispatches an ESC
  // event to this window. The callback returns `{ handled: true }`
  // to tell the backend "I handled the ESC, don't close the window",
  // or `{ handled: false }` (or undefined) to let the backend decide.
  //
  // Implementation: the existing `escape-pressed` IPC is shared with
  // the v1 preload (windows.ts dispatches the same channel per-window
  // regardless of preload variant). We listen to it here and invoke
  // the tile's callback, replying on the provided responseChannel.
  let tileEscapeCallback: (() => unknown) | null = null;
  let tileEscapeInstalled = false;
  api.escape = {
    onEscape: (callback: () => unknown) => {
      if (typeof callback !== 'function') {
        tileEscapeCallback = null;
        return;
      }
      tileEscapeCallback = callback;
      // Signal opt-in to main (informational; drives first-use logging).
      if (tokenValid) {
        ipcRenderer.send('tile:escape:on-escape', { token: tileToken });
      }
      if (tileEscapeInstalled) return;
      tileEscapeInstalled = true;
      ipcRenderer.on('escape-pressed', async (
        _event: unknown,
        data: { responseChannel?: string },
      ) => {
        try {
          let result: unknown = { handled: false };
          if (tileEscapeCallback) {
            result = await tileEscapeCallback();
            if (result == null || typeof result !== 'object') {
              result = { handled: false };
            }
          }
          if (data?.responseChannel) {
            ipcRenderer.send(data.responseChannel, result);
          }
        } catch (err) {
          console.error('[tile-preload] escape handler threw:', err);
          if (data?.responseChannel) {
            ipcRenderer.send(data.responseChannel, { handled: false });
          }
        }
      });
    },
    // trigger() — test helper: directly invoke the registered escape callback
    // without going through the main-process IPC path. Returns the handler
    // result ({ handled: boolean }) or { handled: false } if no callback is
    // registered. Used by Playwright tests that need to assert on internal
    // navigation state without the timing uncertainty of keyboard.press('Escape').
    trigger: async (): Promise<{ handled: boolean }> => {
      if (!tileEscapeCallback) return { handled: false };
      try {
        const result = await tileEscapeCallback();
        if (result == null || typeof result !== 'object') {
          return { handled: false };
        }
        return result as { handled: boolean };
      } catch (err) {
        console.error('[tile-preload] escape trigger threw:', err);
        return { handled: false };
      }
    },
  };

  // ── Log (always available) ──

  api.log = (...args: unknown[]) => {
    ipcRenderer.send('renderer-log', { source: sourceAddress, args });
  };

  // ── Privileged escape hatch (trustedBuiltin only) ────────────────────
  //
  // `api.invoke(channel, data)` forwards to `ipcRenderer.invoke(...)` but
  // ONLY when the token's grant carries `trustedBuiltin: true` (core
  // renderers: cmd, hud, page, _test). Feature tiles never see this
  // method — their api.invoke is a no-op that returns an error object.
  //
  // The v1 preload.js exposed `api.invoke` gated on `isCore` (i.e.
  // `sourceAddress.startsWith('peek://app/')`). The test fixture and
  // core diagnostics rely on it to talk to main-process handlers that
  // don't (yet) have a tile-surfaced wrapper (backup-*, get-display-
  // info, extension-*). Under v2 tile mechanics, trustedBuiltin is the
  // renderer-level equivalent of v1's isCore.
  //
  // Two behaviours are possible:
  //   - trustedBuiltin grant present → forward raw
  //   - no trustedBuiltin            → return failure
  // The boolean is populated by the `tile:validate-token` IPC response,
  // so `api.invoke` must be called after `api.initialize()` resolves
  // (same rule as every other capability API).
  api.invoke = (channel: unknown, data?: unknown) => {
    if (!tokenValid) {
      return Promise.resolve({
        success: false,
        error: 'tile not initialized',
      });
    }
    if (!trustedBuiltin) {
      return Promise.resolve({
        success: false,
        error: 'api.invoke is only available to trustedBuiltin renderers',
      });
    }
    if (typeof channel !== 'string' || channel.length === 0) {
      return Promise.resolve({
        success: false,
        error: 'api.invoke: channel must be a non-empty string',
      });
    }
    return ipcRenderer.invoke(channel, data);
  };

  // ── Extensions management (test-fixture bgWindow compat) ─────────────
  //
  // The v1 preload.js exposed an `api.extensions` surface used by:
  //   - The test fixture (Playwright tests call `api.extensions.list()`,
  //     `api.extensions.reload()`, `api.extensions.add()`, etc.)
  //   - Core admin UIs (features-manager, etc.)
  //
  // Each method is a thin wrapper over a named IPC channel in ipc.ts
  // (`extension-window-list`, `extension-reload`, ...). They don't have
  // strict `tile:*` equivalents yet; exposing them here keeps the shape
  // consistent with v1 and unblocks Phase 2 of v1-removal without a
  // large test rewrite.
  //
  // Gated on trustedBuiltin — feature tiles must not be able to manage
  // other extensions through the tile surface.
  api.extensions = {
    list: () => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.extensions requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('extension-window-list');
    },
    listAllRegistered: () => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.extensions requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('extension-list-all-registered');
    },
    reload: (id: string) => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.extensions requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('extension-reload', { id });
    },
    devtools: (id: string) => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.extensions requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('extension-window-devtools', { id });
    },
    pickFolder: () => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.extensions requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('extension-pick-folder');
    },
    validateFolder: (folderPath: string) => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.extensions requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('extension-validate-folder', { folderPath });
    },
    add: (folderPath: string, manifest: unknown, enabled: boolean = false) => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.extensions requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('extension-add', { folderPath, manifest, enabled });
    },
    remove: (id: string) => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.extensions requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('extension-remove', { id });
    },
    update: (id: string, updates: unknown) => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.extensions requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('extension-update', { id, updates });
    },
    getAll: () => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.extensions requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('extension-get-all');
    },
    get: (id: string) => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.extensions requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('extension-get', { id });
    },
    getSettingsSchema: (extId: string) => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.extensions requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('feature-settings-schema', { extId });
    },
  };

  // ── App control (trustedBuiltin only) ────────────────────────────────
  //
  // v1 preload exposed `api.quit` / `api.restart` (fire-and-forget IPC
  // sends). The core background renderer (app/index.js) registers
  // `quit` / `restart` cmd palette commands that invoke these. The
  // channels are `ipcMain.on` (not .handle), so `api.invoke` cannot
  // replace them — a dedicated `.send` wrapper is required.
  api.quit = () => {
    if (!trustedBuiltin) {
      console.warn('[tile-preload] api.quit requires trustedBuiltin — ignored');
      return;
    }
    ipcRenderer.send('app-quit', { source: sourceAddress });
  };

  api.restart = () => {
    if (!trustedBuiltin) {
      console.warn('[tile-preload] api.restart requires trustedBuiltin — ignored');
      return;
    }
    ipcRenderer.send('app-restart', { source: sourceAddress });
  };

  // ── Theme (trustedBuiltin extensions) ────────────────────────────────
  //
  // The strict tile:theme surface only exposes `getInfo` and `onChange`.
  // Core renderers (app/index.js in particular) need the full v1 theme
  // surface for the cmd palette theme commands (`theme light`, `theme`,
  // `theme light here`, etc.). The channels are plain `ipcMain.handle`
  // entries in `ipc.ts`, so we can expose them here under trustedBuiltin
  // as thin wrappers. Non-trustedBuiltin tiles continue to use the
  // strict tile:theme:* surface declared above.
  if (trustedBuiltin) {
    (api.theme as Record<string, unknown>).get = () => ipcRenderer.invoke('theme:get');
    (api.theme as Record<string, unknown>).list = () => ipcRenderer.invoke('theme:list');
    (api.theme as Record<string, unknown>).getAll = () => ipcRenderer.invoke('theme:getAll');
    (api.theme as Record<string, unknown>).setTheme = (themeId: string) =>
      ipcRenderer.invoke('theme:setTheme', themeId);
    (api.theme as Record<string, unknown>).setColorScheme = (colorScheme: string) =>
      ipcRenderer.invoke('theme:setColorScheme', colorScheme);
    (api.theme as Record<string, unknown>).setWindowColorScheme = async (colorScheme: string) => {
      // Core/test renderers target the "last focused visible window" via
      // `get-focused-visible-window-id`, not their own hidden
      // BrowserWindow. Preserves v1 behaviour where the background
      // iframe ran the theme command on behalf of the user-facing window.
      let windowId = await ipcRenderer.invoke('get-focused-visible-window-id');
      if (!windowId) {
        windowId = await ipcRenderer.invoke('get-window-id');
      }
      if (!windowId) {
        return { success: false, error: 'No visible window to target' };
      }
      return ipcRenderer.invoke('theme:setWindowColorScheme', { windowId, colorScheme });
    };
  }

  // ── Chrome Extensions (trustedBuiltin only) ──────────────────────────
  //
  // v1 preload exposed `api.chromeExtensions.*` for the core background
  // renderer to enumerate bundled chrome extensions + their UI entry
  // points (popup, options, new-tab, etc.) and register cmd palette
  // commands for each openable entry. Gated on trustedBuiltin — feature
  // tiles must not enumerate or launch chrome extensions.
  api.chromeExtensions = {
    list: () => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.chromeExtensions requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('chrome-ext:list');
    },
    enable: (id: string) => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.chromeExtensions requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('chrome-ext:enable', { id });
    },
    disable: (id: string) => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.chromeExtensions requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('chrome-ext:disable', { id });
    },
    getStatus: () => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.chromeExtensions requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('chrome-ext:getStatus');
    },
    getUiEntries: () => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.chromeExtensions requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('chrome-ext:getUiEntries');
    },
    openPage: (id: string, type: string) => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.chromeExtensions requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('chrome-ext:openPage', { id, type });
    },
  };

  return api;
}

// ─── Expose API ──────────────────────────────────────────────────────

const api = buildAPI();
contextBridge.exposeInMainWorld('app', api);

} // end else (tileId/tileEntry/tileToken present)
