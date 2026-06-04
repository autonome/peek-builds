/**
 * Tile Preload Script — Capability-scoped API injection
 *
 * This runs in the renderer process of each tile with contextIsolation: true.
 * It reads the tile ID and capability token from process args, validates the
 * token with the main process, and builds an API object with ONLY the
 * granted capabilities. Injected via contextBridge.exposeInMainWorld('app', api).
 *
 * NOTE: This file is written as a CommonJS module because Electron preload
 * scripts must use require(), not import.
 */

const { contextBridge, ipcRenderer, webFrame } = require('electron');

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
  console.error('[tile-preload] Missing tile arguments. This preload is only for tiles.');
  // Expose minimal error API
  contextBridge.exposeInMainWorld('app', {
    error: 'Tile preload misconfigured: missing tile-id, tile-entry, or tile-token',
    getTileId: () => null,
  });
  // Early exit — don't expose any capabilities (wrapped in IIFE since top-level return is invalid)
} else {

const sourceAddress = `peek://${tileId}/${tileEntry}`;

// ─── Preload boot timing ─────────────────────────────────────────────
//
// Times preload execution itself (renderer V8 has already started by the
// time the first line of this file runs, so t=0 here is "first preload
// statement"; the wall-clock gap from main-process loadURL to t=0 is the
// OS-process spawn + Electron renderer framework init + V8 bootstrap).
// Pair with [page-boot:perf] in page.js for the full chain. Emitted via
// peek:perf-log so they land in main.log synchronously (survives rapid
// quit, unlike renderer.log's async queue).
const __preloadT0 = performance.now();
function __preloadMark(phase: string): void {
  try {
    const t = Math.round(performance.now() - __preloadT0);
    ipcRenderer.send('peek:perf-log', `[preload:perf] phase=${phase} t=${t} source=${sourceAddress}`);
  } catch {
    // Never let logging break the preload.
  }
}
__preloadMark('preload-start');

// ─── Always-on Console Wrapper ───────────────────────────────────────
//
// Forwards every console.{log,info,warn,error,debug} call from renderers
// to the main process via ipcRenderer.send('peek:renderer-log'), which
// writes to <userData>/logs/renderer.log (renderer-log.ts).
//
// Why two layers:
//
//  1. Isolated-world patch (this block, ipcRenderer.send directly):
//     The preload runs in Electron's isolated context. Patching console
//     here catches output from other preload code (e.g. the API builder
//     below, the perf markers) where we have direct access to ipcRenderer.
//
//  2. Main-world patch (webFrame.executeJavaScript below):
//     With contextIsolation:true, the preload's isolated-world `console`
//     is a DIFFERENT JavaScript object from the main-world `console` that
//     page JS and Playwright's bgWindow.evaluate() use. Setting
//     console.log in the isolated world does NOT affect the main world.
//     To capture tile page output we MUST inject a patch into the main
//     world via webFrame.executeJavaScript. The injected patch calls
//     window.__peekLogShim__.send (exposed via contextBridge below) which
//     calls ipcRenderer.send on behalf of the main-world script.
//
// Source label: `tileId:tileEntry` — e.g. `page-host:canvas-abc`.
{
  const _sourceLabel = `${tileId}:${tileEntry}`;
  const _origConsole = {
    log:   console.log.bind(console),
    info:  console.info.bind(console),
    warn:  console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };

  function _wrapConsole(level: string, orig: (...a: unknown[]) => void): (...a: unknown[]) => void {
    return (...args: unknown[]) => {
      orig(...args);
      try {
        ipcRenderer.send('peek:renderer-log', { level, args, source: _sourceLabel });
      } catch {
        // Never let logging interfere with the app.
      }
    };
  }

  // Isolated-world patch (catches preload-level console output).
  console.log   = _wrapConsole('log',   _origConsole.log);
  console.info  = _wrapConsole('info',  _origConsole.info);
  console.warn  = _wrapConsole('warn',  _origConsole.warn);
  console.error = _wrapConsole('error', _origConsole.error);
  console.debug = _wrapConsole('debug', _origConsole.debug);

  // ── Main-world IPC bridge ─────────────────────────────────────────
  // Expose a minimal shim into the main world so the main-world console
  // patch (injected below via webFrame.executeJavaScript) can call IPC
  // without needing direct ipcRenderer access.
  //
  // Key: '__peekLogShim__' — deliberately obscure to avoid collision with
  // tile API surface ('app'). Not advertised in any public API type.
  try {
    contextBridge.exposeInMainWorld('__peekLogShim__', {
      send: (level: string, args: unknown[]) => {
        try {
          ipcRenderer.send('peek:renderer-log', { level, args, source: _sourceLabel });
        } catch {
          // Swallow.
        }
      },
    });
  } catch {
    // exposeInMainWorld can throw if called after contextBridge is sealed
    // (e.g. in a test environment that re-runs the preload). Swallow.
  }

  // ── Main-world console patch ──────────────────────────────────────
  // Inject into the main world so tile page JS and any scripts running
  // in the page's main world (including Playwright's evaluate()) are
  // covered. The injected code is a plain IIFE string — no closure
  // captures needed since it reads window.__peekLogShim__ at call time.
  //
  // We fire-and-forget the promise (no await) so the preload continues
  // synchronously. The patch lands before the page's own scripts run
  // because webFrame.executeJavaScript in the preload executes before
  // DOMContentLoaded.
  try {
    (webFrame as { executeJavaScript: (src: string) => Promise<unknown> }).executeJavaScript(`
      (function() {
        try {
          if (typeof window.__peekLogShim__ !== 'object' || !window.__peekLogShim__) return;
          var _shim = window.__peekLogShim__;
          var _levels = ['log', 'info', 'warn', 'error', 'debug'];
          for (var i = 0; i < _levels.length; i++) {
            (function(lvl) {
              var _orig = console[lvl].bind(console);
              console[lvl] = function() {
                _orig.apply(console, arguments);
                try {
                  var args = Array.prototype.slice.call(arguments);
                  _shim.send(lvl, args);
                } catch(e) { /* never break the renderer */ }
              };
            })(_levels[i]);
          }
        } catch(e) { /* never break the renderer */ }
      })();
    `).catch(() => { /* swallow */ });
  } catch {
    // Swallow — webFrame.executeJavaScript may not be available in all
    // renderer contexts (e.g. chrome extension popups, which skip this path).
  }
}

// ─── Token Validation (Synchronous bootstrap) ────────────────────────

// We validate the token asynchronously but build the API synchronously
// with placeholder functions that queue until validation completes.
// The tile must call initialize() which awaits validation.

let tokenValid = false;
let trustedBuiltin = false;
let grantedCapabilities: Record<string, unknown> = {};

// Kick off token validation eagerly at module load time.
// Tiles no longer need to call api.initialize() before using cap-gated
// methods — each method awaits this promise internally. api.initialize()
// is kept as a thin backward-compatible wrapper.
const validationPromise: Promise<boolean> = ipcRenderer.invoke('tile:validate-token', {
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

function validateToken(): Promise<boolean> {
  return validationPromise;
}

// V1 shims are gone; every legacy api.* surface is either a strict-only
// path through capability-gated `tile:*` IPC or a hard-fail stub that
// throws with a migration hint. No first-use violation logger is needed.

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

  // Static platform info for renderer-side feature gating. `process.env`
  // is available in the (non-sandboxed) preload context — exposed once at
  // build time so settings UIs can detect Wayland (where global hotkeys
  // are unavailable) without an IPC round-trip.
  api.platform = {
    os: process.platform,
    isWayland: process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland',
  };

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

    // Defer tile:lifecycle:ready to the next event-loop tick so any
    // synchronous post-initialize code in background.html (e.g.
    // extension.init() + api.commands.register()) has a chance to
    // complete before the lazy system's hasSubscriber check fires.
    //
    // Channel is private lifecycle IPC — not pubsub. See
    // docs/pubsub-state-machine.md §Topics that are NOT pubsub.
    const result = { capabilities: grantedCapabilities };
    setTimeout(() => {
      ipcRenderer.send('tile:lifecycle:ready', { tileId, tileEntry });
    }, 0);
    return result;
  };

  /**
   * Register a shutdown handler.
   *
   * The underlying IPC listener is installed exactly once. Subsequent calls
   * replace the stored callback — repeated `api.onShutdown(cb)` invocations
   * do NOT accumulate listeners on the `tile:lifecycle:shutdown` channel.
   * This matters for hot-reload scenarios and features that re-register on
   * every init.
   */
  let shutdownCallback: (() => void) | null = null;
  let shutdownListenerInstalled = false;
  api.onShutdown = (callback: () => void) => {
    shutdownCallback = typeof callback === 'function' ? callback : null;
    if (!shutdownListenerInstalled) {
      shutdownListenerInstalled = true;
      ipcRenderer.on('tile:lifecycle:shutdown', () => {
        try {
          shutdownCallback?.();
        } catch (err) {
          console.error('[tile-preload] onShutdown callback threw:', err);
        }
      });
    }
  };

  /**
   * Register a callback that fires when an existing (hidden) tile window
   * is re-shown via the keepLive-reuse path in api.window.open. Same
   * install-once semantics as api.onShutdown.
   *
   * Purpose: give renderers a deterministic hook for "I'm being shown
   * again" state-reset. Previously this relied on the DOM
   * `visibilitychange` event, which races with user input — by the time
   * the DOM event handler ran, input had already landed on a stale
   * (CLOSING) state and was silently absorbed. The private IPC fires
   * before api.window.open resolves to the caller, so by the time the
   * next user interaction arrives, the renderer has already reset.
   */
  let visibleCallback: (() => void) | null = null;
  let visibleListenerInstalled = false;
  api.onVisible = (callback: () => void) => {
    visibleCallback = typeof callback === 'function' ? callback : null;
    if (!visibleListenerInstalled) {
      visibleListenerInstalled = true;
      ipcRenderer.on('tile:lifecycle:visible', () => {
        try {
          visibleCallback?.();
        } catch (err) {
          console.error('[tile-preload] onVisible callback threw:', err);
        }
      });
    }
  };

  /**
   * Register a callback that fires when a deferred session-restore window is
   * first focused and main signals it to load its real URL. Same install-once
   * semantics as api.onVisible.
   *
   * Purpose: deterministic "navigate now" hook for the page-host renderer.
   * Windows restored beyond the eager set boot with their <webview>
   * un-navigated (showing a static placeholder, zero content compositing). On
   * first focus the main process sends `page:navigate-deferred`; the renderer
   * loads the real URL and becomes an ordinary live window. Private lifecycle
   * IPC (not pubsub) so it can't be observed/forged by tile content.
   */
  let navigateDeferredCallback: (() => void) | null = null;
  let navigateDeferredListenerInstalled = false;
  api.onNavigateDeferred = (callback: () => void) => {
    navigateDeferredCallback = typeof callback === 'function' ? callback : null;
    if (!navigateDeferredListenerInstalled) {
      navigateDeferredListenerInstalled = true;
      ipcRenderer.on('page:navigate-deferred', () => {
        try {
          navigateDeferredCallback?.();
        } catch (err) {
          console.error('[tile-preload] onNavigateDeferred callback threw:', err);
        }
      });
    }
  };

  // ── Profiles (admin surface) ──
  //
  // Strict tile:profiles:* counterparts of the legacy `profiles:*`
  // handlers live in tile-ipc.ts. trustedBuiltin only
  // — touches profiles.db, can relaunch the app, holds sync creds.
  // Settings UI is the only real consumer.
  api.profiles = {
    list: () => ipcRenderer.invoke('tile:profiles:list', { token: tileToken }),
    create: (name: string) => ipcRenderer.invoke('tile:profiles:create', { token: tileToken, name }),
    get: (slug: string) => ipcRenderer.invoke('tile:profiles:get', { token: tileToken, slug }),
    delete: (id: string) => ipcRenderer.invoke('tile:profiles:delete', { token: tileToken, id }),
    getCurrent: () => ipcRenderer.invoke('tile:profiles:getCurrent', { token: tileToken }),
    switch: (slug: string) => ipcRenderer.invoke('tile:profiles:switch', { token: tileToken, slug }),
    enableSync: (profileId: string, apiKey: string, serverProfileSlug: string) =>
      ipcRenderer.invoke('tile:profiles:enableSync', { token: tileToken, profileId, apiKey, serverProfileSlug }),
    disableSync: (profileId: string) =>
      ipcRenderer.invoke('tile:profiles:disableSync', { token: tileToken, profileId }),
    getSyncConfig: (profileId: string) =>
      ipcRenderer.invoke('tile:profiles:getSyncConfig', { token: tileToken, profileId }),
    getPartition: () => ipcRenderer.invoke('tile:profiles:getPartition', { token: tileToken }),
  };

  // ── PubSub (if granted) ──
  //
  // Publish supports two call shapes:
  //   api.publish(topic, data)        // flat
  //   api.pubsub.publish(topic, data) // namespaced (kept for clarity)
  //
  // The legacy SYSTEM / SELF / GLOBAL scope param is gone (see
  // docs/pubsub-state-machine.md). Privilege is enforced by the
  // capability grant's topic allowlist in main.

  async function publishImpl(topic: string, data: unknown) {
    const valid = await validationPromise;
    if (!valid) {
      console.warn('[tile-preload] publish called but token validation failed');
      return;
    }
    ipcRenderer.send('tile:pubsub:publish', {
      token: tileToken,
      source: sourceAddress,
      topic,
      data,
    });
  }

  function subscribeImpl(topic: string, callback: (data: unknown) => void) {
    // Attach the IPC listener AND send the upstream subscribe synchronously
    // in the same tick. Deferring the upstream send behind validationPromise
    // created a race: publishers (e.g. tag:item-added from command execution)
    // that fire between "listener attached locally" and "main process has
    // registered this tile as a subscriber" are dropped. Main-side already
    // validates the token in the tile:pubsub:subscribe handler (tile-ipc.ts)
    // — an invalid token is silently ignored — so the client-side gate was
    // redundant. See commit history for the tag-widget flake that motivated
    // this change.
    let unsubscribed = false;
    const handler = (_event: unknown, msg: unknown) => {
      callback(msg);
    };
    ipcRenderer.on(`pubsub:${topic}`, handler);
    ipcRenderer.send('tile:pubsub:subscribe', {
      token: tileToken,
      source: sourceAddress,
      topic,
    });

    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      ipcRenderer.removeListener(`pubsub:${topic}`, handler);
      ipcRenderer.send('tile:pubsub:unsubscribe', {
        token: tileToken,
        source: sourceAddress,
        topic,
      });
    };
  }

  // Top-level api.publish / api.subscribe are kept as thin aliases for
  // api.pubsub.publish / api.pubsub.subscribe — several shared libraries
  // in app/ (app/index.js, app/hud/widgets/*, app/lib/
  // tag-action-affordances.js, app/settings/settings.js) call them
  // directly and the alias avoids touching every call site.
  api.publish = publishImpl;
  api.subscribe = subscribeImpl;

  api.pubsub = {
    publish: publishImpl,
    subscribe: subscribeImpl,
    // Pubsub telemetry for the HUD stats widget + developer diagnostics.
    // Strict path: tile:pubsub:stats (trustedBuiltin only — see tile-ipc.ts).
    stats: () => ipcRenderer.invoke('tile:pubsub:stats', { token: tileToken }),
  };

  // ── Commands (if granted) ──
  //
  // Supports two registration shapes:
  //
  //   api.commands.register(name, handler)
  //     Minimal signature — attaches a handler for cmd:execute:{name}.
  //
  //   api.commands.register({name, description, execute, scope, modes, params, ...})
  //     Descriptor signature. Re-publishes cmd:register so the cmd panel
  //     picks it up and wires the execute handler identically.
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
    register: async (nameOrCommand: unknown, maybeHandler?: (params: unknown) => unknown) => {
      const valid = await validationPromise;
      if (!valid) {
        console.warn('[tile-preload] commands.register called but token validation failed');
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

      // Publish cmd:register so the resident (and live panel) picks up this
      // command. Emit for BOTH string-form (name+handler, no metadata) and
      // object-form (name+metadata) registrations — string-form entries still
      // need to appear in the registry so features-manager-style callers are
      // visible to the cmd panel, even if they carry no accepts/produces.
      const registerPayload = {
        name,
        description,
        source: sourceAddress,
        scope: scope || 'global',
        modes: modes || [],
        accepts: accepts || [],
        produces: produces || [],
        params: params || [],
      };
      ipcRenderer.send('tile:pubsub:publish', {
        token: tileToken,
        source: sourceAddress,
        topic: 'cmd:register',
        data: registerPayload,
      });

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
            topic: msg.resultTopic,
            data: error ? { error } : result,
          });
        }
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
     *   - FALLBACK: publish `cmd:unregister` on GLOBAL scope so tiles
     *     without the capability can still unhook from the registry.
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
      // Fallback path: publish cmd:unregister on GLOBAL scope.
      if (tokenValid) {
        ipcRenderer.send('tile:pubsub:publish', {
          token: tileToken,
          source: sourceAddress,
          topic: 'cmd:unregister',
          data: { name },
        });
      }
    },

    /**
     * List all registered commands. Publishes `cmd:query-commands` on
     * GLOBAL scope, listens for the `cmd:query-commands-response` reply.
     * The cmd resident renderer answers with the full registry.
     *
     * Resolves with `{ success: true, data: Array<{name, description,
     * source, scope?, modes?}> }` on success, or
     * `{ success: false, data: [], error }` on timeout.
     *
     * Used by tests (via bgWindow) and by admin UIs that need to
     * inspect the global registry from an outside tile.
     */
    list: async () => {
      const _valid = await validationPromise;
      if (!_valid) {
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

    /**
     * Flush any pending command registrations immediately.
     *
     * Commands are published synchronously via ipcRenderer.send() in
     * register() — there is no batch queue. This method exists for API
     * compatibility with legacy callers that called flush() after a burst
     * of register() calls; it is a no-op.
     */
    flush: (): Promise<{ success: true }> => {
      // No-op: register() already sends each cmd:register publish
      // synchronously, so nothing to drain.
      return Promise.resolve({ success: true });
    },
  };

  // ── Window ────────────────────────────────────────────────────────
  //
  // Strict-only: every call routes through `tile:window:*` and is
  // gated on the tile's `window` capability shape (or trustedBuiltin).
  // Tiles that call api.window.* must declare a `window` capability
  // in their manifest. `showSelf`/`hideSelf` and `resize` (caller's
  // own window only) remain ungated since the token itself is the
  // authority.

  api.window = {
    /**
     * Open a new window. Requires `window.create` (or trustedBuiltin).
     * Strict handler in tile-ipc.ts validates URL prefix allowlist.
     */
    open: async (url: string, options?: Record<string, unknown>) => {
      const _valid = await validationPromise; if (!_valid) return Promise.reject(new Error('Not initialized'));
      return ipcRenderer.invoke('tile:window:open', {
        token: tileToken,
        url,
        options,
      });
    },

    /**
     * Resize the caller's own tile window. Useful for tiles that want to
     * expand/collapse based on content (cmd panel, HUD widgets, etc.).
     * Routes through the strict `tile:window:resize` channel; requires a
     * `window` capability grant (or trustedBuiltin).
     */
    resize: async (width: number, height: number) => {
      const _valid = await validationPromise; if (!_valid) return Promise.reject(new Error('Not initialized'));
      return ipcRenderer.invoke('tile:window:resize', {
        token: tileToken,
        width,
        height,
      });
    },

    /**
     * Close a window. With no id, closes the caller's own tile window.
     * With an id, closes the target window (requires `window.manage`).
     * Honors keepLive — routes through `closeOrHideWindow` in main.
     */
    close: (id?: number) => {
      ipcRenderer.send('tile:window:close', {
        token: tileToken,
        id,
      });
    },

    /**
     * Get info about the current window. Requires the `window`
     * capability (or trustedBuiltin).
     */
    getInfo: () => {
      return ipcRenderer.invoke('tile:window:info', {
        token: tileToken,
      });
    },

    /**
     * List open windows. Requires `window.query` (or trustedBuiltin).
     */
    list: (opts?: { includeInternal?: boolean }) => {
      return ipcRenderer.invoke('tile:window:list', {
        token: tileToken,
        includeInternal: opts?.includeInternal,
      });
    },

    /**
     * Check if a window with the given id is still open. Requires
     * `window.manage` (or trustedBuiltin).
     */
    exists: (id: number) => {
      return ipcRenderer.invoke('tile:window:exists', {
        token: tileToken,
        id,
      });
    },

    /**
     * Show a hidden window. Requires `window.manage` (or trustedBuiltin).
     */
    show: (id: number) => {
      return ipcRenderer.invoke('tile:window:show', {
        token: tileToken,
        id,
      });
    },

    /**
     * Hide a visible window. Requires `window.manage` (or trustedBuiltin).
     */
    hide: (id: number) => {
      return ipcRenderer.invoke('tile:window:hide', {
        token: tileToken,
        id,
      });
    },

    /**
     * Raise a window to the front. Requires `window.manage` (or
     * trustedBuiltin).
     */
    focus: (id: number) => {
      return ipcRenderer.invoke('tile:window:focus', {
        token: tileToken,
        id,
      });
    },

    /**
     * Toggle click-through on a window. Requires `window.manage` (or
     * trustedBuiltin).
     */
    setIgnoreMouseEvents: (
      id: number | null | undefined,
      ignore: boolean,
      options?: { forward?: boolean },
    ) => {
      return ipcRenderer.invoke('tile:window:set-ignore-mouse', {
        token: tileToken,
        id: typeof id === 'number' ? id : undefined,
        ignore,
        options,
      });
    },

    /**
     * Center a window on its display. Requires `window.manage` (or
     * trustedBuiltin).
     */
    center: (id?: number) => {
      return ipcRenderer.invoke('tile:window:center', {
        token: tileToken,
        id,
      });
    },

    /**
     * Center every visible window on its nearest display. Requires
     * `window.manage` (or trustedBuiltin).
     */
    centerAll: () => {
      return ipcRenderer.invoke('tile:window:center-all', {
        token: tileToken,
      });
    },

    /**
     * Maximize a window (non-toggling — no-op if already maximized).
     * Pair with `unmaximize` to restore. Requires `window.manage` (or
     * trustedBuiltin).
     */
    maximize: (id?: number) => {
      return ipcRenderer.invoke('tile:window:maximize', {
        token: tileToken,
        id,
      });
    },

    /**
     * Restore a maximized window to its pre-maximize bounds. No-op if
     * the window is not maximized. Requires `window.manage` (or
     * trustedBuiltin).
     */
    unmaximize: (id?: number) => {
      return ipcRenderer.invoke('tile:window:unmaximize', {
        token: tileToken,
        id,
      });
    },

    /**
     * Subscribe to maximize requests targeted at this window. The
     * `tile:window:maximize` IPC fires this on the target window's
     * webContents after the OS-side bounds change. Renderers that
     * manage their own internal layout (e.g. the page-host) hook in
     * here to keep their state in sync. Returns an unsubscribe fn.
     *
     * Targeted send (no broadcast) — only the resolved window receives
     * the event.
     */
    onMaximizeRequest: (cb: (payload?: { prevWindowBounds?: { x: number; y: number; width: number; height: number } | null }) => void) => {
      const handler = (_event: unknown, payload?: { prevWindowBounds?: { x: number; y: number; width: number; height: number } | null }) => {
        try { cb(payload); } catch (err) { console.error('[onMaximizeRequest]', err); }
      };
      ipcRenderer.on('tile:window:maximize-request', handler);
      return () => ipcRenderer.off('tile:window:maximize-request', handler);
    },

    /**
     * Subscribe to unmaximize requests targeted at this window. See
     * `onMaximizeRequest` for the firing contract.
     */
    onUnmaximizeRequest: (cb: () => void) => {
      const handler = () => { try { cb(); } catch (err) { console.error('[onUnmaximizeRequest]', err); } };
      ipcRenderer.on('tile:window:unmaximize-request', handler);
      return () => ipcRenderer.off('tile:window:unmaximize-request', handler);
    },

    /**
     * Push the current canvas page-host state into the window's registry
     * params. Used by the page-host renderer to keep info.params in sync
     * with the live state (visible webview bounds + maximize state +
     * pre-maximize bounds when maximized) so session save and the
     * close-undo handler can read from a single source of truth at quit
     * time. Requires `window.manage` (or trustedBuiltin).
     */
    updateCanvasState: (state: {
      x: number; y: number; width: number; height: number;
      maximized: boolean;
      preMaxX?: number; preMaxY?: number; preMaxWidth?: number; preMaxHeight?: number;
    }) => {
      return ipcRenderer.invoke('tile:window:update-canvas-state', {
        token: tileToken,
        ...state,
      });
    },

    /**
     * Toggle fullscreen on a window. Requires `window.manage` (or
     * trustedBuiltin).
     */
    fullscreen: (id?: number) => {
      return ipcRenderer.invoke('tile:window:fullscreen', {
        token: tileToken,
        id,
      });
    },

    /**
     * Get the last-focused visible window id. Read-only — requires
     * `window.query` capability (or trustedBuiltin). Returns the bare
     * window id (number) or null, matching the v1 contract callers
     * already rely on (e.g. `if (!focusedId) ...`). Strict handler
     * returns `{success, data}`; we unwrap here.
     */
    getFocusedVisibleWindowId: async () => {
      const result = await ipcRenderer.invoke('tile:window:get-focused-visible-id', {
        token: tileToken,
      }) as { success?: boolean; data?: number | null } | undefined;
      if (!result || result.success !== true) return null;
      return typeof result.data === 'number' ? result.data : null;
    },

    /**
     * Open devtools (detached) on a target window. Resolution order:
     *   1. explicit id, if provided
     *   2. last-focused content (http/https) window
     *   3. last-focused visible window of any kind
     * Strict-only — requires trustedBuiltin (devtools is a developer
     * surface).
     */
    devtools: (id?: number) => {
      return ipcRenderer.invoke('tile:window:devtools', {
        token: tileToken,
        id,
      });
    },

    /**
     * Set the overlay focus target — captures which window should be
     * focused after an overlay closes. Requires `window.manage` (or
     * trustedBuiltin).
     */
    setOverlayFocusTarget: (targetWindowId: number) => {
      return ipcRenderer.invoke('tile:window:set-overlay-focus-target', {
        token: tileToken,
        targetWindowId,
      });
    },

    /**
     * Pin a window across macOS Spaces. Requires the `window` capability.
     */
    setVisibleOnAllWorkspaces: (
      id: number | null | undefined,
      visible: boolean,
      options?: { visibleOnFullScreen?: boolean; skipTransformProcessType?: boolean },
    ) => {
      return ipcRenderer.invoke('tile:window:set-visible-on-all-workspaces', {
        token: tileToken,
        id: typeof id === 'number' ? id : undefined,
        visible,
        options,
      });
    },

    /**
     * Show this tile's own window.
     *
     * No `window` capability required. The tile's token is the authority —
     * it can only affect the window it runs in. Use for tiles that start
     * hidden at boot (resident: true) and reveal themselves on command.
     */
    showSelf: async () => {
      const _valid = await validationPromise; if (!_valid) return Promise.reject(new Error('Not initialized'));
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
    hideSelf: async () => {
      const _valid = await validationPromise; if (!_valid) return Promise.reject(new Error('Not initialized'));
      return ipcRenderer.invoke('tile:window:hide-self', {
        token: tileToken,
      });
    },

    /**
     * Send a postMessage from this popup tile to its opener window.
     *
     * Strict path routes through `tile:window:opener-postmessage` which
     * requires `window.manage`. Intended for popup tiles that communicate
     * results back to the window that opened them.
     */
    openerPostMessage: async (message: unknown, origin?: string) => {
      const _valid = await validationPromise; if (!_valid) return Promise.reject(new Error('Not initialized'));
      return ipcRenderer.invoke('tile:window:opener-postmessage', {
        token: tileToken,
        message,
        origin,
      });
    },

    /**
     * Close the opener window from this popup tile.
     *
     * Strict path routes through `tile:window:opener-close` which
     * requires `window.manage`.
     */
    openerClose: async () => {
      const _valid = await validationPromise; if (!_valid) return Promise.reject(new Error('Not initialized'));
      return ipcRenderer.invoke('tile:window:opener-close', {
        token: tileToken,
      });
    },

    /**
     * Focus the opener window from this popup tile.
     *
     * Strict path routes through `tile:window:opener-focus` which
     * requires `window.manage`.
     */
    openerFocus: async () => {
      const _valid = await validationPromise; if (!_valid) return Promise.reject(new Error('Not initialized'));
      return ipcRenderer.invoke('tile:window:opener-focus', {
        token: tileToken,
      });
    },

    /**
     * Get the Electron BrowserWindow id for the calling renderer.
     *
     * Routes strictly through `tile:window:get-id`. No `window`
     * capability required — the tile's token is the authority
     * (a tile always knows its own window).
     */
    getId: async () => {
      const _valid = await validationPromise; if (!_valid) return Promise.reject(new Error('Not initialized'));
      return ipcRenderer.invoke('tile:window:get-id', { token: tileToken });
    },

    // Legacy alias for getId — several callers still use the older name.
    getWindowId: async () => {
      const _valid = await validationPromise; if (!_valid) return Promise.reject(new Error('Not initialized'));
      return ipcRenderer.invoke('tile:window:get-id', { token: tileToken });
    },

    /**
     * Get the full bounds (x, y, width, height) for the calling window.
     *
     * Routes strictly through `tile:window:get-bounds`. No `window`
     * capability required — a tile always knows its own bounds.
     */
    getBounds: async () => {
      const _valid = await validationPromise; if (!_valid) return Promise.reject(new Error('Not initialized'));
      return ipcRenderer.invoke('tile:window:get-bounds', { token: tileToken });
    },

    /**
     * Get display info (workArea, bounds, scaleFactor) for the display
     * containing the calling window.
     *
     * Routes strictly through `tile:window:get-display-info`. No `window`
     * capability required — a tile can always query its own display.
     */
    getDisplayInfo: async () => {
      const _valid = await validationPromise; if (!_valid) return Promise.reject(new Error('Not initialized'));
      return ipcRenderer.invoke('tile:window:get-display-info', { token: tileToken });
    },

    /**
     * Set the position and/or size of the calling window.
     *
     * Routes strictly through `tile:window:set-bounds`. No `window`
     * capability required — a tile can always reposition its own window.
     */
    setBounds: async (bounds: { x?: number; y?: number; width?: number; height?: number }) => {
      const _valid = await validationPromise; if (!_valid) return Promise.reject(new Error('Not initialized'));
      return ipcRenderer.invoke('tile:window:set-bounds', { token: tileToken, ...bounds });
    },
  };

  // ── Datastore (if granted) ──
  //
  // Strict surfaces (get/set/query/extractPageContent) route through
  // `tile:datastore:*` which enforces per-table capability. The v1-compat
  // helper methods were replaced with hard-fail stubs.

  const datastoreStrict = {
    /**
     * Get a value from the tile's scoped storage
     */
    get: async (table: string, key: string) => {
      const _valid = await validationPromise; if (!_valid) return Promise.reject(new Error('Not initialized'));
      return ipcRenderer.invoke('tile:datastore:get', {
        token: tileToken,
        table,
        key,
      });
    },

    /**
     * Set a value in the tile's scoped storage
     */
    set: async (table: string, key: string, value: unknown) => {
      const _valid = await validationPromise; if (!_valid) return Promise.reject(new Error('Not initialized'));
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
    query: async (table: string, filter?: Record<string, unknown>) => {
      const _valid = await validationPromise; if (!_valid) return Promise.reject(new Error('Not initialized'));
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
    extractPageContent: async (url: string) => {
      const _valid = await validationPromise; if (!_valid) return Promise.reject(new Error('Not initialized'));
      return ipcRenderer.invoke('tile:datastore:extract-page-content', {
        token: tileToken,
        url,
      });
    },
  };

  // Named datastore methods that features rely on. Each routes to the
  // corresponding legacy `datastore-*` IPC channel in ipc.ts. These are
  // thin routing wrappers, not strict capability-gated paths.
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
      ipcRenderer.invoke('tile:datastore:add-address', { token: tileToken, uri, options }),
    getAddress: (id: string) =>
      ipcRenderer.invoke('tile:datastore:get-address', { token: tileToken, id }),
    updateAddress: (id: string, updates: unknown) =>
      ipcRenderer.invoke('tile:datastore:update-address', { token: tileToken, id, updates }),
    queryAddresses: (filter?: unknown) =>
      ipcRenderer.invoke('tile:datastore:query-addresses', { token: tileToken, filter }),
    addVisit: (addressId: string, options?: unknown) =>
      ipcRenderer.invoke('tile:datastore:add-visit', { token: tileToken, addressId, options }),
    queryVisits: (filter?: unknown) =>
      ipcRenderer.invoke('tile:datastore:query-visits', { token: tileToken, filter }),
    addContent: (options: unknown) =>
      ipcRenderer.invoke('tile:datastore:add-content', { token: tileToken, options }),
    queryContent: (filter?: unknown) =>
      ipcRenderer.invoke('tile:datastore:query-content', { token: tileToken, filter }),
    getTable: (tableName: string) =>
      ipcRenderer.invoke('tile:datastore:get-table', { token: tileToken, tableName }),
    setRow: (tableName: string, rowId: string, rowData: unknown) =>
      ipcRenderer.invoke('tile:datastore:set-row', { token: tileToken, tableName, rowId, rowData }),
    getRow: (tableName: string, rowId: string) =>
      ipcRenderer.invoke('tile:datastore:get-row', { token: tileToken, tableName, rowId }),
    getStats: () => ipcRenderer.invoke('tile:datastore:get-stats', { token: tileToken }),
    // Tag helpers
    getOrCreateTag: (name: string) =>
      ipcRenderer.invoke('tile:datastore:get-or-create-tag', { token: tileToken, name }),
    tagAddress: (addressId: string, tagId: string) =>
      ipcRenderer.invoke('tile:datastore:tag-address', { token: tileToken, addressId, tagId }),
    untagAddress: (addressId: string, tagId: string) =>
      ipcRenderer.invoke('tile:datastore:untag-address', { token: tileToken, addressId, tagId }),
    getTagsByFrecency: (domain?: string) =>
      ipcRenderer.invoke('tile:datastore:get-tags-by-frecency', { token: tileToken, domain }),
    renameTag: (tagId: string, newName: string) =>
      ipcRenderer.invoke('tile:datastore:rename-tag', { token: tileToken, tagId, newName }),
    updateTagColor: (tagId: string, color: string) =>
      ipcRenderer.invoke('tile:datastore:update-tag-color', { token: tileToken, tagId, color }),
    deleteTag: (tagId: string) =>
      ipcRenderer.invoke('tile:datastore:delete-tag', { token: tileToken, tagId }),
    getAddressTags: (addressId: string) =>
      ipcRenderer.invoke('tile:datastore:get-address-tags', { token: tileToken, addressId }),
    getAddressesByTag: (tagId: string) =>
      ipcRenderer.invoke('tile:datastore:get-addresses-by-tag', { token: tileToken, tagId }),
    getUntaggedAddresses: () =>
      ipcRenderer.invoke('tile:datastore:get-untagged-addresses', { token: tileToken }),
    // Item helpers
    addItem: (type: string, options: unknown = {}) =>
      ipcRenderer.invoke('tile:datastore:add-item', { token: tileToken, type, options }),
    getItem: (id: string) =>
      ipcRenderer.invoke('tile:datastore:get-item', { token: tileToken, id }),
    findUrlItem: (url: string) =>
      ipcRenderer.invoke('tile:datastore:find-url-item', { token: tileToken, url }),
    updateItem: (id: string, options: unknown) =>
      ipcRenderer.invoke('tile:datastore:update-item', { token: tileToken, id, options }),
    deleteItem: (id: string) =>
      ipcRenderer.invoke('tile:datastore:delete-item', { token: tileToken, id }),
    hardDeleteItem: (id: string) =>
      ipcRenderer.invoke('tile:datastore:hard-delete-item', { token: tileToken, id }),
    updateItemTitle: (url: string, title: string) =>
      ipcRenderer.invoke('tile:datastore:update-item-title', { token: tileToken, url, title }),
    updateItemFavicon: (url: string, faviconUrl: string) =>
      ipcRenderer.invoke('tile:datastore:update-item-favicon', { token: tileToken, url, faviconUrl }),
    queryItems: (filter: unknown = {}) =>
      ipcRenderer.invoke('tile:datastore:query-items', { token: tileToken, filter }),
    tagItem: (itemId: string, tagId: string) =>
      ipcRenderer.invoke('tile:datastore:tag-item', { token: tileToken, itemId, tagId }),
    untagItem: (itemId: string, tagId: string) =>
      ipcRenderer.invoke('tile:datastore:untag-item', { token: tileToken, itemId, tagId }),
    getItemTags: (itemId: string) =>
      ipcRenderer.invoke('tile:datastore:get-item-tags', { token: tileToken, itemId }),
    getAllItemTags: () =>
      ipcRenderer.invoke('tile:datastore:get-all-item-tags', { token: tileToken }),
    getItemsByTag: (tagId: string) =>
      ipcRenderer.invoke('tile:datastore:get-items-by-tag', { token: tileToken, tagId }),
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
    addItemEvent: (itemId: string, options?: unknown) =>
      ipcRenderer.invoke('tile:datastore:add-item-event', { token: tileToken, itemId, options }),
    getItemEvent: (eventId: string) =>
      ipcRenderer.invoke('tile:datastore:get-item-event', { token: tileToken, eventId }),
    queryItemEvents: (filter: unknown = {}) =>
      ipcRenderer.invoke('tile:datastore:query-item-events', { token: tileToken, filter }),
    deleteItemEvent: (eventId: string) =>
      ipcRenderer.invoke('tile:datastore:delete-item-event', { token: tileToken, eventId }),
    deleteItemEvents: (itemId: string) =>
      ipcRenderer.invoke('tile:datastore:delete-item-events', { token: tileToken, itemId }),
    getLatestItemEvent: (itemId: string) =>
      ipcRenderer.invoke('tile:datastore:get-latest-item-event', { token: tileToken, itemId }),
    countItemEvents: (itemId: string, filter?: unknown) =>
      ipcRenderer.invoke('tile:datastore:count-item-events', { token: tileToken, itemId, filter }),
  };

  // ── Network (if granted) ──

  api.network = {
    /**
     * Fetch a URL — domain-gated by capability
     * The main process validates the domain against the allowlist
     */
    fetch: async (url: string, options?: Record<string, unknown>) => {
      const _valid = await validationPromise; if (!_valid) return Promise.reject(new Error('Not initialized'));
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
    read: async (filePath: string) => {
      const _valid = await validationPromise; if (!_valid) return Promise.reject(new Error('Not initialized'));
      return ipcRenderer.invoke('tile:filesystem:read', {
        token: tileToken,
        path: filePath,
      });
    },

    /**
     * Write a file — path-gated by capability
     */
    write: async (filePath: string, content: string) => {
      const _valid = await validationPromise; if (!_valid) return Promise.reject(new Error('Not initialized'));
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

    // ── tile:theme:* strict shims ────────────────────────────────────────
    // These route through the tile:theme:* strict channels which enforce
    // trustedBuiltin gating on the main-process side. Non-trusted callers
    // will receive { success: false, error: 'trustedBuiltin required' }.
    // setWindowColorScheme has a thin trustedBuiltin wrapper below that
    // resolves the target windowId before forwarding to the strict channel.

    /**
     * Get current theme settings (id, colorScheme, isDark, effectiveScheme).
     * Strict path; requires trustedBuiltin enforcement on the IPC side.
     */
    get: async () => {
      const _valid = await validationPromise; if (!_valid) return Promise.reject(new Error('Not initialized'));
      return ipcRenderer.invoke('tile:theme:get', { token: tileToken });
    },

    /**
     * Set global color scheme preference (system/light/dark).
     * Strict path; requires trustedBuiltin enforcement on the IPC side.
     */
    setColorScheme: async (colorScheme: string) => {
      const _valid = await validationPromise; if (!_valid) return Promise.reject(new Error('Not initialized'));
      return ipcRenderer.invoke('tile:theme:setColorScheme', { token: tileToken, colorScheme });
    },

    /**
     * Set color scheme for a specific window only (does not affect global setting).
     * Strict path; requires trustedBuiltin enforcement on the IPC side.
     */
    setWindowColorScheme: async (windowId: number, colorScheme: string) => {
      const _valid = await validationPromise; if (!_valid) return Promise.reject(new Error('Not initialized'));
      return ipcRenderer.invoke('tile:theme:setWindowColorScheme', { token: tileToken, windowId, colorScheme });
    },

    /**
     * Set the active theme by id.
     * Strict path; requires trustedBuiltin enforcement on the IPC side.
     */
    setTheme: async (themeId: string) => {
      const _valid = await validationPromise; if (!_valid) return Promise.reject(new Error('Not initialized'));
      return ipcRenderer.invoke('tile:theme:setTheme', { token: tileToken, themeId });
    },

    /**
     * List available (builtin) themes with metadata.
     * Strict path; requires trustedBuiltin enforcement on the IPC side.
     */
    list: async () => {
      const _valid = await validationPromise; if (!_valid) return Promise.reject(new Error('Not initialized'));
      return ipcRenderer.invoke('tile:theme:list', { token: tileToken });
    },

    /**
     * Get all themes (builtin + external from DB).
     * Strict path; requires trustedBuiltin enforcement on the IPC side.
     */
    getAll: async () => {
      const _valid = await validationPromise; if (!_valid) return Promise.reject(new Error('Not initialized'));
      return ipcRenderer.invoke('tile:theme:getAll', { token: tileToken });
    },

    // Theme directory management — Settings UI uses these to install
    // user-supplied themes from disk. Strict tile:theme:* counterparts
    // live in tile-ipc.ts. trustedBuiltin only.
    pickFolder: () => ipcRenderer.invoke('tile:theme:pickFolder', { token: tileToken }),
    validateFolder: (folderPath: string) => ipcRenderer.invoke('tile:theme:validateFolder', { token: tileToken, folderPath }),
    add: (folderPath: string) => ipcRenderer.invoke('tile:theme:add', { token: tileToken, folderPath }),
    remove: (themeId: string) => ipcRenderer.invoke('tile:theme:remove', { token: tileToken, themeId }),
    reload: (themeId: string) => ipcRenderer.invoke('tile:theme:reload', { token: tileToken, themeId }),
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
      const _valid = await validationPromise; if (!_valid) return Promise.reject(new Error('Not initialized'));
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
      const _valid = await validationPromise; if (!_valid) return Promise.reject(new Error('Not initialized'));
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
     * Removed: use api.settings.get(key) instead.
     */
    getKey: (..._args: unknown[]) => {
      throw new Error('[tile-preload] api.settings.getKey removed; use api.settings.get');
    },

    /**
     * Removed: use api.settings.set(key, value) instead.
     */
    setKey: (..._args: unknown[]) => {
      throw new Error('[tile-preload] api.settings.setKey removed; use api.settings.set');
    },

    /**
     * Cross-tile foreign-read: fetch another tile's stored setting value
     * (read-only). Strict path only — the tile's manifest must declare
     * `settings.readForeign` (or top-level `settingsForeign`). Routes
     * through `tile:settings:get-foreign`; the main-process handler
     * checks the allowlist and scopes the DB query to the named foreign
     * tile.
     *
     * Returns a normalised `{success, data, value, error}` object so
     * that callers using either the legacy `{success, data}` shape or
     * the strict `{value, error}` shape both work correctly.
     */
    getExtKey: async (extId: unknown, key: unknown) => {
      if (!extId || !key) {
        return { success: false, data: undefined, value: undefined, error: 'extId and key are required' };
      }
      if (!hasSettingsForeignCapability()) {
        throw new Error('[tile-preload] api.settings.getExtKey requires settings.readForeign capability in manifest');
      }
      // Handler returns { success, data } (native shape) — normalise into the
      // legacy { success, data, value } envelope so callers using either
      // field work. Returns `success: true, data: null` when the key simply
      // hasn't been written yet (not an error).
      const r = await ipcRenderer.invoke('tile:settings:get-foreign', {
        token: tileToken,
        foreignExtId: extId,
        key,
      }) as { success?: boolean; data?: unknown; value?: unknown; error?: string } | null;
      if (!r || r.success === false) {
        return { success: false, data: undefined, value: undefined, error: r?.error ?? 'unknown error' };
      }
      const value = r.data !== undefined ? r.data : r.value;
      return { success: true, data: value, value, error: undefined };
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
  // Strict-only: route through `tile:shortcuts:*`. The main-process
  // handlers validate the token + capability + keys allowlist. Tiles
  // that call api.shortcuts.* must declare a `shortcuts` capability
  // (`true` or `{ keys: [...] }`) in their manifest; missing capability
  // throws.
  //
  // The capability check is per-call (not at API-build time) because
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

  // Declare the tile's full set of persisted lazy-WAKE shortcuts (snapshot
  // / replace-all). The main process stores them so it can register these
  // user-configured global hotkeys at boot WITHOUT this renderer running,
  // and live-re-registers them immediately. Each entry is
  // `{ accelerator, wakeTopic, wakeArgs? }` — pressing `accelerator`
  // publishes `wakeTopic` with `{ args: wakeArgs }` (which wakes the tile).
  function declareWakeShortcutsStrict(list: unknown): void {
    const shortcuts = Array.isArray(list) ? list : [];
    ipcRenderer.send('tile:shortcuts:declare-wake', {
      token: tileToken,
      shortcuts,
    });
  }

  // Strict-only shortcuts surface. Tiles must declare `shortcuts` in
  // their manifest capabilities.
  api.shortcuts = {
    register: (shortcut: unknown, cb: unknown, options: unknown) => {
      if (!hasShortcutsCapability()) {
        throw new Error('[tile-preload] api.shortcuts.register requires shortcuts capability in manifest');
      }
      registerShortcutStrict(shortcut, cb, options);
    },
    unregister: (shortcut: unknown, options: unknown) => {
      if (!hasShortcutsCapability()) {
        throw new Error('[tile-preload] api.shortcuts.unregister requires shortcuts capability in manifest');
      }
      unregisterShortcutStrict(shortcut, options);
    },
    declareWakeShortcuts: (list: unknown) => {
      if (!hasShortcutsCapability()) {
        throw new Error('[tile-preload] api.shortcuts.declareWakeShortcuts requires shortcuts capability in manifest');
      }
      declareWakeShortcutsStrict(list);
    },
  };

  // ── Rules (event-dispatch registry, Stage 1) ──────────────────────
  //
  // Stage 1 of the rule engine (peek MCP plan 3d7d9239). Tiles call
  // these to register/unregister runtime rules — rows persisted to
  // the local `rules` table with source='runtime'. Manifest-declared
  // rules are reconciled at install time and not touched here.
  //
  // Capability check is per-call to match how shortcuts/commands are
  // wired (grantedCapabilities is populated asynchronously).
  function hasRulesCapability(): boolean {
    return grantedCapabilities?.rules === true;
  }

  api.rules = {
    list: (options?: { topic?: string; enabled?: boolean }) => {
      if (!hasRulesCapability()) {
        return Promise.reject(new Error('[tile-preload] api.rules.list requires rules capability in manifest'));
      }
      return ipcRenderer.invoke('tile:rules:list', {
        token: tileToken,
        topic: options?.topic,
        enabled: options?.enabled,
      });
    },
    listAffordances: () => {
      if (!hasRulesCapability()) {
        return Promise.reject(new Error('[tile-preload] api.rules.listAffordances requires rules capability in manifest'));
      }
      return ipcRenderer.invoke('tile:rules:list-affordances', { token: tileToken });
    },
    register: (rule: {
      id?: string;
      topic: string;
      scriptId: string;
      match?: Record<string, unknown>;
      config?: Record<string, unknown>;
      display?: Record<string, unknown> | null;
      enabled?: boolean;
      ordering?: number;
    }) => {
      if (!hasRulesCapability()) {
        return Promise.reject(new Error('[tile-preload] api.rules.register requires rules capability in manifest'));
      }
      return ipcRenderer.invoke('tile:rules:register', { token: tileToken, ...rule });
    },
    unregister: (id: string) => {
      if (!hasRulesCapability()) {
        return Promise.reject(new Error('[tile-preload] api.rules.unregister requires rules capability in manifest'));
      }
      return ipcRenderer.invoke('tile:rules:unregister', { token: tileToken, id });
    },
  };

  // ── Files (removed v1-compat) ────────────────────────────────────
  // Use api.dialogs.save / api.dialogs.open for file dialogs,
  // and api.filesystem.read / api.filesystem.write for path operations.
  api.files = {
    save: (..._args: unknown[]) => { throw new Error('[tile-preload] api.files.save removed; use api.dialogs.save'); },
    open: (..._args: unknown[]) => { throw new Error('[tile-preload] api.files.open removed; use api.dialogs.open'); },
    readFromPath: (..._args: unknown[]) => { throw new Error('[tile-preload] api.files.readFromPath removed; use api.filesystem.read'); },
    writeToPath: (..._args: unknown[]) => { throw new Error('[tile-preload] api.files.writeToPath removed; use api.filesystem.write'); },
  };

  // ── Modes (removed — was unused) ─────────────────────────────────
  // api.modes was confirmed zero-usage. Hard-fail stubs catch any survivor.
  api.modes = {
    getWindowMode: (..._args: unknown[]) => { throw new Error('[tile-preload] api.modes removed (was unused); use api.context.*'); },
    setMajorMode: (..._args: unknown[]) => { throw new Error('[tile-preload] api.modes removed (was unused)'); },
    listModes: (..._args: unknown[]) => { throw new Error('[tile-preload] api.modes removed (was unused)'); },
    getCommandContext: (..._args: unknown[]) => { throw new Error('[tile-preload] api.modes removed (was unused)'); },
    onModeChange: (..._args: unknown[]) => { throw new Error('[tile-preload] api.modes removed (was unused)'); },
  };

  // ── Context ───────────────────────────────────────────────────────
  //
  // All renderers using tile-preload have `context` in their capability
  // grant (feature tiles via manifest; cmd/hud/page via
  // createTrustedBuiltinGrant). Route through tile:context:* strictly.

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
    get: (key: unknown, windowId: unknown) =>
      contextStrict.get(key as string, (windowId ?? null) as number | null),
    set: (key: unknown, value: unknown, metadata: unknown, windowId: unknown) =>
      contextStrict.set(key as string, value, metadata as Record<string, unknown> | undefined, (windowId ?? null) as number | null),
    history: (key: unknown, limit: unknown) =>
      contextStrict.history(key as string, limit as number | undefined),
    snapshot: (windowId: unknown) =>
      contextStrict.snapshot((windowId ?? null) as number | null),
    windowsWithValue: (key: unknown, value: unknown) =>
      contextStrict.windowsWithValue(key as string, value),
    windowsInSpace: (spaceId: unknown) =>
      contextStrict.windowsInSpace(spaceId as string),

    // ── Convenience aliases ──────────────────────────────────────────
    // These wrap the generic get/set/subscribe surface for the common
    // 'mode' key — api.context.setMode / getMode / watchMode /
    // getWindowsInSpace.

    setMode: (mode: unknown, options?: { metadata?: Record<string, unknown>; windowId?: number | null }) => {
      const metadata = options?.metadata;
      const windowId = (options?.windowId ?? null) as number | null;
      return contextStrict.set('mode', mode, metadata, windowId);
    },

    getMode: () => contextStrict.get('mode', null),

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
      // `tile:context:get` returns `{success, data: ContextEntry}` where the
      // ContextEntry has `{value, metadata, ...}` — the pubsub-driven path
      // below delivers `(value, entry)`, so match that shape here too
      // (previously this passed the whole ContextEntry as `mode`, causing
      // callers that did `textContent = mode` to render "[object Object]").
      const getPromise = contextStrict.get('mode', null);
      (getPromise as Promise<unknown>).then((result: unknown) => {
        const r = result as { success?: boolean; data?: { value?: unknown } | null } | null;
        const entry = r && typeof r === 'object' && r.data && typeof r.data === 'object' ? r.data : null;
        const value = entry ? (entry as { value?: unknown }).value ?? null : null;
        callback(value, entry);
      }).catch(() => {
        callback(null, null);
      });
      return unsubscribe;
    },

    getWindowsInSpace: (spaceId: unknown) =>
      contextStrict.windowsInSpace(spaceId as string),
  };

  // ── Dialogs ───────────────────────────────────────────────────────
  //
  // Strict-only API: `api.dialogs.save` / `api.dialogs.open` route
  // through `tile:dialogs:*` when the tile declared a `dialogs`
  // capability (`true` or `{ types: [...] }`). When the capability is
  // not declared the strict handler rejects with `dialogs capability
  // not granted`. The v1 `api.files.save` / `api.files.open` surface
  // is a hard-fail stub directing callers here.

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
  // All calls route through the strict `tile:features:*` channel.
  // Main-process handlers validate the token + capability shape +
  // per-action gates + source allowlist.  Tiles without the `features`
  // capability will receive a capability-gate rejection from the handler
  // (correct behaviour — no v1-compat fallback).

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
    settingsSchema: (id: string) =>
      ipcRenderer.invoke('tile:features:settings-schema', { token: tileToken, id }),
  };

  api.features = {
    list: (sourceType: unknown) =>
      featuresStrict.list(sourceType as string | undefined),
    get: (id: unknown) =>
      featuresStrict.get(id as string),
    history: (featureId: unknown, limit: unknown) =>
      featuresStrict.history(featureId as string | undefined, limit as number | undefined),
    enable: (id: unknown, tilePreloadPath: unknown) =>
      featuresStrict.enable(id as string, tilePreloadPath as string | undefined),
    disable: (id: unknown) =>
      featuresStrict.disable(id as string),
    remove: (id: unknown) =>
      featuresStrict.remove(id as string),
    installResolve: (atUri: unknown) =>
      featuresStrict.installResolve(atUri as string),
    previewCapabilities: (mc: unknown, id: unknown) =>
      featuresStrict.previewCapabilities(mc, id as string),
    install: (atUri: unknown, userApproved: unknown) =>
      featuresStrict.install(atUri as string, userApproved as boolean),
    resolvePublisher: (query: unknown) =>
      featuresStrict.resolvePublisher(query as string),
    settingsSchema: (id: unknown) =>
      featuresStrict.settingsSchema(id as string),

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
        throw new Error('[tile-preload] api.izui.isTransient() requires the izui capability in your tile manifest');
      }
      const result = await ipcRenderer.invoke('tile:izui:is-transient', { token: tileToken });
      if (result && typeof result === 'object' && 'transient' in result) {
        return (result as { transient: boolean }).transient;
      }
      return result;
    },
    getEffectiveMode: async () => {
      if (!hasIzuiCapability()) throw new Error('[tile-preload] api.izui.getEffectiveMode() requires the izui capability in your tile manifest');
      const result = await ipcRenderer.invoke('tile:izui:get-effective-mode', { token: tileToken });
      if (result && typeof result === 'object' && 'mode' in result) {
        return (result as { mode: string }).mode;
      }
      return result;
    },
    getState: async () => {
      if (!hasIzuiCapability()) throw new Error('[tile-preload] api.izui.getState() requires the izui capability in your tile manifest');
      const result = await ipcRenderer.invoke('tile:izui:get-state', { token: tileToken });
      if (result && typeof result === 'object' && 'state' in result) {
        return (result as { state: unknown }).state;
      }
      return result;
    },
    getPreOverlayFocusTarget: async () => {
      if (!hasIzuiCapability()) throw new Error('[tile-preload] api.izui.getPreOverlayFocusTarget() requires the izui capability in your tile manifest');
      const result = await ipcRenderer.invoke('tile:izui:get-pre-overlay-focus-target', { token: tileToken });
      if (result && typeof result === 'object' && 'target' in result) {
        return (result as { target: unknown }).target;
      }
      return result;
    },
    closeSelf: () => {
      if (!hasIzuiCapability()) throw new Error('[tile-preload] api.izui.closeSelf() requires the izui capability in your tile manifest');
      return ipcRenderer.invoke('tile:izui:close-self', { token: tileToken });
    },
  };

  // ── OAuth ─────────────────────────────────────────────────────────
  //
  // Strict-only: tiles must declare an `oauth` capability in their
  // manifest. Routes through `tile:oauth:*`; main-process handlers
  // validate token + capability shape + optional per-provider allowlist.

  function hasOAuthCapability(): boolean {
    const oc = grantedCapabilities?.oauth;
    if (oc === true) return true;
    if (oc && typeof oc === 'object') return true;
    return false;
  }

  api.oauth = {
    startLoopback: (options: unknown) => {
      if (!hasOAuthCapability()) {
        return Promise.reject(new Error('[tile-preload] api.oauth.startLoopback requires the oauth capability'));
      }
      const opts = (options || {}) as { callbackPath?: string; timeoutMs?: number; provider?: string };
      return ipcRenderer.invoke('tile:oauth:start-loopback', {
        token: tileToken,
        callbackPath: opts.callbackPath,
        timeoutMs: opts.timeoutMs,
        provider: opts.provider,
      });
    },
    awaitCallback: (port: unknown) => {
      if (!hasOAuthCapability()) {
        return Promise.reject(new Error('[tile-preload] api.oauth.awaitCallback requires the oauth capability'));
      }
      return ipcRenderer.invoke('tile:oauth:await-callback', {
        token: tileToken,
        port: port as number,
      });
    },
  };

  // ── Sync ──────────────────────────────────────────────────────────
  //
  // Strict-only: tiles must declare `sync: true` (builtin-only capability).
  // Routes through `tile:sync:sync-all`; main-process handler validates
  // the token + capability.

  function hasSyncCapability(): boolean {
    return grantedCapabilities?.sync === true;
  }

  api.sync = {
    syncAll: () => {
      if (!hasSyncCapability()) {
        return Promise.reject(new Error('[tile-preload] api.sync.syncAll requires the sync capability'));
      }
      return ipcRenderer.invoke('tile:sync:sync-all', { token: tileToken });
    },
    // Strict tile:sync:* counterparts of the legacy `sync-*` handlers
    // live in tile-ipc.ts. trustedBuiltin only — sync
    // touches network, server creds, and profile state.
    getConfig: () => ipcRenderer.invoke('tile:sync:get-config', { token: tileToken }),
    setConfig: (config: unknown) => ipcRenderer.invoke('tile:sync:set-config', { token: tileToken, config }),
    getStatus: () => ipcRenderer.invoke('tile:sync:status', { token: tileToken }),
    pull: (options?: { since?: number }) => ipcRenderer.invoke('tile:sync:pull', { token: tileToken, since: options?.since }),
    push: (options?: { since?: number }) => ipcRenderer.invoke('tile:sync:push', { token: tileToken, since: options?.since }),
  };

  // ── Ad blocker ────────────────────────────────────────────────────
  //
  // Strict tile:adblocker:* counterparts of the legacy `adblocker:*`
  // handlers live in tile-ipc.ts. trustedBuiltin only —
  // global blocker state + per-site allowlist persisted to feature_settings.
  api.adblocker = {
    getStatus: () => ipcRenderer.invoke('tile:adblocker:getStatus', { token: tileToken }),
    enable: () => ipcRenderer.invoke('tile:adblocker:enable', { token: tileToken }),
    disable: () => ipcRenderer.invoke('tile:adblocker:disable', { token: tileToken }),
    getBlockedCount: () => ipcRenderer.invoke('tile:adblocker:getBlockedCount', { token: tileToken }),
    getAllowlist: () => ipcRenderer.invoke('tile:adblocker:getAllowlist', { token: tileToken }),
    isSiteAllowed: (hostname: string) => ipcRenderer.invoke('tile:adblocker:isSiteAllowed', { token: tileToken, hostname }),
    allowSite: (hostname: string) => ipcRenderer.invoke('tile:adblocker:allowSite', { token: tileToken, hostname }),
    disallowSite: (hostname: string) => ipcRenderer.invoke('tile:adblocker:disallowSite', { token: tileToken, hostname }),
  };

  // ── Web permissions (settings UI) ─────────────────────────────────
  //
  // Read/clear stored per-origin permission decisions persisted by the
  // backend permission handler. trustedBuiltin only — the settings page
  // is the canonical caller. Tile renderers can't snoop or tamper with
  // another tile's stored decisions via this surface.
  api.permissions = {
    list: () => ipcRenderer.invoke('tile:permissions:list', { token: tileToken }),
    forget: (origin: string, permission: string) =>
      ipcRenderer.invoke('tile:permissions:forget', { token: tileToken, origin, permission }),
    forgetAll: () => ipcRenderer.invoke('tile:permissions:forgetAll', { token: tileToken }),
  };

  // ── Dark mode ─────────────────────────────────────────────────────
  //
  // Thin wrappers over `darkMode:*` ipcMain handlers.
  api.darkMode = {
    get: () => ipcRenderer.invoke('tile:darkMode:get', { token: tileToken }),
    set: (mode: string) => ipcRenderer.invoke('tile:darkMode:set', { token: tileToken, mode }),
  };

  // ── closeWindow (removed — was unused) ───────────────────────────
  // Use api.window.close() instead.
  api.closeWindow = (..._args: unknown[]) => {
    throw new Error('[tile-preload] api.closeWindow removed (was unused); use api.window.close()');
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
      return ipcRenderer.invoke('tile:screen:get-primary-display', {
        token: tileToken,
      });
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
      if (!hasSessionCapability()) {
        return Promise.reject(new Error('[tile-preload] api.session.saveSpaceWorkspaces requires the session capability'));
      }
      return ipcRenderer.invoke('tile:session:save-space-workspaces', {
        token: tileToken,
      });
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
  // Implementation: windows.ts dispatches `escape-pressed` per-window.
  // We listen to it here and invoke the tile's callback, replying on
  // the provided responseChannel.
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
    ipcRenderer.send('tile:log:write', { token: tileToken, source: sourceAddress, args });
  };

  // ── Privileged escape hatch (trustedBuiltin only) ────────────────────
  //
  // `api.invoke(channel, data)` forwards to `ipcRenderer.invoke(...)` but
  // ONLY when the token's grant carries `trustedBuiltin: true` (core
  // renderers: cmd, hud, page, _test). Feature tiles never see this
  // method — their api.invoke is a no-op that returns an error object.
  //
  // The test fixture and core diagnostics rely on it to talk to
  // main-process handlers that don't (yet) have a tile-surfaced wrapper.
  //
  // Two behaviours are possible:
  //   - trustedBuiltin grant present → forward raw
  //   - no trustedBuiltin            → return failure
  // The boolean is populated by the `tile:validate-token` IPC response.
  // Validation is kicked off at module load time; callers don't need to
  // call api.initialize() before using api.invoke.
  api.invoke = async (channel: unknown, data?: unknown) => {
    const _valid = await validationPromise;
    if (!_valid) {
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

  // ── App control (trustedBuiltin only) ────────────────────────────────
  //
  // `api.quit` / `api.restart` are fire-and-forget IPC sends. The core
  // background renderer (app/index.js) registers `quit` / `restart` cmd
  // palette commands that invoke these. The channels are `ipcMain.on`
  // (not .handle), so `api.invoke` cannot replace them — a dedicated
  // `.send` wrapper is required.
  api.quit = () => {
    if (!trustedBuiltin) {
      console.warn('[tile-preload] api.quit requires trustedBuiltin — ignored');
      return;
    }
    ipcRenderer.send('tile:app:quit', { token: tileToken, source: sourceAddress });
  };

  api.restart = () => {
    if (!trustedBuiltin) {
      console.warn('[tile-preload] api.restart requires trustedBuiltin — ignored');
      return;
    }
    ipcRenderer.send('tile:app:restart', { token: tileToken, source: sourceAddress });
  };

  // ── Theme (trustedBuiltin extensions) ────────────────────────────────
  //
  // Core renderers (app/index.js in particular) call setWindowColorScheme
  // with only a colorScheme argument (no windowId), relying on window-ID
  // resolution via `get-focused-visible-window-id`. The strict
  // tile:theme:setWindowColorScheme channel requires an explicit windowId,
  // so we keep a thin trustedBuiltin wrapper here that resolves the ID
  // before forwarding to the strict channel. All other theme methods route
  // through the base api.theme.* implementations above (tile:theme:*).
  // Install the override unconditionally (the install-time `trustedBuiltin`
  // flag is still `false` here — buildAPI runs synchronously before
  // api.initialize() flips it). The handler itself runs at call time, by
  // which point `trustedBuiltin` reflects the validated grant. Non-trusted
  // callers are still rejected by the strict tile:theme:setWindowColorScheme
  // handler which enforces `grant.trustedBuiltin`.
  (api.theme as Record<string, unknown>).setWindowColorScheme = async (
    windowIdOrColorScheme: number | string,
    maybeColorScheme?: string,
  ) => {
    // Core/test renderers target the "last focused visible window" via
    // `get-focused-visible-window-id`, not their own hidden
    // BrowserWindow. Preserves v1 behaviour where the background
    // iframe ran the theme command on behalf of the user-facing window.
    //
    // Support two call shapes:
    //   setWindowColorScheme(colorScheme)            — trusted, resolve via tracker
    //   setWindowColorScheme(windowId, colorScheme)  — legacy explicit target
    let windowId: number | null = null;
    let colorScheme: string;
    if (typeof windowIdOrColorScheme === 'number' && typeof maybeColorScheme === 'string') {
      windowId = windowIdOrColorScheme;
      colorScheme = maybeColorScheme;
    } else if (typeof windowIdOrColorScheme === 'string') {
      colorScheme = windowIdOrColorScheme;
    } else {
      return { success: false, error: 'Invalid arguments to setWindowColorScheme' };
    }

    if (windowId == null) {
      // Pass the tracked id as a hint. The strict handler has its own
      // resolution chain (tracked id → getFocusedWindow → headless
      // enumeration) so it can still resolve a target when the hint is
      // null — critical for headless tests where `show:false` windows
      // never emit focus events and the tracker may be stale.
      const hintResult = await ipcRenderer.invoke('tile:window:get-focused-visible-id', {
        token: tileToken,
      }) as { success?: boolean; data?: number | null } | undefined;
      const hint = hintResult?.success === true ? hintResult.data : null;
      if (typeof hint === 'number' && hint > 0) {
        windowId = hint;
      }
    }
    return ipcRenderer.invoke('tile:theme:setWindowColorScheme', { token: tileToken, windowId, colorScheme });
  };

  // ── Chrome Extensions (trustedBuiltin only) ──────────────────────────
  //
  // `api.chromeExtensions.*` lets the core background renderer enumerate
  // bundled chrome extensions + their UI entry points (popup, options,
  // new-tab, etc.) and register cmd palette commands for each openable
  // entry. Gated on trustedBuiltin — feature tiles must not enumerate or
  // launch chrome extensions.
  //
  // Routes through tile:chrome-extensions:* channels in tile-ipc.ts
  // (trustedBuiltin enforcement + capability-token validation).
  api.chromeExtensions = {
    list: () => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.chromeExtensions requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('tile:chrome-extensions:list', { token: tileToken });
    },
    enable: (id: string) => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.chromeExtensions requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('tile:chrome-extensions:enable', { token: tileToken, id });
    },
    disable: (id: string) => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.chromeExtensions requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('tile:chrome-extensions:disable', { token: tileToken, id });
    },
    getStatus: () => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.chromeExtensions requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('tile:chrome-extensions:getStatus', { token: tileToken });
    },
    getUiEntries: () => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.chromeExtensions requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('tile:chrome-extensions:getUiEntries', { token: tileToken });
    },
    openPage: (id: string, type: string) => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.chromeExtensions requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('tile:chrome-extensions:openPage', { token: tileToken, id, type });
    },
  };

  // ── Backup (trustedBuiltin only) ─────────────────────────────────────
  //
  // Backup create/list/restore for the settings tile.
  api.backup = {
    create: () => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.backup requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('tile:backup:create', { token: tileToken });
    },
    list: () => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.backup requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('tile:backup:list', { token: tileToken });
    },
    getConfig: () => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.backup requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('tile:backup:get-config', { token: tileToken });
    },
  };

  // ── Shell (trustedBuiltin only) ───────────────────────────────────────
  //
  // Strict counterpart of the legacy `shell-open-path` channel.
  api.shell = {
    openPath: (filePath: string) => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.shell requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('tile:shell:open-path', { token: tileToken, path: filePath });
    },
  };

  // ── App (trustedBuiltin only) — extended methods ──────────────────────
  //
  // Strict counterparts of the legacy `default-browser-status`,
  // `set-default-browser`, and `get-app-prefs` channels. Extends the
  // existing api.quit / api.restart app control surface.
  api.app = {
    getDefaultBrowserStatus: () => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.app requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('tile:app:default-browser-status', { token: tileToken });
    },
    setDefaultBrowser: () => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.app requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('tile:app:set-default-browser', { token: tileToken });
    },
    getPrefs: () => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.app requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('tile:app:get-prefs', { token: tileToken });
    },
    getCliHelperPath: () => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.app requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('tile:app:cli-helper-path', { token: tileToken });
    },
    /**
     * Build the full shell command users paste into GNOME / KDE custom
     * keyboard shortcuts to fire a verb. Wraps ELECTRON_RUN_AS_NODE=1 +
     * bundled Electron binary + peek-cli helper + verb in `sh -c '…'`.
     */
    getCliCommand: (verb: string, args?: string[]) => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.app requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('tile:app:cli-command', { token: tileToken, verb, args });
    },
  };

  // ── Nav (trustedBuiltin only) ─────────────────────────────────────────
  //
  // Web nav handlers consumed by the core background renderer
  // (app/index.js) for the back/forward/reload/copy-url cmd palette
  // commands.
  api.nav = {
    back: (windowId?: number) => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.nav requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('tile:nav:back', { token: tileToken, windowId });
    },
    forward: (windowId?: number) => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.nav requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('tile:nav:forward', { token: tileToken, windowId });
    },
    reload: (windowId?: number) => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.nav requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('tile:nav:reload', { token: tileToken, windowId });
    },
    state: (windowId?: number) => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.nav requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('tile:nav:state', { token: tileToken, windowId });
    },
  };

  // ── Session (trustedBuiltin only) ─────────────────────────────────────
  //
  // Session save / restore-interactive / reopen-last-closed handlers,
  // consumed by the core background renderer (app/index.js).
  api.session = {
    save: () => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.session requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('tile:session:save', { token: tileToken });
    },
    restoreInteractive: () => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.session requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('tile:session:restore-interactive', { token: tileToken });
    },
    reopenLastClosed: () => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.session requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('tile:session:reopen-last-closed', { token: tileToken });
    },
  };

  // ── Debug flags (trustedBuiltin only) ─────────────────────────────────
  //
  // Read or flip the runtime debug flags (verbose logging + devtools for
  // new windows). Used by the features/debug cmd-palette tile and the
  // Settings UI "Debug" section. Changes are broadcast to all subscribers
  // via the `peek:debug:changed` pubsub topic.
  //
  // Named `debugFlags` rather than `debug` because 33+ feature files use
  // `const debug = api.debug;` as a no-op (`api.debug` has never been
  // wired — they silently resolve to undefined). Naming this surface
  // `debugFlags` keeps those sites inert; the namespace is reserved for
  // a future cleanup that wires a renderer-side verbose flag.
  api.debugFlags = {
    /** Read both flags. Returns { success: true, state: { verbose, devtools } }. */
    get: () => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.debugFlags requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('tile:debug:get', { token: tileToken });
    },
    /**
     * Flip one or both flags. Pass only the keys you want to change;
     * omitted keys are unchanged. Idempotent on the main side: setting a
     * flag to its current value is a no-op and skips the broadcast.
     */
    set: (state: { verbose?: boolean; devtools?: boolean }) => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.debugFlags requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('tile:debug:set', { token: tileToken, ...state });
    },
  };

  // ── api.mcp ─────────────────────────────────────────────────────────
  //
  // Reads/writes the `mcpServers.peek` entry in ~/.claude/settings.json.
  // Off by default — the toggle in Settings → Diagnostics writes the
  // entry on enable and removes it on disable.
  api.mcp = {
    getStatus: () => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.mcp requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('tile:mcp:status', { token: tileToken });
    },
    setConfig: (patch: { enabled?: boolean; profile?: string; readonly?: boolean; scopeTag?: string }) => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.mcp requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('tile:mcp:set-config', { token: tileToken, ...patch });
    },
    listScopedProjects: () => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.mcp requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('tile:mcp:list-scoped-projects', { token: tileToken });
    },
    scaffoldProject: (opts: { dirPath: string; scopeTag: string; profile?: string; readonly?: boolean }) => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.mcp requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('tile:mcp:scaffold-project', { token: tileToken, ...opts });
    },
    removeScopedProject: (dirPath: string) => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.mcp requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('tile:mcp:remove-scoped-project', { token: tileToken, dirPath });
    },
    pickDirectory: () => {
      if (!trustedBuiltin) {
        return Promise.resolve({ success: false, error: 'api.mcp requires trustedBuiltin' });
      }
      return ipcRenderer.invoke('tile:mcp:pick-directory', { token: tileToken });
    },
  };

  return api;
}

// ─── Expose API ──────────────────────────────────────────────────────

const api = buildAPI();

// Diagnostic perf-log channel. Always available (no token/cap gate); sends
// a pre-formatted string to main via ipcRenderer.send so that main can
// console.log it into main.log synchronously. Used by page.js for
// [page-boot:perf] markers that need to survive a rapid quit (the
// renderer.log async queue can drop events on shutdown). Fire-and-forget.
(api as Record<string, unknown>).perfLog = (message: string): void => {
  try {
    ipcRenderer.send('peek:perf-log', message);
  } catch {
    // Never let logging break the app.
  }
};

contextBridge.exposeInMainWorld('app', api);
__preloadMark('preload-done');

// ─── Click-and-Hold Window Drag (unified, application-wide) ─────────
//
// Provides drag-to-move for all frameless windows. Hold the mouse button
// down for `dragHoldDelay` seconds (configurable via the `dragHoldDelay`
// pref in app/config.js — see Settings > Core), then drag to move the
// window.
// Works in every tile window that doesn't opt out via `data-no-drag` on
// <body> (e.g. peek://app/page/index.html — canvas pages have their own
// hold-drag system that pipes through the webview console-message
// bridge).
//
// Settings, cmd panel, hud overlay, and other pseudo-tile windows all
// rely on this for window movement.
{
  const MOVE_THRESHOLD = 3;     // px of movement after hold to engage drag
  const JITTER_TOLERANCE = 3;   // px allowed during hold without cancelling
  let HOLD_DELAY = 1000;        // ms; updated from prefs at init

  let isDragging = false;
  let holdReady = false;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let mouseButtonDown = false;
  let cachedWindowId: number | null = null;

  let lastScreenX = 0, lastScreenY = 0;
  let holdOriginX = 0, holdOriginY = 0;
  let dragOriginX = 0, dragOriginY = 0;
  let windowOriginX = 0, windowOriginY = 0;

  let positionPromise: Promise<{ success: boolean; x?: number; y?: number } | null> | null = null;
  let suppressClick = false;

  let rafPending = false;
  let rafX = 0, rafY = 0;

  const shouldBlockDrag = (target: EventTarget | null): boolean => {
    if (!target || !(target as Element).closest) return false;
    const el = target as Element;
    if (el.closest('[data-no-drag]')) return true;
    const tag = (el.tagName || '').toLowerCase();
    if ((tag === 'input' || tag === 'textarea') && el === document.activeElement) return true;
    if ((el as HTMLElement).isContentEditable && el === document.activeElement) return true;
    return false;
  };

  const hasTextSelection = (): boolean => {
    const sel = window.getSelection();
    return !!(sel && sel.toString().length > 0);
  };

  const cancelHold = () => {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  };

  const endDrag = () => {
    const wasDragging = isDragging;
    cancelHold();
    holdReady = false;
    if (wasDragging) {
      isDragging = false;
      suppressClick = true;
      document.body.classList.remove('is-dragging');
      document.body.style.userSelect = '';
      (document.body.style as { webkitUserSelect?: string }).webkitUserSelect = '';
    }
    document.body.classList.remove('hold-ready');
    positionPromise = null;
  };

  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    mouseButtonDown = true;
    lastScreenX = e.screenX;
    lastScreenY = e.screenY;
    holdOriginX = e.screenX;
    holdOriginY = e.screenY;

    if (shouldBlockDrag(e.target)) return;
    if (cachedWindowId == null) return;

    positionPromise = ipcRenderer.invoke('tile:window:get-bounds', { token: tileToken })
      .catch(() => null);

    holdTimer = setTimeout(async () => {
      holdTimer = null;
      if (!mouseButtonDown) { positionPromise = null; return; }
      if (hasTextSelection()) { positionPromise = null; return; }

      const pos = await positionPromise;
      positionPromise = null;
      if (!pos || !pos.success || typeof pos.x !== 'number' || typeof pos.y !== 'number') return;
      if (!mouseButtonDown) return;

      dragOriginX = lastScreenX;
      dragOriginY = lastScreenY;
      windowOriginX = pos.x;
      windowOriginY = pos.y;
      holdReady = true;
      document.body.classList.add('hold-ready');
    }, HOLD_DELAY);
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!mouseButtonDown) return;
    lastScreenX = e.screenX;
    lastScreenY = e.screenY;

    if (holdTimer && !holdReady && !isDragging) {
      const dx = Math.abs(e.screenX - holdOriginX);
      const dy = Math.abs(e.screenY - holdOriginY);
      if (dx > JITTER_TOLERANCE || dy > JITTER_TOLERANCE) {
        cancelHold();
        positionPromise = null;
        return;
      }
    }

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
      (document.body.style as { webkitUserSelect?: string }).webkitUserSelect = 'none';
    }

    if (!isDragging) return;
    rafX = windowOriginX + (e.screenX - dragOriginX);
    rafY = windowOriginY + (e.screenY - dragOriginY);

    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        if (isDragging && cachedWindowId != null) {
          ipcRenderer.invoke('tile:window:set-bounds', { token: tileToken, x: rafX, y: rafY });
        }
      });
    }
  };

  const onMouseUp = (e: MouseEvent) => {
    if (e.button !== 0) return;
    mouseButtonDown = false;
    endDrag();
  };

  const onClickCapture = (e: MouseEvent) => {
    if (suppressClick) {
      suppressClick = false;
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  };

  const onBlur = () => { cancelHold(); };

  const initDrag = async () => {
    // Body opt-out: peek://app/page/* uses its own webview-bridged drag.
    if (document.body && document.body.hasAttribute('data-no-drag')) return;

    // Resolve cachedWindowId via the strict tile:window:get-id channel
    // (already present in the api surface via api.window.getWindowId).
    try {
      const valid = await validationPromise;
      if (valid) {
        const result = await ipcRenderer.invoke('tile:window:get-id', { token: tileToken });
        if (result && typeof result.id === 'number') cachedWindowId = result.id;
      }
    } catch {
      // Without windowId we can't drag — bail silently.
    }
    if (cachedWindowId == null) return;

    // Try to read dragHoldDelay from prefs. Requires trustedBuiltin grant
    // (tile:app:get-prefs gates on it). Non-trusted tiles fall back to
    // the 1000ms default — they typically don't need finer control.
    try {
      if (trustedBuiltin) {
        const prefs = await ipcRenderer.invoke('tile:app:get-prefs', { token: tileToken });
        if (prefs && typeof prefs.dragHoldDelay === 'number') {
          HOLD_DELAY = Math.max(0, prefs.dragHoldDelay * 1000);
        }
      }
    } catch {
      // Use default
    }

    const dragStyle = document.createElement('style');
    dragStyle.textContent =
      'body.hold-ready, body.hold-ready * { cursor: grab !important; }\n' +
      'body.is-dragging, body.is-dragging * { cursor: grabbing !important; }';
    document.head.appendChild(dragStyle);

    document.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('mousemove', onMouseMove, true);
    window.addEventListener('mouseup', onMouseUp, true);
    window.addEventListener('blur', onBlur);
    document.addEventListener('click', onClickCapture, true);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDrag);
  } else {
    initDrag();
  }
}

// ─── Theme Live-Reload ───────────────────────────────────────────────
//
// Tiles use `@import url('peek://theme/variables.css')` in their CSS to
// pull in theme CSS variables. The @import is resolved ONCE when the
// owning stylesheet loads — switching theme via settings updates what
// peek://theme/variables.css serves, but already-loaded tiles keep the
// cached CSSOM and don't pick up the new values.
//
// Fix: subscribe to `tile:theme:changed` (the same IPC that `api.theme.
// onChange` exposes) at preload level and inject a cache-busted
// `<link>` into `<head>`. The link's `:root { --* : ... }` rules
// override the cached @import rules via cascade order (later === higher
// priority for same specificity). When the new link's CSS finishes
// loading, the previous override link is removed so we don't accumulate
// stylesheets across many theme switches.
//
// Lives in the preload (rather than per-tile code) so every tile gets
// live theme updates for free — no per-feature wiring.
{
  let prevOverrideId: string | null = null;
  const applyThemeOverride = () => {
    try {
      if (!document || !document.head) return;
      const id = `peek-theme-live-${Date.now()}`;
      const link = document.createElement('link');
      link.id = id;
      link.rel = 'stylesheet';
      link.href = `peek://theme/variables.css?v=${Date.now()}`;
      const prevId = prevOverrideId;
      link.addEventListener('load', () => {
        if (prevId) {
          const prev = document.getElementById(prevId);
          if (prev) prev.remove();
        }
      });
      document.head.appendChild(link);
      prevOverrideId = id;
    } catch (err) {
      console.error('[tile-preload] theme live-reload threw:', err);
    }
  };

  ipcRenderer.on('tile:theme:changed', applyThemeOverride);
}

} // end else (tileId/tileEntry/tileToken present)
