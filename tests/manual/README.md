# Manual debugging harness

Reusable Electron + CDP harness for capturing what's happening inside Peek when
chrome-extension flows misbehave. Drives the running app via Playwright's
`_electron`, attaches `webContents.debugger` to every webContents (popup,
host pages, embedded webviews, BG SWs), and dumps a structured trace to
`tmp/harness/`.

## Run

```sh
yarn harness                                       # all scenarios
yarn harness tests/manual/proton-auth.harness.ts   # one scenario
```

`yarn harness` runs Playwright in `--headed --workers=1` against the `manual`
project (defined in `playwright.config.ts`). It launches a fresh isolated
profile (`test-harness-*`) so it never touches your dev/prod data.

## Ending a run early

The harness sleeps for `HARNESS_DURATION_MS` (default 3 min) by default. To
stop it as soon as you're done driving the UI, pick whichever is easiest:

- **Close the Proton auth window** in the Peek instance (the one with the
  `account.proton.me` webview). The harness polls `isClosed()` every second
  and exits cleanly with a "auth window closed" reason.
- **`yarn harness:stop`** from another terminal. Touches `tmp/harness-stop`,
  which the harness picks up on its next poll and exits.
- **Wait it out** — the trace dumps when `HARNESS_DURATION_MS` elapses.

In all three cases the trace is dumped to `tmp/harness/` before the test
exits. Don't Ctrl+C the terminal — that kills Playwright before the dump.

Note: Cmd+Q on the Peek window only works if you can reach the OS-level
window (it doesn't if `yarn harness` was run from inside an integrated
terminal where the keyboard shortcut goes to the editor instead). Closing
the auth window with the mouse / window controls always works.

Output:

```
tmp/harness/
  <scenario>-<ISO>.jsonl   # raw CDP messages (kept for forensics)
  <scenario>-<ISO>.json    # canonical trace
  <scenario>-<ISO>.log     # flat grep-friendly text
```

## What the tracer captures

For every webContents (top-level windows AND embedded webviews):

- **Network** — `Network.requestWillBeSent`, `responseReceived`,
  `loadingFailed`. For 4xx/5xx responses, the body is fetched via
  `Network.getResponseBody` and recorded.
- **Console** — page console output via Playwright's `page.on('console')` for
  top-level windows AND CDP `Runtime.consoleAPICalled` / `Log.entryAdded` for
  webviews.
- **Page errors** — uncaught exceptions.
- **Navigation** — `did-navigate` / `did-navigate-in-page` (for in-page
  history navigations like Proton's /authorize → /reauth → /auth-ext).
- **chrome.runtime snapshots** — explicit `tracer.snapshotRuntime(page,
  label)` calls record `{ id, sendMessage, getURL, getManifest,
  onMessageExternal, keys }` so we can see what Electron exposed at that
  moment. Also supported on webviews via `{ fromWebview: '#content' }`.
- **Scenario notes** — `tracer.record('note', source, { msg, ... })` for
  human-readable milestones.

## Adding a scenario

1. Create `tests/manual/<name>.harness.ts`.
2. Use the desktop-app fixture, start the tracer, drive the UI, dump.
3. Don't assert success on the diagnosis — the spec passes if the trace
   file was produced. Reading the trace is a human activity.

Skeleton:

```ts
import { test, expect } from '../fixtures/desktop-app';
import path from 'path';
import { startTracer } from './harness/tracer';
import { discoverPopup } from './harness/popup';
import { loadEnv, assertRequiredEnv } from './harness/env';

const REPO_ROOT = path.join(__dirname, '..', '..');

test.describe('<scenario-name> @manual', () => {
  test.setTimeout(300_000);

  test('drive the flow while tracer records', async ({ desktopApp }) => {
    const bg = await desktopApp.getBackgroundWindow();
    const env = loadEnv('.env.<scenario>.local', REPO_ROOT);
    // assertRequiredEnv(env.env, [...], '<scenario-name>');

    const tracer = await startTracer({
      app: desktopApp,
      scenarioName: '<scenario-name>',
      tmpDir: path.join(REPO_ROOT, 'tmp', 'harness'),
      profile: 'test-harness-<scenario>',
      backend: desktopApp.backend,
      redactedEnvKeys: env.loadedKeys,
    });

    let result;
    try {
      // Drive the UI here. Use discoverPopup() for extension popups.
      // Use tracer.snapshotRuntime(page, label) at interesting moments.
      // Use tracer.record('note', 'harness', { msg: '...' }) for milestones.
      result = { ok: true };
    } catch (e: any) {
      tracer.record('note', 'harness', { msg: 'scenario error', error: String(e?.message || e) });
      result = { ok: false, reason: String(e?.message || e) };
    }

    const out = await tracer.dump(result);
    console.log(`[harness] trace: ${out.jsonPath}`);
    expect(out.jsonPath).toBeTruthy();
  });
});
```

## Modes

Most scenarios should support an interactive mode (human drives the UI) and
ideally an autodrive mode (creds from `.env.<scenario>.local`, scripted UI
steps). Start with interactive — autodrive selectors are easier to write
once the interactive trace has shown the actual DOM.

Common envs:

- `HARNESS_MODE=interactive|autodrive`
- `HARNESS_DURATION_MS=180000` (interactive wait window)

## Why CDP, not Playwright network listeners

Playwright's `page.on('request')` only fires for the top-level `Page`'s
webContents. Peek's chrome-extension flows happen inside `<webview>`
elements, which are **separate webContents** that Playwright doesn't see.
`webContents.debugger` (CDP) is per-webContents and can be attached to all
of them from the main process. That's the only way to capture the network
activity inside an extension's auth window.

## Why interactive by default

`yarn harness` opens real windows (`--headed`) with a generous timeout and
sleeps in a polling loop while you drive the UI by hand. The tracer captures
everything in the background. When you're done — or when you hit the time
limit — the trace is dumped to `tmp/harness/` and you read it.

This is the opposite of a normal Playwright spec, which runs deterministically
and asserts behavior. The harness's only assertion is "we produced a trace
file" — the diagnosis is a human reading that file.
