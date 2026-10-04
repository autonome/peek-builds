/**
 * Keys for the tag-query block surface: `j`/`k` (and the arrow keys) move the
 * selected block; `zc` `zo` `za` `zM` `zR` fold and unfold blocks, with the same
 * key names the single-document editor uses (codemirror.js). Folding here never
 * enters edit mode.
 *
 * queryKey() is pure: key + state in, new state (or null for "not mine") out, so
 * it is tested without a DOM. attachQueryKeys() wires it to a surface.
 */

/**
 * @typedef {object} QueryKeyState
 * @property {number} selectedIndex selected block, -1 when there are no blocks
 * @property {number} blockCount
 * @property {Set<number>} folded indices of folded blocks
 * @property {boolean} pendingZ true after a `z`, waiting for the second key
 * @property {boolean} [inlineOpen] an inline editor is open; no key is handled here
 */

/** The key that adds a new item to the query. */
export const ADD_KEY = 'o';

/** Keys that move the selected block down and up (in any sort option; outside manual order the view switches to it). */
export const MOVE_DOWN_KEY = 'J';
export const MOVE_UP_KEY = 'K';

const FOLD_KEYS =new Set(['c', 'o', 'a', 'M', 'R']);

/**
 * Apply one key to the state.
 * @param {string} key KeyboardEvent.key
 * @param {QueryKeyState} state
 * @returns {QueryKeyState|null} the new state, or null when the key is not
 *   handled; null also ends a pending `z`
 */
export function queryKey(key, state) {
  // While an inline editor is open, every key belongs to it.
  if (state.inlineOpen) return null;
  const { blockCount } = state;
  const folded = new Set(state.folded);
  const next = (patch) => ({
    selectedIndex: state.selectedIndex,
    blockCount,
    folded,
    pendingZ: false,
    ...patch,
  });

  if (state.pendingZ) {
    if (!FOLD_KEYS.has(key)) return key === 'z' ? next({ pendingZ: true }) : null;
    const i = state.selectedIndex;
    const hasSelection = i >= 0 && i < blockCount;
    switch (key) {
      case 'M':
        for (let n = 0; n < blockCount; n++) folded.add(n);
        break;
      case 'R':
        folded.clear();
        break;
      case 'c':
        if (hasSelection) folded.add(i);
        break;
      case 'o':
        if (hasSelection) folded.delete(i);
        break;
      case 'a':
        if (hasSelection) {
          if (folded.has(i)) folded.delete(i);
          else folded.add(i);
        }
        break;
    }
    return next({});
  }

  switch (key) {
    case 'j':
    case 'ArrowDown':
      if (blockCount === 0) return next({});
      return next({ selectedIndex: Math.min(blockCount - 1, state.selectedIndex + 1) });
    case 'k':
    case 'ArrowUp':
      if (blockCount === 0) return next({});
      return next({ selectedIndex: Math.max(0, state.selectedIndex - 1) });
    case 'z':
      return next({ pendingZ: true });
    default:
      return null;
  }
}

/** Parts of a block that keep their own click behavior: affordances, links, fold controls, the editor. */
const CLICK_EXEMPT = 'a, button, input, select, textarea, .qs-block-left, .qs-link, .qs-fold, .qs-inline-editor, .cm-editor';

/**
 * True when a click on a block should open it for editing: a plain primary-button
 * click, not on one of the block's own controls and not ending a text selection.
 * @param {{button?: number, metaKey?: boolean, ctrlKey?: boolean, altKey?: boolean,
 *   shiftKey?: boolean, defaultPrevented?: boolean, target?: any}} e a MouseEvent
 * @param {boolean} [hasSelection] the document has a non-empty text selection
 */
export function isEditClick(e, hasSelection = false) {
  if (!e || e.defaultPrevented || hasSelection) return false;
  if ((e.button || 0) !== 0) return false;
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  return !e.target?.closest?.(CLICK_EXEMPT);
}

/** True for a target that takes its own typing (inputs, selects, inline editors). */
function isEditable(target) {
  if (!target || !target.tagName) return false;
  if (target.isContentEditable) return true;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return true;
  return !!target.closest?.('.cm-editor');
}

/**
 * Handle block keys on `doc` for `surface` (the interface of query-surface-dom.js
 * mountDomSurface). Ignored while a text field or inline editor has the keys.
 * @param {object} [inline] the inline editor controller: `isOpen()` and
 *   `open(index)`. <Enter> opens the selected block in it.
 * @param {{add?: () => void, move?: (delta: number) => void}} [actions] `move`
 *   runs on Shift+j / Shift+k with +1 / -1 (the caller switches to manual
 *   order first when another sort option is showing). `add` runs on `o` (add a new item, as
 *   vim's `o` opens a new line). Plain `o` is free here: the outer surface has no
 *   vim instance, and Cmd/Ctrl+O (open file) is excluded by the modifier check.
 * @returns {() => void} detach function
 */
export function attachQueryKeys(surface, doc = document, inline = null, actions = {}) {
  let pendingZ = false;

  const onKeyDown = (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
    if (isEditable(e.target)) return;
    if (inline?.isOpen()) return;
    if (e.key === 'Enter' && inline) {
      const at = surface.selectedIndex();
      pendingZ = false;
      if (at >= 0 && at < surface.blockCount()) {
        e.preventDefault();
        inline.open(at);
      }
      return;
    }

    if (e.key === ADD_KEY && actions.add) {
      pendingZ = false;
      e.preventDefault();
      actions.add();
      return;
    }

    // Move the selected block: Shift+j down, Shift+k up. Plain j/k select, and no
    // other binding in the view uses the capitals.
    if (actions.move && (e.key === MOVE_DOWN_KEY || e.key === MOVE_UP_KEY)) {
      pendingZ = false;
      e.preventDefault();
      actions.move(e.key === MOVE_DOWN_KEY ? 1 : -1);
      return;
    }

    const count = surface.blockCount();
    const folded = new Set();
    if (pendingZ) {
      for (let i = 0; i < count; i++) if (surface.isFolded(i)) folded.add(i);
    }
    const state = { selectedIndex: surface.selectedIndex(), blockCount: count, folded, pendingZ };
    const result = queryKey(e.key, state);
    pendingZ = result ? result.pendingZ : false;
    if (!result) return;
    e.preventDefault();

    if (result.selectedIndex !== state.selectedIndex) surface.select(result.selectedIndex);
    if (state.pendingZ) {
      for (let i = 0; i < count; i++) {
        const want = result.folded.has(i);
        if (want !== folded.has(i)) (want ? surface.fold(i) : surface.unfold(i));
      }
      surface.revealSelected();
    }
  };

  doc.addEventListener('keydown', onKeyDown);
  return () => doc.removeEventListener('keydown', onKeyDown);
}
