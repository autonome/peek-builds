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

/**
 * Register main-process handlers for the runtime-external bridge.
 *
 * @param {import('electron').Session} session — Electron session that has the extension(s) loaded
 * @param {Object} options
 * @param {import('electron').IpcMain} options.ipcMain
 * @returns {{ cleanup: () => void }}
 */
export function setupMainProcess(session, options = {}) {
  const { ipcMain } = options;
  if (!ipcMain) {
    throw new Error('chrome-api-polyfills/runtime-external: options.ipcMain is required');
  }

  // Receive page-side request from the webview preload.
  ipcMain.handle(IPC_SEND_FROM_PAGE, async (_event, payload) => {
    const { extId, message, origin } = payload || {};
    console.log('[peek:runtime-external:main] IPC received extId=', extId, 'type=', message && message.type, 'origin=', origin);
    if (!extId || typeof extId !== 'string') {
      return { __peekRuntimeExternalError: 'missing extId' };
    }

    // Find target extension's BG SW versionId. Electron exposes
    // `session.serviceWorkers.getAllRunning()` which returns a map keyed by
    // versionId. Each entry's `scope` for an extension SW is
    // `chrome-extension://<extId>/`.
    const swInfos = (session.serviceWorkers?.getAllRunning?.() ?? {});
    const swSummary = Object.entries(swInfos).map(([v, i]) => `vid=${v} scope=${i?.scope}`).join(' ; ');
    console.log('[peek:runtime-external:main] running service workers:', swSummary || '(none)');
    let targetVersionId = null;
    for (const [vid, info] of Object.entries(swInfos)) {
      const scope = info?.scope ?? '';
      if (scope.startsWith(`chrome-extension://${extId}/`)) {
        targetVersionId = Number(vid);
        break;
      }
    }
    if (targetVersionId == null) {
      console.error('[peek:runtime-external:main] no SW match for extId=', extId);
      return { __peekRuntimeExternalError: `no running service worker for extension ${extId}` };
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
        session.serviceWorkers.send(targetVersionId, SW_CHANNEL_INCOMING, { reqId, message, sender });
        console.log('[peek:runtime-external:main] serviceWorkers.send dispatched reqId=', reqId);
      } catch (err) {
        _pendingByReqId.delete(reqId);
        clearTimeout(timer);
        console.error('[peek:runtime-external:main] serviceWorkers.send THREW reqId=', reqId, 'err=', err?.message);
        resolve({ __peekRuntimeExternalError: `serviceWorkers.send failed: ${err?.message ?? String(err)}` });
      }
    });
  });

  // SW → main reply path. The BG SW's shim posts via globalThis.postMessage
  // which Electron emits as 'ipc-message' on session.serviceWorkers. The
  // exact event shape is Electron-version-sensitive — the listener below
  // tries the most common forms.
  const onIpcMessage = (event, ...rest) => {
    // Electron 40: (event, channel, ...args)
    // Older / different shape: (event, payload)
    let channel, args;
    if (typeof rest[0] === 'string') {
      channel = rest[0];
      args = rest.slice(1);
    } else if (event && typeof event.channel === 'string') {
      channel = event.channel;
      args = [event.payload];
    } else {
      console.log('[peek:runtime-external:main] ipc-message unrecognized shape; rest=', JSON.stringify(rest).slice(0, 200));
      return;
    }
    console.log('[peek:runtime-external:main] ipc-message channel=', channel);
    if (channel !== SW_CHANNEL_RESPONSE) return;
    const [{ reqId, response, error } = {}] = args;
    const pending = _pendingByReqId.get(reqId);
    if (pending) {
      _pendingByReqId.delete(reqId);
      pending(error ? { __peekRuntimeExternalError: error } : response);
    } else {
      console.error('[peek:runtime-external:main] response for unknown reqId=', reqId);
    }
  };
  if (typeof session.serviceWorkers?.on === 'function') {
    session.serviceWorkers.on('ipc-message', onIpcMessage);
  }

  return {
    cleanup() {
      try { ipcMain.removeHandler(IPC_SEND_FROM_PAGE); } catch { /* idempotent */ }
      try { session.serviceWorkers?.off?.('ipc-message', onIpcMessage); } catch { /* idempotent */ }
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
 * Receive paths tried (Electron-version-resilient):
 *   - globalThis 'message' events (Electron's serviceWorkers.send arrives
 *     as a postMessage on the SW global)
 *   - chrome.runtime.onMessage (in case Electron wraps serviceWorkers.send
 *     into a runtime message)
 *
 * Reply path:
 *   - globalThis.postMessage({ __peekIpcChannel, payload }) — Electron emits
 *     this as 'ipc-message' on session.serviceWorkers in main.
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

  var _externalListeners = [];
  try {
    var _ome = chrome.runtime.onMessageExternal;
    var _origAdd = _ome && _ome.addListener && _ome.addListener.bind(_ome);
    if (_origAdd) {
      _ome.addListener = function(fn) {
        _externalListeners.push(fn);
        console.log('[peek:runtime-external:bg] onMessageExternal listener captured (wrap), total=', _externalListeners.length);
        try { _origAdd(fn); } catch(_) {}
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
    try {
      if (typeof globalThis.postMessage === 'function') {
        globalThis.postMessage({ __peekIpcChannel: SW_CHANNEL_RESPONSE, payload: payload });
        console.log('[peek:runtime-external:bg] _sendBack via globalThis.postMessage reqId=', payload && payload.reqId);
        return;
      }
    } catch(e) { console.error('[peek:runtime-external:bg] globalThis.postMessage threw:', e && e.message); }
    console.error('[peek:runtime-external:bg] no SW→main IPC path; response dropped reqId=', payload && payload.reqId);
  }

  function _dispatch(envelope, viaPath) {
    if (!envelope || envelope.__peekIpcChannel !== SW_CHANNEL_INCOMING) return false;
    var payload = envelope.payload || {};
    var reqId = payload.reqId;
    var fwdMessage = payload.message;
    var fwdSender = payload.sender || {};
    fwdSender.id = chrome.runtime.id;
    console.log('[peek:runtime-external:bg] dispatch via=', viaPath, 'reqId=', reqId, 'listeners=', _externalListeners.length, 'type=', fwdMessage && fwdMessage.type);

    if (_externalListeners.length === 0) {
      _sendBack({ reqId: reqId, error: 'no onMessageExternal listeners registered' });
      return true;
    }
    var responded = false;
    function respond(response) {
      if (responded) return;
      responded = true;
      console.log('[peek:runtime-external:bg] listener responded reqId=', reqId);
      _sendBack({ reqId: reqId, response: response });
    }
    for (var i = 0; i < _externalListeners.length; i++) {
      try { _externalListeners[i](fwdMessage, fwdSender, respond); }
      catch(e) {
        if (!responded) {
          responded = true;
          console.error('[peek:runtime-external:bg] listener THREW reqId=', reqId, 'err=', e && e.message);
          _sendBack({ reqId: reqId, error: (e && e.message) || String(e) });
        }
      }
    }
    return true;
  }

  // Receive path 1: globalThis postMessage
  try {
    if (typeof globalThis.addEventListener === 'function') {
      globalThis.addEventListener('message', function(ev) { _dispatch(ev && ev.data, 'globalThis-message'); }, false);
      console.log('[peek:runtime-external:bg] globalThis message listener installed');
    }
  } catch(e) { console.error('[peek:runtime-external:bg] globalThis listener install failed:', e && e.message); }
  // Receive path 2: chrome.runtime.onMessage
  try {
    chrome.runtime.onMessage.addListener(function(message) {
      _dispatch(message, 'chrome.runtime.onMessage');
      return false;
    });
    console.log('[peek:runtime-external:bg] chrome.runtime.onMessage listener installed');
  } catch(e) { console.error('[peek:runtime-external:bg] chrome.runtime.onMessage install failed:', e && e.message); }
})();
`;
}
