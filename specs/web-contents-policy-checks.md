---
enabled: true
touches: [apps/desktop/main/web-contents-policy.ts, apps/desktop/main/web-contents-policy.test.ts, apps/desktop/main/entry.ts, apps/desktop/main/chrome-extensions.ts]
depends-on: []
---

# Pull the new-window policy decisions out of entry.ts and chrome-extensions.ts into unit-tested functions

Part of Peek item `15769552`. This is the item's regression-test slice for the checks that already
guard every new webContents; the decisions themselves stay as they are.

## Problem

Three decisions that keep a raw window from running with elevated privileges are written inline
inside large Electron-bound functions, so the only coverage is the Playwright spec
`apps/desktop/tests/desktop/no-raw-browserwindow.spec.ts`, which needs a launched app and covers
only two of the branches:

1. `apps/desktop/main/entry.ts`, the `app.on('web-contents-created', ...)` listener, block headed
   "SECURITY chokepoint": skips `backgroundPage` and `offscreen` types, reads
   `getLastWebPreferences()`, and builds a violation list from `nodeIntegration === true`,
   `contextIsolation === false` and `webSecurity === false`. A violation always logs and throws
   outside `NODE_ENV=production`.
2. The same listener, block headed "Default-deny window-open chokepoint": installs a deny-all
   `setWindowOpenHandler` only when `contents.getType()` is `window` or `webview`.
3. `apps/desktop/main/chrome-extensions.ts` `openChromeExtensionPage()`: its
   `win.webContents.setWindowOpenHandler` routes `http://` and `https://` URLs to
   `invokeWindowOpen` and denies every other scheme.

No unit test pins any of these. A change that drops `webSecurity` from the list, widens the deny
default to another type, or lets a non-http scheme through would only surface in a launched-app run.

## What goes

New electron-free module `apps/desktop/main/web-contents-policy.ts` (no `electron` import, like
`sandbox-enforcement.ts`'s pure functions) exporting:

- `isIsolationCheckedType(type: string): boolean` — false for `backgroundPage` and `offscreen`,
  true otherwise.
- `evaluateIsolationViolations(prefs: { nodeIntegration?: boolean; contextIsolation?: boolean;
  webSecurity?: boolean } | null): string[]` — returns `['nodeIntegration=true']`,
  `['contextIsolation=false']`, `['webSecurity=false']` entries in that order for the matching
  settings and `[]` for null prefs, unset fields, `nodeIntegration: false`, `contextIsolation: true`
  or `webSecurity: true`. The strings match the ones `entry.ts` builds today so the log line is
  unchanged.
- `hasDefaultDenyWindowOpen(type: string): boolean` — true only for `window` and `webview`.
- `decideExtensionPopupOpen(url: string): 'route' | 'deny'` — `'route'` when the URL starts with
  `http://` or `https://`, `'deny'` for everything else (`chrome-extension:`, `data:`, `blob:`,
  `javascript:`, `about:blank`, empty string).

Then the two call sites use them, keeping behaviour identical:

- `entry.ts` listener: the type skip, the violation list and the default-deny condition call the
  functions above. The message format, the `console.error`, the throw-outside-production rule, the
  catch that rethrows only `[SECURITY]` errors, and the `{ action: 'deny' }` handler with its
  `[SECURITY] Default-deny chokepoint` warning stay exactly as written.
- `chrome-extensions.ts` handler: branches on `decideExtensionPopupOpen(childUrl)`; the
  `invokeWindowOpen(...)` call, its `chrome-extension:<extensionId>` source string, and both log
  lines stay.

## What stays

- `enforceSandboxOnWebContents(contents)` and everything in `sandbox-enforcement.ts`, which has its
  own tests and fatal-exit behaviour.
- Whether a violation throws or wraps the window. That choice, and any rollout flag for it, is
  undecided and is not part of this change.
- `installOffPathWindowGuard()` in `tile-ipc-gate.ts` and the hybrid popup handler in `ipc.ts`
  (`wireHybridContentEvents`), which adopts popups rather than denying them.
- `no-raw-browserwindow.spec.ts` and its three tests.

## Tests to change

New `apps/desktop/main/web-contents-policy.test.ts` (node:test, same style as
`sandbox-enforcement.test.ts`), covering: each violation setting alone and all three together in
order; null prefs and empty prefs return `[]`; the type skip for `backgroundPage` and `offscreen`
and a pass for `window`, `webview`, `browserView`, `remote`; `hasDefaultDenyWindowOpen` for each of
those types; `decideExtensionPopupOpen` for `https://example.com`, `http://example.com/x`,
`chrome-extension://abc/p.html`, `data:text/html,x`, `javascript:alert(1)`, `blob:https://x/y`,
`about:blank`, and `''`.

## Verify

```
yarn workspace @peek/desktop build && NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/web-contents-policy.test.js
yarn workspace @peek/desktop build && NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js && NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
yarn workspace @peek/desktop test:grep "No raw BrowserWindow"
```

Done when the new test file passes, the repo gate reports `fail 0` in both runners, and the
`test:grep` run collects and passes the three `No raw BrowserWindow` tests (confirm the collected
count is 3, not "No tests found"). Record all counts under **Result**.

## Working rules

Run one command per Bash call.
