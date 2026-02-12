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

const DEBUG = true;

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
const btnBack = document.getElementById('btn-back');
const btnForward = document.getElementById('btn-forward');
const btnReload = document.getElementById('btn-reload');
const urlText = document.getElementById('url-text');
const modeIndicator = document.getElementById('mode-indicator');
const widgetContainer = document.getElementById('widget-container');

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
  urlText.value = targetUrl;
}

initWebview();

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

// Hold-to-drag state
const DRAG_HOLD_THRESHOLD = 150;
const WEBVIEW_DRAG_HOLD_THRESHOLD = 300;
let holdDragTimer = null;
let holdDragPending = false;
let holdDragStartScreenX = 0;
let holdDragStartScreenY = 0;

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
  dragOverlay.classList.remove('active');
}

// Instant drag on navbar background (excluding buttons and URL text)
navbar.addEventListener('mousedown', (e) => {
  if (e.target.closest('.nav-btn') || e.target.closest('.url-text')) return;
  pageMouseButtonDown = true;
  startDrag(e.screenX, e.screenY);
  navbar.style.cursor = 'grabbing';
  e.preventDefault();
});

// Hold-to-drag from anywhere on the document
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
      startDrag(holdDragStartScreenX, holdDragStartScreenY);
      holdDragPending = false;
    }
  }, DRAG_HOLD_THRESHOLD);
});

document.addEventListener('mouseup', () => {
  pageMouseButtonDown = false;
  cancelHoldDrag();
});

// --- Webview hold-to-drag via injected long-press detector + overlay ---

const WEBVIEW_LONG_PRESS_JS = `
(function() {
  if (window.__peekLongPressInstalled) return;
  window.__peekLongPressInstalled = true;

  let timer = null;
  let startX = 0;
  let startY = 0;

  function cancel() {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  document.addEventListener('mousedown', function(e) {
    if (e.button !== 0) return;
    startX = e.screenX;
    startY = e.screenY;
    cancel();
    timer = setTimeout(function() {
      console.log('__PEEK_DRAG__:' + e.screenX + ':' + e.screenY);
      timer = null;
    }, ${WEBVIEW_DRAG_HOLD_THRESHOLD});
  }, true);

  document.addEventListener('mousemove', function(e) {
    if (!timer) return;
    if (Math.abs(e.screenX - startX) > 5 || Math.abs(e.screenY - startY) > 5) {
      cancel();
    }
  }, true);

  document.addEventListener('mouseup', function() { cancel(); }, true);
  document.addEventListener('scroll', function() { cancel(); }, true);
  document.addEventListener('contextmenu', function() { cancel(); }, true);
})();
`;

webview.addEventListener('console-message', (e) => {
  if (typeof e.message !== 'string' || !e.message.startsWith('__PEEK_DRAG__:')) return;
  const parts = e.message.split(':');
  const screenX = parseFloat(parts[1]);
  const screenY = parseFloat(parts[2]);
  if (isNaN(screenX) || isNaN(screenY)) return;

  dragOverlay.classList.add('active');
  pageMouseButtonDown = true;  // Webview mousedown doesn't bubble to document, set manually
  startDrag(screenX, screenY);
  DEBUG && console.log('[page] Webview long-press drag started at', screenX, screenY);
});

webview.addEventListener('dom-ready', () => {
  webview.executeJavaScript(WEBVIEW_LONG_PRESS_JS).catch(err => {
    DEBUG && console.log('[page] Failed to inject long-press detector:', err.message);
  });
});

dragOverlay.addEventListener('mouseup', () => {
  dragOverlay.classList.remove('active');
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
  btnBack.disabled = !webview.canGoBack();
  btnForward.disabled = !webview.canGoForward();
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
    requestAnimationFrame(() => {
      urlText.focus();
      urlText.select();
    });
  }
}

function hide() {
  if (isDragging || holdDragPending) return;
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  navbar.classList.remove('visible');
  // Window stays the same size (always includes navbar space).
  // Just update trigger zone and resize handle visibility.
  updatePositions();
  urlText.blur();
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
api.subscribe('page:show-navbar', () => show({ focusUrl: true, source: 'shortcut' }), api.scopes.GLOBAL);

// Cmd+R: reload the webview
api.subscribe('page:reload', () => {
  DEBUG && console.log('[page] Cmd+R: reloading webview');
  webview.reload();
}, api.scopes.GLOBAL);

// Cmd+[ / Cmd+Left: go back
api.subscribe('page:go-back', () => {
  if (webview.canGoBack()) {
    DEBUG && console.log('[page] Cmd+[: going back');
    webview.goBack();
    updateState();
  }
}, api.scopes.GLOBAL);

// Cmd+] / Cmd+Right: go forward
api.subscribe('page:go-forward', () => {
  if (webview.canGoForward()) {
    DEBUG && console.log('[page] Cmd+]: going forward');
    webview.goForward();
    updateState();
  }
}, api.scopes.GLOBAL);

// --- Nav button actions ---

btnBack.addEventListener('click', (e) => {
  e.stopPropagation();
  if (webview.canGoBack()) {
    webview.goBack();
    updateState();
  }
});

btnForward.addEventListener('click', (e) => {
  e.stopPropagation();
  if (webview.canGoForward()) {
    webview.goForward();
    updateState();
  }
});

btnReload.addEventListener('click', (e) => {
  e.stopPropagation();
  webview.reload();
});

// --- URL field: navigate on Enter ---

function normalizeUrl(input) {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.includes('.') && !trimmed.includes(' ')) return 'https://' + trimmed;
  return 'https://' + trimmed;
}

urlText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const url = normalizeUrl(urlText.value);
    if (url) {
      DEBUG && console.log('[page] Navigating to:', url);
      webview.loadURL(url);
      urlText.value = url;
      urlText.blur();
      hide();
    }
  }
  if (e.key === 'Escape') {
    urlText.value = webview.getURL() || targetUrl;
    urlText.blur();
    hide();
    e.stopPropagation();
  }
});

urlText.addEventListener('mousedown', (e) => {
  e.stopPropagation();
});

urlText.addEventListener('focus', () => {
  requestAnimationFrame(() => urlText.select());
});

// --- Escape handling ---

api.escape.onEscape(() => {
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
  urlText.value = e.url;
  updateState();

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
    urlText.value = e.url;
    updateState();
  }
});

webview.addEventListener('did-fail-load', (e) => {
  if (e.errorCode === -3) return;
  console.error('[page] Load failed:', e.errorCode, e.errorDescription);
});

// Set default background color on webview content if the page doesn't set one
webview.addEventListener('dom-ready', async () => {
  try {
    const detectionJs = `
      (function() {
        function isTransparentColor(color) {
          if (!color) return true;
          if (color === 'transparent') return true;
          if (color === 'rgba(0, 0, 0, 0)') return true;
          const rgbaMatch = color.match(/rgba\\s*\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*([\\d.]+)\\s*\\)/);
          if (rgbaMatch && parseFloat(rgbaMatch[1]) === 0) return true;
          return false;
        }

        function hasBackground(el) {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const bgColor = style.backgroundColor;
          const hasColor = !isTransparentColor(bgColor);
          const bgImage = style.backgroundImage;
          const hasImage = bgImage && bgImage !== 'none';
          return hasColor || hasImage;
        }

        const html = document.documentElement;
        const body = document.body;
        return !(hasBackground(html) || hasBackground(body));
      })();
    `;

    const needsBackground = await webview.executeJavaScript(detectionJs);

    if (needsBackground) {
      const defaultBg = '#ffffff';
      await webview.executeJavaScript(`
        document.documentElement.style.backgroundColor = '${defaultBg}';
      `);
      DEBUG && console.log('[page] No background detected, set default:', defaultBg);
    } else {
      DEBUG && console.log('[page] Page has background, skipping default');
    }
  } catch (err) {
    console.error('[page] Failed to check/set background:', err);
  }
});

// --- OpenSearch discovery & page:loaded event ---

webview.addEventListener('did-finish-load', async () => {
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

DEBUG && console.log('[page] Minimal page host initialized for:', targetUrl);
