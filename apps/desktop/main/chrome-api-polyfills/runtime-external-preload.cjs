/**
 * Webview preload for the chrome.runtime.sendMessage cross-origin polyfill.
 *
 * Used as `webPreferences.preload` for webviews navigating to URLs that
 * match a loaded extension's externally_connectable.matches.
 *
 * Two responsibilities:
 *   1. Inject a MAIN-world chrome.runtime.sendMessage polyfill via
 *      webFrame.executeJavaScript so the page's own scripts can call it.
 *   2. Listen for window.postMessage requests from the MAIN-world polyfill
 *      (since MAIN world has no ipcRenderer) and forward them via
 *      ipcRenderer.invoke('peek:runtime-external:send').
 *
 * Companion module: ../chrome-api-polyfills/runtime-external.js
 *   - setupMainProcess() — IPC handler + BG SW dispatch
 *   - getBgInjection()   — JS to inject into the extension's BG SW so it
 *                          fan-fires onMessageExternal listeners
 *
 * CJS because Electron preloads run in a sandboxed CJS context. Keep this
 * file self-contained — it cannot import from ESM siblings at preload time.
 */
'use strict';

const { ipcRenderer, webFrame } = require('electron');

const IPC_SEND_FROM_PAGE = 'peek:runtime-external:send';
const IPC_CS_RELAY_FROM_PAGE = 'peek:cs-relay:from-page';
const IPC_CS_RELAY_TO_PAGE = 'peek:cs-relay:to-page';

console.log('[peek:runtime-external:preload] loaded for', location.href);

/**
 * MAIN-world polyfill source. Installed via webFrame.executeJavaScript so
 * page scripts (in the page's main JS world) can call chrome.runtime.sendMessage.
 * Talks back to this preload via window.postMessage.
 */
const PAGE_POLYFILL_SRC = `(function(){
  console.log('[peek:runtime-external:page] MAIN-world polyfill installing on', location.href, 'preExisting=', !!(window.chrome && window.chrome.runtime && window.chrome.runtime.sendMessage));
  var _seq = 0;
  function _newReqId() { return 'peek-rt-' + (++_seq) + '-' + Math.random().toString(36).slice(2, 8); }

  function _emptyEvent() {
    var l = [];
    return {
      addListener: function(fn) { l.push(fn); },
      removeListener: function(fn) { l = l.filter(function(x){ return x !== fn; }); },
      hasListener: function(fn) { return l.indexOf(fn) !== -1; },
      hasListeners: function() { return l.length > 0; },
    };
  }

  // Invoke a sendMessage callback with chrome.runtime.lastError scoped to just
  // this invocation. Chrome sets lastError per-callback (only visible inside the
  // callback synchronously) — our polyfill must match, otherwise concurrent
  // sendMessage calls leak each other's errors. Proton fans out to 4 platform
  // ext IDs; 3 reject ("Receiving end does not exist"), 1 succeeds — without
  // per-callback scoping, the successful callback sees a leftover lastError and
  // treats success as failure.
  function _invokeCb(callback, response, errMsg) {
    var rt = window.chrome && window.chrome.runtime;
    if (rt) { try { rt.lastError = errMsg ? { message: errMsg } : undefined; } catch(_){} }
    try { callback(response); } catch(_){}
    if (rt) { try { rt.lastError = undefined; } catch(_){} }
  }

  var _sendMessage = function(extIdOrMessage, messageOrCb, optsOrCb, maybeCb) {
    var extId, message, callback;
    if (typeof extIdOrMessage === 'string') {
      extId = extIdOrMessage;
      message = messageOrCb;
      callback = (typeof optsOrCb === 'function') ? optsOrCb : (typeof maybeCb === 'function' ? maybeCb : undefined);
    } else {
      // Self-message form (no extId) — page targets its own extension.
      // Not the externally_connectable cross-origin path; reject so callers
      // don't silently get nothing back.
      console.log('[peek:runtime-external:page] sendMessage rejected: extId not a string (typeof=', typeof extIdOrMessage, ')');
      var p = Promise.reject(new Error('Peek runtime bridge: extensionId required for cross-origin sendMessage'));
      var cb = (typeof messageOrCb === 'function') ? messageOrCb : (typeof optsOrCb === 'function' ? optsOrCb : undefined);
      if (cb) { p.catch(function(e){ _invokeCb(cb, undefined, e.message); }); }
      return p;
    }

    var reqId = _newReqId();
    console.log('[peek:runtime-external:page] sendMessage called reqId=', reqId, 'extId=', extId, 'type=', message && message.type);
    var p = new Promise(function(resolve, reject) {
      var timer = setTimeout(function() {
        window.removeEventListener('message', onMsg, true);
        reject(new Error('Peek runtime bridge: timeout'));
      }, 30000);
      function onMsg(ev) {
        if (ev.source !== window) return;
        var d = ev.data;
        if (!d || d.__peekRuntimeExternal !== 'response' || d.reqId !== reqId) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg, true);
        if (d.error) reject(new Error(d.error));
        else resolve(d.response);
      }
      window.addEventListener('message', onMsg, true);
      window.postMessage({
        __peekRuntimeExternal: 'request',
        reqId: reqId,
        extId: extId,
        message: message,
        origin: location.href,
      }, location.origin);
    });
    if (callback) {
      p.then(function(r){ _invokeCb(callback, r, null); },
             function(e){ _invokeCb(callback, undefined, e.message); });
    }
    return p;
  };

  var _rt = {
    id: __PEEK_EXT_ID__,
    sendMessage: _sendMessage,
    onMessage: _emptyEvent(),
    onConnect: _emptyEvent(),
    connect: function() { throw new Error('chrome.runtime.connect not implemented in Peek bridge'); },
    lastError: undefined,
    getURL: function(p) { return 'chrome-extension://' + __PEEK_EXT_ID__ + (p && p.startsWith('/') ? p : '/' + (p || '')); },
    getManifest: function() { return { manifest_version: 3 }; },
  };

  if (!window.chrome) window.chrome = {};

  // Strategy: don't try to bridge cross-origin sendMessage ourselves —
  // Electron 40's SW context has no electron.ipcRenderer, so a main-process
  // bridge can't deliver messages back into the BG SW. Instead, force
  // Proton's webextension-polyfill-style sender (module 57118) to fall back
  // to its postMessage path, which routes through Proton Pass's own
  // \`orchestrator.js\` content script — that script uses
  // chrome.runtime.sendMessage (same-extension), which Electron handles
  // natively. We remove sendMessage from chrome.runtime; module 57118's
  // branch \`Rw.runtime.sendMessage !== void 0\` becomes false, taking
  // Path B. We KEEP chrome.runtime.id, getURL, getManifest, etc. since
  // Proton reads those at module init.
  function _redactSendMessage(rt) {
    if (!rt) return;
    try { Object.defineProperty(rt, 'sendMessage', { value: undefined, configurable: true, writable: true, enumerable: true }); }
    catch (e) {
      try { rt.sendMessage = undefined; } catch (_) {}
    }
  }

  // Set extension id on native chrome.runtime so callers reading
  // chrome.runtime.id get the correct hash; native exposes id=null otherwise.
  function _setExtId(rt) {
    try { Object.defineProperty(rt, 'id', { value: __PEEK_EXT_ID__, configurable: true, writable: true, enumerable: true }); }
    catch (e) { try { rt.id = __PEEK_EXT_ID__; } catch (_) {} }
  }

  if (window.chrome.runtime) {
    // Install the bridge-routed sendMessage shim (Path C). Replaces both the
    // original Path A (synthetic chrome.runtime object) and Path B (redact +
    // postMessage-via-orchestrator fallback). _sendMessage posts a request to
    // the preload bridge, which invokes main-process IPC, which routes through
    // the hidden bridge window's chrome.runtime.Port to the BG SW's
    // onMessageExternal listeners.
    try {
      Object.defineProperty(window.chrome.runtime, 'sendMessage', {
        value: _sendMessage, configurable: true, writable: true, enumerable: true,
      });
    } catch (e) {
      try { window.chrome.runtime.sendMessage = _sendMessage; } catch (_) {}
    }
    _setExtId(window.chrome.runtime);
    console.log('[peek:runtime-external:page] Path C: chrome.runtime.sendMessage routed through main-process bridge, id set');
  }
  // If window.chrome.runtime isn't there yet, do nothing. Replacing it with a
  // synthetic object races Chromium's native_extension_bindings_system trying
  // to install its own APIs and surfaces as
  // "ERROR:extensions/renderer/native_extension_bindings_system.cc:712
  //  Failed to create API on Chrome object." The redact branch above is the
  //  only path we need — Chromium will create chrome.runtime natively when
  //  the page actually qualifies.

  if (window.browser && window.browser.runtime) {
    // Same Path C treatment for the webextension-polyfill browser.runtime alias.
    try {
      Object.defineProperty(window.browser.runtime, 'sendMessage', {
        value: _sendMessage, configurable: true, writable: true, enumerable: true,
      });
    } catch (e) {
      try { window.browser.runtime.sendMessage = _sendMessage; } catch (_) {}
    }
    _setExtId(window.browser.runtime);
    console.log('[peek:runtime-external:page] Path C: browser.runtime.sendMessage routed through main-process bridge');
  }
})();`;

// Resolve the extension ID from additionalArguments injected by entry.ts in
// will-attach-webview. Without this, chrome.runtime.id is undefined and
// callers like Proton's `sendMessage(chrome.runtime.id, msg)` end up passing
// undefined as the first arg — our polyfill then falls into the "self-message"
// rejection path silently.
const _extIdArg = (process.argv || []).find(a => typeof a === 'string' && a.startsWith('--peek-runtime-external-ext-id='));
const _extId = _extIdArg ? _extIdArg.slice('--peek-runtime-external-ext-id='.length) : '';
const PAGE_POLYFILL_SRC_RESOLVED = PAGE_POLYFILL_SRC.replace(/__PEEK_EXT_ID__/g, JSON.stringify(_extId));

try {
  // Inject the polyfill into the page's MAIN world. webFrame.executeJavaScript
  // runs synchronously in MAIN world during preload, before page scripts run,
  // so chrome.runtime.sendMessage is defined when the page boots.
  webFrame.executeJavaScript(PAGE_POLYFILL_SRC_RESOLVED, false);
  console.log('[peek:runtime-external:preload] MAIN-world polyfill injected, extId=', _extId || '(missing)');
} catch (err) {
  console.error('[peek:runtime-external:preload] failed to inject MAIN-world polyfill:', err && err.message);
}

// Bridge MAIN-world postMessage requests → main-process IPC → response back.
window.addEventListener('message', function (ev) {
  if (ev.source !== window) return;
  const d = ev.data;
  if (!d || d.__peekRuntimeExternal !== 'request') return;
  const { reqId, extId, message, origin } = d;
  console.log('[peek:runtime-external:preload] req reqId=', reqId, 'extId=', extId, 'type=', message && message.type);
  ipcRenderer.invoke(IPC_SEND_FROM_PAGE, { extId, message, origin })
    .then(function (response) {
      if (response && response.__peekRuntimeExternalError) {
        console.error('[peek:runtime-external:preload] resp ERROR reqId=', reqId, 'err=', response.__peekRuntimeExternalError);
        window.postMessage({ __peekRuntimeExternal: 'response', reqId, error: response.__peekRuntimeExternalError }, location.origin);
      } else {
        console.log('[peek:runtime-external:preload] resp ok reqId=', reqId, 'response=', JSON.stringify(response).slice(0, 120));
        window.postMessage({ __peekRuntimeExternal: 'response', reqId, response }, location.origin);
      }
    })
    .catch(function (err) {
      console.error('[peek:runtime-external:preload] ipc THREW reqId=', reqId, 'err=', err && err.message);
      window.postMessage({ __peekRuntimeExternal: 'response', reqId, error: (err && err.message) || String(err) }, location.origin);
    });
}, true);

// === Content-script relay: page postMessage ⇄ extension bridge window ===
//
// Pages whose URL matches an extension's ISOLATED-world content_scripts can't
// host those scripts directly (Electron doesn't give us isolated worlds with
// the extension's chrome.runtime). Instead, the bridge BrowserWindow hosts
// them as singleton listeners. The preload's job is to ferry window.postMessage
// events across that boundary.
//
// Enabled via additionalArgument: --peek-cs-relay-enabled
//
// page postMessage → here → main (which routes to the matching bridge window) →
//   content scripts run in bridge → they postMessage a response → bridge IPCs
//   back → main → here → we dispatch as window.postMessage on this page.
//
// Loop avoidance: we hash dispatched events and skip matching incoming events
// for a short TTL.
const _csRelayEnabled = (process.argv || []).some(function (a) {
  return a === '--peek-cs-relay-enabled';
});
if (_csRelayEnabled) {
  console.log('[peek:cs-relay:preload] enabled for', location.href);

  const _justDispatched = new Set();
  const _LOOP_TTL_MS = 100;
  function _hash(d) { try { return JSON.stringify(d); } catch (_) { return null; } }

  // Page → main. Skip events that are clearly internal protocol surface.
  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    const d = ev.data;
    if (d && typeof d === 'object') {
      // Skip our own protocol envelopes.
      if (d.__peekRuntimeExternal) return;
    }
    // Skip events we just dispatched (loop avoidance).
    const h = _hash(d);
    if (h && _justDispatched.has(h)) { _justDispatched.delete(h); return; }
    // Only relay object-shaped data. Skip strings/numbers/transferables —
    // those are typically iframe protocols / analytics, not content-script
    // message channels.
    if (typeof d !== 'object' || d === null) return;
    try {
      ipcRenderer.send(IPC_CS_RELAY_FROM_PAGE, { data: d, origin: location.origin });
    } catch (err) {
      console.error('[peek:cs-relay:preload] forward threw:', err && err.message);
    }
  }, false);

  // Main → page. Tag dispatched event for loop avoidance, then postMessage.
  ipcRenderer.on(IPC_CS_RELAY_TO_PAGE, function (_event, payload) {
    const data = payload && payload.data;
    if (data === undefined) return;
    const h = _hash(data);
    if (h) {
      _justDispatched.add(h);
      setTimeout(function () { _justDispatched.delete(h); }, _LOOP_TTL_MS);
    }
    try {
      window.postMessage(data, location.origin);
    } catch (err) {
      console.error('[peek:cs-relay:preload] dispatch to page threw:', err && err.message);
    }
  });
}
