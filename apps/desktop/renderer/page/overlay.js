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
 * P1.4b-5: side panels (page-info / tags / entities / extensions) are ported
 * here from the canvas page.js. The overlay is ONE renderer serving N windows by
 * retargeting, so every panel shows data for the CURRENT active window's URL and
 * fully swaps on retarget (clears on active→null). Data sources (identical to
 * page.js, keyed on the active window's URL):
 *   - page-info  → overlay publishes `page:extract-info {windowId}`; main execs
 *                  the meta-tag extraction in the active content WC and replies
 *                  `page:page-info {windowId,url,info}` (ipc.ts). Active-filtered.
 *   - tags       → `api.datastore.*` (queryItems/getItemTags/getOrCreateTag/
 *                  tagItem/untagItem/getTagsByFrecency) on the active URL, +
 *                  `tag:item-added` / `tag:item-removed` / `tag:created` pubsub.
 *   - entities   → publish `entities:get-for-url {url}` → `entities:get-for-url:
 *                  response {url,entities}`; also `entities:extracted {url,...}`.
 *   - extensions → `api.chromeExtensions.*` + `api.adblocker.*`, keyed on the
 *                  active URL's hostname.
 * Panels are .interactive (covered by the existing click-capture loop) and shown
 * with the navbar via body.panels-visible.
 *
 * P1.4b-6: the NOTES panel (PageNotesPane in page-notes.js) and the page WIDGETS
 * host (page-widgets.js + OpenSearch-discovery + space-mode widgets) are ported
 * here, COMPLETING overlay parity. Both belong to the CURRENT active window and
 * fully swap on retarget / clear on active→null:
 *   - notes    → PageNotesPane mounted at #notes-panel-anchor; URL-keyed via
 *                api.datastore (no main routing). loadForUrl(activeUrl) on each
 *                setActiveUrl(); cleared (loadForUrl(null)) on retarget/null. Its
 *                element is added to .interactive and gains .has-data when an
 *                active http URL is set.
 *   - widgets  → an addWidget/removeWidget/updateWidget registry over
 *                #widget-container (ported from page.js), feeding
 *                createPageWidgetHost. The OpenSearch widget is gated to the
 *                ACTIVE windowId: main's per-window `page:search-engine-discovered`
 *                (windowId-tagged, P1.3) records which engine belongs to the
 *                active page, so the global `websearch:engine-discovered` only
 *                renders a card when it matches the active window's discovery. The
 *                space-mode widget mirrors the canvas mode-context behavior. The
 *                container is cleared (all widgets removed) on retarget/null.
 */

import api from '../api.js';
import { PageNotesPane } from './page-notes.js';
import { createPageWidgetHost } from './page-widgets.js';

if (api.initialize) {
  await api.initialize();
}

const DEBUG = false;

const navbar = document.getElementById('navbar');
const triggerZone = document.getElementById('trigger-zone');
const dragZone = document.getElementById('drag-zone');
// P1.4b-4: find-bar elements (mirror page.js's find UI element refs).
const findBar = document.getElementById('find-bar');
const findInput = document.getElementById('find-input');
const findCount = document.getElementById('find-count');
const findPrevBtn = document.getElementById('find-prev');
const findNextBtn = document.getElementById('find-next');
const findCloseBtn = document.getElementById('find-close');

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

// P1.4b-5: the active window's current page URL (http/https). Every side panel
// keys its data on this; it is reset on each retarget and updated as the active
// window navigates (page:nav-state / page:navigated). null when no active window
// or the active URL is not http(s).
let activeUrl = null;

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
  navbar.pageTitle = '';
  navbar.favicon = '';
  navbar.classList.remove('visible');
  document.body.classList.remove('panels-visible');
  document.body.classList.add('no-active');
  hideFindBar();
  clearPanels();
  setCapture(false);
}

/** Paint the navbar for a freshly-active window from the handoff snapshot. */
function paintFromSnapshot(snap) {
  document.body.classList.remove('no-active');
  navbar.setUrl(snap.url || '');
  navbar.canGoBack = !!snap.canGoBack;
  navbar.canGoForward = !!snap.canGoForward;
  navbar.loading = !!snap.loading;
  // P1.4b-4: seed title/favicon from the snapshot if present; otherwise clear so
  // the previous window's title/favicon never bleeds across a retarget.
  navbar.pageTitle = snap.title || '';
  navbar.favicon = snap.favicon || '';
}

// ── main → overlay: active-window handoff ────────────────────────────────────
// Main sends this (directed, on each retarget) so the overlay fully swaps state
// for the newly-active window — instant paint from the snapshot, no flash of the
// previous window's URL.
api.subscribe('page-overlay:active', (msg) => {
  if (!msg || msg.windowId == null) {
    activeWindowId = null;
    activeUrl = null;
    activeBounds = null;
    maximized = false;
    preMaxBounds = null;
    clearChrome();
    DEBUG && console.log('[overlay] active → null (cleared)');
    return;
  }
  activeWindowId = msg.windowId;
  // P1.4b-5: seed the active URL for the side panels and refresh them for the
  // newly-active window (full swap — clears the prior window's panel data first).
  setActiveUrl(isHttp(msg.url) ? msg.url : null);
  // P1.4b-3: seed the locally-tracked outer bounds for resize/move math. Reset
  // maximize state for the newly-active window (each window owns its own).
  activeBounds = msg.bounds ? { ...msg.bounds } : null;
  maximized = false;
  preMaxBounds = null;
  // Hard reset before painting the new window so stale loading/nav state can
  // never bleed across a retarget. Also close any open find bar (find is
  // per-window; the new window starts with no active search).
  navbar.loading = false;
  hideFindBar();
  paintFromSnapshot(msg);
  DEBUG && console.log('[overlay] active →', activeWindowId, msg.url);
});

// ── content → chrome: only apply events for the ACTIVE window ─────────────────
function isActive(msg) {
  return msg && msg.windowId != null && msg.windowId === activeWindowId;
}

api.subscribe('page:title-updated', (msg) => {
  if (!isActive(msg)) return;
  // P1.4b-4: surface the page title in the navbar title chip + keep the URL in
  // sync if the navigation changed the address.
  if (msg.title != null) navbar.pageTitle = msg.title;
  if (msg.url) navbar.setUrl(msg.url);
});

api.subscribe('page:favicon', (msg) => {
  if (!isActive(msg)) return;
  // P1.4b-4: surface the favicon in the navbar title chip.
  navbar.favicon = msg.favicon || '';
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
  // P1.4b-5: a navigation changes the page identity → re-key + refresh panels.
  if (isHttp(msg.url) && msg.url !== activeUrl) setActiveUrl(msg.url);
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
  // P1.4b-5: reveal the side panels alongside the navbar (matches page.js, where
  // show() reveals panels with the navbar). Only panels marked has-data paint.
  document.body.classList.add('panels-visible');
}
function hideNavbar() {
  navbar.classList.remove('visible');
  document.body.classList.remove('chrome-visible');
  document.body.classList.remove('panels-visible');
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

// P1.4b-5: keep the chrome (navbar + panels) visible while the pointer is over a
// side panel — mirrors page.js, which cancels the hide timer on panel hover so a
// user can interact with panels without the chrome collapsing under them.
// P1.4b-6: include the notes panel + widget container so they keep the chrome
// open on hover too. The notes panel is mounted by overlay.js (see below), so it
// may not exist yet at this point — its hover is bound at mount time instead.
for (const sel of ['#page-info-panel', '#tags-panel', '#entities-panel', '#extensions-panel', '#widget-container']) {
  const p = document.querySelector(sel);
  if (!p) continue;
  p.addEventListener('mouseenter', () => { showNavbar(); });
  p.addEventListener('mouseleave', scheduleHide);
}

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

// ── P1.4b-4: find-in-page ─────────────────────────────────────────────────────
// The overlay owns the find-bar UI (mirrors page.js's in-renderer find bar). The
// hybrid content webContents is MAIN-owned, so instead of calling findInPage
// directly the overlay publishes find intents tagged with the active windowId and
// main routes them to getHybridContentWC(windowId) (ipc.ts
// installHybridNavbarActionRouting):
//   - page:find-exec {windowId, text, options}  ← typing in the find input
//   - page:find-next {windowId}                 ← Enter / next button
//   - page:find-prev {windowId}                 ← Shift+Enter / prev button
//   - page:find-stop {windowId}                 ← close / Esc
// Match-count display is fed by main forwarding the content WC's `found-in-page`
// result as `page:found-in-page {windowId, activeMatchOrdinal, matches}`.
//
// Cmd+F / Cmd+G land on the content WC (it owns keyboard focus while the user
// reads the page); main forwards them as `page:find` / `page:find-next` /
// `page:find-prev` (windowId-tagged), which open/advance this bar.

let findBarVisible = false;
let currentFindText = '';

function showFindBar() {
  if (activeWindowId == null) return;
  document.body.classList.add('find-visible');
  findBarVisible = true;
  findInput.focus();
  findInput.select();
  // Surfacing the find bar means the overlay must be pointer-opaque so the user
  // can type/click in it (same as the navbar's .interactive regions).
  setCapture(true);
}

function hideFindBar() {
  document.body.classList.remove('find-visible');
  findBarVisible = false;
  currentFindText = '';
  findCount.textContent = '';
  findInput.value = '';
  if (activeWindowId != null) {
    api.publish('page:find-stop', { windowId: activeWindowId });
  }
}

function execFind(text) {
  if (activeWindowId == null) return;
  currentFindText = text;
  if (!text) {
    findCount.textContent = '';
    api.publish('page:find-exec', { windowId: activeWindowId, text: '' });
    return;
  }
  api.publish('page:find-exec', { windowId: activeWindowId, text, options: {} });
}

// next/prev EXECUTION is driven by main routing the `page:find-next` /
// `page:find-prev` topics to contentWC.findInPage. The overlay's own buttons +
// the forwarded Cmd+G accelerator both arrive on those SAME topics. To avoid a
// publish→self-subscribe→republish loop, the buttons publish directly here and
// the topic SUBSCRIPTIONS below only open the bar (never re-publish).
function findNext() {
  if (activeWindowId == null || !currentFindText) return;
  api.publish('page:find-next', { windowId: activeWindowId });
}
function findPrev() {
  if (activeWindowId == null || !currentFindText) return;
  api.publish('page:find-prev', { windowId: activeWindowId });
}

// Match-count results forwarded from main (content WC found-in-page).
api.subscribe('page:found-in-page', (msg) => {
  if (!isActive(msg) || !findBarVisible) return;
  const matches = msg.matches || 0;
  if (matches > 0) {
    findCount.textContent = `${msg.activeMatchOrdinal} of ${matches}`;
  } else {
    findCount.textContent = 'No matches';
  }
});

findInput.addEventListener('input', () => { execFind(findInput.value); });
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.shiftKey) {
    e.preventDefault();
    findPrev();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    findNext();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    hideFindBar();
  }
});
findNextBtn.addEventListener('click', () => findNext());
findPrevBtn.addEventListener('click', () => findPrev());
findCloseBtn.addEventListener('click', () => hideFindBar());

// Open/advance triggers forwarded from main (Cmd+F / Cmd+G on the content WC).
api.subscribe('page:find', (msg) => {
  if (!isActive(msg)) return;
  showFindBar();
});
// page:find-next / page:find-prev are EXECUTION topics (main runs findInPage).
// The overlay subscribes only to ensure its find bar is open when a bare Cmd+G
// arrives with no bar showing — it must NOT call findNext()/findPrev() here, or
// it would re-publish the same topic and loop. When the bar is already open the
// button/accelerator already published the topic main acts on; nothing to do.
api.subscribe('page:find-next', (msg) => {
  if (!isActive(msg) || findBarVisible) return;
  showFindBar();
});
api.subscribe('page:find-prev', (msg) => {
  if (!isActive(msg) || findBarVisible) return;
  showFindBar();
});

// ── P1.4b-5: side panels (page-info / tags / entities / extensions) ───────────
// All four key on `activeUrl` (the active window's current page URL). They fully
// swap on retarget and clear on active→null. The panel DOM/markup/CSS is REUSED
// verbatim from renderer/page/index.html; the rendering logic is ported from
// page.js (renderPageInfo/renderTags/renderEntities/loadExtensionsPanel) with the
// only change being the data SOURCE: instead of reading a same-window <webview>,
// the overlay reads the MAIN-owned active content WC via pubsub + api.datastore.

function isHttp(u) {
  return typeof u === 'string' && (u.startsWith('http://') || u.startsWith('https://'));
}

// Panel DOM refs (mirror page.js's element handles).
const pageInfoPanel = document.getElementById('page-info-panel');
const pageInfoBody = document.getElementById('page-info-body');
const tagsPanel = document.getElementById('tags-panel');
const tagsBody = document.getElementById('tags-body');
const tagsList = document.getElementById('tags-list');
const tagsInput = document.getElementById('tags-input');
const tagsSuggestion = document.getElementById('tags-suggestion');
const entitiesPanel = document.getElementById('entities-panel');
const entitiesBody = document.getElementById('entities-body');
const entitiesRescanBtn = document.getElementById('entities-rescan-btn');
const extensionsPanel = document.getElementById('extensions-panel');
const extensionsBody = document.getElementById('extensions-body');

// Per-active-window panel state. A monotonically-increasing token gates async
// callbacks so a slow datastore/exec reply for a NO-LONGER-active window can
// never paint into the panels (the single overlay renderer serves N windows).
let panelToken = 0;
let currentItemId = null;
let currentPageTags = [];
let allTagsCache = [];
let currentPageEntities = [];
let currentSiteHostname = null;
let currentSiteAdblockAllowed = false;
let adblockerGlobalEnabled = false;

/** Reset every panel to empty + remove its has-data flag (so it stops painting).
 *  Called on active→null and at the start of every retarget. */
function clearPanels() {
  panelToken++;
  currentItemId = null;
  currentPageTags = [];
  currentPageEntities = [];
  currentSiteHostname = null;
  currentSiteAdblockAllowed = false;
  if (pageInfoBody) pageInfoBody.innerHTML = '<div class="info-empty">Loading page info...</div>';
  if (tagsList) tagsList.innerHTML = '';
  if (tagsInput) tagsInput.value = '';
  if (tagsSuggestion) tagsSuggestion.textContent = '';
  if (entitiesBody) entitiesBody.innerHTML = '<div class="entity-empty">No entities detected yet</div>';
  if (extensionsBody) extensionsBody.innerHTML = '<div class="ext-loading">Loading extensions...</div>';
  for (const p of [pageInfoPanel, tagsPanel, entitiesPanel, extensionsPanel]) {
    if (p) p.classList.remove('has-data');
  }
  // P1.4b-6: notes + widgets belong to the active window too — clear them on the
  // same boundary (retarget / active→null) so a prior window's notes/widgets
  // never bleed into the next active window's chrome.
  clearNotes();
  clearWidgets();
}

/** Re-key the panels onto a new active URL and kick off all four loads. Passing
 *  null clears them (non-http active window — panels have nothing to show). */
function setActiveUrl(url) {
  clearPanels();
  activeUrl = url;
  if (!url) return;
  const token = panelToken;
  requestPageInfo(token);
  requestEntities(token, url);
  loadTagsForUrl(token, url);
  loadExtensionsPanel(token);
  loadNotesForUrl(token, url);
}

// ── Page Info ─────────────────────────────────────────────────────────────────
// Ask main to extract the active content WC's meta tags; the reply arrives on
// `page:page-info` (active-filtered). Mirrors page.js renderPageInfo verbatim.
function requestPageInfo(token) {
  if (activeWindowId == null || token !== panelToken) return;
  api.publish('page:extract-info', { windowId: activeWindowId });
}

api.subscribe('page:page-info', (msg) => {
  if (!isActive(msg)) return;
  if (!msg.info) return;
  renderPageInfo(msg.info);
});

function renderPageInfo(info) {
  if (!pageInfoBody) return;
  const rows = [];
  if (info.title) rows.push(makeInfoRow('Title', info.title));
  if (info.hostname) rows.push(makeInfoRow('Domain', info.hostname));
  if (info.ogSiteName && info.ogSiteName !== info.hostname) rows.push(makeInfoRow('Site', info.ogSiteName));
  const desc = info.ogDescription || info.description;
  if (desc) rows.push(makeInfoRow('Description', desc, true));
  if (info.keywords) rows.push(makeInfoRow('Keywords', info.keywords, true));
  if (info.author) rows.push(makeInfoRow('Author', info.author));
  if (info.ogType) rows.push(makeInfoRow('Type', info.ogType));
  if (info.ogImage) {
    const imgRow = document.createElement('div');
    imgRow.className = 'info-row';
    const label = document.createElement('div');
    label.className = 'info-label';
    label.textContent = 'OG Image';
    imgRow.appendChild(label);
    const img = document.createElement('img');
    img.className = 'og-image-preview';
    img.src = info.ogImage;
    img.alt = 'Open Graph image';
    img.onerror = () => { imgRow.remove(); };
    imgRow.appendChild(img);
    rows.push(imgRow);
  }
  if (info.generator) rows.push(makeInfoRow('Generator', info.generator));

  if (rows.length === 0) {
    pageInfoBody.innerHTML = '<div class="info-empty">No metadata available</div>';
  } else {
    pageInfoBody.innerHTML = '';
    for (const row of rows) pageInfoBody.appendChild(row);
  }
  if (pageInfoPanel) pageInfoPanel.classList.add('has-data');
}

function makeInfoRow(labelText, valueText, truncated = false) {
  const row = document.createElement('div');
  row.className = 'info-row';
  const label = document.createElement('div');
  label.className = 'info-label';
  label.textContent = labelText;
  row.appendChild(label);
  const value = document.createElement('div');
  value.className = 'info-value' + (truncated ? ' truncated' : '');
  value.textContent = valueText;
  row.appendChild(value);
  return row;
}

// ── Tags ──────────────────────────────────────────────────────────────────────
// Pure api.datastore + tag pubsub, keyed on the active URL. Ported verbatim from
// page.js (resolveItemId/loadTagsForCurrentPage/renderTags/add/removeTagToPage).
function normalizeUrlForCompare(u) {
  try {
    const parsed = new URL(u);
    if (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) {
      parsed.port = '';
    }
    if (parsed.search) {
      const params = new URLSearchParams(parsed.search);
      const sortedParams = new URLSearchParams([...params.entries()].sort());
      parsed.search = sortedParams.toString();
    }
    return parsed.toString();
  } catch { return u; }
}

async function resolveItemId(url) {
  if (!isHttp(url)) return null;
  try {
    const result = await api.datastore.queryItems({ type: 'url', search: url });
    if (result.success && result.data && result.data.length > 0) {
      const normalUrl = normalizeUrlForCompare(url);
      const exact = result.data.find((item) => normalizeUrlForCompare(item.content) === normalUrl);
      if (exact) return exact.id;
      return result.data[0].id;
    }
  } catch (err) {
    DEBUG && console.log('[overlay] resolveItemId failed:', err.message);
  }
  return null;
}

async function loadTagsForUrl(token, url) {
  if (!isHttp(url)) return;
  const itemId = await resolveItemId(url);
  if (token !== panelToken) return; // active window changed mid-resolve
  currentItemId = itemId;
  if (!itemId) {
    currentPageTags = [];
    renderTags();
    loadAllTags();
    return;
  }
  try {
    const result = await api.datastore.getItemTags(itemId);
    if (token !== panelToken) return;
    currentPageTags = (result.success && result.data) ? result.data : [];
  } catch (err) {
    DEBUG && console.log('[overlay] load tags failed:', err.message);
    currentPageTags = [];
  }
  renderTags();
  loadAllTags();
}

async function loadAllTags() {
  try {
    const result = await api.datastore.getTagsByFrecency();
    if (result.success && result.data) allTagsCache = result.data;
  } catch (err) {
    DEBUG && console.log('[overlay] loadAllTags failed:', err.message);
  }
}

function renderTags() {
  if (!tagsList) return;
  tagsList.innerHTML = '';
  for (const tag of currentPageTags) {
    const btn = document.createElement('button');
    btn.className = 'tag-btn';
    btn.title = `Remove tag: ${tag.name}`;
    const nameSpan = document.createElement('span');
    nameSpan.className = 'tag-name';
    nameSpan.textContent = tag.name;
    btn.appendChild(nameSpan);
    const removeSpan = document.createElement('span');
    removeSpan.className = 'tag-remove';
    removeSpan.textContent = '×';
    btn.appendChild(removeSpan);
    btn.addEventListener('click', () => { removeTagFromPage(tag.id, tag.name); });
    tagsList.appendChild(btn);
  }
  // The Tags panel always offers the add-tag input, so it always has-data once
  // an active URL is set (matches page.js always showing it alongside chrome).
  if (tagsPanel) tagsPanel.classList.add('has-data');
}

async function addTagToPage(tagName) {
  if (!tagName) return;
  tagName = tagName.trim().toLowerCase();
  if (!tagName || !isHttp(activeUrl)) return;
  const token = panelToken;
  if (!currentItemId) {
    try {
      const found = await api.datastore.findUrlItem(activeUrl);
      if (token !== panelToken) return;
      if (found?.success && found.data) {
        currentItemId = found.data.id;
      } else {
        const created = await api.datastore.addItem('url', { content: activeUrl });
        if (token !== panelToken) return;
        if (!created?.success || !created.data?.id) {
          console.warn('[overlay] addTagToPage: failed to create item for URL:', activeUrl);
          return;
        }
        currentItemId = created.data.id;
      }
    } catch (err) {
      console.error('[overlay] addTagToPage: error resolving item id:', err);
      return;
    }
  }
  if (currentPageTags.some((t) => t.name.toLowerCase() === tagName)) return;
  try {
    const tagResult = await api.datastore.getOrCreateTag(tagName);
    if (!tagResult.success || !tagResult.data) return;
    const tagId = tagResult.data.tag.id;
    const result = await api.datastore.tagItem(currentItemId, tagId);
    if (token !== panelToken) return;
    if (result.success) {
      await loadTagsForUrl(token, activeUrl);
      loadAllTags();
    }
  } catch (err) {
    console.error('[overlay] addTagToPage failed:', err);
  }
}

async function removeTagFromPage(tagId) {
  if (!currentItemId || !tagId) return;
  const token = panelToken;
  try {
    const result = await api.datastore.untagItem(currentItemId, tagId);
    if (token !== panelToken) return;
    if (result.success) await loadTagsForUrl(token, activeUrl);
  } catch (err) {
    console.error('[overlay] removeTagFromPage failed:', err);
  }
}

if (tagsInput) {
  tagsInput.addEventListener('input', () => {
    const query = tagsInput.value.trim().toLowerCase();
    if (!query) { if (tagsSuggestion) tagsSuggestion.textContent = ''; return; }
    const appliedNames = new Set(currentPageTags.map((t) => t.name.toLowerCase()));
    const match = allTagsCache.find((t) =>
      t.name.toLowerCase().startsWith(query) && !appliedNames.has(t.name.toLowerCase()));
    if (match && tagsSuggestion) {
      tagsSuggestion.textContent = tagsInput.value + match.name.slice(query.length);
    } else if (tagsSuggestion) {
      tagsSuggestion.textContent = '';
    }
  });
  tagsInput.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && tagsSuggestion && tagsSuggestion.textContent) {
      e.preventDefault();
      tagsInput.value = tagsSuggestion.textContent;
      tagsSuggestion.textContent = '';
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const value = tagsInput.value.trim();
      if (value) {
        const names = value.split(',').map((t) => t.trim()).filter(Boolean);
        for (const name of names) addTagToPage(name);
        tagsInput.value = '';
        if (tagsSuggestion) tagsSuggestion.textContent = '';
      }
    } else if (e.key === 'Escape') {
      tagsInput.value = '';
      if (tagsSuggestion) tagsSuggestion.textContent = '';
      tagsInput.blur();
      e.stopPropagation();
    }
  });
}

// React to tag pubsub — refresh when our item's tags change. Active-URL-keyed.
api.subscribe('tag:item-added', async (msg) => {
  if (!msg || !msg.itemId) return;
  if (msg.itemId === currentItemId) { loadTagsForUrl(panelToken, activeUrl); loadAllTags(); return; }
  // Adopt a freshly-created item whose URL matches our active page.
  try {
    const lookup = await api.datastore.getItem(msg.itemId);
    if (lookup?.success && lookup.data && isHttp(activeUrl)
        && normalizeUrlForCompare(lookup.data.content) === normalizeUrlForCompare(activeUrl)) {
      currentItemId = msg.itemId;
      loadTagsForUrl(panelToken, activeUrl);
    }
  } catch { /* ignore */ }
  loadAllTags();
});
api.subscribe('tag:item-removed', (msg) => {
  if (msg && msg.itemId === currentItemId) loadTagsForUrl(panelToken, activeUrl);
});
api.subscribe('tag:created', () => { loadAllTags(); });

// ── Entities ────────────────────────────────────────────────────────────────
// Request entities for the active URL from the entities feature via pubsub; the
// response (and proactive `entities:extracted`) is active-URL-keyed. Ported from
// page.js renderEntities + the get-for-url / extracted handlers.
function requestEntities(token, url) {
  if (token !== panelToken || !isHttp(url)) return;
  if (entitiesBody) entitiesBody.innerHTML = '<div class="entity-loading">Scanning for entities...</div>';
  api.publish('entities:get-for-url', { url });
}

function entitiesUrlMatches(url) {
  return isHttp(url) && isHttp(activeUrl) && url === activeUrl;
}

api.subscribe('entities:extracted', (msg) => {
  if (!msg || !msg.url || !msg.entities || !entitiesUrlMatches(msg.url)) return;
  currentPageEntities = msg.entities;
  renderEntities(currentPageEntities);
});
api.subscribe('entities:get-for-url:response', (msg) => {
  if (!msg || !msg.url || !msg.entities || !entitiesUrlMatches(msg.url)) return;
  if (msg.entities.length === 0) { renderEntities([]); return; }
  currentPageEntities = msg.entities.map((e) => {
    let meta = {};
    try { meta = JSON.parse(e.metadata || '{}'); } catch { /* not json */ }
    return {
      name: e.content || e.title,
      type: meta.entityType || 'other',
      confidence: meta.confidence || 0,
      visitCount: e.visitCount || 0,
    };
  });
  renderEntities(currentPageEntities);
});

if (entitiesRescanBtn) {
  entitiesRescanBtn.addEventListener('click', () => {
    if (!isHttp(activeUrl)) return;
    currentPageEntities = [];
    if (entitiesBody) entitiesBody.innerHTML = '<div class="entity-loading">Rescanning for entities...</div>';
    api.publish('entities:extract', { url: activeUrl });
  });
}

function renderEntities(entities) {
  if (!entitiesBody) return;
  if (entitiesPanel) entitiesPanel.classList.add('has-data');
  if (!entities || entities.length === 0) {
    entitiesBody.innerHTML = '<div class="entity-empty">No entities detected</div>';
    return;
  }
  const groups = {};
  for (const entity of entities) {
    const type = entity.type || entity.entityType || 'other';
    if (!groups[type]) groups[type] = [];
    groups[type].push(entity);
  }
  const typeOrder = ['person', 'organization', 'place', 'event', 'email', 'phone', 'product', 'creative_work', 'date', 'tracking_number', 'other'];
  const typeLabels = {
    person: 'People', organization: 'Organizations', place: 'Places', event: 'Events',
    email: 'Emails', phone: 'Phones', product: 'Products', creative_work: 'Works',
    date: 'Dates', tracking_number: 'Tracking', other: 'Other',
  };
  const sortedTypes = Object.keys(groups).sort((a, b) => {
    const ai = typeOrder.indexOf(a); const bi = typeOrder.indexOf(b);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
  entitiesBody.innerHTML = '';
  for (const type of sortedTypes) {
    const groupEl = document.createElement('div');
    groupEl.className = 'entity-group';
    const label = document.createElement('div');
    label.className = 'entity-group-label';
    label.textContent = typeLabels[type] || type;
    groupEl.appendChild(label);
    for (const entity of groups[type]) {
      const item = document.createElement('div');
      item.className = 'entity-item';
      const badge = document.createElement('span');
      badge.className = `entity-badge ${type}`;
      item.appendChild(badge);
      const nameSpan = document.createElement('span');
      nameSpan.textContent = entity.name || entity.content || '';
      item.appendChild(nameSpan);
      if (entity.visitCount > 0) {
        const count = document.createElement('span');
        count.className = 'entity-count';
        count.textContent = entity.visitCount;
        item.appendChild(count);
      }
      groupEl.appendChild(item);
    }
    entitiesBody.appendChild(groupEl);
  }
}

// ── Extensions ──────────────────────────────────────────────────────────────
// api.chromeExtensions + api.adblocker, keyed on the active URL's hostname.
// Ported verbatim from page.js loadExtensionsPanel + renderAdblockerEntry.
function hostnameForActive() {
  if (!isHttp(activeUrl)) return null;
  try { return new URL(activeUrl).hostname; } catch { return null; }
}

async function loadExtensionsPanel(token) {
  if (!extensionsBody || token !== panelToken) return;
  try {
    const [extResult, uiResult, adStatus] = await Promise.all([
      api.chromeExtensions.list(),
      api.chromeExtensions.getUiEntries(),
      api.adblocker.getStatus(),
    ]);
    if (token !== panelToken) return;
    const extensions = (extResult.success && extResult.data) ? extResult.data : [];
    const uiEntries = (uiResult.success && uiResult.data) ? uiResult.data : [];
    adblockerGlobalEnabled = adStatus.success && adStatus.data?.enabled;

    const hostname = hostnameForActive();
    currentSiteHostname = hostname;
    if (hostname && adblockerGlobalEnabled) {
      const siteResult = await api.adblocker.isSiteAllowed(hostname);
      if (token !== panelToken) return;
      currentSiteAdblockAllowed = siteResult.success && siteResult.data;
    } else {
      currentSiteAdblockAllowed = false;
    }

    const popupMap = new Map();
    const optionsMap = new Map();
    for (const entry of uiEntries) {
      if (entry.type === 'popup') popupMap.set(entry.extensionId, entry);
      else if (entry.type === 'options') optionsMap.set(entry.extensionId, entry);
    }
    const enabledExts = extensions.filter((ext) => ext.enabled);

    extensionsBody.innerHTML = '';
    renderAdblockerEntry();

    if (enabledExts.length === 0) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'ext-empty';
      emptyEl.textContent = 'No extensions enabled';
      extensionsBody.appendChild(emptyEl);
    } else {
      for (const ext of enabledExts) {
        const item = document.createElement('div');
        item.className = 'ext-item';
        const header = document.createElement('div');
        header.className = 'ext-item-header';
        const icon = document.createElement('span');
        icon.className = 'ext-icon';
        icon.textContent = '🧩';
        header.appendChild(icon);
        const info = document.createElement('div');
        info.className = 'ext-info';
        const name = document.createElement('div');
        name.className = 'ext-name';
        name.textContent = ext.name;
        name.title = ext.description || ext.name;
        info.appendChild(name);
        header.appendChild(info);
        item.appendChild(header);
        const popupEntry = popupMap.get(ext.id);
        const optionsEntry = optionsMap.get(ext.id);
        if (popupEntry || optionsEntry) {
          const actions = document.createElement('div');
          actions.className = 'ext-actions';
          if (popupEntry) {
            const popupBtn = document.createElement('button');
            popupBtn.className = 'ext-action-btn';
            popupBtn.textContent = 'Open';
            popupBtn.title = `Open ${ext.name} popup`;
            popupBtn.addEventListener('click', () => { api.chromeExtensions.openPage(ext.id, 'popup'); });
            actions.appendChild(popupBtn);
          }
          if (optionsEntry) {
            const settingsBtn = document.createElement('button');
            settingsBtn.className = 'ext-action-btn';
            settingsBtn.textContent = 'Settings';
            settingsBtn.title = `Open ${ext.name} settings`;
            settingsBtn.addEventListener('click', () => { api.chromeExtensions.openPage(ext.id, 'options'); });
            actions.appendChild(settingsBtn);
          }
          item.appendChild(actions);
        }
        extensionsBody.appendChild(item);
      }
    }
    if (extensionsPanel) extensionsPanel.classList.add('has-data');
  } catch (err) {
    console.warn('[overlay] Failed to load extensions panel:', err.message);
    if (extensionsBody) extensionsBody.innerHTML = '<div class="ext-empty">Could not load extensions</div>';
    if (extensionsPanel) extensionsPanel.classList.add('has-data');
  }
}

function renderAdblockerEntry() {
  if (!extensionsBody) return;
  const item = document.createElement('div');
  item.className = 'ext-item';
  item.id = 'ext-adblocker-item';
  const icon = document.createElement('span');
  icon.className = 'ext-icon';
  icon.textContent = '🛡️';
  item.appendChild(icon);
  const info = document.createElement('div');
  info.className = 'ext-info';
  const name = document.createElement('div');
  name.className = 'ext-name';
  name.textContent = 'Ad Blocker';
  info.appendChild(name);
  if (currentSiteHostname) {
    const status = document.createElement('div');
    status.className = 'ext-adblocker-status';
    if (!adblockerGlobalEnabled) status.textContent = 'Disabled globally';
    else if (currentSiteAdblockAllowed) status.textContent = `Ads allowed on ${currentSiteHostname}`;
    else status.textContent = `Blocking ads on ${currentSiteHostname}`;
    info.appendChild(status);
  }
  item.appendChild(info);
  if (adblockerGlobalEnabled && currentSiteHostname) {
    const toggle = document.createElement('label');
    toggle.className = 'ext-toggle';
    toggle.title = currentSiteAdblockAllowed
      ? `Enable ad blocking on ${currentSiteHostname}`
      : `Disable ad blocking on ${currentSiteHostname}`;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !currentSiteAdblockAllowed;
    input.addEventListener('change', async () => {
      const shouldBlock = input.checked;
      try {
        if (shouldBlock) { await api.adblocker.disallowSite(currentSiteHostname); currentSiteAdblockAllowed = false; }
        else { await api.adblocker.allowSite(currentSiteHostname); currentSiteAdblockAllowed = true; }
        const existing = document.getElementById('ext-adblocker-item');
        if (existing) {
          const nextSibling = existing.nextSibling;
          existing.remove();
          renderAdblockerEntry();
          const newItem = document.getElementById('ext-adblocker-item');
          if (newItem && nextSibling) extensionsBody.insertBefore(newItem, nextSibling);
        }
      } catch (err) {
        console.error('[overlay] Adblocker toggle failed:', err);
        input.checked = !shouldBlock;
      }
    });
    const track = document.createElement('span');
    track.className = 'ext-toggle-track';
    toggle.appendChild(input);
    toggle.appendChild(track);
    item.appendChild(toggle);
  }
  if (extensionsBody.firstChild) extensionsBody.insertBefore(item, extensionsBody.firstChild);
  else extensionsBody.appendChild(item);
}

// ── Panel collapse toggles (REUSED from page.js: built-in panel headers) ──────
for (const toggle of document.querySelectorAll('.panel-toggle')) {
  const header = toggle.closest('.panel-header');
  const panel = header?.parentElement;
  const bodyWrap = panel?.querySelector('.panel-body-wrap');
  if (!bodyWrap) continue;
  toggle.addEventListener('click', () => {
    const collapsed = bodyWrap.classList.toggle('collapsed');
    toggle.classList.toggle('collapsed', collapsed);
  });
}

// ── P1.4b-6: NOTES panel ──────────────────────────────────────────────────────
// PageNotesPane is the SAME class the canvas page.js mounts; it is URL-keyed via
// api.datastore (no main routing). The overlay mounts it once into the right
// stack, subscribes (init), and re-keys it per active window via loadForUrl. The
// overlay manages the panel's .has-data flag (the rest of the overlay's panels do
// too) so it shows alongside the chrome only once notes are loaded for an active
// http URL — NOT page.js's per-element `.visible` toggling.
const pageNotesPane = new PageNotesPane();
const notesPanel = pageNotesPane.getElement();
notesPanel.classList.add('interactive'); // join the click-capture set
const notesPanelAnchor = document.getElementById('notes-panel-anchor');
if (notesPanelAnchor) notesPanelAnchor.replaceWith(notesPanel);
pageNotesPane.init();
// Bind the chrome-hover keep-open behavior now that the element is mounted (the
// earlier querySelectorAll loop ran before this replace).
notesPanel.addEventListener('mouseenter', () => { showNavbar(); });
notesPanel.addEventListener('mouseleave', scheduleHide);

function loadNotesForUrl(token, url) {
  if (token !== panelToken || !isHttp(url)) return;
  // The Notes panel always offers its add-note affordance, so it has-data once an
  // active http URL is set (matches the Tags panel + page.js always showing it).
  notesPanel.classList.add('has-data');
  pageNotesPane.loadForUrl(url);
}

function clearNotes() {
  notesPanel.classList.remove('has-data');
  // Clear the notes list back to empty for the no-longer-active window.
  pageNotesPane.loadForUrl(null);
}

// ── P1.4b-6: page WIDGETS ─────────────────────────────────────────────────────
// addWidget/removeWidget/updateWidget registry ported verbatim from page.js
// (page.js ~3030), rendering into #widget-container. createPageWidgetHost feeds it
// for extension widgets; the OpenSearch-discovery + space-mode widgets use it
// directly. All widgets belong to the ACTIVE window and are removed on
// retarget/null (clearWidgets, called from clearPanels). The container's .has-data
// flag gates its visibility with the rest of the chrome.
const widgetContainer = document.getElementById('widget-container');
const widgets = new Map();

function syncWidgetContainerData() {
  if (!widgetContainer) return;
  if (widgets.size > 0) widgetContainer.classList.add('has-data');
  else widgetContainer.classList.remove('has-data');
}

function addWidget(id, { title, content, autoDismiss = 0, onClose, closable = true, collapsible = true } = {}) {
  if (widgets.has(id)) removeWidget(id);

  const el = document.createElement('div');
  el.className = 'widget';
  el.dataset.widgetId = id;

  const header = document.createElement('div');
  header.className = 'widget-header';

  let toggle = null;
  if (collapsible) {
    toggle = document.createElement('button');
    toggle.className = 'widget-toggle';
    toggle.textContent = '▼';
    toggle.title = 'Collapse';
    header.appendChild(toggle);
  }

  const titleEl = document.createElement('span');
  titleEl.className = 'widget-title';
  titleEl.textContent = title || '';
  header.appendChild(titleEl);

  if (closable) {
    const closeBtn = document.createElement('button');
    closeBtn.className = 'widget-close';
    closeBtn.textContent = '×';
    closeBtn.title = 'Dismiss';
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); removeWidget(id); });
    header.appendChild(closeBtn);
  }
  el.appendChild(header);

  const bodyWrap = document.createElement('div');
  bodyWrap.className = 'widget-body-wrap';
  const body = document.createElement('div');
  body.className = 'widget-body';
  if (typeof content === 'string') body.innerHTML = content;
  else if (content instanceof HTMLElement) body.appendChild(content);
  bodyWrap.appendChild(body);
  el.appendChild(bodyWrap);

  if (toggle) {
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const collapsed = toggle.classList.toggle('collapsed');
      bodyWrap.classList.toggle('collapsed', collapsed);
      toggle.title = collapsed ? 'Expand' : 'Collapse';
    });
  }

  widgetContainer.appendChild(el);
  const timers = [];
  requestAnimationFrame(() => { el.classList.add('visible'); });
  if (autoDismiss > 0) timers.push(setTimeout(() => removeWidget(id), autoDismiss));

  const handle = { element: el, body, timers, onClose, close: () => removeWidget(id) };
  widgets.set(id, handle);
  syncWidgetContainerData();
  DEBUG && console.log('[overlay] Widget added:', id, title);
  return handle;
}

function removeWidget(id) {
  const handle = widgets.get(id);
  if (!handle) return;
  for (const timer of handle.timers) clearTimeout(timer);
  handle.element.classList.remove('visible');
  handle.element.classList.add('hiding');
  setTimeout(() => {
    if (handle.element.isConnected) handle.element.remove();
  }, 300);
  if (handle.onClose) { try { handle.onClose(); } catch { /* ignore */ } }
  widgets.delete(id);
  syncWidgetContainerData();
  DEBUG && console.log('[overlay] Widget removed:', id);
}

function updateWidget(id, { content, title } = {}) {
  const handle = widgets.get(id);
  if (!handle) return;
  if (title !== undefined) {
    const titleEl = handle.element.querySelector('.widget-title');
    if (titleEl) titleEl.textContent = title;
  }
  if (content !== undefined) {
    if (typeof content === 'string') handle.body.innerHTML = content;
    else if (content instanceof HTMLElement) { handle.body.innerHTML = ''; handle.body.appendChild(content); }
  }
  DEBUG && console.log('[overlay] Widget updated:', id);
}

// Remove every widget at once and reset per-window widget state. Called on the
// retarget/null boundary (clearPanels) — synchronous DOM clear, no 300ms fade, so
// the next active window starts with an empty container.
function clearWidgets() {
  for (const handle of widgets.values()) {
    for (const timer of handle.timers) clearTimeout(timer);
    if (handle.element.isConnected) handle.element.remove();
    if (handle.onClose) { try { handle.onClose(); } catch { /* ignore */ } }
  }
  widgets.clear();
  // Drop the OpenSearch rendezvous state so a stale discovery/confirm can't
  // render a card for the next active window after retarget.
  activeDiscoveryArmed = false;
  lastUnrenderedEngine = null;
  // The space-mode widget is app-wide (mode context), not per-window: re-evaluate
  // it after the clear so it reappears for the newly-active window if in a space.
  syncWidgetContainerData();
  updateSpaceModeWidget();
}

// --- Page Widget Host (extension-provided widgets via pubsub) ---
// The hybrid content webContents is MAIN-owned; the overlay has no <webview>
// element, so script-exec requests are not serviced here (extensions that need
// page-script exec run against the canvas path). Widget register/render/update/
// close still work — they only touch the overlay-owned container.
const pageWidgetHost = createPageWidgetHost({
  api,
  webview: null,
  widgetContainer,
  addWidget,
  updateWidget,
  removeWidget,
});
pageWidgetHost.init();
if (typeof window !== 'undefined') window.__pageWidgetHost = pageWidgetHost;

// --- OpenSearch discovery widget (gated to the ACTIVE window) ---
// Canvas page.js renders this off the global `websearch:engine-discovered`
// (payload {engine}); each canvas window is its own page so the global event is
// implicitly window-scoped. The overlay is ONE renderer for N windows, so the
// card must render only for the ACTIVE window's discovery.
//
// Two topics correlate to do this, and they can arrive in EITHER order:
//   - `page:search-engine-discovered {windowId, pageUrl}` — main's per-window,
//     windowId-tagged signal (P1.3) that the active page advertised a descriptor.
//   - `websearch:engine-discovered {engine}` — the websearch feature's confirm
//     after it fetches/parses/records the descriptor; it carries the engine name
//     but NO windowId, so it can't self-attribute to a window.
// In production the confirm follows the discovery (a real fetch takes time), but
// pubsub delivery order between the two topics is NOT guaranteed (the discovery
// topic is also a lazy-wake trigger, intercepted by tile-lazy, which can reorder
// it relative to the plain confirm topic). So this is an order-INDEPENDENT
// rendezvous: we remember the most recent unrendered confirm engine AND whether
// the active window has fired a discovery; whichever arrives second renders the
// card. Foreign-window discoveries never set the active-armed flag → a confirm
// without an active discovery never renders. Both are reset on retarget/null
// (clearWidgets) so a stale confirm can't bleed into the next active window.
let activeDiscoveryArmed = false;
let lastUnrenderedEngine = null;

function maybeRenderOpenSearchWidget() {
  if (!activeDiscoveryArmed || !lastUnrenderedEngine || activeWindowId == null) return;
  const engine = lastUnrenderedEngine;
  // Consume both sides of the rendezvous so the same engine isn't re-rendered on
  // a subsequent unrelated discovery/confirm.
  activeDiscoveryArmed = false;
  lastUnrenderedEngine = null;

  const widgetId = `opensearch-${engine.id}`;
  DEBUG && console.log('[overlay] OpenSearch engine discovered:', engine.name);

  const contentEl = document.createElement('div');
  const infoRow = document.createElement('div');
  infoRow.className = 'widget-engine-found';
  const iconSpan = document.createElement('span');
  iconSpan.className = 'widget-engine-icon';
  iconSpan.textContent = '🔍';
  const nameSpan = document.createElement('span');
  nameSpan.className = 'widget-engine-name';
  nameSpan.textContent = engine.name;
  infoRow.appendChild(iconSpan);
  infoRow.appendChild(nameSpan);
  contentEl.appendChild(infoRow);
  const actionBtn = document.createElement('button');
  actionBtn.className = 'widget-action-btn confirmed';
  actionBtn.textContent = '✓ Added to search engines';
  contentEl.appendChild(actionBtn);

  addWidget(widgetId, {
    title: 'Search engine found',
    content: contentEl,
    autoDismiss: 8000,
  });
}

api.subscribe('page:search-engine-discovered', (msg) => {
  if (!isActive(msg)) return;
  activeDiscoveryArmed = true;
  maybeRenderOpenSearchWidget();
});

api.subscribe('websearch:engine-discovered', (msg) => {
  if (!msg || !msg.engine) return;
  lastUnrenderedEngine = msg.engine;
  maybeRenderOpenSearchWidget();
});

// --- Space mode widget (ported from page.js; mode context, app-wide) ---
const SPACE_MODE_WIDGET_ID = '__space-mode__';
let currentMode = 'page';
let currentModeMetadata = {};

function buildSpaceModeContent(metadata) {
  const container = document.createElement('div');
  container.className = 'space-mode-widget-body';
  const dot = document.createElement('span');
  dot.className = 'space-mode-dot';
  dot.style.background = metadata.color || '#9966cc';
  container.appendChild(dot);
  const name = document.createElement('span');
  name.className = 'space-mode-name';
  name.textContent = metadata.spaceName || 'Space';
  container.appendChild(name);
  return container;
}

function updateSpaceModeWidget() {
  // Only show while there's an active window (the container is hidden otherwise).
  if (activeWindowId != null && currentMode === 'space' && currentModeMetadata.spaceName) {
    if (widgets.has(SPACE_MODE_WIDGET_ID)) {
      updateWidget(SPACE_MODE_WIDGET_ID, { title: 'Space', content: buildSpaceModeContent(currentModeMetadata) });
    } else {
      addWidget(SPACE_MODE_WIDGET_ID, {
        title: 'Space',
        content: buildSpaceModeContent(currentModeMetadata),
        closable: false,
        collapsible: false,
      });
    }
    DEBUG && console.log('[overlay] Space mode widget shown:', currentModeMetadata);
  } else if (widgets.has(SPACE_MODE_WIDGET_ID)) {
    removeWidget(SPACE_MODE_WIDGET_ID);
    DEBUG && console.log('[overlay] Space mode widget removed');
  }
}

async function initModeContext() {
  try {
    const modeResult = await api.context.get('mode');
    if (modeResult.success && modeResult.data) {
      currentMode = modeResult.data.value || 'page';
      currentModeMetadata = modeResult.data.metadata || {};
      updateSpaceModeWidget();
    }
    api.context.watchMode((mode, entry) => {
      if (mode) {
        currentMode = mode;
        currentModeMetadata = entry?.metadata || {};
        updateSpaceModeWidget();
      }
    });
  } catch (err) {
    console.error('[overlay] Failed to initialize mode context:', err);
  }
}
initModeContext();

window.addEventListener('beforeunload', () => {
  try { pageWidgetHost.destroy(); } catch { /* ignore */ }
});

// Signal readiness so main can verify the renderer is wired (and tests can wait).
window.__overlayReady = true;
DEBUG && console.log('[overlay] ready');
