/**
 * Shared card helpers for building peek-card elements.
 *
 * Composable utilities that eliminate duplication across groups, search,
 * and tags extensions when constructing standard card header/footer slots,
 * favicons, title extraction, URL formatting, and click-debounce wrappers.
 */

// ── Constants ────────────────────────────────────────────────────────────

const GLOBE_FAVICON = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">\u{1F310}</text></svg>';

// ── Header / Footer slot builders ────────────────────────────────────────

/**
 * Create the standard header-slot div with flex layout.
 *
 * @param {HTMLElement} iconEl - An icon element (img, span, div, etc.)
 * @param {string} titleText - Text for the h2 title
 * @returns {HTMLElement} div[slot="header"]
 */
export const createHeaderSlot = (iconEl, titleText) => {
  const header = document.createElement('div');
  header.slot = 'header';
  header.style.display = 'flex';
  header.style.alignItems = 'center';
  header.style.gap = '8px';

  if (iconEl) header.appendChild(iconEl);

  const title = document.createElement('h2');
  title.className = 'card-title';
  title.textContent = titleText;
  title.style.margin = '0';
  title.style.flex = '1';
  title.style.minWidth = '0';

  header.appendChild(title);
  return header;
};

/**
 * Create the standard footer-slot div with flex justify-between layout.
 *
 * @param {HTMLElement|null} leftEl  - Left-side element (URL span, preview, etc.)
 * @param {HTMLElement|null} rightEl - Right-side element (visit count, etc.)
 * @returns {HTMLElement} div[slot="footer"]
 */
export const createFooterSlot = (leftEl, rightEl) => {
  const footer = document.createElement('div');
  footer.slot = 'footer';
  footer.className = 'card-meta';
  footer.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;';

  if (leftEl) footer.appendChild(leftEl);
  if (rightEl) footer.appendChild(rightEl);
  return footer;
};

// ── Favicon helper ───────────────────────────────────────────────────────

/**
 * Create a favicon <img> with onerror fallback.
 *
 * @param {string} [url] - Favicon URL. Falls back to globe emoji SVG.
 * @param {string} [fallbackSvg] - Custom fallback SVG data-URI (default: globe emoji)
 * @returns {HTMLImageElement}
 */
export const createFaviconEl = (url, fallbackSvg) => {
  const fallback = fallbackSvg || GLOBE_FAVICON;
  const img = document.createElement('img');
  img.className = 'card-favicon';
  img.src = url || fallback;
  img.onerror = () => {
    img.src = fallback;
    img.onerror = null;
  };
  return img;
};

// ── Title extraction ─────────────────────────────────────────────────────

/**
 * Extract a display title from an item/address object.
 *
 * Priority: item.title > metadata.title > fallback
 *
 * @param {object} item - Item or Address object
 * @param {string} [fallback] - Fallback when no title found (default: item URL or '(untitled)')
 * @returns {string}
 */
export const extractTitle = (item, fallback) => {
  let title = item.title;
  if (!title && item.metadata) {
    try {
      const meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata;
      title = meta.title;
    } catch (e) {
      // Ignore parse errors
    }
  }
  return title || fallback || item.uri || item.content || '(untitled)';
};

// ── URL formatting ───────────────────────────────────────────────────────

/**
 * Format a URL for display: strips protocol, shows hostname + truncated path.
 *
 * @param {string} url
 * @returns {string}
 */
export const formatUrl = (url) => {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname !== '/' ? u.pathname : '');
  } catch {
    return url;
  }
};

/**
 * Create a styled URL span element for use inside a footer slot.
 *
 * @param {string} text - Display text (typically from formatUrl)
 * @returns {HTMLSpanElement}
 */
export const createUrlSpan = (text) => {
  const span = document.createElement('span');
  span.className = 'card-url';
  span.textContent = text;
  span.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1;opacity:0.7;';
  return span;
};

// ── Click debounce ───────────────────────────────────────────────────────

/**
 * Wrap a card-click handler with an isOpening debounce flag.
 * Prevents rapid double-clicks from opening multiple windows.
 *
 * @param {HTMLElement} card - The peek-card element
 * @param {Function} handler - Async handler called on card-click
 * @param {number} [cooldown=500] - Cooldown in ms before allowing another click
 */
export const withClickDebounce = (card, handler, cooldown = 500) => {
  let isOpening = false;
  card.addEventListener('card-click', async (...args) => {
    if (isOpening) return;
    isOpening = true;
    try {
      await handler(...args);
    } finally {
      setTimeout(() => { isOpening = false; }, cooldown);
    }
  });
};

// ── Tag Action Affordances (re-exported for convenience) ──────────────────

/**
 * For tag action affordance rendering on cards, import from:
 *   'peek://app/lib/tag-action-affordances.js'
 *
 * That module provides:
 *   - resolveAffordances(itemTagNames, actionRules) — resolve affordance descriptors
 *   - createAffordanceElements(itemId, tags, rules, api, opts) — create DOM elements
 *   - createActionRulesCache(api) — subscribe to action rule updates
 */
