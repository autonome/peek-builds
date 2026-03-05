/**
 * Page Widgets Sample Extension
 *
 * Demonstrates the page widget extensibility API:
 * 1. Registers a widget on startup
 * 2. Listens for page:loaded events
 * 3. Runs a content script to extract metadata from the page
 * 4. Renders the extracted metadata in its widget
 *
 * This is a reference implementation for extension developers.
 */

const api = window.app;
const debug = api.debug;

const EXTENSION_ID = 'pagewidgets-sample';
const WIDGET_ID = 'page-meta';

let requestCounter = 0;

/**
 * Generate a unique request ID for script execution correlation
 */
function nextRequestId() {
  return `${EXTENSION_ID}-${++requestCounter}-${Date.now()}`;
}

/**
 * Execute a content script in the current page and wait for the result.
 *
 * Uses the page:execute-script / page:script-result pubsub pattern
 * with requestId correlation.
 *
 * @param {string} script - JavaScript code to execute in the page webview
 * @param {number} [timeout=5000] - Timeout in ms
 * @returns {Promise<any>} - The script result
 */
function executeContentScript(script, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const requestId = nextRequestId();
    let timer = null;
    let unsub = null;

    function cleanup() {
      if (timer) clearTimeout(timer);
      if (unsub) unsub();
    }

    // Listen for the result
    unsub = api.subscribe('page:script-result', (msg) => {
      if (msg.requestId !== requestId) return;
      cleanup();

      if (msg.success) {
        resolve(msg.result);
      } else {
        reject(new Error(msg.error || 'Script execution failed'));
      }
    }, api.scopes.GLOBAL);

    // Set timeout
    timer = setTimeout(() => {
      cleanup();
      reject(new Error('Content script execution timed out'));
    }, timeout);

    // Request execution
    api.publish('page:execute-script', {
      extensionId: EXTENSION_ID,
      requestId,
      script,
    }, api.scopes.GLOBAL);
  });
}

/**
 * Content script that extracts page metadata.
 * Runs inside the page's webview context.
 */
const METADATA_EXTRACTION_SCRIPT = `
(function() {
  function getMeta(name) {
    var el = document.querySelector('meta[property="' + name + '"], meta[name="' + name + '"]');
    return el ? (el.getAttribute('content') || '').trim() : '';
  }

  var headings = [];
  var h1s = document.querySelectorAll('h1');
  for (var i = 0; i < Math.min(h1s.length, 5); i++) {
    var text = h1s[i].textContent.trim();
    if (text) headings.push(text);
  }

  var linkCount = document.querySelectorAll('a[href]').length;
  var imageCount = document.querySelectorAll('img').length;
  var formCount = document.querySelectorAll('form').length;
  var scriptCount = document.querySelectorAll('script').length;

  var wordCount = 0;
  try {
    var text = document.body.innerText || '';
    wordCount = text.split(/\\s+/).filter(function(w) { return w.length > 0; }).length;
  } catch(e) {}

  return {
    title: document.title || '',
    description: getMeta('description') || getMeta('og:description') || '',
    author: getMeta('author') || '',
    headings: headings,
    stats: {
      links: linkCount,
      images: imageCount,
      forms: formCount,
      scripts: scriptCount,
      words: wordCount
    }
  };
})();
`;

/**
 * Build HTML content for the widget from extracted metadata
 */
function buildWidgetHtml(meta) {
  const parts = [];

  if (meta.description) {
    parts.push(`<div style="margin-bottom:8px;font-size:12px;color:var(--theme-text-secondary,#aaa);line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${escapeHtml(meta.description)}</div>`);
  }

  if (meta.headings && meta.headings.length > 0) {
    const headingList = meta.headings
      .map(h => `<div style="font-size:12px;color:var(--theme-text,#e0e0e0);padding:2px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(h)}</div>`)
      .join('');
    parts.push(`<div style="margin-bottom:8px;"><div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--theme-text-muted,#777);margin-bottom:4px;">Headings</div>${headingList}</div>`);
  }

  if (meta.stats) {
    const s = meta.stats;
    const statItems = [];
    if (s.words > 0) statItems.push(`${s.words.toLocaleString()} words`);
    if (s.links > 0) statItems.push(`${s.links} links`);
    if (s.images > 0) statItems.push(`${s.images} images`);
    if (s.forms > 0) statItems.push(`${s.forms} forms`);

    if (statItems.length > 0) {
      parts.push(`<div style="font-size:11px;color:var(--theme-text-muted,#888);line-height:1.5;">${statItems.join(' &middot; ')}</div>`);
    }
  }

  if (meta.author) {
    parts.push(`<div style="font-size:11px;color:var(--theme-text-muted,#888);margin-top:4px;">By ${escapeHtml(meta.author)}</div>`);
  }

  if (parts.length === 0) {
    parts.push('<div style="font-size:12px;color:var(--theme-text-muted,#666);font-style:italic;">No metadata available</div>');
  }

  return parts.join('');
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Handle page:loaded — extract metadata and render widget
 */
async function onPageLoaded(msg) {
  if (!msg || !msg.url) return;

  debug && console.log('[ext:pagewidgets-sample] Page loaded:', msg.url);

  try {
    const meta = await executeContentScript(METADATA_EXTRACTION_SCRIPT);
    const html = buildWidgetHtml(meta);

    api.publish('widget:render', {
      extensionId: EXTENSION_ID,
      widgetId: WIDGET_ID,
      title: 'Page Summary',
      html,
    }, api.scopes.GLOBAL);

    debug && console.log('[ext:pagewidgets-sample] Widget rendered for:', msg.url);
  } catch (err) {
    console.warn('[ext:pagewidgets-sample] Failed to extract metadata:', err.message);

    api.publish('widget:render', {
      extensionId: EXTENSION_ID,
      widgetId: WIDGET_ID,
      title: 'Page Summary',
      html: '<div style="font-size:12px;color:var(--theme-text-muted,#666);font-style:italic;">Could not extract page metadata</div>',
    }, api.scopes.GLOBAL);
  }
}

/**
 * Handle page:navigated — re-extract for new page
 */
function onPageNavigated(msg) {
  if (!msg || !msg.url) return;
  debug && console.log('[ext:pagewidgets-sample] Page navigated:', msg.url);
  // Re-extract after a brief delay for the new page to settle
  setTimeout(() => onPageLoaded(msg), 500);
}

/**
 * Handle page:will-close — clean up widget
 */
function onPageWillClose() {
  api.publish('widget:close', {
    extensionId: EXTENSION_ID,
    widgetId: WIDGET_ID,
  }, api.scopes.GLOBAL);
}

// ===== Lifecycle =====

const init = async () => {
  console.log('[ext:pagewidgets-sample] init');

  // Step 1: Register our widget
  api.publish('widget:register', {
    extensionId: EXTENSION_ID,
    widgetId: WIDGET_ID,
    title: 'Page Summary',
    position: 'right',
  }, api.scopes.GLOBAL);

  // Step 2: Listen for page lifecycle events
  api.subscribe('page:loaded', onPageLoaded, api.scopes.GLOBAL);
  api.subscribe('page:navigated', onPageNavigated, api.scopes.GLOBAL);
  api.subscribe('page:will-close', onPageWillClose, api.scopes.GLOBAL);

  console.log('[ext:pagewidgets-sample] Initialized — listening for page events');
};

const uninit = () => {
  console.log('[ext:pagewidgets-sample] uninit');
  onPageWillClose();
};

export default {
  id: EXTENSION_ID,
  labels: {
    name: 'Page Widgets Sample',
    description: 'Sample extension demonstrating the page widget extensibility API'
  },
  init,
  uninit
};
