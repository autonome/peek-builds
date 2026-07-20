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

// === Universal editable-focus reporting (peek 51798bae) =====================
// This preload is now applied to EVERY http(s) page-host content WC (not just
// extension-matched URLs — see getRuntimeExternalWebPrefsForUrl). Its universal
// job is to give the main process a deterministic "is an editable element
// focused?" signal so ESC can blur/dismiss the field instead of being stolen to
// open the Windows switcher. FSM-clean: the boolean is recomputed on focus
// TRANSITIONS (focusin/focusout) and pushed only on change — no timers, no
// polling. The predicate mirrors renderer/page/overlay.js `shouldBlockOverlayDrag`
// (shadow-DOM-aware via the active element of each shadow root).
const IPC_EDITABLE_FOCUS = 'page:editable-focus';

function _peekDeepActiveElement() {
  let el = document.activeElement;
  // Pierce shadow roots: a focused element inside a shadow tree is that root's
  // activeElement, chained from the host down.
  while (el && el.shadowRoot && el.shadowRoot.activeElement) {
    el = el.shadowRoot.activeElement;
  }
  return el;
}

function _peekIsEditableElement(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') {
    // Non-text input types (button/checkbox/radio/etc.) don't own ESC.
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    const nonEditable = ['button', 'checkbox', 'radio', 'submit', 'reset', 'image', 'file', 'range', 'color', 'hidden'];
    return !nonEditable.includes(type);
  }
  if ((el.getAttribute('role') || '').toLowerCase() === 'textbox') return true;
  return false;
}

let _peekLastEditable = null;
function _peekReportEditableFocus() {
  const editable = _peekIsEditableElement(_peekDeepActiveElement());
  if (editable === _peekLastEditable) return;
  _peekLastEditable = editable;
  try { ipcRenderer.send(IPC_EDITABLE_FOCUS, editable); } catch (_) {}
}
// focusin/focusout bubble (unlike focus/blur) so ONE document-level capture
// listener sees focus moving anywhere in the page, incl. across shadow
// boundaries. Chromium/DOM boundary: on focusout, document.activeElement has
// not yet settled to the post-transition target, so read it on a MICROTASK —
// a deterministic ordering primitive (runs after the synchronous blur→focus
// sequence completes), NOT a timing race. Dedup makes the double-fire (focusout
// then focusin on a field-to-field move) a no-op.
function _peekScheduleReport() { Promise.resolve().then(_peekReportEditableFocus); }
document.addEventListener('focusin', _peekScheduleReport, true);
document.addEventListener('focusout', _peekScheduleReport, true);

// === Content-area double-click window gesture (peek d8ce0ddf) ================
// A double-click over "dead" page content toggles the host window's maximize.
// Detected HERE in the page realm because only it has the DOM target
// (composedPath, shadow-DOM-aware) and the live text selection needed to
// SUPPRESS the gesture — over an editable/interactive control (input/button/
// link/etc.) OR when the multi-click is selecting text (double-click-a-word must
// never resize the window). Rides Chromium's native multi-click counter
// (MouseEvent.detail) — no timers, no debounce (fsm-pilled). We report only the
// clean detent-2 case; main (hybrid-window-gesture.ts) maps detent 2 → maximize.
// Fullscreen is no longer a content gesture — it is command-driven and single-
// owned by main (tile:window:fullscreen → the window-state machine's
// FULLSCREEN_REQUESTED dispatch, window-os-adapter.ts).
const IPC_CONTENT_WINDOW_GESTURE = 'page:content-window-gesture';

// Broader than _peekIsEditableElement: the gesture must also skip discrete
// interactive controls a click is meant to activate (buttons, links, media,
// widget roles), not just editable fields.
function _peekIsInteractiveTarget(el) {
  if (_peekIsEditableElement(el)) return true;
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'button' || tag === 'a' || tag === 'summary' || tag === 'option'
    || tag === 'label' || tag === 'video' || tag === 'audio') return true;
  const role = (el.getAttribute ? (el.getAttribute('role') || '') : '').toLowerCase();
  const interactiveRoles = ['button', 'link', 'checkbox', 'radio', 'menuitem',
    'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider', 'option', 'textbox'];
  return interactiveRoles.includes(role);
}

function _peekGestureSuppressed(e) {
  // 1) Interactive/editable target anywhere along the (shadow-aware) event path.
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  for (const node of path) {
    if (!node || node.nodeType !== 1) continue;
    if (_peekIsInteractiveTarget(node)) return true;
  }
  // 2) The multi-click landed ON text and selected it (double-click a word /
  //    triple-click a line). A bare "some selection exists" test is too coarse:
  //    Chromium snaps a double-click in DEAD SPACE to the nearest word and
  //    selects THAT, so nearly every dead-space double-click leaves a
  //    non-collapsed selection — which used to suppress the gesture almost
  //    always. The precise signal is whether the click point actually falls
  //    within the selected text's own rects. A genuine dead-space click selects
  //    a word elsewhere whose rects don't cover the cursor → gesture fires; a
  //    word/line click sits inside its selection → suppressed.
  try {
    const sel = window.getSelection && window.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount > 0 && String(sel).length > 0) {
      const rects = sel.getRangeAt(0).getClientRects();
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        if (e.clientX >= r.left && e.clientX <= r.right
          && e.clientY >= r.top && e.clientY <= r.bottom) return true;
      }
    }
  } catch (_) { /* getSelection unavailable */ }
  return false;
}

// Track the press point of the most recent mousedown so the terminating click can
// measure how far the pointer travelled. `detail===2/3` alone can't tell a
// stationary double/triple-click from a click-drag: a click-drag's terminating
// click still inherits detail===2 if its press landed within Chromium's native
// double-click interval of a prior click, even though the pointer moved between
// press and release. Travel is the deterministic discriminator (main-side
// windowGestureAction, hybrid-window-gesture.ts). Captured on EVERY mousedown so
// the click's own press is always the last value recorded, and consumed by the
// click that follows it (see below).
let _peekDownX = null;
let _peekDownY = null;
document.addEventListener('mousedown', function (e) {
  _peekDownX = e.clientX;
  _peekDownY = e.clientY;
}, true);

document.addEventListener('click', function (e) {
  // Read AND clear: a press point belongs to exactly one click. A click that
  // arrives without a mousedown of its own — a page calling .click(), any
  // synthesized MouseEvent — must not inherit the PREVIOUS click's press and get
  // misread as a drag. With no press to compare against it counts as stationary,
  // which is what this handler did before travel was measured at all. Consumed
  // before the detent/suppression returns below so every click clears it, not
  // just the ones that reach the send.
  const downX = _peekDownX;
  const downY = _peekDownY;
  _peekDownX = null;
  _peekDownY = null;

  const detent = e.detail; // native multi-click count: 2 = double-click
  if (detent !== 2) return;
  if (_peekGestureSuppressed(e)) return;
  // Press-to-release travel; no press seen means treat as no movement.
  const dragDx = downX === null ? 0 : e.clientX - downX;
  const dragDy = downY === null ? 0 : e.clientY - downY;
  // A dead-space multi-click that reaches here may still have left Chromium's
  // incidental nearest-word selection behind; clear it so the maximize gesture
  // doesn't leave a stray highlight on the page.
  try {
    const sel = window.getSelection && window.getSelection();
    if (sel && !sel.isCollapsed) sel.removeAllRanges();
  } catch (_) { /* getSelection unavailable */ }
  try { ipcRenderer.send(IPC_CONTENT_WINDOW_GESTURE, { detent, dragDx, dragDy }); } catch (_) { /* no main */ }
}, true);

// === First composited-frame signal (session-restore z-order fidelity) =========
// Cold-start session restore re-asserts the saved window z-order, but a page-host
// is a BaseWindow + WebContentsView whose NSWindow is NOT orderable in the macOS
// window server (main's moveTop() is a no-op) until its content compositor has
// produced a settled frame — later than did-finish-load / did-stop-loading /
// dom-ready, all of which are load-lifecycle, not compositor-frame. So we report
// the real "on screen / orderable" moment to main: two nested requestAnimationFrame
// callbacks resolve one frame AFTER the first content paint is scheduled, i.e.
// once a real frame has been composited. Main (session.ts) keys the ordered
// restack on this per-window signal. Fired ONCE per preload lifetime — a
// deterministic lifecycle transition, not a settle timer (fsm-pilled). Sender
// identifies the host window in main (getHybridWindowByContentWC).
const IPC_FIRST_FRAME = 'hybrid:first-frame';
let _peekFirstFrameSent = false;
function _peekSignalFirstFrame() {
  if (_peekFirstFrameSent) return;
  _peekFirstFrameSent = true;
  try { ipcRenderer.send(IPC_FIRST_FRAME); } catch (_) { /* no main */ }
}
try {
  requestAnimationFrame(function () { requestAnimationFrame(_peekSignalFirstFrame); });
} catch (_) {
  // requestAnimationFrame unavailable (non-visual context) — send immediately so
  // main never waits on a frame that will never come.
  _peekSignalFirstFrame();
}

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

// Chrome-extension messaging polyfill — GATED on a matched extension id. When
// this preload is applied universally for focus tracking (no --peek-runtime-
// external-ext-id arg), _extId is '' and the whole chrome.runtime.sendMessage
// bridge stays dormant; only the focus reporter above runs.
if (_extId) {
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
    const { reqId, extId, message, origin, internal } = d;
    console.log('[peek:runtime-external:preload] req reqId=', reqId, 'extId=', extId, 'type=', message && message.type, 'internal=', !!internal);
    ipcRenderer.invoke(IPC_SEND_FROM_PAGE, { extId, message, origin, internal: !!internal })
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
}

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
