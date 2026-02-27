/**
 * Editor Layout - Multi-panel markdown editor with pane management.
 *
 * Features:
 * - Three main panes: outline, editor, preview (independently togglable)
 * - Fourth annotations pane anchored to far right
 * - Pane ordering via toolbar controls (persisted)
 * - Pane resizing with drag handles, double-click to maximize/minimize
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
    this.originalContainerStyles = '';
    this.cmdSuggestionsCleanup = null;

    // Pane state
    this.paneVisibility = { outline: false, editor: true, preview: false, annotations: false };
    this.paneOrder = ['outline', 'editor', 'preview']; // annotations always far right
    this.maximizedPane = null; // null or pane name

    // Scroll sync state
    this._scrollSyncEnabled = true;
    this._scrollSyncRAF = null;
    this._isEditorScrolling = false;

    this._loadPrefs();
    this.init();
  }

  _loadPrefs() {
    const prefs = loadLayoutPrefs();
    if (prefs.paneVisibility) {
      this.paneVisibility = { ...this.paneVisibility, ...prefs.paneVisibility };
    }
    if (Array.isArray(prefs.paneOrder) && prefs.paneOrder.length === 3) {
      this.paneOrder = prefs.paneOrder;
    }
  }

  _savePrefs() {
    saveLayoutPrefs({
      paneVisibility: this.paneVisibility,
      paneOrder: this.paneOrder,
    });
  }

  init() {
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
    });

    // Create editor container (center)
    this.editorContainer = document.createElement('div');
    this.editorContainer.className = 'editor-container';

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

    this.annotationsToggleBtn = this._createToggleBtn('Notes', 'Toggle annotations (Cmd+Shift+H)', () => this.togglePane('annotations'));
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
    });

    // Create annotations pane (always far right)
    this.annotationsPane = new AnnotationsPane({
      container: document.createElement('div'), // temporary
      onAnnotationClick: (hl) => this._jumpToHighlight(hl),
      onAnnotationDelete: (id) => this._removeHighlight(id),
      onAnnotationEdit: (id, note) => this._updateHighlightNote(id, note),
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

    // Apply persisted vim settings
    if (this.initialVimSettings && this.cmEditor) {
      CodeMirror.applyVimSettings(this.cmEditor, this.initialVimSettings);
    }

    // Set up command bar suggestions
    if (this.cmContainer) {
      this.cmdSuggestionsCleanup = observeCommandBar(this.cmContainer);
    }

    // Apply visibility state
    this._applyVisibility();

    // Initial update
    this.lastContent = this.initialContent;
    this.updateSidebars();

    // Start watching for changes
    this.startWatching();

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
    const leftPaneName = resizer.dataset.leftPane;
    const rightPaneName = resizer.dataset.rightPane;

    // For annotations resizer, left is paneContainer, right is annotations
    const isAnnotationsResizer = resizer.dataset.resizerKey === 'annotations';

    let leftEl, rightEl;
    if (isAnnotationsResizer) {
      rightEl = this.annotationsPane.getElement();
      leftEl = this.paneContainer;
    } else {
      leftEl = this._getPaneElement(leftPaneName);
      rightEl = this._getPaneElement(rightPaneName);
    }

    if (!leftEl || !rightEl) return;

    resizer.classList.add('dragging');
    const startX = startEvent.clientX;
    const startLeftWidth = leftEl.offsetWidth;
    const startRightWidth = rightEl.offsetWidth;

    // Override flex on both panes so explicit widths are respected
    const prevLeftFlex = leftEl.style.flex;
    const prevRightFlex = rightEl.style.flex;
    leftEl.style.flex = 'none';
    rightEl.style.flex = 'none';
    // Set initial widths to current computed sizes
    leftEl.style.width = `${startLeftWidth}px`;
    rightEl.style.width = `${startRightWidth}px`;

    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    const onMouseMove = (e) => {
      const delta = e.clientX - startX;

      if (isAnnotationsResizer) {
        // Resize annotations pane (drag right = shrink annotations)
        const newWidth = Math.max(100, Math.min(600, startRightWidth - delta));
        rightEl.style.width = `${newWidth}px`;
        rightEl.style.minWidth = `${newWidth}px`;
      } else {
        const newLeftWidth = Math.max(100, startLeftWidth + delta);
        const newRightWidth = Math.max(100, startRightWidth - delta);
        leftEl.style.width = `${newLeftWidth}px`;
        leftEl.style.minWidth = `${newLeftWidth}px`;
        rightEl.style.width = `${newRightWidth}px`;
        rightEl.style.minWidth = `${newRightWidth}px`;
      }
    };

    const onMouseUp = () => {
      resizer.classList.remove('dragging');
      indicator.classList.remove('visible');
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  _handleResizerDoubleClick(resizer) {
    const leftPaneName = resizer.dataset.leftPane;
    const rightPaneName = resizer.dataset.rightPane;

    if (resizer.dataset.resizerKey === 'annotations') {
      // Toggle annotations between collapsed and expanded
      this.togglePane('annotations');
      return;
    }

    // If a pane is maximized, restore it
    if (this.maximizedPane) {
      this._restoreAllPanes();
      this.maximizedPane = null;
      return;
    }

    // Maximize the left pane (convention: double-click maximizes the pane to the left of the resizer)
    this._maximizePane(leftPaneName);
  }

  _maximizePane(paneName) {
    this.maximizedPane = paneName;
    for (const name of this.paneOrder) {
      const el = this._getPaneElement(name);
      if (!el) continue;
      if (name === paneName) {
        el.style.flex = '1';
        el.style.display = '';
        el.style.width = '';
        el.style.minWidth = '';
      } else {
        el.style.display = 'none';
      }
    }
    // Hide resizers inside pane container
    this.paneContainer.querySelectorAll('.resizer').forEach(r => r.style.display = 'none');
  }

  _restoreAllPanes() {
    for (const name of this.paneOrder) {
      const el = this._getPaneElement(name);
      if (!el) continue;
      el.style.flex = '';
      el.style.display = this.paneVisibility[name] ? '' : 'none';
      el.style.width = '';
      el.style.minWidth = '';
    }
    this._applyVisibility();
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
   * Toggle a pane's visibility.
   */
  togglePane(paneName) {
    if (paneName === 'annotations') {
      this.paneVisibility.annotations = !this.paneVisibility.annotations;
      if (this.annotationsPane) {
        if (this.paneVisibility.annotations) {
          this.annotationsPane.getElement().style.display = '';
          this.annotationsPane.collapsed = false;
          this.annotationsPane.getElement().classList.remove('collapsed');
          this.annotationsResizer.style.display = '';
        } else {
          this.annotationsPane.getElement().style.display = 'none';
          this.annotationsResizer.style.display = 'none';
        }
      }
      this.annotationsToggleBtn.classList.toggle('active', this.paneVisibility.annotations);
      this._savePrefs();
      return;
    }

    this.paneVisibility[paneName] = !this.paneVisibility[paneName];
    this._applyVisibility();
    this._savePrefs();
  }

  /**
   * Apply current visibility state to DOM.
   */
  _applyVisibility() {
    if (this.maximizedPane) return; // Don't interfere with maximized state

    for (const name of this.paneOrder) {
      const el = this._getPaneElement(name);
      if (!el) continue;

      if (name === 'outline') {
        if (this.paneVisibility.outline) {
          el.style.display = '';
          this.outlineSidebar.collapsed = false;
          el.classList.remove('collapsed');
        } else {
          el.style.display = 'none';
        }
      } else if (name === 'preview') {
        if (this.paneVisibility.preview) {
          el.style.display = '';
          this.previewSidebar.collapsed = false;
          el.classList.remove('collapsed');
        } else {
          el.style.display = 'none';
        }
      } else if (name === 'editor') {
        el.style.display = this.paneVisibility.editor ? '' : 'none';
      }
    }

    // Annotations pane
    if (this.annotationsPane) {
      this.annotationsPane.getElement().style.display = this.paneVisibility.annotations ? '' : 'none';
      this.annotationsResizer.style.display = this.paneVisibility.annotations ? '' : 'none';
    }

    // Hide resizers between hidden panes
    this.paneContainer.querySelectorAll('.resizer').forEach(r => {
      const left = r.dataset.leftPane;
      const right = r.dataset.rightPane;
      const bothVisible = this.paneVisibility[left] && this.paneVisibility[right];
      r.style.display = bothVisible ? '' : 'none';
    });

    // Update toggle button states
    this.outlineToggleBtn.classList.toggle('active', this.paneVisibility.outline);
    this.editorToggleBtn.classList.toggle('active', this.paneVisibility.editor);
    this.previewToggleBtn.classList.toggle('active', this.paneVisibility.preview);
    this.annotationsToggleBtn.classList.toggle('active', this.paneVisibility.annotations);
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
    if (!this.cmEditor || !this.previewSidebar || this.previewSidebar.isCollapsed()) return;
    if (!this.paneVisibility.preview) return;

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
    if (!this.previewSidebar || this.previewSidebar.isCollapsed()) return;
    if (!this.paneVisibility.preview) return;

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
      // Cmd+Shift+H: Toggle annotations
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'h') {
        e.preventDefault();
        this.togglePane('annotations');
      }
      // Cmd+H: Add highlight on selected text
      if ((e.metaKey || e.ctrlKey) && e.key === 'h' && !e.shiftKey) {
        e.preventDefault();
        this._addHighlightFromSelection();
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
    if (sel.from === sel.to) return; // No selection

    const text = state.doc.sliceString(sel.from, sel.to);
    const highlight = {
      id: generateHighlightId(),
      from: sel.from,
      to: sel.to,
      text,
      note: '',
      color: nextHighlightColor(),
    };

    addHighlight(this.cmEditor, highlight);
    this._syncAnnotationsPane();
    this._persistHighlights();

    // Auto-show annotations pane
    if (!this.paneVisibility.annotations) {
      this.togglePane('annotations');
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
    this.annotationsPane.update(highlights);
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
    const check = () => {
      if (this.isDestroyed) return;

      const currentContent = this.getContent();
      if (currentContent !== this.lastContent) {
        this.lastContent = currentContent;
        this.updateSidebars();
      }

      this.rafId = requestAnimationFrame(check);
    };

    this.rafId = requestAnimationFrame(check);

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
    this.originalContainerStyles = this.container.style.cssText;
    this.wrapper.classList.add('focus-mode');
    this.focusBtn.classList.add('active');

    // Hide everything except editor
    if (this.outlineSidebar) this.outlineSidebar.getElement().style.display = 'none';
    if (this.previewSidebar) this.previewSidebar.getElement().style.display = 'none';
    if (this.annotationsPane) {
      this.annotationsPane.getElement().style.display = 'none';
      this.annotationsResizer.style.display = 'none';
    }
    this.paneContainer.querySelectorAll('.resizer').forEach(r => r.style.display = 'none');

    if (this.cmEditor) CodeMirror.focus(this.cmEditor);
  }

  exitFocusMode() {
    if (!this.isFocusMode) return;

    this.isFocusMode = false;
    this.container.style.cssText = this.originalContainerStyles;
    this.wrapper.classList.remove('focus-mode');
    this.focusBtn.classList.remove('active');

    // Restore visibility
    if (this.outlineSidebar) this.outlineSidebar.getElement().style.display = '';
    if (this.previewSidebar) this.previewSidebar.getElement().style.display = '';
    if (this.annotationsPane) {
      this.annotationsPane.getElement().style.display = '';
      this.annotationsResizer.style.display = '';
    }
    this.paneContainer.querySelectorAll('.resizer').forEach(r => r.style.display = '');

    this._applyVisibility();

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
