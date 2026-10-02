---
enabled: true
touches: [specs/tag-query-editor-view.md, apps/desktop/features/editor/home.js, apps/desktop/features/editor/query-surface-dom.js, apps/desktop/features/editor/query-surface-cm.js]
depends-on: [tag-query-dom-surface-trial, tag-query-codemirror-surface-trial]
---

# Tag-query editor, slice 5: compare the two surface trials and keep one

Part of Peek item `item_1790655511612_0mmmdmy59`; design in `tag-query-editor-view.md`
(Decisions: "Outer surface"). A decision slice with a small amount of deletion.

## What goes

Write the comparison into `tag-query-editor-view.md` Decisions as facts with reasons, one line per
criterion, from the numbers and notes in the two trial specs' **Result** sections:

- `j`/`k` and block folding.
- One vim command area taken over by the inline editor.
- Search, `:` commands and marks.
- Behavior at about 1000 blocks (measured figures, not impressions).
- Single-document editor tests unaffected.

Then name the winner and the reason, remove the loser's file and the `surface` URL param and its
branch in `home.js`, and keep the winner as the only query-mode surface. If a criterion could not be
measured, say which and what decided it instead; do not fill the gap with an estimate.

If the trial results do not separate the two, the tie goes to plain DOM blocks: it adds no outer vim
instance and is the cheaper of the two to maintain. Record that as the reason.

## What stays

- The winner's interface (`select`, `fold`, `unfold`, `foldAll`, `unfoldAll`, `blockCount`) and its
  tests.
- The single-document editor path.

## Tests to change

Delete the loser's unit test file; keep the winner's.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
```

Done when the run reports `fail 0`, `grep -rn "surface=" apps/desktop/features/editor` finds nothing,
and the decision text names the winner with its reasons.

## Working rules

Run one command per Bash call. Never run the Electron gate without an explicit OK.
