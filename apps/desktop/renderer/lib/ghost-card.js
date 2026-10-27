/**
 * ghost-card.js — the trailing "+" card that adds a new item to a card grid.
 *
 *   import { createGhostCard, GHOST_CARD_SELECTOR } from 'peek://app/lib/ghost-card.js';
 *   grid.appendChild(createGhostCard({ title: 'New sheet', onClick: addSheet }));
 *
 * One implementation for every grid that adds things (Sheets list, a sheet
 * window, Spaces, Groups). It is a `<peek-card>` marked `data-ghost`, so:
 *   - the window's dead-space double-click gesture treats it as a card
 *     (tile-preload.cts suppresses it for `peek-card`);
 *   - it is focusable, and Enter / Space activate it (peek-card does both);
 *   - peek-grid does not attach drag/resize to it in a freeform layout;
 *   - `isGhostCard()` lets callers keep it out of counts and sorting.
 *
 * The component needs `peek://app/components/peek-card.js` loaded by the page.
 * Its dashed look is injected once into the document, so a page needs no
 * stylesheet of its own.
 */

const STYLE_ID = 'peek-ghost-card-style';

const CSS = `
peek-card.ghost-card::part(card) {
  border-style: dashed;
  background: transparent;
  min-height: 80px;
  align-items: center;
  justify-content: center;
}
peek-card.ghost-card .ghost-plus {
  font-size: 32px;
  line-height: 1;
  text-align: center;
  color: var(--theme-text-muted, var(--base04, #999));
}
peek-card.ghost-card:hover .ghost-plus {
  color: var(--theme-accent, var(--base0D, #007aff));
}
peek-card.ghost-card .ghost-label {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
`;

export const GHOST_CARD_SELECTOR = 'peek-card[data-ghost]';

/** True for a card made by createGhostCard. */
export const isGhostCard = (el) => !!el && el.hasAttribute?.('data-ghost');

const ensureStyle = () => {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
};

/**
 * @param {object} opts
 * @param {string} [opts.title] tooltip and accessible name ("New sheet")
 * @param {() => void} [opts.onClick] called on click, Enter or Space
 */
export const createGhostCard = ({ title, onClick } = {}) => {
  ensureStyle();
  const label = title || 'New';
  const card = document.createElement('peek-card');
  card.className = 'ghost-card';
  card.dataset.ghost = '';
  card.interactive = true;
  card.draggable = false;
  card.title = label;
  card.setAttribute('aria-label', label);

  const plus = document.createElement('div');
  plus.className = 'ghost-plus';
  plus.setAttribute('aria-hidden', 'true');
  plus.textContent = '+';
  card.appendChild(plus);

  // The inner button takes its accessible name from its content.
  const text = document.createElement('span');
  text.className = 'ghost-label';
  text.textContent = label;
  card.appendChild(text);

  if (onClick) card.addEventListener('card-click', () => onClick());
  return card;
};
