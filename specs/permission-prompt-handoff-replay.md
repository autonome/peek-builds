---
enabled: true
touches: [apps/desktop/main/permission-pending.ts, apps/desktop/main/permission-handler.ts, apps/desktop/main/hybrid-overlay.ts, apps/desktop/renderer/page/overlay.js, apps/desktop/tests/unit/permission-handler.test.js, apps/desktop/tests/desktop/permission-prompt.spec.ts]
depends-on: []
---

# Replay pending permission requests to the overlay on every active handoff

Peek item `08d510af`. A web-permission request that the shared hybrid overlay renderer never
received sits in `permission-handler.ts`'s `pendingRequests` map with no visible prompt until its
window closes and `denyPendingRequestsForWindow` / the `'closed'` cleanup denies it.

## What the code does now

- `permission-handler.ts` `installPermissionHandler` → `setPermissionRequestHandler`: on a
  `'prompt'` decision it stores `{callback, windowId (WM id), permission, origin}` in
  `pendingRequests` under a fresh `requestId`, then publishes `page:permission-request`
  `{requestId, windowId: native.id, permission, origin, label: labelFor(permission)}` once. The
  renderer-facing `windowId` is the Electron window id, not the WM id. That boundary is
  deliberate and stays as it is.
- `pubsub.ts` `publish` → `deliver` delivers to the subscribers that exist at that moment. It keeps
  no history and does not replay.
- `renderer/page/overlay.js` fills `permissionQueue` only from its `page:permission-request`
  subscriber. The overlay window is created at startup (`hybrid-overlay.ts` `initHybridOverlay` →
  `ensureOverlay`), but its renderer subscribes only when the `overlay.js` module body runs, and it
  publishes `page-overlay:ready` as the module's last statement. A request published before that
  point is never delivered. So is a request published before a re-created overlay renderer loads
  (see the HAZARD note in `ensureOverlay`'s `'closed'` handler), because the new renderer starts
  with an empty queue.
- `hybrid-overlay.ts` `sendActiveHandoff(id)` publishes `page-overlay:active` with url, title,
  nav, bounds and maximize state, and nothing about permissions. It runs on every overlay
  attachment change (`subscribeOverlayAttachment` in `initHybridOverlay`) and when the renderer
  declares itself ready (`wireOverlayReady`). Neither path lets the renderer recover a missed
  request.

## What changes

1. **`permission-pending.ts`**: add a pure helper
   `listPendingForWindow(pending, windowId): Array<{requestId, windowId, permission, origin}>`.
   It returns the entries for `windowId` in the Map's insertion order (FIFO), with no `callback`
   field. It must not mutate the map, call any callback, or publish anything. It stays free of
   electron imports, like the rest of the module.
2. **`permission-handler.ts`**: add an export
   `pendingPermissionRequestsForWindow(nativeWindowId: number)`. It converts the id with
   `getWindowIdFor`, returns `[]` when that yields null, calls `listPendingForWindow`, and maps
   each entry to exactly the `page:permission-request` payload shape (`windowId: nativeWindowId`,
   `label: labelFor(permission)`). Extract one small payload builder that both the publish site
   and this function use, so the live and replayed shapes cannot drift.
3. **`hybrid-overlay.ts` `sendActiveHandoff`**: add
   `pendingPermissions: pendingPermissionRequestsForWindow(id)` to the non-null
   `page-overlay:active` payload. The null payloads stay `null`. Import it next to the existing
   `denyPendingRequestsForWindow` import. Update the `wireOverlayReady` doc comment to say the
   re-sent handoff also replays outstanding permission requests. Add no new topic, subscription,
   timer, poll or retry. The handoff is the lifecycle signal (item option (a); option (b), a
   separate replay topic, is not taken).
4. **`renderer/page/overlay.js`**:
   - Add a `settledPermissionIds` Set. Record an id in it in `respond()`, and in the
     `page:permission-resolved` subscriber whether or not the id was in the queue.
   - Extract an `enqueuePermissionRequest(msg)` helper from the `page:permission-request`
     subscriber. It keeps the existing guards (requestId present, `windowId != null`, not already
     queued) and adds one: skip any id in `settledPermissionIds`. It returns whether it enqueued.
     The subscriber calls it and then `syncPermissionPrompt()`.
   - In the non-null branch of the `page-overlay:active` subscriber, before the existing
     `syncPermissionPrompt()` call, run `enqueuePermissionRequest` over `msg.pendingPermissions`
     when it is an array.
   - The reconcile only adds. It never removes queued entries. Removal belongs to
     `page:permission-resolved` and `respond()`. The existing synthetic-request tests also depend
     on this: they queue ids that have no backend entry.
   - The settled set covers a handoff whose listing was taken before main processed a
     `page:permission-response`. Without the guard, that handoff would put an answered request
     back in the queue.
   - `__resetPermissionPromptsForTests` also clears `settledPermissionIds`.
   - Update the header comment's `page-overlay:active` payload line and the "Web permission
     prompts" block comment to describe the replay.

## What stays

- The live `page:permission-request` publish, `takePendingRequest`, `denyPendingForWindow`,
  `denyPendingRequestsForWindow`, and the `native.once('closed')` cleanup are unchanged.
- The renderer still never auto-denies. There is still one visible prompt for the active window's
  queue head, with the "+N more pending" badge (`pendingCountForActiveWindow`,
  `updatePendingBadge`). Requests for background windows still wait in the queue until their window
  becomes active. Window close still auto-denies.
- The renderer-facing payloads still use Electron window ids.
- `wireOverlayReady` still answers `page-overlay:ready` with one `sendActiveHandoff` and nothing
  else.

## Tests to add

`apps/desktop/tests/unit/permission-handler.test.js`: import `listPendingForWindow` from
`../../dist/main/permission-pending.js` and add a
`describe('permission-pending: listPendingForWindow')` with these cases:
- It returns only the given window's entries, in insertion order, without a `callback` key.
- An id removed by `takePendingRequest` is no longer listed.
- After `denyPendingForWindow` for that window it returns `[]`.
- Listing calls no callback and no `publishResolved`, and leaves the map size unchanged.
- An empty map returns `[]`.

`apps/desktop/tests/desktop/permission-prompt.spec.ts`: add a test such as
`'replay: a pending request the overlay renderer never received surfaces on the next handoff'`.
Use a REAL host (`openRealHybridPage`), not `makeFakeHybridWindow`, because fake hosts fail on
Linux for an unrelated reason. Steps:
1. Call `startGeoRequest`, poll until `promptPresent()`, and record `promptState().requestId`.
2. Call the bridge's `resetPermissionPromptsForTests()`. This puts the renderer in the state of a
   fresh overlay renderer that never received the publish. Assert `present === false`,
   `queuedCount === 0`, and `pendingCount() === 1`.
3. Call `publishOverlayTopic(app, 'page-overlay:ready', {})`. That publish reaches main's
   `wireOverlayReady` subscriber, so the path under test is the production one.
4. Poll until the prompt is present again. Assert it has the same `requestId` and
   `queuedCount === 1`.
5. Publish `page-overlay:ready` again. `queuedCount` stays 1, which shows the replay does not
   duplicate.
6. `clickPrompt(false)`. `geoResult` starts with `denied:`, and `pendingCount()` reaches 0.
7. Publish `page-overlay:ready` once more. Nothing comes back: `present === false` and
   `queuedCount === 0`.
8. Close the window.

Leave the existing tests as they are. The queueing and background-window deferral tests use
synthetic ids that `pendingPermissionRequestsForWindow` never lists, so the additive-only reconcile
does not change their behavior.

## Verify

```
yarn workspace @peek/desktop test:unit
yarn workspace @peek/desktop test:grep "Permission Prompt"
```

- `test:unit` builds, then runs the electron main-process runner and the node `tests/unit`
  runner. Done when both report `fail 0` and the new `listPendingForWindow` cases pass.
- `test:grep`: the new replay test passes. No other `permission-prompt.spec.ts` test fails, except
  tests listed as "overlay race" or fake-host failures in `apps/desktop/tests/gate-baseline.md`.
  Compare the set of failing tests, not the count. "No tests found" counts as a failure.

## Working rules

`apps/desktop/CLAUDE.md` governs the desktop app. Read it before editing. Run one command per Bash
call.
