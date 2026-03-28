/**
 * Shared search-result card builder for peek-card elements.
 *
 * Single source of truth for item card rendering across all extensions
 * (tags, search, lists, pagestream, groups). Each extension keeps
 * its own data fetching, filtering, and layout — only the card DOM
 * creation is shared here.
 *
 * Builds on existing card-helpers.js utilities (getItemDisplayInfo,
 * createHeaderSlot, createFooterSlot, createFaviconEl, createUrlSpan).
 */

import {
  createHeaderSlot, createFooterSlot, createFaviconEl, createUrlSpan,
  formatUrl, getItemDisplayInfo
} from 'peek://app/lib/card-helpers.js';
import {
  createAffordanceElements
} from 'peek://app/lib/tag-action-affordances.js';

// Open button SVG icon (external link)
const OPEN_BUTTON_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>' +
  '<polyline points="15 3 21 3 21 9"></polyline>' +
  '<line x1="10" y1="14" x2="21" y2="3"></line>' +
  '</svg>';

// Delete button SVG icon (trash can)
const DELETE_BUTTON_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<polyline points="3 6 5 6 21 6"></polyline>' +
  '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>' +
  '</svg>';

/**
 * Create a fully-built peek-card element for an item.
 *
 * @param {object} item - Item object with at least { id, type, content, title, metadata }
 * @param {object} [opts] - Options for customizing the card
 * @param {Array}  [opts.tags] - Tag objects for this item (used for display and affordances)
 * @param {boolean} [opts.showOpenButton] - Show an open-in-new-window button for URL items (default: false)
 * @param {function} [opts.onTagClick] - Called with (tag, event) when a tag chip is clicked
 * @param {function} [opts.onTagRemove] - Called with (item, tag) when a tag remove x is clicked (no confirm)
 * @param {function} [opts.onOpen] - Called with (url) when the open button is clicked
 * @param {function} [opts.onDelete] - Called with (item) when the delete button is clicked (should confirm)
 * @param {function} [opts.onClick] - Called with (item, event) on card-click (overrides default)
 * @param {object}  [opts.affordances] - { rules, api, onToggle } for tag action affordances
 * @param {boolean} [opts.selected] - Whether the card starts in selected state
 * @param {boolean} [opts.interactive] - Whether the card is interactive (default: true)
 * @param {boolean} [opts.elevated] - Whether the card is elevated (default: false)
 * @param {string}  [opts.className] - Additional CSS class for the card element
 * @param {string}  [opts.favicon] - Explicit favicon URL (passed to getItemDisplayInfo)
 * @param {string}  [opts.thumbnailHash] - Thumbnail hash for page screenshot (overrides item.thumbnail)
 * @param {number}  [opts.visitCount] - Visit count to display in footer
 * @returns {HTMLElement} peek-card element with header, footer slots populated
 */
export const createSearchResultCard = (item, opts = {}) => {
  const card = document.createElement('peek-card');
  card.interactive = opts.interactive !== false;
  if (opts.elevated) card.elevated = true;
  if (opts.selected) card.selected = true;
  if (opts.className) card.className = opts.className;
  card.dataset.itemId = item.id;

  const tags = opts.tags || [];
  const displayOpts = {};
  if (tags.length > 0) displayOpts.tags = tags;
  if (opts.favicon) displayOpts.favicon = opts.favicon;

  const { title, subtitle, faviconUrl, itemUrl, itemType, isAddress, thumbnailHash } = getItemDisplayInfo(item, displayOpts);
  const effectiveThumbnailHash = opts.thumbnailHash || thumbnailHash;

  // ── Header slot: favicon + title + button group ──────────
  const favicon = createFaviconEl(faviconUrl);
  const header = createHeaderSlot(favicon, title);

  // Collect action buttons into a grouped container
  const hasOpenBtn = opts.showOpenButton && itemUrl;
  const hasDeleteBtn = !!opts.onDelete;

  if (hasOpenBtn || hasDeleteBtn) {
    const btnGroup = document.createElement('span');
    btnGroup.className = 'card-btn-group';

    if (hasOpenBtn) {
      const openBtn = document.createElement('button');
      openBtn.className = 'card-open-btn';
      openBtn.title = 'Open page';
      openBtn.innerHTML = OPEN_BUTTON_SVG;
      openBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (opts.onOpen) {
          opts.onOpen(itemUrl);
        }
      });
      btnGroup.appendChild(openBtn);
    }

    if (hasDeleteBtn) {
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'card-delete-btn';
      deleteBtn.title = 'Delete item';
      deleteBtn.innerHTML = DELETE_BUTTON_SVG;
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        opts.onDelete(item);
      });
      btnGroup.appendChild(deleteBtn);
    }

    header.appendChild(btnGroup);
  }

  card.appendChild(header);

  // ── URL row (body slot): show URL between header and footer for items with URLs ──
  if (itemUrl) {
    const urlRow = document.createElement('div');
    urlRow.className = 'card-url-row';
    const urlSpan = createUrlSpan(formatUrl(itemUrl));
    urlRow.appendChild(urlSpan);
    card.appendChild(urlRow);
  }

  // ── Thumbnail (media slot): page screenshot background ──
  if (effectiveThumbnailHash) {
    const img = document.createElement('img');
    img.slot = 'media';
    img.src = `peek://thumbnail/${effectiveThumbnailHash}`;
    img.loading = 'lazy';
    img.className = 'card-thumbnail';
    img.onerror = () => {
      img.style.display = 'none';
      img.onerror = null;
    };
    card.appendChild(img);
  }

  // ── Footer slot: affordances on left, tags + visit count on right ──
  const footerLeft = document.createElement('span');
  footerLeft.style.cssText = 'display:flex;align-items:center;gap:6px;flex-shrink:0;';

  // Tag action affordances (icon badges, toggle checkboxes) — bottom left
  if (opts.affordances && opts.affordances.rules && opts.affordances.rules.length > 0 && tags.length > 0) {
    const tagNames = tags.map(t => t.name);
    const el = createAffordanceElements(
      item.id, tagNames, opts.affordances.rules, opts.affordances.api, {
        onToggle: opts.affordances.onToggle || (() => {})
      }
    );
    if (el) footerLeft.appendChild(el);
  }

  // Visit count — bottom left after affordances
  const visitCount = opts.visitCount || item.visitCount || 0;
  if (visitCount > 0) {
    const visitSpan = document.createElement('span');
    visitSpan.textContent = `${visitCount} ${visitCount === 1 ? 'visit' : 'visits'}`;
    visitSpan.style.flexShrink = '0';
    footerLeft.appendChild(visitSpan);
  }

  // For non-URL items that have a subtitle (e.g. entity type), show it on the left
  if (subtitle && !itemUrl) {
    const subtitleEl = createUrlSpan(subtitle);
    footerLeft.appendChild(subtitleEl);
  }

  const footerRight = document.createElement('span');
  footerRight.style.cssText = 'display:flex;align-items:center;gap:6px;flex-shrink:0;margin-left:auto;';

  // Tag chips — right-aligned
  if (tags.length > 0) {
    const tagsContainer = document.createElement('span');
    tagsContainer.className = 'card-tags';
    tagsContainer.style.cssText = 'display:flex;gap:3px;flex-wrap:wrap;flex-shrink:0;';
    tags.forEach(tag => {
      const chip = document.createElement('span');
      chip.className = 'card-tag';
      chip.dataset.tagId = tag.id;
      chip.textContent = tag.name;
      if (opts.onTagClick) {
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          opts.onTagClick(tag, e);
        });
      }
      if (opts.onTagRemove) {
        const removeBtn = document.createElement('span');
        removeBtn.className = 'card-tag-remove';
        removeBtn.textContent = '\u00D7';
        removeBtn.title = `Remove ${tag.name}`;
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          // Optimistic removal: hide chip immediately for instant visual feedback
          chip.remove();
          opts.onTagRemove(item, tag);
        });
        chip.appendChild(removeBtn);
      }
      tagsContainer.appendChild(chip);
    });
    footerRight.appendChild(tagsContainer);
  }

  // Only add footer if there's content
  const hasFooterLeft = footerLeft.children.length > 0;
  const hasFooterRight = footerRight.children.length > 0;
  if (hasFooterLeft || hasFooterRight) {
    card.appendChild(createFooterSlot(
      hasFooterLeft ? footerLeft : null,
      hasFooterRight ? footerRight : null
    ));
  }

  // ── Click handler ────────────────────────────────────────────────
  if (opts.onClick) {
    let isOpening = false;
    card.addEventListener('card-click', async (e) => {
      if (isOpening) return;
      isOpening = true;
      try {
        await opts.onClick(item, e);
      } finally {
        setTimeout(() => { isOpening = false; }, 500);
      }
    });
  }

  return card;
};
