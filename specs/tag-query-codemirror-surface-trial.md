---
enabled: true
touches: [apps/desktop/features/editor/query-surface-cm.js, apps/desktop/features/editor/codemirror.js, apps/desktop/features/editor/home.js, apps/desktop/tests/unit/query-surface-cm.test.js]
depends-on: [tag-query-open, editor-top-toolbar, tag-query-dom-surface-trial]
---

# Tag-query editor, slice 4: trial of CodeMirror with block decorations as the outer surface

Part of Peek item `item_1790655511612_0mmmdmy59`; design in `tag-query-editor-view.md`
(Decisions: "Outer surface", "Scale"). The second trial. It implements the same small interface as
`query-surface-dom.js` (`select`, `fold`, `unfold`, `foldAll`, `unfoldAll`, `blockCount`) so the
comparison drives both the same way. It depends on the DOM trial only for that interface and the
measurement harness.

## What goes

New `features/editor/query-surface-cm.js`: one CodeMirror document whose text is the item blocks, each
item rendered with a block widget decoration (title row, plain body), created through the existing
`createEditor` in `features/editor/codemirror.js` so theming and vim come with it. Block selection and
block-level fold map onto document ranges and `foldEffect`. Block folds must be block-level only; the
existing per-line fold machinery (`canStartFold` / `hasFoldableChildren`) must not act on the outer
surface. If `createEditor` needs a narrow option to disable that, add the option and leave the
single-document defaults untouched.

`home.js`: honor `surface=cm` from the URL param introduced by the DOM trial, and the same
`syntheticBlocks=1000` harness. Record initial mount time, fold-all/unfold-all time and 100-block
selection movement time under **Result**.

Record, with a short note each, how the surface handles the other criteria: j/k and fold, search, `:`
commands, marks (expected to come free from vim), and what is needed for an inline editor inside a
widget to take over the one vim command area, including whether two vim-enabled CodeMirror instances
in one window coexist (unverified in the repo: the tags view runs one at a time). A small throwaway
check that creates two instances and shows whether both receive keys is part of this slice.

## What stays

- The single-document editor defaults, and `editor-folding.spec.ts`, unchanged.
- No new dependency.

## Tests to change

New `apps/desktop/tests/unit/query-surface-cm.test.js` for the pure parts (mapping a block index to a
document range and back). If those parts cannot be separated from a DOM, say so under **Result**.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test node --test apps/desktop/tests/unit/query-surface-cm.test.js
```

Done when the run reports `fail 0` and **Result** holds the 1000-block numbers and the two-instance
finding. Numbers or key-handling observations that need the Electron app and were not taken are
reported as gaps that need the user to run the harness; never invent figures.

## Result

Built `features/editor/query-surface-cm.js`: `buildBlockDoc`, `blockIndexAt` and `clampIndex` are the pure
block-to-document-range mapping (unit tested); `mountCmSurface` loads CodeMirror on demand and mounts one
document (per block: title line, body lines, blank separator) through `createEditor`, with each title line
replaced by a block widget and the selected block marked on its widget; `measureSyntheticBlocks` is the
same harness as the DOM trial over the shared `syntheticItems`. `createEditor` gained `lineFolds` (false
drops the per-line fold service and fold gutter) and `extraExtensions`; `codemirror.js` gained a
`blockFoldAt` facet that the vim fold commands (`zc zo za zM zR zm zr <Space>`) use instead of the
per-line heuristics when present. Defaults for the single-document editor are unchanged. `home.js` honors
`surface=cm` for both the tag query and `syntheticBlocks=N`.

- `yarn workspace @peek/desktop build` succeeded. `node --test tests/unit/query-surface-cm.test.js`: tests 9,
  pass 9, fail 0 (the DOM trial's 11 also still pass).
- Not run: `editor-folding.spec.ts` and the rest of the Playwright suite (the single-document path was
  only touched by added options with the old defaults).

Measurements, 1000 generated blocks (same items as the DOM trial), headless Electron 43, Apple M4 32 GB,
window 1024x923, same timing method (one forced layout per timing, module loading excluded). Times in ms:

| run | mount | foldAll | unfoldAll | select across 100 blocks |
| --- | --- | --- | --- | --- |
| on load (cold) | 16.6 | 18.3 | 13.6 | 41.6 |
| rerun 1 | 5.7 | 11.3 | 6.5 | 46.5 |
| rerun 2 | 5.5 | 15.0 | 7.1 | 39.4 |
| rerun 3 | 3.7 | 7.8 | 6.1 | 38.0 |

Reruns ran while the first surface was still in the page. Mount is cheap because CodeMirror lays out only
the viewport; the document is 1000 blocks but few are drawn. Selection costs about 0.4 ms per step (DOM
trial with `content-visibility: auto`: about 0.2). Not measured: scrolling, blocks with rendered markdown,
the affordance column.

Live observations (headless app, fresh profile, vim driven through `Vim.handleKey`; no real OS key events):

- **j/k do not map to blocks.** They move by document line: from a title, `j` visits the heading line, the
  blank line, then each body line. Block selection through the interface (`select`) is a cursor placed on
  the title line, and the "selected block" is whichever block contains the cursor. Block-wise j/k needs
  its own vim mapping calling `select(i +/- 1)`; not built.
- **After a block fold, `j` from the title moves into the hidden body and reveals it** (the block shows
  as unfolded). Vim motions count document lines, not visible ones, so skipping folded blocks also needs
  the custom j/k.
- **Block fold maps to blocks** for `zc`, `zo`, `za`, from the title line or from any body line of the
  block, and for `zM`/`zR` (all 1000 blocks fold and unfold). Before the `blockFoldAt` facet covered
  `zM`/`zR`, `zM` folded the markdown language's heading sections instead (a block-level fold must not
  do that); the facet fixes it. The language's heading and fence folds still exist in `foldable()` for
  anything else that calls it.
- **Two vim instances coexist.** An outer surface and one inline editor created with `createEditor` in
  the same window keep separate vim state: `i` on one leaves the other in normal mode, `l` moves only
  the one it is sent to, real `keydown` events go to the focused one. **They do not share one status
  line**: `:` on each opens its own `.cm-vim-panel` inside its own editor, so two prompts can be open at
  once. Driving one shared status line needs the takeover (inline editor suppresses the outer panel
  and routes its own to the shared line), which is not built.
- Gaps, need the user: real key events from a real keyboard and the `<Esc>` interception (`api.escape`)
  with an inline editor focused (headless, keys were sent through the vim API and synthetic DOM events);
  painted appearance of the widgets (headless opacity 0, never looked at).
- **In-document search:** `/` and `n` come with vim and the already-loaded search keymap and operate on the
  document text, which includes every block's body. Not exercised live.
- **`:` commands and marks:** `:` opens the panel (observed above); `:w`/`:q` are the editor's existing
  ex-commands and would act on the outer surface unless overridden. Marks (`m`, `'`) come with vim and
  are not exercised.
- **Inline editor takeover:** a block widget can host a nested `createEditor` (coexistence shown above);
  the open parts are the shared status line, `Esc` routing, and the outer surface being read-only so
  edits go only through the inline editor.

## Working rules

Run one command per Bash call. Never run the Electron gate without an explicit OK. Not landing within
about 15 minutes of work: commit nothing and report back.
