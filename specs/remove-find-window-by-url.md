---
enabled: true
touches: [apps/desktop/main/main.ts, apps/desktop/main/ipc.ts, apps/desktop/main/index.ts, apps/desktop/tests/desktop/window-url.spec.ts]
depends-on: []
---

# Delete the canvas-era `findWindowByUrl` lookup and its fallback in `window-open`

Part of Peek item `f1ea471d`. This is the slice for the dead URL-dedup lookup; the item's other
starting points are either already handled (`normalizeUrl` port) or deliberately kept
(`findWindowByKey`), see "What stays".

## Problem

`apps/desktop/main/main.ts` `findWindowByUrl()` searches the window machine records for a window
whose `params.address` matches a URL, but only accepts records with `params.role` of `'content'` or
`'child-content'` and only returns one when `getLiveWindow(id)` (a `BrowserWindow.fromId` lookup)
resolves. Every real web-page open now goes through the hybrid page-host, which is a `BaseWindow`
that `BrowserWindow.fromId` cannot resolve. In `apps/desktop/main/ipc.ts`, the `window-open` handler
already runs `findHybridWindowByUrl()` first and returns on a hit; the `findWindowByUrl(url)` call
right after it is the canvas-era second lookup, and `usePageHost` is true for every http(s) URL that
is not `modal`/`overlay`, so the only way it could match is a modal or overlay window that the
caller explicitly gave `role: 'content'`. No caller does: every explicit `role: 'content'` open in
`features/*/home.js` and `renderer/cmd/panel.js` omits `modal`/`overlay`, so it takes the hybrid
path. The one non-hybrid `role: 'content'` registration, the extension UI window in
`chrome-extensions.ts`, loads `chrome-extension://` URLs and can never match an http(s) target.

Leaving it in place is the split-brain the item complains about: the function's doc comment and its
`normalizeUrl` use suggest URL dedup lives here, while the live dedup is
`hybrid-page-host-registry.ts` `findHybridWindowByUrl()`.

## What goes

- `main.ts` `findWindowByUrl()` and its doc comment.
- The `normalizeUrl` import from `./datastore.js` in `main.ts`, if nothing else in the file uses it
  after the function is gone (`grep -n normalizeUrl apps/desktop/main/main.ts`).
- The `findWindowByUrl` re-export in `index.ts` and its import in `ipc.ts`.
- In `ipc.ts` `window-open` handler: the `const existingByUrl = findWindowByUrl(url); if
  (existingByUrl) { ... }` block that follows the hybrid by-URL reuse block, including its
  `applyPlacementOnReuse(..., 'url-reuse')`, `showWindowHeadlessSafe` and
  `publish('system', 'page:reload', ...)` calls. Do not delete `findHybridWindowByUrl`'s block above
  it. Do not remove the `page:reload` topic itself or its subscribers; only this one publisher call
  goes.
- Reword the comments that name the deleted function so they no longer point at it:
  `ipc.ts` (the hybrid by-URL reuse comment "BaseWindow page-hosts are invisible to
  findWindowByUrl", and the "HYBRID PAGE-HOST EARLY BRANCH" comment that lists `findWindowByUrl /
  findWindowByKey` as the canvas dedup checks; the latter should name only `findWindowByKey`) and
  the file header of `tests/desktop/window-url.spec.ts` ("reuses the existing window
  (findWindowByUrl)" should name `findHybridWindowByUrl`).

Before deleting, re-confirm the premise with a grep for explicit roles
(`grep -rn "role: 'content'" apps/desktop/features apps/desktop/renderer apps/desktop/main`) and
check that none of the hits also passes `modal: true` or `overlay: true` with an http(s) URL. If one
genuinely reaches the `BrowserWindow` path, stop and record it under **Result** instead of deleting.

## What stays

- `main.ts` `findWindowByKey()` and its uses in `ipc.ts` `window-open`. It still serves
  `BrowserWindow` tiles (cmd panel, settings, other keyed tiles) and is the second lookup after
  `findHybridWindowByKey()`. Its comments already say hybrid hosts are skipped.
- `hybrid-page-host-registry.ts` `normalizeForDedup()`. It already mirrors `datastore.ts`
  `normalizeUrl` (lowercase host, default ports, trailing slash, query-param order, empty
  query/hash) and `hybrid-page-host-registry.test.ts` covers it.
- `datastore.ts` `normalizeUrl()` and its other callers (`thumbnails.ts`, `tile-ipc.ts`, item
  lookups).

## Tests to change

None to add: no unit test references `findWindowByUrl`. URL reuse is covered by the Playwright
`tests/desktop/window-url.spec.ts`, which runs through the hybrid path.

## Verify

```
yarn workspace @peek/desktop build && NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js && NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
yarn workspace @peek/desktop test:grep "Window URL"
grep -rn "findWindowByUrl" apps/desktop --include=*.ts --include=*.js --exclude-dir=node_modules --exclude-dir=dist
```

Done when the build compiles, the electron and node runners report `fail 0`, the `Window URL`
Playwright run passes with the collected count recorded under **Result** (all of that file's tests
must be collected, not "No tests found"), and the final grep prints nothing.
