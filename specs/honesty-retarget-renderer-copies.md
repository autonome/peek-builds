---
enabled: true
touches: [apps/desktop/main/noun-registry.test.ts, apps/desktop/main/completers.test.ts, apps/desktop/tests/unit/completers.test.js, apps/desktop/tests/unit/card-helpers-favicon.test.js, apps/desktop/renderer/lib/card-helpers.js]
depends-on: []
---

# Point three renderer-logic tests at the real modules instead of inline copies

Part of Peek item `57895545`. This slice covers the three flagged unit tests whose product module
is plain ES-module JS that Node can import today, so no extraction is needed: `noun-registry`,
`completers` and `card-helpers-favicon`.

## Problem

`yarn lint:test-honesty` flags all three because each one re-implements the code it claims to
test and imports nothing from the product:

- `apps/desktop/main/noun-registry.test.ts` holds inline copies of `validateNounDef()` and
  `generateCommandsFromNoun()` ("avoids ESM import issues in test runner"). The real
  `apps/desktop/renderer/cmd/noun-registry.js` exports both, has no imports, and touches no
  `window`/`document`, so it imports cleanly.
- `apps/desktop/main/completers.test.ts` holds inline copies of `completeEnum()` and a
  tags-array variant of `completeTag()`. The real `apps/desktop/renderer/cmd/completers.js`
  exports `completeEnum`, `completeTag`, `completeItem`, `getSuggestions` and `invalidateCache`,
  has no imports, but reads `const api = window.app;` at module top level, so it throws
  `ReferenceError` in Node unless `globalThis.window` exists first. `completeTag` fetches through
  `api.datastore.getTagsByFrecency()` behind a 5-second cache (`tagCache`, `invalidateCache()`).
- `apps/desktop/tests/unit/card-helpers-favicon.test.js` holds inline copies of `TYPE_ICONS`,
  `extractTitle`, `formatUrl`, `extractUrl`, `_googleFaviconFallback` and `getItemDisplayInfo`
  ("the module uses DOM APIs"). In `apps/desktop/renderer/lib/card-helpers.js` `document` is only
  touched inside function bodies (`createHeaderSlot`, `createFaviconEl`, `createUrlSpan`), never at
  load, so a plain import works. The real `getItemDisplayInfo` has since gained an `event` item
  type and a `thumbnailHash` field the copy lacks; the copies of everything the tests assert on
  are otherwise identical.

## What goes

- `noun-registry.test.ts`: delete the inline copies and their local `NounDef` / `CommandMeta`
  interfaces (keep local types only where a call needs one). Load the real functions with a
  computed dynamic import, the pattern `main/entity-frecency.test.ts` uses:
  `const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')`, then
  `await import(resolve(projectRoot, 'renderer', 'cmd', 'noun-registry.js'))`. A static import of
  the `.js` file from a `main/*.test.ts` would fail to compile (no `allowJs`, no declaration file),
  which is why the computed path is used. Fix the header comment's stale
  `extensions/cmd/noun-registry.js` path. Test cases stay as they are.
- `completers.test.ts`: move to `apps/desktop/tests/unit/completers.test.js` (plain `node --test`,
  since the module needs a `window` stub that the electron runner has no reason to carry). Delete
  the old file. In the new file set `globalThis.window = { app: { datastore: { getTagsByFrecency:
  async () => ({ success: true, data: tags }) } } }` before the dynamic import (precedent:
  `tests/unit/lex-atproto-proxy.test.js` stubs `globalThis.window` the same way), load
  `renderer/cmd/completers.js` through `join(__dirname, '..', '..', 'renderer', 'cmd',
  'completers.js')` like `tests/unit/url-completion.test.js`, and call `invalidateCache()` between
  `completeTag` cases so the 5-second cache never leaks one case's tag list into the next. The
  existing case bodies keep their expectations (`completeEnum` tests use `values`, which the real
  function supports; the real one additionally supports `options`, which may get one added case).
- `card-helpers-favicon.test.js`: delete the inline copies and import the real module the same
  way. About 18 cases call `_googleFaviconFallback`, `extractUrl` and compare against
  `TYPE_ICONS` / `GLOBE_FAVICON`, none of which `card-helpers.js` exports today. Add `export` to
  those four (`GLOBE_FAVICON`, `TYPE_ICONS`, `extractUrl`, `_googleFaviconFallback`) in
  `card-helpers.js`; no behaviour changes. Where a case does a deep-equal on the whole
  `getItemDisplayInfo` result, account for the real `thumbnailHash` field rather than deleting the
  case. Add one case for the `event` item type.

## What stays

- Product behaviour: `renderer/cmd/noun-registry.js` and `renderer/cmd/completers.js` are not
  edited. `card-helpers.js` gains exports only.
- The other flagged files listed in the item; other specs cover them.
- No `// @no-product-import` escape hatch on any of these three; each imports real code.

## Verify

Run each command in its own Bash call and record counts under **Result**.

```
node scripts/lint-test-honesty.mjs
```

Exits 1 while other flagged files remain (this slice does not clear them); done when none of
`noun-registry.test.ts`, `completers.test.js`, `card-helpers-favicon.test.js` appears in its output.

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/noun-registry.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/completers.test.js apps/desktop/tests/unit/card-helpers-favicon.test.js
```

Delete the stale `apps/desktop/dist/main/completers.test.js` (the build does not remove outputs of
deleted sources) before running the full gate glob. Done when all three files report `fail 0`
and the full repo gate (build, `electron --test apps/desktop/dist/main/*.test.js`,
`node --test apps/desktop/tests/unit/*.test.js`) reports `fail 0`. If a case fails only because
the real code differs from the old copy, fix the case to the real behaviour and name the case and
difference in the commit message.
