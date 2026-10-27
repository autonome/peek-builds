---
enabled: true
touches: [apps/desktop/main/entry.ts, apps/desktop/main/runtime-entry.ts, apps/desktop/main/startup-consent.ts, apps/desktop/main/startup-consent.test.ts, apps/desktop/main/startup-consent-electron.ts, apps/desktop/main/startup-consent-preload.cts, apps/desktop/renderer/startup-consent/, apps/desktop/tests/desktop/startup-risk-acknowledgment.spec.ts, apps/desktop/tests/fixtures/, scripts/live-check.mjs, docs/design/startup-risk-acknowledgment.md]
depends-on: []
---

# Require informed risk acceptance before Peek starts

The account holder approved this wording and behavior for implementation.

Automated desktop builds let anyone download and run Peek. Peek has not been security
audited, may be unstable in ways its author does not know about, and is not a conventional
browser, nor intended to become one. Before normal application behavior can run, users
must explicitly acknowledge those facts and accept responsibility for the risks of use.
A download, installation, launch, or dismissing a notice is not acceptance.

## Scope and boundary

- Applies to the Electron desktop app, including source launches and downloaded builds
  on Linux, macOS and Windows. Existing installations are not grandfathered in.
- This is a startup prerequisite, not a welcome screen shown over an already running app.
  Only minimal local bootstrap necessary to show the notice, enforce single-instance
  behavior, and read/write its acceptance record may run beforehand. The OS/Electron
  runtime necessarily runs to display it; do not promise that literally no code runs.
- No normal profile database initialization or migration, session restoration, page or
  webview creation, feature/peeklet execution, extensions, sync, background schedules,
  downloads, tray, global shortcuts, CLI socket server, telemetry, updater/network work,
  or registration as a default handler before acceptance. The notice itself is offline.
- Current `entry.ts` statically imports runtime modules and initializes profiles at
  module scope, before `onReady()`. An `onReady()` dialog alone is insufficient.
  Keep `entry.ts` as the minimal gate and dynamically import a new `runtime-entry.ts`
  containing the existing runtime only after the gate succeeds. Audit bootstrap imports
  for side effects; preserve the early headless-policy ordering and existing profile /
  single-instance semantics. If another file must change, request a `touches` amendment
  rather than silently expanding scope or weakening this boundary.
- Mobile, the Chrome extension, server processes, website download notices, and legal
  review are outside this implementation. Do not claim they are protected by this gate.

## Notice and explicit action

Title: **Before you use Peek**

Present this text, readable in full without visiting a website:

> Peek is experimental software. It has not been security audited and may contain
> unknown security vulnerabilities, serious defects, and unstable behavior. It may
> lose or corrupt data, expose private information, or cause other harm.
>
> Peek is not a conventional web browser and is not intended to become one. Its ability
> to display web pages is not a promise of the security, privacy, compatibility,
> reliability, or protections you may expect from a conventional browser. Do not rely
> on it as a safe replacement for one.
>
> Peek is provided “as is”, without warranties, to the fullest extent permitted by
> applicable law. If you choose to use it, you accept the risks and full responsibility
> for your use and any resulting loss, damage, or other consequences. To the fullest
> extent permitted by applicable law, its authors and contributors disclaim liability
> arising from its use. Nothing in this notice excludes rights or liability that
> applicable law does not permit to be excluded.

Require three separate, initially unchecked checkboxes:

1. **I understand that Peek has not been security audited and may be unstable or unsafe.**
2. **I understand that Peek is not a conventional browser and must not be relied on as one.**
3. **I accept the risks and full responsibility for my use of Peek and its consequences,
   to the fullest extent permitted by applicable law.**

Buttons: **Quit** and **Accept risks and continue**. Continue is disabled until all
three boxes are checked. No prechecked state, countdown, implicit consent, misleading
button label, or auto-accept via Enter/default focus. Support keyboard navigation,
screen readers, visible focus, readable contrast and long text on small screens. Enter
may activate Continue only when it is enabled and explicitly focused. Escape, window
close and Quit decline and terminate without starting the runtime. OS activation or a
second launch must never dismiss or bypass the notice.

These words express the requested assumption of risk; they do not guarantee an enforceable
transfer of all liability. Do not describe them as a substitute for security work or legal
advice. The account holder has approved this notice for implementation; legal review of
release wording remains recommended, not something a code test can certify.

## Acceptance storage and startup behavior

- Persist a local, installation-user-scoped record outside individual profiles, with a
  notice version, exact notice-text hash, acceptance timestamp and build identity when
  available. No network submission, account identity, or claims of independently verified
  identity. This is a local acknowledgment, not tamper-proof legal evidence.
- Use the same stable location for every normal profile in that installation/user-data
  root, before runtime profile selection changes Electron's `userData` path. Do not sync
  it, include it in profile exports, or allow imported data to grant consent.
- A matching valid version/hash permits subsequent launches without repeating the notice.
  An absent, malformed, truncated, unsupported, or outdated record requires acceptance.
  A changed notice requires a new version/hash and re-acceptance; an ordinary app update
  with unchanged wording does not. Never infer acceptance from an existing profile.
- Write acceptance atomically before importing/starting the runtime. If persistence fails,
  explain locally and allow retry or Quit; do not continue with unrecorded acceptance.
  A notice-rendering or bootstrap error must fail closed, never fall through to startup.
- Pending command-line URLs, protocol events, second-instance launches and OS activation
  may be captured as inert data only. Process them after acceptance through normal URL
  validation, or discard on decline. Do not navigate, fetch, start a second runtime,
  or run profile migrations in response while blocked.
- Handle concurrent launches safely: no launch can start normal runtime without a valid
  record or its own completed acceptance flow. Preserve per-profile runtime locks; a
  bootstrap lock must not prevent accepted users running different profiles concurrently.
- No production `--accept`, environment-variable bypass, headless auto-accept, developer
  auto-accept, test-profile exemption, or timeout-to-continue. With no interactive display
  and no valid record, fail closed with a clear diagnostic. Tests that are not testing
  this gate may explicitly seed a valid record in their isolated user-data root; never
  touch the developer's real acceptance record. Gate tests start with an unseeded root.
- `live-check.mjs` must not silently seed consent on behalf of a human. It must let the
  acknowledgment happen, or report that the requested headless launch is blocked.

## Tests to write first

- Neutral unit tests for the version/hash validation, corrupt/missing/old records,
  atomic persistence and write failure, and the all-three-explicit-acknowledgments rule.
- Bootstrap orchestration tests with injected runtime loader, persistence and presenter:
  runtime is never imported on pending, declined, closed, failed presentation or failed
  persistence; on success persistence precedes import and runtime starts exactly once.
- A guard/source test proving the bootstrap does not statically import the runtime or
  profile initialization; instrumentation of representative forbidden startup effects
  must confirm they have not run while consent is pending.
- Desktop integration tests with fresh isolated user-data: only the notice exists;
  all combinations missing any checkbox cannot proceed; keyboard/close/Escape paths;
  acceptance starts the normal app; matching record skips it on relaunch; changed or
  corrupt record prompts again; declined launches leave no acceptance record.
- While blocked, launch with a URL and send second-instance/protocol/activation events:
  no page, external request, feature or normal runtime appears; acceptance releases only
  validated pending work, decline releases none. Test concurrent launches and the
  existing accepted multi-profile behavior.
- Packaged smoke coverage: bundled notice/preload assets are present, startup is gated
  on a fresh user-data root, decline exits, and accept persists. Linux can be verified
  here; macOS/Windows interaction checks remain explicitly unverified until exercised.

## Verify and done criteria

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
node scripts/check-platform-leak.mjs
yarn test:grep "startup risk acknowledgment"
yarn test:desktop:electron
```

Follow the desktop guide's platform-specific launch and gate rules. Compare the full Linux
suite against `apps/desktop/tests/gate-baseline.md`: no new failures, skips or relaxed
assertions, and do not rewrite the baseline to accept regressions. Record actual commands,
counts and platform coverage in the implementation track's handoff. Run a fresh packaged
Linux smoke check through the prescribed live-check workflow (Playwright is the exception).

Done when the approved notice is the sole interactive surface before acceptance, runtime
side effects cannot precede it, decline always exits, persistence/re-consent work, packaged
assets work, existing accepted-user startup remains intact, and tests enforce the boundary.
Document the storage location, record schema, notice-version update procedure, non-browser
positioning and legal-enforceability limitation in `docs/design/startup-risk-acknowledgment.md`.

## Working rules

Read `apps/desktop/CLAUDE.md` before implementation. Keep state and decision logic neutral;
Electron-specific presentation belongs in the adapter. Do not weaken window-construction,
sandbox, headless or platform-boundary guards to add this surface. Change only `touches`.
Run one command per Bash call.
