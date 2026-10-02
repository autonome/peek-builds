---
enabled: true
touches: [apps/desktop/features/editor/query-blocks.js, apps/desktop/features/editor/home.js, apps/desktop/features/editor/home.css, apps/desktop/tests/unit/query-blocks.test.js]
depends-on: [tag-query-surface-pick]
---

# Tag-query editor, slice 6: block rows with the tag-binding left column and per-type rendering

Part of Peek item `item_1790655511612_0mmmdmy59`; design in `tag-query-editor-view.md`
("The document", "Left column: tag bindings"). Builds on the surface that won the pick.

## What goes

New `features/editor/query-blocks.js`: builds one block's rows for an item and hands them to the
surface.

- Title row: first content line with the heading marker stripped (`extractTitle` from
  `renderer/lib/card-helpers.js`).
- Left column: the item's tag bindings through `renderer/lib/tag-action-affordances.js`
  (`createAffordanceElements`, `resolveAffordances`, rules from `createActionRulesCache`). Clicks
  publish `affordance:click`. The shared module is reused, not copied.
- Body by type: `text` renders markdown with `renderMarkdown` from
  `features/editor/preview-sidebar.js`; `url` renders like a card row (favicon, title, URL via
  `getItemDisplayInfo` / `createUrlSpan`) with its notes below; `image` renders the image static with
  its notes below. Other item types are left out of the document.
- A pure function `blockRowsModel(item)` returning the type, title, and which rows exist, so the choice
  is testable without a DOM.

Replace the slice 1 title list in `home.js` with the surface populated through this module. The
outline sidebar lists block titles with the fallback in the Decisions ("Outline"); no preview
sidebar in query mode.

## What stays

- Selection and folding mechanics from the surface slice; keys come in the next slice.
- No editing yet: blocks are read-only here.

## Tests to change

New `apps/desktop/tests/unit/query-blocks.test.js` for `blockRowsModel`: text with and without a
heading, url with and without notes, image, an unsupported type being filtered out, empty content
falling back as the Decisions describe.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test node --test apps/desktop/tests/unit/query-blocks.test.js apps/desktop/tests/unit/editor-outline-preview.test.js
```

Done when both report `fail 0`. Affordance clicks and rendered appearance need the Electron app and
are not exercised here; say so under **Result**.

## Working rules

Run one command per Bash call. Never run the Electron gate without an explicit OK.
