---
enabled: true
touches: [apps/desktop/main/group-mode.test.ts, apps/desktop/main/space-mode.test.ts, apps/desktop/main/page-navigation.test.ts, apps/desktop/tests/unit/url-compare.test.js, apps/desktop/tests/unit/space-mode.test.js, apps/desktop/renderer/page/overlay.js, apps/desktop/renderer/page/url-compare.js, apps/desktop/features/spaces/config.js, apps/desktop/features/spaces/background.js, apps/desktop/features/spaces/space-logic.js]
depends-on: []
---

# Point the group-mode, space-mode and page-navigation tests at real code, or delete them where none exists

Part of Peek item `57895545`. Three flagged main-process tests copy logic about window modes and URL
comparison. They share one copied function (`normalizeUrlForCompare`), so they are one slice.

Rule for every slice of this item: the shipped code is presumed correct. A test is pointed at the
real code; where a case only passed because the inline copy behaves differently, the case is changed
to the real behaviour, and the difference is named in the commit message and under **Result**. Where
no real counterpart exists any more, the copy and its cases are deleted and named. Product behaviour
does not change.

## Problem

`node scripts/lint-test-honesty.mjs` (run from the repo root) flags all three.

- `main/page-navigation.test.ts` copies two functions:
  - `shouldHandleNavKey`, "extracted from app/page/page.js keydown listener". No function by that
    name, or with that logic as a unit, exists in the tree today. Confirm with a search before
    deleting.
  - `normalizeUrlForCompare`. The real one is `renderer/page/overlay.js normalizeUrlForCompare`, but
    `overlay.js` reads `document.getElementById` and adds listeners at module top level, so it
    cannot be imported under node. Precedent for the fix: `renderer/page/navbar-load-reveal.js` is a
    pure module that `overlay.js` imports.
- `main/group-mode.test.ts` copies `resolveGroupBorderColor`, `shouldAutoTagForGroup`,
  `shouldInheritGroupMode`, `shouldResetGroupOnTagRemoval` and another `normalizeUrlForCompare`, and
  names `main/ipc.ts` as their source. None of the first four exists by name in `main/` today. The
  live mode logic sits in `features/spaces/background.js` (`resolveSpaceBorderColor`, the
  `tag:item-removed` subscription `handleTagRemoved`) and in `main/datastore.ts`. Each copy is
  either matched to a real counterpart or deleted.
- `main/space-mode.test.ts` copies:
  - `isSpaceTag`, `getSpaceDisplayName` and `toSpaceTagName`. These are real and exported from
    `features/spaces/config.js`.
  - `detectModeFromUrl` and `shouldPreserveMode`. The real code is `main/datastore.ts
    detectModeFromUrl` and `updateModeForNavigation`, both exported. Other main-process tests,
    `datastore.test.ts` among them, import `datastore.ts`.
  - `shouldAutoTagForSpace`, `resolveSpaceBorderColor` and `shouldShowSpaceBorder`. The real
    versions are inline in `features/spaces/background.js`.

  Known difference: the copy's `shouldPreserveMode` keeps space mode when navigation detects
  `'default'` as well as `'page'`. The real `updateModeForNavigation` keeps `space` or `group` mode
  only against `'page'`, so a space window that navigates to a non-web URL drops to default. The
  test follows the real behaviour; the difference is already filed as a separate question.

## What goes

1. Move `normalizeUrlForCompare` out of `overlay.js` into a new pure
   `renderer/page/url-compare.js`, exported, and have `overlay.js` import it back. The
   function body moves verbatim. Its cases move into `tests/unit/url-compare.test.js`, which
   imports the new module. `features/groups/home.js` and `features/spaces/home.js` keep their own
   copies of this function for now; merging them is out of scope.
2. Delete the `shouldHandleNavKey` copy and every case that uses it, unless the search finds a real
   counterpart. `page-navigation.test.ts` is deleted if nothing remains.
3. `space-mode`: test the `config.js` helpers by importing them. Test `detectModeFromUrl` and
   `updateModeForNavigation` from `datastore.ts` in the main-process runner, the way
   `datastore.test.ts` sets up a datastore, asserting the mode context entry after navigation. For
   the three functions inline in `spaces/background.js`, move each one that is pure into a new
   `features/spaces/space-logic.js`. Call sites in `background.js` import it back, with bodies moved
   verbatim and no behaviour change. The cases then import it. Any that cannot be lifted without
   changing behaviour are deleted and named. Plain-JS cases may live in
   `tests/unit/space-mode.test.js`. Where a case moves out of `main/`, delete the stale
   `apps/desktop/dist/main/<name>.test.js` before running the main-process glob.
4. `group-mode`: for each copied function, find the real counterpart, which will most likely be the
   space versions above. Where one exists and is now importable, point the case at it (or fold it
   into the space-mode test if it duplicates one). Otherwise delete the copy and its cases.
   `group-mode.test.ts` is deleted if nothing remains.

## What stays

- Behaviour of `overlay.js`, `spaces/background.js`, `spaces/config.js` and `datastore.ts`.
- `features/groups/home.js` and its tests belong to the `honesty-groups-and-item-actions` spec.

## Verify

Run each in its own Bash call from the repo root, and record counts under **Result**.

```
node scripts/lint-test-honesty.mjs
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
```

Done when none of `group-mode.test.ts`, `space-mode.test.ts` or `page-navigation.test.ts` appears in
the lint output (the lint still exits 1 while other flagged files remain), and both runners report
`fail 0`. Every deleted case is named in the commit message, grouped by the copied function it
tested.
