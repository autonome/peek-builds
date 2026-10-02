/**
 * Tag-query outer surface, plain DOM trial: one block div per item, a single
 * selected block, and block-level fold (first row only vs all rows).
 *
 * The selection and fold bookkeeping lives in createBlockState(), which has no
 * DOM access so it can be unit tested. mountDomSurface() wires that state to
 * block elements. Both return/expose the same small interface so a second
 * surface implementation can be driven identically:
 *
 *   select(index), fold(index), unfold(index), foldAll(), unfoldAll(), blockCount()
 *
 * Blocks show a title row and a plain-text body. Per-type rendering is a later
 * slice.
 */

/**
 * Selection and fold state over `count` blocks. No DOM.
 * @param {number} count
 * @param {{onSelect?: (index:number, prev:number)=>void, onFold?: (index:number, folded:boolean)=>void}} [hooks]
 */
export function createBlockState(count, hooks = {}) {
  const folded = new Array(count).fill(false);
  let selected = count > 0 ? 0 : -1;

  const clamp = (i) => Math.max(0, Math.min(count - 1, Math.trunc(i)));

  function setFold(index, value) {
    if (count === 0 || !Number.isFinite(index)) return;
    const i = clamp(index);
    if (folded[i] === value) return;
    folded[i] = value;
    hooks.onFold?.(i, value);
  }

  return {
    blockCount: () => count,
    selectedIndex: () => selected,
    isFolded: (i) => folded[i] === true,
    select(index) {
      if (count === 0 || !Number.isFinite(index)) return selected;
      const next = clamp(index);
      if (next === selected) return selected;
      const prev = selected;
      selected = next;
      hooks.onSelect?.(next, prev);
      return selected;
    },
    fold: (index) => setFold(index, true),
    unfold: (index) => setFold(index, false),
    foldAll() {
      for (let i = 0; i < count; i++) setFold(i, true);
    },
    unfoldAll() {
      for (let i = 0; i < count; i++) setFold(i, false);
    },
  };
}

/**
 * Title row text for an item: explicit title, else first non-empty content
 * line without heading marker, else URL, else 'Untitled'.
 */
export function blockTitle(item) {
  const firstLine = (item.content || '').split('\n').find(line => line.trim()) || '';
  return item.title || firstLine.replace(/^#+\s*/, '').trim() || item.url || 'Untitled';
}

/**
 * Mount one block per item into `root`.
 * @param {HTMLElement} root
 * @param {Array<{id?:string,title?:string,content?:string,url?:string}>} items
 * @returns the surface interface plus `element` and `selectedIndex()`
 */
export function mountDomSurface(root, items) {
  const scroller = document.createElement('div');
  scroller.className = 'qs-dom';
  scroller.tabIndex = 0;
  const blocks = [];

  const state = createBlockState(items.length, {
    onSelect(next, prev) {
      blocks[prev]?.classList.remove('selected');
      const el = blocks[next];
      el.classList.add('selected');
      el.scrollIntoView({ block: 'nearest' });
    },
    onFold(i, value) {
      blocks[i].classList.toggle('folded', value);
    },
  });

  const frag = document.createDocumentFragment();
  items.forEach((item, i) => {
    const block = document.createElement('div');
    block.className = 'qs-block';
    block.dataset.index = String(i);
    if (item.id) block.dataset.itemId = item.id;

    const title = document.createElement('div');
    title.className = 'qs-block-title';
    title.textContent = blockTitle(item);

    const body = document.createElement('div');
    body.className = 'qs-block-body';
    body.textContent = item.content || item.url || '';

    block.append(title, body);
    blocks.push(block);
    frag.appendChild(block);
  });
  scroller.appendChild(frag);
  if (blocks.length > 0) blocks[0].classList.add('selected');
  root.appendChild(scroller);

  scroller.addEventListener('click', (e) => {
    const block = e.target.closest?.('.qs-block');
    if (block) state.select(Number(block.dataset.index));
  });

  return {
    element: scroller,
    select: state.select,
    fold: state.fold,
    unfold: state.unfold,
    foldAll: state.foldAll,
    unfoldAll: state.unfoldAll,
    blockCount: state.blockCount,
    selectedIndex: state.selectedIndex,
  };
}

/**
 * Dev-only measurement over `count` generated items (no datastore access).
 * Times initial mount, foldAll, unfoldAll and moving selection across 100 blocks.
 * Each timing includes a forced layout (reading offsetHeight) so deferred
 * style/layout work is counted, not just the script.
 * @returns {{count:number, mountMs:number, foldAllMs:number, unfoldAllMs:number, select100Ms:number}}
 */
export function measureSyntheticBlocks(root, count) {
  const items = Array.from({ length: count }, (_, i) => ({
    id: `synthetic-${i}`,
    title: `Synthetic item ${i}`,
    content: `# Synthetic item ${i}\n\n` + Array.from({ length: 6 }, (_, l) => `Line ${l} of body text for item ${i}, long enough to wrap a little in a narrow window.`).join('\n'),
  }));
  const timed = (fn) => {
    const t0 = performance.now();
    fn();
    // Force layout so style recalc and layout are inside the measurement.
    root.offsetHeight;
    return Math.round((performance.now() - t0) * 10) / 10;
  };

  let surface;
  const mountMs = timed(() => { surface = mountDomSurface(root, items); });
  const foldAllMs = timed(() => surface.foldAll());
  const unfoldAllMs = timed(() => surface.unfoldAll());
  const select100Ms = timed(() => {
    for (let i = 1; i <= 100; i++) {
      surface.select(i);
      root.offsetHeight;
    }
  });
  return { count, mountMs, foldAllMs, unfoldAllMs, select100Ms, surface };
}
