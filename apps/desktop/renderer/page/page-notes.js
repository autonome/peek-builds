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
    // What an open editor held when the pane's DOM was last rebuilt: the text
    // as typed and where the caret sat. The rebuild throws the textarea away,
    // so without this the replacement comes back holding the datastore's copy
    // with the caret at the end.
    this._editorState = null;
    // True only while _render() is replacing the pane's DOM. Removing the
    // focused textarea fires its blur handler, and that blur must not be read
    // as the user leaving the note — see the handler.
    this._rebuilding = false;
    // In-memory draft for a note that hasn't been typed into yet. No datastore
    // row exists until the first non-empty keystroke (see _renderDraftItem),
    // so a draft that's abandoned empty (blur, teardown, click away) never
    // creates a row — this is what replaces the old eager-create-on-+-click.
    this._pendingDraft = null;

    // Build DOM
    this.element = document.createElement('div');
    this.element.className = 'notes-panel';
    this.element.id = 'notes-panel';

    // Header
    const header = document.createElement('div');
    header.className = 'panel-header';

    const toggle = document.createElement('button');
    toggle.className = 'panel-toggle';
    toggle.textContent = '\u25BC';
    toggle.title = 'Collapse';
    header.appendChild(toggle);

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

    // Content wrap (for collapse toggle)
    const bodyWrap = document.createElement('div');
    bodyWrap.className = 'panel-body-wrap';

    // Content area
    this.content = document.createElement('div');
    this.content.className = 'notes-body';
    bodyWrap.appendChild(this.content);
    this.element.appendChild(bodyWrap);

    // Toggle collapse
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const collapsed = toggle.classList.toggle('collapsed');
      bodyWrap.classList.toggle('collapsed', collapsed);
      toggle.title = collapsed ? 'Expand' : 'Collapse';
    });

    this._subsAttached = false;
  }

  /**
   * Attach pubsub subscriptions. Split from the constructor so the renderer
   * can build the DOM (cheap) at module load and defer the subscriptions
   * (which keep the pane reactive to background datastore changes) until
   * the window's chrome is actually needed. Idempotent.
   */
  init() {
    if (this._subsAttached) return;
    this._subsAttached = true;
    api.subscribe('item:created', () => this._reload());
    api.subscribe('item:deleted', () => this._reload());
    api.subscribe('tag:item-added', () => this._reload());
    api.subscribe('tag:item-removed', () => this._reload());
    api.subscribe('sync:pull-completed', () => this._reload());
  }

  /**
   * Load notes for a given URL. Called when the page navigates.
   * Flushes any pending draft first so retargeting (or clearing, via url=null)
   * can't silently drop text the user already typed.
   */
  async loadForUrl(url) {
    await this._flushPendingDraft();
    this._currentUrl = url;
    this._editingId = null;
    this._pendingEditId = null;
    await this._reload();
  }

  /**
   * Resolve the current draft (if any) before it's dropped: an empty/never-
   * typed-into draft is discarded with no datastore write; a draft that has
   * content is created (if it hasn't been already) and saved so the pane can
   * be torn down or retargeted without losing what was typed.
   */
  async _flushPendingDraft() {
    const draft = this._pendingDraft;
    this._pendingDraft = null;
    if (!draft) return;

    if (draft.committing && draft.createPromise) {
      await draft.createPromise;
    }

    if (draft.noteId) {
      await this._updateNote(draft.noteId, draft.value);
      return;
    }

    const value = draft.value || '';
    if (value.trim().length === 0) return; // never received non-empty input

    // Defensive fallback — the input handler should already have started a
    // create for any non-empty value, but cover the case it didn't.
    await this._createDraftNote(draft, value);
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
    // A draft is already open (its textarea keeps focus even across a second
    // + click, since the button's mousedown handler prevents the default
    // focus-out) — don't stomp it with a second in-flight draft.
    if (this._pendingDraft) return;

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

    // No datastore write yet — hold the draft in memory and render its
    // textarea (focused), same as a newly-created note used to look. The
    // item is created on the first non-empty keystroke, in the draft
    // textarea's 'input' handler (_renderDraftItem).
    this._pendingDraft = {
      anchor: {
        url: this._currentUrl,
        text: selectedText || ''
      },
      value: '',
      noteId: null,
      committing: false,
      createPromise: null
    };
    this._render();
  }

  /**
   * Create the datastore row for a draft and tag it as an annotation.
   * Returns the new item id, or null on failure (logged, not thrown).
   */
  async _createDraftNote(draft, content) {
    const tagId = await this._ensureAnnotationTag();
    if (!tagId) return null;

    try {
      const metadata = JSON.stringify({ anchor: draft.anchor });
      const result = await api.datastore.addItem('text', { content, metadata });
      if (result?.success && result.data?.id) {
        await api.datastore.tagItem(result.data.id, tagId);
        return result.data.id;
      }
    } catch (err) {
      console.error('[page-notes] Failed to add note:', err);
    }
    return null;
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

  /**
   * Remember what the open editor holds, so the rebuild can put it back.
   *
   * Any subscribed event — a note created elsewhere, a tag change, a completed
   * sync pull — rebuilds this pane's whole DOM, which is no reason for a note
   * someone is typing in to close.
   */
  _captureOpenEditor() {
    if (!this._editingId) return;
    const textarea = this.content.querySelector('.notes-textarea');
    if (!textarea) return;
    this._editorState = {
      id: this._editingId,
      value: textarea.value,
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd,
    };
  }

  _render() {
    this._captureOpenEditor();
    // Chrome fires the focused textarea's blur while it is still in the
    // document, as the subtree is being replaced — so the blur handler cannot
    // tell a rebuild from a real one by looking at the element. This flag is
    // what tells it.
    this._rebuilding = true;
    try {
      this._renderContent();
    } finally {
      this._rebuilding = false;
    }
  }

  _renderContent() {
    this.content.innerHTML = '';

    // A draft in progress renders even with zero saved notes — don't let the
    // empty-state branch hide it.
    if (this._notes.length === 0 && !this._pendingDraft) {
      const empty = document.createElement('div');
      empty.className = 'notes-empty';
      empty.textContent = 'No notes yet. Click + to add one.';
      this.content.appendChild(empty);
      this._pendingEditId = null;
      return;
    }

    if (this._pendingDraft) {
      this.content.appendChild(this._renderDraftItem(this._pendingDraft));
    }

    for (const note of this._notes) {
      // Once the draft's create lands, the note also exists in this._notes —
      // skip it here so it isn't shown twice (once as the live draft, once
      // as its own stale-content list entry) until the draft is committed.
      if (this._pendingDraft && this._pendingDraft.noteId === note.id) continue;

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
        // A rebuild that interrupted this editor left what was typed and where
        // the caret was; the datastore copy is a keystroke or two behind it.
        const restore = this._editorState && this._editorState.id === note.id
          ? this._editorState
          : null;

        const textarea = document.createElement('textarea');
        textarea.className = 'notes-textarea';
        textarea.value = restore ? restore.value : (note.content || '');
        textarea.placeholder = 'Write a note...';
        textarea.rows = 3;

        textarea.addEventListener('mousedown', (e) => e.stopPropagation());
        textarea.addEventListener('click', (e) => e.stopPropagation());

        // Save on blur
        textarea.addEventListener('blur', () => {
          const value = textarea.value;

          // The pane is being rebuilt underneath this editor, which is what
          // fired the blur — not the user leaving the note. Save what was
          // typed, but leave the note open so the rebuild puts the editor back
          // with the caret where it was. Closing here is what used to
          // interrupt someone mid-sentence whenever anything else changed.
          if (this._rebuilding) {
            this._editorState = {
              id: note.id,
              value,
              selectionStart: textarea.selectionStart,
              selectionEnd: textarea.selectionEnd,
            };
            this._updateNote(note.id, value);
            return;
          }

          this._editingId = null;
          this._pendingEditId = null;
          this._editorState = null;
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

        // Auto-focus after DOM insertion, at the caret the interrupted editor
        // had, or at the end for an editor being opened for the first time.
        requestAnimationFrame(() => {
          textarea.focus();
          textarea.selectionStart = restore ? restore.selectionStart : textarea.value.length;
          textarea.selectionEnd = restore ? restore.selectionEnd : textarea.value.length;
          if (restore && this._editorState === restore) this._editorState = null;
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
   * Render the draft item's DOM (anchor excerpt + textarea, focused). No
   * datastore item exists yet. The item is created on the textarea's first
   * non-empty 'input' event, not on blur — a blur-only commit would leave
   * typed text sitting only in the DOM, at risk of being lost to navigation
   * or teardown before the user tabs away.
   */
  _renderDraftItem(draft) {
    const anchorText = draft.anchor?.text || '';

    const item = document.createElement('div');
    item.className = 'notes-item notes-item-editing';

    const textWrap = document.createElement('div');
    textWrap.className = 'notes-text-wrap';

    if (anchorText) {
      const excerpt = document.createElement('div');
      excerpt.className = 'notes-anchor-text';
      const truncated = anchorText.length > 80
        ? anchorText.slice(0, 80) + '\u2026'
        : anchorText;
      excerpt.textContent = `\u201C${truncated}\u201D`;
      textWrap.appendChild(excerpt);
    }

    const textarea = document.createElement('textarea');
    textarea.className = 'notes-textarea';
    textarea.value = draft.value || '';
    textarea.placeholder = 'Write a note...';
    textarea.rows = 3;

    textarea.addEventListener('mousedown', (e) => e.stopPropagation());
    textarea.addEventListener('click', (e) => e.stopPropagation());

    // Create the datastore row on the first non-empty keystroke. Re-entry is
    // guarded by draft.committing/draft.noteId; a failed create (noteId
    // still null, committing reset to false) retries on the next keystroke.
    textarea.addEventListener('input', () => {
      const value = textarea.value;
      draft.value = value;
      if (draft.noteId || draft.committing) return;
      if (value.trim().length === 0) return;

      draft.committing = true;
      draft.createPromise = this._createDraftNote(draft, value).then((id) => {
        draft.committing = false;
        if (id) draft.noteId = id;
        // Deliberately no re-render here: the textarea already shows the
        // live, correct content, and rebuilding the DOM mid-keystroke would
        // steal focus/cursor. The note transitions to "existing" bookkeeping
        // only; blur (or teardown, via _flushPendingDraft) does the reload.
      });
    });

    // Save on blur, same as an existing note — but only if the draft ever
    // became a real item. An empty/never-typed-into draft is discarded with
    // no datastore write at all.
    textarea.addEventListener('blur', async () => {
      // Same rebuild case as an existing note. Keep the draft — discarding it
      // here would throw away text that has no datastore row yet.
      if (this._rebuilding) {
        draft.value = textarea.value;
        draft.selectionStart = textarea.selectionStart;
        draft.selectionEnd = textarea.selectionEnd;
        return;
      }

      if (draft.committing && draft.createPromise) {
        await draft.createPromise;
      }

      if (draft.noteId) {
        this._pendingDraft = null;
        await this._updateNote(draft.noteId, draft.value);
        await this._reload();
      } else {
        this._pendingDraft = null;
        this._render();
      }
    });

    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        textarea.blur();
      }
    });

    textWrap.appendChild(textarea);
    item.appendChild(textWrap);

    // Auto-focus after DOM insertion, same as a newly-created note used to —
    // at the caret a rebuild interrupted, if there was one.
    requestAnimationFrame(() => {
      textarea.focus();
      const hasCaret = typeof draft.selectionStart === 'number';
      textarea.selectionStart = hasCaret ? draft.selectionStart : textarea.value.length;
      textarea.selectionEnd = hasCaret ? draft.selectionEnd : textarea.value.length;
      draft.selectionStart = undefined;
      draft.selectionEnd = undefined;
    });

    return item;
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
