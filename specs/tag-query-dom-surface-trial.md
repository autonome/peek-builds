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

## Result

Built `features/editor/query-surface-dom.js` (`createBlockState` is the DOM-free selection and fold
state; `mountDomSurface` mounts the blocks; `measureSyntheticBlocks` is the harness). `home.js` picks the
surface from `surface=dom|cm` (default `dom`; `cm` shows a not-built notice until the other trial lands)
and runs the harness when the URL carries `syntheticBlocks=N` (generated items, no datastore access, no
debug gate: the param only changes what the window shows). The surface mounts into the query view's
root, because the `editor-top-toolbar` slice and an `EditorLayout` center area do not exist in query mode
yet; moving the mount point is the integration slice's job.

- `yarn workspace @peek/desktop build` succeeded.
- `node --test apps/desktop/tests/unit/query-surface-dom.test.js`: tests 11, pass 11, fail 0.
- Previous slice (`tag-query-open`) checked live in a headless app on a fresh profile: `edit #qa #qb`
  resolved 3 items, `editor:open` with `tags` opened one window whose imports of
  `peek://cmd/item-suggestions.js` and `tag-query.js` loaded, a repeat run left a single window
  (focused, not duplicated), and the same query with `#bulk` listed 1000 blocks.

Measurements, 1000 generated blocks (title plus 7 lines of body each), headless Electron 43 on an Apple
M4 with 32 GB, window 1024x923. Each timing includes one forced layout (`offsetHeight`); paint and
scroll smoothness are not measured. Times in ms; four runs with `content-visibility: auto` (the first is
the page's own run on load), then three control runs with it forced off:

| run | mount | foldAll | unfoldAll | select across 100 blocks |
| --- | --- | --- | --- | --- |
| auto, on load | 3.6 | 1.8 | 1.7 | 21.6 |
| auto, rerun 1 | 3.2 | 1.8 | 1.4 | 20.6 |
| auto, rerun 2 | 4.6 | 2.2 | 1.8 | 22.4 |
| auto, rerun 3 | 4.0 | 2.0 | 1.6 | 20.5 |
| control (visible), 1-3 | 71.4 / 37.6 / 41.3 | 3.0 / 2.8 / 3.0 | 33.9 / 34.1 / 34.1 | 4.2 / 4.1 / 4.1 |

`content-visibility: auto` makes mount and fold/unfold about ten times cheaper. Selection moves cost more
with it (about 0.2 ms per step against 0.04 ms) because each `scrollIntoView` lays out the blocks that
newly enter view. At 1000 plain-text blocks nothing stalls, so no virtualizer is indicated. Not measured:
blocks with rendered markdown and the affordance column (later slices), and real scrolling.
The harness also drove the interface live: `select(5)`, `foldAll()` (1000 folded, bodies `display:none`),
`unfold(5)`, `unfoldAll()` behaved as specified.

Other comparison criteria, for this surface:

- **j/k and fold:** through the interface above, with a key handler on the scroller element calling
  `select(i +/- 1)`, `fold`, `unfold`, `foldAll`, `unfoldAll`. Nothing about the surface blocks this;
  the handler itself belongs to the nav/folding slice.
- **In-document search:** not covered. The window has no text layer, so find-in-page (Chromium's) is the
  only option, and with `content-visibility: auto` it still sees every block because they stay in the DOM.
  A vim `/` search would be new code over block text.
- **`:` commands:** not covered. No vim instance exists on the outer surface, so `:` would need its own key
  handler feeding the shared status line, with a small command table (`:q`, `:w` as no-ops).
- **Marks:** not covered; would be a map from a letter to a block index (or item id), set and jumped to by
  the same key handler. Cheap, but new.
- **Inline editor takeover of the one vim command area:** easier here than in the CodeMirror trial. There is
  never a second vim instance, since the outer surface is not vim; the inline editor is the only one, so it
  owns the status line while open, and on close the surface sets it back to its own state (selected block
  and fold count). The open item is that the outer key handler must stand down while the inline editor
  has focus; the `<Esc>` interception noted in the design applies unchanged.

## Working rules

Run one command per Bash call. Never run the Electron gate without an explicit OK. Not landing within
about 15 minutes of work: commit nothing and report back.
