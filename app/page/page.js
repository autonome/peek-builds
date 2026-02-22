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
 * - Custom drag: instant on navbar background, hold-150ms-to-drag anywhere else
 * - Custom resize: pointer-captured resize handle (robust even if cursor leaves window)
 * - Hover trigger zone above webview reveals/hides navbar
 * - Cmd+L shows navbar with URL focus
 * - Navbar show/hide is CSS-only (window always includes navbar space)
 */

import api from '../api.js';

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
// Computes the BrowserWindow bounds from the webview screen position

function computeWindowBounds(sb) {
  // Window always includes space for navbar + trigger zone + margins.
  // Navbar visibility is CSS-only — window size stays constant.
  const winX = sb.x - MARGIN;
  const winY = sb.y - TRIGGER_ZONE_HEIGHT - (NAVBAR_HEIGHT + NAVBAR_GAP);
  const winW = sb.width + MARGIN * 2;
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
  // All positions are relative to the window origin (0, 0)
  // The window layout from top to bottom (fixed — never changes):
  //   [navbar area] (NAVBAR_HEIGHT + NAVBAR_GAP) — navbar shown/hidden via CSS
  //   [trigger zone] (TRIGGER_ZONE_HEIGHT)
  //   [webview] (screenBounds.height)
  //   [bottom margin] (MARGIN)
  // Left/right margins: MARGIN on each side

  const navVisible = navbar.classList.contains('visible');
  const navOffset = NAVBAR_HEIGHT + NAVBAR_GAP;

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


// Initial positioning
updatePositions();

// --- Set up webview partition and load URL ---

async function initWebview() {
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

  webview.src = targetUrl;
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

// Visual effect module — applies/removes CSS classes based on lifecycle state
// Also shows/hides navbar with loading spinner during page load.
loadingLifecycle.onChange((state) => {
  if (state === 'loading') {
    webview.classList.add('loading');
    webview.classList.remove('loaded');
    navbar.loading = true;
    show({ source: 'loading' });
  } else if (state === 'loaded') {
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
  loadingLifecycle.stopLoading();
});

// --- Custom drag ---
// Two modes:
//   1. Navbar background: instant drag (no hold delay)
//   2. Anywhere else: hold ~150ms then drag
// Drag now moves the BrowserWindow itself via setBounds() IPC.

let isDragging = false;
let dragStartScreenX = 0;
let dragStartScreenY = 0;
let dragStartBoundsX = 0;
let dragStartBoundsY = 0;
let pageMouseButtonDown = false;

// Hold-to-drag state (configurable, read from prefs at init)
const JITTER_TOLERANCE = 3; // px of movement allowed during hold without cancelling
let DRAG_HOLD_THRESHOLD = 2000; // ms, updated from prefs
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
  webview.executeJavaScript(WEBVIEW_MOUSE_BRIDGE_JS).catch(() => {});
}

// Inject on dom-ready (fires on each full navigation)
webview.addEventListener('dom-ready', injectMouseBridge);

// Also inject on did-navigate for robustness (some navigations may not fire dom-ready).
// Cancel any pending injection from a previous navigation to avoid listener buildup.
webview.addEventListener('did-navigate', () => {
  if (mouseBridgeTimer) clearTimeout(mouseBridgeTimer);
  mouseBridgeTimer = setTimeout(() => {
    mouseBridgeTimer = null;
    injectMouseBridge();
  }, 50);
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
  navbar.canGoBack = webview.canGoBack();
  navbar.canGoForward = webview.canGoForward();
}

// --- Show / Hide navbar ---
// When the navbar becomes visible, the window must expand upward to accommodate it.
// When it hides, the window contracts back down.

let hideTimer = null;
let showSource = null; // 'hover' or 'shortcut'

function show(opts) {
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
}

function hide() {
  if (isDragging || holdDragPending) return;
  // Don't hide while page is loading — navbar stays visible with spinner
  if (loadingLifecycle.state === 'loading') return;
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  navbar.classList.remove('visible');
  // Window stays the same size (always includes navbar space).
  // Just update trigger zone and resize handle visibility.
  updatePositions();
  navbar.inputElement?.blur();
  showSource = null;
  DEBUG && console.log('[page] Navbar hidden');
}

// Dismiss on click outside the navbar
document.addEventListener('mousedown', (e) => {
  if (navbar.classList.contains('visible') && !navbar.contains(e.target) && e.target !== triggerZone && !e.target.closest('.resize-handle')) {
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
    if (showSource !== 'hover') return;
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
  // Suppress navbar auto-show during OAuth flows (Level 2) to avoid
  // interrupting credential entry. User can still Cmd+L to force show.
  if (isOnOAuthPage) {
    DEBUG && console.log('[page] Suppressing navbar hover during OAuth flow');
    return;
  }
  show({ source: 'hover' });
});

triggerZone.addEventListener('mouseleave', () => {
  if (showSource === 'hover') scheduleHide();
});

navbar.addEventListener('mouseenter', () => {
  cancelHide();
});

navbar.addEventListener('mouseleave', () => {
  if (showSource === 'hover') scheduleHide();
});

// Cmd+L: show navbar with URL focus
api.subscribe('page:show-navbar', (msg) => {
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

  header.appendChild(titleEl);
  header.appendChild(closeBtn);
  el.appendChild(header);

  const body = document.createElement('div');
  body.className = 'widget-body';
  if (typeof content === 'string') {
    body.innerHTML = content;
  } else if (content instanceof HTMLElement) {
    body.appendChild(content);
  }
  el.appendChild(body);

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

DEBUG && console.log('[page] Minimal page host initialized for:', targetUrl);
