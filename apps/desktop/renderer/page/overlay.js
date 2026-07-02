/**
 * peek://app/page/overlay.js — the SHARED chrome overlay renderer (P1.4b-2).
 *
 * The hybrid page-host path renders each web page as a
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

// ── Canvas gutter geometry (the SPEC), mirrored from page.js + hybrid-overlay.ts.
// The overlay window is the inner content rect EXPANDED by these gutters (main
// does the expand via expandToOverlayFrame). The renderer lays out the chrome
// relative to the INNER content rect, which inside the overlay sits at
// {left: gutters.left, top: gutters.top, width: content.width, height: content.height}.
// Default gutters mirror hybrid-overlay.ts; main also sends them in the handoff
// (msg.gutters) so the two stay in sync.
//
// NOTE (round 2): edge/corner RESIZE no longer lives in the overlay. The overlay
// can capture a press but never paints a cursor (it is never the macOS first
// responder), so both the resize cursor and the drag moved to main + the content
// WC (see ipc.ts wireHybridContentEvents). The overlay keeps ONLY its chrome role
// (navbar / reveal / panels / hold-to-drag move), and stays click-through at the
// edges so the content stays topmost and main's injected resize cursor shows.
const TRIGGER_ZONE_PX = 8; // narrow border strip that triggers reveal in maximized mode
const PANEL_WIDTH = 280;  // page.js PANEL_WIDTH
const PANEL_OVERLAP = PANEL_WIDTH * 0.25;          // 70
const PANEL_OVERHANG = PANEL_WIDTH - PANEL_OVERLAP; // 210
let gutters = { left: 8 + PANEL_OVERHANG, right: 8 + PANEL_OVERHANG, top: 8 + 36, bottom: 8 };

// The inner content rect WITHIN the overlay window (overlay-local coordinates):
// the gutters inset on each side. width/height come from activeBounds (the
// content BaseWindow's size). Returns null when there is no active window.
function contentRectInOverlay() {
  if (!activeBounds) return null;
  // Maximized parity (mirrors page.js updatePositionsMaximized + the main-side
  // expandToOverlayFrame maximize check): the overlay window == the content rect
  // (work area, no gutter), so the chrome rings the window edge-to-edge. The
  // overlay's own viewport IS the work area when maximized, so size the content
  // rect to window.inner* rather than activeBounds (which still holds the
  // pre-maximize size — main snapped the content to the work area, but did not
  // push that back to the renderer).
  if (maximized) {
    return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  }
  return {
    left: gutters.left,
    top: gutters.top,
    width: activeBounds.width,
    height: activeBounds.height,
  };
}

// Position every chrome element relative to the inner content rect so the chrome
// lives in the gutter AROUND the content and the center stays transparent (the
// content BaseWindow shows through). Ported from page.js updatePositions():
//   - navbar / trigger-zone / drag-zone span the content width in the top gutter
//   - left stack (page-info, extensions) in the LEFT gutter, overlapping the
//     content edge by PANEL_OVERLAP; right stack (widgets, tags, notes, entities)
//     in the RIGHT gutter, each with a CUMULATIVE top offset so they STACK
//     instead of piling at the same top (the reported bug).
function updateOverlayPositions() {
  const r = contentRectInOverlay();
  if (!r) return;
  const left = r.left;
  const top = r.top;
  const w = r.width;
  const h = r.height;
  const navOffset = gutters.top; // navbar band + trigger zone above content

  // Navbar: spans the content width, pinned to the top of the window (page.js
  // navbar.top = 0). Trigger zone: the strip between the window top and content.
  navbar.style.left = `${left}px`;
  navbar.style.top = `0px`;
  navbar.style.width = `${w}px`;

  triggerZone.style.left = `${left}px`;
  triggerZone.style.top = `0px`;
  triggerZone.style.width = `${w}px`;
  // In maximized mode the overlay frame == the content rect (no gutter), so the
  // trigger zone would cover 44px of live content. Narrow it to the 8px border
  // strip so reveal only fires when the cursor actually hits the top edge.
  // In guttered (non-maximized) mode the trigger zone sits in the transparent
  // gutter above the content — keep it at the full navOffset (44px) there.
  triggerZone.style.height = `${maximized ? TRIGGER_ZONE_PX : navOffset}px`;

  // Drag-zone: invisible move strip in the top gutter over the content width.
  dragZone.style.left = `${left}px`;
  dragZone.style.top = `0px`;
  dragZone.style.width = `${w}px`;
  dragZone.style.height = `${navOffset}px`;

  // Find bar: top-right corner of the content rect. Pin its right edge 8px inside
  // the content's right edge via left (overlay-local), so it stays correct in
  // both gutter and maximized modes (right:0 would be the window/gutter edge).
  if (findBar) {
    findBar.style.right = '';
    // Approx find-bar width ~320px; place its left so it hugs the content right.
    findBar.style.left = `${left + w - 8 - findBar.offsetWidth}px`;
    findBar.style.top = `${top + 4}px`;
  }

  // (Round 2: no resize handles here — resize is main-driven against the content
  // WC; see ipc.ts. The overlay no longer rings the content rect with handles.)

  // Panel top offset — clearance below the content top edge (page.js
  // panelTopOffset = webviewTop + 40, where webviewTop === navOffset here).
  const panelTopOffset = top + 40;

  // Left gutter stack: page-info, then extensions below. left = content edge -
  // PANEL_WIDTH + PANEL_OVERLAP (mostly in the gutter, 70px overlaps content).
  const leftStackLeft = left - PANEL_WIDTH + PANEL_OVERLAP;
  let leftStackTop = panelTopOffset;
  const pageInfoEl = document.getElementById('page-info-panel');
  const extEl = document.getElementById('extensions-panel');
  if (pageInfoEl) {
    pageInfoEl.style.left = `${leftStackLeft}px`;
    pageInfoEl.style.top = `${leftStackTop}px`;
    const visH = pageInfoEl.classList.contains('has-data') ? pageInfoEl.offsetHeight : 0;
    if (visH > 0) leftStackTop += visH + 12;
  }
  if (extEl) {
    extEl.style.left = `${leftStackLeft}px`;
    extEl.style.top = `${leftStackTop}px`;
  }

  // Right gutter stack: widgets (top), then tags, notes, entities — each offset
  // by the previous element's height so they STACK (page.js rightStackTop math).
  const rightStackLeft = left + w - PANEL_OVERLAP;
  let rightStackTop = panelTopOffset;
  const widgetEl = document.getElementById('widget-container');
  const tagsEl = document.getElementById('tags-panel');
  const notesEl = document.querySelector('.notes-panel');
  const entitiesEl = document.getElementById('entities-panel');
  const stackRight = (el, hasDataGated) => {
    if (!el) return;
    el.style.left = `${rightStackLeft}px`;
    el.style.top = `${rightStackTop}px`;
    const shown = hasDataGated ? el.classList.contains('has-data') : true;
    const visH = shown && el.offsetHeight > 0 ? el.offsetHeight : 0;
    if (visH > 0) rightStackTop += visH + 12;
  };
  stackRight(widgetEl, true);
  stackRight(tagsEl, true);
  stackRight(notesEl, true);
  stackRight(entitiesEl, true);

  // Stage B: position the load-error overlay over the content rect so it fills
  // exactly the "page area" and tracks window resizes. The overlay is fixed and
  // dynamically created, so we set its geometry here each time positions change.
  const errorOverlay = document.querySelector('.load-error-overlay');
  if (errorOverlay) {
    errorOverlay.style.left = `${left}px`;
    errorOverlay.style.top = `${top}px`;
    errorOverlay.style.width = `${w}px`;
    errorOverlay.style.height = `${h}px`;
  }
}

// Coalesced re-layout: a panel/widget gaining or losing `.has-data` (async, as
// data loads) changes the cumulative stack heights, so re-run the gutter layout.
// rAF-coalesced so a burst of data arrivals reflows once.
let relayoutPending = false;
function relayoutChrome() {
  if (relayoutPending) return;
  relayoutPending = true;
  requestAnimationFrame(() => {
    relayoutPending = false;
    updateOverlayPositions();
  });
}

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

// ── Stage B: branded load-error overlay ──────────────────────────────────────
// One `.load-error-overlay` div is dynamically created / removed per error
// event, matching the canvas page.js approach (showLoadErrorOverlay /
// clearLoadErrorOverlay in page.js ~2485-2553). The overlay is:
//   - Shown/cleared by paintFromSnapshot (on active-window change, reads snap.loadError)
//   - Shown/cleared by the page:load-error subscriber (live update for the active window)
//   - Cleared by clearChrome (active → null, or before painting a new window)
// Position (left/top/width/height) is applied in updateOverlayPositions() so
// the card stays over the content rect even as the user resizes the window.
// FSM alignment: per-host state rides the EXISTING deterministic
// sendActiveHandoff / paintFromSnapshot path; live updates are published from
// main only for the currently-active window — exactly one code path, no timers.

/** Remove any existing load-error overlay (called on new nav start or success). */
function clearLoadErrorOverlay() {
  const existing = document.querySelector('.load-error-overlay');
  if (existing) existing.remove();
}

/**
 * Show the branded load-error card over the content rect. Creates the element
 * dynamically (matching canvas); clears any prior instance first (idempotent).
 * Retry publishes `page:reload`; Close publishes `page:close-window`.
 * The overlay is `.interactive` so the click-capture loop turns the overlay
 * pointer-opaque while the user reads the error or clicks a button.
 */
function showLoadErrorOverlay(failedUrl, errorCode, errorDescription) {
  // Ignore Chromium's internal error-page navigations (chrome-error://).
  if (!failedUrl || failedUrl.startsWith('chrome-error://')) return;
  clearLoadErrorOverlay();

  const overlay = document.createElement('div');
  overlay.className = 'load-error-overlay interactive';

  const card = document.createElement('div');
  card.className = 'load-error-card';

  const icon = document.createElement('div');
  icon.className = 'load-error-icon';
  icon.textContent = '⚠'; // ⚠

  const title = document.createElement('div');
  title.className = 'load-error-title';
  title.textContent = 'This page didn’t load'; // "This page didn't load"

  const reason = document.createElement('div');
  reason.className = 'load-error-reason';
  reason.textContent = errorDescription
    ? `${errorDescription} (${errorCode})`
    : `Load failed (${errorCode})`;

  const urlEl = document.createElement('div');
  urlEl.className = 'load-error-url';
  urlEl.textContent = failedUrl;

  const actions = document.createElement('div');
  actions.className = 'load-error-actions';

  const retry = document.createElement('button');
  retry.className = 'load-error-retry';
  retry.textContent = 'Retry';
  retry.addEventListener('click', () => {
    if (activeWindowId == null) return;
    clearLoadErrorOverlay();
    api.publish('page:reload', { windowId: activeWindowId });
  });

  const close = document.createElement('button');
  close.className = 'load-error-close';
  close.textContent = 'Close window';
  close.addEventListener('click', () => {
    if (activeWindowId == null) return;
    api.publish('page:close-window', { windowId: activeWindowId });
  });

  actions.appendChild(retry);
  actions.appendChild(close);
  card.appendChild(icon);
  card.appendChild(title);
  card.appendChild(reason);
  card.appendChild(urlEl);
  card.appendChild(actions);
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  // Arm the click-capture loop for the dynamically-created .interactive element
  // (the querySelectorAll('.interactive') at init time only covers static HTML).
  overlay.addEventListener('mouseenter', () => setCapture(true));
  overlay.addEventListener('mouseleave', () => {
    requestAnimationFrame(() => {
      const over = document.querySelector('.interactive:hover');
      if (!over) setCapture(false);
    });
  });

  // Position the overlay over the current content rect now that it's in the DOM.
  updateOverlayPositions();
}

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
  clearLoadErrorOverlay();
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
  // Stage B: restore the per-host error state for the newly-active window so the
  // error card shows (or stays gone) instantly on retarget — no flash of the
  // wrong window's state. Rides the same deterministic handoff path as
  // navbar.loading — no extra timer or separate IPC.
  if (snap.loadError) {
    showLoadErrorOverlay(snap.loadError.failedUrl, snap.loadError.errorCode, snap.loadError.errorDescription);
  } else {
    clearLoadErrorOverlay();
  }
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
  // P1.4b-3: seed the locally-tracked CONTENT-RECT bounds for resize/move math
  // (these are the content BaseWindow's outer bounds, NOT the overlay's — the
  // overlay frame is this rect expanded by the gutters, applied by main).
  // Reset maximize state for the newly-active window (each window owns its own).
  activeBounds = msg.bounds ? { ...msg.bounds } : null;
  // Gutter geometry from main (defaults already set; keep them in sync if sent).
  if (msg.gutters) gutters = { ...msg.gutters };
  maximized = false;
  preMaxBounds = null;
  // Reposition the chrome into the gutter around the (possibly new-sized) content
  // rect so widgets/handles/panels never land over the content.
  updateOverlayPositions();
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

// Stage B: live error update for the currently-active window. Main publishes
// this only when the active window's load-error state changes (via the
// registerLoadErrorListener callback in hybrid-overlay.ts). Non-active windows
// receive their error in the next sendActiveHandoff / paintFromSnapshot.
// FSM alignment: no timer, no polling — deterministic main-side publish.
api.subscribe('page:load-error', (msg) => {
  if (!isActive(msg)) return;
  if (msg.error) {
    showLoadErrorOverlay(msg.error.failedUrl, msg.error.errorCode, msg.error.errorDescription);
  } else {
    clearLoadErrorOverlay();
  }
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
  // E2E-only deterministic signal: no hide is pending (consumed by the
  // hybrid-overlay test bridge's moveOffChromeSchedulesHide). No-op in prod.
  window.__overlayHidePending = false;
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
  // Re-stack the gutter panels now they're visible (heights are only measurable
  // once painted, so cumulative stacking must recompute on reveal).
  updateOverlayPositions();
}
function hideNavbar() {
  navbar.classList.remove('visible');
  document.body.classList.remove('chrome-visible');
  document.body.classList.remove('panels-visible');
}
function scheduleHide() {
  cancelHide();
  hideTimer = setTimeout(() => {
    window.__overlayHidePending = false;
    // Keep visible while the user is typing in the URL field.
    if (navbar.shadowRoot && navbar.shadowRoot.activeElement) return;
    hideNavbar();
  }, 400);
  // E2E-only deterministic signal: a hide is now pending. No-op in prod.
  window.__overlayHidePending = true;
}

// Cmd+L (forwarded from the content WC as page:show-navbar) — reveal the navbar
// AND focus + select the URL field for typing, mirroring page.js's
// show({focusUrl:true, source:'shortcut'}). Unlike a hover reveal, this is an
// explicit user intent to type an address, so we also flip the overlay to
// pointer-opaque (setCapture(true), same as showFindBar) — otherwise the overlay
// stays click-through and a click in the URL field would fall to the content
// window. focusUrl() rAF-defers focus+select on the navbar's URL input; the
// overlay is focusable:true and the focus-group keeps the content window active
// while the overlay holds keyboard focus, so typing + Enter works end-to-end.
function openNavbarFocused() {
  if (activeWindowId == null) return;
  showNavbar();
  setCapture(true);
  navbar.focusUrl();
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
// Whether a MAIN-driven edge/corner resize is in progress (set by the
// page-overlay:resize-active signal). While true the capture-loop stays fully
// click-through so the content WC keeps receiving the move stream that drives the
// resize AND stays topmost so main's injected resize cursor shows — the overlay
// must not go opaque (e.g. the navbar trigger zone) mid-resize or it would starve
// and freeze the drag.
let resizeActive = false;
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

// ── Reliable trigger-zone reveal (the flaky-hover fix) ────────────────────────
// FLAKINESS DIAGNOSIS: the overlay window is click-through by default
// (setIgnoreMouseEvents(true,{forward:true})). With `forward:true` Chromium
// forwards `mousemove`, but the boundary-crossing `mouseenter`/`mouseleave` (and
// the `:hover` pseudo-class the leave handler above hit-tests) are UNRELIABLE on
// a click-through window: when the pointer enters the window DIRECTLY over the
// trigger-zone strip (the common case — the strip is at the very top edge, so
// the cursor arrives there without first moving through the window's interior),
// there's no prior in-window position to cross a boundary from, so `mouseenter`
// frequently never fires. Result: hovering the top strip reveals the navbar only
// sometimes. The canvas page.js doesn't hit this because its window is NOT
// click-through — its trigger zone is a normal interactive element.
//
// FIX: drive reveal/hide from the RELIABLY-forwarded `mousemove` stream instead
// of depending on enter/leave crossings. On every move we hit-test the pointer
// against the trigger-zone band (and, while shown, the navbar + visible panels)
// and reveal + capture when inside, schedule-hide + release when outside. This
// reproduces the canvas reveal feel (navbar appears every time the pointer
// enters the top strip) and removes the trigger-zone↔navbar flicker because a
// single contiguous "is the pointer over any chrome region" test spans both —
// crossing from the trigger zone into the navbar never reads as "outside".
function pointInRect(x, y, r) {
  return r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}
function pointerOverChrome(x, y) {
  if (pointInRect(x, y, triggerZone.getBoundingClientRect())) return true;
  if (navbar.classList.contains('visible') &&
      pointInRect(x, y, navbar.getBoundingClientRect())) return true;
  // Visible side panels keep the chrome open on hover (mirrors the panel
  // mouseenter handlers above) — include them so a move from the navbar onto a
  // panel doesn't read as "outside" and collapse the chrome under the pointer.
  if (document.body.classList.contains('panels-visible')) {
    for (const p of document.querySelectorAll(
      '#page-info-panel.has-data, #tags-panel.has-data, #entities-panel.has-data, ' +
      '#extensions-panel.has-data, #widget-container, .notes-panel.has-data',
    )) {
      if (pointInRect(x, y, p.getBoundingClientRect())) return true;
    }
  }
  return false;
}
document.addEventListener('mousemove', (e) => {
  if (activeWindowId == null) return;
  // While a hold-to-drag is actively moving the window, the overlay is
  // intentionally captured (opaque); don't let the chrome hit-test release it
  // mid-drag (would drop the pointer to the content and stall the move).
  if (typeof holdDrag !== 'undefined' && holdDrag.isDragging()) return;
  // While a MAIN-driven resize is in progress, stay click-through no matter where
  // the pointer roams (incl. the top trigger zone) — going opaque would starve the
  // content WC's move stream that drives the resize. See resizeActive.
  if (resizeActive) return;
  const x = e.clientX, y = e.clientY;
  if (pointerOverChrome(x, y)) {
    showNavbar();
    setCapture(true);
  } else {
    // Outside all chrome regions: release capture so clicks fall through to the
    // content window (and so the edges stay click-through → content topmost →
    // main's injected resize cursor shows), and schedule the navbar hide.
    setCapture(false);
    scheduleHide();
  }
});

// ── P1.4b-3: window interaction (MOVE / maximize) ─────────────────────────────
// The overlay owns the navbar-drag MOVE + the maximize affordance for the active
// hybrid window. Both drive the content BaseWindow via main: the renderer computes
// new OUTER bounds (tracked locally in activeBounds, seeded from the handoff +
// kept in sync via page-overlay:bounds during a main-driven resize) and publishes
// `page:set-bounds {windowId, bounds}` (move) / `page:maximize` / `page:unmaximize`.
//
// RESIZE is NOT here (round 2): the overlay never paints a cursor (it is never the
// macOS first responder), so edge/corner resize — cursor AND drag — moved to main
// against the content WC's input-event stream (ipc.ts wireHybridContentEvents).

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

// --- Main-driven resize sync ---
// Main owns edge/corner resize (it drives baseWin.setBounds off the content WC's
// input-event stream). Two signals keep the overlay coherent with that:
//   - page-overlay:resize-active {active} — gates the capture-loop to stay
//     click-through for the whole drag (see resizeActive), so the overlay never
//     goes opaque mid-resize and starves main's move stream.
//   - page-overlay:bounds {bounds} — main pushes the host's new outer bounds each
//     resize step so the renderer's locally-tracked activeBounds (used by the
//     navbar-drag MOVE math + maximize stash) doesn't go stale.
api.subscribe('page-overlay:resize-active', (msg) => {
  if (!isActive(msg)) return;
  resizeActive = !!msg.active;
  // Entering a resize: make sure we're click-through so the content stays topmost
  // (cursor shows) and keeps receiving moves.
  if (resizeActive) setCapture(false);
});
api.subscribe('page-overlay:bounds', (msg) => {
  if (!isActive(msg) || !msg.bounds) return;
  activeBounds = { ...msg.bounds };
  updateOverlayPositions();
});

// --- Uniform hold-to-drag window move (chrome + web content) ---
// Peek-wide gesture (identical to the canvas <webview> page.js hold-to-drag,
// page.js ~1294-1592): press, hold STILL for `dragHoldDelay` (default 1s), THEN
// move → the active hybrid content window moves. There is NO instant drag — the
// prior R2 navbar-background instant drag + `#drag-zone` strip handlers are
// REMOVED. This applies UNIFORMLY over the overlay chrome (navbar / gutters /
// panels) AND the web page content.
//
// dnd / selection / click safety: ANY pointer movement beyond JITTER_TOLERANCE
// BEFORE the hold threshold fires CANCELS window-drag candidacy and lets the
// native gesture proceed untouched (link/image drag, text select, panel card
// drag, normal click). Only a deliberate still-hold-then-move drags the window.
//
// ONE state machine for both regions. Over CHROME the overlay renderer natively
// gets pointerdown/move/up. Over CONTENT the overlay is click-through above the
// main-owned WebContentsView so it never sees button-down/up there — main
// observes the content WC's `input-event` mouse stream and forwards it as
// `page-overlay:content-pointer {phase, screenX, screenY}` (ipc.ts
// wireHybridContentEvents). Both feed the SAME onDown/onMove/onUp below. On
// hold-fire the FSM flips the overlay to CAPTURE (setCapture(true)) so post-hold
// moves land on the overlay and drive the drag instead of selecting page text;
// on up it releases capture (the reveal loop re-captures if still over chrome).
const JITTER_TOLERANCE = 5; // px of movement allowed during hold without cancelling
let DRAG_HOLD_THRESHOLD = 1000; // ms, updated from prefs (mirror page.js)

// Read drag hold delay from prefs (mirror page.js ~1324-1332 exactly).
(async () => {
  try {
    const prefs = await api.app.getPrefs();
    if (prefs && typeof prefs.dragHoldDelay === 'number') {
      DRAG_HOLD_THRESHOLD = Math.max(0, prefs.dragHoldDelay * 1000);
    }
  } catch { /* prefs unavailable — keep default */ }
})();

// Pure, observable hold-to-drag state machine. Effects (capture flip, bounds
// publish, cursor) are injected so it can be unit-tested via the test bridge
// without real pointer input. State: idle → pending(hold timer) → (cancel | ready)
// → dragging. `now` is injectable for deterministic tests.
function createHoldDrag(deps) {
  const {
    getThreshold, getTolerance, canStart, onDragStart, onDragMove, onDragEnd,
    setGrabCursor, clearCursor, setSchedule, clearSchedule,
  } = deps;
  let buttonDown = false;
  let pending = false;     // hold timer running, waiting for it to fire
  let ready = false;       // hold fired; cursor 'grab'; waiting for movement
  let dragging = false;
  let timer = null;
  let startX = 0, startY = 0;

  function reset() {
    if (timer != null) { clearSchedule(timer); timer = null; }
    buttonDown = false; pending = false; ready = false; dragging = false;
  }

  function onDown(screenX, screenY) {
    // A fresh press supersedes any prior candidacy.
    if (timer != null) { clearSchedule(timer); timer = null; }
    if (!canStart()) { buttonDown = false; pending = false; ready = false; dragging = false; return; }
    buttonDown = true; pending = true; ready = false; dragging = false;
    startX = screenX; startY = screenY;
    timer = setSchedule(() => {
      timer = null;
      if (!buttonDown || !pending) return; // released or cancelled before fire
      pending = false; ready = true;
      setGrabCursor();
    }, getThreshold());
  }

  function onMove(screenX, screenY) {
    if (!buttonDown) return;
    if (pending) {
      // Pre-threshold: any movement beyond tolerance cancels candidacy so the
      // native gesture (dnd / selection / panel card drag / click) proceeds.
      const dx = Math.abs(screenX - startX);
      const dy = Math.abs(screenY - startY);
      if (dx > getTolerance() || dy > getTolerance()) {
        pending = false;
        if (timer != null) { clearSchedule(timer); timer = null; }
      }
      return;
    }
    if (ready) {
      // Hold fired, first movement → begin the actual window drag from the
      // press point (so the window tracks 1:1 with the cursor from press).
      ready = false; dragging = true;
      onDragStart(startX, startY);
    }
    if (dragging) onDragMove(screenX, screenY);
  }

  function onUp() {
    const wasDragging = dragging;
    reset();
    clearCursor();
    if (wasDragging) onDragEnd();
  }

  function onButtonsCleared() {
    // A document mousemove arrived with NO buttons pressed while we still think
    // a button is down. This is our fallback for a mouseup we didn't natively
    // see (the overlay is click-through over the content WC, so a real
    // button-up can be missed). Only honor it once the gesture has LATCHED —
    // `ready` (hold fired, grab cursor shown) or `dragging` (actively moving the
    // host) — the states where a missed release would strand a grab/drag that
    // follows the cursor forever.
    //
    // During `pending` (the hold window, before the threshold timer fires) a
    // zero-button move is almost always OS jitter: focus/blur churn retargets
    // the overlay window, its frame moves, and macOS synthesizes a buttons=0
    // mousemove at the new cursor-relative position. Treating THAT as a release
    // cancels a legitimate held-still press — the confirmed cause of the
    // hold-to-drag test flake AND a real "press cancelled by pointer jitter"
    // fragility. So ignore it while pending; a genuine release still arrives as
    // a native `mouseup`, and if it somehow didn't, the worst case is the timer
    // briefly shows the grab cursor and self-corrects on the next event.
    if (dragging || ready) onUp();
  }

  return {
    onDown, onMove, onUp, onButtonsCleared,
    isDragging: () => dragging,
    // test-only inspectors
    _state: () => ({ buttonDown, pending, ready, dragging }),
  };
}

let dragStartBx = 0;
let dragStartBy = 0;
let dragStartScreenX = 0;
let dragStartScreenY = 0;

const holdDrag = createHoldDrag({
  getThreshold: () => DRAG_HOLD_THRESHOLD,
  getTolerance: () => JITTER_TOLERANCE,
  // A window move only starts when there is an active, non-maximized window.
  canStart: () => activeWindowId != null && !!activeBounds && !maximized,
  onDragStart: (screenX, screenY) => {
    dragStartBx = activeBounds.x;
    dragStartBy = activeBounds.y;
    dragStartScreenX = screenX;
    dragStartScreenY = screenY;
    // Take over the pointer: become opaque so post-hold moves hit the overlay
    // (and the page below stops text-selecting). Restored on drag end.
    setCapture(true);
    document.body.style.cursor = 'grabbing';
  },
  onDragMove: (screenX, screenY) => {
    if (!activeBounds) return;
    activeBounds.x = dragStartBx + (screenX - dragStartScreenX);
    activeBounds.y = dragStartBy + (screenY - dragStartScreenY);
    publishBounds();
  },
  onDragEnd: () => {
    document.body.style.cursor = '';
    // Release capture; the reveal-loop mousemove re-captures if the pointer is
    // still over chrome, else the content window stays interactive.
    setCapture(false);
  },
  setGrabCursor: () => { document.body.style.cursor = 'grab'; },
  clearCursor: () => { document.body.style.cursor = ''; },
  setSchedule: (fn, ms) => setTimeout(fn, ms),
  clearSchedule: (t) => clearTimeout(t),
});

// CHROME region: the overlay renderer natively receives these. mousedown on the
// navbar BACKGROUND reaches us (the peek-navbar component stopPropagations its
// own button / URL-field mousedowns), and resize handles call stopPropagation,
// so a press here is on draggable chrome. Panel card drags move > tolerance
// before the threshold → candidacy cancels → the card drag proceeds.
navbar.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  holdDrag.onDown(e.screenX, e.screenY);
});
// Document-level move/up drive the drag once started, regardless of origin
// (mirrors page.js). The reveal-loop mousemove handler above is guarded to not
// fight capture while dragging (see that handler).
document.addEventListener('mousemove', (e) => {
  // A no-button move means "the mouse button is up" — but the FSM decides what
  // that implies per state (release only once latched; ignore mid-hold jitter).
  if (e.buttons === 0) { holdDrag.onButtonsCleared(); return; }
  holdDrag.onMove(e.screenX, e.screenY);
});
document.addEventListener('mouseup', () => holdDrag.onUp());

// CONTENT region: main forwards the page's pointer stream here (the overlay is
// click-through over the WebContentsView so it can't see content button-down/up
// natively). Same FSM. Active-window-gated (ignore foreign windows).
//
// Top-border reveal (peek 363e7cff): the overlay's own forwarded-`mousemove`
// reveal loop (above) is STARVED when the content WebContentsView is the macOS
// first responder and fills the overlay frame (the maximized / no-gutter case) —
// the content WC captures the idle moves the reveal loop needs. So main also
// forwards IDLE top-band moves as `phase:'reveal'` / `phase:'reveal-out'` (it owns
// the host geometry, so this works edge-to-edge incl. maximized). We drive the
// SAME showNavbar()/scheduleHide() the trigger-zone hover uses. The local
// reveal loop still owns the gutter case (where the overlay sees moves natively);
// both feeding showNavbar/scheduleHide is idempotent (cancelHide/scheduleHide
// guard each other), so the two paths never fight.
api.subscribe('page-overlay:content-pointer', (msg) => {
  if (!isActive(msg)) return;
  if (msg.phase === 'down') holdDrag.onDown(msg.screenX, msg.screenY);
  else if (msg.phase === 'move') holdDrag.onMove(msg.screenX, msg.screenY);
  else if (msg.phase === 'up') holdDrag.onUp();
  else if (msg.phase === 'reveal') showNavbar();
  else if (msg.phase === 'reveal-out') scheduleHide();
  // No 'edge' phase: edge/corner RESIZE is owned entirely by main (cursor +
  // drag against the content WC); the overlay only learns a resize is active via
  // page-overlay:resize-active (above) so it stays click-through during the drag.
});

// Expose the pure FSM factory + the live instance for focus-free unit coverage
// (press→move-before-threshold cancels; press→hold→move drags). Drives the REAL
// path: the bridge builds an FSM with injected fake schedule/effects and asserts
// transitions, and reads the live instance's state after synthetic events.
if (typeof globalThis !== 'undefined') {
  globalThis.__peekHoldDragTest = { createHoldDrag, holdDrag };
}

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
  // Reflow the chrome for the new mode (the window resize from main also fires
  // the window 'resize' relayout, but recompute now so there's no 1-frame gap).
  updateOverlayPositions();
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
  // Now it has layout (display:flex) — position it at the content's top-right
  // (offsetWidth is only measurable once shown).
  updateOverlayPositions();
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

// Cmd+L (forwarded from the content WC as page:show-navbar, windowId-tagged) —
// reveal the navbar and focus its URL field for typing. Gated on the active
// window so a forward for a foreign/background hybrid window is ignored (matches
// page:find above and page.js's page:show-navbar handler).
api.subscribe('page:show-navbar', (msg) => {
  if (!isActive(msg)) return;
  openNavbarFocused();
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
if (typeof window !== 'undefined') {
  window.__pageWidgetHost = pageWidgetHost;
  // Test-only: add a plain test widget so gutter-placement/stacking can be
  // verified with ≥2 widgets without depending on the OpenSearch/space-mode
  // feature plumbing. Mirrors a normal addWidget call (joins #widget-container).
  window.__overlayTestAddWidget = (id, title, content) =>
    addWidget(id, { title, content, closable: true, collapsible: true });
}

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

// Gutter re-stacking: a panel/widget gaining or losing `.has-data` (or a widget
// being added/removed) changes the cumulative stack heights. Rather than wire a
// relayout into every async data-load site, observe class/child mutations on the
// gutter regions and reflow (rAF-coalesced) so panels always STACK correctly.
const _relayoutTargets = [
  document.getElementById('page-info-panel'),
  document.getElementById('extensions-panel'),
  document.getElementById('tags-panel'),
  document.getElementById('entities-panel'),
  document.querySelector('.notes-panel'),
  document.getElementById('widget-container'),
].filter(Boolean);
// Watch ONLY `class` (the has-data/visible toggles) on the regions themselves and
// `childList` (widgets added/removed) — NOT `style`, which updateOverlayPositions
// writes (observing it would loop). Not subtree, to avoid reacting to inner DOM
// churn that doesn't change the region's own stack height meaningfully.
const _relayoutObserver = new MutationObserver(() => relayoutChrome());
for (const t of _relayoutTargets) {
  _relayoutObserver.observe(t, { attributes: true, attributeFilter: ['class'], childList: true });
}
// Reflow on window resize too (main reframes the overlay window when the content
// window resizes; the renderer must re-place chrome around the new content rect).
window.addEventListener('resize', () => relayoutChrome());

// Signal readiness so main can verify the renderer is wired (and tests can wait).
window.__overlayReady = true;
DEBUG && console.log('[overlay] ready');
