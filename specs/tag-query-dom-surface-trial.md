---
enabled: true
touches: [apps/desktop/features/editor/query-surface-dom.js, apps/desktop/features/editor/home.js, apps/desktop/features/editor/home.css, apps/desktop/tests/unit/query-surface-dom.test.js]
depends-on: [tag-query-open, editor-top-toolbar]
---

# Tag-query editor, slice 3: trial of plain DOM blocks as the outer surface

Part of Peek item `item_1790655511612_0mmmdmy59`; design in `tag-query-editor-view.md`
(Decisions: "Outer surface", "Scale"). This is one of two trials. It lands behind a switch so the other
trial can sit beside it; the pick slice removes the loser.

## What goes

New `features/editor/query-surface-dom.js`: a function that mounts one block `div` per item into the
editor's center area, with a single selected block, block folded and unfolded states as a class toggle
(first row only versus all rows), and `content-visibility: auto` with `contain-intrinsic-size` on each
block. Blocks show title row plus plain-text body; real per-type rendering is a later slice. Selection
and fold are exposed as a small interface (`select(index)`, `fold(index)`, `unfold(index)`,
`foldAll()`, `unfoldAll()`, `blockCount()`), so the CodeMirror trial can implement the same one and
the comparison can drive both identically.

`home.js`: in query mode choose the surface from a URL param `surface=dom|cm`, default `dom` during the
trials. `home.css`: block styling using the `--base*` variables.

A measurement harness: a way to open the surface over 1000 generated items (a dev-only URL param
`syntheticBlocks=1000` that feeds fake items to the surface, no datastore writes) and record initial
mount time, time to `foldAll`/`unfoldAll`, and time to move selection across 100 blocks. Record the
numbers under **Result** with the machine class they were taken on.

Record, with a short note each, how the surface handles the other comparison criteria: j/k and fold
through the interface above, in-document search, `:` commands, marks, and what the inline editor
takeover of the one vim command area would need (this slice does not build the takeover).

## What stays

- The single-document editor path and its tests.
- No new dependency.

## Tests to change

New `apps/desktop/tests/unit/query-surface-dom.test.js` if the surface's selection and fold logic is
pure enough to import without a DOM; otherwise keep that logic in a leaf function and test that. Cover
select clamping at both ends, foldAll/unfoldAll, and fold of the selected block.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test node --test apps/desktop/tests/unit/query-surface-dom.test.js
```

Done when the run reports `fail 0` and the **Result** section holds the 1000-block numbers. If the
numbers could not be taken without the Electron app, say so under **Result** as a gap that needs the
user to run the harness, and do not invent figures.

## Working rules

Run one command per Bash call. Never run the Electron gate without an explicit OK. Not landing within
about 15 minutes of work: commit nothing and report back.
