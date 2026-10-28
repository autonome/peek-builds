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
 * Whether an arrow key at this caret leaves the editor for the neighbouring
 * block: ArrowUp with the caret on the first visual line, ArrowDown on the last,
 * and no selection. Anywhere else the key moves the caret as usual.
 * @param {'up'|'down'} dir
 * @param {{from: number, to: number}} selection main selection range
 * @param {boolean} onFirstLine the caret is on the first visual line
 * @param {boolean} onLastLine the caret is on the last visual line
 */
export function isAtEdge(dir, selection, onFirstLine, onLastLine) {
  if (!selection || selection.from !== selection.to) return false;
  return dir === 'up' ? !!onFirstLine : !!onLastLine;
}

/**
 * Whether the caret sits on the first and last visual line (wrapped lines count
 * separately), from the rendered geometry; without geometry (not laid out) the
 * document's own lines decide.
 * @returns {{first: boolean, last: boolean}}
 */
export function caretLineEdges(view) {
  const doc = view.state.doc;
  const head = view.state.selection.main.head;
  const line = doc.lineAt(head);
  let first = line.number === 1;
  let last = line.number === doc.lines;
  try {
    const at = view.coordsAtPos(head);
    const start = view.coordsAtPos(0);
    const end = view.coordsAtPos(doc.length);
    if (at && start && end) {
      first = Math.abs(at.top - start.top) < 1;
      last = Math.abs(at.bottom - end.bottom) < 1;
    }
  } catch { /* keep the line-number answer */ }
  return { first, last };
}

/**
 * The horizontal goal (x coordinate in pixels) for the next block crossing. It
 * stays in force only while the caret is exactly where the previous crossing
 * left it, in the same editor; any other caret movement, typing, click or
 * reopening makes the caret's own x the new goal.
 * @param {{x: number, view: any, head: number}|null} landing the previous crossing's goal and where it put the caret
 * @param {any} view the editor the key was pressed in
 * @param {number} head caret position now
 * @param {number|null} caretX caret's x coordinate now, null when not measurable
 * @returns {number|null}
 */
export function stickyGoal(landing, view, head, caretX) {
  if (landing && landing.view === view && landing.head === head) return landing.x;
  return typeof caretX === 'number' && Number.isFinite(caretX) ? caretX : null;
}

/**
 * Where the caret lands in the block it crosses into: on its first line when
 * moving down, its last line when moving up, at the goal x clamped to that
 * line. Without a goal it is the start (down) or end (up) of the text.
 * @param {'up'|'down'} dir
 * @param {number} docLength length of the new block's text
 * @param {number|null} goalX
 * @param {(x: number, line: 'first'|'last') => number|null} posAtX document
 *   position nearest x on that visual line, null when not measurable
 * @returns {number}
 */
export function landingPos(dir, docLength, goalX, posAtX) {
  const fallback = dir === 'down' ? 0 : docLength;
  if (goalX == null) return fallback;
  const pos = posAtX(goalX, dir === 'down' ? 'first' : 'last');
  if (typeof pos !== 'number' || !Number.isFinite(pos)) return fallback;
  return Math.max(0, Math.min(docLength, pos));
}

/** The caret's x coordinate in the view, or null when the view is not laid out. */
function caretX(view) {
  try {
    return view.coordsAtPos(view.state.selection.main.head)?.left ?? null;
  } catch { return null; }
}

/** Document position nearest `x` on the first or last visual line of the view, or null. */
function posAtLineX(view, x, line) {
  try {
    const c = view.coordsAtPos(line === 'first' ? 0 : view.state.doc.length);
    if (!c) return null;
    return view.posAtCoords({ x, y: (c.top + c.bottom) / 2 });
  } catch { return null; }
}

/**
 * Key bindings added to the inline editor. `run` returns true so CodeMirror
 * treats the key as handled and inserts no newline. With `onEdge`, ArrowUp and
 * ArrowDown at the text's edge call it with 'up' or 'down' and the editor view;
 * it returns true when it moved to another block, false (or when the caret is
 * not at the edge) lets the key move the caret as usual.
 * @param {() => void} onSave
 * @param {(dir: 'up'|'down', view: any) => boolean} [onEdge]
 */
export function inlineKeymap(onSave, onEdge) {
  const keys = [{ key: SAVE_KEY, run: () => { onSave(); return true; } }];
  if (onEdge) {
    for (const [key, dir] of [['ArrowUp', 'up'], ['ArrowDown', 'down']]) {
      keys.push({
        key,
        run: (view) => {
          const { from, to } = view.state.selection.main;
          const { first, last } = caretLineEdges(view);
          if (!isAtEdge(dir, { from, to }, first, last)) return false;
          return onEdge(dir, view) === true;
        },
      });
    }
  }
  return keys;
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
 * @param {(item: object, openedText: string) => void} [deps.onClosed] called after the editor closed, with the
 *   text the editor held when it opened
 * @param {(item: object) => boolean} [deps.isDiscarded] true when the item no
 *   longer exists, so closing drops the pending text instead of writing it
 * @param {(dir: 'up'|'down', index: number, goalX: number|null) => boolean} [deps.onEdge]
 *   arrow key at the editor's edge; returns true when it moved to the neighbouring
 *   block. It opens that block with `open(target, {goalX, dir})` so the caret keeps
 *   its horizontal position.
 */
export function createInlineEditor({ api, surface, items, statusLine, vimMode, onBlockChanged, onClosed, isDiscarded, onEdge }) {
  let cm = null; // codemirror.js module, loaded on first open
  let session = null; // the open editor, or null
  let opening = false;
  let savedStatus = null;
  let landing = null; // {x, view, head}: goal x of the last block crossing and where it left the caret

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

  /**
   * @param {{caretAtEnd?: boolean, goalX?: number|null, dir?: 'up'|'down'}} [opts]
   *   caretAtEnd: caret after the last character (opened by a click);
   *   goalX + dir: opened by crossing from a neighbour, caret at x on its first
   *   (down) or last (up) line
   */
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

      const s = { index, item, holder, block, view: null, timer: null, savedText: text, openedText: text };
      takeOverStatusLine();
      s.view = cm.createEditor({
        parent: holder,
        content: text,
        vimMode,
        showLineNumbers: false,
        // Save now (the close path flushes the pending autosave) and leave edit mode;
        // the block stays selected.
        extraKeys: inlineKeymap(() => { close(); }, onEdge && ((dir, view) => {
          const head = view.state.selection.main.head;
          const goalX = stickyGoal(landing, view, head, caretX(view));
          return onEdge(dir, s.index, goalX);
        })),
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
      // Coming from the block below (ArrowUp) also lands at the end; from above, at the start.
      if (opts.dir) {
        const len = s.view.state.doc.length;
        const pos = landingPos(opts.dir, len, opts.goalX ?? null, (x, line) => posAtLineX(s.view, x, line));
        s.view.dispatch({ selection: { anchor: pos } });
        landing = opts.goalX == null ? null : { x: opts.goalX, view: s.view, head: pos };
      } else {
        landing = null;
        if (opts.caretAtEnd) s.view.dispatch({ selection: { anchor: s.view.state.doc.length } });
      }
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
    onClosed?.(s.item, s.openedText);
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
