---
enabled: true
touches: [apps/desktop/features/editor/editor-layout.js, apps/desktop/features/editor/home.css, apps/desktop/features/editor/home.js, apps/desktop/features/editor/sort-options.js, apps/desktop/tests/unit/sort-options.test.js]
depends-on: [tag-query-open]
---

# Tag-query editor, slice 2: a collapsible top toolbar in `EditorLayout` with a sort dropdown

Part of Peek item `item_1790655511612_0mmmdmy59`; design in `tag-query-editor-view.md`
(Decisions: "Top toolbar"). The toolbar is a general editor capability, so it lives in `EditorLayout`
and either editor mode may host it.

## Problem

`EditorLayout` has one toolbar, below the editor pane (`this.toolbar`). The query view needs controls
above the document, starting with a sort order, and the single-document editor should be able to use
the same element later.

## What goes

`editor-layout.js` `EditorLayout`:

- A top toolbar element above the center area, hidden by default, with a small handle styled like the
  sidebar separators that collapses and expands it. Collapsed state persists with the layout prefs
  (`editor:layout-prefs`).
- A method to set its controls from the host (`setTopToolbar(controls)` or equivalent) so the layout
  knows nothing about sorting; with no controls set it renders nothing and takes no space, so the
  single-document editor looks exactly as before.

New leaf module `features/editor/sort-options.js`, pure functions:

- `SORT_OPTIONS`: `updated-desc` (default), `updated-asc`, `created-desc`, `created-asc`,
  `title-asc`, with labels.
- `sortItems(items, optionId)`: sorted copy; unknown id falls back to `updated-desc`; title sort uses
  the shared `extractTitle` convention.

`home.js`: in query mode, give the layout one control, a sort dropdown over `SORT_OPTIONS`, and reorder
the slice 1 title list when it changes. The selected option is held in window state only; persisting it
is not part of this slice.

## What stays

- The existing bottom toolbar and its tests.
- The single-document path: no controls set means no visible change.

## Tests to change

New `apps/desktop/tests/unit/sort-options.test.js`: each option's order, ties, missing timestamps,
unknown id fallback, input not mutated. Do not change `editor-layout.spec.ts`; it must still pass
unchanged when the gate is run.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test node --test apps/desktop/tests/unit/sort-options.test.js
```

Done when the run reports `fail 0`. The toolbar's appearance, collapse handle and persisted state, and
`editor-layout.spec.ts` staying green, need the Electron app and are not exercised here; say so under
**Result**.

## Working rules

Run one command per Bash call. Never run the Electron gate without an explicit OK.
