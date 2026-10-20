---
enabled: true
touches: [apps/desktop/main/cmd-chain.test.ts, apps/desktop/main/cmd-logic.test.ts, apps/desktop/tests/unit/cmd-chain.test.js, apps/desktop/tests/unit/cmd-logic.test.js, apps/desktop/renderer/cmd/panel.js, apps/desktop/renderer/cmd/panel-logic.js, apps/desktop/renderer/cmd/commands/note.js, apps/desktop/renderer/lib/note-tags.js, apps/desktop/features/files/background.js, apps/desktop/features/files/formatters.js, apps/desktop/renderer/index.js]
depends-on: []
---

# Point the cmd-panel, note-command and file-formatter tests at real code

Part of Peek item `57895545`. Two flagged main-process tests, `cmd-chain` and `cmd-logic`, copy
logic from the cmd panel, the note command, the files feature and the tile preload.

Rule for every slice of this item: the shipped code is presumed correct. A test is pointed at the
real code; where a case only passed because the inline copy behaves differently, the case is changed
to the real behaviour, and the difference is named in the commit message and under **Result**. Where
no real counterpart exists any more, the copy and its cases are deleted and named. Product behaviour
does not change.

## Problem

`node scripts/lint-test-honesty.mjs` (run from the repo root) flags both files. Real counterparts:

- `renderer/cmd/panel.js`: `mimeTypeMatches`, `findChainingCommands`, `buildExecutionContext`,
  `updateAdaptiveFeedback`, `getAdaptiveScore`, `getFrecencyScore`. All are module-private, in a
  ~130-DOM-reference file that cannot be imported under node. Precedent for moving pure helpers
  out: the landed spec `specs/honesty-extract-main-pure-helpers.md`.
- `renderer/cmd/commands/note.js`: `parseTagset` and `detectType`, private. `note.js` imports
  `peek://app/api.js`, so it cannot load under node. `renderer/lib/note-tags.js` (which `note.js`
  already imports for `splitTrailingTags`) is the natural home if it is itself pure.
  `extractInlineHashtags` has no counterpart by that name. Find where `note.js` extracts inline
  hashtags, or delete the copy.
- `features/files/background.js`: `jsonToCsv` and the markdown formatter the test calls
  `formatAsMarkdown` (find its real name). `background.js` reads `window.app` at load and exports
  only a default object.
- `isTextMimeType`, the ESC-state copy `getEscAction` and the tab-cycle copy `getTabCycleIndex` have
  no counterpart by those names. Confirm by search, and look for the equivalent logic in `panel.js`.
  If it exists as a separable pure computation, move it out with the others; otherwise delete the
  copy and its cases.
- `shouldBlockDrag` copies `main/tile-preload.cts shouldBlockDrag`, which lives inside the preload's
  drag IIFE. The sandboxed preload may only `require('electron')`, so it cannot import a helper
  module. Delete these copy cases. The real function also differs from the copy, which blocks drag
  on an editable element even when it is not focused, while the real one blocks only a focused one;
  that difference is deliberate.
- The "Settings command -- pane list integrity" cases in `cmd-logic.test.ts` copy `SETTINGS_PANES`
  from `renderer/index.js`. Either read the list from the real source (a source-read guard is
  accepted by the lint) or export it from a pure location. Keep the regression intent described in
  the block's comment.

## What goes

1. Move the `panel.js` helpers above into a new pure `renderer/cmd/panel-logic.js`, exported, and
   import them back into `panel.js`. Bodies move verbatim; any module state a helper reads becomes a
   parameter, with the call site passing it.
2. Move `parseTagset` and `detectType` (and the inline-hashtag logic if found) out of `note.js` into
   `renderer/lib/note-tags.js`, or into a new pure module if `note-tags.js` is not pure, and import
   them back.
3. Move `jsonToCsv` and the markdown formatter out of `files/background.js` into a new pure
   `features/files/formatters.js`, imported back.
4. Rewrite both tests as `tests/unit/cmd-chain.test.js` and `tests/unit/cmd-logic.test.js` (plain
   `node --test`) importing the real modules. Delete the `main/` versions and their stale
   `apps/desktop/dist/main/*.test.js` outputs before running the main-process glob.

## What stays

- Behaviour of the cmd panel, the note command and the files feature.
- `main/tile-preload.cts`: not edited.
- `features/groups/home.js` belongs to `honesty-groups-and-item-actions`, which waits on this spec
  because both touch large renderer files.

## Verify

Run each in its own Bash call from the repo root, and record counts under **Result**.

```
node scripts/lint-test-honesty.mjs
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
```

Done when neither `cmd-chain` nor `cmd-logic` appears in the lint output, and both runners report
`fail 0`. Every deleted case is named in the commit message, grouped by the copied function it
tested. Because `panel.js` changes, also run the Playwright cmd specs on Linux
(`yarn test:grep "cmd"`) and record pass/fail counts. Compare any failure against `main` before
calling it new.
