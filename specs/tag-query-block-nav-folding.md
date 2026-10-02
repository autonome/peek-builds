---
enabled: true
touches: [apps/desktop/features/editor/query-keys.js, apps/desktop/features/editor/home.js, apps/desktop/renderer/lib/grid-nav.js, apps/desktop/tests/unit/query-keys.test.js]
depends-on: [tag-query-block-rows]
---

# Tag-query editor, slice 7: `j`/`k` block selection and block-level folding

Part of Peek item `item_1790655511612_0mmmdmy59`; design in `tag-query-editor-view.md`
("Navigation and folding"; Decisions: "Folding").

## What goes

New `features/editor/query-keys.js`: a pure function mapping a key and the current state
(`selectedIndex`, `blockCount`, folded set) to an action or a new state, so it is testable without a
DOM.

- `j` / `ArrowDown` and `k` / `ArrowUp` move block selection, clamped at both ends, following
  `renderer/lib/grid-nav.js` `updateSelection` for highlight and scroll-into-view. Generalize that
  function only if the change leaves its card callers untouched; otherwise write the block version
  beside it.
- Folding, top level only: `zM` collapse all (each block shows only its first row), `zR` expand all,
  `zc` / `zo` / `za` collapse / expand / toggle the selected block. These are the existing key names
  from `features/editor/codemirror.js`; they do not enter edit mode.
- Keys are active only when no inline editor is open (that slice owns the handoff).

`home.js`: attach the handler to the surface in query mode.

## What stays

- Per-line folding on the single-document editor and its `editor-folding.spec.ts`.
- Nothing for `<Enter>` yet.

## Tests to change

New `apps/desktop/tests/unit/query-keys.test.js`: clamping at first and last block, empty document,
arrow aliases, each fold key's effect, `za` toggling twice, `zM` then `zR`, unknown keys returning no
action.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test node --test apps/desktop/tests/unit/query-keys.test.js apps/desktop/tests/unit/*.test.js
```

Done when the run reports `fail 0`. Live key handling in the window needs the Electron app and is not
exercised here; say so under **Result**.

## Working rules

Run one command per Bash call. Never run the Electron gate without an explicit OK.
