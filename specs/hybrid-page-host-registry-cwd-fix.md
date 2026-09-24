---
enabled: true
touches: [apps/desktop/main/hybrid-page-host-registry.test.ts]
depends-on: []
---

# Make hybrid-page-host-registry.test.ts pass regardless of invoking cwd

`apps/desktop/main/hybrid-page-host-registry.test.ts` has a `repoRoot()` helper:

```js
function repoRoot(): string {
  // The unit suite runs from the repo root via test:unit / test:desktop:electron.
  return process.cwd();
}
```

used to build two paths:

```js
const panelPath = path.join(repoRoot(), 'apps', 'desktop', 'renderer', 'cmd', 'panel.js');
...
const ipcPath = path.join(repoRoot(), 'apps', 'desktop', 'main', 'ipc.ts');
```

Confirmed by running the compiled test both ways:

- From the repo root: all 41 tests pass.
- From `apps/desktop` (`yarn workspace @peek/desktop test:unit`'s own working directory): 39
  pass, 2 fail, both in the `chain popup declares its opener as machine parent` suite, both with
  `ENOENT` on a doubled path — `apps/desktop/apps/desktop/renderer/cmd/panel.js` and
  `apps/desktop/apps/desktop/main/ipc.ts` — exactly `path.join(process.cwd(), 'apps', 'desktop',
  ...)` when `process.cwd()` is already `apps/desktop`.

This is why `yarn test:unit` fails when run from `apps/desktop` even though nothing is actually
broken.

## Fix

Resolve `panelPath` and `ipcPath` relative to this test file's own location instead of
`process.cwd()`, so the result doesn't depend on which directory the test runner was invoked
from. The test file compiles to `apps/desktop/dist/main/hybrid-page-host-registry.test.js`; use
whatever path-resolution convention this codebase already uses for "this compiled file's
location" (check nearby `.ts` files under `apps/desktop/main/` for an existing pattern —
`__dirname`, `import.meta.url`, or similar) rather than introducing a new one. Delete `repoRoot()`
once nothing calls it, or repurpose it to compute the same thing from the file's own location if
other call sites in the same file benefit from keeping the name.

## Verify

Run the compiled test from both directories and confirm both give 41/41:

```
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/hybrid-page-host-registry.test.js
```

(from the repo root, after `yarn workspace @peek/desktop build`), and the same command from
`apps/desktop` with the path adjusted to `dist/main/hybrid-page-host-registry.test.js`. Record
both counts in the handoff's `**Result**` section — the repo gate itself only runs from the repo
root, so it won't by itself prove the `apps/desktop`-cwd case is fixed.

## Working rules

`apps/desktop/CLAUDE.md` governs the desktop app. Read it before editing. Run one command per
Bash call.
