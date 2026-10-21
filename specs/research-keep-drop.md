---
enabled: true
touches: [apps/desktop/features/research/, apps/desktop/renderer/lib/page-state.js, apps/desktop/renderer/page/overlay.js, apps/desktop/renderer/page/overlay.html, apps/desktop/tests/unit/page-state.test.js, apps/desktop/tests/desktop/research-keep-drop.spec.ts]
depends-on: []
---

# Keep or drop a page, with a one-line note

Peek item `df3ffc86`, first slice of `docs/design/search-rounds.md`. In research that runs as
rounds of searching and opening results, a page needs a judgement: kept or dropped, and a short
reason ("too long", "no parking", "maybe"). This slice records that judgement on the page's URL
item. The research view, the seen-before line and rounds are later slices and read what this one
writes.

Decisions:

- A page's state is a tag on its URL item: `kept` or `dropped`. A page has at most one of the
  two; setting one removes the other. No tag means not yet judged. `done` is not part of this
  slice (the todo feature already uses `done` on text items; how a kept page becomes done is
  decided with the research view).
- The note goes in the URL item's `metadata.notes`, the field `features/editor/query-blocks.js
  blockRowsModel()` already shows for URL items. A keep or drop with a note replaces the note;
  one without a note leaves an existing note alone.
- State is global to the URL item, not per space. Per-research state is an open question in the
  design doc and is not decided here.
- Works for any page, in a space or not.
- Commands: `keep [note]` and `drop [note]`, acting on the active page window the way
  `features/tags/background.js executeTag()` does (`getActiveWindow()`, then the URL item,
  created if missing). `unjudge` removes both tags and leaves the note.
- Overlay: two small buttons, keep and drop, beside the tags input in
  `renderer/page/overlay.js`. The one matching the current state shows as active; clicking the
  active one clears the state. No note entry in the overlay in this slice; the note comes from
  the command.

## What the code does now

- `features/tags/background.js`: `getActiveWindow()`, `findItemByUrl()` (through
  `api.datastore.findUrlItem`), and `executeTag()`, which creates the URL item when missing and
  tags it with `getOrCreateTag` and `tagItem`; `executeUntag()` removes a tag.
- `renderer/page/overlay.js`: the `tags-input` element, `resolveItemId(url)`, `renderTags()`,
  `addTagToPage(tagName)`, and live refresh on `tag:item-added` / `item:removed`.
- `features/tag-actions/background.js runTagSwap()` shows the remove-one-add-other pattern.
- `api.datastore.updateItem()` merges metadata shallowly.

## What changes

- New `renderer/lib/page-state.js` (served as `peek://app/lib/page-state.js`), pure, no `api`,
  window or DOM: `PAGE_STATES = ['kept', 'dropped']`, `stateFromTags(tagNames)` returning
  `'kept' | 'dropped' | null`, and `planPageState(currentTagNames, action, note)` with `action`
  one of `keep`, `drop`, `clear`, returning `{ addTag, removeTags, notes }` (`notes` undefined
  when unchanged). Every rule in Decisions lives here. If both tags are somehow present,
  `stateFromTags` returns the one that is not being cleared by the plan, and any action leaves at
  most one.
- New built-in feature `features/research/` (`manifest.json`, `background.html`,
  `background.js`), lazy background tile like `features/tag-actions`, registering `keep`,
  `drop` and `unjudge` synchronously in `init()` before any `await` (`apps/desktop/CLAUDE.md`
  lazy tile init-order rule). Each command resolves the active page's URL item and applies
  `planPageState()`. Datastore tables `items`, `tags`, `item_tags`.
- `renderer/page/overlay.js` (+ `overlay.html`, whose inline `<style>` holds the overlay's CSS): the keep and drop buttons,
  applying `planPageState()` through the same datastore calls `addTagToPage()` uses, and
  reflecting state from the tags already loaded for `renderTags()`.

## Tests to change

New `tests/unit/page-state.test.js`: `stateFromTags` for none, kept, dropped and both;
`planPageState` for keep from none, keep from dropped (removes `dropped`), drop from kept, clear,
keep with and without a note, and keep when already kept (no tag change, note replaced when
given).

New `tests/desktop/research-keep-drop.spec.ts` on a test profile: open a page window, run
`keep too long`, confirm the URL item carries `kept` and `metadata.notes` is `too long`; run
`drop`, confirm `dropped` replaced `kept` and the note is unchanged; click the overlay's keep
button, confirm `kept` is back; click it again, confirm neither tag remains.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
yarn workspace @peek/desktop test:grep "research-keep-drop|tags|tag-actions|hybrid-overlay"
```

Done when the unit tallies report `fail 0`, the new tests pass, and the other collected specs
show no new failure compared with `apps/desktop/tests/gate-baseline.md` (the `hybrid-overlay`
cluster has known Linux failures listed there). Record the `test:grep` pass/fail count under
`**Result**` in the handoff.

## Working rules

`apps/desktop/CLAUDE.md` governs the desktop app. Read it before editing. State logic stays in
the pure module. Run one command per Bash call.
