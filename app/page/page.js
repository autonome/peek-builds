/**
 * peek://page - Container for web content
 *
 * Content-sized BrowserWindow with:
 * - Webview filling the window
 * - Floating navbar overlay at top (with trigger zone)
 * - Drag via -webkit-app-region: drag on navbar
 * - Resize via IPC to resize the BrowserWindow
 */

import izui from '../izui.js';
import api from '../api.js';

const DEBUG = true;

// Parse URL parameters
const params = new URLSearchParams(window.location.search);
const targetUrl = params.get('url');

if (!targetUrl) {
  console.error('[page] No URL provided');
  document.body.innerHTML = '<h1>Error: No URL provided</h1>';
  throw new Error('No URL provided to peek://page');
}

DEBUG && console.log('[page] Loading:', targetUrl);

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

// Set up webview partition for session isolation and load the target URL
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

// --- Resize via IPC (drag on navbar handled natively by -webkit-app-region: drag) ---

let isResizing = false;

resizeHandle.addEventListener('mousedown', (e) => {
  isResizing = true;
  e.preventDefault();
  e.stopPropagation();
});

document.addEventListener('mousemove', (e) => {
  if (isResizing) {
    const newWidth = Math.max(200, e.screenX - window.screenX);
    const newHeight = Math.max(150, e.screenY - window.screenY);
    api.invoke('window-set-bounds', { width: newWidth, height: newHeight });
  }
});

document.addEventListener('mouseup', () => {
  isResizing = false;
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
api.subscribe('page:show-navbar', () => show({ focusUrl: true }), api.scopes.WINDOW);

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

// Initialize IZUI for proper stack navigation
// Web page containers can have children (links opening new windows)
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
}).catch(err => {
  console.error('[page] IZUI init error:', err);
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
