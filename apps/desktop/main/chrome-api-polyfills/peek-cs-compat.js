/* peek-cs-compat.js — ISOLATED-world chrome.runtime.sendMessage shim.
 *
 * Electron's native content script sendMessage from webview guests silently
 * fails to reach the BG SW. This shim wraps sendMessage to relay via
 * window.postMessage → preload bridge → IPC → main → bridge → BG SW.
 *
 * Installed via patch-chrome-extensions.js into the extension manifest
 * as a content_script at document_start (before orchestrator.js).
 * Reuses the __peekRuntimeExternal postMessage protocol that the preload
 * (runtime-external-preload.cjs) already handles.
 */
(function () {
  'use strict';

  if (typeof chrome === 'undefined' || !chrome.runtime) return;
  if (!chrome.runtime.id) return;

  var _ownExtId = chrome.runtime.id;
  var _seq = 0;

  function _newReqId() {
    return 'peek-cs-' + (++_seq) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function _shimmedSendMessage(extIdOrMessage, messageOrCb, optsOrCb, maybeCb) {
    var extId, message, callback, internal;

    if (typeof extIdOrMessage === 'string') {
      extId = extIdOrMessage;
      message = messageOrCb;
      callback = (typeof optsOrCb === 'function') ? optsOrCb
        : (typeof maybeCb === 'function' ? maybeCb : undefined);
      internal = (extId === _ownExtId);
    } else {
      extId = _ownExtId;
      message = extIdOrMessage;
      callback = (typeof messageOrCb === 'function') ? messageOrCb
        : (typeof optsOrCb === 'function' ? optsOrCb : undefined);
      internal = true;
    }

    var reqId = _newReqId();
    console.log('[peek:cs-compat] sendMessage reqId=' + reqId + ' extId=' + extId + ' internal=' + internal + ' type=' + (message && message.type));

    var p = new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        window.removeEventListener('message', onMsg, true);
        reject(new Error('Peek cs-compat: sendMessage timeout'));
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
        internal: internal,
      }, '*');
    });

    if (callback) {
      p.then(
        function (r) {
          try { chrome.runtime.lastError = undefined; } catch (_) {}
          try { callback(r); } catch (_) {}
        },
        function (e) {
          try { chrome.runtime.lastError = { message: e.message }; } catch (_) {}
          try { callback(undefined); } catch (_) {}
          try { chrome.runtime.lastError = undefined; } catch (_) {}
        }
      );
    }

    return p;
  }

  try {
    Object.defineProperty(chrome.runtime, 'sendMessage', {
      value: _shimmedSendMessage,
      configurable: true,
      writable: true,
      enumerable: true,
    });
  } catch (e) {
    try { chrome.runtime.sendMessage = _shimmedSendMessage; } catch (_) {}
  }

  console.log('[peek:cs-compat] ISOLATED-world sendMessage shim installed, extId=' + _ownExtId);
})();
