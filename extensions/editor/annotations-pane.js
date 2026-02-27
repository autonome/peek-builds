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
    this.onToggle = options.onToggle; // callback: () => void — layout handles state
    this.collapsed = false; // Layout owns this state
    this.highlights = [];

    this.element = document.createElement('div');
    this.element.className = 'annotations-pane';

    // Header
    this.header = document.createElement('div');
    this.header.className = 'sidebar-header';

    const title = document.createElement('span');
    title.className = 'sidebar-title';
    title.textContent = 'Annotations';
    this.header.appendChild(title);

    const countBadge = document.createElement('span');
    countBadge.className = 'annotations-count';
    countBadge.textContent = '0';
    this.countBadge = countBadge;
    this.header.appendChild(countBadge);

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
  update(highlights) {
    this.highlights = highlights || [];
    this.countBadge.textContent = String(this.highlights.length);
    this.render();
  }

  render() {
    this.content.innerHTML = '';

    if (this.highlights.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'annotations-empty';
      empty.textContent = 'No highlights yet. Select text and use Cmd+H to highlight.';
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

      const text = document.createElement('div');
      text.className = 'annotation-text';
      text.textContent = hl.text.length > 80 ? hl.text.substring(0, 80) + '...' : hl.text;
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
      editBtn.textContent = 'Note';
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

  /**
   * Set collapsed visual state. Called by layout — pane does NOT own this state.
   */
  setCollapsed(collapsed) {
    this.collapsed = collapsed;
    this.element.classList.toggle('collapsed', collapsed);
    if (collapsed) {
      this.toggleBtn.innerHTML = '\u25B6';
      this.toggleBtn.title = 'Show Annotations';
    } else {
      this.toggleBtn.innerHTML = '\u25C0';
      this.toggleBtn.title = 'Hide Annotations';
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
