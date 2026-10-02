/**
 * Tag-query outer surface, CodeMirror trial: one document whose text is the
 * item blocks, each block's title line shown through a block widget, body lines
 * left as document text. Block selection is a cursor position, block fold is a
 * foldEffect over the block's body range.
 *
 * Same interface as query-surface-dom.js:
 *   select(index), fold(index), unfold(index), foldAll(), unfoldAll(), blockCount()
 *
 * The block <-> document-range mapping (buildBlockDoc, blockIndexAt, clampIndex)
 * is pure and has no CodeMirror import at module scope, so it can be unit
 * tested in node. CodeMirror is loaded inside mountCmSurface().
 */

import { blockTitle, syntheticItems } from './query-surface-dom.js';

/**
 * Lay items out as document text: title line, body lines, blank separator line.
 * @param {Array<{title?:string,content?:string,url?:string}>} items
 * @returns {{text:string, blocks:Array<{titleFrom:number,titleTo:number,bodyFrom:number,to:number}>}}
 *   per block: the title line span, the offset where the body's fold range
 *   starts (end of the title line), and the end of the block's last line.
 *   `bodyFrom === to` when the block has no body lines (nothing to fold).
 */
export function buildBlockDoc(items) {
  const parts = [];
  const blocks = [];
  let pos = 0;
  items.forEach((item, i) => {
    const title = blockTitle(item).replace(/\r?\n/g, ' ');
    const body = (item.content || item.url || '').replace(/\r/g, '').replace(/\s+$/, '');
    const titleFrom = pos;
    const titleTo = pos + title.length;
    let to = titleTo;
    let text = title;
    if (body) {
      text += '\n' + body;
      to = titleFrom + text.length;
    }
    blocks.push({ titleFrom, titleTo, bodyFrom: titleTo, to });
    parts.push(text);
    pos = to + 2; // '\n\n' separator
    if (i === items.length - 1) pos = to;
  });
  return { text: parts.join('\n\n'), blocks };
}

export function clampIndex(count, index) {
  if (count === 0 || !Number.isFinite(index)) return -1;
  return Math.max(0, Math.min(count - 1, Math.trunc(index)));
}

/**
 * Index of the block containing document offset `pos`. Offsets in the blank
 * separator belong to the preceding block. -1 when there are no blocks.
 */
export function blockIndexAt(blocks, pos) {
  if (blocks.length === 0) return -1;
  let lo = 0;
  let hi = blocks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (blocks[mid].titleFrom <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Mount the CodeMirror surface into `root`. Async because CodeMirror is loaded
 * on demand.
 * @param {HTMLElement} root
 * @param {Array<{id?:string,title?:string,content?:string,url?:string}>} items
 * @param {{vimMode?: boolean}} [options]
 */
export async function mountCmSurface(root, items, { vimMode = true } = {}) {
  const [{ createEditor, blockFoldAt }, view, stateMod, language] = await Promise.all([
    import('./codemirror.js'),
    import('@codemirror/view'),
    import('@codemirror/state'),
    import('@codemirror/language'),
  ]);
  const { Decoration, WidgetType, EditorView } = view;
  const { StateField, EditorState } = stateMod;
  const { foldEffect, unfoldEffect, foldedRanges } = language;

  const { text, blocks } = buildBlockDoc(items);
  const count = blocks.length;

  class TitleWidget extends WidgetType {
    constructor(label, selected) {
      super();
      this.label = label;
      this.selected = selected;
    }
    eq(other) { return other.label === this.label && other.selected === this.selected; }
    toDOM() {
      const el = document.createElement('div');
      el.className = 'qs-cm-title' + (this.selected ? ' selected' : '');
      el.textContent = this.label;
      return el;
    }
    ignoreEvent() { return false; }
  }

  const titles = items.map((item) => blockTitle(item).replace(/\r?\n/g, ' '));

  function decorations(state) {
    const sel = blockIndexAt(blocks, state.selection.main.head);
    const ranges = [];
    for (let i = 0; i < count; i++) {
      const b = blocks[i];
      ranges.push(Decoration.replace({
        widget: new TitleWidget(titles[i], i === sel),
        block: true,
      }).range(b.titleFrom, b.titleTo));
    }
    return Decoration.set(ranges);
  }

  const blockDecos = StateField.define({
    create: decorations,
    update(value, tr) {
      return tr.selection || tr.docChanged ? decorations(tr.state) : value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  const foldProvider = (state, pos) => {
    const i = blockIndexAt(blocks, pos);
    if (i < 0) return null;
    const b = blocks[i];
    return b.to > b.bodyFrom ? { from: b.bodyFrom, to: b.to } : null;
  };

  foldProvider.all = () => blocks.filter((b) => b.to > b.bodyFrom).map((b) => ({ from: b.bodyFrom, to: b.to }));

  const host = document.createElement('div');
  host.className = 'qs-cm';
  root.appendChild(host);

  const editor = createEditor({
    parent: host,
    content: text,
    vimMode,
    showLineNumbers: false,
    lineFolds: false,
    extraExtensions: [
      EditorState.readOnly.of(true),
      EditorView.lineWrapping,
      blockFoldAt.of(foldProvider),
      blockDecos,
    ],
  });

  const foldedAt = (i) => {
    const b = blocks[i];
    if (b.to <= b.bodyFrom) return false;
    let folded = false;
    foldedRanges(editor.state).between(b.bodyFrom, b.to, (from) => { if (from === b.bodyFrom) folded = true; });
    return folded;
  };

  function foldEffects(effect, indexes) {
    const effects = [];
    for (const i of indexes) {
      const b = blocks[i];
      if (b.to > b.bodyFrom) effects.push(effect.of({ from: b.bodyFrom, to: b.to }));
    }
    return effects;
  }

  const all = () => Array.from({ length: count }, (_, i) => i);
  const dispatchEffects = (effects) => { if (effects.length) editor.dispatch({ effects }); };

  const surface = {
    element: host,
    editor,
    blockCount: () => count,
    selectedIndex: () => blockIndexAt(blocks, editor.state.selection.main.head),
    isFolded: foldedAt,
    select(index) {
      const i = clampIndex(count, index);
      if (i < 0) return surface.selectedIndex();
      editor.dispatch({
        selection: { anchor: blocks[i].titleFrom },
        effects: EditorView.scrollIntoView(blocks[i].titleFrom, { y: 'nearest' }),
      });
      return i;
    },
    fold(index) {
      const i = clampIndex(count, index);
      if (i >= 0 && !foldedAt(i)) dispatchEffects(foldEffects(foldEffect, [i]));
    },
    unfold(index) {
      const i = clampIndex(count, index);
      if (i >= 0 && foldedAt(i)) dispatchEffects(foldEffects(unfoldEffect, [i]));
    },
    foldAll() { dispatchEffects(foldEffects(foldEffect, all())); },
    unfoldAll() { dispatchEffects(foldEffects(unfoldEffect, all().filter(foldedAt))); },
  };
  return surface;
}

/**
 * Same measurement as measureSyntheticBlocks in query-surface-dom.js, over the
 * CodeMirror surface. Each timing includes one forced layout.
 */
export async function measureSyntheticBlocks(root, count) {
  const items = syntheticItems(count);
  const timed = async (fn) => {
    const t0 = performance.now();
    await fn();
    root.offsetHeight;
    return Math.round((performance.now() - t0) * 10) / 10;
  };
  // Module loading is not part of the mount time (the DOM trial's module is loaded before timing too).
  await Promise.all([import('./codemirror.js'), import('@codemirror/view'), import('@codemirror/state'), import('@codemirror/language')]);
  let surface;
  const mountMs = await timed(async () => { surface = await mountCmSurface(root, items); });
  const foldAllMs = await timed(() => surface.foldAll());
  const unfoldAllMs = await timed(() => surface.unfoldAll());
  const select100Ms = await timed(() => {
    for (let i = 1; i <= 100; i++) {
      surface.select(i);
      root.offsetHeight;
    }
  });
  return { count, mountMs, foldAllMs, unfoldAllMs, select100Ms, surface };
}
