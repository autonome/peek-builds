---
enabled: true
touches: [apps/desktop/main/tag-action-affordances.test.ts, apps/desktop/tests/unit/tag-action-affordances.test.js, apps/desktop/tests/unit/editor-outline-preview.test.js, apps/desktop/features/editor/outline-sidebar.js, apps/desktop/features/editor/preview-sidebar.js, apps/desktop/features/editor/highlights.js, apps/desktop/renderer/lib/tag-action-affordances.js]
depends-on: []
---

# Point the tag-affordance and editor outline/preview tests at the real modules

Part of Peek item `57895545`. This slice covers the two flagged tests whose product code is already
exported from plain ES modules, so no extraction should be needed: `tag-action-affordances` and
`editor-outline-preview`.

Rule for every slice of this item: the shipped code is presumed correct. A test is pointed at the
real code; where a case only passed because the inline copy behaves differently, the case is changed
to the real behaviour, and the difference is named in the commit message and under **Result** (it
may become a separate bug report). Product behaviour does not change in this slice.

## Problem

`node scripts/lint-test-honesty.mjs` (run from the repo root) flags both files because each tests an
inline copy and imports nothing from the product.

- `apps/desktop/main/tag-action-affordances.test.ts` copies the affordance resolution logic. The
  real `apps/desktop/renderer/lib/tag-action-affordances.js resolveAffordances(itemTagNames, rules)`
  is exported, has no imports, and touches no DOM at load. Its real rule shape differs from the
  copy's: rules carry `scriptId: 'tag-swap'`, a `config` object and a `display` object. Most cases
  need rewriting to that shape rather than a find-and-replace. `findAffordanceByKey` is also
  exported. `apps/desktop/tests/unit/tag-action-keys.test.js` already imports this module and is
  the precedent for loading it.
- `apps/desktop/tests/unit/editor-outline-preview.test.js` copies header parsing, markdown
  rendering and highlight serialisation. The real code is exported:
  `features/editor/outline-sidebar.js parseHeaders`, `features/editor/preview-sidebar.js
  renderMarkdown`, and `features/editor/highlights.js` (`serializeHighlights`,
  `deserializeHighlights`, `nextHighlightColor`, `generateHighlightId`, and others).
  `outline-sidebar.js` imports `@codemirror/language` and `highlights.js` imports `@codemirror/state`
  and `@codemirror/view`. *Unverified*: whether these load under plain `node --test` with no DOM.
  Check this first.

## What goes

1. Move `main/tag-action-affordances.test.ts` to `tests/unit/tag-action-affordances.test.js` (plain
   `node --test`, beside `tag-action-keys.test.js`, which loads the module the same way). Delete
   the old file. Rewrite its cases against `resolveAffordances` / `findAffordanceByKey` with real
   rule objects, keeping each case's intent (which tags produce which affordances, ordering,
   de-duplication, and so on). Delete the stale `apps/desktop/dist/main/tag-action-affordances.test.js`
   before running the main-process glob, because the build does not remove the output of a deleted
   source.
2. `editor-outline-preview.test.js`: delete the inline copies and import the real functions. If a
   `@codemirror/*` import fails under node with no DOM, set up the smallest global stub that makes
   it load (precedent: `tests/unit/lex-atproto-proxy.test.js` stubs `globalThis.window`). If no stub
   is enough, move only the affected pure function into a DOM-free sibling module that the original
   file imports back, and name the move under **Result**. Do not add a `// @no-product-import`
   escape hatch.
3. Exports may be added to the four product files listed in `touches` if a case needs a symbol
   they keep private. No other product edits.

## What stays

- Behaviour of every product module.
- The other flagged files; other specs cover them.

## Verify

Run each in its own Bash call from the repo root, and record counts under **Result**.

```
node scripts/lint-test-honesty.mjs
yarn workspace @peek/desktop build
NODE_ENV=test node --test apps/desktop/tests/unit/tag-action-affordances.test.js apps/desktop/tests/unit/tag-action-keys.test.js apps/desktop/tests/unit/editor-outline-preview.test.js
```

Done when neither test file appears in the lint output (the lint still exits 1 while other flagged
files remain), and all three test files report `fail 0`. Then the full repo gate (build,
`NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js`,
`NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js`) reports `fail 0`. Test counts may
drop only for cases deleted as pure copies, each named in the commit message.
