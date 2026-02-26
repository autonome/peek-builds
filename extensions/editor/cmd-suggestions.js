/**
 * Command Bar Suggestions - Inline ghost-text suggestions for the vim : command bar.
 *
 * As the user types, a dimmed ghost-text completion appears inline.
 * Tab accepts the suggestion or cycles to the next match.
 * Shift-Tab cycles backward. Enter executes the current input value.
 */

// Known ex commands ordered by usage frequency.
const COMMANDS = [
  'write', 'wq', 'quit',
  'edit',
  'set',
  'substitute',
  'nohlsearch',
  'undo', 'redo',
  'sort',
  'yank',
  'delete',
  'join',
  'global', 'vglobal',
  'normal',
  'marks', 'registers',
  'delmarks',
  'startinsert',
  'map', 'nmap', 'vmap', 'imap', 'omap',
  'noremap', 'nnoremap', 'vnoremap', 'inoremap', 'onoremap',
  'unmap',
  'mapclear', 'nmapclear', 'vmapclear', 'imapclear', 'omapclear',
  'setlocal', 'setglobal',
  'colorscheme',
];

/**
 * Get commands matching a prefix (case-insensitive, prefix must be non-empty).
 */
function getMatches(prefix) {
  if (!prefix) return [];
  const p = prefix.toLowerCase();
  return COMMANDS.filter(cmd => cmd.startsWith(p) && cmd !== p);
}

/**
 * Attach command bar suggestions to an input element.
 * @param {HTMLInputElement} inputEl
 * @returns {Function} cleanup
 */
export function attachSuggestions(inputEl) {
  // Ghost text element -- inserted right after the input in the DOM
  const ghostEl = document.createElement('span');
  ghostEl.className = 'vim-cmd-ghost';
  inputEl.insertAdjacentElement('afterend', ghostEl);

  // State
  let matches = [];     // Current matching commands for the user's prefix
  let matchIdx = 0;     // Which match is currently selected
  let userPrefix = '';   // The prefix the user typed (before any Tab cycling)
  let cycling = false;   // Whether we're in Tab-cycling mode
  let programmatic = false; // Flag to ignore input events from programmatic changes

  /**
   * Refresh matches and ghost from the current input value.
   * Called on every user-initiated input event.
   */
  function refresh() {
    const val = inputEl.value;
    userPrefix = val;
    cycling = false;
    matches = getMatches(val);
    matchIdx = 0;

    if (matches.length > 0) {
      ghostEl.textContent = matches[0].substring(val.length);
    } else {
      ghostEl.textContent = '';
    }
  }

  /**
   * Set the input to a matched command. Ghost clears since the command is accepted.
   */
  function acceptMatch(idx) {
    if (matches.length === 0) return;
    matchIdx = ((idx % matches.length) + matches.length) % matches.length;
    const cmd = matches[matchIdx];

    programmatic = true;
    inputEl.value = cmd;
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    programmatic = false;

    // Clear ghost -- the full command is now in the input
    ghostEl.textContent = '';
  }

  function onInput() {
    if (programmatic) return;
    refresh();
  }

  function onKeyDown(e) {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    e.stopPropagation();

    // Ensure we have matches to work with
    if (!cycling) {
      // Recompute from current input
      userPrefix = inputEl.value;
      matches = getMatches(userPrefix);
      matchIdx = 0;
    }
    if (matches.length === 0) return;

    if (e.shiftKey) {
      // Shift-Tab: cycle backward
      if (!cycling) {
        cycling = true;
        matchIdx = matches.length - 1;
      } else {
        matchIdx = (matchIdx - 1 + matches.length) % matches.length;
      }
      acceptMatch(matchIdx);
    } else {
      // Tab: accept current ghost or cycle forward
      if (!cycling) {
        // First Tab: accept the first suggestion
        cycling = true;
        acceptMatch(0);
      } else {
        // Subsequent Tab: cycle forward
        matchIdx = (matchIdx + 1) % matches.length;
        acceptMatch(matchIdx);
      }
    }
  }

  inputEl.addEventListener('input', onInput);
  inputEl.addEventListener('keydown', onKeyDown, true);
  refresh();

  return function cleanup() {
    inputEl.removeEventListener('input', onInput);
    inputEl.removeEventListener('keydown', onKeyDown, true);
    if (ghostEl.parentElement) ghostEl.remove();
  };
}

/**
 * Observe the CodeMirror container for vim command panels and attach suggestions.
 * @param {HTMLElement} container
 * @returns {Function} disconnect
 */
export function observeCommandBar(container) {
  let cleanup = null;
  let attachedInput = null;

  function tryAttach(root) {
    const panels = root.classList?.contains('cm-vim-panel')
      ? [root]
      : [...(root.querySelectorAll?.('.cm-vim-panel') || [])];

    for (const panel of panels) {
      const input = panel.querySelector('input');
      if (!input || input === attachedInput) continue;

      // Verify this is a : command dialog by checking sibling nodes for ":"
      const dialog = input.parentElement;
      if (!dialog) continue;
      let isCmd = false;
      for (const child of dialog.childNodes) {
        const txt = child.textContent?.trim();
        if (txt === ':') { isCmd = true; break; }
      }
      if (!isCmd) continue;

      if (cleanup) cleanup();
      attachedInput = input;
      cleanup = attachSuggestions(input);
      return;
    }
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) tryAttach(node);
      }
      for (const node of m.removedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE &&
            attachedInput && (node === attachedInput || node.contains?.(attachedInput))) {
          if (cleanup) { cleanup(); cleanup = null; }
          attachedInput = null;
        }
      }
    }
  });

  observer.observe(container, { childList: true, subtree: true });

  return function disconnect() {
    observer.disconnect();
    if (cleanup) { cleanup(); cleanup = null; }
    attachedInput = null;
  };
}
