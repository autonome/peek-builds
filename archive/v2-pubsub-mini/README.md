# v2-pubsub-mini

Minimal standalone Electron reproducer for the v2-tile pubsub routing
pattern Peek uses. Two `BrowserWindow`s share a sandboxed
`contextIsolation: true` preload that exposes `app.publish` /
`app.subscribe` over `tile:pubsub:*` IPC channels. Main process records
subs and broadcasts publishes to other tile windows.

## Run

```
cd /tmp/v2-pubsub-mini
/Users/dietrich/misc/mpeek/node_modules/.bin/electron .
```

The app:
1. Creates two BrowserWindows (subscriber + publisher), both with
   `sandbox: true, contextIsolation: true`, sharing `preload.cjs`.
2. After both load, waits 250ms, then asks the publisher window to
   `window.app.publish('test-topic', {...})` via `executeJavaScript`.
3. Polls the subscriber window's `window.__received` for up to 1s.
4. Logs `VERDICT: STANDALONE_WORKS` or `STANDALONE_FAILS`.

Logs go to stdout AND to `/tmp/v2-pubsub-mini.log`.

## Files

- `main.js` — IPC handlers, window creation, auto-test runner
- `preload.cjs` — `contextBridge.exposeInMainWorld('app', {publish, subscribe, rlog})`
- `publisher.html` — exposes a click button + auto-test target
- `subscriber.html` — auto-subscribes on load, stores received data on `window.__received`
