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
 *   overlay → main (readiness):
 *     - page-overlay:ready    {} (published once, at the very end of this
 *                             module body, after every subscription above has
 *                             registered — closes the first-load handoff race,
 *                             see the publish site at the bottom of this file)
 *   main → overlay (active handoff + content events):
 *     - page-overlay:active   {windowId,url,title,canGoBack,canGoForward,loading,
 *                             pendingPermissions[]}|null (directed). The
 *                             pendingPermissions array carries the window's
 *                             still-unanswered web-permission requests, so a
 *                             prompt this renderer never received (published
 *                             before it subscribed) surfaces at the next handoff.
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
import { createPageWidgetHost, widgetActionFromPath } from './page-widgets.js';
import { navbarLoadReveal, pointerLeaveHides, SHOWN_BY_LOAD, SHOWN_BY_USER } from './navbar-load-reveal.js';
import { normalizeUrlForCompare } from './url-compare.js';
import { stateFromTags, planPageState } from 'peek://app/lib/page-state.js';

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
const TRIGGER_ZONE_PX = 4; // thin strip on the content's top edge that triggers reveal
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
  // Main clamps the overlay frame onto the work area, so a host flush with the
  // screen's top or left edge sits closer to the frame edge than the gutters;
  // main sends the real inset (contentInset) and the plain gutters are only the
  // fallback for a payload without it.
  return {
    left: contentInset ? contentInset.left : gutters.left,
    top: contentInset ? contentInset.top : gutters.top,
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
  const navOffset = top; // navbar band + trigger zone above content (0 when flush with the screen top)

  // Navbar: spans the content width, pinned to the top of the window (page.js
  // navbar.top = 0). Trigger zone: the strip between the window top and content.
  navbar.style.left = `${left}px`;
  navbar.style.top = `0px`;
  navbar.style.width = `${w}px`;

  triggerZone.style.left = `${left}px`;
  triggerZone.style.width = `${w}px`;
  // A thin strip on the content's top edge in both modes, so reveal only fires
  // when the cursor actually hits the edge. Maximized: the overlay frame == the
  // content rect (no gutter), so the strip is the first rows of content.
  // Guttered: the strip's bottom sits on the content top edge, in the gutter.
  triggerZone.style.top = `${maximized ? 0 : Math.max(0, navOffset - TRIGGER_ZONE_PX)}px`;
  triggerZone.style.height = `${TRIGGER_ZONE_PX}px`;

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

  // Permission prompt: pinned top-center of the content rect (the canvas chrome
  // used window-relative top:16px/left:50%; the overlay frames content + gutters,
  // so anchor to the content instead). CSS translateX(-50%) centers on `left`.
  const permissionPromptEl = document.querySelector('.permission-prompt');
  if (permissionPromptEl) {
    permissionPromptEl.style.left = `${left + w / 2}px`;
    permissionPromptEl.style.top = `${top + 16}px`;
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

// Cmd+L while the OVERLAY window itself holds focus (the repeat-press case, peek
// a500e36f). Press 1's Cmd+L is caught on the content WC's before-input-event and
// forwarded as page:show-navbar, which focuses the overlay window — after that the
// content WC is no longer first-responder, so subsequent Cmd+L keydowns land HERE
// in the overlay renderer instead. <peek-navbar>'s own bubble-phase handler only
// re-selects the URL input (focusUrl) and will NOT re-reveal a navbar that has
// auto-hidden, so repeat Cmd+L looked dead. Drive the SAME full reveal path press 1
// uses (showNavbar + capture + focusUrl) — browser convention: Cmd+L always
// opens+focuses the address field, never closes it. Capture phase so we run before
// <peek-navbar>'s bubble-phase keydown listener (registered without capture in
// peek-navbar.js connectedCallback) and can suppress its now-redundant focusUrl.
// Deterministic ordering — no timer / blur listener / polling.
document.addEventListener('keydown', (e) => {
  if (e.key === 'l' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    e.stopImmediatePropagation();
    openNavbarFocused();
  }
}, true);

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
// Where the content rect sits inside the overlay frame ({left, top}), from main.
// null = use the plain gutters.
let contentInset = null;
// Whether the active window is currently maximized (toggled by the maximize
// affordance). preMaxBounds holds the bounds to restore to on unmaximize.
let maximized = false;
let preMaxBounds = null;
// Page windows the chrome has framed at least once. The first handoff to a
// window not in here is that window appearing (navbar-load-reveal.js
// 'window-appeared'); later handoffs to it are switches.
const framedWindowIds = new Set();

/** Reset the navbar to empty (active→null or before painting a new window). */
function clearChrome() {
  navbar.setUrl('');
  navbar.canGoBack = false;
  navbar.canGoForward = false;
  navbar.loading = false;
  navbar.pageTitle = '';
  navbar.favicon = '';
  navbarShownBy = null;
  cancelLoadHide();
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
    contentInset = null;
    maximized = false;
    preMaxBounds = null;
    setRevealDelay(0);
    clearChrome();
    // Re-evaluate the permission queue: no active window → no visible prompt.
    // Queued requests are NOT dropped (never auto-deny) — they surface again
    // when their window becomes active.
    syncPermissionPrompt();
    retargetSpaceModeWidget();
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
  activeBounds = msg.bounds ? { ...msg.bounds } : null;
  // Gutter geometry from main (defaults already set; keep them in sync if sent).
  if (msg.gutters) gutters = { ...msg.gutters };
  contentInset = msg.contentInset ? { ...msg.contentInset } : null;
  setRevealDelay(msg.revealDelayMs);
  // Reconcile maximize state to the newly-active window (each window owns its
  // own). Main ships the registry's maximized/preMaxBounds — the single source
  // of truth — on every handoff, so re-activating a maximized window (window
  // switch) keeps the overlay's flag in sync instead of clobbering it to false.
  maximized = !!msg.maximized;
  preMaxBounds = msg.preMaxBounds ? { ...msg.preMaxBounds } : null;
  // Reposition the chrome into the gutter around the (possibly new-sized) content
  // rect so widgets/handles/panels never land over the content.
  updateOverlayPositions();
  // Hard reset before painting the new window so stale loading/nav state can
  // never bleed across a retarget. Also close any open find bar (find is
  // per-window; the new window starts with no active search).
  navbar.loading = false;
  hideFindBar();
  paintFromSnapshot(msg);
  // A page window the chrome has not framed before (a new window) shows the
  // bar for the dwell even when its load already finished: its load-start was
  // published before it became the active window, and a cached load can settle
  // before the chrome arrives. A switch back to a window already framed never
  // reveals, and takes down a bar the previous window's load held.
  const appeared = !framedWindowIds.has(msg.windowId);
  framedWindowIds.add(msg.windowId);
  applyLoadReveal(appeared ? 'window-appeared' : 'window-switched', !!msg.loading);
  // Recover any request main still holds pending for this window that this
  // renderer never received — the publish predates our subscription, or a
  // previous overlay renderer got it and this one started empty. Purely
  // ADDITIVE: the reconcile never removes a queued entry, because the handoff
  // listing can lag a response we have already sent, and because queued entries
  // need not have a backend entry at all. Removal stays with
  // `page:permission-resolved` and `respond()`.
  if (Array.isArray(msg.pendingPermissions)) {
    for (const pending of msg.pendingPermissions) enqueuePermissionRequest(pending);
  }
  // Re-evaluate the permission queue for the newly-active window: a request
  // that arrived while this window was in the background surfaces now; a
  // prompt belonging to the previously-active window is taken down (but stays
  // queued — never auto-deny from the renderer).
  syncPermissionPrompt();
  // The SPACE widget shows the newly-active window's own mode.
  retargetSpaceModeWidget();
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
  applyLoadReveal(msg.loading ? 'load-start' : 'load-stop', !!msg.loading);
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
navbar.addEventListener('stop', () => {
  if (activeWindowId == null) return;
  api.publish('page:stop', { windowId: activeWindowId });
});
navbar.addEventListener('dismiss',() => { hideNavbar(); });

// ── Navbar show/hide (trigger-zone hover), mirrors page.js behavior ───────────
let hideTimer = null;
// Who holds the navbar visible: the active page's load (navbar-load-reveal.js
// SHOWN_BY_LOAD), the user (SHOWN_BY_USER), or null while it is hidden. Only a
// load-held navbar hides when the load settles and its dwell has run.
let navbarShownBy = null;
// When the current load reveal started (performance.now()), null otherwise.
let navbarShownAt = null;
// The pending end-of-dwell hide for a load-held navbar.
let loadHideTimer = null;
function cancelLoadHide() {
  if (loadHideTimer) { clearTimeout(loadHideTimer); loadHideTimer = null; }
}
function cancelHide() {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  // E2E-only deterministic signal: no hide is pending (consumed by the
  // hybrid-overlay test bridge's moveOffChromeSchedulesHide). No-op in prod.
  window.__overlayHidePending = false;
}
// ── The one route for hover-driven show/hide of the navbar ────────────────────
// Every pointer-driven reveal or hide (trigger zone, the mousemove chrome loop,
// the content-pointer band from main, panel hover, navbar leave) goes through
// requestReveal()/requestHide(); nothing else decides when the bar appears.
// `revealDelay` is the dwell main computed for the active host (peek bf879b8c):
// a page flush with the top of the screen draws its own account menu / home link /
// site nav exactly where the navbar lands, so a cursor merely crossing the top
// edge must not drop the bar on them. 0 = reveal at once. Main sends it with the
// active-window handoff and with every bounds change; the overlay never measures.
//
// The timer measures HUMAN dwell ("the pointer stayed 2 s"), the same shape as
// the 400ms `hideTimer`; there is no state transition to wait on instead. One
// handle, cleared on fire and on any hide request, so nothing races it.
let revealDelay = 0;
let pendingReveal = null;
function cancelPendingReveal() {
  if (pendingReveal) { clearTimeout(pendingReveal); pendingReveal = null; }
}
/** Explicit intent (Cmd+L) passes `immediate` and skips the dwell. A bar already
 *  up stays up at once; an armed dwell keeps running rather than restarting, so a
 *  pointer jittering inside the zone still reveals. */
function requestReveal({ immediate = false } = {}) {
  if (activeWindowId == null) return;
  if (immediate || revealDelay <= 0 || navbar.classList.contains('visible')) {
    cancelPendingReveal();
    showNavbar();
    return;
  }
  if (pendingReveal) return;
  pendingReveal = setTimeout(() => {
    pendingReveal = null;
    showNavbar();
  }, revealDelay);
}
/** `e` is the pointer event behind the request, when there is one. Leaving
 *  through the top edge of the overlay (clientY <= 0) is not leaving the band: on
 *  a host flush with the screen top the pointer is now resting against the menu
 *  bar / screen edge, which is exactly the dwell gesture, so a pending reveal
 *  keeps running. */
function requestHide(e) {
  if (pendingReveal && e && typeof e.clientY === 'number' && e.clientY <= 0) return;
  cancelPendingReveal();
  scheduleHide();
}
/** Take the active host's dwell from main (absent or invalid = reveal at once).
 *  A pending dwell armed for another window or geometry is dropped. */
function setRevealDelay(ms) {
  const next = Number(ms) > 0 ? Number(ms) : 0;
  if (next !== revealDelay) cancelPendingReveal();
  revealDelay = next;
}

/** A user reveal (hover, Cmd+L, panel hover): the bar stays until they leave. */
function showNavbar() {
  if (activeWindowId == null) return;
  revealNavbar();
  cancelLoadHide();
  navbarShownBy = SHOWN_BY_USER;
  navbarShownAt = null;
}
/** Show the bar when a page window first appears, and hide it once its first
 *  load settles and the dwell has run, unless the user is holding it
 *  (navbar-load-reveal.js). */
function applyLoadReveal(event, loading) {
  if (activeWindowId == null) return;
  const r = navbarLoadReveal(
    { shownBy: navbarShownBy, shownAt: navbarShownAt, revealed: framedWindowIds.has(activeWindowId) },
    event, performance.now(), loading);
  cancelLoadHide();
  if (r.show) revealNavbar();
  navbarShownBy = r.shownBy;
  navbarShownAt = r.shownAt;
  if (r.hideAfterMs === 0) hideNavbar();
  else if (r.hideAfterMs != null) {
    loadHideTimer = setTimeout(() => {
      loadHideTimer = null;
      // The user may have taken the bar over during the dwell (hover, Cmd+L).
      if (navbarShownBy === SHOWN_BY_LOAD) hideNavbar();
    }, r.hideAfterMs);
  }
}
function revealNavbar() {
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
  navbarShownBy = null;
  navbarShownAt = null;
  cancelLoadHide();
  navbar.classList.remove('visible');
  document.body.classList.remove('chrome-visible');
  document.body.classList.remove('panels-visible');
}
function scheduleHide() {
  // A bar the active page's load is holding stays up while the pointer moves
  // over the page; the load settling takes it down (navbar-load-reveal.js).
  if (!pointerLeaveHides(navbarShownBy)) return;
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
  requestReveal({ immediate: true });
  setCapture(true);
  navbar.focusUrl();
}

triggerZone.addEventListener('mouseenter', () => requestReveal());
triggerZone.addEventListener('mouseleave', requestHide);
navbar.addEventListener('mouseenter', cancelHide);
navbar.addEventListener('mouseleave', requestHide);

// P1.4b-5: keep the chrome (navbar + panels) visible while the pointer is over a
// side panel — mirrors page.js, which cancels the hide timer on panel hover so a
// user can interact with panels without the chrome collapsing under them.
// P1.4b-6: include the notes panel + widget container so they keep the chrome
// open on hover too. The notes panel is mounted by overlay.js (see below), so it
// may not exist yet at this point — its hover is bound at mount time instead.
for (const sel of ['#page-info-panel', '#tags-panel', '#entities-panel', '#extensions-panel', '#widget-container']) {
  const p = document.querySelector(sel);
  if (!p) continue;
  // Hidden panels (opacity 0) are still hit-testable; only visible ones reveal.
  p.addEventListener('mouseenter', () => {
    if (document.body.classList.contains('panels-visible')) requestReveal();
  });
  p.addEventListener('mouseleave', requestHide);
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
// With a reveal dwell in effect the top band is as deep as the top resize band
// (ipc.ts DWELL_REVEAL_BAND_PX): the resize cursor showing is what tells the
// user they are at the top edge, so resting anywhere it shows must count. The
// overlay stays click-through while the dwell runs, so a press there still
// resizes.
const DWELL_REVEAL_BAND_PX = 14;
function pointerOverChrome(x, y) {
  if (pointInRect(x, y, triggerZone.getBoundingClientRect())) return true;
  if (revealDelay > 0) {
    const c = contentRectInOverlay();
    if (c && x >= c.left && x <= c.left + c.width && y <= c.top + DWELL_REVEAL_BAND_PX) return true;
  }
  if (navbar.classList.contains('visible') &&
      pointInRect(x, y, navbar.getBoundingClientRect())) return true;
  // Visible side panels keep the chrome open on hover (mirrors the panel
  // mouseenter handlers above) — include them so a move from the navbar onto a
  // panel doesn't read as "outside" and collapse the chrome under the pointer.
  if (document.body.classList.contains('panels-visible')) {
    for (const p of document.querySelectorAll(
      '#page-info-panel.has-data, #tags-panel.has-data, #entities-panel.has-data, ' +
      '#extensions-panel.has-data, #widget-container.has-data, .notes-panel.has-data',
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
    requestReveal();
    // While the dwell is pending the overlay stays click-through: capturing now
    // would make the top strip opaque and the page's own top elements unclickable,
    // which is what the dwell exists to prevent. The next move after the bar
    // appears captures it.
    if (!pendingReveal) setCapture(true);
  } else if (pointerOverPermissionPrompt(x, y)) {
    // Over the permission prompt: capture so its buttons/checkbox are clickable,
    // but don't reveal the navbar — the prompt is its own transient surface
    // (same capture mechanism, no chrome reveal). The move-out branch below
    // restores click-through when the pointer leaves it.
    setCapture(true);
  } else {
    // Outside all chrome regions: release capture so clicks fall through to the
    // content window (and so the edges stay click-through → content topmost →
    // main's injected resize cursor shows), and schedule the navbar hide.
    setCapture(false);
    requestHide(e);
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

// Signal main to paint the closed-hand cursor over WEB CONTENT during the
// hold-to-drag gesture. The overlay is never the macOS first responder, so its
// own `document.body.style.cursor` (set alongside these calls) renders only over
// the chrome region, NOT over the content WebContentsView. Main owns the content
// WC and paints the cursor there via its insertCSS reconciler (ipc.ts
// wireHybridContentEvents), resolving the target host from `windowId`. `state` is
// 'grab' (hold fired) / 'grabbing' (dragging) / null (released).
function publishDragCursor(state) {
  if (activeWindowId == null) return;
  api.publish('page:drag-cursor', { windowId: activeWindowId, state });
}

// --- Main-driven resize sync ---
// Main owns edge/corner resize (it drives baseWin.setBounds off the content WC's
// input-event stream). Three signals keep the overlay coherent with that:
//   - page-overlay:resize-active {active} — gates the capture-loop to stay
//     click-through for the whole drag (see resizeActive), so the overlay never
//     goes opaque mid-resize and starves main's move stream.
//   - page-overlay:bounds {bounds} — main pushes the host's new outer bounds each
//     resize step so the renderer's locally-tracked activeBounds (used by the
//     navbar-drag MOVE math + maximize stash) doesn't go stale.
//   - page-overlay:maximize-state {maximized, preMaxBounds} — main pushes the
//     registry's maximize state when IT changes that state without going through
//     this overlay's toggleMaximize. Today that's the resize-start exit: grabbing
//     an edge of a maximized host exits maximize in the same gesture, and main
//     owns that press. Same payload + same reconcile as the page-overlay:active
//     handoff, so there's one shape for "here is the registry's maximize state".
api.subscribe('page-overlay:resize-active', (msg) => {
  if (!isActive(msg)) return;
  resizeActive = !!msg.active;
  // Entering a resize: make sure we're click-through so the content stays topmost
  // (cursor shows) and keeps receiving moves.
  if (resizeActive) setCapture(false);
});
api.subscribe('page-overlay:bounds', (msg) => {
  if (!isActive(msg) || !msg.bounds) return;
  // A chrome drag owns activeBounds and publishes it itself; main's echo of
  // those moves lags the pointer and would rewind it mid-drag.
  if (typeof holdDrag !== 'undefined' && holdDrag.isDragging()) return;
  activeBounds = { ...msg.bounds };
  contentInset = msg.contentInset ? { ...msg.contentInset } : null;
  setRevealDelay(msg.revealDelayMs);
  updateOverlayPositions();
});
// Assign directly rather than calling toggleMaximize() — the toggle would publish
// page:unmaximize and snap bounds back to preMaxBounds, fighting the in-flight
// resize.
api.subscribe('page-overlay:maximize-state', (msg) => {
  if (!isActive(msg)) return;
  maximized = !!msg.maximized;
  preMaxBounds = msg.preMaxBounds ? { ...msg.preMaxBounds } : null;
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
    publishDragCursor('grabbing'); // paint 'grabbing' over web content too
  },
  onDragMove: (screenX, screenY) => {
    if (!activeBounds) return;
    activeBounds.x = dragStartBx + (screenX - dragStartScreenX);
    activeBounds.y = dragStartBy + (screenY - dragStartScreenY);
    publishBounds();
  },
  onDragEnd: () => {
    document.body.style.cursor = '';
    // A real drag just ended: swallow the click that this button-up would
    // otherwise synthesize, so a drag that STARTED on an interactive surface
    // (URL bar, widget, nav button) doesn't fire an unwanted click on release.
    // (onDragEnd only runs when a drag actually happened — see the FSM's onUp.)
    suppressNextClick = true;
    // Release capture; the reveal-loop mousemove re-captures if the pointer is
    // still over chrome, else the content window stays interactive.
    setCapture(false);
  },
  setGrabCursor: () => { document.body.style.cursor = 'grab'; publishDragCursor('grab'); },
  clearCursor: () => { document.body.style.cursor = ''; publishDragCursor(null); },
  setSchedule: (fn, ms) => setTimeout(fn, ms),
  clearSchedule: (t) => clearTimeout(t),
});

// CHROME region: the overlay renderer natively receives these. The hold-to-drag
// gesture is Peek-wide — it starts on ALL overlay chrome surfaces (navbar
// background, address bar, nav buttons, widgets, panels), not just the navbar
// background. So the START binding is a DOCUMENT capture-phase mousedown rather
// than a navbar-scoped one.
//
// Capture phase is REQUIRED: peek-navbar is a shadow-DOM Lit component whose URL
// input `@mousedown` handler calls stopPropagation (to protect caret placement),
// and #widget-container is a SIBLING of <peek-navbar>. A navbar-scoped bubble
// listener would never see either. A document capture-phase listener runs before
// any shadow-internal stopPropagation can block it, so the press is always seen.
function shouldBlockOverlayDrag(e) {
  // Walk composedPath (innermost → outermost). At the document level e.target is
  // retargeted to the <peek-navbar> host, so composedPath is the only way to see
  // the REAL innermost element INTO the shadow DOM (URL input, buttons, widgets).
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  for (const node of path) {
    if (!node || node.nodeType !== 1) continue; // elements only (skip document/window)
    const el = node;
    // Explicit opt-out marker (mirrors tile-preload shouldBlockDrag) — but NOT the
    // <body>'s own data-no-drag: the overlay body carries it to opt OUT of
    // tile-preload's whole-body window drag (tile-preload initDrag bails when
    // body has data-no-drag), NOT to disable the overlay's own hold-drag. Honor
    // the marker only on a specific control/widget BELOW body/html.
    if (typeof el.closest === 'function') {
      const nd = el.closest('[data-no-drag]');
      if (nd && nd !== document.body && nd !== document.documentElement) return true;
    }
    const tag = (el.tagName || '').toLowerCase();
    // Shadow-aware "active element": check within the element's OWN root, since a
    // focused element inside a shadow tree is `shadowRoot.activeElement`, not
    // `document.activeElement`. Only block an ACTIVELY-focused text field: this
    // lets the FIRST press on the (unfocused) URL bar start hold-drag candidacy
    // (gap 2) while a press WHILE editing the URL doesn't hijack caret placement.
    // At capture-phase mousedown native focus hasn't moved yet, so an unfocused
    // URL bar reads as not-active → candidacy starts; a quick release still
    // focuses+edits it (no drag fired), only a still-hold-then-move drags.
    const root = typeof el.getRootNode === 'function' ? el.getRootNode() : null;
    const activeInRoot = !!root && root.activeElement === el;
    if ((tag === 'input' || tag === 'textarea') && activeInRoot) return true;
    if (el.isContentEditable && activeInRoot) return true;
  }
  return false;
}
document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (shouldBlockOverlayDrag(e)) return;
  holdDrag.onDown(e.screenX, e.screenY);
}, true);
// A real drag can now start on interactive chrome (URL bar, widgets, nav
// buttons). If it ends over one of those, swallow the click the button-up
// synthesizes so the drag doesn't also trigger the element's action. Set only
// on a genuine drag end (onDragEnd), mirrored on tile-preload's onClickCapture.
let suppressNextClick = false;
document.addEventListener('click', (e) => {
  if (suppressNextClick) {
    suppressNextClick = false;
    e.stopImmediatePropagation();
    e.preventDefault();
  }
}, true);
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
// SAME requestReveal()/requestHide() route the trigger-zone hover uses; the dwell
// for a host flush with the screen top lives there, in one place. The local
// reveal loop still owns the gutter case (where the overlay sees moves natively);
// both feeding requestReveal/requestHide is idempotent (cancelHide/scheduleHide
// guard each other), so the two paths never fight.
api.subscribe('page-overlay:content-pointer', (msg) => {
  if (!isActive(msg)) return;
  if (msg.phase === 'down') holdDrag.onDown(msg.screenX, msg.screenY);
  else if (msg.phase === 'move') holdDrag.onMove(msg.screenX, msg.screenY);
  else if (msg.phase === 'up') holdDrag.onUp();
  else if (msg.phase === 'reveal') requestReveal();
  else if (msg.phase === 'reveal-out') requestHide();
  // No 'edge' phase: edge/corner RESIZE is owned entirely by main (cursor +
  // drag against the content WC); the overlay only learns a resize is active via
  // page-overlay:resize-active (above) so it stays click-through during the drag.
});

// Expose the pure FSM factory + the live instance for focus-free unit coverage
// (press→move-before-threshold cancels; press→hold→move drags). Drives the REAL
// path: the bridge builds an FSM with injected fake schedule/effects and asserts
// transitions, and reads the live instance's state after synthetic events.
if (typeof globalThis !== 'undefined') {
  globalThis.__peekHoldDragTest = {
    createHoldDrag, holdDrag, shouldBlockOverlayDrag, publishDragCursor,
  };
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

// Content-area double-click → maximize toggle (peek d8ce0ddf). The content
// preload detects a "dead space" double-click over the page (no editable/
// interactive target, no text selected); main republishes it here so the overlay
// — the single source of truth for maximize state + chrome reflow — runs the
// SAME toggleMaximize the navbar double-click uses, keeping both in sync. (A
// content triple-click drives fullscreen in main directly; that path is
// OS-driven and needs no overlay state, so it isn't routed here.)
api.subscribe('page:request-toggle-maximize', (msg) => {
  if (!isActive(msg)) return;
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

// ── Web permission prompts ────────────────────────────────────────────────────
// Backend's permission-handler.ts publishes `page:permission-request` when a
// hybrid content WebContents requests a risky permission (geolocation,
// camera/mic, etc.) and defers the Chromium callback until the user responds.
// Ported from the retired canvas page.js prompt UI (git 2b14032d^, page.js
// ~2843-3039) with overlay adaptations: the overlay is ONE renderer serving N
// windows, so it keeps ONE FIFO queue of requests across ALL hybrid windows
// and renders a visible prompt only for the head request belonging to the
// ACTIVE window. Requests for background windows stay queued silently and
// surface when their window becomes active (the queue is re-evaluated on every
// `page-overlay:active` handoff). The "+N more pending" badge counts the
// ADDITIONAL queued requests for the active window (canvas semantics).
//
// The renderer NEVER auto-denies. A queued request leaves the queue only when
// (a) the user responds here (`page:permission-response`), or (b) main
// announces it resolved by another path — window close / hybrid teardown —
// via `page:permission-resolved {requestId}` (permission-handler.ts). Both
// are deterministic pubsub signals; no timers.
//
// Requests also arrive a SECOND way: every `page-overlay:active` handoff
// carries `pendingPermissions`, the window's still-unanswered requests as main
// sees them. Pubsub keeps no history, so a request published before this
// renderer subscribed — at startup, or after a previous overlay renderer was
// replaced — reached nobody, and the prompt stayed invisible until window close
// auto-denied it. Reconciling the handoff's listing recovers exactly those.
// The reconcile is ADDITIVE ONLY. It never drops a queued entry, for two
// reasons: the listing can be older than a response already sent from here, and
// a queued entry need not correspond to a backend entry at all. What keeps an
// already-answered request from coming back is `settledPermissionIds`, the
// tombstone set every enqueue is filtered through.

const permissionQueue = [];
// Every requestId this renderer has seen settled — answered here in `respond()`
// or announced resolved by main. It is the tombstone set the handoff replay is
// filtered through, so a listing taken before main saw our response cannot
// resurrect an answered request. Ids are never removed: a settled request never
// becomes pending again (main mints a fresh id for a fresh request).
const settledPermissionIds = new Set();
let activePermissionPrompt = null; // { req, wrap, badgeEl, resolved }

function originForFavicon(origin) {
  // Strip scheme + path so we can hand bare hostname to the favicon service.
  if (!origin) return null;
  try {
    const u = new URL(origin);
    return u.hostname || null;
  } catch {
    return null;
  }
}

// Visual scan helper — emoji glyph by permission type, shown next to the
// label so the user can recognize at-a-glance which sense the page is
// asking for. Falls back to a generic lock for unknown permissions.
const PERMISSION_GLYPHS = {
  geolocation: '\u{1F4CD}',          // 📍
  media: '\u{1F3A4}',                // 🎤
  midi: '\u{1F3B9}',                 // 🎹
  midiSysex: '\u{1F3B9}',
  'display-capture': '\u{1F4FA}',    // 📺
  notifications: '\u{1F514}',        // 🔔
  'clipboard-read': '\u{1F4CB}',     // 📋
  'clipboard-sanitized-write': '\u{1F4CB}',
  pointerLock: '\u{1F5B1}',          // 🖱️
  fullscreen: '\u{2922}',            // ⤢
  openExternal: '\u{1F517}',         // 🔗
};
function glyphFor(permission) {
  return PERMISSION_GLYPHS[permission] || '\u{1F512}'; // 🔒 fallback
}

/** The queued request the visible prompt should show: the FIRST queued request
 *  belonging to the ACTIVE window (FIFO per window), or null. */
function activePermissionHead() {
  if (activeWindowId == null) return null;
  return permissionQueue.find((r) => r.windowId === activeWindowId) || null;
}

function pendingCountForActiveWindow() {
  if (activeWindowId == null) return 0;
  return permissionQueue.filter((r) => r.windowId === activeWindowId).length;
}

function removeFromPermissionQueue(requestId) {
  const idx = permissionQueue.findIndex((r) => r.requestId === requestId);
  if (idx === -1) return false;
  permissionQueue.splice(idx, 1);
  return true;
}

/** Is the pointer over the visible permission prompt? Feeds the reliable-reveal
 *  mousemove hit-test so the overlay captures clicks over the prompt (the same
 *  mechanism the navbar/panels use) without also revealing the navbar. */
function pointerOverPermissionPrompt(x, y) {
  const p = document.querySelector('.permission-prompt');
  return !!p && pointInRect(x, y, p.getBoundingClientRect());
}

/**
 * Reconcile the visible prompt with the queue + active window: if the correct
 * request is already showing, just refresh the badge; otherwise re-render
 * (which also removes the prompt when nothing should show).
 */
function syncPermissionPrompt() {
  const head = activePermissionHead();
  if (
    activePermissionPrompt &&
    !activePermissionPrompt.resolved &&
    head &&
    activePermissionPrompt.req.requestId === head.requestId
  ) {
    updatePendingBadge();
    return;
  }
  renderActivePermissionPrompt();
}

function renderActivePermissionPrompt() {
  // Removes any prior DOM and renders the active window's queue head (if any).
  if (activePermissionPrompt) {
    activePermissionPrompt.wrap.remove();
    activePermissionPrompt = null;
  }
  const req = activePermissionHead();
  if (!req) {
    // Nothing to show. If the pointer was parked over the just-removed prompt
    // the overlay is still capturing — release unless it's over other chrome
    // (the same deferred `.interactive:hover` check every dynamic surface uses).
    requestAnimationFrame(() => {
      const over = document.querySelector('.interactive:hover');
      if (!over) setCapture(false);
    });
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'permission-prompt';
  wrap.dataset.requestId = req.requestId;

  const message = document.createElement('div');
  message.className = 'permission-prompt-message';

  // Favicon — uses the same Google s2 favicon service the search-result
  // cards use (see app/lib/card-helpers.js). onerror falls back to the
  // globe-emoji SVG so unreachable origins don't show a broken-image icon.
  const favicon = document.createElement('img');
  favicon.className = 'permission-prompt-favicon';
  favicon.alt = '';
  const host = originForFavicon(req.origin);
  const fallback = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">\u{1F310}</text></svg>';
  favicon.src = host ? `https://www.google.com/s2/favicons?domain=${host}&sz=32` : fallback;
  favicon.onerror = () => { favicon.src = fallback; favicon.onerror = null; };
  message.appendChild(favicon);

  const text = document.createElement('div');
  text.className = 'permission-prompt-text';
  const originSpan = document.createElement('span');
  originSpan.className = 'permission-prompt-origin';
  originSpan.textContent = req.origin || '(unknown origin)';
  text.appendChild(originSpan);

  // "+N more pending" badge — visible only when more than one request is
  // queued FOR THE ACTIVE WINDOW. Updated in place via badgeEl.textContent
  // on enqueue/dequeue (updatePendingBadge).
  const badge = document.createElement('span');
  badge.className = 'permission-prompt-pending-badge';
  const queuedExtras = pendingCountForActiveWindow() - 1;
  if (queuedExtras > 0) {
    badge.textContent = `+${queuedExtras} more pending`;
  } else {
    badge.style.display = 'none';
  }
  text.appendChild(badge);

  text.appendChild(document.createElement('br'));
  // Emoji glyph for the requested permission type — visual scan helper
  // so the user can tell "this is geolocation" vs "this is camera/mic"
  // at a glance.
  text.appendChild(document.createTextNode(`wants to ${glyphFor(req.permission)} ${req.label || req.permission}.`));
  message.appendChild(text);

  // "Remember this decision" checkbox — when checked, the response includes
  // remember:true and permission-handler.ts persists the {origin, permission,
  // allowed} tuple to feature_settings.
  const rememberLabel = document.createElement('label');
  rememberLabel.className = 'permission-prompt-remember';
  const rememberCheckbox = document.createElement('input');
  rememberCheckbox.type = 'checkbox';
  rememberCheckbox.checked = false;
  const rememberText = document.createElement('span');
  rememberText.textContent = 'Remember this decision';
  rememberLabel.appendChild(rememberCheckbox);
  rememberLabel.appendChild(rememberText);

  const actions = document.createElement('div');
  actions.className = 'permission-prompt-actions';

  const denyBtn = document.createElement('button');
  denyBtn.className = 'permission-prompt-deny';
  denyBtn.textContent = 'Deny';

  const allowBtn = document.createElement('button');
  allowBtn.className = 'permission-prompt-allow';
  allowBtn.textContent = 'Allow';

  function respond(allowed) {
    if (!activePermissionPrompt || activePermissionPrompt.resolved) return;
    if (activePermissionPrompt.wrap !== wrap) return; // stale prompt closure
    activePermissionPrompt.resolved = true;
    // Tombstone before publishing: a handoff arriving between this response and
    // main's removal of the pending entry would otherwise replay it back in.
    settledPermissionIds.add(req.requestId);
    api.publish('page:permission-response', {
      requestId: req.requestId,
      allowed,
      remember: rememberCheckbox.checked,
    });
    // Dequeue locally right away (snappy advance to the next prompt); main's
    // `page:permission-resolved` for this id then finds nothing — a no-op.
    removeFromPermissionQueue(req.requestId);
    renderActivePermissionPrompt();
  }
  denyBtn.addEventListener('click', () => respond(false));
  allowBtn.addEventListener('click', () => respond(true));

  actions.appendChild(denyBtn);
  actions.appendChild(allowBtn);
  wrap.appendChild(message);
  wrap.appendChild(rememberLabel);
  wrap.appendChild(actions);

  // Join the click-capture set: the prompt is a transient interactive surface,
  // so pointer enter must flip the overlay pointer-opaque (and leave must
  // release unless another interactive region is hovered) — the manual binding
  // every dynamically-created interactive surface needs.
  wrap.classList.add('interactive');
  wrap.addEventListener('mouseenter', () => setCapture(true));
  wrap.addEventListener('mouseleave', () => {
    requestAnimationFrame(() => {
      const over = document.querySelector('.interactive:hover');
      if (!over) setCapture(false);
    });
  });

  // Defer the DOM append to the next paint frame. Without this, the synchronous
  // appendChild during the renderer's event tick can briefly leak the prompt's
  // pixels onto the user's display via the macOS compositor — even though the
  // headless overlay window has opacity:0 (set at ctor in hybrid-overlay.ts),
  // the initial paint cycle of a transparent window doesn't fully respect
  // alpha. By the next rAF tick, the window's alpha-0 state has settled in
  // NSWindow and the appendChild's paint can no longer escape.
  //
  // Diagnostic origin (canvas page.js): a 2-second setTimeout reproducibly
  // suppressed the visible "permission prompts flashing center of screen"
  // symptom. rAF is the same fix at minimum delay — production gets ~16ms,
  // imperceptible.
  requestAnimationFrame(() => {
    // A re-render may have superseded this prompt before the frame fired —
    // only append if it is still the active one (prevents a ghost prompt).
    if (activePermissionPrompt && activePermissionPrompt.wrap === wrap) {
      document.body.appendChild(wrap);
      // Position it over the active content rect now that it's in the DOM.
      updateOverlayPositions();
    }
  });
  activePermissionPrompt = { req, wrap, badgeEl: badge, resolved: false };
}

function updatePendingBadge() {
  // Refreshes the badge on the active prompt without re-rendering it.
  if (!activePermissionPrompt) return;
  const queuedExtras = pendingCountForActiveWindow() - 1;
  const badge = activePermissionPrompt.badgeEl;
  if (queuedExtras > 0) {
    badge.textContent = `+${queuedExtras} more pending`;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

/**
 * Queue one request, from either source: the live `page:permission-request`
 * publish, or the `pendingPermissions` list replayed on a handoff. Returns
 * whether it was actually enqueued. Does NOT re-render — callers batch a single
 * `syncPermissionPrompt()` afterwards.
 */
function enqueuePermissionRequest(msg) {
  if (!msg || !msg.requestId) return false;
  // A request with no windowId can never surface (no window to become active)
  // — and main denies those before publishing, so just guard.
  if (msg.windowId == null) return false;
  // Dedup: if the same requestId is already queued (duplicate publish from a
  // re-entrant transition, or a replay of a request already showing), ignore it.
  if (permissionQueue.some((r) => r.requestId === msg.requestId)) return false;
  // Already answered here. A handoff's listing is a snapshot taken in main
  // BEFORE it necessarily processed our `page:permission-response`, so without
  // this guard the very next handoff would put an answered request back in the
  // queue and re-show a prompt the user just dismissed.
  if (settledPermissionIds.has(msg.requestId)) return false;
  permissionQueue.push(msg);
  return true;
}

api.subscribe('page:permission-request', (msg) => {
  enqueuePermissionRequest(msg);
  syncPermissionPrompt();
});

// Main announces a request resolved by ANY path (user response relayed back,
// window close, hybrid teardown) — prune it so the singleton UI can't show a
// stale prompt for a request whose Chromium callback is already settled.
api.subscribe('page:permission-resolved', (msg) => {
  if (!msg || !msg.requestId) return;
  // Record it whether or not it was queued: an id resolved while we had nothing
  // queued for it must still be refused by a later handoff replay.
  settledPermissionIds.add(msg.requestId);
  if (removeFromPermissionQueue(msg.requestId)) {
    syncPermissionPrompt();
  }
});

// Test-only hooks (same pattern as __overlayTestAddWidget above): let the E2E
// bridge read the queue and reset prompt state between tests. No-ops in prod.
if (typeof window !== 'undefined') {
  window.__permissionPromptQueueForTests = () => permissionQueue.map((r) => ({ ...r }));
  window.__resetPermissionPromptsForTests = () => {
    permissionQueue.length = 0;
    settledPermissionIds.clear();
    renderActivePermissionPrompt();
  };
  // Read the overlay's live maximize state for the active window — the flag the
  // page-overlay:active handoff must RECONCILE (not clobber) on a window switch.
  window.__overlayMaximizeStateForTests = () => ({
    maximized,
    preMaxBounds: preMaxBounds ? { ...preMaxBounds } : null,
  });
}

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
const pageKeepBtn = document.getElementById('page-keep-btn');
const pageDropBtn = document.getElementById('page-drop-btn');
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
  renderPageState();
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
// normalizeUrlForCompare lives in ./url-compare.js so it can be tested under node.

async function resolveItemId(url) {
  if (!isHttp(url)) return null;
  try {
    // Canonical-URL lookup (same as addTagToPage); a substring search misses
    // slash-terminated URLs whose stored item has no trailing slash.
    const found = await api.datastore.findUrlItem(url);
    if (found?.success && found.data) return found.data.id;
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
  renderPageState();
}

// ── Keep / drop ───────────────────────────────────────────────────────────────
// A page is kept or dropped by a tag on its URL item, so the state is already in
// the tags `renderTags()` just painted — no extra query. Every rule about which
// tag goes and which stays lives in lib/page-state.js.

/** The kept/dropped state of the active page, from the tags currently loaded. */
function currentPageState() {
  return stateFromTags(currentPageTags.map((t) => t.name));
}

/** Show the button matching the current state as active. */
function renderPageState() {
  const state = currentPageState();
  if (pageKeepBtn) pageKeepBtn.classList.toggle('is-active', state === 'kept');
  if (pageDropBtn) pageDropBtn.classList.toggle('is-active', state === 'dropped');
}

/**
 * Apply a keep, drop or clear to the active page through the same datastore calls
 * `addTagToPage()` / `removeTagFromPage()` use. No note is set from the overlay.
 */
async function applyPageState(action) {
  if (!isHttp(activeUrl)) return;
  const token = panelToken;
  const plan = planPageState(currentPageTags.map((t) => t.name), action);
  // Resolve the tag ids before the first await: each call below reloads
  // currentPageTags, so the snapshot the plan was made from would be gone.
  const toRemove = plan.removeTags
    .map((name) => currentPageTags.find((t) => t.name.toLowerCase() === name))
    .filter(Boolean);
  for (const tag of toRemove) {
    await removeTagFromPage(tag.id);
    if (token !== panelToken) return; // active window changed mid-apply
  }
  if (plan.addTag) await addTagToPage(plan.addTag);
}

if (pageKeepBtn) {
  pageKeepBtn.addEventListener('click', () => {
    // Clicking the active button clears the state.
    applyPageState(currentPageState() === 'kept' ? 'clear' : 'keep');
  });
}
if (pageDropBtn) {
  pageDropBtn.addEventListener('click', () => {
    applyPageState(currentPageState() === 'dropped' ? 'clear' : 'drop');
  });
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
notesPanel.addEventListener('mouseenter', () => {
  if (document.body.classList.contains('panels-visible')) requestReveal();
});
notesPanel.addEventListener('mouseleave', requestHide);

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

function addWidget(id, { title, content, autoDismiss = 0, onClose, onAction, closable = true, collapsible = true } = {}) {
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
  // Clicks on elements carrying `data-widget-action` go back to the widget's
  // owner (see page-widgets.js widgetActionFromPath). The listener sits on the
  // body, not on the elements, so it survives updateWidget replacing the markup.
  if (typeof onAction === 'function') {
    body.addEventListener('click', (e) => {
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [e.target];
      const hit = widgetActionFromPath(path, body);
      if (!hit) return;
      e.stopPropagation();
      try { onAction(hit); } catch (err) { console.error('[overlay] widget action failed:', err); }
    });
  }

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
  // The space-mode widget is not a page widget: re-add it after the clear from
  // the active window's mode (see retargetSpaceModeWidget()).
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
  getActiveWindowId: () => activeWindowId,
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

// --- Space mode widget ---
// One overlay frames every page host, so the widget shows the mode of the
// window it is framing now (`activeWindowId`), never the last mode written to
// any window. The active-window handoff re-reads it (`retargetSpaceModeWidget`);
// a mode change is applied only when it is for the active window.
const SPACE_MODE_WIDGET_ID = '__space-mode__';
let currentMode = 'page';
let currentModeMetadata = {};
// Bumped on every retarget so a mode read that resolves after a later
// retarget is dropped instead of painting the previous window's space.
let spaceModeReadSeq = 0;

function applySpaceMode(mode, metadata) {
  currentMode = mode || 'page';
  currentModeMetadata = metadata || {};
  updateSpaceModeWidget();
}

async function retargetSpaceModeWidget() {
  const windowId = activeWindowId;
  const seq = ++spaceModeReadSeq;
  // Nothing of the previous window's space may show while the read is in flight.
  applySpaceMode('page', {});
  if (windowId == null) return;
  try {
    const result = await api.context.get('mode', windowId);
    if (seq !== spaceModeReadSeq || windowId !== activeWindowId) return;
    if (result?.success && result.data) applySpaceMode(result.data.value, result.data.metadata);
  } catch (err) {
    console.error('[overlay] Failed to read the active window mode:', err);
  }
}

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

// `context:changed` carries the window the mode was written for. watchMode's
// initial call reports the overlay's own window, which is never the active
// page, so the same filter drops it.
api.context.watchMode((mode, entry) => {
  if (activeWindowId == null || entry?.windowId !== activeWindowId) return;
  // A write supersedes any read still in flight for this window.
  spaceModeReadSeq++;
  applySpaceMode(mode, entry?.metadata);
});

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

// ── First-load handoff race ───────────────────────────────────────────────────
// `page-overlay:active` (the main→overlay active-window handoff, see the
// `api.subscribe` near the top of this file) can be published before this
// module's subscription registers — the browser-process load signal main used
// to key a re-send off (`did-finish-load`) and the renderer's
// `tile:pubsub:subscribe` IPC travel on independent channels with no
// cross-channel ordering guarantee, so a load-event re-send can still lose the
// race. A late subscriber is answered by its own declaration instead: this
// publish is the LAST statement in the module body, after every `api.subscribe`
// above has registered, so main's `page-overlay:ready` subscriber
// (`wireOverlayReady` in hybrid-overlay.ts) can safely re-send the current
// active handoff the instant this fires — there is no earlier point at which
// the resend could still beat the subscription it's answering.
api.publish('page-overlay:ready', {});
