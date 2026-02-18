/**
 * Peek Grid Component
 *
 * A responsive CSS Grid layout container with auto-fit behavior.
 * Items automatically flow into available columns based on min-width.
 *
 * @element peek-grid
 *
 * @prop {number} minItemWidth - Minimum item width in pixels (default: 250)
 * @prop {number} gap - Gap between items in pixels (default: 16)
 * @prop {number} columns - Fixed column count (overrides auto-fit if set)
 * @prop {string} align - Item alignment: 'start' | 'center' | 'end' | 'stretch'
 * @prop {boolean} dense - Enable dense packing algorithm
 * @prop {boolean} overlay - Optimize spacing for overlay contexts
 * @prop {string} viewMode - Layout mode: 'columns' | 'list' | 'masonry' | 'freeform'
 * @prop {Object} freeformLayout - Map of item id → {x, y, w, h} bounds
 * @prop {boolean} freeformEditing - Toggle edit mode for freeform layout
 * @prop {number} freeformSnap - Snap grid in px (default 20, 0 = off)
 *
 * @slot - Default slot for grid items
 *
 * @csspart grid - The grid container
 *
 * @cssprop --peek-grid-min-item-width - Minimum item width
 * @cssprop --peek-grid-gap - Gap between items
 * @cssprop --peek-grid-columns - Fixed column count
 *
 * @example
 * <peek-grid min-item-width="300" gap="20">
 *   <peek-card>Item 1</peek-card>
 *   <peek-card>Item 2</peek-card>
 *   <peek-card>Item 3</peek-card>
 * </peek-grid>
 */

import { html, css } from 'lit';
import { PeekElement, sharedStyles } from './base.js';

export class PeekGrid extends PeekElement {
  static properties = {
    minItemWidth: { type: Number, attribute: 'min-item-width' },
    gap: { type: Number },
    columns: { type: Number },
    align: { type: String, reflect: true },
    dense: { type: Boolean },
    overlay: { type: Boolean, reflect: true },
    viewMode: { type: String, attribute: 'view-mode', reflect: true },
    freeformLayout: { type: Object, attribute: false },
    freeformEditing: { type: Boolean, attribute: 'freeform-editing', reflect: true },
    freeformSnap: { type: Number, attribute: 'freeform-snap' }
  };

  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }

      .grid {
        display: grid;
        grid-template-columns: var(--_grid-columns);
        gap: var(--_grid-gap);
        align-items: var(--_grid-align, stretch);
      }

      :host([dense]) .grid {
        grid-auto-flow: dense;
      }

      /* Overlay mode - optimized for transparent overlays */
      :host([overlay]) {
        padding: var(--peek-space-2xl, 32px);
      }

      :host([overlay]) .grid {
        max-width: 1800px;
        margin: 0 auto;
      }

      /* Slot styling for items */
      ::slotted(*) {
        min-width: 0; /* Prevent overflow */
      }

      /* List view mode - single column */
      :host([view-mode="list"]) .grid {
        grid-template-columns: 1fr;
      }

      /* Masonry view mode - CSS columns layout */
      :host([view-mode="masonry"]) .grid {
        display: block;
        columns: var(--_masonry-columns, 3);
        column-gap: var(--_grid-gap);
      }

      :host([view-mode="masonry"]) ::slotted(*) {
        break-inside: avoid;
        margin-bottom: var(--_grid-gap);
      }

      /* Freeform mode — container relative, items absolute */
      :host([view-mode="freeform"]) .grid {
        display: block;
        position: relative;
        min-height: 400px;
      }

      :host([view-mode="freeform"]) ::slotted(*) {
        position: absolute;
        box-sizing: border-box;
      }

      /* Edit mode — visual affordance */
      :host([view-mode="freeform"][freeform-editing]) ::slotted(*) {
        cursor: move;
        outline: 1px dashed var(--peek-border, #ccc);
        outline-offset: 2px;
        user-select: none;
      }

      :host([view-mode="freeform"][freeform-editing]) ::slotted(*:hover) {
        outline-color: var(--peek-accent, #007aff);
      }
    `
  ];

  constructor() {
    super();
    this.minItemWidth = 250;
    this.gap = 16;
    this.columns = null;
    this.align = 'stretch';
    this.dense = false;
    this.overlay = false;
    this.viewMode = 'columns';
    this.freeformLayout = {};
    this.freeformEditing = false;
    this.freeformSnap = 20;
    this._resizeObserver = null;
    this._dragState = null;
    this._boundPointerMove = this._onPointerMove.bind(this);
    this._boundPointerUp = this._onPointerUp.bind(this);
  }

  connectedCallback() {
    super.connectedCallback();
    this._resizeObserver = new ResizeObserver(() => {
      if (this.viewMode === 'masonry' || this.viewMode === 'freeform') {
        this.requestUpdate();
      }
    });
    this._resizeObserver.observe(this);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    this._cleanupFreeformListeners();
  }

  updated(changedProps) {
    super.updated?.(changedProps);

    const wasFreeform = changedProps.has('viewMode') && changedProps.get('viewMode') === 'freeform';
    const isFreeform = this.viewMode === 'freeform';

    // Clean up when leaving freeform
    if (wasFreeform && !isFreeform) {
      this._clearFreeformStyles();
      this._cleanupFreeformListeners();
      return;
    }

    if (isFreeform) {
      this._applyFreeformPositions();
      if (this.freeformEditing) {
        this._attachEditListeners();
      } else {
        this._cleanupFreeformListeners();
      }
    }
  }

  // --- Freeform: positioning ---

  _getSlottedChildren() {
    const slot = this.shadowRoot?.querySelector('slot');
    return slot ? slot.assignedElements() : [];
  }

  _getChildId(el) {
    return el.id || el.dataset?.id || null;
  }

  _snap(value) {
    if (!this.freeformSnap) return value;
    return Math.round(value / this.freeformSnap) * this.freeformSnap;
  }

  _applyFreeformPositions() {
    const children = this._getSlottedChildren();
    const containerWidth = this.clientWidth || 600;
    const gap = this.gap;
    const itemW = Math.min(300, Math.max(200, Math.floor(containerWidth / 3) - gap));
    const itemH = 200;
    const cols = Math.max(1, Math.floor(containerWidth / (itemW + gap)));
    let autoIndex = 0;
    let maxBottom = 400;

    for (const child of children) {
      const id = this._getChildId(child);
      let bounds = id && this.freeformLayout?.[id];

      if (!bounds) {
        // Auto-place in grid pattern
        const col = autoIndex % cols;
        const row = Math.floor(autoIndex / cols);
        bounds = {
          x: col * (itemW + gap),
          y: row * (itemH + gap),
          w: itemW,
          h: itemH
        };
        autoIndex++;
      }

      child.style.position = 'absolute';
      child.style.left = `${bounds.x}px`;
      child.style.top = `${bounds.y}px`;
      child.style.width = `${bounds.w}px`;
      child.style.height = `${bounds.h}px`;
      child.style.boxSizing = 'border-box';

      maxBottom = Math.max(maxBottom, bounds.y + bounds.h + gap);
    }

    // Set container min-height
    const grid = this.shadowRoot?.querySelector('.grid');
    if (grid) grid.style.minHeight = `${maxBottom}px`;
  }

  _clearFreeformStyles() {
    const children = this._getSlottedChildren();
    for (const child of children) {
      child.style.position = '';
      child.style.left = '';
      child.style.top = '';
      child.style.width = '';
      child.style.height = '';
      child.style.boxSizing = '';
      child.style.cursor = '';
    }
    const grid = this.shadowRoot?.querySelector('.grid');
    if (grid) grid.style.minHeight = '';
  }

  // --- Freeform: edit mode listeners ---

  _attachEditListeners() {
    const children = this._getSlottedChildren();
    for (const child of children) {
      if (!child._peekFreeformDown) {
        child._peekFreeformDown = (e) => this._onChildPointerDown(child, e);
        child._peekFreeformMove = (e) => this._onChildHoverMove(child, e);
        child.addEventListener('pointerdown', child._peekFreeformDown);
        child.addEventListener('pointermove', child._peekFreeformMove);
      }
    }
  }

  _cleanupFreeformListeners() {
    const children = this._getSlottedChildren();
    for (const child of children) {
      if (child._peekFreeformDown) {
        child.removeEventListener('pointerdown', child._peekFreeformDown);
        child.removeEventListener('pointermove', child._peekFreeformMove);
        delete child._peekFreeformDown;
        delete child._peekFreeformMove;
        child.style.cursor = '';
      }
    }
  }

  // --- Freeform: edge detection ---

  _detectEdge(el, e) {
    const rect = el.getBoundingClientRect();
    const t = 8; // threshold px
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const w = rect.width;
    const h = rect.height;

    const nearLeft = x < t;
    const nearRight = x > w - t;
    const nearTop = y < t;
    const nearBottom = y > h - t;

    if (nearTop && nearLeft) return 'nw';
    if (nearTop && nearRight) return 'ne';
    if (nearBottom && nearLeft) return 'sw';
    if (nearBottom && nearRight) return 'se';
    if (nearLeft) return 'w';
    if (nearRight) return 'e';
    if (nearTop) return 'n';
    if (nearBottom) return 's';
    return 'move';
  }

  _cursorForEdge(edge) {
    const map = {
      n: 'ns-resize', s: 'ns-resize',
      e: 'ew-resize', w: 'ew-resize',
      ne: 'nesw-resize', sw: 'nesw-resize',
      nw: 'nwse-resize', se: 'nwse-resize',
      move: 'move'
    };
    return map[edge] || 'move';
  }

  _onChildHoverMove(child, e) {
    if (!this.freeformEditing || this._dragState) return;
    const edge = this._detectEdge(child, e);
    child.style.cursor = this._cursorForEdge(edge);
  }

  // --- Freeform: drag/resize ---

  _onChildPointerDown(child, e) {
    if (!this.freeformEditing) return;
    e.preventDefault();
    e.stopPropagation();

    const edge = this._detectEdge(child, e);
    const rect = child.getBoundingClientRect();

    this._dragState = {
      child,
      edge,
      startX: e.clientX,
      startY: e.clientY,
      origLeft: parseFloat(child.style.left) || 0,
      origTop: parseFloat(child.style.top) || 0,
      origWidth: rect.width,
      origHeight: rect.height
    };

    child.setPointerCapture(e.pointerId);
    child.addEventListener('pointermove', this._boundPointerMove);
    child.addEventListener('pointerup', this._boundPointerUp);
  }

  _onPointerMove(e) {
    const s = this._dragState;
    if (!s) return;
    e.preventDefault();

    const dx = e.clientX - s.startX;
    const dy = e.clientY - s.startY;
    const minW = 100;
    const minH = 60;

    if (s.edge === 'move') {
      s.child.style.left = `${this._snap(s.origLeft + dx)}px`;
      s.child.style.top = `${this._snap(s.origTop + dy)}px`;
      return;
    }

    // Resize
    let newLeft = s.origLeft;
    let newTop = s.origTop;
    let newW = s.origWidth;
    let newH = s.origHeight;

    if (s.edge.includes('e')) newW = Math.max(minW, s.origWidth + dx);
    if (s.edge.includes('w')) {
      newW = Math.max(minW, s.origWidth - dx);
      newLeft = s.origLeft + (s.origWidth - newW);
    }
    if (s.edge.includes('s')) newH = Math.max(minH, s.origHeight + dy);
    if (s.edge.includes('n')) {
      newH = Math.max(minH, s.origHeight - dy);
      newTop = s.origTop + (s.origHeight - newH);
    }

    s.child.style.left = `${this._snap(newLeft)}px`;
    s.child.style.top = `${this._snap(newTop)}px`;
    s.child.style.width = `${this._snap(newW)}px`;
    s.child.style.height = `${this._snap(newH)}px`;
  }

  _onPointerUp(e) {
    const s = this._dragState;
    if (!s) return;

    s.child.releasePointerCapture(e.pointerId);
    s.child.removeEventListener('pointermove', this._boundPointerMove);
    s.child.removeEventListener('pointerup', this._boundPointerUp);

    const id = this._getChildId(s.child);
    const bounds = {
      x: parseFloat(s.child.style.left) || 0,
      y: parseFloat(s.child.style.top) || 0,
      w: parseFloat(s.child.style.width) || s.origWidth,
      h: parseFloat(s.child.style.height) || s.origHeight
    };

    if (id) {
      this.freeformLayout = { ...this.freeformLayout, [id]: bounds };
    }

    this.emit('freeform-layout-change', { layout: this.freeformLayout, itemId: id, bounds });
    this._dragState = null;

    // Update container min-height
    this._updateContainerHeight();
  }

  _updateContainerHeight() {
    const children = this._getSlottedChildren();
    let maxBottom = 400;
    for (const child of children) {
      const top = parseFloat(child.style.top) || 0;
      const height = parseFloat(child.style.height) || 0;
      maxBottom = Math.max(maxBottom, top + height + this.gap);
    }
    const grid = this.shadowRoot?.querySelector('.grid');
    if (grid) grid.style.minHeight = `${maxBottom}px`;
  }

  _onSlotChange() {
    if (this.viewMode === 'freeform') {
      this._applyFreeformPositions();
      if (this.freeformEditing) this._attachEditListeners();
    }
  }

  _getMasonryColumns() {
    const width = this.clientWidth || 300;
    return Math.max(1, Math.floor(width / this.minItemWidth));
  }

  _getGridColumns() {
    if (this.columns) {
      return `repeat(${this.columns}, 1fr)`;
    }
    const minWidth = this.minItemWidth;
    return `repeat(auto-fit, minmax(min(${minWidth}px, 100%), 1fr))`;
  }

  _getAlignValue() {
    const alignMap = {
      start: 'start',
      center: 'center',
      end: 'end',
      stretch: 'stretch'
    };
    return alignMap[this.align] || 'stretch';
  }

  render() {
    const gridColumns = this._getGridColumns();
    const alignItems = this._getAlignValue();
    const masonryColumns = this.viewMode === 'masonry' ? this._getMasonryColumns() : 3;

    return html`
      <div
        part="grid"
        class="grid"
        style="
          --_grid-columns: ${gridColumns};
          --_grid-gap: ${this.gap}px;
          --_grid-align: ${alignItems};
          --_masonry-columns: ${masonryColumns};
        "
      >
        <slot @slotchange=${this._onSlotChange}></slot>
      </div>
    `;
  }
}

/**
 * Peek Grid Item Component
 *
 * Optional wrapper for grid items with span control.
 *
 * @element peek-grid-item
 *
 * @prop {number} colSpan - Number of columns to span
 * @prop {number} rowSpan - Number of rows to span
 *
 * @slot - Default slot for item content
 *
 * @example
 * <peek-grid>
 *   <peek-grid-item col-span="2">Wide item</peek-grid-item>
 *   <peek-grid-item>Normal item</peek-grid-item>
 * </peek-grid>
 */
export class PeekGridItem extends PeekElement {
  static properties = {
    colSpan: { type: Number, attribute: 'col-span' },
    rowSpan: { type: Number, attribute: 'row-span' }
  };

  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
        grid-column: var(--_col-span, auto);
        grid-row: var(--_row-span, auto);
      }
    `
  ];

  constructor() {
    super();
    this.colSpan = null;
    this.rowSpan = null;
  }

  render() {
    const colStyle = this.colSpan ? `span ${this.colSpan}` : 'auto';
    const rowStyle = this.rowSpan ? `span ${this.rowSpan}` : 'auto';

    return html`
      <style>
        :host {
          --_col-span: ${colStyle};
          --_row-span: ${rowStyle};
        }
      </style>
      <slot></slot>
    `;
  }
}

customElements.define('peek-grid', PeekGrid);
customElements.define('peek-grid-item', PeekGridItem);

export default PeekGrid;
