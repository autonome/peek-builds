---
enabled: true
touches: [apps/desktop/main/chrome-api-polyfills/tabs.js, apps/desktop/main/chrome-api-polyfills/_external-url.js, apps/desktop/tests/unit/chrome-polyfill-external-url.test.js]
depends-on: []
---

# Only hand http(s) URLs to the OS from the chrome.tabs.create shim

Part of Peek item `15769552`. This is the item's `shell.openExternal` review: the one call site in
the desktop app is the `chrome.tabs.create` shim, and it forwards any string an extension gives it.

## Problem

`apps/desktop/main/chrome-api-polyfills/tabs.js` `setupMainProcess()` registers a `create` handler
(`registerHandler(ipcMain, API, 'create', ...)`). It takes `createProperties.url` from the calling
extension background page and passes it straight to `_shell.openExternal(url)`. Its own comment
says the intent is "route HTTP(S) URLs to Peek", but nothing checks the scheme. A background page
can therefore ask the OS to open `peek://...`, `chrome-extension://...`, `file:`, `javascript:`,
`data:` or any registered custom protocol. `peek://` in particular re-enters the app through the OS
protocol handler, outside the tile / capability path. It is the only `openExternal` call in
`apps/desktop/main`, `features`, `renderer` and the tile preload (`permission-policy.ts` names
`openExternal` only as a permission label).

The popup-window counterpart already does this right: the `setWindowOpenHandler` in
`chrome-extensions.ts` `openChromeExtensionPage()` routes only `http://` and `https://` and denies
everything else.

## What goes

- A small electron-free module `apps/desktop/main/chrome-api-polyfills/_external-url.js` exporting
  `isWebUrl(url)` (true only when `url` is a string that parses with `new URL()` and whose
  protocol is `http:` or `https:`; scheme match is case-insensitive because `URL` normalises it) and
  `openExternalIfWebUrl(shell, url)` (calls `shell.openExternal(url)` and returns `true` for a web
  URL; returns `false` without calling it otherwise). The `shell` argument is injected so the unit
  test needs no electron import (`tabs.js` itself imports `electron` and cannot be loaded by
  `node --test`).
- `tabs.js` `create` handler calls `openExternalIfWebUrl(_shell, url)` instead of
  `_shell.openExternal(url)`. When the URL is refused it logs a `console.warn` that names the
  extension (`getExtensionId(event)` already exists in the file) and the refused scheme only, not
  the full URL, and still returns the same synthetic tab object it returns today. The default
  `'about:blank'` for a missing url is refused by this rule, which is intended: `about:blank` has
  nothing to open externally.

The allowed set is http(s) only. It matches what the handler's own comment and the popup handler
already say; adding `mailto:` later is a one-line change in `isWebUrl()`.

## What stays

- The `create` handler's return shape (the synthetic tab object with `id: -1`), so callers that
  await `chrome.tabs.create` see no difference.
- The `get`, `sendMessage` and `update` handlers, `getPreloadScript()` and the popup-context path
  through `window.open`.
- The `setWindowOpenHandler` in `chrome-extensions.ts`; it is already correct and is covered by a
  separate spec.

## Tests to change

New `apps/desktop/tests/unit/chrome-polyfill-external-url.test.js`, importing
`main/chrome-api-polyfills/_external-url.js` the way `chrome-polyfill-alarms.test.js` imports its
module:

- `isWebUrl`: true for `https://example.com/a?b=1` and `HTTP://example.com`; false for
  `peek://groups/home.html`, `chrome-extension://abc/page.html`, `file:///etc/passwd`,
  `javascript:alert(1)`, `data:text/html,x`, `about:blank`, `''`, `undefined`, `42`, and a
  non-parsing string like `not a url`.
- `openExternalIfWebUrl` with a fake `{ openExternal: mock.fn() }`: called once with the exact URL
  and returns `true` for an https URL; not called and returns `false` for a `peek://` URL.
- A source check that `tabs.js` no longer contains a direct `_shell.openExternal(` call and does
  import from `./_external-url.js` (read the file with `fs.readFileSync`), since the handler itself
  cannot be run under `node --test`.

## Verify

```
NODE_ENV=test node --test apps/desktop/tests/unit/chrome-polyfill-external-url.test.js
yarn workspace @peek/desktop build && NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js && NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
```

Done when the new test file passes and the repo gate reports `fail 0` in both runners. Record the
counts under **Result**. The build step copies `chrome-api-polyfills` into `dist/main`, so the new
`_external-url.js` needs no build config change; confirm it appears in
`apps/desktop/dist/main/chrome-api-polyfills/`.

## Working rules

Run one command per Bash call.
