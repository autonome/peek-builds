/**
 * Highlights Module - Persistent text highlights with annotations.
 *
 * Manages highlight data (create, delete, update notes) and provides
 * CodeMirror decorations to render highlights in the editor.
 */

import { StateField, StateEffect } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';

// Effects for adding/removing highlights
export const addHighlightEffect = StateEffect.define();
export const removeHighlightEffect = StateEffect.define();
export const setHighlightsEffect = StateEffect.define();
export const updateHighlightNoteEffect = StateEffect.define();

// Highlight colors cycling palette
const HIGHLIGHT_COLORS = [
  'var(--base0A)', // yellow
  'var(--base0B)', // green
  'var(--base0C)', // cyan
  'var(--base0D)', // blue
  'var(--base0E)', // purple
  'var(--base09)', // orange
];

let colorIndex = 0;

/**
 * Get the next highlight color in the palette.
 */
export function nextHighlightColor() {
  const color = HIGHLIGHT_COLORS[colorIndex % HIGHLIGHT_COLORS.length];
  colorIndex++;
  return color;
}

/**
 * Generate a unique highlight ID.
 */
export function generateHighlightId() {
  return 'hl-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 8);
}

/**
 * Build a Decoration.mark for a highlight.
 */
function makeHighlightMark(hl) {
  // Convert CSS var to a translucent background
  // We use the color as a class suffix and handle in CSS
  return Decoration.mark({
    class: 'cm-highlight-mark',
    attributes: {
      'data-highlight-id': hl.id,
      'style': `background-color: color-mix(in srgb, ${hl.color} 30%, transparent); border-bottom: 2px solid ${hl.color};`,
    },
  });
}

/**
 * StateField that tracks highlights and produces decorations.
 */
export const highlightField = StateField.define({
  create() {
    return { highlights: [], decorations: Decoration.none };
  },

  update(value, tr) {
    let highlights = value.highlights;
    let changed = false;

    for (const effect of tr.effects) {
      if (effect.is(setHighlightsEffect)) {
        highlights = effect.value;
        changed = true;
      } else if (effect.is(addHighlightEffect)) {
        highlights = [...highlights, effect.value];
        changed = true;
      } else if (effect.is(removeHighlightEffect)) {
        highlights = highlights.filter(h => h.id !== effect.value);
        changed = true;
      } else if (effect.is(updateHighlightNoteEffect)) {
        const { id, note } = effect.value;
        highlights = highlights.map(h => h.id === id ? { ...h, note } : h);
        changed = true;
      }
    }

    // If document changed, adjust highlight positions
    if (tr.docChanged && !changed) {
      highlights = highlights.map(hl => {
        const newFrom = tr.changes.mapPos(hl.from, 1);
        const newTo = tr.changes.mapPos(hl.to, -1);
        if (newFrom >= newTo) return null; // Highlight collapsed
        return {
          ...hl,
          from: newFrom,
          to: newTo,
          text: tr.state.doc.sliceString(newFrom, newTo),
        };
      }).filter(Boolean);
      changed = true;
    }

    if (!changed) return value;

    // Rebuild decorations
    const decos = [];
    for (const hl of highlights) {
      if (hl.from >= 0 && hl.to <= tr.state.doc.length && hl.from < hl.to) {
        decos.push(makeHighlightMark(hl).range(hl.from, hl.to));
      }
    }

    // Sort by from position
    decos.sort((a, b) => a.from - b.from || a.startSide - b.startSide);

    return {
      highlights,
      decorations: Decoration.set(decos),
    };
  },

  provide: f => EditorView.decorations.from(f, val => val.decorations),
});

/**
 * Get current highlights from editor state.
 */
export function getHighlights(state) {
  return state.field(highlightField).highlights;
}

/**
 * Add a highlight to the editor.
 */
export function addHighlight(view, highlight) {
  view.dispatch({
    effects: addHighlightEffect.of(highlight),
  });
}

/**
 * Remove a highlight by ID.
 */
export function removeHighlight(view, highlightId) {
  view.dispatch({
    effects: removeHighlightEffect.of(highlightId),
  });
}

/**
 * Set all highlights (used for restoring from storage).
 */
export function setHighlights(view, highlights) {
  view.dispatch({
    effects: setHighlightsEffect.of(highlights),
  });
}

/**
 * Update a highlight's note.
 */
export function updateHighlightNote(view, highlightId, note) {
  view.dispatch({
    effects: updateHighlightNoteEffect.of({ id: highlightId, note }),
  });
}

/**
 * Serialize highlights for storage.
 */
export function serializeHighlights(highlights) {
  return highlights.map(hl => ({
    id: hl.id,
    from: hl.from,
    to: hl.to,
    text: hl.text,
    note: hl.note || '',
    color: hl.color,
  }));
}

/**
 * Deserialize highlights from storage, validating against doc length.
 */
export function deserializeHighlights(data, docLength) {
  if (!Array.isArray(data)) return [];
  return data.filter(hl =>
    hl && typeof hl.from === 'number' && typeof hl.to === 'number' &&
    hl.from >= 0 && hl.to <= docLength && hl.from < hl.to
  ).map(hl => ({
    id: hl.id || generateHighlightId(),
    from: hl.from,
    to: hl.to,
    text: hl.text || '',
    note: hl.note || '',
    color: hl.color || 'var(--base0A)',
  }));
}
