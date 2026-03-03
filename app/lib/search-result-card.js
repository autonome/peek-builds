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
  getItemDisplayInfo
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

/**
 * Create a fully-built peek-card element for an item.
 *
 * @param {object} item - Item object with at least { id, type, content, title, metadata }
 * @param {object} [opts] - Options for customizing the card
 * @param {Array}  [opts.tags] - Tag objects for this item (used for display and affordances)
 * @param {boolean} [opts.showOpenButton] - Show an open-in-new-window button for URL items (default: false)
 * @param {function} [opts.onTagClick] - Called with (tag, event) when a tag chip is clicked
 * @param {function} [opts.onOpen] - Called with (url) when the open button is clicked
 * @param {function} [opts.onClick] - Called with (item, event) on card-click (overrides default)
 * @param {object}  [opts.affordances] - { rules, api, onToggle } for tag action affordances
 * @param {boolean} [opts.selected] - Whether the card starts in selected state
 * @param {boolean} [opts.interactive] - Whether the card is interactive (default: true)
 * @param {boolean} [opts.elevated] - Whether the card is elevated (default: false)
 * @param {string}  [opts.className] - Additional CSS class for the card element
 * @param {string}  [opts.favicon] - Explicit favicon URL (passed to getItemDisplayInfo)
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

  const { title, subtitle, faviconUrl, itemUrl, itemType } = getItemDisplayInfo(item, displayOpts);

  // ── Header slot: favicon + title + optional open button ──────────
  const favicon = createFaviconEl(faviconUrl);
  const header = createHeaderSlot(favicon, title);

  if (opts.showOpenButton && itemUrl) {
    const openBtn = document.createElement('button');
    openBtn.className = 'card-open-btn';
    openBtn.title = 'Open page';
    openBtn.innerHTML = OPEN_BUTTON_SVG;
    openBtn.style.flexShrink = '0';
    openBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (opts.onOpen) {
        opts.onOpen(itemUrl);
      }
    });
    header.appendChild(openBtn);
  }

  card.appendChild(header);

  // ── Footer slot: URL/subtitle on left, tags + affordances + visit count on right ──
  const urlEl = subtitle ? createUrlSpan(subtitle) : null;

  const footerRight = document.createElement('span');
  footerRight.style.cssText = 'display:flex;align-items:center;gap:6px;flex-shrink:0;';

  // Tag action affordances (icon badges, toggle checkboxes)
  if (opts.affordances && opts.affordances.rules && opts.affordances.rules.length > 0 && tags.length > 0) {
    const tagNames = tags.map(t => t.name);
    const el = createAffordanceElements(
      item.id, tagNames, opts.affordances.rules, opts.affordances.api, {
        onToggle: opts.affordances.onToggle || (() => {})
      }
    );
    if (el) footerRight.appendChild(el);
  }

  // Tag chips
  if (tags.length > 0) {
    const tagsContainer = document.createElement('span');
    tagsContainer.className = 'card-tags';
    tagsContainer.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;flex-shrink:0;';
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
      tagsContainer.appendChild(chip);
    });
    footerRight.appendChild(tagsContainer);
  }

  // Visit count
  const visitCount = opts.visitCount || item.visitCount || 0;
  if (visitCount > 0) {
    const visitSpan = document.createElement('span');
    visitSpan.textContent = `${visitCount} ${visitCount === 1 ? 'visit' : 'visits'}`;
    visitSpan.style.flexShrink = '0';
    footerRight.appendChild(visitSpan);
  }

  // Only add footer right if it has children
  const hasFooterRight = footerRight.children.length > 0;
  card.appendChild(createFooterSlot(urlEl, hasFooterRight ? footerRight : null));

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
