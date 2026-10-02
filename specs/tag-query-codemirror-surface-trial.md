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

## Working rules

Run one command per Bash call. Never run the Electron gate without an explicit OK. Not landing within
about 15 minutes of work: commit nothing and report back.
