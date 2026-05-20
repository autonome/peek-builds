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
      if (cb) { p.catch(function(e){ try { window.chrome.runtime.lastError = { message: e.message }; cb(undefined); } catch(_){} }); }
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
      p.then(function(r){ try { callback(r); } catch(_){} },
             function(e){ try { window.chrome.runtime.lastError = { message: e.message }; callback(undefined); } catch(_){} });
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
    _redactSendMessage(window.chrome.runtime);
    _setExtId(window.chrome.runtime);
    console.log('[peek:runtime-external:page] forced Path B: chrome.runtime.sendMessage redacted, id set, native otherwise preserved');
  }
  // If window.chrome.runtime isn't there yet, do nothing. Replacing it with a
  // synthetic object races Chromium's native_extension_bindings_system trying
  // to install its own APIs and surfaces as
  // "ERROR:extensions/renderer/native_extension_bindings_system.cc:712
  //  Failed to create API on Chrome object." The redact branch above is the
  //  only path we need — Chromium will create chrome.runtime natively when
  //  the page actually qualifies.

  if (window.browser && window.browser.runtime) {
    _redactSendMessage(window.browser.runtime);
    _setExtId(window.browser.runtime);
    console.log('[peek:runtime-external:page] browser.runtime sendMessage also redacted');
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
