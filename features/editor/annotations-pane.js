/**
 * Notes Pane - displays persistent highlights and user notes.
 * Anchored to the far right of the editor layout.
 * Clicking a note scrolls to and selects the highlighted range.
 */

export class AnnotationsPane {
  constructor(options) {
    this.container = options.container;
    this.onAnnotationClick = options.onAnnotationClick; // (highlight) => void
    this.onAnnotationDelete = options.onAnnotationDelete; // (highlightId) => void
    this.onAnnotationEdit = options.onAnnotationEdit; // (highlightId, note) => void
    this.onAddNote = options.onAddNote; // () => void — add note at current selection/cursor
    this.onToggle = options.onToggle; // callback: () => void — layout handles state
    this.collapsed = false; // Layout owns this state
    this.highlights = [];
    this.doc = null; // CodeMirror doc for line number lookup
    this._editingId = null; // ID of highlight currently being edited
    this._pendingEditId = null; // ID of newly-added highlight to auto-open for editing
    this._inRender = false; // True while render() is mutating the DOM — see blur handler

    this.element = document.createElement('div');
    this.element.className = 'annotations-pane';

    // Header
    this.header = document.createElement('div');
    this.header.className = 'sidebar-header';

    const title = document.createElement('span');
    title.className = 'sidebar-title';
    title.textContent = 'Notes';
    this.header.appendChild(title);

    const countBadge = document.createElement('span');
    countBadge.className = 'annotations-count';
    countBadge.textContent = '0';
    this.countBadge = countBadge;
    this.header.appendChild(countBadge);

    // Add note button
    const addBtn = document.createElement('button');
    addBtn.className = 'annotation-btn annotation-add-btn';
    addBtn.textContent = '+';
    addBtn.title = 'Add note at selection (\u2318\u21E7L)';
    addBtn.addEventListener('mousedown', (e) => e.preventDefault());
    addBtn.addEventListener('click', () => {
      if (this.onAddNote) this.onAddNote();
    });
    this.header.appendChild(addBtn);

    // Collapsed pane icon (visible only when collapsed)
    this.collapsedIcon = document.createElement('span');
    this.collapsedIcon.className = 'pane-collapsed-icon';
    this.collapsedIcon.textContent = '\u2710'; // ✐ (note icon)
    this.collapsedIcon.title = 'Show Notes';
    this.collapsedIcon.addEventListener('click', () => this.toggle());
    this.header.appendChild(this.collapsedIcon);

    this.toggleBtn = document.createElement('button');
    this.toggleBtn.className = 'sidebar-toggle';
    this.toggleBtn.innerHTML = '\u25B6'; // ▶ (collapse icon)
    this.toggleBtn.title = 'Hide Notes';
    this.toggleBtn.tabIndex = -1;
    this.toggleBtn.addEventListener('mousedown', (e) => e.preventDefault());
    this.toggleBtn.addEventListener('click', () => this.toggle());
    this.header.appendChild(this.toggleBtn);

    this.element.appendChild(this.header);

    // Content area
    this.content = document.createElement('div');
    this.content.className = 'annotations-content';
    this.element.appendChild(this.content);

    this.container.appendChild(this.element);
  }

  /**
   * Update the displayed highlights.
   * @param {Array} highlights - Array of {id, from, to, text, note, color}
   */
  /**
   * Update the displayed highlights.
   * @param {Array} highlights - Array of {id, from, to, text, note, color}
   * @param {Object} [doc] - CodeMirror doc for line number lookup
   */
  update(highlights, doc) {
    this.highlights = highlights || [];
    if (doc) this.doc = doc;
    this.countBadge.textContent = String(this.highlights.length);
    this.render();
  }

  _getLineNumber(pos) {
    if (this.doc && pos < this.doc.length) {
      try { return this.doc.lineAt(pos).number; } catch (e) { /* ignore */ }
    }
    return null;
  }

  /**
   * Open the inline textarea editor for a specific highlight.
   * Called externally (e.g. after adding a new highlight).
   */
  openEditorForHighlight(highlightId) {
    this._pendingEditId = highlightId;
    this.render();
  }

  render() {
    this._inRender = true;
    try {
      this._renderImpl();
    } finally {
      this._inRender = false;
    }
  }

  _renderImpl() {
    this.content.innerHTML = '';

    if (this.highlights.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'annotations-empty';
      empty.textContent = 'No notes yet. Select text or place cursor, then click + or press \u2318\u21E7L.';
      this.content.appendChild(empty);
      this._pendingEditId = null;
      return;
    }

    // Sort highlights by position
    const sorted = [...this.highlights].sort((a, b) => a.from - b.from);

    for (const hl of sorted) {
      const isEditing = this._editingId === hl.id || this._pendingEditId === hl.id;

      const item = document.createElement('div');
      item.className = 'annotation-item';
      if (isEditing) item.classList.add('annotation-item-editing');

      // Color indicator
      const colorDot = document.createElement('span');
      colorDot.className = 'annotation-color';
      colorDot.style.background = hl.color || 'var(--base0A)';
      item.appendChild(colorDot);

      // Text content
      const textWrap = document.createElement('div');
      textWrap.className = 'annotation-text-wrap';

      // Header row: line info + note preview (clickable to toggle editor)
      const header = document.createElement('div');
      header.className = 'annotation-header';

      const lineNum = this._getLineNumber(hl.from);
      const text = document.createElement('div');
      text.className = 'annotation-text';
      let headerLabel = lineNum ? `Line ${lineNum}` : 'Highlight';
      if (hl.text) {
        const excerpt = hl.text.replace(/\s+/g, ' ').trim();
        if (excerpt.length > 0) {
          const truncated = excerpt.length > 35 ? excerpt.slice(0, 35) + '\u2026' : excerpt;
          headerLabel += ` \u2014 ${truncated}`;
        }
      }
      text.textContent = headerLabel;
      header.appendChild(text);

      if (hl.note && !isEditing) {
        const notePreview = document.createElement('div');
        notePreview.className = 'annotation-note';
        notePreview.textContent = hl.note;
        header.appendChild(notePreview);
      }

      // Click header to toggle textarea and jump to highlight
      header.addEventListener('mousedown', (e) => e.preventDefault());
      header.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this._editingId === hl.id) {
          this._editingId = null;
        } else {
          this._editingId = hl.id;
        }
        this.render();
        if (this.onAnnotationClick) {
          this.onAnnotationClick(hl);
        }
      });

      textWrap.appendChild(header);

      // Inline textarea editor
      if (isEditing) {
        const textarea = document.createElement('textarea');
        textarea.className = 'annotation-textarea';
        textarea.value = hl.note || '';
        textarea.placeholder = 'Add a note...';
        textarea.rows = 3;

        // Prevent item click from firing when interacting with textarea
        textarea.addEventListener('mousedown', (e) => e.stopPropagation());
        textarea.addEventListener('click', (e) => e.stopPropagation());

        // Save and close on blur
        textarea.addEventListener('blur', () => {
          // Skip save when blur was triggered by our own render() detaching
          // this textarea (innerHTML clear → Chromium moves focus to body
          // before the node is fully detached, firing blur while the
          // textarea is still .isConnected). That path is internal cleanup,
          // not user intent — saving the textarea's empty value here would
          // clobber a note that another caller (e.g. updateHighlightNote)
          // just dispatched. Real user blurs (click-elsewhere, Escape→blur())
          // happen outside render(), so they still save normally.
          if (this._inRender) return;

          const value = textarea.value;
          // Clear editing state BEFORE save — save triggers update() -> render()
          // chain via onAnnotationEdit callback. If _editingId is still set when
          // that intermediate render runs, it recreates the textarea (with a new
          // rAF focus schedule), defeating the close.
          this._editingId = null;
          this._pendingEditId = null;
          this._saveTextarea(hl.id, value);
          // render() was already called by the save->update chain above,
          // but call again to ensure consistent state if the chain was skipped.
          this.render();
        });

        // Enter inserts newline (default behavior). Escape saves and closes.
        textarea.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation(); // Don't trigger editor focus mode exit
            // blur will trigger save+close
            textarea.blur();
          }
        });

        textWrap.appendChild(textarea);

        // Auto-focus the textarea after DOM insertion
        requestAnimationFrame(() => {
          textarea.focus();
          // Place cursor at end
          textarea.selectionStart = textarea.value.length;
          textarea.selectionEnd = textarea.value.length;
        });
      }

      item.appendChild(textWrap);

      // Actions — only delete button
      const actions = document.createElement('div');
      actions.className = 'annotation-actions';

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'annotation-btn annotation-btn-delete';
      deleteBtn.textContent = '\u00D7'; // x
      deleteBtn.title = 'Remove note';
      let confirmPending = false;
      let confirmTimeout = null;
      deleteBtn.addEventListener('mousedown', (e) => e.preventDefault());
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirmPending) {
          // Second click — actually delete
          clearTimeout(confirmTimeout);
          if (this.onAnnotationDelete) {
            this.onAnnotationDelete(hl.id);
          }
        } else {
          // First click — enter confirm state
          confirmPending = true;
          deleteBtn.textContent = '?';
          deleteBtn.classList.add('annotation-btn-confirm');
          confirmTimeout = setTimeout(() => {
            confirmPending = false;
            deleteBtn.textContent = '\u00D7';
            deleteBtn.classList.remove('annotation-btn-confirm');
          }, 3000);
        }
      });
      actions.appendChild(deleteBtn);

      item.appendChild(actions);

      // Click the item background to jump to highlight
      item.addEventListener('mousedown', (e) => e.preventDefault());
      item.addEventListener('click', () => {
        if (this.onAnnotationClick) {
          this.onAnnotationClick(hl);
        }
      });

      this.content.appendChild(item);
    }

    // Clear pending edit after render
    if (this._pendingEditId) {
      this._editingId = this._pendingEditId;
      this._pendingEditId = null;
    }
  }

  _saveTextarea(highlightId, value) {
    if (this.onAnnotationEdit) {
      this.onAnnotationEdit(highlightId, value);
    }
  }

  /**
   * Set collapsed visual state. Called by layout — pane does NOT own this state.
   */
  setCollapsed(collapsed) {
    this.collapsed = collapsed;
    this.element.classList.toggle('collapsed', collapsed);
    // Toggle button and collapsed icon visibility handled by CSS .collapsed class
  }

  /**
   * Toggle (for internal toggle button click) — delegates to layout.
   */
  toggle() {
    if (this.onToggle) {
      this.onToggle();
    }
  }

  isCollapsed() {
    return this.collapsed;
  }

  getElement() {
    return this.element;
  }

  destroy() {
    this.element.remove();
  }
}
