/**
 * Editor Home - Pure markdown editor with three-panel layout.
 *
 * Features:
 * - Outline sidebar (TOC from headers)
 * - CodeMirror editor with vim mode support
 * - Preview sidebar (live markdown rendering)
 * - Resizable panels
 * - Focus mode
 * - Autosave for datastore items
 */

import { EditorLayout } from './editor-layout.js';
import { getCM, Vim, onVimSetOption } from './codemirror.js';
import { parseTagQuery, queryKey } from 'peek://cmd/tag-query.js';
import { SORT_OPTIONS, DEFAULT_SORT_OPTION, MANUAL_SORT_OPTION, sortItems } from './sort-options.js';
import { loadOrder, saveOrder, loadSort, saveSort, reorderBase, moveBlock, moveBlockTo } from './manual-order.js';
import { createBlockRenderer } from './query-blocks.js';
import { resolveTagQuery, startQueryLive, diffBlocks, liveAction, blockSignature, LEAVE_MS } from './query-live.js';
import { attachQueryKeys, isEditClick } from './query-keys.js';
import { createUndoStack, inverseAffordance, deleteEntry, restorePayload } from './undo-stack.js';
import { createTaggedItem, discardItem, closeEmptyAction } from './query-add-item.js';
import { createInlineEditor } from './query-inline-editor.js';
import { createActionRulesCache, findAffordanceByKey, triggerAffordance } from 'peek://app/lib/tag-action-affordances.js';

const api = window.app;
const debug = api?.debug;

// Per-phase boot timing. Mirrors app/page/page.js __bootMark — routes
// through api.perfLog (peek:perf-log IPC) so markers land in main.log
// synchronously. Times are ms relative to module-script-start.
const __bootT0 = performance.now();
function __bootMark(phase) {
  try {
    const t = Math.round(performance.now() - __bootT0);
    if (api && typeof api.perfLog === 'function') {
      api.perfLog(`[editor-boot:perf] phase=${phase} t=${t}`);
    }
  } catch { /* never crash on instrumentation */ }
}
__bootMark('script-start');

// Editor layout instance
let editorLayout = null;

// Settings storage key (matches how Settings app stores under 'prefs' key)
const PREFS_STORAGE_KEY = 'prefs';

// Autosave state
let currentItemId = null;
let currentItemTitle = null; // Tracks the loaded item's title (datastore-item path)
let currentFilePath = null; // Tracks the open file on disk
let saveStatus = 'saved'; // 'saved' | 'saving' | 'unsaved'
let saveTimer = null;
let deferredNewNote = false; // True when editor opened blank — item creation deferred until content exists
const AUTOSAVE_DELAY_MS = 1500; // 1.5 seconds after typing stops

/**
 * Sample markdown content for testing folding features.
 * Tests: headers (6 levels), nested lists, code blocks.
 */
const SAMPLE_CONTENT = `# Level 1 Header - Main Document

This content is under a level 1 header.

## Level 2 - Features

Content under level 2.

### Level 3 - Folding Types

We support multiple folding types.

#### Level 4 - Header Folding

Headers fold everything until the next header of same or higher level.

##### Level 5 - Deep Nesting

This is deeply nested content.

###### Level 6 - Maximum Depth

This is the deepest header level supported.

Back to level 5 content.

##### Level 5 - Another Section

Another level 5 section.

#### Level 4 - List Folding

Lists with children are foldable:

- Parent item with children
  - Child item one
  - Child item two
    - Grandchild item
    - Another grandchild
  - Child item three
- Simple item (no children)
- Another parent
  - Single child

Numbered lists also fold:

1. First parent
   1. Sub-item one
   2. Sub-item two
2. Second parent
   - Mixed child
   - Another mixed

#### Level 4 - Code Block Folding

Top-level code blocks fold their contents:

\`\`\`javascript
function example() {
    if (condition) {
        doSomething();
    }
    return result;
}

class MyClass {
    constructor() {
        this.x = 1;
    }

    method() {
        return this.x;
    }
}
\`\`\`

### Level 3 - Vim Fold Commands

Test these vim commands (enable vim mode first):

| Command | Action |
|---------|--------|
| \`za\` | Toggle fold under cursor |
| \`zo\` | Open fold under cursor |
| \`zc\` | Close fold under cursor |
| \`zR\` | Open all folds |
| \`zM\` | Close all folds |
| \`zr\` | Reduce folding (open one level) |
| \`zm\` | More folding (close one level) |

## Level 2 - Another Top Section

This tests that level 2 properly ends the previous level 2 section.

### Level 3 - Final Nested

Final nested content.

## Level 2 - Conclusion

End of test document.
`;

/**
 * Resolve a tag query against the datastore (not from any id list passed in) and
 * show the matching text, url and image items as blocks.
 * @param {HTMLElement} rootEl
 * @param {string[]} tagNames
 */
async function renderTagQuery(rootEl, tagNames, vimMode) {
  document.title = `Editor: ${tagNames.map(t => '#' + t).join(' ')}`;

  const resolved = await resolveTagQuery(api, tagNames);
  // Window state: the items in the query now (unsorted), their tag names, and the
  // blocks on screen, which also hold items that just left the query.
  let items = resolved.items;
  let unknownTags = resolved.unknownTags;
  let itemTags = resolved.itemTags;
  let shown = [];
  const leaving = new Map(); // id -> { item, tags, since, index, timer, deleted }
  const acting = new Map(); // id -> { color, timer }: rows highlighted after an action, before the update lands
  const ACTING_MS = 3000;
  const deletedIds = new Set(); // items known deleted while their inline editor was open
  let pending = null; // newest query result held back while an inline editor is open
  let rebuildPending = false;
  let rebuilding = false;
  let lastSignature = null;
  const addedIds = new Set(); // items added here whose editor has not closed yet
  let awaitingAdd = null; // { id, done }: the added item whose block is awaited
  let adding = false;

  const addBtn = document.createElement('button');
  addBtn.className = 'toolbar-btn';
  addBtn.textContent = '+ Add item';

  const wrap =document.createElement('div');
  wrap.className = 'tag-query-list';

  const heading = document.createElement('h2');
  heading.textContent = tagNames.map(t => '#' + t).join(' ');
  wrap.appendChild(heading);

  const notice = document.createElement('p');
  notice.className = 'tag-query-notice';
  const empty = document.createElement('p');
  empty.className = 'tag-query-empty';
  empty.textContent = 'No items match this query.';
  const updateNotices = () => {
    notice.textContent = `Unknown tag${unknownTags.length > 1 ? 's' : ''}: ${unknownTags.map(t => '#' + t).join(' ')}`;
    notice.remove();
    empty.remove();
    if (unknownTags.length > 0) heading.after(notice);
    if (shown.length === 0) (unknownTags.length > 0 ? notice : heading).after(empty);
    // A query naming a tag that does not exist has no tag set to apply to a new item.
    addBtn.disabled = unknownTags.length > 0;
    addBtn.title = unknownTags.length > 0
      ? `Cannot add an item: ${unknownTags.map(t => '#' + t).join(' ')} ${unknownTags.length > 1 ? 'are not existing tags' : 'is not an existing tag'}`
      : `Add a new item tagged ${tagNames.map(t => '#' + t).join(' ')} (o)`;
  };

  // A short message in the window's one status line, put back when it times out.
  let sayTimer = null;
  let saidFrom = null;
  const clearSay = () => {
    if (!sayTimer) return;
    clearTimeout(sayTimer);
    sayTimer = null;
    editorLayout.statusLine?.restoreState(saidFrom);
    saidFrom = null;
  };
  const say = (message) => {
    const line = editorLayout.statusLine;
    if (!line) return;
    clearSay();
    saidFrom = line.saveState();
    if (line.container) line.container.style.display = '';
    line.show();
    line.showMessage(message, 0);
    sayTimer = setTimeout(clearSay, 4000);
  };

  editorLayout = new EditorLayout({ container: rootEl, textEditor: false });
  editorLayout.setCenterContent(wrap);

  const { mountDomSurface } = await import('./query-surface-dom.js');

  // Tag bindings come from the shared affordance rules and each item's tags.
  const rulesCache = createActionRulesCache(api);
  for (let waited = 0; !rulesCache.isLoaded() && waited < 1000; waited += 25) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const getTagNamesOf = (id) => itemTags.get(id) || leaving.get(id)?.tags || [];
  const renderBlock = await createBlockRenderer({
    api,
    getRules: () => rulesCache.getRules(),
    getTagNames: getTagNamesOf,
    // A checkbox click records the same undo entry as the key does.
    onToggle: (itemId, aff) => recordTagAction(itemId, aff, aff.checked),
  });

  // The sort starts as the one this query was last left in (a manual reorder saves
  // manual), so a reopened window, including one restored by undoing a close, matches.
  const orderKey = queryKey(tagNames);
  const savedSort = loadSort(orderKey, localStorage);
  let sortOption = SORT_OPTIONS.some(option => option.id === savedSort) ? savedSort : DEFAULT_SORT_OPTION;
  let surface = null;
  let detachKeys = null;
  let inline = null;
  let clickOpen = null; // opens a clicked block; set once its inline editor exists
  // Manual order: stored ids per query, read here and written on every move. It is
  // used only while the sort option is manual and kept when another option is chosen.
  let manualOrder = loadOrder(orderKey, localStorage);
  // Undo history lives as long as this view, which is bound to one query.
  const undoStack = createUndoStack();

  /** Remember a tag action for undo and show the row as acted on right away. */
  const recordTagAction = (itemId, aff, checked) => {
    undoStack.push({ kind: 'tag', itemId, affordance: { ...aff }, checked });
    const color = checked ? aff.checkedColor : aff.color;
    const prior = acting.get(itemId);
    if (prior) clearTimeout(prior.timer);
    acting.set(itemId, {
      color,
      // Cleared when the block does not leave (the action failed or it stays in the query).
      timer: setTimeout(() => { acting.delete(itemId); paintActing(itemId); }, ACTING_MS),
    });
    paintActing(itemId);
  };

  /** Apply (or clear) the acted-on highlight on the block currently showing `id`. */
  const paintActing = (id) => {
    const at = shown.findIndex(item => item.id === id);
    const block = at >= 0 ? surface?.blockElement(at) : null;
    if (!block) return;
    const entry = acting.get(id);
    block.classList.toggle('qs-acted', !!entry);
    if (entry) block.style.setProperty('--qs-act-color', entry.color);
    else block.style.removeProperty('--qs-act-color');
  };

  /** Sorted items with the blocks that are leaving put back where they were. */
  const displayList = () => {
    const list = sortItems(items, sortOption, manualOrder);
    const gone = [...leaving.values()].sort((a, b) => a.index - b.index);
    for (const entry of gone) list.splice(Math.min(entry.index, list.length), 0, entry.item);
    return list;
  };

  const mountSorted = () => {
    rebuilding = true;
    rebuildPending = false;
    // Selection, folds and scroll position survive the rebuild.
    let keep = null;
    if (surface) {
      const selected = surface.selectedIndex();
      keep = {
        selectedId: shown[selected]?.id,
        selectedIndex: selected,
        folded: new Set(shown.filter((_, i) => surface.isFolded(i)).map(item => item.id)),
        scrollTop: surface.element.scrollTop,
        focused: surface.element.contains(document.activeElement),
      };
    }
    inline?.close(); // flush an open inline editor before its block goes away
    rebuilding = false;
    detachKeys?.();
    surface?.element.remove();
    const display = displayList();
    shown = display;
    // Moving selection off the open block, or folding it, closes the inline editor
    // (and writes its text).
    const mounted = mountDomSurface(wrap, display, {
      renderBlock,
      onSelect: (next) => { if (inline?.isOpen() && inline.openIndex() !== next) inline.close(); },
      onFold: (index) => { if (inline?.isOpen() && inline.openIndex() === index) inline.close(); },
      onBlockClick: (index, e) => clickOpen?.(index, e),
      // Handles exist in every sort option; reordering outside manual order switches to it.
      reorder: { canStart: (index) => canReorder(display[index]), onDrop: dropBlock },
    });
    surface = mounted;
    // The editor's one status line is borrowed by the inline editor while it is open.
    const editor = createInlineEditor({
      api,
      surface: mounted,
      items: display,
      statusLine: editorLayout.statusLine,
      vimMode,
      onBlockChanged: () => setOutline(mounted),
      isDiscarded: (item) => deletedIds.has(item.id),
      // ArrowUp/ArrowDown at the edge of the open editor: select the neighbouring
      // block (the selection guard closes and saves this one) and open it, caret at
      // the same horizontal position on its first line (down) or last line (up).
      onEdge: (dir, index, goalX) => {
        const target = dir === 'up' ? index - 1 : index + 1;
        if (target < 0 || target >= display.length || leaving.has(display[target]?.id)) return false;
        mounted.select(target);
        mounted.revealSelected();
        guarded.open(target, { dir, goalX });
        return true;
      },
      onClosed: (item, openedText) => {
        // A new item closed without any text is removed again; an existing one
        // emptied and closed is deleted through the undoable delete.
        const wasAdded = addedIds.delete(item.id);
        const action = closeEmptyAction(item, wasAdded);
        if (action === 'discard') discardItem(api, item.id);
        else if (action === 'delete') deleteBlock(item, openedText);
        if (rebuilding) return;
        // After the current event finishes: the close may sit inside a selection change.
        setTimeout(() => {
          if (inline?.isOpen()) return;
          if (pending) {
            const held = pending;
            pending = null;
            applyResult(held);
          } else if (rebuildPending) {
            mountSorted();
          }
        }, 0);
      },
    });
    inline = editor;
    // A block that is leaving cannot be opened for editing.
    const guarded = {
      isOpen: () => editor.isOpen(),
      open: (index, opts) => {
        if (leaving.has(display[index]?.id)) return undefined;
        clearSay();
        return editor.open(index, opts);
      },
    };
    // A click on a block (the surface has already selected it and closed any other
    // open editor, saving it) opens it for editing.
    clickOpen = (index, e) => {
      if (isEditClick(e, !window.getSelection()?.isCollapsed)) guarded.open(index, { caretAtEnd: true });
    };
    detachKeys = attachQueryKeys(mounted, document, guarded, {
      add: () => addItem(),
      move: moveSelected,
      // Tag actions declare their own keys; the tag change comes back through the live update.
      tagKey: (key, index) => {
        const item = display[index];
        if (!item || leaving.has(item.id)) return false;
        const aff = findAffordanceByKey(getTagNamesOf(item.id), rulesCache.getRules(), key);
        if (!aff) return false;
        const checked = triggerAffordance(item.id, aff, api);
        recordTagAction(item.id, aff, checked);
        return true;
      },
      remove: (index) => deleteBlock(display[index]),
      undo: undoLast,
    });

    if (keep) {
      let at = display.findIndex(item => item.id === keep.selectedId);
      if (at < 0) at = Math.min(keep.selectedIndex, display.length - 1);
      if (at > 0) mounted.select(at);
      display.forEach((item, i) => { if (keep.folded.has(item.id)) mounted.fold(i); });
      mounted.element.scrollTop = keep.scrollTop;
      if (keep.focused) mounted.element.focus();
    }
    // Leavers stay as last shown, controls off, fading from where their fade had got to.
    const now = Date.now();
    display.forEach((item, i) => {
      const entry = leaving.get(item.id);
      if (acting.has(item.id)) paintActing(item.id);
      if (!entry) return;
      const block = mounted.blockElement(i);
      block.style.setProperty('--qs-leave-h', `${block.offsetHeight}px`);
      block.classList.add('qs-leaving');
      if (entry.deleted) block.classList.add('qs-deleted');
      block.setAttribute('aria-disabled', 'true');
      block.style.animationDelay = `-${now - entry.since}ms`;
    });
    setOutline(mounted);
    updateNotices();
    if (awaitingAdd && display.some(item => item.id === awaitingAdd.id)) awaitingAdd.done();
  };

  /**
   * Move the selected block one place up or down and store the new manual order,
   * switching to manual order first when another sort option is showing (see
   * `reorder`). Not for a block that is leaving.
   */
  const moveSelected = (delta) => {
    if (!surface) return;
    const selected = shown[surface.selectedIndex()];
    reorder(selected, (reconciled) => moveBlock(reconciled, selected.id, delta));
  };

  /** Whether `item`'s block may be moved now: any sort option, no open inline editor, not leaving. */
  const canReorder = (item) =>
    !inline?.isOpen() && !!item && !leaving.has(item.id)
    && items.some(other => other.id === item.id);

  /**
   * Store a new manual order for `item`'s move. `compute` gets the starting list
   * and returns the new one. In manual order the start is the stored list
   * reconciled with the items now in the query (which drops ids that no longer
   * match anything). In another sort option it is the order on screen, and the
   * view switches to manual order (the dropdown follows) so the block stays where
   * it was put. Selection and folds follow the block by id through the rebuild.
   */
  const reorder = (item, compute) => {
    if (!surface || !canReorder(item)) return;
    const isManual = sortOption === MANUAL_SORT_OPTION;
    const current = sortItems(items, sortOption, manualOrder).map(other => other.id);
    const base = reorderBase(current, manualOrder, isManual);
    const moved = compute(base);
    if (moved.join('\n') === base.join('\n')) return;
    undoStack.push({ kind: 'move', previousOrder: base });
    applyOrder(moved);
  };

  /** Store `ids` as the manual order, show it, and keep the selection in view. */
  const applyOrder = (ids) => {
    manualOrder = ids;
    saveOrder(orderKey, ids, localStorage);
    sortOption = MANUAL_SORT_OPTION;
    saveSort(orderKey, sortOption, localStorage);
    select.value = sortOption;
    mountSorted();
    lastSignature = signatureOf({ items, unknownTags, itemTags });
    surface.revealSelected();
  };

  /**
   * Soft-delete the item behind `item`'s block. The block leaves through the live
   * update (red slide-out); undo restores the item and the manual order.
   */
  const deleteBlock = async (item, restoreText) => {
    if (!item || leaving.has(item.id)) return;
    const isManual = sortOption === MANUAL_SORT_OPTION;
    const current = sortItems(items, sortOption, manualOrder).map(other => other.id);
    const previousOrder = reorderBase(current, manualOrder, isManual);
    const res = await api.datastore.deleteItem(item.id);
    if (!res?.success || !res.data) { say('The item could not be deleted'); return; }
    undoStack.push(deleteEntry(item.id, previousOrder, restoreText));
  };

  /**
   * Undo the last tag action, move or delete. A tag action is undone by publishing the
   * inverse swap through the same tag-action layer; the block comes back through
   * the live update. A move restores the previous order. A delete restores the
   * item (its tags were never removed) and the order it had.
   */
  const undoLast = () => {
    if (!surface || inline?.isOpen()) return;
    const entry = undoStack.pop();
    if (!entry) return;
    if (entry.kind === 'tag') {
      triggerAffordance(entry.itemId, inverseAffordance(entry), api);
    } else if (entry.kind === 'move') {
      applyOrder(entry.previousOrder);
    } else if (entry.kind === 'delete') {
      manualOrder = entry.previousOrder;
      saveOrder(orderKey, manualOrder, localStorage);
      const text = restorePayload(entry);
      // An item emptied by an edit comes back with the text it had before.
      Promise.resolve(api.datastore.restoreItem(entry.itemId)).then(() => {
        if (text) return api.datastore.updateItem(entry.itemId, text);
      }).catch((err) => console.error('[editor] Undo delete failed:', err));
    }
  };

  /** A handle dropped on another block: move the dragged block there and keep it selected. */
  const dropBlock = (from, to, after) => {
    const dragged = shown[from];
    const target = shown[to];
    if (!dragged || !target || leaving.has(target.id)) return;
    surface.select(from);
    reorder(dragged, (reconciled) => moveBlockTo(reconciled, dragged.id, target.id, after));
  };

  /** Resolve true once the live update has shown a block for `id`, false on timeout. */
  const waitForBlock = (id, ms) => new Promise((resolve) => {
    if (shown.some(item => item.id === id)) { resolve(true); return; }
    const timer = setTimeout(() => { awaitingAdd = null; resolve(false); }, ms);
    awaitingAdd = { id, done: () => { clearTimeout(timer); awaitingAdd = null; resolve(true); } };
  });

  /**
   * Add a text item carrying every tag in the query. The block comes in through
   * the live update; it is then selected and opened in the inline editor.
   */
  const addItem = async () => {
    if (adding) return;
    if (unknownTags.length > 0) { say(addBtn.title); return; }
    adding = true;
    try {
      await inline?.close(); // writes (or drops) an editor that is open
      clearSay();
      const created = await createTaggedItem(api, tagNames);
      if (!created.ok) { say(created.message); return; }
      addedIds.add(created.id);
      if (!(await waitForBlock(created.id, 5000))) {
        addedIds.delete(created.id);
        await discardItem(api, created.id);
        say('The new item did not show up in the view, so it was removed');
        return;
      }
      const at = shown.findIndex(item => item.id === created.id);
      if (at < 0) return;
      surface.select(at);
      surface.revealSelected();
      await inline.open(at);
    } finally {
      adding = false;
    }
  };
  addBtn.addEventListener('click', () => addItem());

  /** Remove a block once its fade has finished. */
  const finishLeaving = (id) => {
    if (!leaving.delete(id)) return;
    deletedIds.delete(id);
    if (inline?.isOpen()) rebuildPending = true;
    else mountSorted();
  };

  /** Changes whenever a block would render differently (items, tags, order, rules). */
  const signatureOf = (result) => JSON.stringify([
    sortItems(result.items, sortOption, manualOrder).map(item => blockSignature(item, result.itemTags.get(item.id))),
    result.unknownTags,
    rulesCache.getRules(),
  ]);

  /** Show a fresh query result: new items appear, leavers freeze and fade. */
  const applyResult = async (result) => {
    // Rule changes take effect with the next rebuild, which reads the fresh rules.
    await rulesCache.refresh();
    const openId = inline?.isOpen() ? shown[inline.openIndex()]?.id : undefined;
    if (inline?.isOpen()) {
      // An open block whose item left the query: deleted items freeze and fade at
      // once; retagged-out ones (and changed ones) keep the document as it is until
      // the editor closes, and the held result is applied then.
      const stillThere = result.items.some(item => item.id === openId);
      let change = 'changed';
      if (!stillThere) {
        change = 'left';
        if (openId) {
          try {
            const res = await api.datastore.getItem(openId);
            if (!res?.success || !res.data || res.data.deletedAt) change = 'deleted';
          } catch { /* unknown: treat as left */ }
        }
      }
      const action = liveAction({ open: true }, change);
      if (action === 'keep-editor' || action === 'freeze-fade-on-close') {
        pending = result;
        return;
      }
      if (action === 'drop-edit-freeze-fade') {
        // The rebuild below closes the editor; marking the item deleted makes that
        // close drop the pending autosave instead of writing to a deleted item.
        deletedIds.add(openId);
        pending = null;
      }
    }

    const liveIds = shown.filter(item => !leaving.has(item.id)).map(item => item.id);
    const diff = diffBlocks(liveIds, result.items);
    let restored = false;
    for (const item of result.items) {
      const entry = leaving.get(item.id);
      if (entry) {
        clearTimeout(entry.timer);
        leaving.delete(item.id);
        restored = true;
      }
    }
    const signature = signatureOf(result);
    if (diff.removed.length === 0 && !restored && signature === lastSignature) return;

    const since = Date.now();
    for (const id of diff.removed) {
      const index = shown.findIndex(item => item.id === id);
      leaving.set(id, {
        item: shown[index],
        tags: itemTags.get(id) || [],
        since,
        index,
        timer: setTimeout(() => finishLeaving(id), LEAVE_MS),
        deleted: deletedIds.has(id),
      });
      if (deletedIds.has(id)) continue;
      // A deleted item gets the red slide-out instead of the plain fade.
      api.datastore.getItem(id).then((res) => {
        const entry = leaving.get(id);
        if (!entry || (res?.success && res.data && !res.data.deletedAt)) return;
        entry.deleted = true;
        const at = shown.findIndex(item => item.id === id);
        surface?.blockElement(at)?.classList.add('qs-deleted');
      }).catch(() => {});
    }
    lastSignature = signature;
    items = result.items;
    unknownTags = result.unknownTags;
    itemTags = result.itemTags;
    mountSorted();
  };
  const setOutline = (mounted) => {
    editorLayout.setOutlineEntries(mounted.blockTitles(), (index) => {
      mounted.select(index);
      mounted.revealSelected();
    });
  };
  mountSorted();
  lastSignature = signatureOf(resolved);

  const live = await startQueryLive({ api, tagNames, onResult: applyResult });
  window.addEventListener('beforeunload', () => {
    live.destroy();
    for (const entry of leaving.values()) clearTimeout(entry.timer);
    for (const entry of acting.values()) clearTimeout(entry.timer);
  });

  // <Esc> reaches the window through the preload, not as a DOM keydown. Inner
  // layers first: vim insert/visual -> normal, then close the inline editor; with
  // none open, the window's default <Esc> applies.
  if (api?.escape?.onEscape) {
    api.escape.onEscape(() => (inline ? inline.handleEscape() : { handled: false }));
  }
  // The layout is torn down by cleanup() on unload, so only write the text here.
  window.addEventListener('beforeunload', () => {
    inline?.flush();
    // Closing the window with a new item's editor still empty removes the item.
    const openItem = inline?.isOpen() ? shown[inline.openIndex()] : null;
    if (openItem && addedIds.has(openItem.id) && (inline.openText() || '').trim() === '') {
      discardItem(api, openItem.id);
    }
  });

  const select = document.createElement('select');
  select.className = 'editor-top-toolbar-select';
  select.title = 'Sort order';
  for (const option of SORT_OPTIONS) {
    const el = document.createElement('option');
    el.value = option.id;
    el.textContent = option.label;
    select.appendChild(el);
  }
  select.value = sortOption;
  select.addEventListener('change', () => {
    sortOption = select.value;
    saveSort(orderKey, sortOption, localStorage);
    mountSorted();
  });
  editorLayout.setTopToolbar([addBtn, select]);
}

/**
 * Measurement hook (URL param syntheticBlocks=N): mount the block surface over generated items (no datastore writes)
 * and record timings. The result is logged to main.log via perfLog and kept on
 * window.__syntheticBlocksResult for a live probe.
 * @param {HTMLElement} rootEl
 * @param {number} count
 */
async function runSyntheticBlocks(rootEl, count) {
  rootEl.textContent = '';
  const wrap = document.createElement('div');
  wrap.className = 'tag-query-list';
  rootEl.appendChild(wrap);
  const { measureSyntheticBlocks } = await import('./query-surface-dom.js');
  const { surface, ...result } = await measureSyntheticBlocks(wrap, count);
  window.__syntheticSurface = surface;
  window.__syntheticBlocksResult = result;
  const line = `[query-surface-dom:measure] ${JSON.stringify(result)}`;
  console.log(line);
  try { api?.perfLog?.(line); } catch { /* instrumentation only */ }
}

/**
 * Initialize the editor
 */
const init = async () => {
  __bootMark('init-start');
  debug && console.log('[editor] Home init');

  const rootEl = document.getElementById('editor-root');
  if (!rootEl) {
    console.error('[editor] Root element not found');
    return;
  }

  // Load vim mode preference from extension settings API (Settings app stores under 'prefs' key)
  let vimMode = false;
  let vimSettings = null; // persisted vim :set settings (wrap, lineNumbers)
  try {
    if (api?.settings?.get) {
      const result = await api.settings.get(PREFS_STORAGE_KEY);
      const prefs = result?.value;
      if (prefs && typeof prefs === 'object') {
        vimMode = !!prefs.vimMode;
        debug && console.log('[editor] Loaded vimMode from prefs:', vimMode);

        // Load persisted vim :set settings
        if (prefs.vimSettings && typeof prefs.vimSettings === 'object') {
          vimSettings = prefs.vimSettings;
          debug && console.log('[editor] Loaded vimSettings from prefs:', vimSettings);
        }
      } else {
        debug && console.log('[editor] No prefs found in datastore, using default vimMode:', vimMode);
      }
    }
  } catch (err) {
    debug && console.log('[editor] Failed to load settings:', err);
  }

  // Check URL params for content, file path, or itemId
  const params = new URLSearchParams(window.location.search);
  const contentParam = params.get('content');
  const fileParam = params.get('file');
  const itemIdParam = params.get('itemId');

  // Tag query mode: show the items carrying every tag in the query
  // Measurement hook: generated items, no datastore reads or writes.
  const syntheticBlocks = parseInt(params.get('syntheticBlocks') || '', 10);
  if (Number.isFinite(syntheticBlocks) && syntheticBlocks > 0) {
    await runSyntheticBlocks(rootEl, syntheticBlocks);
    return;
  }
  const queryTags = parseTagQuery((params.get('tags') || '').split(',').filter(Boolean).map(t => '#' + t).join(' '));
  if (queryTags) {
    await renderTagQuery(rootEl, queryTags, vimMode);
    return;
  }

  let initialContent = '';
  let hasExplicitSource = false;

  // If content provided via URL param, use it
  if (contentParam) {
    initialContent = contentParam;
    hasExplicitSource = true;
  }

  // If file path provided, try to load it
  if (fileParam && api?.filesystem?.read) {
    try {
      const result = await api.filesystem.read(fileParam);
      if (result && !result.error && typeof result.content === 'string') {
        initialContent = result.content;
        currentFilePath = fileParam;
        hasExplicitSource = true;
        debug && console.log('[editor] Loaded file from path:', currentFilePath);
        // basePath will be set after editorLayout is created
      } else if (result?.error) {
        debug && console.log('[editor] Failed to load file:', result.error);
      }
    } catch (err) {
      debug && console.log('[editor] Failed to load file:', err);
    }
  }

  __bootMark('settings-loaded');

  // If itemId provided, load from datastore
  if (itemIdParam && api?.datastore?.getItem) {
    try {
      const result = await api.datastore.getItem(itemIdParam);
      __bootMark(`item-loaded len=${(result?.data?.content || '').length}`);
      if (result.success && result.data) {
        initialContent = result.data.content || '';
        currentItemId = itemIdParam;
        currentItemTitle = result.data.title || null;
        hasExplicitSource = true;
        debug && console.log('[editor] Loaded item from datastore:', itemIdParam);
      } else {
        console.error('[editor] Failed to load item:', result.error);
      }
    } catch (err) {
      console.error('[editor] Failed to load item:', err);
    }
  }

  // No explicit source — defer item creation until user actually types content.
  // This prevents empty junk items from being saved to the datastore.
  if (!hasExplicitSource && !currentItemId) {
    deferredNewNote = true;
    debug && console.log('[editor] New blank note — item creation deferred until content is typed');
  }

  __bootMark('layout-create-start');
  // Create editor layout
  editorLayout = new EditorLayout({
    container: rootEl,
    initialContent,
    vimMode,
    vimSettings,
    onContentChange: handleContentChange,
  });
  __bootMark('layout-create-done');

  // Show save status indicator and filename if editing a datastore item or file
  if (currentItemId || currentFilePath) {
    editorLayout.setSaveStatusVisible(true);
  }
  if (currentFilePath) {
    updateWindowTitle();
    // Set base path for resolving relative image paths in preview
    editorLayout.setBasePath(extractDirname(currentFilePath));
  } else if (currentItemId) {
    updateWindowTitle();
  }

  // Set up Cmd+O (open file) and Cmd+S (save file) keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Cmd+O: Open file
    if ((e.metaKey || e.ctrlKey) && e.key === 'o' && !e.shiftKey) {
      e.preventDefault();
      openFile();
    }
    // Cmd+S: Save file
    if ((e.metaKey || e.ctrlKey) && e.key === 's' && !e.shiftKey) {
      e.preventDefault();
      const content = editorLayout.getContent();
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (currentFilePath || currentItemId) {
        performAutosave(content);
      } else {
        saveToFile(content);
      }
    }
  });

  // Persist vim :set option changes (wrap, number) to settings
  onVimSetOption(async (optionName, value) => {
    debug && console.log(`[editor] Vim :set ${optionName}=${value}, persisting`);
    try {
      if (api?.settings?.get && api?.settings?.set) {
        const result = await api.settings.get(PREFS_STORAGE_KEY);
        const existing = result?.value;
        const prefs = (existing && typeof existing === 'object')
          ? { ...existing }
          : {};

        // Map vim option names to our settings keys
        const settingsKey = optionName === 'number' ? 'lineNumbers' : optionName;
        if (!prefs.vimSettings || typeof prefs.vimSettings !== 'object') {
          prefs.vimSettings = {};
        }
        prefs.vimSettings[settingsKey] = value;

        await api.settings.set(PREFS_STORAGE_KEY, prefs);
        debug && console.log('[editor] Persisted vimSettings:', prefs.vimSettings);
      }
    } catch (err) {
      debug && console.log('[editor] Failed to persist vim setting:', err);
    }
  });

  // Register vim ex-commands for :w, :wq, :e
  Vim.defineEx('write', 'w', () => {
    const content = editorLayout.getContent();
    // Cancel any pending autosave — we're saving now
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (currentFilePath || currentItemId) {
      performAutosave(content);
    } else {
      // No file or item — trigger save-as
      saveToFile(content);
    }
    debug && console.log('[editor:vim] :w — saved');
  });

  Vim.defineEx('quit', 'q', () => {
    try {
      if (api?.window?.close) {
        api.window.close();
      } else {
        window.close();
      }
    } catch (err) {
      debug && console.log('[editor:vim] :q — window.close failed:', err);
    }
    debug && console.log('[editor:vim] :q — closing window');
  });

  Vim.defineEx('wq', 'wq', async () => {
    const content = editorLayout.getContent();
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (currentFilePath || currentItemId) {
      await performAutosave(content);
    } else {
      await saveToFile(content);
    }
    debug && console.log('[editor:vim] :wq — saved');
    // Close the editor window
    try {
      if (api?.window?.close) {
        api.window.close();
      } else {
        window.close();
      }
    } catch (err) {
      debug && console.log('[editor:vim] :wq — window.close failed:', err);
    }
    debug && console.log('[editor:vim] :wq — closing window');
  });

  // :e — open a file
  Vim.defineEx('edit', 'e', () => {
    openFile();
    debug && console.log('[editor:vim] :e — opening file');
  });

  // Shadow-aware "is a plain editable element focused?" check (peek 51798bae).
  // Mirrors renderer/page/overlay.js `shouldBlockOverlayDrag` and the universal
  // content preload's predicate: input(text-ish)/textarea/select/contenteditable/
  // role=textbox, piercing shadow roots via each root's activeElement.
  const isPlainEditableFocused = () => {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'select') return true;
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      return !['button', 'checkbox', 'radio', 'submit', 'reset', 'image', 'file', 'range', 'color', 'hidden'].includes(type);
    }
    return (el.getAttribute('role') || '').toLowerCase() === 'textbox';
  };

  // Set up escape handler
  //
  // ESC cascade (preload intercepts ESC via before-input-event, DOM keydown never fires):
  //   1. Annotation textarea focused -> blur to save+close
  //   2. Vim insert/visual mode -> exit to vim normal mode
  //   3. Vim normal mode (or non-vim) + focus mode -> exit focus mode
  //   4. Otherwise -> not handled (backend decides: close window, etc.)
  if (api?.escape) {
    api.escape.onEscape(() => {
      // Check if an annotation textarea is focused. The preload intercepts
      // ESC via before-input-event, so the textarea's own keydown handler
      // never fires. We blur it here to trigger the save+close logic.
      const focused = document.activeElement;
      if (focused?.tagName === 'TEXTAREA' && focused.classList.contains('annotation-textarea')) {
        debug && console.log('[editor:esc] Annotation textarea focused, blurring to save+close');
        focused.blur();
        return { handled: true };
      }

      // If vim mode is enabled, check if vim is in insert/visual mode.
      // The preload intercepts ESC via before-input-event and calls
      // e.preventDefault(), so the DOM keydown never reaches CodeMirror.
      // We must programmatically send <Esc> to vim here.
      if (editorLayout?.vimMode && editorLayout?.cmEditor) {
        try {
          const cm = getCM(editorLayout.cmEditor);
          if (cm && cm.state && cm.state.vim) {
            const vimState = cm.state.vim;
            if (vimState.insertMode || vimState.visualMode) {
              debug && console.log('[editor:esc] Vim in insert/visual mode, sending <Esc> to vim');
              Vim.handleKey(cm, '<Esc>');
              return { handled: true };
            }
            // In normal mode, fall through to focus mode check / close
            debug && console.log('[editor:esc] Vim in normal mode, checking focus mode');
          }
        } catch (e) {
          debug && console.log('[editor:esc] Could not check vim state:', e);
        }
      }

      if (editorLayout?.isInFocusMode()) {
        editorLayout.exitFocusMode();
        return { handled: true };
      }

      // Peek editor requirement (51798bae): ESC while a plain editable is focused
      // (the CodeMirror text area / any input/textarea/contenteditable) must NOT
      // fall through to the backend switcher route. Consume it so ESC stays in
      // the editing context. Vim insert/visual and focus-mode are handled above;
      // this catches ordinary editing (incl. vim normal mode with the editor
      // focused), which previously fell through and blasted open the switcher.
      if (isPlainEditableFocused()) {
        debug && console.log('[editor:esc] Editable focused — consuming ESC (no switcher)');
        return { handled: true };
      }
      return { handled: false };
    });
  }

  // Listen for settings changes from Settings app to live-reload vim mode and vim settings
  if (api?.pubsub?.subscribe) {
    api.pubsub.subscribe('editor:settings-changed', async () => {
      debug && console.log('[editor] Settings changed, reloading vim mode and vim settings');
      try {
        if (api?.settings?.get) {
          const result = await api.settings.get(PREFS_STORAGE_KEY);
          const prefs = result?.value;
          if (prefs && typeof prefs === 'object') {
            const newVimMode = !!prefs.vimMode;
            if (editorLayout) {
              editorLayout.setVimMode(newVimMode);
            }
            debug && console.log('[editor] Updated vimMode from settings:', newVimMode);

            // Apply vim settings if changed
            if (prefs.vimSettings && editorLayout) {
              editorLayout.applyVimSettings(prefs.vimSettings);
              debug && console.log('[editor] Updated vimSettings from settings:', prefs.vimSettings);
            }
          }
        }
      } catch (err) {
        debug && console.log('[editor] Failed to reload settings:', err);
      }
    });
  }

  debug && console.log('[editor] Editor initialized');
  __bootMark('init-done');
};

/**
 * Update save status indicator in the UI
 */
const updateSaveStatusUI = () => {
  const statusEl = document.getElementById('save-status');
  if (!statusEl) return;

  statusEl.className = `save-status save-status-${saveStatus}`;
  switch (saveStatus) {
    case 'saved':
      statusEl.textContent = 'Saved';
      break;
    case 'saving':
      statusEl.textContent = 'Saving...';
      break;
    case 'unsaved':
      statusEl.textContent = 'Unsaved';
      break;
  }
};

/**
 * Extract a title from the first line of content.
 * Strips leading markdown heading markers (e.g., "# Title" -> "Title").
 */
const extractTitleFromContent = (content) => {
  if (!content) return '';
  const firstLine = content.split('\n')[0].trim();
  // Strip leading markdown heading markers
  return firstLine.replace(/^#+\s*/, '');
};

/**
 * Extract filename from a full file path.
 */
const extractFilename = (filePath) => {
  if (!filePath) return '';
  return filePath.split('/').pop() || filePath.split('\\').pop() || filePath;
};

/**
 * Extract directory path from a full file path.
 */
const extractDirname = (filePath) => {
  if (!filePath) return '';
  const parts = filePath.split('/');
  parts.pop();
  return parts.join('/') || '/';
};

/**
 * Update the window title and filename display.
 *
 * Title resolution: filename (file path) → item title (datastore item) →
 * fallback "Editor". The window-presenter pulls win.getTitle() into its
 * canonical WindowPresentation, so consumers (Windows switcher, session
 * save) inherit whatever we set here without any per-feature awareness.
 */
const updateWindowTitle = () => {
  const filename = currentFilePath ? extractFilename(currentFilePath) : null;
  const title = filename || currentItemTitle || 'Editor';
  document.title = title;
  if (api?.window?.setTitle) {
    api.window.setTitle(title);
  }
  if (editorLayout) {
    editorLayout.setFilename(filename);
  }
};

/**
 * Open a file from disk via the native file picker.
 */
const openFile = async () => {
  if (!api?.dialogs?.open) return;

  try {
    const result = await api.dialogs.open();
    if (!result.success || result.canceled || !result.data) return;

    const { content, path: filePath, name, isText } = result.data;
    if (!isText || content === null) {
      debug && console.log('[editor] Cannot open non-text file:', name);
      return;
    }

    // Clear any pending autosave for previous content
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }

    // Switch to file mode (no datastore item)
    currentItemId = null;
    currentFilePath = filePath;

    // Load content into editor
    if (editorLayout) {
      editorLayout.setContent(content);
      editorLayout.setSaveStatusVisible(true);
      // Set base path for resolving relative image paths in preview
      editorLayout.setBasePath(extractDirname(filePath));
    }

    saveStatus = 'saved';
    updateSaveStatusUI();
    updateWindowTitle();
    debug && console.log('[editor] Opened file:', filePath);
  } catch (err) {
    console.error('[editor] Failed to open file:', err);
  }
};

/**
 * Save content to the current file path, or show save-as dialog if no path.
 */
const saveToFile = async (content) => {
  if (!content && editorLayout) {
    content = editorLayout.getContent();
  }
  if (!content && content !== '') return;

  // If we have a file path, write directly
  if (currentFilePath && api?.filesystem?.write) {
    saveStatus = 'saving';
    updateSaveStatusUI();

    try {
      const result = await api.filesystem.write(currentFilePath, content);
      if (result && result.success && !result.error) {
        saveStatus = 'saved';
        debug && console.log('[editor] Saved to file:', currentFilePath);
      } else {
        console.error('[editor] File save failed:', result?.error);
        saveStatus = 'unsaved';
      }
    } catch (err) {
      console.error('[editor] File save error:', err);
      saveStatus = 'unsaved';
    }

    updateSaveStatusUI();
    return;
  }

  // No file path — show save-as dialog
  if (api?.dialogs?.save) {
    saveStatus = 'saving';
    updateSaveStatusUI();

    try {
      const result = await api.dialogs.save(content, { filename: 'untitled.md' });
      if (result.success && result.path) {
        currentFilePath = result.path;
        saveStatus = 'saved';
        updateWindowTitle();
        if (editorLayout) {
          editorLayout.setSaveStatusVisible(true);
        }
        debug && console.log('[editor] Saved as:', currentFilePath);
      } else if (result.canceled) {
        saveStatus = 'unsaved';
      } else {
        console.error('[editor] Save-as failed:', result.error);
        saveStatus = 'unsaved';
      }
    } catch (err) {
      console.error('[editor] Save-as error:', err);
      saveStatus = 'unsaved';
    }

    updateSaveStatusUI();
  }
};

/**
 * Perform autosave to datastore
 */
const performAutosave = async (content) => {
  // File-based autosave
  if (currentFilePath) {
    await saveToFile(content);
    return;
  }

  if (!currentItemId || !api?.datastore?.updateItem) {
    return;
  }

  saveStatus = 'saving';
  updateSaveStatusUI();

  try {
    // Extract title from first line and save alongside content
    const title = extractTitleFromContent(content);
    const result = await api.datastore.updateItem(currentItemId, { content, title });
    if (result.success) {
      saveStatus = 'saved';
      debug && console.log('[editor] Autosaved item:', currentItemId, 'title:', title);

      if (title !== currentItemTitle) {
        currentItemTitle = title;
        updateWindowTitle();
      }

      // Publish change event
      if (api?.pubsub?.publish) {
        api.pubsub.publish('editor:changed', { action: 'update', itemId: currentItemId });
      }
    } else {
      console.error('[editor] Autosave failed:', result.error);
      saveStatus = 'unsaved';
    }
  } catch (err) {
    console.error('[editor] Autosave error:', err);
    saveStatus = 'unsaved';
  }

  updateSaveStatusUI();
};

/**
 * Create a new note item in the datastore (deferred from init).
 * Called on first real content change when editor was opened blank.
 */
const createDeferredNoteItem = async (content) => {
  if (!deferredNewNote || !api?.datastore?.addItem) return false;

  deferredNewNote = false; // Prevent re-entry

  try {
    const title = extractTitleFromContent(content);
    const result = await api.datastore.addItem('text', { content, title });
    if (result.success && result.data) {
      currentItemId = result.data.id;
      currentItemTitle = title || null;
      updateWindowTitle();
      debug && console.log('[editor] Created new note item on first content:', currentItemId);

      // Tag with 'note' and 'from:cmd'
      if (api?.datastore?.getOrCreateTag && api?.datastore?.tagItem) {
        for (const tagName of ['note', 'from:cmd']) {
          const tagResult = await api.datastore.getOrCreateTag(tagName);
          if (tagResult.success) {
            await api.datastore.tagItem(currentItemId, tagResult.data.tag.id);
          }
        }
      }

      // Notify that a new item was created
      if (api?.pubsub?.publish) {
        api.pubsub.publish('editor:changed', { action: 'add', itemId: currentItemId });
      }

      // Update URL with itemId so session restore can reopen this document.
      // Without this, session save captures the bare URL (no itemId) and
      // restore opens a blank editor instead of the saved document.
      try {
        const url = new URL(window.location.href);
        url.searchParams.set('itemId', currentItemId);
        history.replaceState(null, '', url.toString());
        debug && console.log('[editor] Updated URL with itemId for session restore:', currentItemId);
      } catch (urlErr) {
        debug && console.log('[editor] Failed to update URL with itemId:', urlErr);
      }

      // Show save status now that we have an item
      if (editorLayout) {
        editorLayout.setSaveStatusVisible(true);
      }

      saveStatus = 'saved';
      updateSaveStatusUI();
      return true;
    }
  } catch (err) {
    debug && console.log('[editor] Failed to create deferred note item:', err);
  }
  return false;
};

/**
 * Schedule autosave with debouncing
 */
const scheduleAutosave = (content) => {
  if (!currentItemId && !currentFilePath) return;

  // Mark as unsaved
  saveStatus = 'unsaved';
  updateSaveStatusUI();

  // Clear existing timer
  if (saveTimer) {
    clearTimeout(saveTimer);
  }

  // Schedule save after delay
  saveTimer = setTimeout(() => {
    performAutosave(content);
  }, AUTOSAVE_DELAY_MS);
};

/**
 * Handle content changes
 */
const handleContentChange = async (content) => {
  // Publish change event for other extensions
  if (api?.pubsub?.publish) {
    api.pubsub.publish('editor:contentChanged', { content });
  }

  // If this is a deferred new note and user typed real content, create the item now
  if (deferredNewNote && content && content.trim().length > 0) {
    await createDeferredNoteItem(content);
    // Item was just created with this content — no need to schedule another save
    return;
  }

  // Schedule autosave if editing a datastore item or a file
  if (currentItemId || currentFilePath) {
    scheduleAutosave(content);
  }
};

/**
 * Clean up on unload
 */
const cleanup = () => {
  // Clear any pending autosave timer
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  // Reset deferred state
  deferredNewNote = false;

  if (editorLayout) {
    editorLayout.destroy();
    editorLayout = null;
  }
};

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Clean up on unload
window.addEventListener('beforeunload', cleanup);
