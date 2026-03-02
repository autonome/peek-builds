/**
 * Page Notes Pane - displays persistent annotations anchored to a URL.
 * Built-in panel in page.js that participates in navbar show/hide lifecycle.
 * Each note is a datastore item of type 'text' tagged 'annotation' with
 * metadata.anchor.url matching the current page URL.
 */

import api from '../api.js';

export class PageNotesPane {
  constructor() {
    this._notes = [];
    this._annotationTagId = null;
    this._currentUrl = null;
    this._editingId = null;
    this._pendingEditId = null;

    // Build DOM
    this.element = document.createElement('div');
    this.element.className = 'notes-panel';
    this.element.id = 'notes-panel';

    // Header
    const header = document.createElement('div');
    header.className = 'panel-header';

    const title = document.createElement('span');
    title.className = 'panel-title';
    title.textContent = 'Notes';
    header.appendChild(title);

    this.countBadge = document.createElement('span');
    this.countBadge.className = 'notes-count';
    this.countBadge.textContent = '0';
    header.appendChild(this.countBadge);

    const addBtn = document.createElement('button');
    addBtn.className = 'notes-add-btn';
    addBtn.textContent = '+';
    addBtn.title = 'Add note for this page';
    addBtn.addEventListener('mousedown', (e) => e.preventDefault());
    addBtn.addEventListener('click', () => this._addNote());
    header.appendChild(addBtn);

    this.element.appendChild(header);

    // Content area
    this.content = document.createElement('div');
    this.content.className = 'notes-body';
    this.element.appendChild(this.content);

    // Subscribe to relevant events
    api.subscribe('item:created', () => this._reload(), api.scopes.GLOBAL);
    api.subscribe('item:deleted', () => this._reload(), api.scopes.GLOBAL);
    api.subscribe('tag:item-added', () => this._reload(), api.scopes.GLOBAL);
    api.subscribe('tag:item-removed', () => this._reload(), api.scopes.GLOBAL);
    api.subscribe('sync:pull-completed', () => this._reload(), api.scopes.GLOBAL);
  }

  /**
   * Load notes for a given URL. Called when the page navigates.
   */
  async loadForUrl(url) {
    this._currentUrl = url;
    this._editingId = null;
    this._pendingEditId = null;
    await this._reload();
  }

  async _ensureAnnotationTag() {
    if (this._annotationTagId) return this._annotationTagId;
    try {
      const result = await api.datastore.getOrCreateTag('annotation');
      if (result?.success && result.data?.tag) {
        this._annotationTagId = result.data.tag.id;
      }
    } catch (err) {
      console.error('[page-notes] Failed to get annotation tag:', err);
    }
    return this._annotationTagId;
  }

  async _reload() {
    if (!this._currentUrl) {
      this._notes = [];
      this._updateCount();
      this._render();
      return;
    }

    const tagId = await this._ensureAnnotationTag();
    if (!tagId) {
      this._notes = [];
      this._updateCount();
      this._render();
      return;
    }

    try {
      const result = await api.datastore.getItemsByTag(tagId);
      if (result?.success && result.data) {
        // Filter to notes anchored to the current URL
        this._notes = result.data.filter(item => {
          try {
            const meta = typeof item.metadata === 'string'
              ? JSON.parse(item.metadata)
              : (item.metadata || {});
            return meta.anchor && meta.anchor.url === this._currentUrl;
          } catch {
            return false;
          }
        });
        // Sort by creation time, newest first
        this._notes.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      } else {
        this._notes = [];
      }
    } catch (err) {
      console.error('[page-notes] Failed to load notes:', err);
      this._notes = [];
    }

    this._updateCount();
    this._render();
  }

  _updateCount() {
    this.countBadge.textContent = String(this._notes.length);
    this.countBadge.style.display = this._notes.length > 0 ? '' : 'none';
  }

  async _addNote() {
    if (!this._currentUrl) return;

    const tagId = await this._ensureAnnotationTag();
    if (!tagId) return;

    // Get selected text from the webview if possible
    let selectedText = '';
    try {
      const webview = document.getElementById('content');
      if (webview) {
        selectedText = await webview.executeJavaScript(
          'window.getSelection().toString().trim().slice(0, 500)'
        );
      }
    } catch {
      // webview not ready
    }

    try {
      const metadata = JSON.stringify({
        anchor: {
          url: this._currentUrl,
          text: selectedText || ''
        }
      });

      const result = await api.datastore.addItem('text', {
        content: '',
        metadata
      });

      if (result?.success && result.data?.id) {
        // Tag it as annotation
        await api.datastore.tagItem(result.data.id, tagId);
        // Set pending edit to auto-open textarea
        this._pendingEditId = result.data.id;
        await this._reload();
      }
    } catch (err) {
      console.error('[page-notes] Failed to add note:', err);
    }
  }

  async _updateNote(noteId, content) {
    try {
      await api.datastore.updateItem(noteId, { content });
    } catch (err) {
      console.error('[page-notes] Failed to update note:', err);
    }
  }

  async _deleteNote(noteId) {
    try {
      await api.datastore.deleteItem(noteId);
      await this._reload();
    } catch (err) {
      console.error('[page-notes] Failed to delete note:', err);
    }
  }

  _parseMeta(item) {
    try {
      return typeof item.metadata === 'string'
        ? JSON.parse(item.metadata)
        : (item.metadata || {});
    } catch {
      return {};
    }
  }

  _render() {
    this.content.innerHTML = '';

    if (this._notes.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'notes-empty';
      empty.textContent = 'No notes yet. Click + to add one.';
      this.content.appendChild(empty);
      this._pendingEditId = null;
      return;
    }

    for (const note of this._notes) {
      const isEditing = this._editingId === note.id || this._pendingEditId === note.id;
      const meta = this._parseMeta(note);
      const anchorText = meta.anchor?.text || '';

      const item = document.createElement('div');
      item.className = 'notes-item';
      if (isEditing) item.classList.add('notes-item-editing');

      // Text content wrapper
      const textWrap = document.createElement('div');
      textWrap.className = 'notes-text-wrap';

      // Anchor text excerpt (if any)
      if (anchorText) {
        const excerpt = document.createElement('div');
        excerpt.className = 'notes-anchor-text';
        const truncated = anchorText.length > 80
          ? anchorText.slice(0, 80) + '\u2026'
          : anchorText;
        excerpt.textContent = `\u201C${truncated}\u201D`;
        textWrap.appendChild(excerpt);
      }

      // Note content preview (when not editing)
      if (!isEditing && note.content) {
        const preview = document.createElement('div');
        preview.className = 'notes-content-preview';
        preview.textContent = note.content;
        textWrap.appendChild(preview);
      }

      // Click header area to toggle editing
      textWrap.addEventListener('mousedown', (e) => e.preventDefault());
      textWrap.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this._editingId === note.id) {
          this._editingId = null;
        } else {
          this._editingId = note.id;
        }
        this._render();
      });

      // Inline textarea editor
      if (isEditing) {
        const textarea = document.createElement('textarea');
        textarea.className = 'notes-textarea';
        textarea.value = note.content || '';
        textarea.placeholder = 'Write a note...';
        textarea.rows = 3;

        textarea.addEventListener('mousedown', (e) => e.stopPropagation());
        textarea.addEventListener('click', (e) => e.stopPropagation());

        // Save on blur
        textarea.addEventListener('blur', () => {
          const value = textarea.value;
          this._editingId = null;
          this._pendingEditId = null;
          this._updateNote(note.id, value);
          this._render();
        });

        // Escape handled via IPC (see page.js onEscape handler)
        // But also handle it here for textarea-specific case
        textarea.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            textarea.blur();
          }
        });

        textWrap.appendChild(textarea);

        // Auto-focus after DOM insertion
        requestAnimationFrame(() => {
          textarea.focus();
          textarea.selectionStart = textarea.value.length;
          textarea.selectionEnd = textarea.value.length;
        });
      }

      item.appendChild(textWrap);

      // Delete button with confirm pattern
      const actions = document.createElement('div');
      actions.className = 'notes-actions';

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'notes-btn-delete';
      deleteBtn.textContent = '\u00D7';
      deleteBtn.title = 'Delete note';
      let confirmPending = false;
      let confirmTimeout = null;
      deleteBtn.addEventListener('mousedown', (e) => e.preventDefault());
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirmPending) {
          clearTimeout(confirmTimeout);
          this._deleteNote(note.id);
        } else {
          confirmPending = true;
          deleteBtn.textContent = '?';
          deleteBtn.classList.add('notes-btn-confirm');
          confirmTimeout = setTimeout(() => {
            confirmPending = false;
            deleteBtn.textContent = '\u00D7';
            deleteBtn.classList.remove('notes-btn-confirm');
          }, 3000);
        }
      });
      actions.appendChild(deleteBtn);

      item.appendChild(actions);
      this.content.appendChild(item);
    }

    // Transfer pending edit to editing state
    if (this._pendingEditId) {
      this._editingId = this._pendingEditId;
      this._pendingEditId = null;
    }
  }

  /**
   * Check if a textarea in the notes panel is currently focused.
   * Used by the escape handler in page.js.
   */
  hasActiveTextarea() {
    const active = document.activeElement;
    return active && active.classList.contains('notes-textarea')
      && this.element.contains(active);
  }

  /**
   * Blur the active textarea (saves via blur handler).
   */
  blurActiveTextarea() {
    const active = document.activeElement;
    if (active && active.classList.contains('notes-textarea')) {
      active.blur();
    }
  }

  getElement() {
    return this.element;
  }
}
