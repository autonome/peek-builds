/* peek-bridge.js — extracted from peek-bridge.html to satisfy MV3 CSP
 * (`script-src 'self'`). See peek-bridge.html for the architecture comment.
 */
(function () {
  'use strict';

  var PORT_NAME = 'peek-auth-relay';
  var RECONNECT_DELAY_MS = 1000;
  var MAX_RECONNECT_ATTEMPTS = 10;

  var _port = null;
  var _reconnectAttempts = 0;
  var _pendingByReqId = {};

  function log() {
    var args = Array.prototype.slice.call(arguments);
    try {
      if (window.peekBridge && window.peekBridge.log) {
        window.peekBridge.log.apply(null, args);
      } else {
        console.error.apply(console, ['[peek:bridge:page]'].concat(args));
      }
    } catch (_) {}
  }

  function connect() {
    try {
      _port = chrome.runtime.connect({ name: PORT_NAME });
      _reconnectAttempts = 0;
      log('chrome.runtime.connect() opened port name=', PORT_NAME, 'extId=', chrome.runtime.id);

      _port.onMessage.addListener(function (msg) {
        // Handle scripting relay requests from the BG SW
        if (msg && msg.type === 'peek:scripting') {
          log('port.onMessage: scripting relay reqId=', msg.reqId, 'channel=', msg.channel);
          if (window.peekBridge && window.peekBridge.invokeScripting) {
            window.peekBridge.invokeScripting(msg.channel, msg.params).then(function (result) {
              try { _port.postMessage({ type: 'peek:scripting:response', reqId: msg.reqId, result: result }); } catch (e) {
                log('scripting response postMessage threw:', e && e.message);
              }
            }).catch(function (err) {
              try { _port.postMessage({ type: 'peek:scripting:response', reqId: msg.reqId, error: (err && err.message) || String(err) }); } catch (e) {
                log('scripting error response postMessage threw:', e && e.message);
              }
            });
          } else {
            try { _port.postMessage({ type: 'peek:scripting:response', reqId: msg.reqId, error: 'peekBridge.invokeScripting not available' }); } catch (_) {}
          }
          return;
        }

        log('port.onMessage reqId=', msg && msg.reqId, 'type=', msg && msg.type);
        var reqId = msg && msg.reqId;
        var pending = reqId && _pendingByReqId[reqId];
        if (pending) {
          delete _pendingByReqId[reqId];
          pending.sendResponse(msg && msg.response !== undefined ? msg.response : msg);
        } else {
          log('port.onMessage: no pending reqId=', reqId, '(unsolicited or already resolved)');
        }
      });

      _port.onDisconnect.addListener(function () {
        var err = chrome.runtime.lastError;
        log('port disconnected:', err && err.message || '(no error)');
        _port = null;
        // Reject any in-flight requests whose port just dropped.
        var pendingIds = Object.keys(_pendingByReqId);
        for (var i = 0; i < pendingIds.length; i++) {
          var p = _pendingByReqId[pendingIds[i]];
          if (p && p.sendResponse) {
            try { p.sendResponse({ __peekBridgeError: 'port disconnected' }); } catch (_) {}
          }
          delete _pendingByReqId[pendingIds[i]];
        }
        // Attempt reconnect with backoff.
        scheduleReconnect();
      });

      return true;
    } catch (err) {
      log('chrome.runtime.connect() threw:', err && err.message);
      _port = null;
      return false;
    }
  }

  function scheduleReconnect() {
    if (_reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log('max reconnect attempts reached — bridge port permanently unavailable');
      return;
    }
    _reconnectAttempts++;
    var delay = RECONNECT_DELAY_MS * _reconnectAttempts;
    log('scheduling reconnect attempt', _reconnectAttempts, 'in', delay, 'ms');
    setTimeout(function () {
      log('reconnect attempt', _reconnectAttempts);
      connect();
    }, delay);
  }

  function ensurePort() {
    if (_port) return true;
    return connect();
  }

  function onForward(payload, sendResponse) {
    var reqId = payload && payload.reqId;
    log('onForward reqId=', reqId, 'type=', payload && payload.message && payload.message.type);

    if (!ensurePort()) {
      sendResponse({ __peekBridgeError: 'bridge port not available' });
      return;
    }

    // Track the pending request so port.onMessage can resolve it.
    _pendingByReqId[reqId] = { sendResponse: sendResponse };

    // Set a local timeout to clean up if the BG SW never responds.
    var timer = setTimeout(function () {
      if (_pendingByReqId[reqId]) {
        delete _pendingByReqId[reqId];
        log('timeout waiting for BG SW response reqId=', reqId);
        sendResponse({ __peekBridgeError: 'BG SW response timeout (bridge)' });
      }
    }, 28000); // slightly under the 30s main-process timeout

    // Override sendResponse to also clear the timer.
    var originalSendResponse = sendResponse;
    _pendingByReqId[reqId] = {
      sendResponse: function (r) {
        clearTimeout(timer);
        originalSendResponse(r);
      },
    };

    // Forward the message through the port to the BG SW.
    try {
      _port.postMessage({
        reqId: reqId,
        message: payload && payload.message,
        sender: payload && payload.sender,
        internal: !!(payload && payload.internal),
      });
      log('port.postMessage dispatched reqId=', reqId, 'internal=', !!(payload && payload.internal));
    } catch (err) {
      delete _pendingByReqId[reqId];
      clearTimeout(timer);
      log('port.postMessage threw reqId=', reqId, 'err=', err && err.message);
      sendResponse({ __peekBridgeError: 'port.postMessage failed: ' + (err && err.message || String(err)) });
    }
  }

  // Wire up the preload bridge once the DOM is ready.
  function init() {
    if (!window.peekBridge) {
      log('ERROR: window.peekBridge not exposed — peek-bridge-preload.cjs not loaded');
      return;
    }
    if (!chrome || !chrome.runtime) {
      log('ERROR: chrome.runtime not available — not running as extension page');
      return;
    }

    window.peekBridge.onForward(function (payload, sendResponse) {
      onForward(payload, sendResponse);
    });

    // Open the port eagerly so it's ready before the first forward arrives.
    connect();

    log('bridge initialized extId=', chrome.runtime.id);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

