/**
 * peek://page - Fullscreen transparent canvas container for web content
 *
 * Architecture: A fullscreen transparent BrowserWindow covers the entire display.
 * All UI elements (webview, navbar, trigger zone, resize handle, mode indicator)
 * are position:absolute siblings, positioned by JS via updatePositions() using
 * a `bounds` object. The navbar sits ABOVE the webview with an 8px gap.
 *
 * - Custom drag: instant on navbar background, hold-150ms-to-drag anywhere else
 * - Custom resize: pointer-captured resize handle (robust even if cursor leaves window)
 * - Hover trigger zone above navbar reveals/hides navbar
 * - Cmd+L shows navbar with URL focus
 */

import api from '../api.js';

const DEBUG = true;

// --- Constants ---
const NAVBAR_HEIGHT = 36;
const NAVBAR_GAP = 8;
const MIN_WIDTH = 200;
const MIN_HEIGHT = 150;

// --- Parse URL parameters ---
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

// --- Bounds state ---
// All positioning is derived from this single object
let bounds = {
  x: initialX,
  y: initialY,
  width: initialWidth,
  height: initialHeight,
};

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

// --- Position all elements based on bounds ---

function updateUrlParams() {
  // Keep the URL search params in sync with current bounds so that
  // session save (extractCanvasBounds) reads the latest position/size.
  // Uses replaceState to avoid reloading the page or adding history entries.
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('x', String(bounds.x));
    url.searchParams.set('y', String(bounds.y));
    url.searchParams.set('width', String(bounds.width));
    url.searchParams.set('height', String(bounds.height));
    history.replaceState(null, '', url.toString());
  } catch (e) {
    // Non-critical — session restore will fall back to initial position
    DEBUG && console.log('[page] Failed to update URL params:', e);
  }
}

function updatePositions() {
  const { x, y, width, height } = bounds;

  // Webview — the main content area
  webview.style.left = `${x}px`;
  webview.style.top = `${y}px`;
  webview.style.width = `${width}px`;
  webview.style.height = `${height}px`;

  // Drag overlay — covers webview area exactly (for hold-to-drag from webview)
  dragOverlay.style.left = `${x}px`;
  dragOverlay.style.top = `${y}px`;
  dragOverlay.style.width = `${width}px`;
  dragOverlay.style.height = `${height}px`;

  // Navbar — above the webview with a gap
  const navbarTop = Math.max(0, y - NAVBAR_GAP - NAVBAR_HEIGHT);
  navbar.style.left = `${x}px`;
  navbar.style.top = `${navbarTop}px`;
  navbar.style.width = `${width}px`;

  // Trigger zone — covers the area above the webview where hover reveals the navbar
  const triggerTop = Math.max(0, navbarTop - 14);
  triggerZone.style.left = `${x}px`;
  triggerZone.style.top = `${triggerTop}px`;
  triggerZone.style.width = `${width}px`;

  // Resize handles — all four corners of the webview (24x24)
  resizeHandles.se.style.left = `${x + width - 24}px`;
  resizeHandles.se.style.top = `${y + height - 24}px`;

  resizeHandles.sw.style.left = `${x}px`;
  resizeHandles.sw.style.top = `${y + height - 24}px`;

  resizeHandles.ne.style.left = `${x + width - 24}px`;
  resizeHandles.ne.style.top = `${y}px`;

  resizeHandles.nw.style.left = `${x}px`;
  resizeHandles.nw.style.top = `${y}px`;

  // Navbar corner resize handles — only visible when navbar is shown
  const navVisible = navbar.classList.contains('visible');
  resizeHandles.navNe.style.display = navVisible ? '' : 'none';
  resizeHandles.navNw.style.display = navVisible ? '' : 'none';
  resizeHandles.navNe.style.left = `${x + width - 24}px`;
  resizeHandles.navNe.style.top = `${navbarTop}px`;
  resizeHandles.navNw.style.left = `${x}px`;
  resizeHandles.navNw.style.top = `${navbarTop}px`;

  // Mode indicator — top-right corner of the webview
  if (modeIndicator) {
    modeIndicator.style.left = `${x + width - 120}px`;
    modeIndicator.style.top = `${y + 8}px`;
  }

  // Widget container — right side of the webview with a gap
  if (widgetContainer) {
    const widgetGap = 12;
    widgetContainer.style.left = `${x + width + widgetGap}px`;
    widgetContainer.style.top = `${y}px`;
  }
}

// Initial positioning
updatePositions();

// --- Set up webview partition and load URL ---

async function initWebview() {
  try {
    // Get the partition string for the current profile
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

  // Load the target URL
  webview.src = targetUrl;
  urlText.value = targetUrl;
}

// Start initialization
initWebview();

// --- Custom drag ---
// Two modes:
//   1. Navbar background: instant drag (no hold delay) — primary purpose of navbar
//   2. Anywhere else (webview, buttons, url text, empty space): hold ~150ms then drag
// A quick click (<150ms) on non-navbar areas passes through to the underlying element.

let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let dragStartBoundsX = 0;
let dragStartBoundsY = 0;
let pageMouseButtonDown = false; // track button state ourselves for reliability

// Hold-to-drag state
const DRAG_HOLD_THRESHOLD = 150; // ms before hold-drag activates (transparent canvas)
const WEBVIEW_DRAG_HOLD_THRESHOLD = 300; // ms for webview content (longer to avoid interfering with clicks)
let holdDragTimer = null;
let holdDragPending = false;
let holdDragStartScreenX = 0;
let holdDragStartScreenY = 0;

function startDrag(screenX, screenY) {
  isDragging = true;
  dragStartX = screenX;
  dragStartY = screenY;
  dragStartBoundsX = bounds.x;
  dragStartBoundsY = bounds.y;
  document.body.style.cursor = 'grabbing';
}

function cancelHoldDrag() {
  if (holdDragTimer) {
    clearTimeout(holdDragTimer);
    holdDragTimer = null;
  }
  holdDragPending = false;
  // Deactivate the drag overlay if it was activated
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

// Hold-to-drag from anywhere on the document (transparent canvas areas)
document.addEventListener('mousedown', (e) => {
  // Skip if resize handle was clicked
  if (e.target.closest('.resize-handle')) return;
  // Skip if already dragging (navbar instant drag handled above)
  if (isDragging) return;
  // Only primary button
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

// Cancel hold-drag on mouseup before threshold
document.addEventListener('mouseup', () => {
  pageMouseButtonDown = false;
  cancelHoldDrag();
});

// --- Webview hold-to-drag via injected long-press detector + overlay ---
// The webview is a separate Electron process; mouse events inside it don't propagate
// to the host document. We solve this by:
// 1. Injecting a long-press detector into the guest page via executeJavaScript on dom-ready
// 2. The guest script sends a message via console.log('__PEEK_DRAG__:screenX:screenY')
// 3. The host listens for console-message events on the <webview> element
// 4. On receiving the signal, the host activates the drag overlay and starts dragging
// The overlay (pointer-events:all when active) captures all subsequent mouse events.

const WEBVIEW_LONG_PRESS_JS = `
(function() {
  // Guard against re-injection
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
      // Signal the host via console.log (host listens for console-message)
      console.log('__PEEK_DRAG__:' + e.screenX + ':' + e.screenY);
      timer = null;
    }, ${WEBVIEW_DRAG_HOLD_THRESHOLD});
  }, true);

  document.addEventListener('mousemove', function(e) {
    if (!timer) return;
    // Cancel if moved more than 5px (user is selecting text, not holding)
    if (Math.abs(e.screenX - startX) > 5 || Math.abs(e.screenY - startY) > 5) {
      cancel();
    }
  }, true);

  document.addEventListener('mouseup', function() { cancel(); }, true);
  document.addEventListener('scroll', function() { cancel(); }, true);
  // Also cancel on context menu (right-click)
  document.addEventListener('contextmenu', function() { cancel(); }, true);
})();
`;

// Listen for the long-press signal from the guest page
webview.addEventListener('console-message', (e) => {
  if (typeof e.message !== 'string' || !e.message.startsWith('__PEEK_DRAG__:')) return;
  const parts = e.message.split(':');
  const screenX = parseFloat(parts[1]);
  const screenY = parseFloat(parts[2]);
  if (isNaN(screenX) || isNaN(screenY)) return;

  // Activate the overlay so it captures all subsequent mouse events for the drag
  dragOverlay.classList.add('active');
  startDrag(screenX, screenY);
  DEBUG && console.log('[page] Webview long-press drag started at', screenX, screenY);
});

// Inject the long-press detector into the guest page on every navigation
webview.addEventListener('dom-ready', () => {
  webview.executeJavaScript(WEBVIEW_LONG_PRESS_JS).catch(err => {
    DEBUG && console.log('[page] Failed to inject long-press detector:', err.message);
  });
});

// The drag overlay captures mousemove/mouseup once active (handled by shared drag listeners below)
// On mouseup during drag, deactivate the overlay
dragOverlay.addEventListener('mouseup', () => {
  dragOverlay.classList.remove('active');
});

// --- Custom resize (all corner handles) ---
// Uses pointer capture to keep receiving events even if cursor leaves the window.
// Each direction (se, sw, ne, nw) adjusts different edges of the bounds.

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
    resizeStartWidth = bounds.width;
    resizeStartHeight = bounds.height;
    resizeStartBoundsX = bounds.x;
    resizeStartBoundsY = bounds.y;
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

    // Apply resize based on direction
    if (resizeDir === 'se') {
      bounds.width = Math.max(MIN_WIDTH, resizeStartWidth + dx);
      bounds.height = Math.max(MIN_HEIGHT, resizeStartHeight + dy);
    } else if (resizeDir === 'sw') {
      const newWidth = Math.max(MIN_WIDTH, resizeStartWidth - dx);
      bounds.x = resizeStartBoundsX + (resizeStartWidth - newWidth);
      bounds.width = newWidth;
      bounds.height = Math.max(MIN_HEIGHT, resizeStartHeight + dy);
    } else if (resizeDir === 'ne') {
      bounds.width = Math.max(MIN_WIDTH, resizeStartWidth + dx);
      const newHeight = Math.max(MIN_HEIGHT, resizeStartHeight - dy);
      bounds.y = resizeStartBoundsY + (resizeStartHeight - newHeight);
      bounds.height = newHeight;
    } else if (resizeDir === 'nw') {
      const newWidth = Math.max(MIN_WIDTH, resizeStartWidth - dx);
      bounds.x = resizeStartBoundsX + (resizeStartWidth - newWidth);
      bounds.width = newWidth;
      const newHeight = Math.max(MIN_HEIGHT, resizeStartHeight - dy);
      bounds.y = resizeStartBoundsY + (resizeStartHeight - newHeight);
      bounds.height = newHeight;
    }

    updatePositions();
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

// Initialize all resize handles
Object.values(resizeHandles).forEach(initResizeHandle);

function cancelResize() {
  const wasResizing = isResizing;
  isResizing = false;
  resizeDir = null;
  activeResizeHandle = null;
  document.body.style.cursor = '';
  // Persist updated bounds to URL params for session save
  if (wasResizing) {
    updateUrlParams();
  }
}

// --- Shared mousemove/mouseup for drag ---

document.addEventListener('mousemove', (e) => {
  // Safety: if no button is held during drag, cancel it.
  // Use our tracked pageMouseButtonDown rather than e.buttons which can report
  // stale values (0) during fast cursor movements due to Chromium event coalescing.
  if (isDragging && !pageMouseButtonDown) {
    isDragging = false;
    dragOverlay.classList.remove('active');
    document.body.style.cursor = '';
    navbar.style.cursor = 'grab';
    // Persist updated bounds to URL params for session save
    updateUrlParams();
    return;
  }

  if (isDragging) {
    const dx = e.screenX - dragStartX;
    const dy = e.screenY - dragStartY;
    bounds.x = dragStartBoundsX + dx;
    bounds.y = dragStartBoundsY + dy;
    updatePositions();
  }
});

document.addEventListener('mouseup', () => {
  if (isDragging) {
    isDragging = false;
    dragOverlay.classList.remove('active');
    document.body.style.cursor = '';
    navbar.style.cursor = 'grab';
    // Persist updated bounds to URL params for session save
    updateUrlParams();
  }
});

// --- State display ---

function updateState() {
  btnBack.disabled = !webview.canGoBack();
  btnForward.disabled = !webview.canGoForward();
}

// --- Show / Hide navbar ---
// The navbar is shown by:
//   1. Cmd+L (published from main process via before-input-event on guest/host webContents)
//   2. Hovering near the top of the webview (trigger zone)
// It is hidden by clicking outside, pressing Escape, or moving mouse away (hover mode).

let hideTimer = null;
let showSource = null; // 'hover' or 'shortcut' — determines dismiss behavior

function show(opts) {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  const wasHidden = !navbar.classList.contains('visible');
  navbar.classList.add('visible');
  if (opts?.source) showSource = opts.source;
  if (wasHidden) {
    updatePositions(); // Show navbar corner resize handles
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
  // Don't hide while dragging or about to drag
  if (isDragging || holdDragPending) return;
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  navbar.classList.remove('visible');
  updatePositions(); // Hide navbar corner resize handles
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
// Mouse entering the area above the webview shows the navbar.
// Moving away from both the trigger zone AND the navbar hides it (with a small delay).

function scheduleHide() {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    // Only auto-hide if shown by hover (not by Cmd+L)
    if (showSource === 'hover') {
      hide();
    }
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
// Published from main process with GLOBAL scope (both host and webview guest fire this)
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

/**
 * Normalize user input into a navigable URL.
 * If it looks like a URL (has a dot, or starts with a protocol), use it directly.
 * Otherwise prefix with https://.
 */
function normalizeUrl(input) {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Already has a protocol
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // Looks like a domain (contains a dot and no spaces)
  if (trimmed.includes('.') && !trimmed.includes(' ')) return 'https://' + trimmed;
  // Fallback: prefix with https://
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
  // Escape while editing the URL field: restore current URL and hide navbar
  if (e.key === 'Escape') {
    urlText.value = webview.getURL() || targetUrl;
    urlText.blur();
    hide();
    e.stopPropagation();
  }
});

// Prevent mousedown on URL field from triggering navbar drag
urlText.addEventListener('mousedown', (e) => {
  e.stopPropagation();
});

// Select all on focus (clicking the field)
urlText.addEventListener('focus', () => {
  // Defer so the click doesn't immediately deselect
  requestAnimationFrame(() => urlText.select());
});

// --- Escape handling ---

// Register escape handler for internal navigation (back in webview history)
// The backend determines close policy based on the window's role.
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

// NOTE: The 'new-window' webview event was removed in Electron 22.
// Popups from webview guests (window.open / target="_blank") are now handled
// by setWindowOpenHandler on the guest webContents, attached via
// did-attach-webview in backend/electron/ipc.ts.

webview.addEventListener('did-fail-load', (e) => {
  if (e.errorCode === -3) return;
  console.error('[page] Load failed:', e.errorCode, e.errorDescription);
});

// Set default background color on webview content if the page doesn't set one
// This prevents white-text-on-transparent issues for pages that assume a background
webview.addEventListener('dom-ready', async () => {
  try {
    // Detection script that thoroughly checks for any background
    const detectionJs = `
      (function() {
        // Check if a color value represents "no background"
        function isTransparentColor(color) {
          if (!color) return true;
          if (color === 'transparent') return true;
          if (color === 'rgba(0, 0, 0, 0)') return true;
          // Handle any rgba with alpha = 0
          const rgbaMatch = color.match(/rgba\\s*\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*([\\d.]+)\\s*\\)/);
          if (rgbaMatch && parseFloat(rgbaMatch[1]) === 0) return true;
          return false;
        }

        // Check if an element has a background set (color or image)
        function hasBackground(el) {
          if (!el) return false;
          const style = window.getComputedStyle(el);

          // Check background-color
          const bgColor = style.backgroundColor;
          const hasColor = !isTransparentColor(bgColor);

          // Check background-image (includes gradients)
          const bgImage = style.backgroundImage;
          const hasImage = bgImage && bgImage !== 'none';

          return hasColor || hasImage;
        }

        // Check both html and body elements
        const html = document.documentElement;
        const body = document.body;

        const htmlHasBg = hasBackground(html);
        const bodyHasBg = hasBackground(body);

        // If either has a background, we don't need to set one
        return !(htmlHasBg || bodyHasBg);
      })();
    `;

    // Run detection in page context
    const needsBackground = await webview.executeJavaScript(detectionJs);

    if (needsBackground) {
      // Simple fix: set white background
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
// After DOM is ready, detect OpenSearch <link> tags and publish page:loaded for extensions

webview.addEventListener('did-finish-load', async () => {
  const pageUrl = webview.getURL();
  if (!pageUrl) return;

  // Only process http/https pages
  if (!pageUrl.startsWith('http://') && !pageUrl.startsWith('https://')) return;

  let opensearchUrl = null;

  try {
    // Detect OpenSearch description link in the page
    const detectedUrl = await webview.executeJavaScript(`
      (function() {
        const link = document.querySelector('link[rel="search"][type="application/opensearchdescription+xml"]');
        return link ? link.href : null;
      })();
    `);

    if (detectedUrl) {
      // Resolve relative URLs against the page URL
      try {
        opensearchUrl = new URL(detectedUrl, pageUrl).href;
      } catch (e) {
        // Invalid URL, skip
      }
    }
  } catch (err) {
    DEBUG && console.log('[page] OpenSearch detection failed:', err.message);
  }

  // Publish page:loaded event for extensions (e.g., websearch OpenSearch discovery)
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

/**
 * Update the mode indicator display
 */
function updateModeIndicator() {
  if (!modeIndicator) return;

  const label = modeIndicator.querySelector('.mode-label');
  const groupName = modeIndicator.querySelector('.group-name');

  modeIndicator.setAttribute('data-mode', currentMode);

  if (label) {
    label.textContent = currentMode;
  }

  // Show group name when in group mode
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

/**
 * Initialize mode context on page load
 */
async function initModeContext() {
  try {
    // Check if we inherited group mode from opener BEFORE setting page mode
    const existingMode = await api.context.get('mode');
    if (existingMode.success && existingMode.data && existingMode.data.value === 'group') {
      // Window inherited group mode from opener - preserve it
      currentMode = 'group';
      currentModeMetadata = existingMode.data.metadata || {};
      DEBUG && console.log('[page] Inherited group mode, preserving:', currentModeMetadata);
    } else {
      // No inherited group mode - set page mode as before
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

    // Read back the current mode
    const modeResult = await api.context.get('mode');
    if (modeResult.success && modeResult.data) {
      currentMode = modeResult.data.value || 'page';
      currentModeMetadata = modeResult.data.metadata || {};
      updateModeIndicator();
    }

    // Watch for mode changes
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

// Initialize mode context
initModeContext();

// --- Widget system ---
// Widgets are small UI panels that appear on the transparent canvas to the right
// of the webview. Each widget is a position:absolute div inside the widget container,
// positioned by updatePositions(). Widgets can be added, removed, and updated via API.

const widgets = new Map(); // id -> { element, timers }

/**
 * Add a widget panel to the right side of the page.
 * @param {string} id - Unique widget identifier
 * @param {object} opts - Widget options
 * @param {string} opts.title - Widget header title
 * @param {string|HTMLElement} opts.content - HTML string or DOM element for widget body
 * @param {number} [opts.autoDismiss] - Auto-dismiss after N milliseconds (0 = no auto-dismiss)
 * @param {function} [opts.onClose] - Callback when widget is closed
 * @returns {object} Widget handle with { element, close() }
 */
function addWidget(id, { title, content, autoDismiss = 0, onClose } = {}) {
  // Remove existing widget with same id
  if (widgets.has(id)) {
    removeWidget(id);
  }

  const el = document.createElement('div');
  el.className = 'widget';
  el.dataset.widgetId = id;

  // Header with title and close button
  const header = document.createElement('div');
  header.className = 'widget-header';

  const titleEl = document.createElement('span');
  titleEl.className = 'widget-title';
  titleEl.textContent = title || '';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'widget-close';
  closeBtn.textContent = '\u00D7'; // multiplication sign (x)
  closeBtn.title = 'Dismiss';
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    removeWidget(id);
  });

  header.appendChild(titleEl);
  header.appendChild(closeBtn);
  el.appendChild(header);

  // Body
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

  // Animate in on next frame
  requestAnimationFrame(() => {
    el.classList.add('visible');
  });

  // Auto-dismiss
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

/**
 * Remove a widget by id with a fade-out animation.
 * @param {string} id - Widget identifier
 */
function removeWidget(id) {
  const handle = widgets.get(id);
  if (!handle) return;

  // Clear any pending timers
  for (const timer of handle.timers) {
    clearTimeout(timer);
  }

  // Animate out
  handle.element.classList.remove('visible');
  handle.element.classList.add('hiding');

  setTimeout(() => {
    handle.element.remove();
  }, 300); // Match transition duration

  if (handle.onClose) {
    try { handle.onClose(); } catch (e) { /* ignore */ }
  }

  widgets.delete(id);
  DEBUG && console.log('[page] Widget removed:', id);
}

/**
 * Update a widget's content.
 * @param {string} id - Widget identifier
 * @param {object} opts - Update options
 * @param {string|HTMLElement} [opts.content] - New content for widget body
 * @param {string} [opts.title] - New title
 */
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
// When the websearch extension discovers an OpenSearch engine, show a temporary
// notification widget on the right side of the page.

api.subscribe('websearch:engine-discovered', (msg) => {
  if (!msg || !msg.engine) return;

  const { engine } = msg;
  const widgetId = `opensearch-${engine.id}`;

  DEBUG && console.log('[page] OpenSearch engine discovered:', engine.name);

  // Build the widget content
  const contentEl = document.createElement('div');

  // Engine info row
  const infoRow = document.createElement('div');
  infoRow.className = 'widget-engine-found';

  const iconSpan = document.createElement('span');
  iconSpan.className = 'widget-engine-icon';
  iconSpan.textContent = '\uD83D\uDD0D'; // magnifying glass emoji

  const nameSpan = document.createElement('span');
  nameSpan.className = 'widget-engine-name';
  nameSpan.textContent = engine.name;

  infoRow.appendChild(iconSpan);
  infoRow.appendChild(nameSpan);
  contentEl.appendChild(infoRow);

  // Action button - already added by the extension background, show confirmation
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

// --- Click-through on transparent background ---
// The canvas page is a fullscreen transparent BrowserWindow. Clicks on the
// transparent background (areas outside the webview, navbar, resize handles,
// and widgets) should pass through to windows behind it.
//
// Strategy:
// 1. Set setIgnoreMouseEvents(true, { forward: true }) — OS passes through
//    clicks on transparent pixels, but still forwards mouse events to renderer
// 2. Track mouse position via forwarded events to detect when cursor enters
//    a content element (webview, navbar, resize handles, widgets)
// 3. When cursor is over content, call setIgnoreMouseEvents(false) to receive events
// 4. When cursor leaves content, call setIgnoreMouseEvents(true, { forward: true })

(async function initClickThrough() {
  let windowId;
  try {
    windowId = await api.window.getWindowId();
    if (!windowId) {
      DEBUG && console.log('[page] No window ID for click-through');
      return;
    }
  } catch (err) {
    console.error('[page] Failed to get window ID for click-through:', err);
    return;
  }

  let ignoring = false;

  function setIgnore(ignore) {
    if (ignore === ignoring) return;
    ignoring = ignore;
    api.window.setIgnoreMouseEvents(windowId, ignore, ignore);
  }

  // Start with click-through enabled (transparent areas pass through)
  setIgnore(true);

  // Check if a point is over any content element
  function isOverContent(clientX, clientY) {
    const { x, y, width, height } = bounds;

    // Check webview area
    if (clientX >= x && clientX <= x + width && clientY >= y && clientY <= y + height) {
      return true;
    }

    // Check navbar (when visible)
    if (navbar.classList.contains('visible')) {
      const navRect = navbar.getBoundingClientRect();
      if (clientX >= navRect.left && clientX <= navRect.right &&
          clientY >= navRect.top && clientY <= navRect.bottom) {
        return true;
      }
    }

    // Check trigger zone (always active for hover-to-show navbar)
    const triggerRect = triggerZone.getBoundingClientRect();
    if (clientX >= triggerRect.left && clientX <= triggerRect.right &&
        clientY >= triggerRect.top && clientY <= triggerRect.bottom) {
      return true;
    }

    // Check resize handles
    for (const handle of Object.values(resizeHandles)) {
      if (!handle || handle.style.display === 'none') continue;
      const rect = handle.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 &&
          clientX >= rect.left && clientX <= rect.right &&
          clientY >= rect.top && clientY <= rect.bottom) {
        return true;
      }
    }

    // Check widget container children
    if (widgetContainer) {
      const widgetEls = widgetContainer.querySelectorAll('.widget');
      for (const w of widgetEls) {
        const rect = w.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 &&
            clientX >= rect.left && clientX <= rect.right &&
            clientY >= rect.top && clientY <= rect.bottom) {
          return true;
        }
      }
    }

    return false;
  }

  // Listen for mouse events to toggle click-through.
  // When ignoreMouseEvents is true with forward: true, mouse events are still
  // delivered to the renderer (but clicks pass through at the OS level).
  // We use mousemove to detect transitions between content and transparent areas.
  document.addEventListener('mousemove', (e) => {
    const overContent = isOverContent(e.clientX, e.clientY);
    if (overContent && ignoring) {
      // Cursor entered content area — start receiving events
      setIgnore(false);
    } else if (!overContent && !ignoring) {
      // Cursor left content area — pass through clicks again
      // But only if not dragging or resizing (those need continued event capture)
      if (!isDragging && !isResizing) {
        setIgnore(true);
      }
    }
  });

  // When drag or resize ends, re-evaluate click-through state
  document.addEventListener('mouseup', () => {
    // After drag/resize ends, schedule a re-check on next frame
    requestAnimationFrame(() => {
      if (!isDragging && !isResizing && !ignoring) {
        // Re-enable click-through — the next mousemove will toggle it off
        // if cursor is still over content
        setIgnore(true);
      }
    });
  });

  DEBUG && console.log('[page] Click-through initialized for transparent background');
})();

DEBUG && console.log('[page] Canvas container initialized for:', targetUrl);
