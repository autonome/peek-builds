---
enabled: true
touches: [apps/desktop/main/tile-ipc.ts, apps/desktop/main/hybrid-overlay.ts]
depends-on: []
---

# Reword the comments that still describe the hybrid page-host as flag-gated or as a canvas rewrite

Part of Peek item `f1ea471d`. This is the slice for the leftover flag and canvas prose in
`tile-ipc.ts` and `hybrid-overlay.ts`; it changes comments only.

## Problem

The hybrid page-host is the only page-host implementation (the canvas page-host and the flag that
selected between them were removed; `apps/desktop/CLAUDE.md` "Hybrid page-host is the ONLY
page-host"). Several main-process comments still describe the old arrangement, which sends a reader
looking for a flag or a canvas branch that does not exist. Other files already carry the corrected
wording ("hybrid is the only page-host path now, not a flag-gated one", in
`hybrid-page-host-registry.ts` `getAllHybridWindows()`'s doc comment and in `cli-router.ts`).

## What goes

In `tile-ipc.ts`, reword these comments (behaviour and code untouched):

- The `tile:window:close` handler, comment above `if (args.id != null) { const hybrid =
  getHybridWindow(args.id); ...`: "No-op (null) when the flag is off (registry empty)." Say instead
  that it is a no-op when `args.id` is not a hybrid window.
- The `tile:window:hide` handler, comment above `const hybrid = getHybridWindow(args.id)`: "No-op
  (null) when the flag is off." Same treatment.
- The `tile:window:open` handler: "External http(s) URLs are rewritten to the page canvas by the
  window-open handler below" (they open in a hybrid page-host, nothing is rewritten) and "handles
  canvas rendering, mode inheritance, deduping, session registration" (drop "canvas rendering",
  name the hybrid page-host).
- The `tile:window:list` handler, comment above `params: getWindowInfo(h.windowId)?.params ?? {}`:
  "the same way the canvas branch above does" (the loop above enumerates `BrowserWindow`s from
  `getAllLiveWindows()`; say that).

In `hybrid-overlay.ts`, the doc comment on the test bridge's fake-host teardown ("return the
registry to its empty (flag-off-equivalent) state") should say "empty state" without the flag
reference.

Confirm each quoted phrase is still present before editing (`grep -n "flag is off\|flag-off\|page
canvas\|canvas rendering\|canvas branch" apps/desktop/main/tile-ipc.ts apps/desktop/main/hybrid-overlay.ts`);
if a line was already reworded, skip it and note that under **Result**.

## What stays

- Every `canvas` mention in `ipc.ts`, `main.ts`, `session*.ts` and the renderer. Those comments
  describe parity with the old implementation or session-restore compatibility and need a per-site
  judgement that this slice does not make.
- `hybrid-overlay.ts` comments about the test bridge being indistinguishable from "a canvas page"
  (`windowsFeatureHybridEntries()` doc comment): kept, since they compare against the old
  behaviour on purpose.
- All code. No identifier, import or string literal changes.

## Verify

```
yarn workspace @peek/desktop build && NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js && NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
grep -n "flag is off\|flag-off\|page canvas\|canvas rendering\|canvas branch" apps/desktop/main/tile-ipc.ts apps/desktop/main/hybrid-overlay.ts
```

Done when the build compiles, both runners report `fail 0`, and the grep prints nothing. `git diff`
must show only comment lines changed; record that under **Result**.
