/**
 * peek://app/page/overlay.js — the SHARED chrome overlay renderer (P1.4b-2).
 *
 * The hybrid page-host path (PEEK_PAGEHOST_HYBRID=1) renders each web page as a
 * chrome-less opaque BaseWindow + WebContentsView (main-owned content
 * webContents). There is exactly ONE chrome surface for the whole app — this
 * overlay — which retargets/follows over whichever hybrid content window is
 * active (see apps/desktop/main/hybrid-overlay.ts). This renderer is that ONE
 * surface, serving N content windows by fully swapping its navbar state on each
 * active-window change.
 *
 * It REUSES the existing `<peek-navbar>` Lit component (the same component the
 * canvas page.js uses) rather than re-loading page.js in an "overlay mode" —
 * page.js is ~4800 lines tightly coupled to its own in-window `<webview>`,
 * widgets, panels, and resize math; a thin reuse of the navbar component is the
 * smaller, cleaner surface and follows the codebase's reuse-existing-pattern
 * rule.
 *
 * Mediation (all main-brokered — main owns the content webContents handle):
 *   main → overlay (active handoff + content events):
 *     - page-overlay:active   {windowId,url,title,canGoBack,canGoForward,loading}|null (directed)
 *     - page:title-updated    {windowId,url,title}
 *     - page:favicon          {windowId,url,favicon}
 *     - page:loading          {windowId,loading}
 *     - page:nav-state        {windowId,url,canGoBack,canGoForward}
 *     - page:navigated        {windowId,url,title}
 *   overlay → content (navbar actions; main resolves getHybridContentWC):
 *     - page:navigate         {windowId,url}
 *     - page:go-back          {windowId}
 *     - page:go-forward       {windowId}
 *     - page:reload           {windowId}
 *   overlay → main (click-capture toggle):
 *     - page-overlay:set-capture {capture:boolean}
 *
 * DEFERRED to P1.4b-3 (stubbed/omitted here): widgets, side panels
 * (info/tags/entities/notes/extensions), resize-handle DRAG to resize the
 * content BaseWindow, find-in-page, window drag-to-move, maximized layout.
 */

import api from '../api.js';

if (api.initialize) {
  await api.initialize();
}

const DEBUG = false;

const navbar = document.getElementById('navbar');
const triggerZone = document.getElementById('trigger-zone');
const dragZone = document.getElementById('drag-zone');

// P1.4b-3 window-interaction constants — mirror page.js so resize feels identical.
const MIN_WIDTH = 200;
const MIN_HEIGHT = 150;

// Component-level keyboard shortcuts are managed by the navbar; keep them on so
// Cmd+L/Cmd+R/Cmd+[/Cmd+] work while the overlay is focused. (The canvas page
// disables them and routes via pubsub instead; the overlay is the only chrome
// renderer, so letting the component own its shortcuts is simplest here.)
navbar.shortcuts = true;

// ── Active-window state ──────────────────────────────────────────────────────
// The single windowId the overlay currently reflects/drives. null = no active
// hybrid window (overlay cleared + hidden by main).
let activeWindowId = null;

// P1.4b-3: the active host window's current OUTER bounds, seeded from the active
// handoff and kept in sync as the user resizes/moves through the overlay chrome.
// The overlay frames the content window's full outer rect, so these ARE the
// overlay's own bounds — the renderer tracks them locally (exactly as page.js
// tracks `screenBounds`) and publishes new bounds for main to apply.
let activeBounds = null;
// Whether the active window is currently maximized (toggled by the maximize
// affordance). preMaxBounds holds the bounds to restore to on unmaximize.
let maximized = false;
let preMaxBounds = null;

/** Reset the navbar to empty (active→null or before painting a new window). */
function clearChrome() {
  navbar.setUrl('');
  navbar.canGoBack = false;
  navbar.canGoForward = false;
  navbar.loading = false;
  navbar.classList.remove('visible');
  document.body.classList.add('no-active');
  setCapture(false);
}

/** Paint the navbar for a freshly-active window from the handoff snapshot. */
function paintFromSnapshot(snap) {
  document.body.classList.remove('no-active');
  navbar.setUrl(snap.url || '');
  navbar.canGoBack = !!snap.canGoBack;
  navbar.canGoForward = !!snap.canGoForward;
  navbar.loading = !!snap.loading;
}

// ── main → overlay: active-window handoff ────────────────────────────────────
// Main sends this (directed, on each retarget) so the overlay fully swaps state
// for the newly-active window — instant paint from the snapshot, no flash of the
// previous window's URL.
api.subscribe('page-overlay:active', (msg) => {
  if (!msg || msg.windowId == null) {
    activeWindowId = null;
    activeBounds = null;
    maximized = false;
    preMaxBounds = null;
    clearChrome();
    DEBUG && console.log('[overlay] active → null (cleared)');
    return;
  }
  activeWindowId = msg.windowId;
  // P1.4b-3: seed the locally-tracked outer bounds for resize/move math. Reset
  // maximize state for the newly-active window (each window owns its own).
  activeBounds = msg.bounds ? { ...msg.bounds } : null;
  maximized = false;
  preMaxBounds = null;
  // Hard reset before painting the new window so stale loading/nav state can
  // never bleed across a retarget.
  navbar.loading = false;
  paintFromSnapshot(msg);
  DEBUG && console.log('[overlay] active →', activeWindowId, msg.url);
});

// ── content → chrome: only apply events for the ACTIVE window ─────────────────
function isActive(msg) {
  return msg && msg.windowId != null && msg.windowId === activeWindowId;
}

api.subscribe('page:title-updated', (msg) => {
  if (!isActive(msg)) return;
  // Title is not shown in the navbar itself, but a URL refresh keeps the bar in
  // sync if the navigation changed the address. (Title surfacing is a P1.4b-3
  // panel concern.)
  if (msg.url) navbar.setUrl(msg.url);
});

api.subscribe('page:favicon', (msg) => {
  if (!isActive(msg)) return;
  // P1.4b-3: the navbar has no favicon slot yet; favicon surfaces in the
  // (deferred) page-info panel. No-op for now beyond keeping the topic wired.
});

api.subscribe('page:loading', (msg) => {
  if (!isActive(msg)) return;
  navbar.loading = !!msg.loading;
});

api.subscribe('page:nav-state', (msg) => {
  if (!isActive(msg)) return;
  if (msg.url) navbar.setUrl(msg.url);
  navbar.canGoBack = !!msg.canGoBack;
  navbar.canGoForward = !!msg.canGoForward;
});

api.subscribe('page:navigated', (msg) => {
  if (!isActive(msg)) return;
  if (msg.url) navbar.setUrl(msg.url);
});

// ── chrome → content: navbar actions, tagged with the active windowId ─────────
// Main subscribes to these (ipc.ts) and, when windowId is a hybrid window,
// resolves getHybridContentWC(windowId) and drives the content webContents.
navbar.addEventListener('navigate', (e) => {
  const url = e.detail?.url;
  if (url == null || activeWindowId == null) return;
  api.publish('page:navigate', { windowId: activeWindowId, url });
  navbar.setUrl(url);
  hideNavbar();
});
navbar.addEventListener('go-back', () => {
  if (activeWindowId == null) return;
  api.publish('page:go-back', { windowId: activeWindowId });
});
navbar.addEventListener('go-forward', () => {
  if (activeWindowId == null) return;
  api.publish('page:go-forward', { windowId: activeWindowId });
});
navbar.addEventListener('reload', () => {
  if (activeWindowId == null) return;
  api.publish('page:reload', { windowId: activeWindowId });
});
navbar.addEventListener('dismiss', () => { hideNavbar(); });

// ── Navbar show/hide (trigger-zone hover), mirrors page.js behavior ───────────
let hideTimer = null;
function cancelHide() {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
}
function showNavbar() {
  if (activeWindowId == null) return;
  cancelHide();
  navbar.classList.add('visible');
  // P1.4b-3: arm the drag-zone (window move) only while the chrome is visible.
  document.body.classList.add('chrome-visible');
}
function hideNavbar() {
  navbar.classList.remove('visible');
  document.body.classList.remove('chrome-visible');
}
function scheduleHide() {
  cancelHide();
  hideTimer = setTimeout(() => {
    // Keep visible while the user is typing in the URL field.
    if (navbar.shadowRoot && navbar.shadowRoot.activeElement) return;
    hideNavbar();
  }, 400);
}

triggerZone.addEventListener('mouseenter', showNavbar);
triggerZone.addEventListener('mouseleave', scheduleHide);
navbar.addEventListener('mouseenter', cancelHide);
navbar.addEventListener('mouseleave', scheduleHide);

// ── Click-capture: overlay is window-level click-through by default. Capture
// ONLY while the pointer is over an interactive chrome region (trigger zone or
// navbar). main toggles overlayWin.setIgnoreMouseEvents on this signal so the
// content window stays interactive everywhere the chrome isn't. ────────────────
let captureOn = false;
function setCapture(want) {
  const next = !!want;
  if (next === captureOn) return;
  captureOn = next;
  api.publish('page-overlay:set-capture', { capture: next });
  DEBUG && console.log('[overlay] set-capture', next);
}

// Track pointer enter/leave on interactive regions. `forward:true` on the main
// side keeps move events flowing even while click-through, so these handlers
// still fire when the cursor is over the (otherwise click-through) chrome layer.
for (const el of document.querySelectorAll('.interactive')) {
  el.addEventListener('mouseenter', () => setCapture(true));
  el.addEventListener('mouseleave', () => {
    // Defer: a move from trigger-zone INTO the navbar fires leave-then-enter; a
    // microtask check avoids a capture flicker between adjacent regions.
    requestAnimationFrame(() => {
      const over = document.querySelector('.interactive:hover');
      if (!over) setCapture(false);
    });
  });
}

// ── P1.4b-3: window interaction (resize / move / maximize) ────────────────────
// The overlay frames the active hybrid content window's FULL outer bounds, so it
// owns the resize handles / drag surface / maximize affordance for that window.
// All three drive the content BaseWindow via main: the renderer computes new
// OUTER bounds (tracked locally in activeBounds, seeded from the handoff) and
// publishes `page:set-bounds {windowId, bounds}`; main resolves the host baseWin
// and applies them (ipc.ts installHybridNavbarActionRouting). Maximize/unmaximize
// publish `page:maximize` / `page:unmaximize` and main snaps to the display work
// area / restores the pre-maximize bounds.
//
// REUSED from page.js: the per-direction resize math (se/sw/ne/nw/n/s/e/w using
// screen-coordinate deltas + MIN_WIDTH/MIN_HEIGHT clamps) and the navbar-double-
// click maximize toggle. REIMPLEMENTED (much simpler): page.js applies a canvas
// MARGIN via computeWindowBounds() and updates per-window-element positions; the
// chrome-less hybrid window has no margin and no in-window chrome elements, so
// the overlay applies the math DIRECTLY to outer bounds and lets P1.1 fillView +
// P1.4b-1 follow handle the content/overlay reframe.

function publishBounds() {
  if (activeWindowId == null || !activeBounds) return;
  api.publish('page:set-bounds', {
    windowId: activeWindowId,
    bounds: {
      x: Math.round(activeBounds.x),
      y: Math.round(activeBounds.y),
      width: Math.round(activeBounds.width),
      height: Math.round(activeBounds.height),
    },
  });
}

// --- Resize handles (reuses page.js per-direction math) ---
let resizeDir = null;
let resizeStartX = 0;
let resizeStartY = 0;
let resizeStartW = 0;
let resizeStartH = 0;
let resizeStartBx = 0;
let resizeStartBy = 0;
let activeHandle = null;

for (const handle of document.querySelectorAll('.resize-handle')) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || activeWindowId == null || !activeBounds || maximized) return;
    resizeDir = handle.dataset.dir;
    resizeStartX = e.screenX;
    resizeStartY = e.screenY;
    resizeStartW = activeBounds.width;
    resizeStartH = activeBounds.height;
    resizeStartBx = activeBounds.x;
    resizeStartBy = activeBounds.y;
    activeHandle = handle;
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  });

  handle.addEventListener('pointermove', (e) => {
    if (activeHandle !== handle || !activeBounds) return;
    if (e.buttons === 0) { endResize(handle, e); return; }
    const dx = e.screenX - resizeStartX;
    const dy = e.screenY - resizeStartY;
    // Per-direction math copied from page.js (apps/desktop/renderer/page/page.js
    // initResizeHandle pointermove), applied directly to OUTER bounds.
    if (resizeDir === 'se') {
      activeBounds.width = Math.max(MIN_WIDTH, resizeStartW + dx);
      activeBounds.height = Math.max(MIN_HEIGHT, resizeStartH + dy);
    } else if (resizeDir === 'sw') {
      const nw = Math.max(MIN_WIDTH, resizeStartW - dx);
      activeBounds.x = resizeStartBx + (resizeStartW - nw);
      activeBounds.width = nw;
      activeBounds.height = Math.max(MIN_HEIGHT, resizeStartH + dy);
    } else if (resizeDir === 'ne') {
      activeBounds.width = Math.max(MIN_WIDTH, resizeStartW + dx);
      const nh = Math.max(MIN_HEIGHT, resizeStartH - dy);
      activeBounds.y = resizeStartBy + (resizeStartH - nh);
      activeBounds.height = nh;
    } else if (resizeDir === 'nw') {
      const nw = Math.max(MIN_WIDTH, resizeStartW - dx);
      activeBounds.x = resizeStartBx + (resizeStartW - nw);
      activeBounds.width = nw;
      const nh = Math.max(MIN_HEIGHT, resizeStartH - dy);
      activeBounds.y = resizeStartBy + (resizeStartH - nh);
      activeBounds.height = nh;
    } else if (resizeDir === 'e') {
      activeBounds.width = Math.max(MIN_WIDTH, resizeStartW + dx);
    } else if (resizeDir === 'w') {
      const nw = Math.max(MIN_WIDTH, resizeStartW - dx);
      activeBounds.x = resizeStartBx + (resizeStartW - nw);
      activeBounds.width = nw;
    } else if (resizeDir === 's') {
      activeBounds.height = Math.max(MIN_HEIGHT, resizeStartH + dy);
    } else if (resizeDir === 'n') {
      const nh = Math.max(MIN_HEIGHT, resizeStartH - dy);
      activeBounds.y = resizeStartBy + (resizeStartH - nh);
      activeBounds.height = nh;
    }
    publishBounds();
  });

  const onEnd = (e) => endResize(handle, e);
  handle.addEventListener('pointerup', onEnd);
  handle.addEventListener('pointercancel', onEnd);
}

function endResize(handle, e) {
  if (activeHandle !== handle) return;
  resizeDir = null;
  activeHandle = null;
  try { if (e && e.pointerId != null) handle.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
}

// --- Drag-to-move (mirrors page.js navbar-background instant drag) ---
let dragging = false;
let dragStartX = 0;
let dragStartY = 0;
let dragStartBx = 0;
let dragStartBy = 0;

dragZone.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || activeWindowId == null || !activeBounds || maximized) return;
  dragging = true;
  dragStartX = e.screenX;
  dragStartY = e.screenY;
  dragStartBx = activeBounds.x;
  dragStartBy = activeBounds.y;
  dragZone.classList.add('dragging');
  dragZone.setPointerCapture(e.pointerId);
  e.preventDefault();
});
dragZone.addEventListener('pointermove', (e) => {
  if (!dragging || !activeBounds) return;
  if (e.buttons === 0) { endDrag(e); return; }
  activeBounds.x = dragStartBx + (e.screenX - dragStartX);
  activeBounds.y = dragStartBy + (e.screenY - dragStartY);
  publishBounds();
});
function endDrag(e) {
  if (!dragging) return;
  dragging = false;
  dragZone.classList.remove('dragging');
  try { if (e && e.pointerId != null) dragZone.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
}
dragZone.addEventListener('pointerup', endDrag);
dragZone.addEventListener('pointercancel', endDrag);

// --- Maximize / restore (navbar double-click, mirrors page.js toggleMaximize) ---
function toggleMaximize() {
  if (activeWindowId == null) return;
  if (maximized) {
    maximized = false;
    // Restore the locally-tracked bounds so subsequent resize/move math is right.
    if (preMaxBounds) activeBounds = { ...preMaxBounds };
    preMaxBounds = null;
    api.publish('page:unmaximize', { windowId: activeWindowId });
  } else {
    if (activeBounds) preMaxBounds = { ...activeBounds };
    maximized = true;
    api.publish('page:maximize', { windowId: activeWindowId });
  }
}
navbar.addEventListener('dblclick', (e) => {
  e.preventDefault();
  toggleMaximize();
});

// P1.4b-4: side panels (info/tags/entities/notes/extensions), page widgets,
// navbar title/favicon slots, and find-in-page are DEFERRED. Their chrome would
// hang off this same overlay surface + main routing.

// Signal readiness so main can verify the renderer is wired (and tests can wait).
window.__overlayReady = true;
DEBUG && console.log('[overlay] ready');
