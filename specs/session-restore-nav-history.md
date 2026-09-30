---
enabled: true
touches: [apps/desktop/main/session.ts, apps/desktop/main/session-projection.ts, apps/desktop/main/session-projection.test.ts, apps/desktop/main/window-registry.ts, apps/desktop/main/ipc.ts, apps/desktop/tests/desktop/session-restore-nav-history.spec.ts]
depends-on: [undo-close-nav-history]
---

# Session restore keeps each page-host window's back/forward trail

Part of Peek item `452cd2c2`. This is the third slice: the session snapshot saves each hybrid
page-host window's trail and relaunch restores it, using the cache and load helper added by the
undo-close slice.

## Problem

`session-projection.ts serializeSession()` writes a `WindowDescriptor` per window with the leaf URL
only, and `session.ts restoreSessionSnapshot()` reopens each with a plain load, so a relaunched window
has no back history. Windows beyond the eager count (`SESSION_EAGER_RESTORE_COUNT` in `session.ts`)
restore blank and load on first focus (`ipc.ts assembleHybridPageHost`'s `onHybridHostFocus` ->
`hybrid-page-host-registry.ts claimHybridDeferredLoad`); such a window has no navigation entries until
then, so a live read at save time would overwrite its saved trail with nothing. The trail therefore
comes from the per-window cache in `nav-history.ts`, which the open path seeds from the descriptor.

`sanitizeParams()` drops arrays of objects, so the trail cannot ride in `descriptor.params`; it is a
top-level optional field like `stackIndex`.

## What goes

- `window-registry.ts WindowDescriptor` gains optional `navHistory?: NavHistoryEntry[]` and
  `navHistoryIndex?: number`, commented as local machine state that is not synced (the
  `session`/`snapshot` `feature_settings` rows are not read by `sync.ts`).
- `session-projection.ts SessionSaveWindow` gains an optional `navHistory` carrying the
  `{ navHistory, navHistoryIndex }` pair; `serializeSession()` writes both keys onto the descriptor,
  after `context`, only when the pair is present. A window with no trail must serialize to exactly the
  JSON text it does today: the on-disk shape is pinned by `session-projection.test.ts`, and an explicit
  `undefined` key is not acceptable.
- `session.ts buildSessionSaveWindows()` fills that field from `getWindowNavHistory(id)` (the cache, not
  a live webContents read), so no timer or new save trigger is needed: the existing before-quit,
  autosave, lifecycle and manual saves carry it.
- `session.ts saveSessionSnapshot()`'s `before-quit` block that pushes descriptors onto the closed-window
  stack: pass `descriptor.navHistory` / `navHistoryIndex` into `pushClosedWindow` when present, so
  undo-close after a quit keeps the trail too.
- `session.ts restoreSessionSnapshot()`: when `readNavHistory(descriptor)` yields a trail, put
  `navHistory` and `navHistoryIndex` on the `options` for `invokeWindowOpen` (they are not in
  `descriptor.params`, so the `stripKeys` set needs no change). The eager path then restores through the
  helper the undo-close slice added to the hybrid open branch. Old snapshots without the fields restore
  at the leaf URL exactly as before.
- `ipc.ts assembleHybridPageHost`'s `onHybridHostFocus` deferred-load call: go through the same load
  helper, passing `getWindowNavHistory(baseWin.id)` (seeded at open by the undo-close slice), so a
  deferred window's first activation restores its trail rather than the leaf URL. This is a small change
  to one call, not a new mechanism.

## What stays

- The frozen shape of every existing descriptor field, their order, and `SessionSnapshot.version`.
- The `restoreBlank` handling, eager count and focus-order logic in `session.ts`.
- Non-hybrid (BrowserWindow) and `peek://` windows: no trail.
- `refreshWindowNavHistory` wiring in `wireHybridContentEvents`: already done by the undo-close slice.

## Tests to change

`session-projection.test.ts`: a window with a trail serializes both fields with the expected values and
key order; a window without one serializes byte-identically to the current pinned expectation (the
existing pin must pass unmodified).

New `apps/desktop/tests/desktop/session-restore-nav-history.spec.ts`, following the save+restore pattern
in `session-restore-page-host.spec.ts` and the deferred-load harness in
`session-restore-deferred-load.spec.ts`. Test titles contain "nav history". Cases: an eager window that
went A -> B -> C is saved, the app restores it, and it shows C with back reaching B then A; a deferred
window (beyond the eager count) that has not been activated is saved a second time, then activated, and
still has its trail (this is the case that loses history if save reads the live webContents); a legacy
snapshot descriptor with no trail restores at its leaf URL.

## Verify

```
yarn workspace @peek/desktop build && NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js && NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
yarn workspace @peek/desktop test:grep "nav history"
yarn workspace @peek/desktop test:grep "Session Restore Page Host"
```

Done when the unit runners report `fail 0` (the new `session-projection.test.ts` cases counted), the
`nav history` run includes the undo-close slice's tests plus at least 3 new session tests with 0 failed
("No tests found" is a failure), and the `Session Restore Page Host` run passes with the same count as
before this change. Record all counts under **Result**.
