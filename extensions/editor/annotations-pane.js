/**
 * Annotations Pane - displays persistent highlights and their annotations.
 * Anchored to the far right of the editor layout.
 * Clicking an annotation scrolls to and selects the highlighted range.
 */

export class AnnotationsPane {
  constructor(options) {
    this.container = options.container;
    this.onAnnotationClick = options.onAnnotationClick; // (highlight) => void
    this.onAnnotationDelete = options.onAnnotationDelete; // (highlightId) => void
    this.onAnnotationEdit = options.onAnnotationEdit; // (highlightId, note) => void
    this.onAddNote = options.onAddNote; // () => void — trigger highlight from selection
    this.onToggle = options.onToggle; // () => void — called when internal toggle clicked
    this.collapsed = true; // Start collapsed
    this.highlights = [];

    this.element = document.createElement('div');
    this.element.className = 'annotations-pane collapsed';

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

    // Add Note button
    this.addNoteBtn = document.createElement('button');
    this.addNoteBtn.className = 'annotation-add-btn';
    this.addNoteBtn.textContent = '+';
    this.addNoteBtn.title = 'Add note at selection (Cmd+Shift+L)';
    this.addNoteBtn.tabIndex = -1;
    this.addNoteBtn.addEventListener('mousedown', (e) => e.preventDefault());
    this.addNoteBtn.addEventListener('click', () => {
      if (this.onAddNote) this.onAddNote();
    });
    this.header.appendChild(this.addNoteBtn);

    this.toggleBtn = document.createElement('button');
    this.toggleBtn.className = 'sidebar-toggle';
    this.toggleBtn.innerHTML = '\u25B6'; // >
    this.toggleBtn.tabIndex = -1;
    this.toggleBtn.addEventListener('mousedown', (e) => e.preventDefault());
    this.toggleBtn.addEventListener('click', () => {
      if (this.onToggle) {
        this.onToggle();
      } else {
        this.toggle();
      }
    });
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
   * @param {object} [doc] - CodeMirror doc for line number lookup
   */
  update(highlights, doc) {
    this.highlights = highlights || [];
    this.doc = doc || this.doc;
    this.countBadge.textContent = String(this.highlights.length);
    this.render();
  }

  render() {
    this.content.innerHTML = '';

    if (this.highlights.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'annotations-empty';
      empty.innerHTML = 'No notes yet.<br><br>Select text or place cursor, then click <strong>+</strong> or press <strong>\u2318\u21E7L</strong> to add a note.';
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

      // Line reference + user note
      const textWrap = document.createElement('div');
      textWrap.className = 'annotation-text-wrap';

      // Show line number
      const lineRef = document.createElement('div');
      lineRef.className = 'annotation-text';
      let lineNum = '?';
      try {
        if (this.doc) lineNum = this.doc.lineAt(hl.from).number;
      } catch (e) { /* position may be stale */ }
      lineRef.textContent = hl.note ? `Line ${lineNum}` : `Line ${lineNum} — highlight`;
      textWrap.appendChild(lineRef);

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
      editBtn.title = 'Edit note text';
      editBtn.addEventListener('mousedown', (e) => e.preventDefault());
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._editNote(hl);
      });
      actions.appendChild(editBtn);

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'annotation-btn annotation-btn-delete';
      deleteBtn.textContent = '\u00D7'; // x
      deleteBtn.title = 'Remove highlight';
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
    const note = prompt('Annotation note:', highlight.note || '');
    if (note !== null && this.onAnnotationEdit) {
      this.onAnnotationEdit(highlight.id, note);
    }
  }

  toggle() {
    this.setCollapsed(!this.collapsed);
  }

  setCollapsed(collapsed) {
    this.collapsed = collapsed;
    this.element.classList.toggle('collapsed', this.collapsed);

    if (this.collapsed) {
      this.toggleBtn.innerHTML = '\u25B6';
      this.toggleBtn.title = 'Show Notes';
    } else {
      this.toggleBtn.innerHTML = '\u25C0';
      this.toggleBtn.title = 'Hide Notes';
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
