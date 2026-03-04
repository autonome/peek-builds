/**
 * peek://page - Minimal page host window for web content
 *
 * Architecture: A tight-fitting transparent BrowserWindow wraps the webview
 * content plus margins for resize handles and a trigger zone. All UI elements
 * are positioned relative to the window origin (0,0). Moving the page moves
 * the BrowserWindow via setBounds() IPC. Resizing changes both window and
 * element sizes.
 *
 * The URL params (x, y, width, height) store screen coordinates of the webview
 * for session save/restore. Internally, elements use window-relative positions.
 *
 * - Custom drag: instant on navbar background, hold-to-drag anywhere else (configurable via dragHoldDelay pref, default 1s)
 * - Custom resize: pointer-captured resize handle (robust even if cursor leaves window)
 * - Hover trigger zone above webview reveals/hides navbar
 * - Cmd+L shows navbar with URL focus
 * - Navbar show/hide is CSS-only (window always includes navbar space)
 */

import api from '../api.js';
import { createPageWidgetHost } from './page-widgets.js';
import { PageNotesPane } from './page-notes.js';

console.log('[page] Script loaded');

const DEBUG = false;

// Cache our window ID for filtering GLOBAL pubsub messages
let myWindowId = null;
api.window.getWindowId().then(id => { myWindowId = id; });

// --- OAuth URL detection (Level 2) ---
// Patterns that indicate an OAuth/authentication flow in progress.
// When detected, navbar auto-show on hover is suppressed to avoid interrupting the flow.

const OAUTH_DOMAINS = [
  'accounts.google.com',
  'login.microsoftonline.com',
  'auth0.com',
  'appleid.apple.com',
];

const OAUTH_PATH_PATTERNS = [
  '/oauth/',
  '/authorize',
  '/auth/',
  '/login/oauth',
  '/oauth2/',
  '/connect/authorize',
  '/o/oauth2/',
];

function isOAuthUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    // Check domain-based patterns
    for (const domain of OAUTH_DOMAINS) {
      if (parsed.hostname === domain || parsed.hostname.endsWith('.' + domain)) {
        return true;
      }
    }
    // Check path-based patterns
    const lowerPath = parsed.pathname.toLowerCase();
    for (const pattern of OAUTH_PATH_PATTERNS) {
      if (lowerPath.includes(pattern)) {
        return true;
      }
    }
  } catch (e) {
    // Invalid URL, not OAuth
  }
  return false;
}

let isOnOAuthPage = false;

// --- Constants ---
const NAVBAR_HEIGHT = 36;
const NAVBAR_GAP = 0; // trigger zone serves as the visual gap
const MIN_WIDTH = 200;
const MIN_HEIGHT = 150;
const MARGIN = 8;                // Resize handle margin on each side
const TRIGGER_ZONE_HEIGHT = 8;   // Transparent strip above webview for hover trigger
const PANEL_WIDTH = 280;         // Width of page info / entities panels
const PANEL_OVERLAP = PANEL_WIDTH * 0.25; // 70px overlaps the page
const PANEL_OVERHANG = PANEL_WIDTH - PANEL_OVERLAP; // 210px extends beyond page

// --- Parse URL parameters ---
// URL params represent the webview's position in screen coordinates
const params = new URLSearchParams(window.location.search);
const targetUrl = params.get('url');
const initialX = parseInt(params.get('x')) || 100;
const initialY = parseInt(params.get('y')) || 100;
const initialWidth = parseInt(params.get('width')) || 800;
const initialHeight = parseInt(params.get('height')) || 600;

if (!targetUrl) {
  console.error('[page] No URL provided');
  document.body.innerHTML = '<h1>Error: No URL provided</h1>';
  throw new Error('No URL provided to peek://page');
}

DEBUG && console.log('[page] Loading:', targetUrl, 'at', initialX, initialY, initialWidth, initialHeight);

// --- Screen bounds state ---
// screenBounds tracks where the webview appears on screen (for URL params / session save)
// Window-relative positions are computed from these + the known margins
let screenBounds = {
  x: initialX,
  y: initialY,
  width: initialWidth,
  height: initialHeight,
};

// NOTE: The window always includes navbar space (NAVBAR_HEIGHT) to avoid
// visual jumps on show/hide. Navbar visibility is CSS-only — no window resize.

// --- DOM elements ---
const navbar = document.getElementById('navbar');
const triggerZone = document.getElementById('trigger-zone');
const webview = document.getElementById('content');
const dragOverlay = document.getElementById('drag-overlay');
const resizeHandles = {
  se: document.getElementById('resize-se'),
  sw: document.getElementById('resize-sw'),
  ne: document.getElementById('resize-ne'),
  nw: document.getElementById('resize-nw'),
  navNe: document.getElementById('resize-nav-ne'),
  navNw: document.getElementById('resize-nav-nw'),
};
const modeIndicator = document.getElementById('mode-indicator');
const widgetContainer = document.getElementById('widget-container');
const centerColumn = document.getElementById('center-column');
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

// Notes panel — instantiated from page-notes.js, inserted into DOM
const pageNotesPane = new PageNotesPane();
const notesPanel = pageNotesPane.getElement();
const notesPanelAnchor = document.getElementById('notes-panel-anchor');
if (notesPanelAnchor) {
  notesPanelAnchor.replaceWith(notesPanel);
}

console.log('[page] DOM elements initialized');

// Disable component-level keyboard shortcuts — page.js handles them via pubsub
navbar.shortcuts = false;

// --- peek-navbar component event wiring ---
navbar.addEventListener('navigate', (e) => {
  const url = e.detail?.url;
  if (url) {
    DEBUG && console.log('[page] Navigating to:', url);
    webview.loadURL(url);
    navbar.setUrl(url);
  }
});
navbar.addEventListener('go-back', () => {
  if (webview.canGoBack()) {
    DEBUG && console.log('[page] navbar go-back');
    webview.goBack();
    updateState();
  }
});
navbar.addEventListener('go-forward', () => {
  if (webview.canGoForward()) {
    DEBUG && console.log('[page] navbar go-forward');
    webview.goForward();
    updateState();
  }
});
navbar.addEventListener('reload', () => {
  DEBUG && console.log('[page] navbar reload');
  webview.reload();
});

// --- Window bounds computation ---
// Computes the BrowserWindow bounds from the webview screen position.
// extraWidth is distributed symmetrically — flexbox centering keeps
// the center column (and webview) at the same screen position.
let extraWidth = 0;

function computeWindowBounds(sb) {
  const winX = sb.x - MARGIN - extraWidth / 2;
  const winY = sb.y - TRIGGER_ZONE_HEIGHT - (NAVBAR_HEIGHT + NAVBAR_GAP);
  const winW = sb.width + MARGIN * 2 + extraWidth;
  const winH = sb.height + TRIGGER_ZONE_HEIGHT + MARGIN + (NAVBAR_HEIGHT + NAVBAR_GAP);

  return { x: Math.round(winX), y: Math.round(winY), width: Math.round(winW), height: Math.round(winH) };
}

// --- Position all elements relative to the window ---

function updateUrlParams() {
  // Keep the URL search params in sync with current screen bounds so that
  // session save (extractCanvasBounds) reads the latest position/size.
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('x', String(Math.round(screenBounds.x)));
    url.searchParams.set('y', String(Math.round(screenBounds.y)));
    url.searchParams.set('width', String(Math.round(screenBounds.width)));
    url.searchParams.set('height', String(Math.round(screenBounds.height)));
    history.replaceState(null, '', url.toString());
  } catch (e) {
    DEBUG && console.log('[page] Failed to update URL params:', e);
  }
}

function updatePositions() {
  // Elements are positioned within the center column, which is auto-centered
  // by flexbox. When the window is wider than needed (extraWidth > 0), the
  // gutters absorb the extra space — no element repositioning needed.

  const navVisible = navbar.classList.contains('visible');
  const navOffset = NAVBAR_HEIGHT + NAVBAR_GAP;

  // Set center column width so flexbox can center it
  centerColumn.style.width = `${screenBounds.width + MARGIN * 2}px`;

  // Webview — positioned after navbar area + trigger zone (fixed position)
  const webviewLeft = MARGIN;
  const webviewTop = navOffset + TRIGGER_ZONE_HEIGHT;
  const webviewWidth = screenBounds.width;
  const webviewHeight = screenBounds.height;

  webview.style.left = `${webviewLeft}px`;
  webview.style.top = `${webviewTop}px`;
  webview.style.width = `${webviewWidth}px`;
  webview.style.height = `${webviewHeight}px`;

  // Drag overlay — covers webview area exactly
  dragOverlay.style.left = `${webviewLeft}px`;
  dragOverlay.style.top = `${webviewTop}px`;
  dragOverlay.style.width = `${webviewWidth}px`;
  dragOverlay.style.height = `${webviewHeight}px`;

  // Navbar — always positioned at the top of the window
  navbar.style.left = `${MARGIN}px`;
  navbar.style.top = `0px`;
  navbar.style.width = `${webviewWidth}px`;

  // Trigger zone — covers the area above the webview.
  // When navbar is hidden, it spans the full top area (navbar space + gap) for hover detection.
  // When navbar is visible, it just covers the small gap between navbar and webview.
  triggerZone.style.left = `${MARGIN}px`;
  triggerZone.style.top = navVisible ? `${navOffset}px` : '0px';
  triggerZone.style.width = `${webviewWidth}px`;
  triggerZone.style.height = navVisible ? `${TRIGGER_ZONE_HEIGHT}px` : `${navOffset + TRIGGER_ZONE_HEIGHT}px`;

  // Resize handles — all four corners of the webview (24x24)
  resizeHandles.se.style.left = `${webviewLeft + webviewWidth - 24}px`;
  resizeHandles.se.style.top = `${webviewTop + webviewHeight - 24}px`;

  resizeHandles.sw.style.left = `${webviewLeft}px`;
  resizeHandles.sw.style.top = `${webviewTop + webviewHeight - 24}px`;

  resizeHandles.ne.style.left = `${webviewLeft + webviewWidth - 24}px`;
  resizeHandles.ne.style.top = `${webviewTop}px`;

  resizeHandles.nw.style.left = `${webviewLeft}px`;
  resizeHandles.nw.style.top = `${webviewTop}px`;

  // Navbar corner resize handles — only visible when navbar is shown
  resizeHandles.navNe.style.display = navVisible ? '' : 'none';
  resizeHandles.navNw.style.display = navVisible ? '' : 'none';
  if (navVisible) {
    resizeHandles.navNe.style.left = `${MARGIN + webviewWidth - 24}px`;
    resizeHandles.navNe.style.top = `0px`;
    resizeHandles.navNw.style.left = `${MARGIN}px`;
    resizeHandles.navNw.style.top = `0px`;
  }

  // Mode indicator — top-right corner of the webview
  if (modeIndicator) {
    modeIndicator.style.left = `${webviewLeft + webviewWidth - 120}px`;
    modeIndicator.style.top = `${webviewTop + 8}px`;
  }

  // Widget container — right side of the webview with a gap
  if (widgetContainer) {
    const widgetGap = 12;
    widgetContainer.style.left = `${webviewLeft + webviewWidth + widgetGap}px`;
    widgetContainer.style.top = `${webviewTop}px`;
  }

  // Panel top offset — enough clearance below the top edge of the web content area
  const panelTopOffset = webviewTop + 40;

  // Page Info Panel — top-left, 75% off-page / 25% overlapping
  if (pageInfoPanel) {
    pageInfoPanel.style.left = `${webviewLeft - PANEL_WIDTH + PANEL_OVERLAP}px`;
    pageInfoPanel.style.top = `${panelTopOffset}px`;
    pageInfoPanel.style.width = `${PANEL_WIDTH}px`;
  }

  // Extensions Panel — left side, below page info
  if (extensionsPanel) {
    extensionsPanel.style.left = `${webviewLeft - PANEL_WIDTH + PANEL_OVERLAP}px`;
    const pageInfoHeight = (pageInfoPanel && pageInfoPanel.classList.contains('visible')) ? pageInfoPanel.offsetHeight : 0;
    const extensionsPanelTop = panelTopOffset + (pageInfoHeight > 0 ? pageInfoHeight + 12 : 0);
    extensionsPanel.style.top = `${extensionsPanelTop}px`;
    extensionsPanel.style.width = `${PANEL_WIDTH}px`;
  }

  // Tags Panel — right side, top of right stack
  if (tagsPanel) {
    tagsPanel.style.left = `${webviewLeft + webviewWidth - PANEL_OVERLAP}px`;
    tagsPanel.style.top = `${panelTopOffset}px`;
    tagsPanel.style.width = `${PANEL_WIDTH}px`;
  }

  // Notes Panel — right side, below tags panel
  if (notesPanel) {
    notesPanel.style.left = `${webviewLeft + webviewWidth - PANEL_OVERLAP}px`;
    const tagsHeight = (tagsPanel && tagsPanel.classList.contains('visible')) ? tagsPanel.offsetHeight : 0;
    const notesPanelTop = panelTopOffset + (tagsHeight > 0 ? tagsHeight + 12 : 0);
    notesPanel.style.top = `${notesPanelTop}px`;
    notesPanel.style.width = `${PANEL_WIDTH}px`;
  }

  // Entities Panel — right side, below notes panel
  if (entitiesPanel) {
    entitiesPanel.style.left = `${webviewLeft + webviewWidth - PANEL_OVERLAP}px`;
    const tagsHeight = (tagsPanel && tagsPanel.classList.contains('visible')) ? tagsPanel.offsetHeight : 0;
    const notesHeight = (notesPanel && notesPanel.classList.contains('visible')) ? notesPanel.offsetHeight : 0;
    let entitiesPanelTop = panelTopOffset;
    if (tagsHeight > 0) entitiesPanelTop += tagsHeight + 12;
    if (notesHeight > 0) entitiesPanelTop += notesHeight + 12;
    entitiesPanel.style.top = `${entitiesPanelTop}px`;
    entitiesPanel.style.width = `${PANEL_WIDTH}px`;
  }
}

// --- Set window bounds via IPC ---

let pendingBoundsUpdate = null;

function setWindowBounds(bounds) {
  // Throttle to ~60fps using requestAnimationFrame
  if (pendingBoundsUpdate) return;
  pendingBoundsUpdate = requestAnimationFrame(() => {
    pendingBoundsUpdate = null;
    api.window.setBounds(bounds);
  });
}


// --- Set extra window width (for panels, widgets, etc.) ---
// Expands the window symmetrically. Flexbox keeps the center column in place.
// Returns a promise that resolves when the window bounds have been applied.
function setWindowPadding(width) {
  width = Math.max(0, width);
  if (width === extraWidth) return Promise.resolve();
  extraWidth = width;
  if (pendingBoundsUpdate) {
    cancelAnimationFrame(pendingBoundsUpdate);
    pendingBoundsUpdate = null;
  }
  const p = api.window.setBounds(computeWindowBounds(screenBounds));
  DEBUG && console.log('[page] Window padding set to', width);
  return p;
}

// Initial positioning
updatePositions();

// --- Set up webview partition and load URL ---

async function initWebview() {
  console.log('[page] initWebview: getting partition...');
  try {
    const result = await api.profiles.getPartition();
    if (result.success && result.data?.partition) {
      webview.partition = result.data.partition;
      DEBUG && console.log('[page] Set webview partition:', result.data.partition);
    } else {
      DEBUG && console.log('[page] No partition available, using default session');
    }
  } catch (err) {
    console.error('[page] Failed to get partition:', err);
  }

  console.log('[page] initWebview: partition resolved, setting src:', targetUrl);
  webview.src = targetUrl;
  console.log('[page] initWebview: src set');
  navbar.setUrl(targetUrl);
}

// --- Loading lifecycle & visual effect ---
// Simple state machine: 'loading' or 'loaded'.
// Visual effect (CSS class) subscribes to state changes.

const loadingLifecycle = {
  _state: 'idle',
  _listeners: [],

  get state() { return this._state; },

  startLoading() {
    if (this._state === 'loading') return;
    this._state = 'loading';
    this._notify();
    DEBUG && console.log('[page] Loading started');
  },

  stopLoading() {
    if (this._state === 'loaded') return;
    this._state = 'loaded';
    this._notify();
    DEBUG && console.log('[page] Loading finished');
  },

  onChange(fn) {
    this._listeners.push(fn);
  },

  _notify() {
    for (const fn of this._listeners) fn(this._state);
  }
};

// --- Show / Hide navbar state ---
// Declared here (before loadingLifecycle.onChange) so they are initialized when
// startLoading() triggers show() synchronously during module execution.
let hideTimer = null;
let showSource = null; // 'hover', 'shortcut', or 'loading'

// Visual effect module — applies/removes CSS classes based on lifecycle state
// Also shows/hides navbar with loading spinner during page load.
loadingLifecycle.onChange((state) => {
  if (state === 'loading') {
    console.log('[page] Loading state: loading');
    webview.classList.add('loading');
    webview.classList.remove('loaded');
    navbar.loading = true;
    show({ source: 'loading' });
  } else if (state === 'loaded') {
    console.log('[page] Loading state: loaded');
    webview.classList.remove('loading');
    webview.classList.add('loaded');
    navbar.loading = false;
    // Only auto-hide if the navbar was shown by loading (not by user hover/shortcut)
    if (showSource === 'loading') {
      hide();
    }
  }
});

initWebview();
loadingLifecycle.startLoading();

// --- In-page navigation loading indicator ---
// When the user clicks a link inside the webview, show the same loading glow.
// Filter out trivial navigations (hash changes, same-page anchors).

webview.addEventListener('did-start-navigation', (e) => {
  // Only track main frame navigations
  if (!e.isMainFrame) return;
  // Skip same-page anchor / hash-only navigations
  try {
    const currentUrl = webview.getURL();
    if (currentUrl && e.url) {
      const current = new URL(currentUrl);
      const next = new URL(e.url);
      // Same origin + path, only hash differs → skip
      if (current.origin === next.origin &&
          current.pathname === next.pathname &&
          current.search === next.search &&
          next.hash !== current.hash) {
        return;
      }
    }
  } catch (_) {
    // URL parsing failed, proceed with showing indicator
  }
  DEBUG && console.log('[page] Navigation started (in-webview):', e.url);
  loadingLifecycle.startLoading();
});

webview.addEventListener('did-stop-loading', () => {
  console.log('[page] did-stop-loading fired');
  loadingLifecycle.stopLoading();
});

// --- Custom drag ---
// Two modes:
//   1. Navbar background: instant drag (no hold delay)
//   2. Anywhere else: hold for dragHoldDelay (default 1s) then drag
// Drag now moves the BrowserWindow itself via setBounds() IPC.

let isDragging = false;
let dragStartScreenX = 0;
let dragStartScreenY = 0;
let dragStartBoundsX = 0;
let dragStartBoundsY = 0;
let pageMouseButtonDown = false;

// Hold-to-drag state (configurable, read from prefs at init)
const JITTER_TOLERANCE = 3; // px of movement allowed during hold without cancelling
let DRAG_HOLD_THRESHOLD = 1000; // ms, updated from prefs
let holdDragTimer = null;
let holdDragPending = false;
let holdDragReady = false; // true when hold fires, cursor is 'grab', waiting for movement
let holdDragStartScreenX = 0;
let holdDragStartScreenY = 0;

// Read drag hold delay from prefs
(async () => {
  try {
    const prefs = await api.invoke('get-app-prefs');
    if (prefs && typeof prefs.dragHoldDelay === 'number') {
      DRAG_HOLD_THRESHOLD = Math.max(0, prefs.dragHoldDelay * 1000);
    }
  } catch {}
})();

function startDrag(screenX, screenY) {
  isDragging = true;
  dragStartScreenX = screenX;
  dragStartScreenY = screenY;
  dragStartBoundsX = screenBounds.x;
  dragStartBoundsY = screenBounds.y;
  document.body.style.cursor = 'grabbing';
}

function cancelHoldDrag() {
  if (holdDragTimer) {
    clearTimeout(holdDragTimer);
    holdDragTimer = null;
  }
  holdDragPending = false;
  holdDragReady = false;
  dragOverlay.classList.remove('active');
  document.body.style.cursor = '';
}

// Instant drag on navbar background (excluding buttons and URL text inside shadow DOM)
navbar.addEventListener('mousedown', (e) => {
  // The peek-navbar component handles its own button/input mousedowns with stopPropagation,
  // so if the event reaches us, it's on the navbar background — start drag.
  pageMouseButtonDown = true;
  startDrag(e.screenX, e.screenY);
  navbar.style.cursor = 'grabbing';
  e.preventDefault();
});

// Hold-to-drag from anywhere on the document.
// User must hold still (within jitter tolerance) for DRAG_HOLD_THRESHOLD ms.
// When hold fires, cursor changes to 'grab'. Movement after that starts drag.
// Any movement during hold period cancels the timer, allowing text selection.
document.addEventListener('mousedown', (e) => {
  if (e.target.closest('.resize-handle')) return;
  if (isDragging) return;
  if (e.button !== 0) return;
  pageMouseButtonDown = true;

  holdDragPending = true;
  holdDragStartScreenX = e.screenX;
  holdDragStartScreenY = e.screenY;

  holdDragTimer = setTimeout(() => {
    if (holdDragPending) {
      // Hold fired — show grab cursor as visual feedback, wait for movement
      holdDragPending = false;
      holdDragReady = true;
      document.body.style.cursor = 'grab';
    }
  }, DRAG_HOLD_THRESHOLD);
});

document.addEventListener('mousemove', (e) => {
  if (!pageMouseButtonDown) return;

  // During hold period: cancel if mouse moves beyond jitter tolerance
  if (holdDragPending && holdDragTimer) {
    const dx = Math.abs(e.screenX - holdDragStartScreenX);
    const dy = Math.abs(e.screenY - holdDragStartScreenY);
    if (dx > JITTER_TOLERANCE || dy > JITTER_TOLERANCE) {
      cancelHoldDrag();
    }
    return;
  }

  // After hold fired (cursor is 'grab'): movement starts drag
  if (holdDragReady && !isDragging) {
    holdDragReady = false;
    startDrag(holdDragStartScreenX, holdDragStartScreenY);
  }
});

document.addEventListener('mouseup', () => {
  pageMouseButtonDown = false;
  cancelHoldDrag();
});

// --- Webview hold-to-drag via injected mouse event bridge + overlay ---
// The webview is a separate Electron renderer process — mouse events inside it
// don't propagate to the host document. We solve this by:
// 1. Injecting a mouse event bridge into the guest page via executeJavaScript
// 2. The guest script sends mousedown/mouseup/mousemove signals via console.log
// 3. The host listens for console-message events on the <webview> element
// 4. On mousedown from webview, the host starts a hold-to-drag timer
// 5. On mouseup from webview, the host cancels the timer / ends drag
// 6. When the timer fires, the host activates the drag overlay and starts dragging
// The overlay (pointer-events:all when active) captures all subsequent mouse events.

const WEBVIEW_MOUSE_BRIDGE_JS = `
(function() {
  if (window.__peekMouseBridgeInstalled) return;
  window.__peekMouseBridgeInstalled = true;

  // Save native console.log before the page can override it
  var nativeLog = console.log.bind(console);
  var buttonDown = false;

  document.addEventListener('mousedown', function(e) {
    if (e.button !== 0) return;
    buttonDown = true;
    nativeLog('__PEEK_MOUSEDOWN__:' + e.screenX + ':' + e.screenY);
  }, true);

  document.addEventListener('mouseup', function() {
    if (buttonDown) {
      buttonDown = false;
      nativeLog('__PEEK_MOUSEUP__');
    }
  }, true);

  // Only send mousemove while button is held (avoids flooding the bridge)
  document.addEventListener('mousemove', function(e) {
    if (!buttonDown) return;
    nativeLog('__PEEK_MOUSEMOVE__:' + e.screenX + ':' + e.screenY);
  }, true);
})();
`;

// Track webview mouse state separately from document mouse state
let webviewMouseDown = false;
let webviewHoldTimer = null;
let webviewHoldScreenX = 0;
let webviewHoldScreenY = 0;
let webviewHoldReady = false;  // true after hold threshold, waiting for movement to start drag

function cancelWebviewHold() {
  if (webviewHoldTimer) {
    clearTimeout(webviewHoldTimer);
    webviewHoldTimer = null;
  }
  if (webviewHoldReady) {
    document.body.style.cursor = '';
  }
  webviewHoldReady = false;
}

webview.addEventListener('console-message', (e) => {
  if (typeof e.message !== 'string') return;

  // --- Mousedown from webview: start hold-to-drag timer ---
  if (e.message.startsWith('__PEEK_MOUSEDOWN__:')) {
    const parts = e.message.split(':');
    const screenX = parseFloat(parts[1]);
    const screenY = parseFloat(parts[2]);
    if (isNaN(screenX) || isNaN(screenY)) return;

    webviewMouseDown = true;
    webviewHoldScreenX = screenX;
    webviewHoldScreenY = screenY;
    cancelWebviewHold();

    webviewHoldTimer = setTimeout(() => {
      webviewHoldTimer = null;
      if (!webviewMouseDown) return;  // Released before threshold
      // Hold fired — show grab cursor as visual feedback, wait for movement to confirm drag.
      webviewHoldReady = true;
      document.body.style.cursor = 'grab';
      DEBUG && console.log('[page] Webview hold ready (cursor→grab), waiting for movement');
    }, DRAG_HOLD_THRESHOLD);
    return;
  }

  // --- Mouseup from webview: cancel hold timer / end drag ---
  if (e.message === '__PEEK_MOUSEUP__') {
    webviewMouseDown = false;
    cancelWebviewHold();
    // If drag was active, fully end it — webview mouseup won't bubble to document,
    // so we must clean up here to avoid the drag overlay staying active and blocking clicks.
    if (isDragging) {
      isDragging = false;
      pageMouseButtonDown = false;
      dragOverlay.classList.remove('active');
      document.body.style.cursor = '';
      navbar.style.cursor = 'grab';
      updateUrlParams();
    }
    return;
  }

  // --- Mousemove from webview: update drag or cancel hold ---
  if (e.message.startsWith('__PEEK_MOUSEMOVE__:')) {
    const parts = e.message.split(':');
    const screenX = parseFloat(parts[1]);
    const screenY = parseFloat(parts[2]);
    if (isNaN(screenX) || isNaN(screenY)) return;

    // If actively dragging, update window position from webview mouse coords.
    if (isDragging) {
      const dx = screenX - dragStartScreenX;
      const dy = screenY - dragStartScreenY;
      screenBounds.x = dragStartBoundsX + dx;
      screenBounds.y = dragStartBoundsY + dy;
      setWindowBounds(computeWindowBounds(screenBounds));
      return;
    }

    // Hold threshold passed and mouse is moving — start drag now
    if (webviewHoldReady) {
      webviewHoldReady = false;
      dragOverlay.classList.add('active');
      pageMouseButtonDown = true;
      startDrag(webviewHoldScreenX, webviewHoldScreenY);
      DEBUG && console.log('[page] Webview hold-drag started at', webviewHoldScreenX, webviewHoldScreenY);
      return;
    }

    if (!webviewHoldTimer) return;  // No pending hold
    const dx = Math.abs(screenX - webviewHoldScreenX);
    const dy = Math.abs(screenY - webviewHoldScreenY);
    if (dx > JITTER_TOLERANCE || dy > JITTER_TOLERANCE) {
      cancelWebviewHold();
    }
    return;
  }

  // --- Popup-to-opener postMessage bridge (Level 3) ---
  // When a popup's webview guest calls window.opener.postMessage(), the injected
  // shim logs this message. We forward it to the main process which routes it
  // to the opener window.
  if (e.message.startsWith('__PEEK_OPENER_POSTMESSAGE__:')) {
    const jsonStr = e.message.substring('__PEEK_OPENER_POSTMESSAGE__:'.length);
    try {
      const payload = JSON.parse(jsonStr);
      DEBUG && console.log('[page] Forwarding opener postMessage:', payload);
      api.invoke('opener-postmessage', payload);
    } catch (err) {
      console.error('[page] Failed to parse opener postMessage:', err);
    }
    return;
  }

  // --- Popup opener.close() bridge (Level 4) ---
  if (e.message === '__PEEK_OPENER_CLOSE__') {
    DEBUG && console.log('[page] Popup requested opener.close()');
    api.invoke('opener-close');
    return;
  }

  // --- Popup opener.focus() bridge (Level 4) ---
  if (e.message === '__PEEK_OPENER_FOCUS__') {
    DEBUG && console.log('[page] Popup requested opener.focus()');
    api.invoke('opener-focus');
    return;
  }
});

let mouseBridgeTimer = null;

function injectMouseBridge() {
  webview.executeJavaScript(WEBVIEW_MOUSE_BRIDGE_JS)
    .then(() => { DEBUG && console.log('[page] Mouse bridge injected'); })
    .catch((err) => { console.warn('[page] Mouse bridge injection failed:', err.message); });
}

// Inject on dom-ready (fires on each full navigation)
webview.addEventListener('dom-ready', injectMouseBridge);

// Also inject on did-navigate and did-finish-load for robustness.
// Some navigations skip dom-ready; some sites run scripts that reset global state.
// Cancel any pending injection from a previous navigation to avoid listener buildup.
webview.addEventListener('did-navigate', () => {
  if (mouseBridgeTimer) clearTimeout(mouseBridgeTimer);
  mouseBridgeTimer = setTimeout(() => {
    mouseBridgeTimer = null;
    injectMouseBridge();
  }, 50);
});

webview.addEventListener('did-finish-load', () => {
  // Re-inject after full load — catches cases where dom-ready injection was too early
  // or the page's own scripts cleared global state. The bridge's __peekMouseBridgeInstalled
  // guard prevents duplicate listeners if the bridge is already active.
  injectMouseBridge();
});

dragOverlay.addEventListener('mouseup', () => {
  dragOverlay.classList.remove('active');
  webviewMouseDown = false;
  cancelWebviewHold();
});

// --- Custom resize (all corner handles) ---
// Uses pointer capture. On each pointermove, calls setBounds() to resize the
// BrowserWindow AND updates element positions within the window.

let isResizing = false;
let resizeDir = null;
let resizeStartX = 0;
let resizeStartY = 0;
let resizeStartWidth = 0;
let resizeStartHeight = 0;
let resizeStartBoundsX = 0;
let resizeStartBoundsY = 0;
let activeResizeHandle = null;

function initResizeHandle(handle) {
  if (!handle) return;

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    isResizing = true;
    resizeDir = handle.dataset.dir;
    resizeStartX = e.screenX;
    resizeStartY = e.screenY;
    resizeStartWidth = screenBounds.width;
    resizeStartHeight = screenBounds.height;
    resizeStartBoundsX = screenBounds.x;
    resizeStartBoundsY = screenBounds.y;
    activeResizeHandle = handle;
    document.body.style.cursor = `${resizeDir}-resize`;
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  });

  handle.addEventListener('pointermove', (e) => {
    if (!isResizing || activeResizeHandle !== handle) return;
    if (e.buttons === 0) {
      cancelResize();
      return;
    }
    const dx = e.screenX - resizeStartX;
    const dy = e.screenY - resizeStartY;

    // Apply resize based on direction (update screen bounds)
    if (resizeDir === 'se') {
      screenBounds.width = Math.max(MIN_WIDTH, resizeStartWidth + dx);
      screenBounds.height = Math.max(MIN_HEIGHT, resizeStartHeight + dy);
    } else if (resizeDir === 'sw') {
      const newWidth = Math.max(MIN_WIDTH, resizeStartWidth - dx);
      screenBounds.x = resizeStartBoundsX + (resizeStartWidth - newWidth);
      screenBounds.width = newWidth;
      screenBounds.height = Math.max(MIN_HEIGHT, resizeStartHeight + dy);
    } else if (resizeDir === 'ne') {
      screenBounds.width = Math.max(MIN_WIDTH, resizeStartWidth + dx);
      const newHeight = Math.max(MIN_HEIGHT, resizeStartHeight - dy);
      screenBounds.y = resizeStartBoundsY + (resizeStartHeight - newHeight);
      screenBounds.height = newHeight;
    } else if (resizeDir === 'nw') {
      const newWidth = Math.max(MIN_WIDTH, resizeStartWidth - dx);
      screenBounds.x = resizeStartBoundsX + (resizeStartWidth - newWidth);
      screenBounds.width = newWidth;
      const newHeight = Math.max(MIN_HEIGHT, resizeStartHeight - dy);
      screenBounds.y = resizeStartBoundsY + (resizeStartHeight - newHeight);
      screenBounds.height = newHeight;
    }

    // Update both window bounds and element positions
    updatePositions();
    setWindowBounds(computeWindowBounds(screenBounds));
  });

  handle.addEventListener('pointerup', (e) => {
    if (isResizing && activeResizeHandle === handle) {
      cancelResize();
      handle.releasePointerCapture(e.pointerId);
    }
  });

  handle.addEventListener('pointercancel', () => {
    if (isResizing && activeResizeHandle === handle) {
      cancelResize();
    }
  });
}

Object.values(resizeHandles).forEach(initResizeHandle);

function cancelResize() {
  const wasResizing = isResizing;
  isResizing = false;
  resizeDir = null;
  activeResizeHandle = null;
  document.body.style.cursor = '';
  if (wasResizing) {
    updateUrlParams();
  }
}

// --- Shared mousemove/mouseup for drag ---
// Drag now moves the BrowserWindow via setBounds() IPC

document.addEventListener('mousemove', (e) => {
  if (isDragging && !pageMouseButtonDown) {
    isDragging = false;
    dragOverlay.classList.remove('active');
    document.body.style.cursor = '';
    navbar.style.cursor = 'grab';
    updateUrlParams();
    return;
  }

  if (isDragging) {
    const dx = e.screenX - dragStartScreenX;
    const dy = e.screenY - dragStartScreenY;
    screenBounds.x = dragStartBoundsX + dx;
    screenBounds.y = dragStartBoundsY + dy;
    // Move the window — element positions within the window stay the same
    setWindowBounds(computeWindowBounds(screenBounds));
  }
});

document.addEventListener('mouseup', () => {
  if (isDragging) {
    isDragging = false;
    dragOverlay.classList.remove('active');
    document.body.style.cursor = '';
    navbar.style.cursor = 'grab';
    updateUrlParams();
  }
});

// --- State display ---

function updateState() {
  // Guard: webview methods (canGoBack, canGoForward) are only available after the
  // guest process is attached. Calling them before src is set throws an error.
  // During initial loading (show() called from startLoading()), the webview isn't
  // ready yet, so we silently skip.
  try {
    navbar.canGoBack = webview.canGoBack();
    navbar.canGoForward = webview.canGoForward();
  } catch {
    // Webview not ready yet — will be updated on did-navigate
  }
}

// --- Show / Hide navbar ---
// When the navbar becomes visible, the window must expand upward to accommodate it.
// When it hides, the window contracts back down.
// NOTE: hideTimer and showSource are declared near the top of the file (before
// loadingLifecycle.onChange) to avoid TDZ errors when startLoading() calls show()
// during module initialization.

// Generation counter to prevent stale hide() completions from clobbering a
// subsequent show(). Incremented by both show() and hide() — if show() fires
// while hide() is awaiting setBounds, the hide's post-await code sees a stale
// generation and bails out.
let navbarGeneration = 0;

async function show(opts) {
  console.log('[page] show() called, source:', opts?.source);
  navbarGeneration++;
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  const wasHidden = !navbar.classList.contains('visible');
  navbar.classList.add('visible');
  if (opts?.source) showSource = opts.source;
  if (wasHidden) {
    // Window is already the right size (always includes navbar space).
    // Just update trigger zone and resize handle visibility.
    updatePositions();
    updateState();
    DEBUG && console.log('[page] Navbar shown, source:', showSource);
  }
  if (opts?.focusUrl) {
    navbar.focusUrl();
  }

  // Fade-to-invisible before expanding window to prevent compositor desync flash.
  // Same technique as hide() — make content invisible so the stale pixel buffer
  // during resize is transparent, then restore after setBounds completes.
  centerColumn.style.opacity = '0';
  // Show page info and entities panels alongside navbar
  // Expand window to fit panel overhang on each side
  if (pageInfoPanel) pageInfoPanel.classList.add('visible');
  if (tagsPanel) tagsPanel.classList.add('visible');
  if (entitiesPanel) entitiesPanel.classList.add('visible');
  if (extensionsPanel) extensionsPanel.classList.add('visible');
  if (notesPanel) notesPanel.classList.add('visible');
  // Re-run positions now that panels are visible (offsetHeight is accurate)
  updatePositions();
  await setWindowPadding(PANEL_OVERHANG * 2);
  centerColumn.style.opacity = '1';
}

async function hide() {
  if (isDragging || holdDragPending) return;
  // Don't hide while page is loading — navbar stays visible with spinner
  if (loadingLifecycle.state === 'loading') return;
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  const gen = ++navbarGeneration;
  // Fade-to-invisible before resizing to prevent compositor desync flash.
  // The OS resizes the NSWindow before Chromium re-renders, causing a one-frame
  // glitch where stale pixels are visible. By making content invisible first,
  // the stale frame is transparent (invisible to the user).
  centerColumn.style.opacity = '0';
  await setWindowPadding(0);
  // If show() was called while we were awaiting, abort — don't clobber the new state
  if (navbarGeneration !== gen) return;
  navbar.classList.remove('visible');
  // Hide page info, entities, and extensions panels alongside navbar
  if (pageInfoPanel) pageInfoPanel.classList.remove('visible');
  if (tagsPanel) tagsPanel.classList.remove('visible');
  if (entitiesPanel) entitiesPanel.classList.remove('visible');
  if (extensionsPanel) extensionsPanel.classList.remove('visible');
  if (notesPanel) notesPanel.classList.remove('visible');
  updatePositions();
  // Restore visibility now that the window has been resized
  centerColumn.style.opacity = '1';
  navbar.inputElement?.blur();
  showSource = null;
  DEBUG && console.log('[page] Navbar hidden');
}

// Dismiss on click outside the navbar (also check panels)
document.addEventListener('mousedown', (e) => {
  if (navbar.classList.contains('visible') && !navbar.contains(e.target) && e.target !== triggerZone && !e.target.closest('.resize-handle')
      && !(pageInfoPanel && pageInfoPanel.contains(e.target))
      && !(tagsPanel && tagsPanel.contains(e.target))
      && !(entitiesPanel && entitiesPanel.contains(e.target))
      && !(extensionsPanel && extensionsPanel.contains(e.target))
      && !(notesPanel && notesPanel.contains(e.target))) {
    hide();
  }
});

// Dismiss on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && navbar.classList.contains('visible')) {
    hide();
    e.stopPropagation();
  }
});

// --- Hover trigger zone ---

let lastMouseY = 0;
document.addEventListener('mousemove', (e) => { lastMouseY = e.clientY; }, true);

function scheduleHide() {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (showSource !== 'hover' && showSource !== 'shortcut') return;
    // If cursor is still in the navbar+trigger area, don't hide.
    // This prevents the hide→contract→re-trigger→show bounce when cursor
    // crosses the boundary between navbar and webview.
    const navBottom = NAVBAR_HEIGHT + NAVBAR_GAP + TRIGGER_ZONE_HEIGHT;
    if (lastMouseY < navBottom) {
      // Cursor still near top — reschedule instead of hiding
      scheduleHide();
      return;
    }
    hide();
  }, 300);
}

function cancelHide() {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

triggerZone.addEventListener('mouseenter', () => {
  console.log('[page] Trigger zone mouseenter');
  // Suppress navbar auto-show during OAuth flows (Level 2) to avoid
  // interrupting credential entry. User can still Cmd+L to force show.
  if (isOnOAuthPage) {
    DEBUG && console.log('[page] Suppressing navbar hover during OAuth flow');
    return;
  }
  show({ source: 'hover' });
});

triggerZone.addEventListener('mouseleave', () => {
  if (showSource === 'hover' || showSource === 'shortcut') scheduleHide();
});

navbar.addEventListener('mouseenter', () => {
  cancelHide();
});

navbar.addEventListener('mouseleave', () => {
  if (showSource === 'hover' || showSource === 'shortcut') scheduleHide();
});

// Keep navbar visible when hovering page info or entities panels
if (pageInfoPanel) {
  pageInfoPanel.addEventListener('mouseenter', () => { cancelHide(); });
  pageInfoPanel.addEventListener('mouseleave', () => {
    if (showSource === 'hover' || showSource === 'shortcut') scheduleHide();
  });
}
if (entitiesPanel) {
  entitiesPanel.addEventListener('mouseenter', () => { cancelHide(); });
  entitiesPanel.addEventListener('mouseleave', () => {
    if (showSource === 'hover' || showSource === 'shortcut') scheduleHide();
  });
}
if (tagsPanel) {
  tagsPanel.addEventListener('mouseenter', () => { cancelHide(); });
  tagsPanel.addEventListener('mouseleave', () => {
    if (showSource === 'hover' || showSource === 'shortcut') scheduleHide();
  });
}
if (extensionsPanel) {
  extensionsPanel.addEventListener('mouseenter', () => { cancelHide(); });
  extensionsPanel.addEventListener('mouseleave', () => {
    if (showSource === 'hover' || showSource === 'shortcut') scheduleHide();
  });
}
if (notesPanel) {
  notesPanel.addEventListener('mouseenter', () => { cancelHide(); });
  notesPanel.addEventListener('mouseleave', () => {
    if (showSource === 'hover' || showSource === 'shortcut') scheduleHide();
  });
}

// Cmd+L: show navbar with URL focus
api.subscribe('page:show-navbar', (msg) => {
  console.log('[page] page:show-navbar received, windowId:', msg.windowId, 'myWindowId:', myWindowId);
  if (msg.windowId != null && msg.windowId !== myWindowId) return;
  show({ focusUrl: true, source: 'shortcut' });
}, api.scopes.GLOBAL);

// Cmd+R: reload the webview
api.subscribe('page:reload', (msg) => {
  if (msg.windowId != null && msg.windowId !== myWindowId) return;
  DEBUG && console.log('[page] Cmd+R: reloading webview');
  webview.reload();
}, api.scopes.GLOBAL);

// Cmd+[ / Cmd+Left: go back
api.subscribe('page:go-back', (msg) => {
  if (msg.windowId != null && msg.windowId !== myWindowId) return;
  if (webview.canGoBack()) {
    DEBUG && console.log('[page] Cmd+[: going back');
    webview.goBack();
    updateState();
  }
}, api.scopes.GLOBAL);

// Cmd+] / Cmd+Right: go forward
api.subscribe('page:go-forward', (msg) => {
  if (msg.windowId != null && msg.windowId !== myWindowId) return;
  if (webview.canGoForward()) {
    DEBUG && console.log('[page] Cmd+]: going forward');
    webview.goForward();
    updateState();
  }
}, api.scopes.GLOBAL);

// Navigate to a new URL (used by pagestream to flip between cards).
// Tracks the original URL so Escape can skip accumulated history.
let pagestreamOriginalUrl = null;

api.subscribe('page:navigate', (msg) => {
  if (msg.windowId != null && msg.windowId !== myWindowId) return;
  const url = msg.url;
  if (url) {
    DEBUG && console.log('[page] page:navigate:', url);
    if (!pagestreamOriginalUrl) pagestreamOriginalUrl = webview.getURL();
    webview.loadURL(url);
    navbar.setUrl(url);
  }
}, api.scopes.GLOBAL);

// Forward card-navigation keys to pagestream (only fires when webview is NOT focused,
// e.g., after pressing Escape which blurs to the page chrome level)
document.addEventListener('keydown', (e) => {
  // Don't intercept if typing in navbar
  if (document.activeElement === navbar || navbar.contains(document.activeElement)) return;

  const NAV_MAP = {
    'j': 'down', 'ArrowDown': 'down',
    'k': 'up', 'ArrowUp': 'up',
    'g': 'first', 'Home': 'first',
    'G': 'last', 'End': 'last',
  };

  const action = NAV_MAP[e.key];
  if (action) {
    e.preventDefault();
    api.publish('pagestream:nav', { action }, api.scopes.GLOBAL);
  }
});

// --- Nav button actions and URL navigation are handled by peek-navbar component ---
// Event listeners wired up in the "peek-navbar component event wiring" section above.
// On navigate or dismiss (Escape), also hide the navbar (page-specific behavior).
navbar.addEventListener('navigate', () => { hide(); });
navbar.addEventListener('dismiss', () => { hide(); });

// --- Escape handling ---

api.escape.onEscape(() => {
  // If a notes textarea is focused, blur it (saves and closes)
  if (pageNotesPane.hasActiveTextarea()) {
    DEBUG && console.log('[page] ESC: blurring notes textarea');
    pageNotesPane.blurActiveTextarea();
    return { handled: true };
  }
  // If navbar and widget panels are visible, hide them first
  if (navbar.classList.contains('visible')) {
    DEBUG && console.log('[page] ESC: hiding navbar and widget panels');
    hide();
    return { handled: true };
  }
  // If pagestream was flipping through cards, skip all accumulated history
  // and let backend close the window (return to pagestream)
  if (pagestreamOriginalUrl) {
    pagestreamOriginalUrl = null;
    DEBUG && console.log('[page] ESC: pagestream browsing, closing window');
    return { handled: false }; // let backend close
  }
  if (webview.canGoBack()) {
    DEBUG && console.log('[page] ESC: webview going back');
    webview.goBack();
    return { handled: true };
  }
  DEBUG && console.log('[page] ESC: at root, letting backend decide');
  return { handled: false };
});

// --- Webview events ---

webview.addEventListener('page-title-updated', (e) => {
  const newTitle = e.title || targetUrl;
  document.title = newTitle;

  if (newTitle && newTitle !== 'Loading...') {
    api.datastore.updateItemTitle(webview.getURL() || targetUrl, newTitle)
      .catch(err => console.error('[page] Failed to update title:', err));
  }
});

webview.addEventListener('did-navigate', async (e) => {
  DEBUG && console.log('[page] did-navigate:', e.url);
  navbar.setUrl(e.url);
  updateState();

  // Update OAuth state (Level 2)
  const wasOAuth = isOnOAuthPage;
  isOnOAuthPage = isOAuthUrl(e.url);
  if (isOnOAuthPage && !wasOAuth) {
    DEBUG && console.log('[page] OAuth flow detected:', e.url);
  } else if (!isOnOAuthPage && wasOAuth) {
    DEBUG && console.log('[page] OAuth flow ended');
  }

  try {
    await api.datastore.trackNavigation(e.url, {
      source: 'page',
      windowType: 'main'
    });
  } catch (err) {
    console.error('[page] Failed to record visit:', err);
  }
});

webview.addEventListener('did-navigate-in-page', (e) => {
  if (e.isMainFrame) {
    navbar.setUrl(e.url);
    updateState();
  }
});

webview.addEventListener('did-fail-load', (e) => {
  if (e.errorCode === -3) return; // Aborted navigation (e.g. replaced by new nav)
  console.error('[page] Load failed:', e.errorCode, e.errorDescription);
  loadingLifecycle.stopLoading();
});

// On dom-ready: detect page background color.
// Background detection prevents the white flash when loading pages in dark mode.
webview.addEventListener('dom-ready', async () => {
  // Detect background color (cosmetic)
  try {
    const bgResult = await webview.executeJavaScript(`
      (function() {
        function isTransparentColor(color) {
          if (!color) return true;
          if (color === 'transparent') return true;
          if (color === 'rgba(0, 0, 0, 0)') return true;
          var rgbaMatch = color.match(/rgba\\s*\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*([\\d.]+)\\s*\\)/);
          if (rgbaMatch && parseFloat(rgbaMatch[1]) === 0) return true;
          return false;
        }

        function getEffectiveBg(el) {
          if (!el) return null;
          var style = window.getComputedStyle(el);
          var bgColor = style.backgroundColor;
          if (!isTransparentColor(bgColor)) return bgColor;
          return null;
        }

        var bodyBg = getEffectiveBg(document.body);
        var htmlBg = getEffectiveBg(document.documentElement);
        var detectedBg = bodyBg || htmlBg || null;
        var hasAnyBg = !!(bodyBg || htmlBg ||
          (document.body && window.getComputedStyle(document.body).backgroundImage !== 'none') ||
          (document.documentElement && window.getComputedStyle(document.documentElement).backgroundImage !== 'none'));

        return { detectedBg: detectedBg, hasAnyBg: hasAnyBg };
      })();
    `);

    if (!bgResult.hasAnyBg) {
      // Page has no background — set white inside the page
      await webview.executeJavaScript(
        "document.documentElement.style.backgroundColor = '#ffffff';"
      );
      webview.style.background = '#ffffff';
      DEBUG && console.log('[page] No background detected, set default white');
    } else if (bgResult.detectedBg) {
      // Match the webview element's backing color to the page's actual bg
      webview.style.background = bgResult.detectedBg;
      DEBUG && console.log('[page] Detected background:', bgResult.detectedBg);
    }
  } catch (err) {
    console.error('[page] Failed to detect background:', err);
  }
});

// --- OpenSearch discovery, loading lifecycle & page:loaded event ---

webview.addEventListener('did-finish-load', async () => {
  loadingLifecycle.stopLoading();
  const pageUrl = webview.getURL();
  if (!pageUrl) return;
  if (!pageUrl.startsWith('http://') && !pageUrl.startsWith('https://')) return;

  let opensearchUrl = null;

  try {
    const detectedUrl = await webview.executeJavaScript(`
      (function() {
        const link = document.querySelector('link[rel="search"][type="application/opensearchdescription+xml"]');
        return link ? link.href : null;
      })();
    `);

    if (detectedUrl) {
      try {
        opensearchUrl = new URL(detectedUrl, pageUrl).href;
      } catch (e) {
        // Invalid URL, skip
      }
    }
  } catch (err) {
    DEBUG && console.log('[page] OpenSearch detection failed:', err.message);
  }

  const pageTitle = document.title || webview.getTitle() || '';
  api.publish('page:loaded', {
    url: pageUrl,
    title: pageTitle,
    opensearchUrl
  }, api.scopes.GLOBAL);

  DEBUG && console.log('[page] page:loaded published:', pageUrl, opensearchUrl ? `(OpenSearch: ${opensearchUrl})` : '');
});

// --- Commands ---

api.commands.register({
  name: 'Back',
  description: 'Go back in page history',
  scope: 'window',
  canExecute: () => webview.canGoBack(),
  execute: () => webview.goBack()
});

api.commands.register({
  name: 'Forward',
  description: 'Go forward in page history',
  scope: 'window',
  canExecute: () => webview.canGoForward(),
  execute: () => webview.goForward()
});

api.commands.register({
  name: 'Reload',
  description: 'Reload the current page',
  scope: 'window',
  execute: () => webview.reload()
});

// --- Mode indicator ---

let currentMode = 'page';
let currentModeMetadata = {};

function updateModeIndicator() {
  if (!modeIndicator) return;

  const label = modeIndicator.querySelector('.mode-label');
  const groupName = modeIndicator.querySelector('.group-name');

  modeIndicator.setAttribute('data-mode', currentMode);

  if (label) {
    label.textContent = currentMode;
  }

  if (groupName) {
    if (currentMode === 'group' && currentModeMetadata.groupName) {
      groupName.textContent = currentModeMetadata.groupName;
      groupName.style.display = 'inline';
    } else {
      groupName.style.display = 'none';
    }
  }

  DEBUG && console.log('[page] Mode indicator updated:', currentMode, currentModeMetadata);
}

async function initModeContext() {
  try {
    const existingMode = await api.context.get('mode');
    if (existingMode.success && existingMode.data && existingMode.data.value === 'group') {
      currentMode = 'group';
      currentModeMetadata = existingMode.data.metadata || {};
      DEBUG && console.log('[page] Inherited group mode, preserving:', currentModeMetadata);
    } else {
      const result = await api.context.setMode('page', {
        metadata: {
          url: targetUrl,
          title: document.title
        }
      });

      if (result.success) {
        DEBUG && console.log('[page] Page mode set via context');
      } else {
        console.warn('[page] Failed to set page mode:', result.error);
      }
    }

    const modeResult = await api.context.get('mode');
    if (modeResult.success && modeResult.data) {
      currentMode = modeResult.data.value || 'page';
      currentModeMetadata = modeResult.data.metadata || {};
      updateModeIndicator();
    }

    api.context.watchMode((mode, entry) => {
      if (mode) {
        currentMode = mode;
        currentModeMetadata = entry?.metadata || {};
        updateModeIndicator();
      }
    });

  } catch (err) {
    console.error('[page] Failed to initialize mode context:', err);
  }
}

initModeContext();

// --- Widget system ---

const widgets = new Map();

function addWidget(id, { title, content, autoDismiss = 0, onClose } = {}) {
  if (widgets.has(id)) {
    removeWidget(id);
  }

  const el = document.createElement('div');
  el.className = 'widget';
  el.dataset.widgetId = id;

  const header = document.createElement('div');
  header.className = 'widget-header';

  const toggle = document.createElement('button');
  toggle.className = 'widget-toggle';
  toggle.textContent = '\u25BC';
  toggle.title = 'Collapse';

  const titleEl = document.createElement('span');
  titleEl.className = 'widget-title';
  titleEl.textContent = title || '';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'widget-close';
  closeBtn.textContent = '\u00D7';
  closeBtn.title = 'Dismiss';
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    removeWidget(id);
  });

  header.appendChild(toggle);
  header.appendChild(titleEl);
  header.appendChild(closeBtn);
  el.appendChild(header);

  const bodyWrap = document.createElement('div');
  bodyWrap.className = 'widget-body-wrap';

  const body = document.createElement('div');
  body.className = 'widget-body';
  if (typeof content === 'string') {
    body.innerHTML = content;
  } else if (content instanceof HTMLElement) {
    body.appendChild(content);
  }
  bodyWrap.appendChild(body);
  el.appendChild(bodyWrap);

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const collapsed = toggle.classList.toggle('collapsed');
    bodyWrap.classList.toggle('collapsed', collapsed);
    toggle.title = collapsed ? 'Expand' : 'Collapse';
  });

  widgetContainer.appendChild(el);

  const timers = [];

  requestAnimationFrame(() => {
    el.classList.add('visible');
  });

  if (autoDismiss > 0) {
    const timer = setTimeout(() => {
      removeWidget(id);
    }, autoDismiss);
    timers.push(timer);
  }

  const handle = {
    element: el,
    body,
    timers,
    onClose,
    close: () => removeWidget(id),
  };

  widgets.set(id, handle);

  DEBUG && console.log('[page] Widget added:', id, title);
  return handle;
}

function removeWidget(id) {
  const handle = widgets.get(id);
  if (!handle) return;

  for (const timer of handle.timers) {
    clearTimeout(timer);
  }

  handle.element.classList.remove('visible');
  handle.element.classList.add('hiding');

  setTimeout(() => {
    handle.element.remove();
  }, 300);

  if (handle.onClose) {
    try { handle.onClose(); } catch (e) { /* ignore */ }
  }

  widgets.delete(id);
  DEBUG && console.log('[page] Widget removed:', id);
}

function updateWidget(id, { content, title } = {}) {
  const handle = widgets.get(id);
  if (!handle) return;

  if (title !== undefined) {
    const titleEl = handle.element.querySelector('.widget-title');
    if (titleEl) titleEl.textContent = title;
  }

  if (content !== undefined) {
    if (typeof content === 'string') {
      handle.body.innerHTML = content;
    } else if (content instanceof HTMLElement) {
      handle.body.innerHTML = '';
      handle.body.appendChild(content);
    }
  }

  DEBUG && console.log('[page] Widget updated:', id);
}

// --- Panel collapse toggles (built-in panels in HTML) ---

document.querySelectorAll('.panel-toggle').forEach((toggle) => {
  const header = toggle.closest('.panel-header');
  const panel = header?.parentElement;
  const bodyWrap = panel?.querySelector('.panel-body-wrap');
  if (!bodyWrap) return;

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const collapsed = toggle.classList.toggle('collapsed');
    bodyWrap.classList.toggle('collapsed', collapsed);
    toggle.title = collapsed ? 'Expand' : 'Collapse';
  });
});

// --- Page Widget Host (extension-provided widgets via pubsub) ---

const pageWidgetHost = createPageWidgetHost({
  api,
  webview,
  widgetContainer,
  addWidget,
  updateWidget,
  removeWidget,
});
pageWidgetHost.init();

// Publish page:navigated on in-page navigation
webview.addEventListener('did-navigate', (e) => {
  const title = document.title || '';
  pageWidgetHost.publishNavigated(e.url, title);
});

// Publish page:will-close when window is closing
window.addEventListener('beforeunload', () => {
  pageWidgetHost.destroy();
});

// Expose for testing
if (typeof window !== 'undefined') {
  window.__pageWidgetHost = pageWidgetHost;
}

// --- OpenSearch discovery widget ---

api.subscribe('websearch:engine-discovered', (msg) => {
  if (!msg || !msg.engine) return;

  const { engine } = msg;
  const widgetId = `opensearch-${engine.id}`;

  DEBUG && console.log('[page] OpenSearch engine discovered:', engine.name);

  const contentEl = document.createElement('div');

  const infoRow = document.createElement('div');
  infoRow.className = 'widget-engine-found';

  const iconSpan = document.createElement('span');
  iconSpan.className = 'widget-engine-icon';
  iconSpan.textContent = '\uD83D\uDD0D';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'widget-engine-name';
  nameSpan.textContent = engine.name;

  infoRow.appendChild(iconSpan);
  infoRow.appendChild(nameSpan);
  contentEl.appendChild(infoRow);

  const actionBtn = document.createElement('button');
  actionBtn.className = 'widget-action-btn confirmed';
  actionBtn.textContent = '\u2713 Added to search engines';
  contentEl.appendChild(actionBtn);

  addWidget(widgetId, {
    title: 'Search engine found',
    content: contentEl,
    autoDismiss: 8000,
  });
}, api.scopes.GLOBAL);

// --- Popup-to-opener postMessage bridge: receiver side (Level 3) ---
// When main process routes a postMessage from a popup to this opener window,
// dispatch it as a MessageEvent into the webview guest.
api.ipc.on('opener-message-received', (data) => {
  if (!data || !data.message) return;
  DEBUG && console.log('[page] Received opener message, dispatching to webview:', data);
  const messageJson = JSON.stringify(data.message);
  const origin = data.origin || '*';
  webview.executeJavaScript(`
    window.dispatchEvent(new MessageEvent('message', {
      data: ${messageJson},
      origin: ${JSON.stringify(origin)}
    }));
  `).catch(err => {
    DEBUG && console.log('[page] Failed to dispatch opener message to webview:', err.message);
  });
});

// --- Opener shim injection for popup windows (Level 3 & 4) ---
// If this window was opened as a popup (has openerUrl param), inject a window.opener
// shim into the webview guest that bridges postMessage back to the opener via IPC.
const openerUrl = params.get('openerUrl');

const OPENER_SHIM_JS = openerUrl ? `
(function() {
  if (window.__peekOpenerShimInstalled) return;
  window.__peekOpenerShimInstalled = true;

  var nativeLog = console.log.bind(console);
  var openerUrl = ${JSON.stringify(openerUrl)};

  Object.defineProperty(window, 'opener', {
    configurable: true,
    get: function() {
      return {
        postMessage: function(message, targetOrigin) {
          var payload = JSON.stringify({
            message: message,
            targetOrigin: targetOrigin || '*',
            origin: window.location.origin
          });
          nativeLog('__PEEK_OPENER_POSTMESSAGE__:' + payload);
        },
        closed: false,
        location: {
          href: openerUrl,
          origin: (function() {
            try { return new URL(openerUrl).origin; } catch(e) { return ''; }
          })()
        },
        close: function() {
          nativeLog('__PEEK_OPENER_CLOSE__');
        },
        focus: function() {
          nativeLog('__PEEK_OPENER_FOCUS__');
        }
      };
    }
  });
})();
` : null;

if (OPENER_SHIM_JS) {
  let openerShimTimer = null;
  function injectOpenerShim() {
    webview.executeJavaScript(OPENER_SHIM_JS).catch(() => {});
  }
  webview.addEventListener('dom-ready', injectOpenerShim);
  webview.addEventListener('did-navigate', () => {
    if (openerShimTimer) clearTimeout(openerShimTimer);
    openerShimTimer = setTimeout(() => {
      openerShimTimer = null;
      injectOpenerShim();
    }, 50);
  });
  DEBUG && console.log('[page] Opener shim will be injected (openerUrl:', openerUrl, ')');
}

// --- Page Info Panel: extract metadata from webview ---

let lastPageInfoUrl = null;

async function extractPageInfo() {
  let currentUrl;
  try {
    currentUrl = webview.getURL();
  } catch {
    return;
  }
  if (!currentUrl || currentUrl === lastPageInfoUrl) return;
  if (!currentUrl.startsWith('http://') && !currentUrl.startsWith('https://')) return;

  lastPageInfoUrl = currentUrl;

  try {
    const info = await webview.executeJavaScript(`
      (function() {
        function getMeta(name) {
          var el = document.querySelector('meta[property="' + name + '"], meta[name="' + name + '"]');
          return el ? (el.getAttribute('content') || '').trim() : '';
        }

        return {
          title: document.title || '',
          hostname: window.location.hostname || '',
          url: window.location.href || '',
          description: getMeta('description') || getMeta('og:description') || '',
          keywords: getMeta('keywords') || '',
          ogTitle: getMeta('og:title') || '',
          ogDescription: getMeta('og:description') || '',
          ogImage: getMeta('og:image') || '',
          ogSiteName: getMeta('og:site_name') || '',
          ogType: getMeta('og:type') || '',
          author: getMeta('author') || '',
          generator: getMeta('generator') || '',
          canonical: (function() {
            var link = document.querySelector('link[rel="canonical"]');
            return link ? link.href : '';
          })(),
          favicon: (function() {
            var link = document.querySelector('link[rel="icon"], link[rel="shortcut icon"]');
            return link ? link.href : '';
          })()
        };
      })();
    `);

    renderPageInfo(info);
  } catch (err) {
    console.warn('[page] Failed to extract page info:', err.message);
    if (pageInfoBody) {
      pageInfoBody.innerHTML = '<div class="info-empty">Could not load page info</div>';
    }
  }
}

function renderPageInfo(info) {
  if (!pageInfoBody) return;

  const rows = [];

  if (info.title) {
    rows.push(makeInfoRow('Title', info.title));
  }

  if (info.hostname) {
    rows.push(makeInfoRow('Domain', info.hostname));
  }

  if (info.ogSiteName && info.ogSiteName !== info.hostname) {
    rows.push(makeInfoRow('Site', info.ogSiteName));
  }

  const desc = info.ogDescription || info.description;
  if (desc) {
    rows.push(makeInfoRow('Description', desc, true));
  }

  if (info.keywords) {
    rows.push(makeInfoRow('Keywords', info.keywords, true));
  }

  if (info.author) {
    rows.push(makeInfoRow('Author', info.author));
  }

  if (info.ogType) {
    rows.push(makeInfoRow('Type', info.ogType));
  }

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

  if (info.generator) {
    rows.push(makeInfoRow('Generator', info.generator));
  }

  if (rows.length === 0) {
    pageInfoBody.innerHTML = '<div class="info-empty">No metadata available</div>';
    return;
  }

  pageInfoBody.innerHTML = '';
  for (const row of rows) {
    pageInfoBody.appendChild(row);
  }
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

// Extract page info after page finishes loading
webview.addEventListener('did-finish-load', () => {
  // Small delay to ensure meta tags are populated (some SPAs add them after load)
  setTimeout(extractPageInfo, 500);
});

// Re-extract on in-page navigation
webview.addEventListener('did-navigate', () => {
  lastPageInfoUrl = null; // Reset to allow re-extraction
  setTimeout(extractPageInfo, 500);
});

// --- Entities Panel: show detected entities ---

let currentPageEntities = [];

function renderEntities(entities) {
  if (!entitiesBody) return;

  if (!entities || entities.length === 0) {
    entitiesBody.innerHTML = '<div class="entity-empty">No entities detected</div>';
    return;
  }

  // Group by type
  const groups = {};
  for (const entity of entities) {
    const type = entity.type || entity.entityType || 'other';
    if (!groups[type]) groups[type] = [];
    groups[type].push(entity);
  }

  // Display order for entity types
  const typeOrder = ['person', 'organization', 'place', 'event', 'email', 'phone', 'product', 'creative_work', 'date', 'tracking_number', 'other'];
  const typeLabels = {
    person: 'People',
    organization: 'Organizations',
    place: 'Places',
    event: 'Events',
    email: 'Emails',
    phone: 'Phones',
    product: 'Products',
    creative_work: 'Works',
    date: 'Dates',
    tracking_number: 'Tracking',
    other: 'Other',
  };

  const sortedTypes = Object.keys(groups).sort((a, b) => {
    const ai = typeOrder.indexOf(a);
    const bi = typeOrder.indexOf(b);
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

      const name = document.createTextNode(entity.name || entity.content || '');
      item.appendChild(name);

      groupEl.appendChild(item);
    }

    entitiesBody.appendChild(groupEl);
  }
}

// Listen for entity extraction results (from entities extension)
api.subscribe('entities:extracted', (msg) => {
  if (!msg || !msg.url || !msg.entities) return;
  // Check if this is for the current page
  try {
    const currentUrl = webview.getURL();
    if (msg.url === currentUrl) {
      currentPageEntities = msg.entities;
      renderEntities(currentPageEntities);
      updatePositions();
    }
  } catch {
    // webview not ready
  }
}, api.scopes.GLOBAL);

// Also listen for get-for-url responses
api.subscribe('entities:get-for-url:response', (msg) => {
  if (!msg || !msg.url || !msg.entities) return;
  try {
    const currentUrl = webview.getURL();
    if (msg.url === currentUrl && msg.entities.length > 0) {
      // Convert stored entity format to display format
      currentPageEntities = msg.entities.map(e => {
        let meta = {};
        try { meta = JSON.parse(e.metadata || '{}'); } catch {}
        return {
          name: e.content || e.title,
          type: meta.entityType || 'other',
          confidence: meta.confidence || 0
        };
      });
      renderEntities(currentPageEntities);
      updatePositions();
    }
  } catch {
    // webview not ready
  }
}, api.scopes.GLOBAL);

// Rescan button — triggers re-extraction of entities for current page
if (entitiesRescanBtn) {
  entitiesRescanBtn.addEventListener('click', () => {
    let currentUrl;
    try {
      currentUrl = webview.getURL();
    } catch {
      return;
    }
    if (!currentUrl || !currentUrl.startsWith('http')) return;

    // Show loading state
    currentPageEntities = [];
    if (entitiesBody) {
      entitiesBody.innerHTML = '<div class="entity-loading">Rescanning for entities...</div>';
    }

    // Request re-extraction from entities extension
    api.publish('entities:extract', { url: currentUrl }, api.scopes.GLOBAL);
  });
}

// On navigation, clear entities and request for current URL
webview.addEventListener('did-navigate', (e) => {
  currentPageEntities = [];
  if (entitiesBody) {
    entitiesBody.innerHTML = '<div class="entity-loading">Scanning for entities...</div>';
  }

  // Request entities for this URL from the entities extension
  if (e.url && e.url.startsWith('http')) {
    api.publish('entities:get-for-url', { url: e.url }, api.scopes.GLOBAL);
  }

  // Load notes for the new URL
  if (e.url) {
    pageNotesPane.loadForUrl(e.url);
  }
});

// Also do a simple in-page entity extraction as a fallback
// This catches links, emails, etc. directly from the webview DOM
async function extractSimpleEntities() {
  let currentUrl;
  try {
    currentUrl = webview.getURL();
  } catch {
    return;
  }
  if (!currentUrl || !currentUrl.startsWith('http')) return;

  // Only run if we have no entities yet (the extension hasn't responded)
  if (currentPageEntities.length > 0) return;

  try {
    const extracted = await webview.executeJavaScript(`
      (function() {
        var entities = [];
        var seen = new Set();

        // --- JSON-LD structured data (high quality) ---
        var typeMap = {
          'Person': 'person', 'Organization': 'organization', 'Corporation': 'organization',
          'LocalBusiness': 'organization', 'PerformingGroup': 'organization',
          'MusicGroup': 'organization', 'Event': 'event', 'MusicEvent': 'event',
          'TheaterEvent': 'event', 'Festival': 'event', 'SportsEvent': 'event',
          'Place': 'place', 'PerformingArtsTheater': 'place', 'MusicVenue': 'place',
          'Church': 'place', 'StadiumOrArena': 'place', 'CivicStructure': 'place',
          'Product': 'product', 'SoftwareApplication': 'product',
          'Article': 'creative_work', 'NewsArticle': 'creative_work', 'Book': 'creative_work',
          'Movie': 'creative_work', 'MusicRecording': 'creative_work'
        };
        var skipTypes = new Set(['Offer', 'AggregateOffer', 'ListItem', 'BreadcrumbList',
          'ItemList', 'SearchAction', 'WebPage', 'WebSite', 'ImageObject', 'Rating',
          'AggregateRating', 'PropertyValue', 'MonetaryAmount', 'QuantitativeValue']);
        function extractLdItem(item) {
          if (!item || typeof item !== 'object' || !item['@type']) return;
          var type = Array.isArray(item['@type']) ? item['@type'][0] : item['@type'];
          if (skipTypes.has(type)) return;
          var name = item.name || item.headline || item.title;
          if (name && typeof name === 'string' && name.trim().length >= 4) {
            var entityType = typeMap[type];
            if (entityType && !seen.has(name.trim())) {
              seen.add(name.trim());
              entities.push({ name: name.trim(), type: entityType, confidence: 0.9 });
            }
          }
          // Walk nested objects for sub-entities
          Object.keys(item).forEach(function(key) {
            if (key.startsWith('@')) return;
            var val = item[key];
            if (Array.isArray(val)) { val.forEach(function(v) { extractLdItem(v); }); }
            else if (val && typeof val === 'object') { extractLdItem(val); }
          });
        }
        var ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (var s = 0; s < ldScripts.length; s++) {
          try {
            var data = JSON.parse(ldScripts[s].textContent);
            var items = Array.isArray(data) ? data : [data];
            items.forEach(function(item) {
              if (item['@graph'] && Array.isArray(item['@graph'])) {
                item['@graph'].forEach(extractLdItem);
              } else {
                extractLdItem(item);
              }
            });
          } catch(e) {}
        }

        // --- Extract mailto links ---
        var mailLinks = document.querySelectorAll('a[href^="mailto:"]');
        for (var j = 0; j < mailLinks.length; j++) {
          var email = mailLinks[j].href.replace('mailto:', '').split('?')[0];
          if (email && !seen.has(email)) {
            seen.add(email);
            entities.push({ name: email, type: 'email' });
          }
        }

        // --- Extract tel links ---
        var telLinks = document.querySelectorAll('a[href^="tel:"]');
        for (var k = 0; k < telLinks.length; k++) {
          var phone = telLinks[k].href.replace('tel:', '');
          if (phone && !seen.has(phone)) {
            seen.add(phone);
            entities.push({ name: phone, type: 'phone' });
          }
        }

        return entities.slice(0, 50);
      })();
    `);

    if (extracted && extracted.length > 0 && currentPageEntities.length === 0) {
      currentPageEntities = extracted;
      renderEntities(extracted);
      updatePositions();
    }
  } catch (err) {
    DEBUG && console.log('[page] Simple entity extraction failed:', err.message);
  }
}

// Run simple extraction after page loads (as fallback)
webview.addEventListener('did-finish-load', () => {
  setTimeout(extractSimpleEntities, 2000);
});

// --- Tags Panel: show/manage tags for current page ---

let currentItemId = null;
let currentPageTags = [];
let allTagsCache = []; // For autocomplete suggestions

async function resolveItemId(url) {
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) return null;
  try {
    // queryItems with exact URL search to find the item
    const result = await api.datastore.queryItems({ type: 'url', search: url });
    if (result.success && result.data && result.data.length > 0) {
      // Find exact match by content
      const exact = result.data.find(item => item.content === url);
      if (exact) return exact.id;
      // Fallback: first result
      return result.data[0].id;
    }
  } catch (err) {
    DEBUG && console.log('[page] Failed to resolve itemId for URL:', err.message);
  }
  return null;
}

async function loadTagsForCurrentPage() {
  if (!currentItemId) {
    if (tagsList) tagsList.innerHTML = '';
    return;
  }

  try {
    const result = await api.datastore.getItemTags(currentItemId);
    if (result.success && result.data) {
      currentPageTags = result.data;
    } else {
      currentPageTags = [];
    }
  } catch (err) {
    console.warn('[page] Failed to load tags:', err.message);
    currentPageTags = [];
  }

  renderTags();
}

async function loadAllTags() {
  try {
    const result = await api.datastore.getTagsByFrecency();
    if (result.success && result.data) {
      allTagsCache = result.data;
    }
  } catch (err) {
    DEBUG && console.log('[page] Failed to load all tags:', err.message);
  }
}

function renderTags() {
  if (!tagsList) return;

  tagsList.innerHTML = '';

  if (currentPageTags.length === 0) {
    // Show nothing — the input placeholder is enough
    return;
  }

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
    removeSpan.textContent = '\u00D7';
    btn.appendChild(removeSpan);

    btn.addEventListener('click', () => {
      removeTagFromPage(tag.id, tag.name);
    });

    tagsList.appendChild(btn);
  }
}

async function addTagToPage(tagName) {
  if (!currentItemId || !tagName) return;
  tagName = tagName.trim().toLowerCase();
  if (!tagName) return;

  // Check if already tagged
  if (currentPageTags.some(t => t.name.toLowerCase() === tagName)) {
    return;
  }

  try {
    // Get or create tag
    const tagResult = await api.datastore.getOrCreateTag(tagName);
    if (!tagResult.success || !tagResult.data) {
      console.warn('[page] Failed to create tag:', tagResult.error);
      return;
    }

    const tagId = tagResult.data.tag.id;

    // Tag the item (IPC handler publishes events)
    const result = await api.datastore.tagItem(currentItemId, tagId);
    if (result.success) {
      // Refresh tags list
      await loadTagsForCurrentPage();
      // Refresh autocomplete cache
      loadAllTags();
    }
  } catch (err) {
    console.error('[page] Failed to add tag:', err);
  }
}

async function removeTagFromPage(tagId, tagName) {
  if (!currentItemId || !tagId) return;

  try {
    const result = await api.datastore.untagItem(currentItemId, tagId);
    if (result.success) {
      // Refresh tags list
      await loadTagsForCurrentPage();
    }
  } catch (err) {
    console.error('[page] Failed to remove tag:', err);
  }
}

// --- Tags input with inline suggestion ---

if (tagsInput) {
  tagsInput.addEventListener('input', () => {
    const query = tagsInput.value.trim().toLowerCase();
    if (!query) {
      if (tagsSuggestion) tagsSuggestion.textContent = '';
      return;
    }

    // Find first matching tag not already applied
    const appliedNames = new Set(currentPageTags.map(t => t.name.toLowerCase()));
    const match = allTagsCache.find(t =>
      t.name.toLowerCase().startsWith(query) && !appliedNames.has(t.name.toLowerCase())
    );

    if (match && tagsSuggestion) {
      // Show the typed part + suggestion remainder as ghost text
      tagsSuggestion.textContent = tagsInput.value + match.name.slice(query.length);
    } else if (tagsSuggestion) {
      tagsSuggestion.textContent = '';
    }
  });

  tagsInput.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && tagsSuggestion && tagsSuggestion.textContent) {
      // Accept suggestion
      e.preventDefault();
      tagsInput.value = tagsSuggestion.textContent;
      tagsSuggestion.textContent = '';
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const value = tagsInput.value.trim();
      if (value) {
        addTagToPage(value);
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

// --- React to tag pubsub events ---

api.subscribe('tag:item-added', (msg) => {
  if (msg && msg.itemId === currentItemId) {
    loadTagsForCurrentPage();
  }
  // Refresh autocomplete cache on any tag creation
  loadAllTags();
}, api.scopes.GLOBAL);

api.subscribe('tag:item-removed', (msg) => {
  if (msg && msg.itemId === currentItemId) {
    loadTagsForCurrentPage();
  }
}, api.scopes.GLOBAL);

api.subscribe('tag:created', () => {
  loadAllTags();
}, api.scopes.GLOBAL);

// --- Load tags on navigation ---

// Capture itemId from trackNavigation on did-navigate
webview.addEventListener('did-navigate', async (e) => {
  currentItemId = null;
  currentPageTags = [];
  renderTags();

  if (!e.url || (!e.url.startsWith('http://') && !e.url.startsWith('https://'))) return;

  // Small delay to ensure trackNavigation has created the item
  setTimeout(async () => {
    currentItemId = await resolveItemId(e.url);
    if (currentItemId) {
      await loadTagsForCurrentPage();
    }
    // Update tags panel position after page-info has rendered
    updatePositions();
  }, 600);
});

// Also load tags on initial page load
webview.addEventListener('did-finish-load', async () => {
  if (currentItemId) return; // Already resolved

  let url;
  try {
    url = webview.getURL();
  } catch {
    return;
  }
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) return;

  currentItemId = await resolveItemId(url);
  if (currentItemId) {
    await loadTagsForCurrentPage();
  }
  // Load all tags for autocomplete
  loadAllTags();
  updatePositions();
});

// --- Page Command Handlers (pubsub) ---
// Commands from the cmd palette publish page:cmd:request, we handle them here
// by running executeJavaScript on the webview and publishing the result back.

api.subscribe('page:cmd:request', async (msg) => {
  if (!msg || !msg.requestId || !msg.action) return;

  // Only respond if we are the focused page window
  if (msg.windowId != null && msg.windowId !== myWindowId) return;

  const { requestId, action } = msg;

  const respond = (data, error) => {
    api.publish('page:cmd:response', {
      requestId,
      data: data || null,
      error: error || null
    }, api.scopes.GLOBAL);
  };

  try {
    switch (action) {
      case 'list-images': {
        const images = await webview.executeJavaScript(`
          (function() {
            var results = [];
            var seen = new Set();
            var imgs = document.querySelectorAll('img[src]');
            for (var i = 0; i < imgs.length; i++) {
              var img = imgs[i];
              var src = img.src;
              if (!src || seen.has(src)) continue;
              seen.add(src);
              var alt = (img.alt || '').trim();
              var w = img.naturalWidth || img.width || 0;
              var h = img.naturalHeight || img.height || 0;
              results.push({
                src: src,
                alt: alt,
                width: w,
                height: h,
                title: alt || src.split('/').pop().split('?')[0]
              });
            }
            // Also check CSS background images on visible elements
            var els = document.querySelectorAll('[style*="background-image"]');
            for (var j = 0; j < Math.min(els.length, 50); j++) {
              var style = window.getComputedStyle(els[j]);
              var bg = style.backgroundImage;
              if (bg && bg !== 'none') {
                var match = bg.match(/url\\(["']?([^"')]+)["']?\\)/);
                if (match && match[1] && !seen.has(match[1])) {
                  seen.add(match[1]);
                  results.push({
                    src: match[1],
                    alt: 'Background image',
                    width: 0,
                    height: 0,
                    title: match[1].split('/').pop().split('?')[0]
                  });
                }
              }
            }
            return results;
          })();
        `);
        respond(images);
        break;
      }

      case 'list-feeds': {
        const feeds = await webview.executeJavaScript(`
          (function() {
            var results = [];
            var feedLinks = document.querySelectorAll(
              'link[type="application/rss+xml"], ' +
              'link[type="application/atom+xml"], ' +
              'link[type="application/feed+json"], ' +
              'link[rel="alternate"][type*="xml"]'
            );
            for (var i = 0; i < feedLinks.length; i++) {
              var link = feedLinks[i];
              results.push({
                url: link.href,
                title: link.title || link.type || 'Feed',
                type: link.type || 'unknown'
              });
            }
            // Also look for common feed URL patterns in <a> tags
            var anchors = document.querySelectorAll('a[href]');
            var feedPatterns = ['/feed', '/rss', '/atom', '.rss', '.xml', '/feeds/'];
            var seen = new Set(results.map(function(r) { return r.url; }));
            for (var j = 0; j < anchors.length; j++) {
              var href = anchors[j].href;
              if (!href || seen.has(href)) continue;
              var lower = href.toLowerCase();
              for (var k = 0; k < feedPatterns.length; k++) {
                if (lower.includes(feedPatterns[k])) {
                  seen.add(href);
                  results.push({
                    url: href,
                    title: anchors[j].textContent.trim().slice(0, 60) || 'Feed link',
                    type: 'link'
                  });
                  break;
                }
              }
            }
            return results;
          })();
        `);
        respond(feeds);
        break;
      }

      case 'list-links': {
        const links = await webview.executeJavaScript(`
          (function() {
            var results = [];
            var seen = new Set();
            var anchors = document.querySelectorAll('a[href]');
            var pageHost = window.location.hostname;
            for (var i = 0; i < anchors.length; i++) {
              var a = anchors[i];
              var href = a.href;
              if (!href || !href.startsWith('http') || seen.has(href)) continue;
              seen.add(href);
              var text = (a.textContent || '').trim().slice(0, 100);
              if (!text || text.length < 2) continue;
              var isExternal = false;
              try { isExternal = new URL(href).hostname !== pageHost; } catch(e) {}
              results.push({
                url: href,
                text: text,
                title: text,
                external: isExternal
              });
            }
            return results;
          })();
        `);
        respond(links);
        break;
      }

      case 'list-entities': {
        // Return cached entities if available, otherwise do live extraction
        if (currentPageEntities && currentPageEntities.length > 0) {
          respond(currentPageEntities);
        } else {
          // Do a quick extraction from the live page DOM
          const entities = await webview.executeJavaScript(`
            (function() {
              var entities = [];
              var seen = new Set();

              // --- JSON-LD structured data (high quality) ---
              var typeMap = {
                'Person': 'person', 'Organization': 'organization', 'Corporation': 'organization',
                'LocalBusiness': 'organization', 'PerformingGroup': 'organization',
                'MusicGroup': 'organization', 'Event': 'event', 'MusicEvent': 'event',
                'TheaterEvent': 'event', 'Festival': 'event', 'SportsEvent': 'event',
                'Place': 'place', 'PerformingArtsTheater': 'place', 'MusicVenue': 'place',
                'Church': 'place', 'StadiumOrArena': 'place', 'CivicStructure': 'place',
                'Product': 'product', 'SoftwareApplication': 'product',
                'Article': 'creative_work', 'NewsArticle': 'creative_work', 'Book': 'creative_work',
                'Movie': 'creative_work', 'MusicRecording': 'creative_work'
              };
              var skipTypes = new Set(['Offer', 'AggregateOffer', 'ListItem', 'BreadcrumbList',
                'ItemList', 'SearchAction', 'WebPage', 'WebSite', 'ImageObject', 'Rating',
                'AggregateRating', 'PropertyValue', 'MonetaryAmount', 'QuantitativeValue']);
              function extractLdItem(item) {
                if (!item || typeof item !== 'object' || !item['@type']) return;
                var type = Array.isArray(item['@type']) ? item['@type'][0] : item['@type'];
                if (skipTypes.has(type)) return;
                var name = item.name || item.headline || item.title;
                if (name && typeof name === 'string' && name.trim().length >= 4) {
                  var entityType = typeMap[type];
                  if (entityType && !seen.has(name.trim())) {
                    seen.add(name.trim());
                    entities.push({ name: name.trim(), type: entityType, confidence: 0.9 });
                  }
                }
                // Walk nested objects for sub-entities (location, performer, organizer, etc.)
                Object.keys(item).forEach(function(key) {
                  if (key.startsWith('@')) return;
                  var val = item[key];
                  if (Array.isArray(val)) { val.forEach(function(v) { extractLdItem(v); }); }
                  else if (val && typeof val === 'object') { extractLdItem(val); }
                });
              }
              var ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
              for (var s = 0; s < ldScripts.length; s++) {
                try {
                  var data = JSON.parse(ldScripts[s].textContent);
                  var items = Array.isArray(data) ? data : [data];
                  items.forEach(function(item) {
                    if (item['@graph'] && Array.isArray(item['@graph'])) {
                      item['@graph'].forEach(extractLdItem);
                    } else {
                      extractLdItem(item);
                    }
                  });
                } catch(e) {}
              }

              // --- Emails from mailto links ---
              var mailLinks = document.querySelectorAll('a[href^="mailto:"]');
              for (var i = 0; i < mailLinks.length; i++) {
                var email = mailLinks[i].href.replace('mailto:', '').split('?')[0];
                if (email && !seen.has(email)) {
                  seen.add(email);
                  entities.push({ name: email, type: 'email' });
                }
              }

              // --- Emails from text content (regex) ---
              var textContent = document.body ? document.body.innerText : '';
              var emailRegex = /[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}/g;
              var emailMatches = textContent.match(emailRegex) || [];
              for (var j = 0; j < emailMatches.length; j++) {
                if (!seen.has(emailMatches[j])) {
                  seen.add(emailMatches[j]);
                  entities.push({ name: emailMatches[j], type: 'email' });
                }
              }

              // --- Phone numbers from tel links ---
              var telLinks = document.querySelectorAll('a[href^="tel:"]');
              for (var k = 0; k < telLinks.length; k++) {
                var phone = telLinks[k].href.replace('tel:', '');
                if (phone && !seen.has(phone)) {
                  seen.add(phone);
                  entities.push({ name: phone, type: 'phone' });
                }
              }

              // --- External domains as organizations ---
              var links = document.querySelectorAll('a[href]');
              var domainCounts = {};
              for (var l = 0; l < Math.min(links.length, 500); l++) {
                try {
                  var host = new URL(links[l].href).hostname;
                  if (host === window.location.hostname) continue;
                  if (!domainCounts[host]) domainCounts[host] = 0;
                  domainCounts[host]++;
                } catch(e) {}
              }
              // Only include domains referenced multiple times (likely organizations)
              Object.keys(domainCounts).forEach(function(domain) {
                if (domainCounts[domain] >= 2 && !seen.has(domain)) {
                  seen.add(domain);
                  entities.push({ name: domain, type: 'organization' });
                }
              });

              return entities.slice(0, 100);
            })();
          `);
          respond(entities);
        }
        break;
      }

      case 'view-reader': {
        // Toggle reader mode by injecting/removing a simplified view
        const result = await webview.executeJavaScript(`
          (function() {
            // Check if already in reader mode
            if (document.getElementById('__peek_reader_mode')) {
              // Exit reader mode: restore original content
              var overlay = document.getElementById('__peek_reader_mode');
              overlay.remove();
              document.body.style.overflow = '';
              return { active: false, message: 'Reader mode off' };
            }

            // Enter reader mode: extract readable content
            var title = document.title || '';
            var article = document.querySelector('article') ||
                          document.querySelector('[role="main"]') ||
                          document.querySelector('main') ||
                          document.querySelector('.post-content') ||
                          document.querySelector('.article-content') ||
                          document.querySelector('.entry-content');

            var content = '';
            if (article) {
              content = article.innerHTML;
            } else {
              // Fallback: use body but strip nav, header, footer, aside, script, style
              var clone = document.body.cloneNode(true);
              var remove = clone.querySelectorAll('nav, header, footer, aside, script, style, .nav, .header, .footer, .sidebar, .menu, .ad, .advertisement, [role="navigation"], [role="banner"], [role="complementary"]');
              for (var i = 0; i < remove.length; i++) {
                remove[i].remove();
              }
              content = clone.innerHTML;
            }

            var overlay = document.createElement('div');
            overlay.id = '__peek_reader_mode';
            overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:999999;background:#fff;color:#222;overflow-y:auto;padding:40px;font-family:Georgia,serif;font-size:18px;line-height:1.6;';
            overlay.innerHTML =
              '<div style="max-width:700px;margin:0 auto;">' +
                '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;padding-bottom:10px;border-bottom:1px solid #ddd;">' +
                  '<span style="color:#888;font-size:14px;font-family:system-ui,sans-serif;">Reader Mode</span>' +
                  '<button id="__peek_reader_close" style="background:none;border:1px solid #ccc;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:13px;font-family:system-ui,sans-serif;">Exit</button>' +
                '</div>' +
                '<h1 style="font-size:28px;line-height:1.3;margin-bottom:20px;">' + title.replace(/</g, '&lt;') + '</h1>' +
                content +
              '</div>';

            document.body.appendChild(overlay);
            document.body.style.overflow = 'hidden';

            // Wire up close button
            document.getElementById('__peek_reader_close').addEventListener('click', function() {
              overlay.remove();
              document.body.style.overflow = '';
            });

            return { active: true, message: 'Reader mode on' };
          })();
        `);
        respond(result);
        break;
      }

      case 'view-source': {
        const source = await webview.executeJavaScript(`
          (function() {
            return {
              html: document.documentElement.outerHTML,
              title: document.title || window.location.href
            };
          })();
        `);
        respond(source);
        break;
      }

      default:
        respond(null, 'Unknown page command action: ' + action);
    }
  } catch (err) {
    console.error('[page] page:cmd:request error:', err);
    respond(null, err.message || 'Failed to execute page command');
  }
}, api.scopes.GLOBAL);

// --- Extensions Panel: show loaded chrome extensions and adblocker ---

let extensionsLoaded = false;
let currentSiteHostname = null;
let currentSiteAdblockAllowed = false; // true = ads allowed (blocking disabled for this site)
let adblockerGlobalEnabled = false;

function getHostnameFromWebview() {
  try {
    const url = webview.getURL();
    if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
      return new URL(url).hostname;
    }
  } catch {
    // webview not ready
  }
  return null;
}

async function loadExtensionsPanel() {
  if (!extensionsBody) return;

  try {
    // Fetch chrome extensions and adblocker status in parallel
    const [extResult, uiResult, adStatus] = await Promise.all([
      api.chromeExtensions.list(),
      api.chromeExtensions.getUiEntries(),
      api.adblocker.getStatus(),
    ]);

    const extensions = (extResult.success && extResult.data) ? extResult.data : [];
    const uiEntries = (uiResult.success && uiResult.data) ? uiResult.data : [];
    adblockerGlobalEnabled = adStatus.success && adStatus.data?.enabled;

    // Get per-site adblocker state
    const hostname = getHostnameFromWebview();
    currentSiteHostname = hostname;
    if (hostname && adblockerGlobalEnabled) {
      const siteResult = await api.adblocker.isSiteAllowed(hostname);
      currentSiteAdblockAllowed = siteResult.success && siteResult.data;
    } else {
      currentSiteAdblockAllowed = false;
    }

    // Build UI entry lookup for quick popup access
    const popupMap = new Map(); // extensionId -> popup entry
    for (const entry of uiEntries) {
      if (entry.type === 'popup') {
        popupMap.set(entry.extensionId, entry);
      }
    }

    // Filter to only enabled extensions (loaded state is a race condition at startup)
    const enabledExts = extensions.filter(ext => ext.enabled);

    extensionsBody.innerHTML = '';

    // Adblocker entry (always shown first)
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

        const icon = document.createElement('span');
        icon.className = 'ext-icon';
        icon.textContent = '\uD83E\uDDE9'; // puzzle piece emoji
        item.appendChild(icon);

        const info = document.createElement('div');
        info.className = 'ext-info';

        const name = document.createElement('div');
        name.className = 'ext-name';
        name.textContent = ext.name;
        name.title = ext.description || ext.name;
        info.appendChild(name);

        item.appendChild(info);

        // Popup button (if extension has a popup)
        const popupEntry = popupMap.get(ext.id);
        if (popupEntry) {
          const actions = document.createElement('div');
          actions.className = 'ext-actions';

          const popupBtn = document.createElement('button');
          popupBtn.className = 'ext-action-btn';
          popupBtn.textContent = 'Open';
          popupBtn.title = `Open ${ext.name} popup`;
          popupBtn.addEventListener('click', () => {
            api.chromeExtensions.openPage(ext.id, 'popup');
          });
          actions.appendChild(popupBtn);
          item.appendChild(actions);
        }

        extensionsBody.appendChild(item);
      }
    }

    extensionsLoaded = true;
    // Update positions after rendering (panel height may have changed)
    updatePositions();
  } catch (err) {
    console.warn('[page] Failed to load extensions panel:', err.message);
    if (extensionsBody) {
      extensionsBody.innerHTML = '<div class="ext-empty">Could not load extensions</div>';
    }
  }
}

function renderAdblockerEntry() {
  if (!extensionsBody) return;

  const item = document.createElement('div');
  item.className = 'ext-item';
  item.id = 'ext-adblocker-item';

  const icon = document.createElement('span');
  icon.className = 'ext-icon';
  icon.textContent = '\uD83D\uDEE1\uFE0F'; // shield emoji
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
    if (!adblockerGlobalEnabled) {
      status.textContent = 'Disabled globally';
    } else if (currentSiteAdblockAllowed) {
      status.textContent = `Ads allowed on ${currentSiteHostname}`;
    } else {
      status.textContent = `Blocking ads on ${currentSiteHostname}`;
    }
    info.appendChild(status);
  }

  item.appendChild(info);

  // Toggle switch for per-site blocking
  if (adblockerGlobalEnabled && currentSiteHostname) {
    const toggle = document.createElement('label');
    toggle.className = 'ext-toggle';
    toggle.title = currentSiteAdblockAllowed
      ? `Enable ad blocking on ${currentSiteHostname}`
      : `Disable ad blocking on ${currentSiteHostname}`;

    const input = document.createElement('input');
    input.type = 'checkbox';
    // Checked = blocking is active (not allowed)
    input.checked = !currentSiteAdblockAllowed;
    input.addEventListener('change', async () => {
      const shouldBlock = input.checked;
      if (shouldBlock) {
        // Remove from allowlist
        await api.adblocker.disallowSite(currentSiteHostname);
        currentSiteAdblockAllowed = false;
      } else {
        // Add to allowlist
        await api.adblocker.allowSite(currentSiteHostname);
        currentSiteAdblockAllowed = true;
      }
      // Refresh the adblocker entry to update status text and toggle title
      const existing = document.getElementById('ext-adblocker-item');
      if (existing) {
        const nextSibling = existing.nextSibling;
        existing.remove();
        renderAdblockerEntry();
        // The new entry was appended; move it back to the original position
        const newItem = document.getElementById('ext-adblocker-item');
        if (newItem && nextSibling) {
          extensionsBody.insertBefore(newItem, nextSibling);
        }
      }
    });

    const track = document.createElement('span');
    track.className = 'ext-toggle-track';

    toggle.appendChild(input);
    toggle.appendChild(track);
    item.appendChild(toggle);
  }

  // Insert at the beginning of the body
  if (extensionsBody.firstChild) {
    extensionsBody.insertBefore(item, extensionsBody.firstChild);
  } else {
    extensionsBody.appendChild(item);
  }
}

// Load extensions panel on initial page load
webview.addEventListener('did-finish-load', () => {
  setTimeout(loadExtensionsPanel, 700);
});

// Reload on navigation (hostname may change)
webview.addEventListener('did-navigate', () => {
  extensionsLoaded = false;
  setTimeout(loadExtensionsPanel, 700);
});

// --- Notes Panel: load notes for current page URL ---
// Initial load on did-finish-load (fallback in case did-navigate was missed)
webview.addEventListener('did-finish-load', () => {
  try {
    const url = webview.getURL();
    if (url) pageNotesPane.loadForUrl(url);
  } catch {
    // webview not ready
  }
});

DEBUG && console.log('[page] Minimal page host initialized for:', targetUrl);
