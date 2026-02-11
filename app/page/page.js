/**
 * peek://page - Fullscreen transparent canvas container for web content
 *
 * Architecture: A fullscreen transparent BrowserWindow covers the entire display.
 * All UI elements (webview, navbar, trigger zone, resize handle, mode indicator)
 * are position:absolute siblings, positioned by JS via updatePositions() using
 * a `bounds` object. The navbar sits ABOVE the webview with an 8px gap.
 *
 * - Custom drag: mousedown on navbar moves bounds
 * - Custom resize: mousedown on resize handle changes bounds size
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
const resizeHandle = document.getElementById('resize-handle');
const btnBack = document.getElementById('btn-back');
const btnForward = document.getElementById('btn-forward');
const btnReload = document.getElementById('btn-reload');
const urlText = document.getElementById('url-text');
const modeIndicator = document.getElementById('mode-indicator');

// --- Position all elements based on bounds ---

function updatePositions() {
  const { x, y, width, height } = bounds;

  // Webview — the main content area
  webview.style.left = `${x}px`;
  webview.style.top = `${y}px`;
  webview.style.width = `${width}px`;
  webview.style.height = `${height}px`;

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

  // Resize handle — bottom-right corner of the webview
  resizeHandle.style.left = `${x + width - 16}px`;
  resizeHandle.style.top = `${y + height - 16}px`;

  // Mode indicator — top-right corner of the webview
  if (modeIndicator) {
    modeIndicator.style.left = `${x + width - 120}px`;
    modeIndicator.style.top = `${y + 8}px`;
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
  urlText.textContent = targetUrl;
}

// Start initialization
initWebview();

// --- Custom drag (navbar) ---

let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let dragStartBoundsX = 0;
let dragStartBoundsY = 0;

navbar.addEventListener('mousedown', (e) => {
  // Don't start drag on buttons or URL text
  if (e.target.closest('.nav-btn') || e.target.closest('.url-text')) return;
  isDragging = true;
  dragStartX = e.screenX;
  dragStartY = e.screenY;
  dragStartBoundsX = bounds.x;
  dragStartBoundsY = bounds.y;
  navbar.style.cursor = 'grabbing';
  e.preventDefault();
});

// --- Custom resize (resize handle) ---

let isResizing = false;
let resizeStartX = 0;
let resizeStartY = 0;
let resizeStartWidth = 0;
let resizeStartHeight = 0;

resizeHandle.addEventListener('mousedown', (e) => {
  isResizing = true;
  resizeStartX = e.screenX;
  resizeStartY = e.screenY;
  resizeStartWidth = bounds.width;
  resizeStartHeight = bounds.height;
  e.preventDefault();
  e.stopPropagation();
});

// --- Shared mousemove/mouseup for drag and resize ---

document.addEventListener('mousemove', (e) => {
  if (isDragging) {
    const dx = e.screenX - dragStartX;
    const dy = e.screenY - dragStartY;
    bounds.x = dragStartBoundsX + dx;
    bounds.y = dragStartBoundsY + dy;
    updatePositions();
  } else if (isResizing) {
    const dx = e.screenX - resizeStartX;
    const dy = e.screenY - resizeStartY;
    bounds.width = Math.max(MIN_WIDTH, resizeStartWidth + dx);
    bounds.height = Math.max(MIN_HEIGHT, resizeStartHeight + dy);
    updatePositions();
  }
});

document.addEventListener('mouseup', () => {
  if (isDragging) {
    isDragging = false;
    navbar.style.cursor = 'grab';
  }
  if (isResizing) {
    isResizing = false;
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
    updateState();
    DEBUG && console.log('[page] Navbar shown, source:', showSource);
  }
  if (opts?.focusUrl) {
    requestAnimationFrame(() => {
      const range = document.createRange();
      range.selectNodeContents(urlText);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
  }
}

function hide() {
  // Don't hide while dragging
  if (isDragging) return;
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  navbar.classList.remove('visible');
  window.getSelection().removeAllRanges();
  showSource = null;
  DEBUG && console.log('[page] Navbar hidden');
}

// Dismiss on click outside the navbar
document.addEventListener('mousedown', (e) => {
  if (navbar.classList.contains('visible') && !navbar.contains(e.target) && e.target !== triggerZone) {
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

// URL text click-to-select
urlText.addEventListener('click', (e) => {
  e.stopPropagation();
  const range = document.createRange();
  range.selectNodeContents(urlText);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
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
  document.title = e.title || targetUrl;
});

webview.addEventListener('did-navigate', async (e) => {
  DEBUG && console.log('[page] did-navigate:', e.url);
  urlText.textContent = e.url;
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
    urlText.textContent = e.url;
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

DEBUG && console.log('[page] Canvas container initialized for:', targetUrl);
