/**
 * peek://page - Container for web content
 *
 * Full-screen transparent canvas with:
 * - Webview positioned at caller's coordinates
 * - Floating navbar above the webview (with gap)
 * - Webview is draggable and resizable
 */

import izui from '../izui.js';
import api from '../api.js';

const DEBUG = true;

// Parse URL parameters
const params = new URLSearchParams(window.location.search);
const targetUrl = params.get('url');
const initialX = parseInt(params.get('x')) || 100;
const initialY = parseInt(params.get('y')) || 100;
const initialWidth = parseInt(params.get('width')) || 1024;
const initialHeight = parseInt(params.get('height')) || 768;

if (!targetUrl) {
  console.error('[page] No URL provided');
  document.body.innerHTML = '<h1>Error: No URL provided</h1>';
  throw new Error('No URL provided to peek://page');
}

DEBUG && console.log('[page] Loading:', targetUrl, 'at', initialX, initialY, initialWidth, initialHeight);

// DOM elements
const navbar = document.getElementById('navbar');
const triggerZone = document.getElementById('trigger-zone');
const webview = document.getElementById('content');
const resizeHandle = document.getElementById('resize-handle');
const btnBack = document.getElementById('btn-back');
const btnForward = document.getElementById('btn-forward');
const btnReload = document.getElementById('btn-reload');
const urlText = document.getElementById('url-text');
const modeIndicator = document.getElementById('mode-indicator');

// Current webview bounds
let bounds = { x: initialX, y: initialY, width: initialWidth, height: initialHeight };
const NAVBAR_HEIGHT = 36;
const NAVBAR_GAP = 8;

// Position elements
function updatePositions() {
  // Webview position
  webview.style.left = bounds.x + 'px';
  webview.style.top = bounds.y + 'px';
  webview.style.width = bounds.width + 'px';
  webview.style.height = bounds.height + 'px';

  // Navbar above webview with gap
  navbar.style.left = bounds.x + 'px';
  navbar.style.top = (bounds.y - NAVBAR_HEIGHT - NAVBAR_GAP) + 'px';
  navbar.style.width = bounds.width + 'px';

  // Trigger zone spans navbar area
  triggerZone.style.left = bounds.x + 'px';
  triggerZone.style.top = (bounds.y - NAVBAR_HEIGHT - NAVBAR_GAP - 10) + 'px';
  triggerZone.style.width = bounds.width + 'px';

  // Resize handle at bottom-right of webview
  resizeHandle.style.left = (bounds.x + bounds.width - 16) + 'px';
  resizeHandle.style.top = (bounds.y + bounds.height - 16) + 'px';
}

// Initialize positions
updatePositions();

// Load the target URL
webview.src = targetUrl;
urlText.textContent = targetUrl;

// --- Drag to move webview ---

let isDragging = false;
let dragStart = { x: 0, y: 0 };

navbar.addEventListener('mousedown', (e) => {
  if (e.target.classList.contains('nav-btn') || e.target.classList.contains('url-text')) return;
  isDragging = true;
  dragStart = { x: e.clientX - bounds.x, y: e.clientY - bounds.y };
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (isDragging) {
    bounds.x = e.clientX - dragStart.x;
    bounds.y = e.clientY - dragStart.y;
    updatePositions();
  }
  if (isResizing) {
    bounds.width = Math.max(200, e.clientX - bounds.x);
    bounds.height = Math.max(150, e.clientY - bounds.y);
    updatePositions();
  }
});

document.addEventListener('mouseup', () => {
  isDragging = false;
  isResizing = false;
});

// --- Resize webview ---

let isResizing = false;

resizeHandle.addEventListener('mousedown', (e) => {
  isResizing = true;
  e.preventDefault();
  e.stopPropagation();
});

// --- State display ---

function updateState() {
  btnBack.disabled = !webview.canGoBack();
  btnForward.disabled = !webview.canGoForward();
}

// --- Show / Hide navbar ---

function show(opts) {
  const wasHidden = !navbar.classList.contains('visible');
  navbar.classList.add('visible');
  if (wasHidden) updateState();
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

function isPointInElement(x, y, el) {
  const rect = el.getBoundingClientRect();
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function hide(e) {
  if (isDragging) return; // Don't hide while dragging
  // Check if cursor is still within navbar or trigger zone bounds
  if (isPointInElement(e.clientX, e.clientY, navbar)) return;
  if (isPointInElement(e.clientX, e.clientY, triggerZone)) return;
  navbar.classList.remove('visible');
  window.getSelection().removeAllRanges();
}

// Show navbar when entering trigger zone or navbar itself
triggerZone.addEventListener('mouseenter', () => show({}));
navbar.addEventListener('mouseenter', () => show({}));
navbar.addEventListener('mouseleave', hide);
triggerZone.addEventListener('mouseleave', hide);

// Cmd+L: show with URL focus
api.subscribe('overlay:show', () => show({ focusUrl: true }), api.scopes.WINDOW);

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

// --- IZUI integration ---

izui.init({
  canHaveChildren: true,
  onEscape: () => {
    if (webview.canGoBack()) {
      DEBUG && console.log('[page] ESC: webview going back');
      webview.goBack();
      return { handled: true };
    }
    DEBUG && console.log('[page] ESC: at root, closing');
    return { handled: false };
  }
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
    const addressResult = await api.datastore.addAddress(e.url, {});
    if (addressResult.success && addressResult.data?.id) {
      await api.datastore.addVisit(addressResult.data.id, {});
    }
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

webview.addEventListener('new-window', async (e) => {
  DEBUG && console.log('[page] new-window:', e.url);
  e.preventDefault();
  await izui.openChildWindow(e.url, { width: 1024, height: 768 });
});

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
    // Set page mode via context API
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

    // Check if we inherited group mode from opener
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

DEBUG && console.log('[page] Container initialized for:', targetUrl);
