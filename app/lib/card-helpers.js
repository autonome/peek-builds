/**
 * Shared card helpers for building peek-card elements.
 *
 * Composable utilities that eliminate duplication across groups, search,
 * and tags extensions when constructing standard card header/footer slots,
 * favicons, title extraction, URL formatting, and click-debounce wrappers.
 */

// ── Constants ────────────────────────────────────────────────────────────

const GLOBE_FAVICON = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">\u{1F310}</text></svg>';

// Emoji SVG data URIs for item type icons
const TYPE_ICONS = {
  url:     GLOBE_FAVICON,
  text:    'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">\u{1F4DD}</text></svg>',
  tagset:  'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">\u{1F3F7}\uFE0F</text></svg>',
  image:   'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">\u{1F5BC}\uFE0F</text></svg>',
  entity:  'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">\u{1F48E}</text></svg>',
  feed:    'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">\u{1F4E1}</text></svg>',
  series:  'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">\u{1F4DA}</text></svg>',
  unknown: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">?</text></svg>'
};

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

// ── Item display info ───────────────────────────────────────────────────

/**
 * Extract the first URL from a text string (only if the entire content IS a URL).
 * @param {string} text
 * @returns {string|null}
 */
const extractUrl = (text) => {
  if (!text) return null;
  const trimmed = text.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    try { new URL(trimmed); return trimmed; } catch (e) { /* fall through */ }
  }
  if (/^([a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}(\/\S*)?$/.test(trimmed)) {
    try { new URL('https://' + trimmed); return 'https://' + trimmed; } catch (e) { /* not valid */ }
  }
  return null;
};

/**
 * Compute display properties (title, subtitle, faviconUrl, itemUrl) for any item.
 *
 * Centralizes the icon/title logic so all views (tags, search, groups) render
 * items consistently. Call this instead of duplicating type-switch logic.
 *
 * @param {object} item - Item object with at least { id, type, content, title, metadata }
 * @param {object} [opts]
 * @param {Array}  [opts.tags]      - Tag objects for this item (used for tagset subtitle)
 * @param {string} [opts.favicon]   - Explicit favicon URL (e.g. from address record)
 * @returns {{ title: string, subtitle: string, faviconUrl: string, itemUrl: string|null, itemType: string, isAddress: boolean }}
 */
export const getItemDisplayInfo = (item, opts = {}) => {
  const tags = opts.tags || [];
  const isAddress = !!item.uri;
  const itemType = item.type || 'url';
  const noteUrl = (itemType === 'text') ? extractUrl(item.content) : null;

  let title, subtitle;
  let faviconUrl = TYPE_ICONS.unknown;

  if (isAddress) {
    title = extractTitle(item, item.uri);
    subtitle = formatUrl(item.uri);
    faviconUrl = item.favicon || opts.favicon || TYPE_ICONS.url;
  } else {
    if (itemType === 'url') {
      title = extractTitle(item, item.content);
      subtitle = formatUrl(item.content);
      faviconUrl = item.favicon || opts.favicon || TYPE_ICONS.url;
    } else if (itemType === 'text') {
      title = item.title || (item.content || '').substring(0, 100) + ((item.content || '').length > 100 ? '...' : '');
      subtitle = noteUrl || '';
      faviconUrl = TYPE_ICONS.text;
    } else if (itemType === 'tagset') {
      title = 'Tag Set';
      subtitle = tags.length > 0 ? tags.map(t => t.name).join(', ') : 'Empty tagset';
      faviconUrl = TYPE_ICONS.tagset;
    } else if (itemType === 'image') {
      title = item.content || 'Image';
      subtitle = 'Image';
      faviconUrl = TYPE_ICONS.image;
    } else if (itemType === 'entity') {
      title = item.title || item.content || 'Entity';
      let entityMeta = {};
      try { entityMeta = JSON.parse(item.metadata || '{}'); } catch {}
      const entityKind = entityMeta.entityType ? entityMeta.entityType.replace('_', ' ') : 'entity';
      subtitle = entityKind.charAt(0).toUpperCase() + entityKind.slice(1);
      faviconUrl = TYPE_ICONS.entity;
    } else if (itemType === 'feed') {
      title = item.title || item.content || 'Feed';
      subtitle = 'Feed';
      faviconUrl = TYPE_ICONS.feed;
    } else if (itemType === 'series') {
      title = item.title || item.content || 'Series';
      subtitle = 'Series';
      faviconUrl = TYPE_ICONS.series;
    }
  }

  const itemUrl = isAddress ? item.uri : (itemType === 'url') ? item.content : noteUrl;

  return { tags, isAddress, itemType, noteUrl, title, subtitle, faviconUrl, itemUrl };
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
