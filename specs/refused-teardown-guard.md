---
enabled: true
touches: [apps/desktop/main/entry.ts, apps/desktop/main/web-contents-policy.ts, apps/desktop/main/web-contents-policy.test.ts]
depends-on: []
---

# A failing teardown of a refused window is logged, not thrown

Peek item `f49cf67b`. `main/entry.ts installIsolationRefusal()` calls `tearDownRefusedWindow()` from
the refused webContents' first `did-start-navigation`. Nothing catches a throw from it: if the
window was destroyed between the refusal and that navigation, or closing it fails, the error
escapes as an uncaught exception in the main process.

Decisions:

- **The guard is a small pure function in `main/web-contents-policy.ts`**, so it can be unit
  tested without Electron: `runRefusedTeardown(attempt, label, log)`. `attempt` is a
  `() => boolean` (the existing teardown), `label` a string naming the window
  (`webContents <id>`), `log` a `(message: string) => void`. It returns what `attempt` returns;
  when `attempt` throws it calls `log` once with a message containing `label` and the error's
  message, and returns `true`.
- **Returning `true` after a throw is deliberate**: the `tearDown` closure in
  `installIsolationRefusal()` sets `ownerTornDown` from the return value, and a teardown that
  threw must not be retried on every later navigation. The refusal itself still stands: the
  `refuse` path already blocks every navigation and denies `window.open`, so the webContents
  stays inert whether or not the window closed.
- **`installIsolationRefusal()`'s `tearDown` closure calls
  `runRefusedTeardown(() => tearDownRefusedWindow(contents), \`webContents ${contents.id}\`,
  console.error)`.** `tearDownRefusedWindow()` itself is unchanged.
- Out of scope: a refused webContents that never navigates stays alive but inert; accepted.

## Tests to change

`main/web-contents-policy.test.ts`, a `runRefusedTeardown` suite, written first and failing:

- `attempt` returning `true` or `false` is passed through, `log` not called.
- `attempt` throwing `new Error('Object has been destroyed')`: no exception escapes, the result is
  `true`, `log` is called exactly once, and its message contains both the label and
  `Object has been destroyed`.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
```

Done when both unit tallies report `fail 0` and the new suite is among the passing tests. Record
the main-process unit pass/fail count under `**Result**` in the handoff.

## Working rules

`apps/desktop/CLAUDE.md` governs the desktop app; read it before editing. Change only the files
in `touches`. Run one command per Bash call.
