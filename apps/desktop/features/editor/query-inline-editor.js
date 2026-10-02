/**
 * Inline editor for the tag-query view: <Enter> on the selected block (or a click
 * on it) opens one embedded CodeMirror editor inside it, <Esc> or Mod-Enter closes
 * it (Mod-Enter is bound inside the editor; both write unsaved text first).
 *
 * - Text items edit their whole content; url and image items edit only their
 *   notes (the picture and the address stay static).
 * - Edits apply instantly: a debounced write to the datastore (same delay as the
 *   single-document editor), flushed when the block closes.
 * - While open, the editor borrows the window's one StatusLine (mode and
 *   position); the outer state is put back on close. No second status line.
 * - The window's <Esc> goes through handleEscape() because the preload consumes
 *   <Esc> before any DOM keydown, so CodeMirror's vim never sees it.
 *
 * escapeAction(), needsFlush(), editableText() and savePayload() are pure so the
 * decisions are unit tested; createInlineEditor() does the DOM work.
 */

import { notesOf } from './query-blocks.js';

export const AUTOSAVE_DELAY_MS = 1500;

/**
 * What <Esc> does, innermost layer first.
 * @param {{open: boolean, vimEnabled: boolean, vimInsertOrVisual: boolean}} state
 * @returns {'vim-normal'|'close'|'default'} `vim-normal`: leave insert/visual
 *   mode; `close`: close the inline editor; `default`: not ours, the window's
 *   own <Esc> behavior applies
 */
export function escapeAction(state) {
  if (!state || !state.open) return 'default';
  if (state.vimEnabled && state.vimInsertOrVisual) return 'vim-normal';
  return 'close';
}

/** CodeMirror key for "save now and leave edit mode": Cmd+Enter on macOS, Ctrl+Enter elsewhere. */
export const SAVE_KEY = 'Mod-Enter';

/**
 * Key bindings added to the inline editor. `run` returns true so CodeMirror
 * treats the key as handled and inserts no newline.
 * @param {() => void} onSave
 */
export function inlineKeymap(onSave) {
  return [{ key: SAVE_KEY, run: () => { onSave(); return true; } }];
}

/** True when text typed in the editor has not reached the datastore yet. */
export function needsFlush(savedText, currentText) {
  return savedText !== currentText;
}

/** The text an item's inline editor holds: content for text, notes otherwise. */
export function editableText(item) {
  if (item.type === 'text') return typeof item.content === 'string' ? item.content : '';
  return notesOf(item);
}

function titleOf(content) {
  const first = (content || '').split('\n')[0].trim();
  return first.replace(/^#+\s*/, '');
}

/**
 * The datastore update for an edit. Text items write content and the title from
 * its first line; url and image items write only the `notes` metadata field
 * (metadata is merged by the datastore, so other fields stay).
 */
export function savePayload(item, text) {
  if (item.type === 'text') return { content: text, title: titleOf(text) };
  return { metadata: { notes: text } };
}

/** The item as it is after the edit, for re-rendering its block. */
function applyEdit(item, text) {
  if (item.type === 'text') {
    item.content = text;
    item.title = titleOf(text);
    return;
  }
  let meta = {};
  if (item.metadata && typeof item.metadata === 'object') meta = { ...item.metadata };
  else if (typeof item.metadata === 'string') {
    try { meta = JSON.parse(item.metadata) || {}; } catch { meta = {}; }
  }
  meta.notes = text;
  item.metadata = meta;
}

/**
 * @param {object} deps
 * @param {object} deps.api window.app
 * @param {object} deps.surface mountDomSurface result
 * @param {object[]} deps.items items in the surface's block order
 * @param {import('./status-line.js').StatusLine} deps.statusLine the window's one
 *   status line
 * @param {boolean} deps.vimMode
 * @param {(index: number) => void} [deps.onBlockChanged] called after a block
 *   was re-rendered with edited text (the outline refreshes its titles)
 * @param {(item: object) => void} [deps.onClosed] called after the editor closed
 * @param {(item: object) => boolean} [deps.isDiscarded] true when the item no
 *   longer exists, so closing drops the pending text instead of writing it
 */
export function createInlineEditor({ api, surface, items, statusLine, vimMode, onBlockChanged, onClosed, isDiscarded }) {
  let cm = null; // codemirror.js module, loaded on first open
  let session = null; // the open editor, or null
  let opening = false;
  let savedStatus = null;

  async function save(s, text) {
    s.savedText = text;
    const payload = savePayload(s.item, text);
    try {
      const result = await api.datastore.updateItem(s.item.id, payload);
      if (result && result.success === false) {
        console.error('[editor] Inline autosave failed:', result.error);
        s.savedText = null; // not written; a later flush tries again
        return;
      }
      api.pubsub?.publish?.('editor:changed', { action: 'update', itemId: s.item.id });
    } catch (err) {
      console.error('[editor] Inline autosave error:', err);
      s.savedText = null;
    }
  }

  function flushSession(s) {
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    const text = cm.getContent(s.view);
    if (!needsFlush(s.savedText, text)) return Promise.resolve();
    return save(s, text);
  }

  function takeOverStatusLine() {
    if (!statusLine) return;
    savedStatus = statusLine.saveState();
    if (statusLine.container) statusLine.container.style.display = '';
    if (vimMode) {
      statusLine.show();
      statusLine.updateMode('normal');
    } else {
      statusLine.hide();
    }
  }

  function giveBackStatusLine() {
    if (!statusLine || !savedStatus) return;
    statusLine.restoreState(savedStatus);
    savedStatus = null;
  }

  /** @param {{caretAtEnd?: boolean}} [opts] caretAtEnd: caret after the last character (opened by a click) */
  async function open(index, opts = {}) {
    if (session || opening) return;
    const listed = items[index];
    if (!listed || !listed.id) return;
    opening = true;
    try {
      if (!cm) cm = await import('./codemirror.js');
      if (session) return;

      // The list may hold trimmed content; edit the full stored item.
      let item = listed;
      try {
        const result = await api.datastore.getItem(listed.id);
        if (result?.success && result.data) item = Object.assign(listed, result.data);
      } catch (err) {
        console.error('[editor] Failed to load item for inline edit:', err);
      }

      const block = surface.blockElement(index);
      if (!block) return;
      const text = editableText(item);
      const holder = document.createElement('div');
      holder.className = 'qs-inline-editor';
      (block.querySelector('.qs-block-main') || block).appendChild(holder);
      block.classList.add('editing', item.type === 'text' ? 'editing-text' : 'editing-notes');

      const s = { index, item, holder, block, view: null, timer: null, savedText: text };
      takeOverStatusLine();
      s.view = cm.createEditor({
        parent: holder,
        content: text,
        vimMode,
        showLineNumbers: false,
        // Save now (the close path flushes the pending autosave) and leave edit mode;
        // the block stays selected.
        extraKeys: inlineKeymap(() => { close(); }),
        onChange: (content) => {
          if (s.timer) clearTimeout(s.timer);
          s.timer = setTimeout(() => {
            s.timer = null;
            if (needsFlush(s.savedText, content)) save(s, content);
          }, AUTOSAVE_DELAY_MS);
        },
        onSelectionChange: (line, col) => statusLine?.updatePosition(line, col),
        onVimModeChange: (mode) => {
          if (vimMode) statusLine?.updateMode(mode);
        },
      });
      session = s;
      // The rendered block does not map back to a source offset, so a click puts the caret at the end.
      if (opts.caretAtEnd) s.view.dispatch({ selection: { anchor: s.view.state.doc.length } });
      cm.focus(s.view);
    } finally {
      opening = false;
    }
  }

  /** Close the inline editor, writing any unsaved text first. */
  function close() {
    const s = session;
    if (!s) return Promise.resolve();
    session = null;
    let flushed;
    if (isDiscarded?.(s.item)) {
      if (s.timer) {
        clearTimeout(s.timer);
        s.timer = null;
      }
      flushed = Promise.resolve();
    } else {
      flushed = flushSession(s);
    }
    const text = cm.getContent(s.view);
    cm.destroy(s.view);
    s.holder.remove();
    s.block.classList.remove('editing', 'editing-text', 'editing-notes');
    applyEdit(s.item, text);
    surface.rerender(s.index, s.item);
    onBlockChanged?.(s.index);
    giveBackStatusLine();
    surface.element.focus();
    onClosed?.(s.item);
    return flushed;
  }

  /** Write any unsaved text without touching the DOM (for window unload). */
  function flush() {
    return session ? flushSession(session) : Promise.resolve();
  }

  /**
   * The window's <Esc>: innermost layer first.
   * @returns {{handled: boolean}}
   */
  function handleEscape() {
    let vimInsertOrVisual = false;
    if (session && vimMode) {
      try {
        const vimState = cm.getCM(session.view)?.state?.vim;
        vimInsertOrVisual = !!(vimState && (vimState.insertMode || vimState.visualMode));
      } catch { /* vim state unavailable: treat as normal mode */ }
    }
    const action = escapeAction({ open: !!session, vimEnabled: vimMode, vimInsertOrVisual });
    if (action === 'vim-normal') {
      cm.Vim.handleKey(cm.getCM(session.view), '<Esc>');
      return { handled: true };
    }
    if (action === 'close') {
      close();
      return { handled: true };
    }
    return { handled: false };
  }

  return {
    open,
    close,
    flush,
    handleEscape,
    isOpen: () => !!session || opening,
    openIndex: () => (session ? session.index : -1),
    /** The text in the open editor, or null when none is open. */
    openText: () => (session ? cm.getContent(session.view) : null),
  };
}
