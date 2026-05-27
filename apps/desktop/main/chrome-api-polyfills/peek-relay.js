/* peek-relay.js — bridge-window postMessage relay for ISOLATED content scripts.
 *
 * Loaded from peek-bridge.html alongside peek-bridge.js. While peek-bridge.js
 * handles cross-origin chrome.runtime.sendMessage routing, this script
 * relays window.postMessage events between cross-origin pages and the
 * extension's ISOLATED-world content scripts (which we inject into THIS bridge
 * window so they have the extension's real chrome.runtime).
 *
 * Flow:
 *   page (cross-origin) ──window.postMessage──► page preload
 *     ──ipcRenderer.send('peek:cs-relay:from-page')──► main
 *     ──webContents.send('peek:cs-relay:dispatch')──► bridge window
 *     ──window.dispatchEvent(new MessageEvent('message'))──► injected
 *                                                            content scripts
 *
 *   content script ──window.postMessage(response)──► OUR listener
 *     ──peekBridge.relayBack({senderId, data, origin})──► main
 *     ──webContents.send('peek:cs-relay:to-page')──► page preload
 *     ──window.postMessage on page──► page's listeners
 *
 * Loop avoidance:
 *   When we dispatch an event INTO the bridge window, our own
 *   `window.addEventListener('message', ...)` also fires. We tag the
 *   stringified data + add to a short-TTL set; on listener fire we skip
 *   matching events to avoid re-forwarding our own injections.
 *
 * No extension-specific logic lives here — the relay is generic across any
 * extension whose manifest declares ISOLATED-world content_scripts.
 */
(function () {
  'use strict';

  // Bail if peek-bridge-preload didn't expose the relay surface.
  if (!window.peekBridge || typeof window.peekBridge.onRelayDispatch !== 'function') {
    console.error('[peek:relay] window.peekBridge.onRelayDispatch missing — bridge preload too old');
    return;
  }

  var _justDispatched = new Set();
  var _LOOP_TTL_MS = 100;

  function _hashData(data) {
    try { return JSON.stringify(data); } catch (_) { return null; }
  }

  function log() {
    try {
      var args = Array.prototype.slice.call(arguments);
      window.peekBridge.log.apply(null, ['[relay]'].concat(args));
    } catch (_) {}
  }

  // Track the most-recently-dispatched senderId so outgoing responses
  // (which arrive on a SEPARATE message event triggered by content scripts)
  // can be routed back to the right page. Short queue for in-flight requests.
  var _recentSenderIds = [];
  var _RECENT_SENDER_MAX = 16;

  /**
   * Dispatch a relayed page-side postMessage into the bridge window so
   * injected content scripts hear it. Tag the stringified data so our own
   * listener can skip it (loop avoidance).
   */
  function _dispatchIntoBridge(payload) {
    var data = payload && payload.data;
    var origin = (payload && payload.origin) || '*';
    var senderId = payload && payload.senderId;

    if (typeof senderId === 'number') {
      _recentSenderIds.push(senderId);
      if (_recentSenderIds.length > _RECENT_SENDER_MAX) _recentSenderIds.shift();
    }

    var hash = _hashData(data);
    if (hash) {
      _justDispatched.add(hash);
      setTimeout(function () { _justDispatched.delete(hash); }, _LOOP_TTL_MS);
    }

    log('dispatch INTO bridge senderId=', senderId, 'origin=', origin);

    try {
      var ev = new MessageEvent('message', {
        data: data,
        origin: origin,
        source: window,
      });
      window.dispatchEvent(ev);
    } catch (err) {
      log('dispatchEvent threw:', err && err.message);
    }
  }

  window.peekBridge.onRelayDispatch(_dispatchIntoBridge);

  // Capture outgoing postMessage events from injected content scripts.
  window.addEventListener('message', function (ev) {
    // Only care about events sourced from this same window (content scripts
    // running here, including our dispatched MessageEvents).
    if (ev.source !== null && ev.source !== window) return;

    var hash = _hashData(ev.data);
    if (hash && _justDispatched.has(hash)) {
      _justDispatched.delete(hash);
      // Our own injected event — don't forward back to the page.
      return;
    }

    // Skip messages that are clearly bridge-internal (auth-ext forward/response
    // surface uses ipcRenderer directly; nothing should arrive as
    // window.postMessage there, but belt-and-suspenders).
    if (ev.data && typeof ev.data === 'object' && ev.data.__peekRuntimeExternal) return;
    if (ev.data && typeof ev.data === 'object' && ev.data.__peekBridgeError) return;

    // Route response to the most-recently-tracked sender. For strict
    // request-response patterns this is correct; for fan-out broadcasts the
    // current model only relays to the most recent page (acceptable for now —
    // orchestrator's auth flow is strict request-response).
    var senderId = _recentSenderIds.length > 0
      ? _recentSenderIds[_recentSenderIds.length - 1]
      : null;
    if (senderId == null) {
      log('outgoing postMessage with no recent sender — dropping');
      return;
    }

    try {
      window.peekBridge.relayBack({
        senderId: senderId,
        data: ev.data,
        origin: ev.origin || '*',
      });
      log('outgoing postMessage relayed to senderId=', senderId);
    } catch (err) {
      log('relayBack threw:', err && err.message);
    }
  }, false);

  log('peek-relay initialized');
})();
