---
enabled: true
touches: [apps/desktop/renderer/lib/session.js, apps/desktop/renderer/lib/session.d.ts, apps/desktop/main/session.test.ts]
depends-on: []
---

# Delete the canvas container-URL helpers `extractRealUrl` and `extractCanvasBounds`

Part of Peek item `f1ea471d`. This is the slice for the two canvas-only URL helpers in the shared
session module and the test-local copies that keep them looking alive.

## Problem

`apps/desktop/renderer/lib/session.js` exports `extractRealUrl()` and `extractCanvasBounds()`.
Both parse the canvas page container URL (`peek://app/page/index.html?url=<real>&x=&y=&width=&height=`),
where the canvas page encoded the webview's real URL and bounds. The canvas page-host that produced
those URLs is gone (`apps/desktop/renderer/page/` no longer has an `index.html`; the hybrid page-host
keeps the real URL and bounds on the window itself).

Neither function has a caller anywhere in the repo: nothing imports `renderer/lib/session.js` (the
only mention is a comment in `main/session.ts`), and `main/session.ts` has no such functions.
`main/session.test.ts` defines its own copies with the comment "Identical to session.ts
extractRealUrl", so the `extractRealUrl` and `extractCanvasBounds` describe blocks there test
copies of code that ships nowhere.

## What goes

- `renderer/lib/session.js`: `extractRealUrl()` and `extractCanvasBounds()` with their doc comments.
- `renderer/lib/session.d.ts`: the two matching `export declare function` lines.
- `main/session.test.ts`:
  - the two local function copies (`extractRealUrl`, `extractCanvasBounds`) and their doc comments;
  - the `describe('extractRealUrl', ...)` and `describe('extractCanvasBounds', ...)` blocks;
  - the test `'canvas page URLs get real URL extracted (not peek://app/page)'`, which only calls
    the local `extractRealUrl` copy.
- `main/session.test.ts`, test `'preserves canvas page bounds (not fullscreen) through save/load'`:
  keep the test (it is a plain bounds round trip through `saveSnapshot`/`readSnapshot`), but reword
  its comment so it no longer says the save logic uses `extractCanvasBounds`.

Before deleting, re-run the caller check:
`grep -rn "extractRealUrl\|extractCanvasBounds" apps packages scripts --include=*.ts --include=*.js --include=*.mjs --exclude-dir=node_modules --exclude-dir=dist`
must show hits only in the three files above. If anything else references them, leave that
function in place and note it under **Result**.

## What stays

- The rest of `renderer/lib/session.js` (`SYSTEM_WINDOW_URLS`, `sanitizeParams`,
  `validateSnapshot`, crash-count and restore helpers). The module has no importer either, but
  whether it is kept as the "shared copy for frontend/Tauri use" that `main/session.ts` documents is
  a separate decision; this slice does not delete it.
- The `peek://app/page` handling in `main/window-address.ts` `resolveWindowAddress()`, in `ipc.ts`
  around the `peek://app/page` container extraction, in `session-partition.ts`, and in
  `tile-preload.cts`. The overlay window loads `peek://app/page/overlay.html`, so those prefix
  checks are not trivially dead and need their own review.
- `docs/page-host-state-machine.md` (a historical design note that names `extractCanvasBounds`).

## Verify

```
yarn workspace @peek/desktop build && NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js && NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
grep -rn "extractRealUrl\|extractCanvasBounds" apps --include=*.ts --include=*.js --exclude-dir=node_modules --exclude-dir=dist
```

Done when the build compiles, both runners report `fail 0`, the electron runner's test count drops
by exactly the tests removed from `session.test.ts` (record both counts under **Result**), and the
grep prints nothing.
