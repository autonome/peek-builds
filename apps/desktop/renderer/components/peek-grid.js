/**
 * Peek Grid Component
 *
 * A responsive CSS Grid layout container with auto-fit behavior.
 * Items automatically flow into available columns based on min-width.
 *
 * Backward-compatible slotted-children API (all existing consumers):
 *   <peek-grid min-item-width="300" gap="20">
 *     <peek-card>Item 1</peek-card>
 *   </peek-grid>
 *
 * Opt-in virtual windowing API (columns/list view modes with large item sets):
 *   await grid.setVirtualItems(items, (item, index) => cardElement, opts)
 *   grid.clearVirtualItems()        — switch back to slotted mode
 *   grid.scrollToIndex(index, opts) — scroll a specific item into view
 *   grid.getRenderedCards()         — array of currently-visible card elements
 *   grid.getColCount()              — current column count (for keyboard nav)
 *   grid.getVirtualItemCount()      — total item count
 *
 * When virtual mode is active, peek-grid owns an internal scroll container
 * (in its shadow root) whose content div projects a named slot. The windowed
 * cards themselves live in the consumer's LIGHT DOM as `slot="virtual"`
 * children of the host, absolutely positioned and projected into that slot.
 * Keeping the cards in light DOM is deliberate: the consumer's page stylesheet
 * (e.g. tags/home.css styling `.card-title` / `--peek-card-*`) cannot cross a
 * shadow boundary, so cards appended into peek-grid's own shadow root would
 * lose all consumer styling. Light-DOM slotting restores it for free and keeps
 * `document.querySelector` able to find the cards.
 *
 * The CSS class 'virtual-active' (added to the host element) activates the
 * relevant layout rules. Slotted-children consumers are completely unaffected —
 * they never call setVirtualItems.
 *
 * @element peek-grid
 *
 * @prop {number} minItemWidth - Minimum item width in pixels (default: 250)
 * @prop {number} gap - Gap between items in pixels (default: 10)
 * @prop {number} columns - Fixed column count (overrides auto-fit if set)
 * @prop {string} align - Item alignment: 'start' | 'center' | 'end' | 'stretch'
 * @prop {boolean} dense - Enable dense packing algorithm
 * @prop {boolean} overlay - Optimize spacing for overlay contexts
 * @prop {string} viewMode - Layout mode: 'columns' | 'list' | 'masonry' | 'freeform' | 'fit'
 * @prop {Object} freeformLayout - Map of item id → {x, y, w, h} bounds
 * @prop {boolean} freeformEditing - Toggle edit mode for freeform layout
 * @prop {number} freeformSnap - Snap grid in px (default 20, 0 = off)
 * @prop {boolean} pushCards - Freeform drag/resize pushes overlapped cards down (default false)
 *
 * @slot - Default slot for grid items (slotted-children path)
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
import { pushLayout } from '../lib/push-layout.js';

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
    freeformSnap: { type: Number, attribute: 'freeform-snap' },
    pushCards: { type: Boolean, attribute: 'push-cards' }
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
        /* Skip layout/paint for off-screen grid items. The "auto" keyword in
           contain-intrinsic-size tells the browser to remember each item's real
           rendered height so variable-height cards don't jumble the scrollbar
           after the first pass. 84px is the cold-start fallback for items that
           have never been rendered. Masonry mode overrides this below. */
        content-visibility: auto;
        contain-intrinsic-size: auto 84px;
      }

      /* CSS columns layout (masonry) reads ALL item heights to balance columns.
         content-visibility:auto would make off-screen items report 84px instead
         of their real height, causing uneven column distribution. Disable it. */
      :host([view-mode="masonry"]) ::slotted(*) {
        content-visibility: visible;
        contain-intrinsic-size: none;
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

      /* Fit mode — all items visible in the container without scroll.
         Cols and rows computed in JS based on item count + container
         aspect; cells are equal-sized so there's a consistent gap and
         no overlap regardless of count. Container needs an explicit
         height for this to fill the viewport. */
      :host([view-mode="fit"]) {
        display: block;
        height: 100%;
      }

      :host([view-mode="fit"]) .grid {
        height: 100%;
      }

      :host([view-mode="fit"]) ::slotted(*) {
        min-width: 0;
        min-height: 0;
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

      /* Edit mode — cards drag and resize; no outline, the cards draw their own edges */
      :host([view-mode="freeform"][freeform-editing]) ::slotted(*) {
        cursor: move;
        user-select: none;
      }

      /* ── Virtual windowing mode ──────────────────────────────────────────────
         Activated when the consumer calls grid.setVirtualItems(…). The host
         gets the class 'virtual-active' which triggers these layout rules.

         The host becomes a flex column that fills its parent (flex:1 makes it
         grow; min-height:0 lets it shrink so descendant overflow:auto gets a
         bounded viewport). The Lit-managed .grid div is hidden; the imperative
         .virtual-scroll-host div (appended to shadow root) takes its place.
         ──────────────────────────────────────────────────────────────────── */
      :host(.virtual-active) {
        display: flex !important;
        flex-direction: column;
        overflow: hidden;
        flex: 1;
        min-height: 0;
      }

      /* Hide Lit's grid when virtual mode is on.
         The .grid div's own inline style only carries CSS custom properties
         (--_grid-columns etc.), so no !important is needed here. */
      :host(.virtual-active) .grid {
        display: none;
      }

      /* .virtual-scroll-host is appended imperatively to the shadow root.
         By default (no virtual-active) it starts hidden. */
      .virtual-scroll-host {
        display: none;
        position: relative;
        flex: 1;
        overflow-y: auto;
        min-height: 0;
      }

      :host(.virtual-active) .virtual-scroll-host {
        display: block;
      }

      /* Full-height inner div — its height equals virtualizer.getTotalSize(),
         giving the scrollbar an accurate track for the full virtual list.
         position:relative makes it the containing block for the absolutely
         positioned cards projected through its <slot name="virtual">. */
      .virtual-scroll-content {
        position: relative;
        width: 100%;
      }

      /* Cards projected into the virtual slot are already windowed by the
         virtualizer and absolutely positioned. The general ::slotted(*)
         content-visibility containment above (meant for the in-flow grid
         path) would make off-screen overscan cards report their placeholder
         contain-intrinsic-size to the virtualizer's measureElement,
         corrupting height measurement — so disable it for virtual-slot
         children. Higher specificity than ::slotted(*) so it wins. */
      ::slotted([slot="virtual"]) {
        content-visibility: visible;
        contain-intrinsic-size: none;
      }
    `
  ];

  constructor() {
    super();
    this.minItemWidth = 250;
    this.gap = 10;
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

    // ── Virtual windowing state (not Lit-reactive; managed imperatively) ────
    this._vCore               = null;   // cached import('@tanstack/virtual-core')
    this._virtualItems        = null;   // item array, or null when not in virtual mode
    this._renderItem          = null;   // (item, index) => HTMLElement callback
    this._virtualOpts         = {};     // { estimateSize?, getKey?, emptyMessage? }
    this._virtualizer         = null;   // headless Virtualizer instance
    this._virtualizerCleanup  = null;   // teardown fn returned by _didMount()
    this._scrollHost          = null;   // div.virtual-scroll-host — the scroll element
    this._scrollContent       = null;   // div.virtual-scroll-content — full-height inner
    this._virtualSlot         = null;   // slot[name=virtual] inside scrollContent
    this._emptyEl             = null;   // empty-state light child (slot=virtual), or null
    this._vColCount           = 1;      // current column count (updated by ResizeObserver)
    this._vItemHeight         = 90;     // uniform fixed card height (px) for the virtual grid path
    this._hostColResizeObserver = null;

    // Cache: item-key → peek-card DOM node.
    // Cleared on data/filter/sort change; evicted entries are ALSO deleted here
    // (not just from activeVirtualCards) so detached nodes can be GC'd and
    // memory stays bounded during long scroll sessions.
    this._cardNodeCache     = new Map();
    this._activeVirtualCards = new Map(); // key → card currently in virtualScrollContent
    this._cardGeometry      = new Map(); // key → {top, left, width}

    // Convergence guard: signature of the last rendered window. If range +
    // totalSize + colCount + hostWidth are unchanged, _renderVirtualWindow
    // is a no-op. Breaks the measure→onChange→render feedback loop.
    this._lastWindowSig    = '';

    // Re-entrancy guard: measureElement() inside _renderVirtualWindow can
    // synchronously trigger onChange → _renderVirtualWindow. Drop the nested call.
    this._renderingWindow  = false;

    // One-time viewport diagnostic logged on first render.
    this._loggedViewportDiag = false;
    // ────────────────────────────────────────────────────────────────────────
  }

  connectedCallback() {
    super.connectedCallback();
    this._resizeObserver = new ResizeObserver(() => {
      if (this.viewMode === 'masonry' || this.viewMode === 'freeform') {
        this.requestUpdate();
      } else if (this.viewMode === 'fit') {
        this._applyFitLayout();
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
    this._teardownVirtualizer();
  }

  updated(changedProps) {
    super.updated?.(changedProps);

    const wasFreeform = changedProps.has('viewMode') && changedProps.get('viewMode') === 'freeform';
    const isFreeform = this.viewMode === 'freeform';
    const wasFit = changedProps.has('viewMode') && changedProps.get('viewMode') === 'fit';
    const isFit = this.viewMode === 'fit';

    // Clean up when leaving freeform
    if (wasFreeform && !isFreeform) {
      this._clearFreeformStyles();
      this._cleanupFreeformListeners();
      return;
    }

    if (isFreeform) {
      // In push mode the active card follows the pointer freely; re-applying
      // the stored layout mid-gesture (e.g. after the resize observer fires)
      // would snap it back.
      if (!(this.pushCards && this._dragState)) this._applyFreeformPositions();
      if (this.freeformEditing) {
        this._attachEditListeners();
      } else {
        this._cleanupFreeformListeners();
      }
    }

    // Clean up when leaving fit
    if (wasFit && !isFit) {
      this._clearFitStyles();
    }
    if (isFit) {
      this._applyFitLayout();
    }
  }

  // ── Virtual windowing API ────────────────────────────────────────────────

  /**
   * Switch to the virtual windowing path for the given item set.
   *
   * Virtual-core is loaded lazily on first call so pages that use only the
   * slotted-children path are not affected and don't need the importmap entry.
   *
   * On the first call this is async (dynamic import + Lit render cycle). On
   * subsequent calls (same page session) virtual-core is already cached so the
   * method completes synchronously before returning.
   *
   * @param {Array}    items       - The full item array to display
   * @param {Function} renderItem  - (item, index) => HTMLElement. Called once
   *                                 per item when it first enters the viewport.
   * @param {Object}   [opts]
   * @param {number}   [opts.estimateSize=90]   - Estimated item height (px)
   * @param {number}   [opts.itemHeight]        - Fixed uniform item height (px).
   *                                              When set, every card is forced to
   *                                              this height and rows align (true grid).
   *                                              Takes precedence over estimateSize.
   * @param {Function} [opts.getKey]            - (item, index) => string stable key
   * @param {string}   [opts.emptyMessage]      - Message shown when items is empty
   * @returns {Promise<void>}
   */
  async setVirtualItems(items, renderItem, opts = {}) {
    // Lazy-load virtual-core once; subsequent calls reuse the cached module.
    if (!this._vCore) {
      this._vCore = await import('@tanstack/virtual-core');
    }

    // Store current intent (may have changed while awaiting the import).
    this._virtualItems = items;
    this._renderItem   = renderItem;
    this._virtualOpts  = opts;

    // Ensure the virtual containers exist in the shadow root.
    this._ensureVirtualContainers();

    // Activate virtual layout (idempotent: add only if not already present).
    if (!this.classList.contains('virtual-active')) {
      this.classList.add('virtual-active');
      // Wait for the CSS class change to be processed so offsetWidth below
      // reflects the correct laid-out width of the (now-visible) scroll host.
      await this.updateComplete;
    }

    // Reinitialize (or first-initialize) the virtualizer with current items.
    this._initVirtualizer(items);
  }

  /**
   * Switch back to the slotted-children path.
   * Tears down the virtualizer and removes the virtual-mode class.
   * Call this before appending slot children for non-virtual view modes.
   */
  clearVirtualItems() {
    if (!this.classList.contains('virtual-active')) return;

    this._teardownVirtualizer();

    this._virtualItems  = null;
    this._renderItem    = null;

    // Remove the projected light-DOM cards + empty-state. The slot itself
    // stays inside _scrollContent for the next virtual session.
    this._clearVirtualSlotChildren();

    this.classList.remove('virtual-active');
  }

  /**
   * Scroll the item at the given index into view.
   * @param {number} index
   * @param {Object} [opts] - Options forwarded to virtual-core's scrollToIndex
   */
  scrollToIndex(index, opts = {}) {
    if (this._virtualizer) {
      this._virtualizer.scrollToIndex(index, opts);
    }
  }

  /**
   * Returns the array of card elements currently rendered in the virtual window.
   * Elements are identified by a `data-index` attribute.
   * @returns {Element[]}
   */
  getRenderedCards() {
    // Cards are light-DOM children of the host (projected into the virtual
    // slot), so query the host directly — this also keeps consumer code and
    // tests using plain document.querySelector working.
    return Array.from(this.querySelectorAll(':scope > [slot="virtual"][data-index]'));
  }

  /**
   * Returns the current column count (1 in list mode or narrow viewports).
   * Useful for keyboard navigation row-skip calculations.
   * @returns {number}
   */
  getColCount() {
    return this._vColCount;
  }

  /**
   * Returns the total number of items in the virtual list.
   * @returns {number}
   */
  getVirtualItemCount() {
    return this._virtualItems ? this._virtualItems.length : 0;
  }

  // ── Virtual windowing internals ──────────────────────────────────────────

  /** Lazily create the virtual scroll containers and append to shadow root. */
  _ensureVirtualContainers() {
    if (this._scrollHost) return; // already created

    this._scrollContent = document.createElement('div');
    this._scrollContent.className = 'virtual-scroll-content';

    // Named slot — projects the consumer's light-DOM virtual cards
    // (slot="virtual") into this positioned content div. The cards stay in
    // light DOM so the consumer's page stylesheet styles them; the slot's
    // default display:contents means the projected cards take .virtual-scroll-
    // content as their absolute-positioning containing block.
    this._virtualSlot = document.createElement('slot');
    this._virtualSlot.setAttribute('name', 'virtual');
    this._scrollContent.appendChild(this._virtualSlot);

    this._scrollHost = document.createElement('div');
    this._scrollHost.className = 'virtual-scroll-host';
    this._scrollHost.appendChild(this._scrollContent);

    // Append alongside Lit's managed .grid div. Lit never clears the shadow
    // root — it only patches the range it created — so this node persists
    // across all subsequent Lit re-renders.
    this.shadowRoot.appendChild(this._scrollHost);
  }

  /**
   * (Re-)initialize the Virtualizer for the given items.
   * Tears down any existing instance first, clears all caches, and starts fresh.
   */
  _initVirtualizer(items) {
    if (!this._scrollHost || !this._scrollContent) return;

    const {
      Virtualizer,
      observeElementRect,
      observeElementOffset,
      elementScroll,
      measureElement: vCoreMeasureElement,
    } = this._vCore;

    const gap    = this.gap;
    const minColW = this.minItemWidth;
    const opts   = this._virtualOpts;
    // Uniform fixed height takes precedence: when itemHeight is set, every card is
    // forced to it and no per-card measurement happens, so lanes advance in lockstep
    // and rows align (a true grid). Falls back to the old estimateSize behaviour.
    const itemHeight = opts.itemHeight ?? opts.estimateSize ?? 90;
    this._vItemHeight = itemHeight;

    // Snapshot initial column count from the now-visible host element.
    const hostWidth = this._scrollHost.offsetWidth;
    if (hostWidth > 0) {
      this._vColCount = Math.max(1, Math.floor((hostWidth + gap) / (minColW + gap)));
    }

    // Teardown previous virtualizer (handles filter/sort reinit).
    if (this._virtualizerCleanup) {
      this._virtualizerCleanup();
      this._virtualizerCleanup = null;
    }
    if (this._virtualizer) {
      this._virtualizer = null;
    }
    if (this._hostColResizeObserver) {
      this._hostColResizeObserver.disconnect();
      this._hostColResizeObserver = null;
    }

    // Clear projected light-DOM cards + empty-state and reset caches. The
    // <slot> inside _scrollContent is preserved across reinit.
    this._clearVirtualSlotChildren();
    this._activeVirtualCards.clear();
    this._cardNodeCache.clear();
    this._cardGeometry.clear();
    this._lastWindowSig     = '';
    this._loggedViewportDiag = false;

    if (items.length === 0) {
      // Empty-state is a light child (slot=virtual) so the consumer's
      // .empty-state page styling applies, same as the cards.
      this._emptyEl = document.createElement('div');
      this._emptyEl.className = 'empty-state';
      this._emptyEl.setAttribute('slot', 'virtual');
      this._emptyEl.textContent = opts.emptyMessage ?? 'No items.';
      this.appendChild(this._emptyEl);
      this._scrollContent.style.height = '';
      return;
    }

    // Set up column count ResizeObserver before creating the virtualizer so
    // it fires before onChange if the layout changes mid-init.
    this._hostColResizeObserver = new ResizeObserver(entries => {
      const width = entries[0].contentRect.width;
      const newCols = Math.max(1, Math.floor((width + gap) / (minColW + gap)));
      if (newCols !== this._vColCount) {
        this._vColCount = newCols;
        if (this._virtualizer) {
          this._virtualizer.setOptions({ ...this._virtualizer.options, lanes: newCols });
          this._virtualizer._willUpdate();
          this._renderVirtualWindow();
        }
      }
    });
    this._hostColResizeObserver.observe(this._scrollHost);

    this._virtualizer = new Virtualizer({
      count: items.length,
      estimateSize: () => itemHeight,
      getScrollElement: () => this._scrollHost,
      scrollToFn: elementScroll,
      observeElementRect,
      observeElementOffset,
      measureElement: (el, entry, instance) => vCoreMeasureElement(el, entry, instance),
      lanes: this._vColCount,
      gap,
      overscan: 3,
      getItemKey: opts.getKey
        ? (index) => {
            const item = this._virtualItems[index];
            return item != null ? opts.getKey(item, index) : String(index);
          }
        : (index) => String(index),
      onChange: (instance) => {
        instance._willUpdate();
        this._renderVirtualWindow();
      },
    });

    // _didMount() returns the teardown fn and registers scroll/resize observers.
    // _willUpdate() attaches them (transitions scrollElement null → _scrollHost).
    // Both are required; calling only _willUpdate() leaves observers unregistered.
    this._virtualizerCleanup = this._virtualizer._didMount();
    this._virtualizer._willUpdate();

    // Render the initial visible window synchronously.
    this._renderVirtualWindow();
  }

  /**
   * Re-render the visible window of cards.
   * Called by the virtualizer onChange callback (scroll/resize) and at init.
   *
   * Proven fixes carried from the tags prototype:
   * - Re-entrancy guard: a cheap safety net (no longer triggered by measureElement
   *   since we no longer measure; kept as a harmless guard against any future path
   *   that might synchronously trigger onChange mid-render).
   * - Convergence guard: if range + totalSize + colCount + hostWidth are
   *   unchanged, return early. Breaks any onChange→render feedback loop.
   * - Cache eviction: delete the card from _cardNodeCache on eviction so
   *   detached nodes are GC'd and memory stays bounded during full-list scroll.
   * - Uniform fixed height: every card receives `height:_vItemHeight` so all
   *   lanes advance in lockstep and rows align (a true grid). No per-card
   *   measureElement runs.
   * - Conditional style writes: only rewrite card.style when geometry changed.
   * - colWidth from clientWidth (not offsetWidth): excludes the scrollbar width
   *   so column geometry doesn't oscillate as the scrollbar appears/disappears.
   */
  _renderVirtualWindow() {
    if (!this._virtualizer || !this._scrollHost || !this._scrollContent) return;
    if (this._renderingWindow) return; // re-entrancy guard

    const virtualItems = this._virtualizer.getVirtualItems();
    const totalSize    = this._virtualizer.getTotalSize();
    const cols         = this._vColCount;
    const hostWidth    = this._scrollHost.clientWidth; // excludes scrollbar

    // Update inner div height so the scrollbar reflects the full virtual list.
    this._scrollContent.style.height = `${totalSize}px`;

    if (hostWidth <= 0) return; // not laid out yet — defer to next onChange

    // One-time viewport diagnostic.
    if (!this._loggedViewportDiag) {
      this._loggedViewportDiag = true;
      console.log(
        `[peek-grid:virt] viewportH=${this._scrollHost.offsetHeight}` +
        ` visibleCount=${virtualItems.length} totalSize=${Math.round(totalSize)}` +
        ` count=${this._virtualItems?.length} cols=${cols}`
      );
    }

    // Convergence guard.
    const firstIdx = virtualItems.length > 0 ? virtualItems[0].index : -1;
    const lastIdx  = virtualItems.length > 0 ? virtualItems[virtualItems.length - 1].index : -1;
    const sig = `${firstIdx}:${lastIdx}:${Math.round(totalSize)}:${cols}:${hostWidth}`;
    if (sig === this._lastWindowSig) return;
    this._lastWindowSig = sig;

    this._renderingWindow = true;
    try {
      const gap       = this.gap;
      const colWidth  = Math.floor((hostWidth - (cols - 1) * gap) / cols);
      const laneStride = colWidth + gap;

      // Determine which item keys belong in the visible window.
      const nextVisibleKeys = new Set();
      for (const vi of virtualItems) {
        const item = this._virtualItems[vi.index];
        if (item != null) nextVisibleKeys.add(this._itemKey(item, vi.index));
      }

      // Evict cards that scrolled out of the overscan boundary.
      // Deleting from _cardNodeCache (not just _activeVirtualCards) lets the
      // detached node be GC'd; otherwise memory climbs as the full list scrolls.
      for (const [key, card] of this._activeVirtualCards) {
        if (!nextVisibleKeys.has(key)) {
          card.remove();
          this._activeVirtualCards.delete(key);
          this._cardGeometry.delete(key);
          this._cardNodeCache.delete(key);
        }
      }

      // Add or update each visible card.
      for (const vi of virtualItems) {
        const item = this._virtualItems[vi.index];
        if (item == null) continue;

        const key = this._itemKey(item, vi.index);
        let card = this._activeVirtualCards.get(key);
        const isNew = !card;
        if (isNew) {
          // Prefer a cached node from a previous scroll-back to avoid rebuilding
          // the DOM on every scroll tick.
          card = this._cardNodeCache.get(key);
          if (!card) {
            card = this._renderItem(item, vi.index);
            this._cardNodeCache.set(key, card);
          }
          // Project the card through the virtual slot by making it a light-DOM
          // child of the host with slot="virtual". Absolute positioning (set
          // below) resolves against .virtual-scroll-content in the shadow tree.
          card.setAttribute('slot', 'virtual');
          this.appendChild(card);
          this._activeVirtualCards.set(key, card);
        }

        // Absolute position within the scroll content.
        const left = vi.lane * laneStride;
        const top  = vi.start;

        // Only rewrite card.style when geometry actually changed.
        const prev = this._cardGeometry.get(key);
        if (!prev || prev.top !== top || prev.left !== left || prev.width !== colWidth) {
          card.style.cssText =
            `position:absolute;top:0;transform:translateY(${top}px);` +
            `left:${left}px;width:${colWidth}px;height:${this._vItemHeight}px;box-sizing:border-box;`;
          this._cardGeometry.set(key, { top, left, width: colWidth });
        }

        // data-index lets consumers find cards by index (selection, keyboard nav).
        const idxStr = String(vi.index);
        if (card.getAttribute('data-index') !== idxStr) {
          card.setAttribute('data-index', idxStr);
        }
      }
    } finally {
      this._renderingWindow = false;
    }
  }

  /** Stable string key for a given item + index. */
  _itemKey(item, index) {
    const opts = this._virtualOpts;
    return opts.getKey ? opts.getKey(item, index) : String(index);
  }

  /** Tear down virtualizer observers and clear all virtual state. */
  _teardownVirtualizer() {
    if (this._virtualizerCleanup) {
      this._virtualizerCleanup();
      this._virtualizerCleanup = null;
    }
    this._virtualizer = null;

    if (this._hostColResizeObserver) {
      this._hostColResizeObserver.disconnect();
      this._hostColResizeObserver = null;
    }

    this._clearVirtualSlotChildren();
    this._activeVirtualCards.clear();
    this._cardNodeCache.clear();
    this._cardGeometry.clear();
    this._lastWindowSig = '';
  }

  /**
   * Remove every light-DOM node we projected into the virtual slot — the
   * windowed cards plus the empty-state element. The <slot> itself lives in
   * the shadow root's _scrollContent and is never touched here.
   */
  _clearVirtualSlotChildren() {
    const projected = this.querySelectorAll(':scope > [slot="virtual"]');
    for (const el of projected) el.remove();
    this._emptyEl = null;
  }

  // ── Freeform: positioning ────────────────────────────────────────────────

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

  // ── Freeform: edit mode listeners ────────────────────────────────────────

  _attachEditListeners() {
    const children = this._getSlottedChildren();
    for (const child of children) {
      // A ghost "+" card (lib/ghost-card.js) is placed but never dragged.
      if (child.hasAttribute('data-ghost')) continue;
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

  // ── Freeform: edge detection ─────────────────────────────────────────────

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

  // ── Freeform: drag/resize ────────────────────────────────────────────────

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
      origHeight: rect.height,
      // Every card's rectangle at gesture start; the push on drop is computed
      // from where cards were before the gesture.
      startRects: this.pushCards ? this._readChildRects() : null
    };

    // Push mode lets the active card overlap others, so draw it on top.
    if (this.pushCards) child.style.zIndex = '1000';

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

  /** Current bounds of every slotted child, in slot order. */
  _readChildRects() {
    return this._getSlottedChildren().map((el) => ({
      x: parseFloat(el.style.left) || 0,
      y: parseFloat(el.style.top) || 0,
      w: parseFloat(el.style.width) || el.getBoundingClientRect().width,
      h: parseFloat(el.style.height) || el.getBoundingClientRect().height,
      ghost: el.hasAttribute('data-ghost')
    }));
  }

  /**
   * Layout entries for cards the active card's final rectangle pushes down
   * (pushCards mode), computed once from the gesture-start rectangles.
   */
  _computePushedLayout(activeBounds) {
    const s = this._dragState;
    if (!this.pushCards || !s?.startRects) return {};
    const children = this._getSlottedChildren();
    const activeIndex = children.indexOf(s.child);
    if (activeIndex < 0 || children.length !== s.startRects.length) return {};
    const rects = pushLayout(s.startRects, activeIndex, activeBounds);
    const pushed = {};
    children.forEach((el, i) => {
      const cid = this._getChildId(el);
      if (!cid || i === activeIndex) return;
      if (rects[i].y !== s.startRects[i].y) pushed[cid] = rects[i];
    });
    return pushed;
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

    // On drop, cards the final rectangle covers move down and persist there.
    if (this.pushCards && s.startRects) {
      const pushed = this._computePushedLayout(bounds);
      this.freeformLayout = { ...this.freeformLayout, ...pushed };
      for (const el of this._getSlottedChildren()) {
        const b = pushed[this._getChildId(el)];
        if (b) el.style.top = `${b.y}px`;
      }
      s.child.style.zIndex = '';
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
      if (!(this.pushCards && this._dragState)) this._applyFreeformPositions();
      if (this.freeformEditing) this._attachEditListeners();
    } else if (this.viewMode === 'fit') {
      this._applyFitLayout();
    }
  }

  // ── Fit: pick the cols×rows arrangement that maximises per-card area ─────
  // while staying close to a target card aspect ratio (3:2). Iterates from
  // 1..N because N is small (window count). Empty container or zero items
  // is a no-op; the host's :host([view-mode="fit"]) display:none-free
  // styling handles the layout when the layout runs.
  _applyFitLayout() {
    const grid = this.shadowRoot?.querySelector('.grid');
    if (!grid) return;
    const children = this._getSlottedChildren();
    const N = children.length;
    if (N === 0) {
      grid.style.gridTemplateColumns = '';
      grid.style.gridTemplateRows = '';
      grid.style.gap = '';
      return;
    }

    // Measure the grid box, not the host — the host may have padding
    // (e.g. .cards { padding: 24px } in the windows feature) that
    // reduces the area the grid actually lays out in. Using
    // this.clientWidth/Height here would over-size cells and let them
    // overflow the visible viewport.
    const cw = grid.clientWidth;
    const ch = grid.clientHeight;
    if (cw <= 0 || ch <= 0) return;

    // The `gap` attribute acts as the MAXIMUM gutter; the effective gap
    // scales with cell width so 30+ small cards don't drown in 72px
    // gutters while 2 huge cards still get a generous frame.
    // 5% / 4px floor: tuned so small cards get tight gutters (better
    // space utilisation) without losing the framed look on big cards.
    const MAX_GAP = this.gap;
    const MIN_GAP = 8;
    const GAP_RATIO = 0.06; // gap ≈ 6% of cell width
    const TARGET_ASPECT = 3 / 2; // w / h
    // Hard aspect bounds — layouts outside this range are skipped, so
    // cards never become extremely wide-and-short or tall-and-narrow.
    // If no candidate fits (degenerate counts on extreme viewports),
    // we fall back to a soft-penalty pass below.
    const MIN_ASPECT = 0.7;
    const MAX_ASPECT = 1.9;

    // Closed-form ideal cell width when gap = GAP_RATIO * cellW:
    //   cellW * cols + (cols - 1) * GAP_RATIO * cellW = cw
    //   cellW = cw / (cols + (cols - 1) * GAP_RATIO)
    // Then clamp the resulting ideal gap into [MIN_GAP, MAX_GAP] and
    // re-derive cellW from the clamped value so columns sum to cw.
    const computeGap = (cols) => {
      const idealCellW = cw / (cols + (cols - 1) * GAP_RATIO);
      const idealGap = idealCellW * GAP_RATIO;
      if (idealGap > MAX_GAP) return MAX_GAP;
      if (idealGap < MIN_GAP) return MIN_GAP;
      return idealGap;
    };

    // Score a single (cols, effGap, cellW, cellH) candidate. Returns
    // the score; caller decides whether to honor the in-range filter.
    const scoreCandidate = (cellW, cellH) => {
      const cardAspect = cellW / cellH;
      const aspectScore = cardAspect > TARGET_ASPECT
        ? TARGET_ASPECT / cardAspect
        : cardAspect / TARGET_ASPECT;
      // Quadratic aspect penalty — wide-short and tall-narrow layouts
      // lose against closer-to-target ones even at equal area.
      return aspectScore * aspectScore * cellW * cellH;
    };

    // Two-pass search: first try only layouts whose cell aspect is in
    // [MIN_ASPECT, MAX_ASPECT]; if none qualify (degenerate count on an
    // extreme viewport), fall back to scoring every layout.
    let bestCols = 1;
    let bestGap = MAX_GAP;
    let bestScore = -1;
    let foundInRange = false;

    for (let pass = 0; pass < 2; pass++) {
      for (let cols = 1; cols <= N; cols++) {
        const rows = Math.ceil(N / cols);
        const effGap = computeGap(cols);
        const cellW = (cw - (cols - 1) * effGap) / cols;
        const cellH = (ch - (rows - 1) * effGap) / rows;
        if (cellW <= 0 || cellH <= 0) continue;

        if (pass === 0) {
          const cardAspect = cellW / cellH;
          if (cardAspect < MIN_ASPECT || cardAspect > MAX_ASPECT) continue;
        }

        const score = scoreCandidate(cellW, cellH);
        if (score > bestScore) {
          bestScore = score;
          bestCols = cols;
          bestGap = effGap;
          if (pass === 0) foundInRange = true;
        }
      }
      if (foundInRange) break;
    }

    const rows = Math.ceil(N / bestCols);
    grid.style.gridTemplateColumns = `repeat(${bestCols}, 1fr)`;
    grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
    grid.style.gap = `${bestGap}px`;
  }

  _clearFitStyles() {
    const grid = this.shadowRoot?.querySelector('.grid');
    if (!grid) return;
    grid.style.gridTemplateColumns = '';
    grid.style.gridTemplateRows = '';
    grid.style.gap = '';
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
