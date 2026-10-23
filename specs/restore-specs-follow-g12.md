---
enabled: true
touches: [apps/desktop/tests/desktop/reopen-closed-window.spec.ts, apps/desktop/tests/desktop/session-restore-page-host.spec.ts]
depends-on: []
---

# Restore and reopen specs expect a maximized window to come back maximized

`bfe2a0f8` ("restore: a window maximized at save or close comes back maximized") changed the
rule, and `docs/design/window-rules.md` G12 now states it: a window maximized at save or close
comes back maximized, opened at its pre-maximize bounds and then maximized through the kernel
(`main/session-projection.ts maximizeRestoreDescriptor()`). Two specs still assert the old rule
and fail every run on `main`:

- `tests/desktop/reopen-closed-window.spec.ts`, "reopen a maximized hybrid page-host restores it
  unmaximized at its pre-maximize bounds" — fails "reopened window must come back at the
  pre-maximize bounds".
- `tests/desktop/session-restore-page-host.spec.ts`, "hybrid page host: a window maximized at
  save time restores unmaximized at its pre-maximize bounds" — fails "maximize is not written to
  the snapshot" (`saved.params.maximized` is `true`).

Decisions:

- Change only these two tests; product code is correct as it stands. Each keeps its setup (open
  a page host at known bounds, maximize it, close or save, reopen or restore).
- **The reopen test**, renamed "reopen a maximized hybrid page-host restores it maximized,
  keeping its pre-maximize bounds": after reopen, the window reports maximized; unmaximizing it
  returns it to the original bounds.
- **The restore test**, renamed "hybrid page host: a window maximized at save time restores
  maximized, keeping its pre-maximize bounds": the snapshot saves the window at its original
  bounds with `params.maximized` `true`; after restore the window reports maximized; unmaximizing
  it returns it to the original bounds. Drop the assertion that `params.preMaxBounds` is absent
  only if the snapshot now writes it; read `serializeSession()` in `main/session-projection.ts`
  to see what is written, and assert exactly that.
- Use the same helpers each file already uses to read maximized state and bounds; add none.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
yarn workspace @peek/desktop test:grep "Reopen Last Closed Window|Session Restore Page Host"
```

Done when the unit tallies report `fail 0` and every collected test in the two files passes.
Record the `test:grep` pass/fail count under `**Result**` in the handoff.

## Working rules

`apps/desktop/CLAUDE.md` governs the desktop app; read it before editing. Change only the files
in `touches`. Run one command per Bash call.
