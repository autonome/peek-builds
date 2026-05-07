/**
 * Peek Item Actions Component
 *
 * Renders a compact row of action icon-buttons for an item card.
 * The component itself is display-only — it emits events and lets
 * the consumer (feature renderer) own the actual API calls, keeping
 * this component free of any `window.app` dependency so it can be
 * used from any feature tile.
 *
 * @element peek-item-actions
 *
 * @prop {object}  item           - The item object ({ id, title, uri, content, ... })
 * @prop {boolean} showOpenInline - Show the "open inline" (peek page-host) button
 * @prop {boolean} showDelete     - Show the "delete" button
 *
 * @fires action-open-inline - User clicked the open-inline button.
 *   detail: { item, url } — url is item.uri || item.content
 * @fires action-delete      - User clicked the delete button.
 *   detail: { item }
 *
 * Both events bubble + composed so they cross shadow DOM boundaries.
 * Clicks do NOT propagate to the parent card (stopPropagation is called
 * internally so the card's card-click handler is not triggered).
 *
 * @example
 * <peek-item-actions
 *   .item=${myItem}
 *   show-open-inline
 *   show-delete
 *   @action-open-inline=${e => api.window.open(e.detail.url, {...})}
 *   @action-delete=${e => handleDelete(e.detail.item)}
 * ></peek-item-actions>
 */

import { html, css, nothing } from 'lit';
import { PeekElement, sharedStyles } from './base.js';

// ── SVG Icons ─────────────────────────────────────────────────────────────
// Heroicons-style, stroke-based, 16×16 viewport on a 24-unit grid.

// Open inline: external-link arrow (matches existing card-open-btn style)
const ICON_OPEN_INLINE = html`
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" stroke-width="2"
       stroke-linecap="round" stroke-linejoin="round"
       aria-hidden="true">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
    <polyline points="15 3 21 3 21 9"/>
    <line x1="10" y1="14" x2="21" y2="3"/>
  </svg>
`;

// Delete: trash-can (matches existing card-delete-btn style)
const ICON_DELETE = html`
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" stroke-width="2"
       stroke-linecap="round" stroke-linejoin="round"
       aria-hidden="true">
    <polyline points="3 6 5 6 21 6"/>
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
  </svg>
`;

export class PeekItemActions extends PeekElement {
  static properties = {
    item:           { type: Object },
    showOpenInline: { type: Boolean, reflect: true, attribute: 'show-open-inline' },
    showDelete:     { type: Boolean, reflect: true, attribute: 'show-delete' },
  };

  static styles = [
    sharedStyles,
    css`
      :host {
        display: inline-flex;
        align-items: center;
        gap: 2px;
      }

      .action-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        padding: 0;
        border: none;
        background: transparent;
        border-radius: var(--peek-radius-sm);
        color: var(--theme-text-muted, #999);
        cursor: pointer;
        transition: background var(--peek-transition-fast),
                    color var(--peek-transition-fast);
        flex-shrink: 0;
      }

      .action-btn:hover {
        background: var(--theme-bg-tertiary, rgba(0,0,0,0.08));
        color: var(--theme-text, #333);
      }

      .action-btn:active {
        background: var(--theme-bg-tertiary, rgba(0,0,0,0.12));
      }

      .action-btn:focus-visible {
        outline: none;
        box-shadow: var(--peek-focus-ring);
      }

      .action-btn.delete:hover {
        color: var(--theme-danger, #e53e3e);
        background: rgba(229, 62, 62, 0.08);
      }
    `
  ];

  constructor() {
    super();
    this.item = null;
    this.showOpenInline = false;
    this.showDelete = false;
  }

  _handleOpenInline(e) {
    e.stopPropagation();
    if (!this.item) return;
    const url = this.item.uri || this.item.content || '';
    this.emit('action-open-inline', { item: this.item, url });
  }

  _handleDelete(e) {
    e.stopPropagation();
    if (!this.item) return;
    this.emit('action-delete', { item: this.item });
  }

  render() {
    const url = this.item ? (this.item.uri || this.item.content || '') : '';
    const hasUrl = url.startsWith('http://') || url.startsWith('https://');

    return html`
      ${this.showOpenInline && hasUrl ? html`
        <button
          class="action-btn open-inline"
          title="Open in Peek"
          @click=${this._handleOpenInline}
        >${ICON_OPEN_INLINE}</button>
      ` : nothing}

      ${this.showDelete ? html`
        <button
          class="action-btn delete"
          title="Delete item"
          @click=${this._handleDelete}
        >${ICON_DELETE}</button>
      ` : nothing}
    `;
  }
}

customElements.define('peek-item-actions', PeekItemActions);

export default PeekItemActions;
