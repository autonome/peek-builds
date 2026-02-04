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
    // Get the current theme to determine light/dark mode
    const theme = await api.theme.get();
    const isDark = theme?.isDark || theme?.effectiveScheme === 'dark';
    const defaultBg = isDark ? '#1a1a1a' : '#ffffff';

    // Inject CSS that sets a default background only if the page doesn't have one
    // Uses :where() for zero specificity so any page CSS will override it
    const css = `
      :where(html:not([style*="background"]):not([class])),
      :where(body:not([style*="background"])) {
        background-color: ${defaultBg};
      }
      /* Fallback: if html/body have no explicit background, set on html */
      html {
        background-color: ${defaultBg};
      }
    `;

    // Also run JS to check computed styles and set background only if truly transparent
    const js = `
      (function() {
        const defaultBg = '${defaultBg}';

        // Check if body has a background set (either directly or via CSS)
        const bodyStyle = window.getComputedStyle(document.body);
        const htmlStyle = window.getComputedStyle(document.documentElement);

        // rgba(0, 0, 0, 0) is the default "transparent" value
        const isTransparent = (color) => {
          if (!color) return true;
          if (color === 'transparent') return true;
          if (color === 'rgba(0, 0, 0, 0)') return true;
          return false;
        };

        const bodyBgTransparent = isTransparent(bodyStyle.backgroundColor);
        const htmlBgTransparent = isTransparent(htmlStyle.backgroundColor);

        // Only set background if both html and body are transparent
        if (bodyBgTransparent && htmlBgTransparent) {
          document.documentElement.style.backgroundColor = defaultBg;
        }
      })();
    `;

    await webview.insertCSS(css);
    await webview.executeJavaScript(js);
    DEBUG && console.log('[page] Injected default background color:', defaultBg);
  } catch (err) {
    console.error('[page] Failed to inject default background:', err);
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

DEBUG && console.log('[page] Container initialized for:', targetUrl);
