/**
 * In-place editing of a sheet name: swaps a heading's text for a text box.
 * Enter or clicking away saves, Esc cancels. Used by the sheet header and the
 * sheets card grid, which pass their own save function.
 */

import { resolveNameEdit } from './sheet-commands.js';

/** How long after an Esc cancel the window still counts as "handled it". */
const ESC_GRACE_MS = 300;

let activeEdits = 0;
let lastCancelAt = 0;

/**
 * True while a name is being edited, and just after an Esc cancelled one.
 * The window's Esc handler asks this so Esc ends only the edit, not the sheet
 * (the keydown can finish the edit before main's Esc query arrives).
 */
export const isNameEditing = () =>
  activeEdits > 0 || Date.now() - lastCancelAt < ESC_GRACE_MS;

/**
 * @param {HTMLElement} el heading whose text is the name
 * @param {object} opts
 * @param {string} opts.name the saved name
 * @param {(name: string) => (void|Promise<void>)} opts.save called with the new name
 * @param {() => void} [opts.onDone] called after the edit ends either way
 */
export const startNameEdit = (el, { name, save, onDone }) => {
  if (el.querySelector('input')) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'inline-name-input';
  input.value = name;
  el.textContent = '';
  el.appendChild(input);
  activeEdits++;
  input.focus();
  input.select();

  let finished = false;
  const finish = async (cancelled) => {
    if (finished) return;
    finished = true;
    activeEdits--;
    if (cancelled) lastCancelAt = Date.now();
    const result = resolveNameEdit(name, input.value, cancelled);
    el.textContent = result.name;
    if (result.save) await save(result.name);
    if (onDone) onDone();
  };

  // Keys and presses belong to the box: the card and the grid must not see them.
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(false);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(true);
    }
  });
  for (const type of ['click', 'dblclick', 'pointerdown', 'mousedown']) {
    input.addEventListener(type, (e) => e.stopPropagation());
  }
  input.addEventListener('blur', () => finish(false));
};
