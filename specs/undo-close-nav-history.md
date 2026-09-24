---
enabled: true
touches: [apps/desktop/main/main.ts, apps/desktop/main/ipc.ts, apps/desktop/tests/desktop/undo-close-nav-history.spec.ts]
depends-on: [nav-history-model, remove-find-window-by-url]
---

# Undo-close keeps a page-host window's back/forward trail

Part of Peek item `452cd2c2`. This is the second slice: hybrid page-host windows reopened with
Cmd+Shift+T come back with their back/forward trail. Session restore is the next slice.

## Problem

`main.ts` `finalizeWindowClose()` pushes a `ClosedWindowEntry` holding only the leaf URL
(`currentUrl`, kept current by `ipc.ts wireHybridContentEvents` on `did-navigate`), and
`ipc.ts reopenLastClosedWindow()` reopens it with a plain `loadURL`. Back after undo-close is dead.

Two claims in the item's draft plan do not hold on main and shape this slice:

- The trail cannot be read at close time from `win.webContents`. A web page is a hybrid page-host: a
  `BaseWindow` with a `WebContentsView` (`hybrid-page-host-registry.ts HybridWindowEntry.contentWC`),
  and `getLiveWindow()` returns `null` for it. The normal close path destroys that content
  webContents first (`windows.ts closeHostWindow` -> kernel close effect ->
  `electron-window-backend.ts destroyGuestsThenClose`), before
  `ipc.ts assembleHybridPageHost`'s `runHybridFinalize` calls `finalizeWindowClose`. So the trail is
  read from the per-window cache in `nav-history.ts`, kept fresh from the content webContents' own
  events while it is alive.
- `finalizeWindowClose` is no longer a `'closed'` handler body in `main.ts`; it is called from
  `drainWindowClose` (BrowserWindows) and `runHybridFinalize` (hybrid hosts). Only the hybrid caller
  can have a trail.

## What goes

- `main.ts ClosedWindowEntry` gains optional `navHistory?: NavHistoryEntry[]` and
  `navHistoryIndex?: number` (types from `nav-history.ts`), with a comment that they are local machine
  state and are not synced (the `session`/`closed-window-stack` `feature_settings` row is not read by
  `sync.ts`). Entries persisted before this change lack the fields and must keep working.
- `main.ts finalizeWindowClose()`: in the branch that builds the entry for `pushClosedWindow`, read
  `getWindowNavHistory(windowId)` and spread `navHistory` / `navHistoryIndex` into the entry only when a
  trail exists (no explicit `undefined` keys). Call `clearWindowNavHistory(windowId)` once the entry is
  built, on every path through the function (including windows that are not reopenable), so the cache
  never outlives the window.
- `ipc.ts wireHybridContentEvents()`: call `refreshWindowNavHistory(hostWindowId, contentWC)` from the
  existing `did-navigate` and `did-navigate-in-page` handlers and from `page-title-updated`, so titles
  in the trail stay current.
- `ipc.ts reopenLastClosedWindow()`: when the popped entry passes `readNavHistory(entry)`, put
  `navHistory` and `navHistoryIndex` on the `options` handed to `invokeWindowOpen`. The entry's `url`
  stays the open URL.
- `ipc.ts` hybrid open branch (where `deferContentLoad` and the two `view.webContents.loadURL(url)`
  calls sit, both the `skipTracking` fire-and-forget one and the awaited one): route them through one
  small helper that, when `readNavHistory(options)` yields a trail, calls `restoreNavHistory(wc, trail)`
  and falls back to `loadURL(url)` when it returns `false`; without a trail it is exactly today's
  `loadURL`. Keep the awaited/fire-and-forget split as it is. Seed the cache with the trail
  (`seedWindowNavHistory(baseWin.id, trail)`) before loading, so a close before the content reports its
  entries still keeps the trail.
- `ipc.ts assembleHybridPageHost`'s `windowParams` construction: delete `navHistory` and
  `navHistoryIndex` from the params bag next to the existing `delete windowParams.restoreBlank`, so an
  open-time directive is not baked into the registry params.

## What stays

- The deferred-load path (`onHybridHostFocus` -> `claimHybridDeferredLoad`) and everything in
  `session.ts` / `session-projection.ts`: session restore is the next slice. Until it lands, the
  `before-quit` closed-stack push in `session.ts saveSessionSnapshot` builds entries without a trail;
  that is expected.
- The non-hybrid (BrowserWindow) open branch and `peek://` windows: they get no trail.
- `reopenLastClosedWindow`'s synchronous shape (`void invokeWindowOpen(...)`, returns
  `{ success, url }`). The restore happens inside the open branch, so the item's draft change to await
  the open and look the window up with `getLiveWindow(openResult.id)` is not needed (and would return
  `null` for a hybrid host).
- Old persisted closed-window stacks: entries with no trail reopen at the leaf URL as before.

## Tests to change

New `apps/desktop/tests/desktop/undo-close-nav-history.spec.ts`, modelled on
`reopen-closed-window.spec.ts` (same local http server and `createPerDescribeApp` setup, and
`helpers/hybrid-page.ts` for the content wc). Test titles contain "nav history". Cases: open A ->
navigate B -> C -> close -> `reopenLastClosedWindow()` -> the reopened window shows C, back (publish
`page:go-back` through `publishOverlayTopic`, the route the navbar uses) shows B, back again shows A,
forward shows B; and a window that was moved back to B before closing reopens on B with C still
reachable by forward. Existing tests in `reopen-closed-window.spec.ts` must still pass unchanged.

## Verify

```
yarn workspace @peek/desktop build && NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js && NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
yarn workspace @peek/desktop test:grep "nav history"
yarn workspace @peek/desktop test:grep "Reopen Last Closed Window"
```

Done when the unit runners report `fail 0`, the `nav history` run shows at least 2 passed and 0 failed
("No tests found" is a failure), and the `Reopen Last Closed Window` run passes with the same count as
before this change. Record all counts under **Result**. A Linux run cannot observe real focus; nothing
here depends on it.
