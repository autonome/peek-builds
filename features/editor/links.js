/**
 * Clickable Links Extension for CodeMirror 6
 *
 * Scans visible text for URLs and makes them Cmd+clickable.
 * Uses ViewPlugin + Decoration API for lightweight, viewport-only scanning.
 */

import { ViewPlugin, Decoration, EditorView } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

// Match http(s) URLs and bare www. URLs
// Avoid trailing punctuation that's likely sentence-ending
const URL_RE = /https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]|www\.[a-zA-Z0-9][^\s<>"')\]]+[^\s<>"')\].,;:!?]/g;

const linkMark = Decoration.mark({ class: 'cm-clickable-link' });

function buildDecorations(view) {
  const builder = new RangeSetBuilder();
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.sliceDoc(from, to);
    let match;
    URL_RE.lastIndex = 0;
    while ((match = URL_RE.exec(text)) !== null) {
      const start = from + match.index;
      const end = start + match[0].length;
      builder.add(start, end, linkMark);
    }
  }
  return builder.finish();
}

const linkPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildDecorations(view);
    }
    update(update) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      mousedown(event, view) {
        // Cmd+click (Mac) or Ctrl+click (other)
        if (!event.metaKey && !event.ctrlKey) return false;

        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return false;

        // Check if pos is inside a link decoration
        let url = null;
        this.decorations.between(pos, pos, (from, to) => {
          url = view.state.sliceDoc(from, to);
        });

        if (url) {
          event.preventDefault();
          // Ensure bare www. URLs get a protocol
          if (url.startsWith('www.')) {
            url = 'https://' + url;
          }
          window.open(url);
          return true;
        }
        return false;
      },
    },
  }
);

/** CSS styles for clickable links */
const linkTheme = EditorView.theme({
  '.cm-clickable-link': {
    textDecoration: 'underline',
    textDecorationColor: 'var(--base04)',
    textUnderlineOffset: '2px',
    cursor: 'default',
  },
  '.cm-clickable-link:hover': {
    textDecorationColor: 'var(--base0C)',
    color: 'var(--base0C)',
    cursor: 'pointer',
  },
});

/**
 * Extension that makes URLs in the editor Cmd+clickable.
 * Returns an array of extensions to spread into the editor config.
 */
export function clickableLinks() {
  return [linkPlugin, linkTheme];
}
