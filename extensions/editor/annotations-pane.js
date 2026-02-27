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

    this.toggleBtn = document.createElement('button');
    this.toggleBtn.className = 'sidebar-toggle';
    this.toggleBtn.innerHTML = '\u25B6'; // >
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

  render() {
    this.content.innerHTML = '';

    if (this.highlights.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'annotations-empty';
      empty.textContent = 'No notes yet. Select text or place cursor, then click + or press \u2318\u21E7L.';
      this.content.appendChild(empty);
      return;
    }

    // Sort highlights by position
    const sorted = [...this.highlights].sort((a, b) => a.from - b.from);

    for (const hl of sorted) {
      const item = document.createElement('div');
      item.className = 'annotation-item';

      // Color indicator
      const colorDot = document.createElement('span');
      colorDot.className = 'annotation-color';
      colorDot.style.background = hl.color || 'var(--base0A)';
      item.appendChild(colorDot);

      // Text content
      const textWrap = document.createElement('div');
      textWrap.className = 'annotation-text-wrap';

      const lineNum = this._getLineNumber(hl.from);
      const text = document.createElement('div');
      text.className = 'annotation-text';
      if (hl.note) {
        // Has user note — show "Line N" as label, note as primary text
        text.textContent = lineNum ? `Line ${lineNum}` : 'Note';
      } else {
        // No note — show "Line N — highlight"
        text.textContent = lineNum ? `Line ${lineNum} \u2014 highlight` : 'Highlight';
      }
      textWrap.appendChild(text);

      if (hl.note) {
        const note = document.createElement('div');
        note.className = 'annotation-note';
        note.textContent = hl.note;
        textWrap.appendChild(note);
      }

      item.appendChild(textWrap);

      // Actions
      const actions = document.createElement('div');
      actions.className = 'annotation-actions';

      const editBtn = document.createElement('button');
      editBtn.className = 'annotation-btn';
      editBtn.textContent = 'Edit';
      editBtn.title = 'Edit note';
      editBtn.addEventListener('mousedown', (e) => e.preventDefault());
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._editNote(hl);
      });
      actions.appendChild(editBtn);

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'annotation-btn annotation-btn-delete';
      deleteBtn.textContent = '\u00D7'; // x
      deleteBtn.title = 'Remove note';
      deleteBtn.addEventListener('mousedown', (e) => e.preventDefault());
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.onAnnotationDelete) {
          this.onAnnotationDelete(hl.id);
        }
      });
      actions.appendChild(deleteBtn);

      item.appendChild(actions);

      // Click to jump to highlight
      item.addEventListener('mousedown', (e) => e.preventDefault());
      item.addEventListener('click', () => {
        if (this.onAnnotationClick) {
          this.onAnnotationClick(hl);
        }
      });

      this.content.appendChild(item);
    }
  }

  _editNote(highlight) {
    const note = prompt('Note:', highlight.note || '');
    if (note !== null && this.onAnnotationEdit) {
      this.onAnnotationEdit(highlight.id, note);
    }
  }

  /**
   * Set collapsed visual state. Called by layout — pane does NOT own this state.
   */
  setCollapsed(collapsed) {
    this.collapsed = collapsed;
    this.element.classList.toggle('collapsed', collapsed);
    if (collapsed) {
      this.toggleBtn.innerHTML = '\u25B6';
      this.toggleBtn.title = 'Show Notes';
    } else {
      this.toggleBtn.innerHTML = '\u25C0';
      this.toggleBtn.title = 'Hide Notes';
    }
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
