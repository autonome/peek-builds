---
enabled: true
touches: [apps/desktop/features/editor/query-inline-editor.js, apps/desktop/features/editor/status-line.js, apps/desktop/features/editor/home.js, apps/desktop/features/editor/query-keys.js, apps/desktop/tests/unit/query-inline-editor.test.js]
depends-on: [tag-query-block-nav-folding]
---

# Tag-query editor, slice 8: inline editor, one vim command area, and the `<Esc>` cascade

Part of Peek item `item_1790655511612_0mmmdmy59`; design in `tag-query-editor-view.md`
("Inline editing", "The single vim command area"; Decisions: "Edits apply instantly", "Vim command
area"). The riskiest interaction in the design: keep this slice to the takeover and its edges.

## What goes

New `features/editor/query-inline-editor.js`, modeled on `createEmbeddedEditor` /
`destroyEmbeddedEditor` / `handleEscape` / `scheduleEditorAutosave` in `features/tags/home.js`:

- `<Enter>` on the selected block opens an embedded editor (via `createEditor` from
  `features/editor/codemirror.js`, vim from the `vimMode` preference) inside that block, replacing its
  rendered body. Only one is open at a time.
- The existing `StatusLine` instance is the only vim command area. While an inline editor is open,
  its `onVimModeChange` and `onSelectionChange` drive that instance; on close the outer surface's state
  is restored. No second status line is created.
- Autosave: debounced `api.datastore.updateItem(id, { content, title })` at the editor's
  `AUTOSAVE_DELAY_MS` (1500 ms), flushed when the block closes by `<Esc>`, by a fold command collapsing
  it, or by moving selection.
- `<Esc>` cascade, innermost first: vim insert goes to normal (handled here, because the preload
  intercepts `<Esc>` before CodeMirror's vim sees it); then the inline editor closes and selection
  returns to the block; then the editor window's existing `<Esc>` behavior.
- While an inline editor is open, `z` keys and `j`/`k` belong to it; `query-keys.js` is told through a
  small `inlineOpen` flag in its state.
- A pure function for the cascade decision (`escapeAction(state)`) so it is testable.

## What stays

- The window's existing `<Esc>` behavior and `StatusLine` public methods.
- Edits made elsewhere to the open item are not merged in v1; the editor keeps its text until closed
  (the live-updates slice records the rest).

## Tests to change

New `apps/desktop/tests/unit/query-inline-editor.test.js` for `escapeAction` (insert, open, closed
states) and for the flush-on-close decision. The takeover and key handling are not unit-testable.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test node --test apps/desktop/tests/unit/query-inline-editor.test.js apps/desktop/tests/unit/*.test.js
```

Done when the run reports `fail 0`. Report under **Result** as gaps that need the user's action in the
Electron app: the status line showing the inline editor's mode and position and restoring afterward,
`<Esc>` cascade order, and that the preload interception behaves as the tags view's comment says in this
window (unverified so far).

## Working rules

Run one command per Bash call. Never run the Electron gate without an explicit OK. Not landing within
about 15 minutes of work: commit nothing and report back.
