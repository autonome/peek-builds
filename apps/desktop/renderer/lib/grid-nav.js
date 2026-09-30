/**
 * Shared grid navigation, toolbar setup, and view preferences
 * for vim-style hjkl/arrow grid navigation across card views.
 */

// ── Grid Navigation ─────────────────────────────────────────────────────

/**
 * Get all cards in the current view
 */
export const getCards = () => {
  return Array.from(document.querySelectorAll('.cards peek-card'));
};

/**
 * Update visual selection on cards
 * @param {object} state - must have `selectedIndex` property
 */
export const updateSelection = (state) => {
  const cards = getCards();
  cards.forEach((card, i) => {
    card.selected = (i === state.selectedIndex);
  });

  const selected = cards[state.selectedIndex];
  if (selected) {
    selected.focus();
    selected.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
};

/**
 * Activate the currently selected card (trigger click)
 * @param {object} state - must have `selectedIndex` property
 */
export const activateSelected = (state) => {
  const cards = getCards();
  const selected = cards[state.selectedIndex];
  if (selected) {
    selected.click();
  }
};

/**
 * Toggle the checkbox (tag-action-toggle) on the currently selected card.
 * Finds the first .tag-action-toggle button on the card and clicks it,
 * reusing the existing affordance toggle logic.
 *
 * @param {object} state - must have `selectedIndex` property
 * @returns {boolean} true if a toggle was found and clicked
 */
export const toggleSelectedCheckbox = (state) => {
  const cards = getCards();
  const selected = cards[state.selectedIndex];
  if (!selected) return false;

  const toggleBtn = selected.querySelector('.tag-action-toggle');
  if (toggleBtn) {
    toggleBtn.click();
    return true;
  }
  return false;
};

/**
 * Get number of columns in the grid based on card positions
 */
export const getGridColumns = (cards) => {
  if (cards.length < 2) return 1;
  const firstTop = cards[0].getBoundingClientRect().top;
  for (let i = 1; i < cards.length; i++) {
    if (cards[i].getBoundingClientRect().top !== firstTop) {
      return i;
    }
  }
  return cards.length;
};

/**
 * Create a keydown handler for vim-style grid navigation.
 *
 * @param {object} state - must have `selectedIndex` property
 * @param {object} [callbacks] - optional hooks
 * @param {function} [callbacks.onActivate] - called on Enter (default: activateSelected)
 * @param {function} [callbacks.onEscape] - called on Escape key
 * @param {function} [callbacks.shouldIgnore] - return true to skip handling entirely
 * @param {function} [callbacks.isInputFocused] - return true when an input has focus
 *   (h/l and arrow-left/right will be skipped so cursor can move in the input;
 *    only arrow-up/down/Enter are handled when input is focused)
 */
export const createKeydownHandler = (state, callbacks = {}) => {
  return (e) => {
    // Let the consumer bail out entirely (e.g. when a create-input is focused)
    if (callbacks.shouldIgnore && callbacks.shouldIgnore(e)) return;

    const inputFocused = callbacks.isInputFocused ? callbacks.isInputFocused() : false;

    // Don't intercept most keys when an input is focused
    if (inputFocused && !['ArrowUp', 'ArrowDown', 'Enter'].includes(e.key)) {
      return;
    }

    const cards = getCards();
    if (cards.length === 0) return;

    const cols = getGridColumns(cards);

    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        e.preventDefault();
        if (state.selectedIndex + cols < cards.length) {
          state.selectedIndex += cols;
          updateSelection(state);
        }
        break;
      case 'k':
      case 'ArrowUp':
        e.preventDefault();
        if (state.selectedIndex - cols >= 0) {
          state.selectedIndex -= cols;
          updateSelection(state);
        }
        break;
      case 'h':
      case 'ArrowLeft':
        if (inputFocused) return;
        e.preventDefault();
        if (state.selectedIndex > 0) {
          state.selectedIndex--;
          updateSelection(state);
        }
        break;
      case 'l':
      case 'ArrowRight':
        if (inputFocused) return;
        e.preventDefault();
        if (state.selectedIndex < cards.length - 1) {
          state.selectedIndex++;
          updateSelection(state);
        }
        break;
      case 'Enter':
        // A focused interactive `<peek-card>` turns Enter into its own
        // `card-click` before the event reaches the document (and marks it
        // consumed). Activating the selected card here as well fired the
        // activation twice per keypress — for a Spaces card, two concurrent
        // `switch space` runs that raced each other into a double open.
        if (e.defaultPrevented) return;
        e.preventDefault();
        if (callbacks.onActivate) {
          callbacks.onActivate();
        } else {
          activateSelected(state);
        }
        break;
      case 'x':
        if (inputFocused) return;
        e.preventDefault();
        toggleSelectedCheckbox(state);
        break;
      case 'Escape':
        if (callbacks.onEscape) {
          e.preventDefault();
          callbacks.onEscape();
        }
        break;
    }
  };
};

// ── Toolbar Setup ───────────────────────────────────────────────────────

/**
 * Wire up a grid-toolbar element with sort/view-mode change events.
 *
 * @param {object} options
 * @param {object} options.viewPrefs - viewPrefs object (mutated in place)
 * @param {Array}  options.sortOptions - sort option descriptors
 * @param {function} options.onSave - called after prefs change to persist
 * @param {function} options.onRender - called after prefs change to re-render
 */
export const setupToolbar = ({ viewPrefs, sortOptions, onSave, onRender }) => {
  const toolbar = document.querySelector('.grid-toolbar');
  const container = document.querySelector('.cards');
  if (!toolbar) return;

  toolbar.sortOptions = sortOptions;
  toolbar.sortBy = viewPrefs.sortBy;
  toolbar.sortDirection = viewPrefs.sortDirection;
  toolbar.viewMode = viewPrefs.viewMode;
  container.viewMode = viewPrefs.viewMode;

  toolbar.addEventListener('sort-change', (e) => {
    viewPrefs.sortBy = e.detail.sortBy;
    viewPrefs.sortDirection = e.detail.sortDirection;
    onSave();
    onRender();
  });

  toolbar.addEventListener('view-mode-change', (e) => {
    viewPrefs.viewMode = e.detail.mode;
    container.viewMode = e.detail.mode;
    onSave();
    onRender();
  });
};

// ── View Preferences ────────────────────────────────────────────────────

/**
 * Create a view-preferences helper bound to a localStorage key.
 *
 * @param {string} storageKey - localStorage key
 * @param {object} defaults - default prefs (viewMode, sortBy, sortDirection)
 * @returns {{ prefs: object, load: function, save: function }}
 */
export const createViewPrefs = (storageKey, defaults) => {
  const prefs = { ...defaults };

  const load = () => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        Object.assign(prefs, JSON.parse(stored));
      }
    } catch (err) {
      console.log(`[grid-nav] Failed to load viewPrefs (${storageKey}):`, err);
    }
  };

  const save = () => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(prefs));
    } catch (err) {
      console.log(`[grid-nav] Failed to save viewPrefs (${storageKey}):`, err);
    }
  };

  return { prefs, load, save };
};
