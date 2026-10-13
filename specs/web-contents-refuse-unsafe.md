---
enabled: true
touches: [apps/desktop/main/entry.ts, apps/desktop/main/web-contents-policy.ts, apps/desktop/main/web-contents-policy.test.ts, apps/desktop/main/ipc.ts, apps/desktop/main/chrome-api-polyfills/_external-url.js, apps/desktop/tests/unit/external-url.test.js, apps/desktop/tests/desktop/no-raw-browserwindow.spec.ts]
depends-on: [peek-slide-relative-size]
---

# A webContents with unsafe settings is refused in every build, and every window-open path is tested

Peek item `15769552`, the part left after `web-contents-policy-checks` and
`window-construction-source-gate` landed.

## Decision

A webContents that violates the isolation policy is refused in every build, production
included: it never loads content and its window is torn down. There is no configuration switch.
Today a release build only logs the violation and lets the window run, which is the unsafe case.

## What the code does now

- `main/entry.ts`, the `app.on('web-contents-created')` listener, block headed "SECURITY
  chokepoint": for types passing `web-contents-policy.ts isIsolationCheckedType`, reads
  `getLastWebPreferences()` and calls `evaluateIsolationViolations(prefs)` (`nodeIntegration=true`,
  `contextIsolation=false`, `webSecurity=false`). On a violation it `console.error`s and, only when
  `NODE_ENV !== 'production'`, throws. The throw is an uncaught exception inside an Electron event,
  so even then the window is not closed. Null prefs (not readable yet) pass silently, with no
  second check, unlike `sandbox-enforcement.ts`, which re-checks on the first
  `did-start-navigation`.
- The block headed "Default-deny window-open chokepoint" denies `window.open` for `window` and
  `webview` types (`hasDefaultDenyWindowOpen`). Hybrid page content (`browserView`) has its own
  handler in `ipc.ts wireHybridContentEvents`, which adopts popups.
- `ipc.ts windowOpenHandler`'s direct `new BrowserWindow(winOptions)` branch (pseudo-tiles,
  `about:blank`, trusted built-ins) spreads the caller's `options.webPreferences` first, so a caller
  can pass `nodeIntegration` or `contextIsolation` overrides; only the listener notices. The real
  tile branch strips those overrides.
- The `will-attach-webview` handler in the same listener sets preloads for `<webview>` guests but
  never validates or refuses.
- `tests/desktop/no-raw-browserwindow.spec.ts` checks that normal paths comply and that the default
  deny works; it never provokes a violation, and it cannot see hybrid hosts
  (`BrowserWindow.getAllWindows()` misses them; use `hybrid-page-host-registry.ts`).
- Window construction sites are inventoried in `main/window-construction-gate.test.ts EXPECTED`.

## What changes

1. **Refusal** (`entry.ts`, with the decision logic in `web-contents-policy.ts`):
   - On a violation at creation, in every build: log the `[SECURITY]` line as today, then refuse
     the webContents: block every navigation on it from that moment (`will-navigate`,
     `will-redirect` and `did-start-navigation` stop it; `setWindowOpenHandler` denies) so no
     content ever runs in it, and tear down its owning window through the window-state machine's
     destroy path (`windows.ts closeHostWindow`, `ipc.ts destroyUnassembledHybridHost`, or
     `chrome-extensions.ts destroyWindowViaMachine`, whichever fits the owner). Remove the
     `NODE_ENV` branch and the throw.
   - The owner is often not reachable at creation (a hybrid view is created before
     `registerHybridWindow`; a BrowserWindow's `fromWebContents` can be null inside its own
     constructor). Tear down at the first deterministic point the owner is known (for example the
     first `did-start-navigation`, which the navigation block intercepts anyway, or hybrid
     registration). No timer, retry or poll. Record the chosen point under `**Result**`.
   - Null prefs at creation: re-check on the first `did-start-navigation`, as
     `sandbox-enforcement.ts` does, and refuse there before the navigation commits.
   - Unlike `sandbox-enforcement.ts fatalSandboxViolation`, a refusal does not exit the app.
2. **window-open input** (`ipc.ts windowOpenHandler`): a request whose `options.webPreferences`
   sets `nodeIntegration: true`, `contextIsolation: false`, `webSecurity: false` or
   `sandbox: false` is refused with an error result before any window is built (a pure helper in
   `web-contents-policy.ts`, e.g. `unsafeWebPreferenceOverrides(prefs): string[]`). No current
   caller should hit this; if one does, the full gate shows it.
3. **`<webview>` attach**: in `will-attach-webview`, after the existing preload setup, call
   `event.preventDefault()` when the resulting prefs violate the policy.
4. **`shell.openExternal`**: confirm `chrome-api-polyfills/_external-url.js openExternalIfWebUrl`
   opens only `http:` and `https:`; tighten it if not.

Out of scope: a "must carry a tile token" rule (page hosts carry a runtime-external preload and no
token, so it would refuse every page host); `tile-ipc-gate.ts installOffPathWindowGuard`, which
stays log-only.

## Tests to change

- `main/web-contents-policy.test.ts`: `unsafeWebPreferenceOverrides` for each unsafe setting alone,
  all together, safe and empty input; any other helper added for the refusal decision.
- `tests/unit/external-url.test.js` (new, if no test exists for it): `openExternalIfWebUrl` opens
  `http(s)` and refuses `file:`, `javascript:`, `peek:`, `chrome-extension:`.
- `tests/desktop/no-raw-browserwindow.spec.ts`, keeping its three tests:
  - Provoke a violation: from `app.evaluateMain`, construct a `BrowserWindow` with
    `webPreferences: { nodeIntegration: true, sandbox: true }` (sandbox stays on so
    `sandbox-enforcement.ts` does not exit the app) and `loadURL` a `data:` page that sets a
    marker. Assert the marker never appears, the window is destroyed, and the app keeps running
    (a later `window.app.window.open` still works).
  - A window-open request carrying `webPreferences: { nodeIntegration: true }` returns an error and
    creates no window.
  - One test per path in Peek item `15769552`'s list, each asserting the resulting webContents has
    `nodeIntegration` false, `contextIsolation` true, `sandbox` true, and is registered
    (`getAllWindows()` for BrowserWindows, `hybrid-page-host-registry.ts getHybridWindowByContentWC`
    for page hosts): a tile window via window-open; a page host for an `https` URL (use the local
    test server the other hybrid specs use); a popup from `window.open` in a page host; the direct
    BrowserWindow branch (`about:blank`); a chrome-extension page if the test profile has an
    extension, else skipped with the reason in the skip message. Session restore and
    `tile:window:open` create no window of their own; they route through `invokeWindowOpen`, so
    the window-open cases cover them; name that in those tests' titles. OAuth loopback
    (`oauth-loopback.ts`) creates no window.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
yarn workspace @peek/desktop test:grep "No raw BrowserWindow"
yarn test:desktop:electron
```

The guard sits in front of every window, so the full gate is required (it may run freely on the
Linux box). Done when the unit tallies report `fail 0`, every `No raw BrowserWindow` test passes,
and the full gate's failing set matches `apps/desktop/tests/gate-baseline.md` with nothing new.
Record the per-runner gate numbers under `**Result**`. Not verified by this run: macOS; note it.

## Working rules

`apps/desktop/CLAUDE.md` governs the desktop app. Read it before editing. Run one command per
Bash call.
