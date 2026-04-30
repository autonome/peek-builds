/**
 * chrome.runtime.sendMessage (cross-origin / externally_connectable form)
 * → chrome.runtime.onMessageExternal polyfill for Electron.
 *
 * Background: Standard Chrome lets a regular web page whose origin matches
 * an extension's manifest `externally_connectable.matches` call
 * `chrome.runtime.sendMessage(extensionId, message, callback)`. The extension's
 * BG service worker receives this via `chrome.runtime.onMessageExternal`.
 * Proton Pass uses this for OAuth-fork delivery: the auth-callback page calls
 * `chrome.runtime.sendMessage(passId, tokens)` to hand off auth state to the
 * extension.
 *
 * Electron 40 implements `chrome.runtime` only partially for
 * externally_connectable origins — the page sees `chrome.runtime` exist but
 * the cross-origin sendMessage does not actually round-trip to BG SW
 * onMessageExternal listeners. This polyfill bridges the gap.
 *
 * ## Architecture
 *
 *   1. **Page-side polyfill** (MAIN world)
 *      Lives in `runtime-external-preload.cjs`. Injected via
 *      webFrame.executeJavaScript at preload time, so chrome.runtime.sendMessage
 *      is defined before the page's own scripts run. Forwards calls via
 *      window.postMessage to its bridge in the preload world.
 *
 *   2. **Webview preload bridge** (preload world, runtime-external-preload.cjs)
 *      Has access to ipcRenderer. Receives postMessage requests from the
 *      MAIN-world polyfill and forwards via
 *      `ipcRenderer.invoke('peek:runtime-external:send', payload)`.
 *
 *   3. **Main IPC handler** (this file's `setupMainProcess`)
 *      Dispatches incoming requests to the target extension's BG service worker
 *      via `session.serviceWorkers.send(versionId, channel, payload)` with a
 *      reqId. Maintains a pending-response map keyed by reqId; resolves when
 *      the BG SW replies via `ipc-message`.
 *
 *   4. **BG SW shim** (this file's `getBgInjection()`)
 *      Wraps `chrome.runtime.onMessageExternal.addListener` to capture
 *      registered listeners. Listens for our IPC channel; on incoming requests,
 *      fan-fires the captured listeners with synthetic sender info and routes
 *      their `sendResponse` callback back to main.
 *
 * ## Status (overnight checkpoint)
 *
 * The main IPC handler + preload + BG injection skeleton all exist. The
 * SW receive path uses Electron's `session.serviceWorkers.send()` and the
 * SW shim listens via both `globalThis.addEventListener('message')` and
 * `chrome.runtime.onMessage.addListener` to be resilient to whichever path
 * Electron 40 actually uses. The reverse (SW → main) path uses
 * `globalThis.postMessage` which Electron should surface as `ipc-message`
 * on `session.serviceWorkers`. Both paths are sensitive to Electron version
 * and may need verification — see tests/desktop/runtime-external.spec.ts.
 *
 * @module runtime-external
 * @see https://developer.chrome.com/docs/extensions/reference/api/runtime#method-sendMessage
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const IPC_SEND_FROM_PAGE = 'peek:runtime-external:send';
const SW_CHANNEL_INCOMING = 'peek:runtime-external:incoming';
const SW_CHANNEL_RESPONSE = 'peek:runtime-external:response';

/** Absolute path to the webview preload .cjs. Set by entry.ts via getPreloadPath(). */
export function getPreloadPath() {
  return path.join(__dirname, 'runtime-external-preload.cjs');
}

/**
 * Page-side MAIN-world polyfill source as a string. Returns the same
 * polyfill that the preload installs via webFrame.executeJavaScript at
 * preload time. Exported for re-injection on each `dom-ready` from main
 * (entry.ts), since sandboxed preloads run only once per webContents and
 * `<webview>` navigations within the same webContents lose the polyfill.
 *
 * Read from runtime-external-preload.cjs (single source of truth).
 *
 * @returns {string}
 */
import { readFileSync } from 'node:fs';
let _cachedPagePolyfillTemplate = null;
export function getPagePolyfillSource(extId = '') {
  if (_cachedPagePolyfillTemplate === null) {
    const preloadSrc = readFileSync(path.join(__dirname, 'runtime-external-preload.cjs'), 'utf-8');
    // Extract the PAGE_POLYFILL_SRC template literal. The preload defines it
    // as `const PAGE_POLYFILL_SRC = \`...\`;` — pull out exactly that block.
    const m = preloadSrc.match(/const PAGE_POLYFILL_SRC = `([\s\S]*?)`;/);
    if (!m) {
      throw new Error('runtime-external: cannot locate PAGE_POLYFILL_SRC in preload .cjs');
    }
    _cachedPagePolyfillTemplate = m[1];
  }
  return _cachedPagePolyfillTemplate.replace(/__PEEK_EXT_ID__/g, JSON.stringify(extId));
}

let _pendingByReqId = new Map();
let _seq = 0;
function _newReqId() {
  return `peek-rt-${Date.now()}-${++_seq}`;
}
const _attachedSwIpc = new Set();

/**
 * Register main-process handlers for the runtime-external bridge.
 *
 * @param {import('electron').Session} session — Electron session that has the extension(s) loaded
 * @param {Object} options
 * @param {import('electron').IpcMain} options.ipcMain
 * @param {(url: string) => string | null} [options.findExtensionByOrigin] — fallback resolver for when the requested extId doesn't match a running SW. Receives the request origin and returns an extension ID whose `externally_connectable.matches` accepts that origin (or null). Used to bridge the gap between the hardcoded Web Store IDs in pages like Proton's account bundle (which fans out to 4 platform-specific IDs) and the Electron-assigned runtime hash of our locally-unpacked extension.
 * @returns {{ cleanup: () => void }}
 */
export function setupMainProcess(session, options = {}) {
  const { ipcMain, findExtensionByOrigin } = options;
  if (!ipcMain) {
    throw new Error('chrome-api-polyfills/runtime-external: options.ipcMain is required');
  }

  // Receive page-side request from the webview preload.
  ipcMain.handle(IPC_SEND_FROM_PAGE, async (_event, payload) => {
    const { extId: requestedExtId, message, origin } = payload || {};
    console.log('[peek:runtime-external:main] IPC received extId=', requestedExtId, 'type=', message && message.type, 'origin=', origin);
    if (!requestedExtId || typeof requestedExtId !== 'string') {
      return { __peekRuntimeExternalError: 'missing extId' };
    }

    // Find target extension's BG SW versionId. Electron exposes
    // `session.serviceWorkers.getAllRunning()` which returns a map keyed by
    // versionId. Each entry's `scope` for an extension SW is
    // `chrome-extension://<extId>/`.
    const swInfos = (session.serviceWorkers?.getAllRunning?.() ?? {});
    const swSummary = Object.entries(swInfos).map(([v, i]) => `vid=${v} scope=${i?.scope}`).join(' ; ');
    console.log('[peek:runtime-external:main] running service workers:', swSummary || '(none)');
    function findVersionIdForExtId(eid) {
      for (const [vid, info] of Object.entries(swInfos)) {
        const scope = info?.scope ?? '';
        if (scope.startsWith(`chrome-extension://${eid}/`)) return Number(vid);
      }
      return null;
    }
    let targetVersionId = findVersionIdForExtId(requestedExtId);
    let extId = requestedExtId;
    if (targetVersionId == null && typeof findExtensionByOrigin === 'function' && origin) {
      // The requested extId didn't match. Pages like Proton's account bundle
      // fan out to multiple platform-specific Web Store IDs (Chrome, Edge,
      // Firefox, Safari) — none match our Electron-assigned runtime hash.
      // Resolve by origin instead: any extension whose
      // externally_connectable.matches accepts this origin is a valid target.
      try {
        const resolvedExtId = findExtensionByOrigin(origin);
        if (resolvedExtId) {
          const vid = findVersionIdForExtId(resolvedExtId);
          if (vid != null) {
            console.log('[peek:runtime-external:main] origin-fallback: requested extId=', requestedExtId, 'resolved to extId=', resolvedExtId, 'via origin=', origin);
            targetVersionId = vid;
            extId = resolvedExtId;
          }
        }
      } catch (e) {
        console.error('[peek:runtime-external:main] findExtensionByOrigin threw:', e?.message);
      }
    }
    if (targetVersionId == null) {
      console.error('[peek:runtime-external:main] no SW match for extId=', requestedExtId, '(origin fallback also failed)');
      return { __peekRuntimeExternalError: `no running service worker for extension ${requestedExtId}` };
    }

    const reqId = _newReqId();
    const sender = {
      id: extId,
      origin: origin ? safeOrigin(origin) : '',
      url: origin ?? '',
      tab: { id: -1 },
    };
    console.log('[peek:runtime-external:main] dispatching reqId=', reqId, 'to versionId=', targetVersionId);

    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (_pendingByReqId.has(reqId)) {
          _pendingByReqId.delete(reqId);
          console.error('[peek:runtime-external:main] BG response timeout reqId=', reqId);
          resolve({ __peekRuntimeExternalError: 'BG response timeout' });
        }
      }, 30_000);

      _pendingByReqId.set(reqId, (response) => {
        clearTimeout(timer);
        console.log('[peek:runtime-external:main] resolved reqId=', reqId);
        resolve(response);
      });

      try {
        // Electron 40: use ServiceWorkerMain.send via getWorkerFromVersionID
        // — there is no generic send() on the ServiceWorkers manager.
        const swMain = session.serviceWorkers.getWorkerFromVersionID?.(targetVersionId)
          ?? session.serviceWorkers.fromVersionID?.(targetVersionId);
        if (!swMain || typeof swMain.send !== 'function') {
          throw new Error('ServiceWorkerMain.send not available');
        }
        // Lazily attach the response listener on this swMain's ipc — first
        // dispatch to a given SW wires it up; subsequent dispatches reuse.
        if (!_attachedSwIpc.has(targetVersionId) && swMain.ipc?.on) {
          _attachedSwIpc.add(targetVersionId);
          swMain.ipc.on(SW_CHANNEL_RESPONSE, (_e, payload) => {
            const { reqId: rid, response, error } = payload || {};
            const pending = _pendingByReqId.get(rid);
            if (pending) {
              _pendingByReqId.delete(rid);
              pending(error ? { __peekRuntimeExternalError: error } : response);
            } else {
              console.error('[peek:runtime-external:main] response for unknown reqId=', rid);
            }
          });
          console.log('[peek:runtime-external:main] swMain.ipc listener attached for vid=', targetVersionId);
        }
        swMain.send(SW_CHANNEL_INCOMING, { reqId, message, sender });
        console.log('[peek:runtime-external:main] swMain.send dispatched reqId=', reqId);
      } catch (err) {
        _pendingByReqId.delete(reqId);
        clearTimeout(timer);
        console.error('[peek:runtime-external:main] swMain.send THREW reqId=', reqId, 'err=', err?.message);
        resolve({ __peekRuntimeExternalError: `swMain.send failed: ${err?.message ?? String(err)}` });
      }
    });
  });

  // SW → main reply path is wired up lazily via swMain.ipc.on inside the
  // dispatch path (see _attachedSwIpc above). Electron 40 doesn't fire a
  // generic 'ipc-message' event on the ServiceWorkers manager — IPC is
  // per-ServiceWorkerMain via its `ipc` IpcMainServiceWorker instance.

  return {
    cleanup() {
      try { ipcMain.removeHandler(IPC_SEND_FROM_PAGE); } catch { /* idempotent */ }
      _attachedSwIpc.clear();
      _pendingByReqId.clear();
    },
  };
}

function safeOrigin(href) {
  try { return new URL(href).origin; } catch { return ''; }
}

/**
 * JS source to inject into an extension's BG service worker. Wraps
 * onMessageExternal.addListener and handles inbound IPC from main, fanning
 * messages out to registered listeners and bridging sendResponse → main.
 *
 * Electron 40 wires SW IPC through `electron.ipcRenderer` (exposed in the
 * extension SW context as a global `electron` object — same surface used by
 * other chrome-api-polyfills like storage-session). swMain.send(channel,...)
 * arrives as `ipcRenderer.on(channel, ...)`; replies go back via
 * `ipcRenderer.send(channel, ...)` which surfaces on swMain.ipc.on(channel,...).
 *
 * @returns {string}
 */
export function getBgInjection() {
  return `
/* Peek: chrome.runtime.onMessageExternal polyfill — capture listeners and
 * dispatch from main-process IPC. See backend/electron/chrome-api-polyfills/
 * runtime-external.js. */
(function(){
  if (typeof chrome === 'undefined' || !chrome.runtime) return;
  var SW_CHANNEL_INCOMING = '${SW_CHANNEL_INCOMING}';
  var SW_CHANNEL_RESPONSE = '${SW_CHANNEL_RESPONSE}';
  console.log('[peek:runtime-external:bg] shim init extId=', chrome.runtime.id);

  // Resolve electron.ipcRenderer. Electron 40's extension SW context may
  // expose it through several paths depending on sandbox / contextIsolation
  // settings. Try them all.
  var _ipc = null;
  var _ipcSource = 'none';
  try {
    if (typeof electron !== 'undefined' && electron.ipcRenderer) { _ipc = electron.ipcRenderer; _ipcSource = 'global.electron'; }
  } catch(_) {}
  try {
    if (!_ipc && typeof globalThis !== 'undefined' && globalThis.electron && globalThis.electron.ipcRenderer) { _ipc = globalThis.electron.ipcRenderer; _ipcSource = 'globalThis.electron'; }
  } catch(_) {}
  try {
    if (!_ipc && typeof require === 'function') {
      var _e = require('electron');
      if (_e && _e.ipcRenderer) { _ipc = _e.ipcRenderer; _ipcSource = "require('electron')"; }
    }
  } catch(_) {}
  try {
    if (!_ipc && typeof require === 'function') {
      var _er = require('electron/renderer');
      if (_er && _er.ipcRenderer) { _ipc = _er.ipcRenderer; _ipcSource = "require('electron/renderer')"; }
    }
  } catch(_) {}
  console.log('[peek:runtime-external:bg] ipcRenderer source=', _ipcSource, 'available=', !!_ipc, 'electronGlobal=', typeof electron, 'globalThisElectron=', typeof (globalThis||{}).electron, 'require=', typeof require);
  if (!_ipc) {
    console.error('[peek:runtime-external:bg] electron.ipcRenderer unavailable on all probed paths — cross-origin sendMessage will fail');
  }

  var _externalListeners = [];
  try {
    var _ome = chrome.runtime.onMessageExternal;
    var _origAdd = _ome && _ome.addListener && _ome.addListener.bind(_ome);
    function _wrapListener(fn) {
      return function(message, sender, sendResponse) {
        try {
          var typeStr = message && message.type ? String(message.type) : '(no-type)';
          var senderUrl = sender && (sender.url || sender.origin) || '(no-sender-url)';
          console.log('[peek:runtime-external:bg] LISTENER FIRED via NATIVE dispatch — type=', typeStr, 'sender=', senderUrl);
        } catch(_) {}
        var ret;
        try { ret = fn(message, sender, sendResponse); }
        catch(e) {
          console.error('[peek:runtime-external:bg] listener threw on native dispatch:', e && e.message);
          throw e;
        }
        if (ret && typeof ret.then === 'function') {
          ret.then(function(v) { console.log('[peek:runtime-external:bg] listener (native) resolved'); },
                   function(e) { console.error('[peek:runtime-external:bg] listener (native) rejected:', e && e.message); });
        }
        return ret;
      };
    }
    if (_origAdd) {
      _ome.addListener = function(fn) {
        var wrapped = _wrapListener(fn);
        _externalListeners.push(fn); // store the original for our IPC dispatch path
        console.log('[peek:runtime-external:bg] onMessageExternal listener captured (wrap), total=', _externalListeners.length);
        try { _origAdd(wrapped); } catch(_) {}
      };
    } else {
      chrome.runtime.onMessageExternal = {
        addListener: function(fn) {
          _externalListeners.push(fn);
          console.log('[peek:runtime-external:bg] onMessageExternal listener captured (stub), total=', _externalListeners.length);
        },
        removeListener: function(fn) { _externalListeners = _externalListeners.filter(function(x){ return x !== fn; }); },
        hasListener: function(fn) { return _externalListeners.indexOf(fn) !== -1; },
        hasListeners: function() { return _externalListeners.length > 0; },
      };
    }
  } catch(e) { console.error('[peek:runtime-external:bg] addListener wrap failed:', e && e.message); }

  function _sendBack(payload) {
    if (!_ipc) {
      console.error('[peek:runtime-external:bg] no SW→main IPC path; response dropped reqId=', payload && payload.reqId);
      return;
    }
    try {
      _ipc.send(SW_CHANNEL_RESPONSE, payload);
      console.log('[peek:runtime-external:bg] _sendBack via ipcRenderer.send reqId=', payload && payload.reqId);
    } catch(e) { console.error('[peek:runtime-external:bg] ipcRenderer.send threw:', e && e.message); }
  }

  function _dispatch(payload) {
    var reqId = payload && payload.reqId;
    var fwdMessage = payload && payload.message;
    var fwdSender = (payload && payload.sender) || {};
    fwdSender.id = chrome.runtime.id;
    console.log('[peek:runtime-external:bg] dispatch reqId=', reqId, 'listeners=', _externalListeners.length, 'type=', fwdMessage && fwdMessage.type);

    if (_externalListeners.length === 0) {
      _sendBack({ reqId: reqId, error: 'no onMessageExternal listeners registered' });
      return;
    }
    var responded = false;
    function respond(response) {
      if (responded) return;
      responded = true;
      console.log('[peek:runtime-external:bg] listener responded reqId=', reqId);
      _sendBack({ reqId: reqId, response: response });
    }
    for (var i = 0; i < _externalListeners.length; i++) {
      try {
        var ret = _externalListeners[i](fwdMessage, fwdSender, respond);
        // Chrome semantics: returning true OR a Promise keeps the channel
        // open for async sendResponse. If it's a Promise, await it.
        if (ret && typeof ret.then === 'function') {
          (function() {
            ret.then(function(r) { respond(r); }, function(e) {
              if (!responded) {
                responded = true;
                _sendBack({ reqId: reqId, error: (e && e.message) || String(e) });
              }
            });
          })();
        }
      } catch(e) {
        if (!responded) {
          responded = true;
          console.error('[peek:runtime-external:bg] listener THREW reqId=', reqId, 'err=', e && e.message);
          _sendBack({ reqId: reqId, error: (e && e.message) || String(e) });
        }
      }
    }
  }

  // Listen for incoming dispatches from main.
  if (_ipc) {
    _ipc.on(SW_CHANNEL_INCOMING, function(_event, payload) { _dispatch(payload); });
    console.log('[peek:runtime-external:bg] ipcRenderer.on(' + SW_CHANNEL_INCOMING + ') installed');
    // Startup heartbeat: announces shim is alive on a debug channel. Main
    // listens via swMain.ipc.on('peek:bg-heartbeat') — if it fires, the
    // shim is executing and ipcRenderer.send works. If it doesn't, either
    // the shim never ran or electron.ipcRenderer is unavailable.
    // Send periodically to defeat the startup race: tracer's listener is
    // wired up only on 'running-status-changed' → 'running', which fires
    // AFTER the SW global has begun executing. A single startup beat
    // would always be lost.
    var _hbCount = 0;
    function _heartbeat() {
      try { _ipc.send('peek:bg-heartbeat', { extId: chrome.runtime.id, hasIpcRenderer: true, t: Date.now(), n: ++_hbCount }); } catch(e) {}
    }
    _heartbeat();
    setTimeout(_heartbeat, 100);
    setTimeout(_heartbeat, 500);
    setTimeout(_heartbeat, 1500);
  } else {
    // No ipcRenderer — try chrome.storage.local as a fallback signal.
    try {
      if (chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({
          __peekRuntimeExternalBgShim: { extId: chrome.runtime.id, t: Date.now(), hasIpcRenderer: false },
        });
      }
    } catch(e) {}
  }
})();
`;
}
