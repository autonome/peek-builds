---
enabled: true
touches: [apps/desktop/tests/unit/groups-quick-wins.test.js, apps/desktop/tests/unit/peek-item-actions.test.js, apps/desktop/tests/components/peek-item-actions.spec.ts, apps/desktop/features/groups/home.js, apps/desktop/features/groups/group-logic.js, apps/desktop/renderer/components/peek-item-actions.js]
depends-on: [honesty-cmd-tests]
---

# Point the groups and item-actions tests at real code

Part of Peek item `57895545`. Two flagged node unit tests: `groups-quick-wins` copies logic from
`features/groups/home.js`, and `peek-item-actions` copies logic from the `<peek-item-actions>`
component.

Rule for every slice of this item: the shipped code is presumed correct. A test is pointed at the
real code; where a case only passed because the inline copy behaves differently, the case is changed
to the real behaviour, and the difference is named in the commit message and under **Result**. Where
no real counterpart exists any more, the copy and its cases are deleted and named. Product behaviour
does not change.

## Problem

`node scripts/lint-test-honesty.mjs` (run from the repo root) flags both.

- `tests/unit/groups-quick-wins.test.js` (~1190 lines) copies functions from
  `features/groups/home.js`, such as `resolveCurrentGroup`, `closeGroup` and the pin helpers. The
  real versions close over module state (`activeGroupId`, `activeGroupName`) and the module-level
  `api`, and `home.js` touches the DOM throughout, so it cannot be imported under node. The copies
  take that state as parameters.

  Known stale copy: the copied `resolveCurrentGroup` reads mode `'space'` with
  `metadata.spaceId`, but the real one reads `'group'` with `metadata.groupId`, which is what the
  groups UI sets. Cases follow the real code.
- `tests/unit/peek-item-actions.test.js` copies logic from
  `renderer/components/peek-item-actions.js`, a Lit component that imports `lit` and calls
  `customElements.define` at load.

## What goes

1. Move the pure parts of the copied `home.js` functions into a new
   `features/groups/group-logic.js`, exported, with module state and `api` passed as parameters (the
   shape the copies already use). `home.js` imports them back and passes its state. Bodies move
   verbatim apart from that parameterisation. Confirm that `home.js` loads as an ES module before
   adding the import. Functions that are pure glue around `api` calls with no decision in them may
   be deleted with their cases instead of moved; name each one.
2. Rewrite `groups-quick-wins.test.js` against `group-logic.js` with the mock `api` it already
   builds.
3. `peek-item-actions`: if its logic separates cleanly into pure functions in the component file,
   export them and import them in the node test with a `globalThis.customElements` stub only if load
   requires it. Otherwise move the test to the Playwright `components` project as
   `tests/components/peek-item-actions.spec.ts`, rendering the real element (precedent: the other
   specs in `tests/components/`), and delete the node file.

## What stays

- Behaviour of the groups feature and the component.
- `features/spaces/home.js` and its copy of `normalizeUrlForCompare`.

## Verify

Run each in its own Bash call from the repo root, and record counts under **Result**.

```
node scripts/lint-test-honesty.mjs
yarn workspace @peek/desktop build
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
```

If a components spec was added, also run
`HEADLESS=1 BACKEND=electron ./scripts/playwright-with-display.sh test --config apps/desktop/playwright.config.ts --project=components`.
Because `home.js` changes, run `yarn test:grep "group"` and record counts, comparing any failure
against `main`. Done when neither file appears in the lint output, and every run above reports 0
failures not also present on `main`.
