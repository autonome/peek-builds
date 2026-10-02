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
 */

const FOLD_KEYS = new Set(['c', 'o', 'a', 'M', 'R']);

/**
 * Apply one key to the state.
 * @param {string} key KeyboardEvent.key
 * @param {QueryKeyState} state
 * @returns {QueryKeyState|null} the new state, or null when the key is not
 *   handled; null also ends a pending `z`
 */
export function queryKey(key, state) {
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
 * @returns {() => void} detach function
 */
export function attachQueryKeys(surface, doc = document) {
  let pendingZ = false;

  const onKeyDown = (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
    if (isEditable(e.target)) return;

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
