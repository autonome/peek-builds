---
enabled: true
touches: [apps/desktop/main/window-construction-gate.test.ts]
depends-on: []
---

# Source gate: every window-creating call site is listed, and no unsafe webPreferences literal exists

Part of Peek item `15769552`. This is the item's page-open path inventory, expressed as a test that
fails when a new raw window construction site appears without being listed.

## Problem

The item asks that every path that can open a window be enumerated and that a new, unreviewed one
not slip in. Nothing enforces that today. `sandbox-enforcement.test.ts` scans the main tree for
`sandbox: false` only. A new `new BrowserWindow(...)`, `new BaseWindow(...)` or
`new WebContentsView(...)` anywhere in `apps/desktop/main`, or an `nodeIntegration: true`,
`contextIsolation: false` or `webSecurity: false` literal, lands with no gate reaction until a
launched-app run happens to trip the `web-contents-created` listener in `entry.ts`, and that listener
only runs for windows that are actually created in that run.

The current code sites (comments excluded) are, per file and constructor:

| File | Constructor | Count | What it builds |
| --- | --- | --- | --- |
| `main/tile-launcher.ts` | `BrowserWindow` | 1 | `createTileBrowserWindow()`: tile windows with tile preload |
| `main/core-glue.ts` | `BrowserWindow` (`BrowserWindowCtor`) | 1 | the background / core window |
| `main/test-fixture-glue.ts` | `BrowserWindow` (`BrowserWindowCtor`) | 1 | test fixture window |
| `main/ipc.ts` | `BrowserWindow` | 1 | the `window-open` handler's direct path for non-tile windows |
| `main/ipc.ts` | `BaseWindow` | 1 | `createHybridHostBaseWindow()`, hybrid page-host frame |
| `main/ipc.ts` | `WebContentsView` | 3 | hybrid page-host content (adopted popup, fresh popup, page host) |
| `main/hybrid-overlay.ts` | `BrowserWindow` | 1 | the shared chrome overlay window |
| `main/hybrid-overlay.ts` | `BaseWindow` (`BaseWindowCtor`) | 5 | test-bridge hosts and the "elsewhere" helper window |
| `main/hybrid-overlay.ts` | `WebContentsView` | 4 | test-bridge content views |
| `main/chrome-extensions.ts` | `BrowserWindow` | 2 | extension bridge window; extension options/popup page window |
| `main/chrome-api-polyfills/offscreen.js` | `BrowserWindow` | 1 | `chrome.offscreen` document host |

## What goes

New test file `apps/desktop/main/window-construction-gate.test.ts`, in the style of the static gate
in `sandbox-enforcement.test.ts` (same `walkSource()` helper shape, resolves the source tree with
`path.resolve(__dirname, '../../main')`, skips `*.test.*` files):

1. **Inventory.** For each non-comment source line matching
   `new (BrowserWindow|BaseWindow|WebContentsView)[A-Za-z]*\(` (this also catches the `...Ctor`
   aliases; skip lines whose trimmed text starts with `//`, `*` or `/*`), count occurrences per
   `file + constructor family` and compare with an `EXPECTED` table in the test containing exactly the
   rows above, each with a one-line reason string. The failure message names the file and says a new
   window construction site must be added to `EXPECTED` with a reason and, if it loads content, must
   register with the window-state machine and appear under a policy-compliant
   `webPreferences`. Before writing the table, re-derive the counts with a grep on the current tree
   and correct any row that has drifted; the table above was taken at the time of writing.
2. **Forbidden literals.** No non-comment line in the same tree matches
   `^\s*nodeIntegration\s*:\s*true\b`, `^\s*contextIsolation\s*:\s*false\b` or
   `^\s*webSecurity\s*:\s*false\b` (same line-start anchoring the sandbox gate uses, so prose such as
   "replaces `webSecurity:false`" in `tile-network-enforcement.ts` and `atproto-proxy.ts` does not
   match). Also forbid `nodeIntegrationInSubFrames`, `enableRemoteModule` and
   `allowRunningInsecureContent` as property names at line start. Report offenders as
   `file:line`.
3. **Self-check.** One small assertion that the scanner sees the known sites (for example that the
   total inventory count is greater than zero and `main/tile-launcher.ts` appears), so a broken
   path or regex cannot make the gate pass by scanning nothing.

No production file changes. The `web-contents-created` listener in `entry.ts`, the sandbox gate, and
`installOffPathWindowGuard()` stay as they are.

## What stays

- `sandbox-enforcement.test.ts` and its own static gate.
- Any per-path behaviour check (registration, placement class, preload). Those depend on which
  failure mode the guard should use (throw or wrap) and are out of scope here.
- `apps/desktop/features`, `renderer` and `chrome-extensions` (upstream imports): no window
  construction sites were found there.

## Verify

```
yarn workspace @peek/desktop build && NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/window-construction-gate.test.js
yarn workspace @peek/desktop build && NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js && NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
```

Done when the new test passes on the current tree and the repo gate reports `fail 0` in both
runners. Prove the gate bites: temporarily add `new BrowserWindow({})` to any scanned `.ts` file and
confirm the inventory test fails naming that file, then revert; note the check under **Result** with
the counts.

## Working rules

Run one command per Bash call.
