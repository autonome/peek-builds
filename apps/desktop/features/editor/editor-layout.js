/**
 * Editor Layout - Multi-panel markdown editor with pane management.
 *
 * Pane management model:
 * - Each pane has two independent states: visible (bool) and collapsed (bool)
 * - Visible+expanded: shows at persisted width (or CSS default)
 * - Visible+collapsed: 32px strip with header only
 * - Hidden (!visible): display:none, not shown at all
 * - Toolbar buttons toggle collapsed state (expanded <-> collapsed)
 * - Hidden state is only for programmatic use (annotations default, focus mode)
 * - Layout owns ALL state; sidebar components only update their visual appearance
 * - _applyPaneState() is the single source of truth for DOM
 *
 * Other features:
 * - Pane ordering via toolbar controls (persisted)
 * - Pane resizing with drag handles
 * - Preview scroll sync with editor
 * - Persistent highlights with annotations
 */

import { OutlineSidebar } from './outline-sidebar.js';
import { PreviewSidebar } from './preview-sidebar.js';
import { AnnotationsPane } from './annotations-pane.js';
import { StatusLine } from './status-line.js';
import * as CodeMirror from './codemirror.js';
import { foldEffect, unfoldEffect, foldable, foldedRanges } from '@codemirror/language';
import { observeCommandBar } from './cmd-suggestions.js';
import {
  highlightField, getHighlights, addHighlight, removeHighlight,
  setHighlights, updateHighlightNote, serializeHighlights,
  deserializeHighlights, nextHighlightColor, generateHighlightId,
} from './highlights.js';

const LAYOUT_PREFS_KEY = 'editor:layout-prefs';

// Boot timing markers for renderer-tail perf work. Each call forwards to
// main.log via api.perfLog. t is wall-clock relative to this module's init
// in this renderer; cross-correlate with [editor-boot:perf] in home.js.
function __layoutMark(phase, t0) {
  try {
    const t = Math.round(performance.now() - t0);
    const api = (typeof window !== 'undefined') ? window.app : null;
    if (api && typeof api.perfLog === 'function') {
      api.perfLog(`[editor-layout:perf] phase=${phase} t=${t}`);
    }
  } catch { /* never crash on instrumentation */ }
}

/** Default widths for each pane when expanded (CSS values). */
const DEFAULT_WIDTHS = {
  outline: '220px',
  preview: '400px',
  annotations: '260px',
};

/**
 * Load layout preferences from localStorage.
 */
function loadLayoutPrefs() {
  try {
    const raw = localStorage.getItem(LAYOUT_PREFS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ignore */ }
  return {};
}

/**
 * Save layout preferences to localStorage.
 */
function saveLayoutPrefs(prefs) {
  try {
    localStorage.setItem(LAYOUT_PREFS_KEY, JSON.stringify(prefs));
  } catch (e) { /* ignore */ }
}

export class EditorLayout {
  constructor(options) {
    this.container = options.container;
    this.onContentChange = options.onContentChange;
    this.initialContent = options.initialContent || '';
    this.vimMode = options.vimMode || false;
    this.initialVimSettings = options.vimSettings || null;

    this.outlineSidebar = null;
    this.previewSidebar = null;
    this.annotationsPane = null;
    this.statusLine = null;
    this.cmEditor = null;
    this.lastContent = '';
    this.rafId = null;
    this.isDestroyed = false;
    this.isFocusMode = false;
    this.preFocusState = null; // saved state before focus mode
    this.cmdSuggestionsCleanup = null;

    // Pane state — uniform for all four panes
    // visible: whether the pane is shown at all (hidden = display:none)
    // collapsed: whether the pane is a 32px strip (true) or expanded (false)
    this.paneVisible = { outline: true, editor: true, preview: true, annotations: false };
    this.paneCollapsed = { outline: true, editor: false, preview: true, annotations: false };
    this.paneWidths = {}; // persisted user widths (px strings), e.g. { outline: '250px' }
    this.paneOrder = ['outline', 'editor', 'preview']; // annotations always far right

    // Scroll sync state
    this._scrollSyncEnabled = true;
    this._scrollSyncRAF = null;
    this._isEditorScrolling = false;

    this._loadPrefs();
    this.init();
  }

  _loadPrefs() {
    const prefs = loadLayoutPrefs();
    if (prefs.paneVisible) {
      this.paneVisible = { ...this.paneVisible, ...prefs.paneVisible };
    }
    // Always keep editor visible
    this.paneVisible.editor = true;
    if (prefs.paneCollapsed) {
      this.paneCollapsed = { ...this.paneCollapsed, ...prefs.paneCollapsed };
    }
    if (prefs.paneWidths) {
      this.paneWidths = { ...prefs.paneWidths };
    }
    if (Array.isArray(prefs.paneOrder) && prefs.paneOrder.length === 3) {
      this.paneOrder = prefs.paneOrder;
    }
  }

  _savePrefs() {
    saveLayoutPrefs({
      paneVisible: this.paneVisible,
      paneCollapsed: this.paneCollapsed,
      paneWidths: this.paneWidths,
      paneOrder: this.paneOrder,
    });
  }

  init() {
    const __t0 = performance.now();
    __layoutMark('init-start', __t0);
    // Create main wrapper
    this.wrapper = document.createElement('div');
    this.wrapper.className = 'editor-layout';

    // Create pane container (holds the three reorderable panes + resizers)
    this.paneContainer = document.createElement('div');
    this.paneContainer.className = 'pane-container';

    // Create outline sidebar
    this.outlineSidebar = new OutlineSidebar({
      container: document.createElement('div'), // temporary, will reparent
      onHeaderClick: (header) => this.jumpToHeader(header),
      onFoldToggle: (header, shouldFold) => this.handleOutlineFoldToggle(header, shouldFold),
      onToggle: () => this.togglePane('outline'),
    });

    // Create editor container (center)
    this.editorContainer = document.createElement('div');
    this.editorContainer.className = 'editor-container';

    // Editor header bar (matches sidebar headers)
    this.editorHeader = document.createElement('div');
    this.editorHeader.className = 'sidebar-header';

    const editorTitle = document.createElement('span');
    editorTitle.className = 'sidebar-title';
    editorTitle.textContent = 'Editor';
    this.editorHeader.appendChild(editorTitle);

    this.editorHeaderFilename = document.createElement('span');
    this.editorHeaderFilename.className = 'editor-header-filename';
    this.editorHeader.appendChild(this.editorHeaderFilename);

    // Collapsed icon for editor pane
    this.editorCollapsedIcon = document.createElement('span');
    this.editorCollapsedIcon.className = 'pane-collapsed-icon';
    this.editorCollapsedIcon.textContent = '\u270E'; // ✎
    this.editorCollapsedIcon.title = 'Show Editor';
    this.editorCollapsedIcon.addEventListener('click', () => this.togglePane('editor'));
    this.editorHeader.appendChild(this.editorCollapsedIcon);

    this.editorToggleHeaderBtn = document.createElement('button');
    this.editorToggleHeaderBtn.className = 'sidebar-toggle';
    this.editorToggleHeaderBtn.innerHTML = '\u25C0'; // ◀
    this.editorToggleHeaderBtn.title = 'Hide Editor';
    this.editorToggleHeaderBtn.tabIndex = -1;
    this.editorToggleHeaderBtn.addEventListener('mousedown', (e) => e.preventDefault());
    this.editorToggleHeaderBtn.addEventListener('click', () => this.togglePane('editor'));
    this.editorHeader.appendChild(this.editorToggleHeaderBtn);

    this.editorContainer.appendChild(this.editorHeader);

    // CodeMirror container
    this.cmContainer = document.createElement('div');
    this.cmContainer.className = 'cm-container';
    this.editorContainer.appendChild(this.cmContainer);

    // Status line container
    this.statusLineContainer = document.createElement('div');
    this.statusLineContainer.className = 'status-line-container';
    this.editorContainer.appendChild(this.statusLineContainer);

    // Toolbar below editor
    this.toolbar = document.createElement('div');
    this.toolbar.className = 'editor-toolbar';

    // Left group: pane toggles
    const sidebarToggles = document.createElement('div');
    sidebarToggles.className = 'sidebar-toggles';

    this.outlineToggleBtn = this._createToggleBtn('Outline', 'Toggle outline (Cmd+Shift+O)', () => this.togglePane('outline'));
    sidebarToggles.appendChild(this.outlineToggleBtn);

    this.editorToggleBtn = this._createToggleBtn('Editor', 'Toggle editor pane', () => this.togglePane('editor'));
    sidebarToggles.appendChild(this.editorToggleBtn);

    this.previewToggleBtn = this._createToggleBtn('Preview', 'Toggle preview (Cmd+Shift+P)', () => this.togglePane('preview'));
    sidebarToggles.appendChild(this.previewToggleBtn);

    this.annotationsToggleBtn = this._createToggleBtn('Notes', 'Toggle notes (Cmd+Shift+H)', () => this.togglePane('annotations'));
    sidebarToggles.appendChild(this.annotationsToggleBtn);

    // Pane order cycle button
    this.orderBtn = document.createElement('button');
    this.orderBtn.className = 'toolbar-btn toolbar-btn-icon';
    this.orderBtn.textContent = '\u21C4'; // arrows
    this.orderBtn.title = 'Cycle pane order';
    this.orderBtn.addEventListener('click', () => this.cyclePaneOrder());
    sidebarToggles.appendChild(this.orderBtn);

    this.focusBtn = this._createToggleBtn('Focus', 'Toggle focus mode (Escape to exit)', () => this.toggleFocusMode());
    sidebarToggles.appendChild(this.focusBtn);

    this.toolbar.appendChild(sidebarToggles);

    // Filename display (center)
    this.filenameDisplay = document.createElement('span');
    this.filenameDisplay.className = 'filename-display';
    this.filenameDisplay.style.display = 'none';
    this.toolbar.appendChild(this.filenameDisplay);

    // Save status indicator
    this.saveStatus = document.createElement('span');
    this.saveStatus.id = 'save-status';
    this.saveStatus.className = 'save-status save-status-saved';
    this.saveStatus.textContent = 'Saved';
    this.saveStatus.style.display = 'none';
    this.toolbar.appendChild(this.saveStatus);

    this.editorContainer.appendChild(this.toolbar);

    // Create preview sidebar
    this.previewSidebar = new PreviewSidebar({
      container: document.createElement('div'), // temporary
      onToggle: () => this.togglePane('preview'),
    });

    // Create annotations pane (always far right)
    this.annotationsPane = new AnnotationsPane({
      container: document.createElement('div'), // temporary
      onAnnotationClick: (hl) => this._jumpToHighlight(hl),
      onAnnotationDelete: (id) => this._removeHighlight(id),
      onAnnotationEdit: (id, note) => this._updateHighlightNote(id, note),
      onAddNote: () => this._addHighlightFromSelection(),
      onToggle: () => this.togglePane('annotations'),
    });

    // Build pane layout
    this._buildPaneLayout();

    // Annotations pane always far right, outside main pane container
    this.wrapper.appendChild(this.paneContainer);

    // Annotations resizer and pane
    this.annotationsResizer = this._createResizer('annotations');
    this.wrapper.appendChild(this.annotationsResizer);
    this.wrapper.appendChild(this.annotationsPane.getElement());

    this.container.appendChild(this.wrapper);

    // Initialize status line
    this.statusLine = new StatusLine({
      container: this.statusLineContainer,
    });
    if (!this.vimMode) {
      this.statusLine.hide();
    }

    __layoutMark('dom-built', __t0);

    // Initialize CodeMirror
    this.cmEditor = CodeMirror.createEditor({
      parent: this.cmContainer,
      content: this.initialContent,
      vimMode: this.vimMode,
      showLineNumbers: true,
      onChange: (content) => this.handleContentChange(content),
      onSelectionChange: (line, col) => this.handleSelectionChange(line, col),
      onVimModeChange: (mode) => this.handleVimModeUpdate(mode),
      onFoldChange: () => this.syncOutlineFromFolds(),
      onScroll: (view) => this._handleEditorScroll(view),
    });
    __layoutMark('cm-created', __t0);

    // Apply persisted vim settings
    if (this.initialVimSettings && this.cmEditor) {
      CodeMirror.applyVimSettings(this.cmEditor, this.initialVimSettings);
    }

    // Set up command bar suggestions
    if (this.cmContainer) {
      this.cmdSuggestionsCleanup = observeCommandBar(this.cmContainer);
    }

    // Apply pane state (visibility, collapsed, widths)
    this._applyPaneState();

    // Initial update
    this.lastContent = this.initialContent;
    this.updateSidebars();
    __layoutMark(`sidebars-updated len=${(this.initialContent || '').length}`, __t0);

    // Start watching for changes
    this.startWatching();
    __layoutMark('init-done', __t0);

    // Set up keyboard shortcuts
    this.setupKeyboardShortcuts();

    // Set up editor scroll sync via scroll event on scroller
    this._setupEditorScrollListener();

    // Focus editor
    setTimeout(() => {
      if (this.cmEditor) CodeMirror.focus(this.cmEditor);
    }, 100);
  }

  _createToggleBtn(label, title, onClick) {
    const btn = document.createElement('button');
    btn.className = 'toolbar-btn';
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener('click', onClick);
    return btn;
  }

  /**
   * Build the pane layout based on current paneOrder.
   * Clears and repopulates paneContainer.
   */
  _buildPaneLayout() {
    this.paneContainer.innerHTML = '';

    const paneElements = {
      outline: this.outlineSidebar.getElement(),
      editor: this.editorContainer,
      preview: this.previewSidebar.getElement(),
    };

    for (let i = 0; i < this.paneOrder.length; i++) {
      const paneName = this.paneOrder[i];
      const el = paneElements[paneName];
      if (el) {
        el.style.order = String(i * 2);
        this.paneContainer.appendChild(el);
      }

      // Add resizer between panes (not after last)
      if (i < this.paneOrder.length - 1) {
        const resizerKey = `${this.paneOrder[i]}-${this.paneOrder[i + 1]}`;
        const resizer = this._createResizer(resizerKey);
        resizer.style.order = String(i * 2 + 1);
        resizer.dataset.leftPane = this.paneOrder[i];
        resizer.dataset.rightPane = this.paneOrder[i + 1];
        this.paneContainer.appendChild(resizer);
      }
    }
  }

  _createResizer(key) {
    const resizer = document.createElement('div');
    resizer.className = `resizer resizer-${key}`;
    resizer.dataset.resizerKey = key;

    const indicator = document.createElement('div');
    indicator.className = 'resizer-indicator';
    resizer.appendChild(indicator);

    resizer.addEventListener('mouseenter', () => {
      indicator.classList.add('visible');
    });

    resizer.addEventListener('mouseleave', () => {
      if (!resizer.classList.contains('dragging')) {
        indicator.classList.remove('visible');
      }
    });

    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      indicator.classList.add('visible');
      this._startResize(resizer, e, indicator);
    });

    // Double-click to maximize/minimize
    resizer.addEventListener('dblclick', (e) => {
      e.preventDefault();
      this._handleResizerDoubleClick(resizer);
    });

    return resizer;
  }

  _startResize(resizer, startEvent, indicator) {
    const isAnnotationsResizer = resizer.dataset.resizerKey === 'annotations';

    // Determine which non-editor pane we're resizing.
    // For annotations resizer: resize the annotations pane.
    // For inner resizers: resize whichever side is NOT the editor.
    let targetPaneName;
    let targetEl;

    if (isAnnotationsResizer) {
      targetPaneName = 'annotations';
      targetEl = this._getPaneElement('annotations');
    } else {
      const leftPaneName = resizer.dataset.leftPane;
      const rightPaneName = resizer.dataset.rightPane;
      // The non-editor side is the target
      if (leftPaneName !== 'editor') {
        targetPaneName = leftPaneName;
      } else {
        targetPaneName = rightPaneName;
      }
      targetEl = this._getPaneElement(targetPaneName);
    }

    if (!targetEl) return;

    resizer.classList.add('dragging');
    const startX = startEvent.clientX;
    const startWidth = targetEl.offsetWidth;

    // Determine resize direction: dragging right grows the pane if it's to the left of the resizer
    const growsRight = isAnnotationsResizer
      ? false // annotations is to the right, dragging right shrinks it
      : (resizer.dataset.leftPane === targetPaneName); // left pane grows when dragging right

    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    let lastWidth = startWidth;

    const onMouseMove = (e) => {
      const delta = e.clientX - startX;
      const newWidth = Math.max(100, Math.min(600, startWidth + (growsRight ? delta : -delta)));
      targetEl.style.width = `${newWidth}px`;
      targetEl.style.minWidth = `${newWidth}px`;
      targetEl.style.flex = 'none';
      lastWidth = newWidth;
    };

    const onMouseUp = () => {
      resizer.classList.remove('dragging');
      indicator.classList.remove('visible');
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);

      // Persist the width
      this.paneWidths[targetPaneName] = `${lastWidth}px`;
      this._savePrefs();
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  _handleResizerDoubleClick(resizer) {
    if (resizer.dataset.resizerKey === 'annotations') {
      this.togglePane('annotations');
      return;
    }

    // Double-click toggles the non-editor pane adjacent to the resizer
    const leftPaneName = resizer.dataset.leftPane;
    const rightPaneName = resizer.dataset.rightPane;
    const target = leftPaneName !== 'editor' ? leftPaneName : rightPaneName;
    this.togglePane(target);
  }

  _getPaneElement(name) {
    switch (name) {
      case 'outline': return this.outlineSidebar?.getElement();
      case 'editor': return this.editorContainer;
      case 'preview': return this.previewSidebar?.getElement();
      case 'annotations': return this.annotationsPane?.getElement();
      default: return null;
    }
  }

  /**
   * Toggle a pane's collapsed state.
   * For non-visible panes (e.g. annotations initially hidden), first show them expanded.
   * Toolbar cycle: expanded -> collapsed -> expanded (never hides).
   */
  togglePane(paneName) {
    if (!this.paneVisible[paneName]) {
      // Not visible yet — show it expanded
      this.paneVisible[paneName] = true;
      this.paneCollapsed[paneName] = false;
    } else {
      // Already visible — toggle collapsed
      this.paneCollapsed[paneName] = !this.paneCollapsed[paneName];
    }

    this._applyPaneState();
    this._savePrefs();
  }

  /**
   * Programmatically hide a pane (display:none). Used by focus mode.
   */
  hidePane(paneName) {
    this.paneVisible[paneName] = false;
    this._applyPaneState();
  }

  /**
   * Programmatically show a pane (restores previous collapsed state).
   */
  showPane(paneName) {
    this.paneVisible[paneName] = true;
    this._applyPaneState();
  }

  /**
   * Apply the full pane state to DOM. This is the SINGLE source of truth.
   * Reads paneVisible, paneCollapsed, paneWidths and updates:
   *   - display (visible vs hidden)
   *   - CSS .collapsed class
   *   - inline width/minWidth (cleared when collapsed, set when expanded with user width)
   *   - sidebar component visual state (toggle button icon)
   *   - resizer visibility
   *   - toolbar button active states
   */
  _applyPaneState() {
    const allPanes = ['outline', 'editor', 'preview', 'annotations'];

    for (const name of allPanes) {
      const el = this._getPaneElement(name);
      if (!el) continue;

      const visible = this.paneVisible[name];
      const collapsed = this.paneCollapsed[name];

      if (!visible) {
        // Hidden — display:none, clear all inline styles
        el.style.display = 'none';
        el.style.width = '';
        el.style.minWidth = '';
        el.style.flex = '';
        el.classList.remove('collapsed');
      } else if (collapsed) {
        // Visible + collapsed — 32px strip
        el.style.display = '';
        el.style.width = '32px';
        el.style.minWidth = '32px';
        el.style.flex = 'none';
        el.classList.add('collapsed');
      } else if (name === 'editor') {
        // Editor expanded — flex:1
        el.style.display = '';
        el.style.width = '';
        el.style.minWidth = '';
        el.style.flex = '1';
        el.classList.remove('collapsed');
      } else {
        // Visible + expanded — use persisted width or default
        el.style.display = '';
        const width = this.paneWidths[name] || DEFAULT_WIDTHS[name] || '';
        el.style.width = width;
        el.style.minWidth = width;
        el.style.flex = 'none';
        el.classList.remove('collapsed');
      }

      // Update sidebar component visual state (including editor)
      this._updateSidebarVisual(name, collapsed && visible);
    }

    // Annotations resizer visibility: shown only when annotations is visible AND expanded
    if (this.annotationsResizer) {
      const annVisible = this.paneVisible.annotations;
      const annCollapsed = this.paneCollapsed.annotations;
      this.annotationsResizer.style.display = (annVisible && !annCollapsed) ? '' : 'none';
    }

    // Inner resizers: shown only when both adjacent panes are visible AND at least one is expanded
    this.paneContainer.querySelectorAll('.resizer').forEach(r => {
      const left = r.dataset.leftPane;
      const right = r.dataset.rightPane;
      const leftOk = this.paneVisible[left] && !this.paneCollapsed[left];
      const rightOk = this.paneVisible[right] && !this.paneCollapsed[right];
      // Show resizer if both panes are visible and at least one is expanded
      const bothVisible = this.paneVisible[left] && this.paneVisible[right];
      r.style.display = (bothVisible && (leftOk || rightOk)) ? '' : 'none';
    });

    // Update toolbar button states — "active" means visible+expanded
    this.outlineToggleBtn.classList.toggle('active', this.paneVisible.outline && !this.paneCollapsed.outline);
    this.editorToggleBtn.classList.toggle('active', this.paneVisible.editor && !this.paneCollapsed.editor);
    this.previewToggleBtn.classList.toggle('active', this.paneVisible.preview && !this.paneCollapsed.preview);
    this.annotationsToggleBtn.classList.toggle('active', this.paneVisible.annotations && !this.paneCollapsed.annotations);
  }

  /**
   * Update a sidebar component's visual collapsed state (CSS class + toggle button icon).
   * The layout owns the state; sidebars only reflect it visually.
   */
  _updateSidebarVisual(paneName, isCollapsed) {
    switch (paneName) {
      case 'outline':
        if (this.outlineSidebar) this.outlineSidebar.setCollapsed(isCollapsed);
        break;
      case 'editor':
        this.editorContainer.classList.toggle('collapsed', isCollapsed);
        break;
      case 'preview':
        if (this.previewSidebar) this.previewSidebar.setCollapsed(isCollapsed);
        break;
      case 'annotations':
        if (this.annotationsPane) this.annotationsPane.setCollapsed(isCollapsed);
        break;
    }
  }

  // Keep old name as alias for any external callers
  _applyVisibility() {
    this._applyPaneState();
  }

  /**
   * Cycle the pane order through common arrangements.
   */
  cyclePaneOrder() {
    const arrangements = [
      ['outline', 'editor', 'preview'],
      ['editor', 'outline', 'preview'],
      ['outline', 'preview', 'editor'],
      ['preview', 'editor', 'outline'],
      ['editor', 'preview', 'outline'],
      ['preview', 'outline', 'editor'],
    ];

    const currentStr = this.paneOrder.join(',');
    let idx = arrangements.findIndex(a => a.join(',') === currentStr);
    idx = (idx + 1) % arrangements.length;
    this.paneOrder = arrangements[idx];

    this._buildPaneLayout();
    this._applyVisibility();
    this._savePrefs();
  }

  /**
   * Set up editor scroll listener for preview sync.
   */
  _setupEditorScrollListener() {
    // Watch for scroll on the cm-scroller element
    const scroller = this.cmContainer?.querySelector('.cm-scroller');
    if (scroller) {
      scroller.addEventListener('scroll', () => {
        if (this._scrollSyncEnabled) {
          this._syncPreviewScroll();
        }
      }, { passive: true });
    }
  }

  /**
   * Handle editor scroll from CodeMirror update listener.
   */
  _handleEditorScroll(view) {
    if (this._scrollSyncEnabled && !this._scrollSyncRAF) {
      this._scrollSyncRAF = requestAnimationFrame(() => {
        this._scrollSyncRAF = null;
        this._syncPreviewScroll();
      });
    }
  }

  /**
   * Sync preview scroll position based on editor scroll.
   */
  _syncPreviewScroll() {
    if (!this.cmEditor || !this.previewSidebar) return;
    if (!this.paneVisible.preview || this.paneCollapsed.preview) return;

    const scroller = this.cmContainer?.querySelector('.cm-scroller');
    if (!scroller) return;

    const scrollRatio = scroller.scrollTop / Math.max(1, scroller.scrollHeight - scroller.clientHeight);

    const previewContent = this.previewSidebar.getContentElement();
    if (!previewContent) return;

    const maxScroll = previewContent.scrollHeight - previewContent.clientHeight;
    previewContent.scrollTo({
      top: scrollRatio * maxScroll,
      behavior: 'smooth',
    });
  }

  /**
   * Sync preview to a specific heading (from outline click).
   */
  _syncPreviewToHeading(headerText) {
    if (!this.previewSidebar) return;
    if (!this.paneVisible.preview || this.paneCollapsed.preview) return;

    const previewContent = this.previewSidebar.getContentElement();
    if (!previewContent) return;

    // Find matching heading in preview
    const headings = previewContent.querySelectorAll('h1, h2, h3, h4, h5, h6');
    for (const heading of headings) {
      if (heading.textContent.trim() === headerText.trim()) {
        heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
    }
  }

  setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Cmd+Shift+O: Toggle outline
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'o') {
        e.preventDefault();
        this.togglePane('outline');
      }
      // Cmd+Shift+P: Toggle preview
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'p') {
        e.preventDefault();
        this.togglePane('preview');
      }
      // Cmd+Shift+H: Toggle notes pane
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'h') {
        e.preventDefault();
        this.togglePane('annotations');
      }
      // Cmd+Shift+L: Add note at selection/cursor
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'l') {
        e.preventDefault();
        this._addHighlightFromSelection();
      }
      // Cmd+Shift+Plus: Zoom outline in (show more levels)
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        if (this.outlineSidebar) this.outlineSidebar.zoomIn();
      }
      // Cmd+Shift+Minus: Zoom outline out (show fewer levels)
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === '-' || e.key === '_')) {
        e.preventDefault();
        if (this.outlineSidebar) this.outlineSidebar.zoomOut();
      }
      // Escape: Exit focus mode
      if (e.key === 'Escape' && this.isFocusMode) {
        this.exitFocusMode();
      }
    });
  }

  // ── Highlight management ──

  _addHighlightFromSelection() {
    if (!this.cmEditor) return;

    const state = this.cmEditor.state;
    const sel = state.selection.main;

    let from, to;
    if (sel.from !== sel.to) {
      // Has selection — anchor to selection range
      from = sel.from;
      to = sel.to;
    } else {
      // No selection — anchor to current line
      const line = state.doc.lineAt(sel.from);
      from = line.from;
      to = line.to;
    }

    const highlight = {
      id: generateHighlightId(),
      from,
      to,
      text: state.doc.sliceString(from, to),
      note: '',
      color: nextHighlightColor(),
    };

    addHighlight(this.cmEditor, highlight);
    this._syncAnnotationsPane();
    this._persistHighlights();

    // Auto-open the textarea editor for the new highlight
    if (this.annotationsPane) {
      this.annotationsPane.openEditorForHighlight(highlight.id);
    }

    // Auto-show annotations pane expanded
    if (!this.paneVisible.annotations || this.paneCollapsed.annotations) {
      this.paneVisible.annotations = true;
      this.paneCollapsed.annotations = false;
      this._applyPaneState();
      this._savePrefs();
    }
  }

  _removeHighlight(id) {
    if (!this.cmEditor) return;
    removeHighlight(this.cmEditor, id);
    this._syncAnnotationsPane();
    this._persistHighlights();
  }

  _updateHighlightNote(id, note) {
    if (!this.cmEditor) return;
    updateHighlightNote(this.cmEditor, id, note);
    this._syncAnnotationsPane();
    this._persistHighlights();
  }

  _jumpToHighlight(hl) {
    if (!this.cmEditor) return;
    this.cmEditor.dispatch({
      selection: { anchor: hl.from, head: hl.to },
      scrollIntoView: true,
    });
    CodeMirror.focus(this.cmEditor);
  }

  _syncAnnotationsPane() {
    if (!this.cmEditor || !this.annotationsPane) return;
    const highlights = getHighlights(this.cmEditor.state);
    this.annotationsPane.update(highlights, this.cmEditor.state.doc);
  }

  _persistHighlights() {
    if (!this.cmEditor) return;
    const highlights = getHighlights(this.cmEditor.state);
    const data = serializeHighlights(highlights);
    try {
      // Use itemId-based key if available, otherwise generic
      const key = this._getHighlightStorageKey();
      localStorage.setItem(key, JSON.stringify(data));
    } catch (e) { /* ignore */ }
  }

  _restoreHighlights() {
    if (!this.cmEditor) return;
    try {
      const key = this._getHighlightStorageKey();
      const raw = localStorage.getItem(key);
      if (raw) {
        const data = JSON.parse(raw);
        const highlights = deserializeHighlights(data, this.cmEditor.state.doc.length);
        if (highlights.length > 0) {
          setHighlights(this.cmEditor, highlights);
          this._syncAnnotationsPane();
        }
      }
    } catch (e) { /* ignore */ }
  }

  _getHighlightStorageKey() {
    // Uses URL params to create a unique key per document
    const params = new URLSearchParams(window.location.search);
    const itemId = params.get('itemId');
    const file = params.get('file');
    if (itemId) return `editor:highlights:${itemId}`;
    if (file) return `editor:highlights:file:${file}`;
    return 'editor:highlights:scratch';
  }

  // ── Content & sidebar updates ──

  startWatching() {
    // Sidebar/content updates are event-driven: CodeMirror's onChange callback
    // (→ handleContentChange) fires on every edit and refreshes the sidebars.
    // Render once now for the initial content, then let onChange drive updates.
    //
    // This used to poll getContent() every animation frame (~60×/sec) and diff
    // it against lastContent — which re-serialized the entire document each frame
    // for every VISIBLE editor tile, a steady idle CPU burn that scaled with doc
    // size and number of open editors (rAF throttles when hidden, so the cost
    // rotated across foreground editors). The onChange path already covers every
    // real edit, so the poll was pure redundancy.
    if (!this.isDestroyed) {
      this.lastContent = this.getContent();
      this.updateSidebars();
    }

    // Restore highlights after editor is ready
    setTimeout(() => this._restoreHighlights(), 200);
  }

  stopWatching() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  updateSidebars() {
    const content = this.lastContent;

    if (this.outlineSidebar) {
      this.outlineSidebar.update(content);
    }

    if (this.previewSidebar) {
      this.previewSidebar.update(content);
    }
  }

  handleContentChange(content) {
    this.lastContent = content;
    this.updateSidebars();

    // Persist highlights (positions may have changed)
    this._persistHighlights();
    this._syncAnnotationsPane();

    if (this.onContentChange) {
      this.onContentChange(content);
    }
  }

  updateVimModeState(enabled) {
    this.vimMode = enabled;
    if (this.cmEditor) {
      CodeMirror.setVimMode(this.cmEditor, this.vimMode);
    }
    if (this.statusLine) {
      if (this.vimMode) {
        this.statusLine.show();
        this.statusLine.updateMode('normal');
      } else {
        this.statusLine.hide();
      }
    }
  }

  handleSelectionChange(line, col) {
    if (this.statusLine) {
      this.statusLine.updatePosition(line, col);
    }
  }

  handleVimModeUpdate(mode) {
    if (this.statusLine && this.vimMode) {
      this.statusLine.updateMode(mode);
    }
  }

  handleOutlineFoldToggle(header, shouldFold) {
    if (!this.cmEditor) return;

    const view = this.cmEditor;
    const state = view.state;

    if (header.offset >= state.doc.length) return;
    const line = state.doc.lineAt(header.offset);
    const foldRange = foldable(state, line.from, line.to);
    if (!foldRange) return;

    if (shouldFold) {
      const folded = foldedRanges(state);
      let alreadyFolded = false;
      folded.between(foldRange.from, foldRange.to, (from) => {
        if (from === foldRange.from) alreadyFolded = true;
      });
      if (!alreadyFolded) {
        view.dispatch({
          effects: foldEffect.of({ from: foldRange.from, to: foldRange.to })
        });
      }
    } else {
      view.dispatch({
        effects: unfoldEffect.of({ from: foldRange.from, to: foldRange.to })
      });
    }
  }

  syncOutlineFromFolds() {
    if (this.outlineSidebar && this.cmEditor) {
      this.outlineSidebar.syncFromEditor(this.cmEditor);
    }
  }

  jumpToHeader(header) {
    if (!this.cmEditor) return;

    const view = this.cmEditor;
    view.dispatch({
      selection: { anchor: header.offset },
      scrollIntoView: true,
    });
    CodeMirror.focus(view);

    // Sync preview to this heading
    this._syncPreviewToHeading(header.text);
  }

  getContent() {
    if (this.cmEditor) {
      return CodeMirror.getContent(this.cmEditor);
    }
    return this.lastContent;
  }

  setContent(content) {
    if (this.cmEditor) {
      CodeMirror.setContent(this.cmEditor, content);
    }
    this.lastContent = content;
    this.updateSidebars();
  }

  toggleOutline() {
    this.togglePane('outline');
  }

  togglePreview() {
    this.togglePane('preview');
  }

  enterFocusMode() {
    if (this.isFocusMode) return;

    this.isFocusMode = true;
    // Save current state so we can restore on exit
    this.preFocusState = {
      paneVisible: { ...this.paneVisible },
      paneCollapsed: { ...this.paneCollapsed },
    };
    this.wrapper.classList.add('focus-mode');
    this.focusBtn.classList.add('active');

    // Hide everything except editor
    this.paneVisible = { outline: false, editor: true, preview: false, annotations: false };
    this.paneCollapsed = { ...this.paneCollapsed, editor: false };
    this._applyPaneState();

    if (this.cmEditor) CodeMirror.focus(this.cmEditor);
  }

  exitFocusMode() {
    if (!this.isFocusMode) return;

    this.isFocusMode = false;
    this.wrapper.classList.remove('focus-mode');
    this.focusBtn.classList.remove('active');

    // Restore previous state
    if (this.preFocusState) {
      this.paneVisible = this.preFocusState.paneVisible;
      this.paneCollapsed = this.preFocusState.paneCollapsed;
      this.preFocusState = null;
    }
    this._applyPaneState();

    if (this.cmEditor) CodeMirror.focus(this.cmEditor);
  }

  toggleFocusMode() {
    if (this.isFocusMode) {
      this.exitFocusMode();
    } else {
      this.enterFocusMode();
    }
  }

  isInFocusMode() {
    return this.isFocusMode;
  }

  setVimMode(enabled) {
    this.updateVimModeState(enabled);
  }

  applyVimSettings(settings) {
    if (this.cmEditor && settings) {
      CodeMirror.applyVimSettings(this.cmEditor, settings);
    }
  }

  getVimMode() {
    return this.vimMode;
  }

  focus() {
    if (this.cmEditor) {
      CodeMirror.focus(this.cmEditor);
    }
  }

  setSaveStatusVisible(visible) {
    if (this.saveStatus) {
      this.saveStatus.style.display = visible ? 'inline-block' : 'none';
    }
  }

  setFilename(filename) {
    if (this.filenameDisplay) {
      if (filename) {
        this.filenameDisplay.textContent = filename;
        this.filenameDisplay.style.display = 'inline-block';
      } else {
        this.filenameDisplay.textContent = '';
        this.filenameDisplay.style.display = 'none';
      }
    }
    // Also update the editor header filename
    if (this.editorHeaderFilename) {
      this.editorHeaderFilename.textContent = filename || '';
    }
  }

  /**
   * Set the base path for resolving relative image paths in the preview.
   * Should be the directory containing the file being edited.
   * @param {string|null} basePath - Directory path (e.g., '/Users/me/docs')
   */
  setBasePath(basePath) {
    if (this.previewSidebar) {
      this.previewSidebar.setBasePath(basePath);
      // Re-render preview with the new base path
      this.updateSidebars();
    }
  }

  destroy() {
    this.isDestroyed = true;
    this.stopWatching();

    if (this._scrollSyncRAF) {
      cancelAnimationFrame(this._scrollSyncRAF);
    }

    if (this.isFocusMode) {
      this.exitFocusMode();
    }

    if (this.cmdSuggestionsCleanup) {
      this.cmdSuggestionsCleanup();
      this.cmdSuggestionsCleanup = null;
    }

    if (this.cmEditor) {
      CodeMirror.destroy(this.cmEditor);
      this.cmEditor = null;
    }

    this.statusLine?.destroy();
    this.outlineSidebar?.destroy();
    this.previewSidebar?.destroy();
    this.annotationsPane?.destroy();
    this.wrapper.remove();
  }
}
