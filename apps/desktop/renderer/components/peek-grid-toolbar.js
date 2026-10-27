/**
 * Peek Grid Toolbar Component
 *
 * A compact toolbar for controlling grid sort order and view modes.
 * Designed to sit above a peek-grid and emit events for sort/view changes.
 *
 * @element peek-grid-toolbar
 *
 * @prop {string} viewMode - 'fit' | 'columns' | 'list' | 'masonry' | 'freeform', default 'columns'
 * @prop {Array} viewModes - Which view-mode buttons to offer; defaults to all five
 * @prop {boolean} freeformEditing - Whether freeform edit mode is active
 * @prop {string} sortBy - Current sort key
 * @prop {string} sortDirection - 'asc' | 'desc'
 * @prop {Array} sortOptions - [{value, label}]
 *
 * @fires view-mode-change - When view mode changes. Detail: { mode }
 * @fires sort-change - When sort changes. Detail: { sortBy, sortDirection }
 * @fires freeform-editing-change - When freeform edit toggle changes. Detail: { editing }
 */

import { html, css } from 'lit';
import { PeekElement, sharedStyles } from './base.js';

export class PeekGridToolbar extends PeekElement {
  static properties = {
    viewMode: { type: String, attribute: 'view-mode', reflect: true },
    sortBy: { type: String, attribute: 'sort-by' },
    sortDirection: { type: String, attribute: 'sort-direction' },
    sortOptions: { type: Array },
    // Which view-mode buttons to offer, in render order. Defaults to all
    // modes (backward-compatible). Consumers can narrow this — e.g. the tags
    // feature omits 'fit' because fit packs every item into one no-scroll
    // viewport, which collapses to invisible sub-pixel cards on large sets.
    viewModes: { type: Array },
    freeformEditing: { type: Boolean, attribute: 'freeform-editing', reflect: true }
  };

  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
        /* Empty toolbar space is dead space for the window double-click; a
           double-click there must not select the dropdown's text. */
        user-select: none;
        -webkit-user-select: none;
      }

      .toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--peek-space-sm);
        padding: var(--peek-space-xs) 0;
      }

      .toolbar-left {
        display: flex;
        align-items: center;
        gap: var(--peek-space-xs);
      }

      .toolbar-right {
        display: flex;
        align-items: center;
        gap: 2px;
      }

      /* Sort select */
      .sort-select {
        height: var(--peek-btn-height-sm, 28px);
        padding: 0 var(--peek-space-xl) 0 var(--peek-space-sm);
        font: inherit;
        font-size: var(--peek-font-xs);
        color: var(--theme-text, #333);
        background: var(--theme-bg-secondary, #fff);
        border: 1px solid var(--theme-border, #e0e0e0);
        border-radius: var(--peek-radius-sm);
        cursor: pointer;
        appearance: none;
        outline: none;
        transition: border-color var(--peek-transition-fast);
      }

      .sort-select:focus {
        border-color: var(--theme-accent, #007aff);
      }

      .sort-wrapper {
        position: relative;
        display: flex;
        align-items: center;
      }

      .sort-arrow {
        position: absolute;
        right: 6px;
        pointer-events: none;
        color: var(--theme-text-muted, #999);
      }

      /* Direction toggle */
      .dir-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: var(--peek-btn-height-sm, 28px);
        height: var(--peek-btn-height-sm, 28px);
        padding: 0;
        border: 1px solid var(--theme-border, #e0e0e0);
        border-radius: var(--peek-radius-sm);
        background: var(--theme-bg-secondary, #fff);
        color: var(--theme-text, #333);
        cursor: pointer;
        font-size: var(--peek-font-sm);
        transition: background var(--peek-transition-fast), color var(--peek-transition-fast);
      }

      .dir-btn:hover {
        background: var(--theme-bg-tertiary, #f5f5f5);
      }

      .dir-btn:focus-visible {
        outline: 2px solid var(--theme-accent, #007aff);
        outline-offset: -2px;
      }

      /* View mode buttons */
      .view-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: var(--peek-btn-height-sm, 28px);
        height: var(--peek-btn-height-sm, 28px);
        padding: 0;
        border: 1px solid transparent;
        border-radius: var(--peek-radius-sm);
        background: transparent;
        color: var(--theme-text-muted, #999);
        cursor: pointer;
        transition: background var(--peek-transition-fast), color var(--peek-transition-fast);
      }

      .view-btn:hover {
        background: var(--theme-bg-tertiary, #f5f5f5);
        color: var(--theme-text, #333);
      }

      .view-btn:focus-visible {
        outline: 2px solid var(--theme-accent, #007aff);
        outline-offset: -2px;
      }

      .view-btn.active {
        background: var(--theme-accent, #007aff);
        color: #fff;
        border-color: var(--theme-accent, #007aff);
      }

      .edit-toggle {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: var(--peek-btn-height-sm, 28px);
        height: var(--peek-btn-height-sm, 28px);
        padding: 0;
        margin-left: 4px;
        border: 1px solid var(--theme-border, #e0e0e0);
        border-radius: var(--peek-radius-sm);
        background: var(--theme-bg-secondary, #fff);
        color: var(--theme-text-muted, #999);
        cursor: pointer;
        transition: background var(--peek-transition-fast), color var(--peek-transition-fast);
      }

      .edit-toggle:hover {
        background: var(--theme-bg-tertiary, #f5f5f5);
        color: var(--theme-text, #333);
      }

      .edit-toggle.active {
        background: var(--theme-accent, #007aff);
        color: #fff;
        border-color: var(--theme-accent, #007aff);
      }
    `
  ];

  constructor() {
    super();
    this.viewMode = 'columns';
    this.sortBy = '';
    this.sortDirection = 'asc';
    this.sortOptions = [];
    this.viewModes = ['fit', 'columns', 'list', 'masonry', 'freeform'];
    this.freeformEditing = false;
  }

  _handleSortChange(e) {
    this.sortBy = e.target.value;
    this.emit('sort-change', { sortBy: this.sortBy, sortDirection: this.sortDirection });
  }

  _handleDirectionToggle() {
    this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
    this.emit('sort-change', { sortBy: this.sortBy, sortDirection: this.sortDirection });
  }

  _handleViewMode(mode) {
    this.viewMode = mode;
    this.emit('view-mode-change', { mode });
  }

  _handleEditToggle() {
    this.freeformEditing = !this.freeformEditing;
    this.emit('freeform-editing-change', { editing: this.freeformEditing });
  }

  render() {
    return html`
      <div class="toolbar">
        <div class="toolbar-left">
          <div class="sort-wrapper">
            <select
              class="sort-select"
              .value=${this.sortBy}
              @change=${this._handleSortChange}
            >
              ${this.sortOptions.map(opt => html`
                <option value=${opt.value} ?selected=${opt.value === this.sortBy}>${opt.label}</option>
              `)}
            </select>
            <svg class="sort-arrow" width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M2.5 3.75L5 6.25L7.5 3.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <button
            class="dir-btn"
            title=${this.sortDirection === 'asc' ? 'Ascending' : 'Descending'}
            @click=${this._handleDirectionToggle}
          >
            ${this.sortDirection === 'asc'
              ? html`<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 11V3M7 3L4 6M7 3L10 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`
              : html`<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 3V11M7 11L4 8M7 11L10 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`
            }
          </button>
        </div>
        <div class="toolbar-right">
          ${this.viewModes.includes('fit') ? html`
          <button
            class="view-btn ${this.viewMode === 'fit' ? 'active' : ''}"
            title="Fit view (no scroll, all cards visible)"
            @click=${() => this._handleViewMode('fit')}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="1" y="1" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.5"/>
              <rect x="8" y="1" width="5" height="3" rx="1" stroke="currentColor" stroke-width="1.5"/>
              <rect x="8" y="5" width="5" height="3" rx="1" stroke="currentColor" stroke-width="1.5"/>
              <rect x="1" y="8" width="3" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/>
              <rect x="5" y="9" width="3" height="4" rx="1" stroke="currentColor" stroke-width="1.5"/>
              <rect x="9" y="9" width="4" height="4" rx="1" stroke="currentColor" stroke-width="1.5"/>
            </svg>
          </button>
          ` : ''}
          <button
            class="view-btn ${this.viewMode === 'columns' ? 'active' : ''}"
            title="Grid view"
            @click=${() => this._handleViewMode('columns')}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="1" y="1" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/>
              <rect x="8" y="1" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/>
              <rect x="1" y="8" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/>
              <rect x="8" y="8" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/>
            </svg>
          </button>
          <button
            class="view-btn ${this.viewMode === 'list' ? 'active' : ''}"
            title="List view"
            @click=${() => this._handleViewMode('list')}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <line x1="1" y1="3" x2="13" y2="3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              <line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              <line x1="1" y1="11" x2="13" y2="11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </button>
          <button
            class="view-btn ${this.viewMode === 'masonry' ? 'active' : ''}"
            title="Masonry view"
            @click=${() => this._handleViewMode('masonry')}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="1" y="1" width="5" height="7" rx="1" stroke="currentColor" stroke-width="1.5"/>
              <rect x="8" y="1" width="5" height="4" rx="1" stroke="currentColor" stroke-width="1.5"/>
              <rect x="1" y="10" width="5" height="3" rx="1" stroke="currentColor" stroke-width="1.5"/>
              <rect x="8" y="7" width="5" height="6" rx="1" stroke="currentColor" stroke-width="1.5"/>
            </svg>
          </button>
          <button
            class="view-btn ${this.viewMode === 'freeform' ? 'active' : ''}"
            title="Freeform view"
            @click=${() => this._handleViewMode('freeform')}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="1" y="1" width="4" height="3" rx="0.5" stroke="currentColor" stroke-width="1.5"/>
              <rect x="7" y="2" width="6" height="4" rx="0.5" stroke="currentColor" stroke-width="1.5"/>
              <rect x="2" y="6" width="5" height="4" rx="0.5" stroke="currentColor" stroke-width="1.5"/>
              <rect x="9" y="8" width="4" height="5" rx="0.5" stroke="currentColor" stroke-width="1.5"/>
            </svg>
          </button>
          ${this.viewMode === 'freeform' ? html`
            <button
              class="edit-toggle ${this.freeformEditing ? 'active' : ''}"
              title="${this.freeformEditing ? 'Exit edit mode' : 'Edit layout'}"
              @click=${this._handleEditToggle}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M10.5 1.5L12.5 3.5L4.5 11.5L1.5 12.5L2.5 9.5L10.5 1.5Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
          ` : ''}
        </div>
      </div>
    `;
  }
}

customElements.define('peek-grid-toolbar', PeekGridToolbar);

export default PeekGridToolbar;
