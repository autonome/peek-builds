# Startup risk acknowledgment

Peek shows a notice before the normal runtime loads and starts only after the
person has explicitly accepted it. Behavior is specified in
`specs/startup-risk-acknowledgment.md`; this document describes how it is built.

## What the notice says

`apps/desktop/main/startup-consent.ts` (`NOTICE`) is the only source of the
wording: the title, three paragraphs, three acknowledgments and both button
labels. The renderer asks the main process for the text, so what is displayed,
what is hashed and what the tests assert cannot drift apart.

Peek is described as experimental, unaudited software that is not a conventional
browser and must not be relied on as one. The third paragraph asks the person to
accept the risk and responsibility for their use. The words express that request;
they do not guarantee an enforceable transfer of liability, are not a substitute
for security work or legal advice, and legal review of release wording remains
recommended.

## Startup sequence

```
entry.ts (gate)
  imports only: headless-policy, electron, build-info, startup-consent
  reads the record synchronously from the installation user-data root
  |
  |-- valid record --> await import('./runtime-entry.js') before Electron is ready
  |                    (identical to the previous startup; nothing is shown)
  |
  `-- no valid record --> install inert capture and take bootstrap lock before ready,
        wait for ready, show the notice
        |-- Quit, Escape, window close  --> discard pending work, exit 0
        |-- presentation / bootstrap error, no display, headless
        |                               --> diagnostic on stderr, exit 1
        `-- accept (all three boxes)    --> write the record atomically,
                                            release the bootstrap lock,
                                            relaunch the app, exit 0
```

The notice is for packaged builds only. A run from source (`app.isPackaged` false:
`yarn start`, `scripts/live-check.mjs`, `yarn test:grep`) behaves as if a valid
record exists: the runtime loads before ready, nothing is shown, and the record
file is neither read nor written (`startup-consent.ts noticeRequired()`).

`entry.ts` imports `headless-policy.js` first, so the macOS headless activation
policy is still applied before anything else with side effects. The runtime lives
in `runtime-entry.ts` and is reachable only through the gate's `loadRuntime`
dependency. `startup-consent.test.ts` enforces the import allowlist of `entry.ts`,
`startup-consent.ts` and `startup-consent-electron.ts`, so a static import of the
runtime, a profile module or the datastore fails the build.

`createStartupConsentGate()` is the injected orchestrator: record reader,
presenter, persistence and runtime loader are parameters. It runs once per
process, never persists or loads the runtime after decline, close, a bad message
or a failed presentation, persists before loading, and treats a persistence
failure as "show the notice again with the error", unless the person has declined.
Cancellation stays live through persistence: Quit, Escape, close and app quit
abort startup. The gate waits for the write to settle and removes a successfully
committed record after cancellation before exiting. It never recreates the notice
on a cancelled write failure.

### Why the first acceptance restarts the app

The runtime must register the `peek://` scheme privileges and set some
command-line switches before Electron is ready. The notice window needs a ready
app. Registering scheme privileges after ready throws, so the runtime cannot be
started in the same process that showed the notice without changing
`main.ts`/`protocol.ts` (outside this feature). After the first acceptance the
app therefore relaunches itself with bootstrap options (and the source application
path for source launches), not original navigation operands, and exits; every
later launch has a record and starts the runtime directly, with no restart.

Consequence: the very first launch starts the application twice. A possible
follow-up is to split scheme registration out of `main.ts configure()` so the
first launch can continue in-process.

## The notice window

`startup-consent-electron.ts` creates one window with `sandbox: true`,
`contextIsolation: true`, `nodeIntegration: false`, an in-memory session that
denies every permission and cancels every non-`file:` request, blocked
navigation, no popups and no webviews. The preload (`startup-consent-preload.cts`,
CommonJS because the sandbox rejects ESM) exposes `getNotice`, `decide` and
`onError` only. Main ignores IPC that does not come from the notice's main frame.

The page (`renderer/startup-consent/`) uses a classic script, no form element and
no autofocus on an action: Enter cannot accept. Continue stays disabled until all
three unchecked boxes are checked, and Enter activates it only when it is enabled
and focused. Escape and Quit decline. The page has labelled controls, a labelled
group, an alert region for save errors, visible focus, light and dark colors, and
wraps and scrolls on small screens.

Files in `renderer/` ship in the package without extra configuration
(`electron-builder.yml` packages `**/*`); the desktop spec asserts the notice
actually load from the application under test, including `app.asar` in packaged
runs, with a working sandboxed preload bridge and stylesheet.

## Pending work while blocked

Command-line URLs, `open-url`, and second-instance launches are captured as inert
data in `createPendingWork()`; nothing navigates, fetches or loads a profile. On
acceptance only the first value that passes `validatePendingUrl()` (http or https,
bounded length) is passed on as an argument to the restarted app; file paths and
other schemes are dropped. On decline or failure everything is discarded. OS
activation and a second launch never dismiss the notice, and the window is not
raised by them.

## Concurrency

Before readiness or showing the notice, bootstrap takes a single-instance lock on the installation user-data
root. A second unaccepted launch in that root exits and forwards its arguments to
the first. The runtime's own lock is per profile (it lives in the profile's
`userData`), so accepted launches under different profiles are unaffected. The
bootstrap lock is released before the restart.

## The record

Location: `<installation-user-data-root>/startup-risk-acknowledgment.json`, the
user-data directory captured before the runtime selects a profile. It is outside
every profile directory, so profile data, imports, exports and sync neither carry
it nor confer consent. Schema version 1:

```json
{
  "schemaVersion": 1,
  "noticeVersion": 1,
  "noticeHash": "<lowercase SHA-256 hex>",
  "acceptedAt": "2026-01-02T03:04:05.000Z",
  "buildIdentity": "<optional build identity string>"
}
```

The hash is SHA-256 over `JSON.stringify(NOTICE)`. `buildIdentity` is
informational: an app update with unchanged wording does not prompt again. There
is no account identity and nothing is sent anywhere. The file is locally
editable, so it is a local acknowledgment and not tamper-proof legal evidence.

A missing, unreadable, malformed, truncated, unsupported, version-mismatched or
hash-mismatched file counts as not accepted. Writes use a unique exclusive
temporary file in the same directory, flush, then rename over the record.

## Updating the notice

1. Obtain approval for the changed wording.
2. Change `NOTICE` and increment `NOTICE_VERSION` in the same commit. Never reuse
   a version for different wording; the hash is recomputed automatically.
3. Update the wording tests and exercise re-consent from an older record.
4. Check the rendered notice, including on a small window and with a screen reader.

## No bypass, no display, headless

There is no flag, environment variable, test-profile exemption, headless
auto-accept, developer shortcut or timeout that starts the runtime without a
record. Without a display (Linux without `DISPLAY` or `WAYLAND_DISPLAY`) or with
`PEEK_HEADLESS` set, an unaccepted launch fails closed with a diagnostic and
exit code 1.

Tests that are not about the notice launch through
`tests/fixtures/desktop-app.ts`, which writes a valid record into that launch's
temporary user-data root (and refuses any path outside the OS temp directory).
`launchStartupGate()` launches with no record for the notice's own spec.

`scripts/live-check.mjs` never writes a record. A headless start with no record is
refused with an explanation. A visible start lets the person accept, and the
supervisor follows the restarted copy.
