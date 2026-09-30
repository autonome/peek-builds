---
enabled: true
touches: [apps/desktop/main/page-loading.test.ts, apps/desktop/main/tile-window-open.test.ts, apps/desktop/tests/unit/page-maximize-layout.test.js, apps/desktop/tests/unit/mcp-write-response-shape.test.js]
depends-on: []
---

# Delete three flagged tests that cover code which no longer exists, and mark the subprocess test

Part of Peek item `57895545`. This slice covers four flagged files that need no product change:
three test code that is gone (or nothing at all), and one that runs the real product as a subprocess.

## Problem

`yarn lint:test-honesty` flags these four. Each was read against main:

- `apps/desktop/main/page-loading.test.ts` defines and exports `shouldClearLoadingOnFail()`
  itself, described as "extracted decision logic from page.js did-fail-load handler". No
  `page.js` exists in `apps/desktop/renderer/page/` (canvas page-host removed), and
  `shouldClearLoadingOnFail` / `hasEverLoaded` appear nowhere else under `apps/desktop`. It
  tests its own function.
- `apps/desktop/tests/unit/page-maximize-layout.test.js` duplicates `computeWindowBounds()`,
  `positionPanelsMaximized()` and `updatePositionsMaximized()` "from app/page/page.js". None of
  those functions exists in `main/` or `renderer/` now. The models have also drifted: the test
  assumes an 8px margin around screen bounds and detects maximized via a stored
  `preMaximizeBounds`, whereas the current chrome frame is
  `apps/desktop/main/overlay-frame.ts` `expandToOverlayFrame()` / `OVERLAY_GUTTERS`, which
  `apps/desktop/main/overlay-frame.test.ts` already tests through a real import.
- `apps/desktop/main/tile-window-open.test.ts` has one case with an empty body ("documents that
  e2e coverage lives in Playwright") and imports only `node:test`. Its docstring points at
  `tests/desktop/tile-window-open.spec.ts`, which does not exist. It asserts nothing.
- `apps/desktop/tests/unit/mcp-write-response-shape.test.js` is not a copy. It spawns
  `node apps/desktop/features/mcp-server/server.js` (`SERVER_PATH`) against a temp sqlite file and
  drives `create_item` / `update_item` / `complete_task` over stdio JSON-RPC, so it exercises the
  shipping server end to end. The lint does not see this because there is no import of
  `server.js`. `shapeItemForResponse()` in `server.js` is private, so a static import is not an
  option without widening exports.

## What goes

- Delete `apps/desktop/main/page-loading.test.ts`, `apps/desktop/main/tile-window-open.test.ts` and
  `apps/desktop/tests/unit/page-maximize-layout.test.js`. Their cases guard nothing shipping. Name
  each deleted file, with its case count (7, 1 and 22), in the commit message.
- In `apps/desktop/tests/unit/mcp-write-response-shape.test.js`, add directly under the header
  comment one line that satisfies the lint's escape hatch and states why:

  `// @no-product-import: exercises features/mcp-server/server.js end to end by spawning it as a subprocess over stdio; the product is run, not imported.`

  The test body is not changed.

## What stays

- `apps/desktop/main/overlay-frame.ts` and its test: they are the coverage for the current
  maximized/overlay layout and are not edited.
- `apps/desktop/renderer/page/overlay.js` has a comment saying it "mirrors page.js
  updatePositionsMaximized". That comment is stale but lives in product code and is out of scope.
- The remaining flagged files (`closed-window`, `cmd-chain`, `cmd-logic`, `group-mode`,
  `space-mode`, `page-navigation`, `tag-action-affordances`, `editor-outline-preview`,
  `groups-quick-wins`, `peek-item-actions`) belong to other work; do not touch them.

## Verify

Run each in its own Bash call and record counts under **Result**.

```
node scripts/lint-test-honesty.mjs
```

Done when none of the four files appears in its output (the lint still exits 1 while other flagged
files remain).

Delete the stale compiled outputs `apps/desktop/dist/main/page-loading.test.js` and
`apps/desktop/dist/main/tile-window-open.test.js` (the build does not remove outputs of deleted
sources), then run the repo gate:

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
```

Done when both runners report `fail 0` and the test totals fell by exactly 30 (7 + 1 + 22)
compared with a run before the change.
