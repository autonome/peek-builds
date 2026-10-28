---
enabled: false
touches: [scripts/check-r2-window-ops.mjs, apps/desktop/main/entry.ts, apps/desktop/main/runtime-entry.ts, apps/desktop/main/profiles.ts, apps/desktop/main/profiles.test.ts, apps/desktop/main/startup-profile.ts, apps/desktop/main/startup-profile.test.ts, apps/desktop/main/startup-profile-electron.ts, apps/desktop/main/startup-profile-preload.cts, apps/desktop/main/startup-consent-electron.ts, apps/desktop/main/startup-consent.test.ts, apps/desktop/renderer/startup-profile/, apps/desktop/tests/desktop/startup-profile-picker.spec.ts, apps/desktop/tests/fixtures/, apps/desktop/main/window-construction-gate.test.ts, scripts/live-check.mjs, docs/design/startup-profile-picker.md]
depends-on: []
---

# Choose a profile before normal startup when Default is active

Approved for manual implementation in the `startup-profile-picker` track. Keep
`enabled: false` while that track owns writing, so the automated tick cannot start
a second writer. This is not blocked on signing or the macOS signing credentials.

## Problem and goal

Downloaded CI builds have the same application identity as the installed app and
normally use its active production profile. Signing state and app bundle location
are not reliable isolation mechanisms. When the effective startup profile is the
built-in Default profile, require an explicit select/create decision **before
normal runtime startup**, using the isolated-bootstrap approach of the startup
risk acknowledgment. An already active named profile continues normally.

This is informed profile choice, not a claim that CI and production builds are
fully isolated. Selecting an existing profile deliberately uses its existing data
and sync configuration. Switching the saved active profile affects other builds
using the same installation user-data root; explain this in the chooser/docs.

## Startup order and policy

1. Existing liability acknowledgment gate first. No profile enumeration or profile
   database initialization before valid liability acceptance.
2. Inspect only profile metadata needed to determine the effective profile and
   list/create/select profiles. No profile datastore, session, sync, background
   features, extension execution, content pages, tray, shortcuts or CLI server
   starts while choice is pending.
3. If the effective profile is a valid existing named profile, start normally.
4. If Default is active (built-in `default` folder / built-in default metadata),
   no active profile is saved, the saved profile is missing, or this is a fresh
   installation, show the chooser rather than silently falling back to Default.
   Metadata corruption/read failures show an actionable local error and Quit;
   never treat a failure as permission to start on Default or wipe/recreate data.
5. Explicit nonempty `PROFILE` remains an intentional developer/test override.
   Validate it as a safe single folder name; do not accept traversal, separators,
   absolute paths, dot/dotdot or empty normalized names. A valid non-default
   override may skip the chooser without changing saved active production choice.
   `PROFILE=default` still needs explicit confirmation, not a default bypass.
   Preserve source/dev use of the `dev` profile and `.dev-profiles.db`; do not
   accidentally redirect source launches to production metadata.
6. Existing accepted-user named-profile startup must still register Electron's
   privileged schemes before readiness. A chooser shown after readiness may
   persist choice and safely relaunch, as the liability gate does. Do not import
   the whole runtime to obtain metadata helpers. Resolve the current duplicate
   profile selection in runtime-entry so runtime cannot silently choose a
   different profile or fall back after bootstrap's decision.

## Chooser interaction

- Title: **Choose a Peek profile**. Explain: Default is currently active; choose
  an existing profile or create a separate one before Peek starts. Existing
  profiles may contain personal data and configured sync. New profiles start
  empty with sync off. Selecting a profile changes the active choice for other
  Peek builds sharing this user-data root.
- List existing profiles by name, mark Default clearly, and expose no API keys,
  tokens, server credentials or profile contents to the renderer. Show only
  minimal safe metadata (identity/name/default marker, optional last-used).
- Do not preselect a row or pre-enable Continue just because Default is active.
  Selecting a row then **Use selected profile** is an explicit action.
- Keep Default selectable so existing data is not stranded. Explicitly choosing
  Default permits this launch but must prompt again on the next independent
  launch while Default remains active. Any relaunch handoff needed for this is
  one-use, scoped to this startup/installation and must not become a persistent
  skip flag, environment auto-accept or unvalidated URL/CLI bypass. No loop or
  duplicate runtime on the acceptance relaunch. Liability consent is never bypassed.
- **Create profile** accepts a human-readable name, validates it in main as well
  as UI, rejects whitespace-only names, empty derived folder names, collisions,
  reserved folder names and unsafe paths. Reuse existing profile metadata schema;
  newly created profiles have fresh identity, separate local storage, sync off,
  no inherited cookies, history, session, credentials or copied Default data.
- Persist selection only on explicit confirmation. Return to chooser with a local
  error on recoverable create/select failure; never silently use another profile.
  Validate selection IDs against current metadata, not renderer-supplied paths.
- Quit, Escape and window close cancel before runtime. Keep cancellation effective
  through pending writes/relaunch; a close during save must not launch the app.
  Opening/closing the chooser alone must not change the saved active profile.
- Keyboard accessible, readable contrast, visible focus, screen-reader labels;
  no Enter/default-focus implicit selection or offscreen required controls.
- Activation, command-line URLs, open-url/open-file and second-instance events
  remain inert until both gates complete. Preserve the consent gate's bounded
  validated navigation policy, and discard work on cancellation.

## Concurrency, storage and boundaries

- Only installation-level profile metadata may be read/created/changed before
  profile selection; do not run existing `migrateExistingProfiles()` or open user
  profile datastores just to show the chooser. Existing profile migrations run
  only after a valid selection when normal runtime begins.
- Coordinate the consent/chooser bootstrap lock so two concurrent launches cannot
  open duplicate flows or race partial creation/active selection. Release bootstrap
  locking safely before per-profile runtime locking. Existing accepted named
  different-profile launches must retain their current concurrency semantics.
- Create profile metadata/directory with rollback/clear recovery on partial failure;
  do not leave a profile claiming successful creation if its directory failed, and
  never delete pre-existing directories during rollback.
- Noninteractive/headless launch requiring the chooser fails closed with a clear
  diagnostic, unless the isolated test harness explicitly supplies an intentional
  named profile. Do not auto-create or auto-select a production profile for tests.
- Do not change data root, app ID, signing, sync protocol, existing profile content,
  normal post-startup profile management or release workflow under this task.
- Guard-file change may inventory exactly the new sandboxed chooser window; do
  not weaken sandbox/headless/platform/window-construction invariants. The R2
  checker may add exact-count, symbol-justified non-window SQLite close inventory
  entries for entry.ts (1), startup-profile.ts (2), startup-profile-electron.ts (4),
  after auditing all receivers; its existing documented policy allows database
  cleanup false positives. Never exempt a file/method broadly or allow an actual
  window operation. If another file is genuinely needed, request a bounded
  `touches` amendment.

## Tests first

- Neutral policy/orchestration: Default/no active/missing active/fresh installation
  prompt; existing active named profile skips; metadata failures fail closed;
  override validation and dev/production metadata separation; no runtime import
  until confirmed; explicit Default permits one launch but prompts on the next;
  no stale/replayed handoff bypass; liability still precedes all profile work.
- Profile creation tests: blank/unsafe/empty-slug/colliding/reserved names rejected,
  separate folder/identity with sync off and no inherited state, transaction and
  directory-failure behavior, no deletion of existing data.
- Deferred persistence/relaunch tests: Quit/Escape/close while selection or creation
  is pending never starts runtime; no implicit saved selection on cancel.
- Desktop tests: fresh and Default-active installation show only bootstrap UI;
  existing named selection, new profile creation, explicit Default, relaunch
  persistence/no prompt for named profile; no profile content/network/background
  effects while pending; early URL and concurrent launch handling, headless fail
  closed and accepted different-profile behavior. Seed consent in isolated fixture
  roots; do not use real user data or globally auto-select profiles.
- Source/boundary regression checks must prove pre-selection runtime is not
  imported, and instrument representative forbidden side effects. Existing
  startup-liability tests must continue to pass in the combined flow.

## Verify and done

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
node scripts/check-platform-leak.mjs
yarn test:grep "startup profile picker"
yarn test:grep "startup risk acknowledgment"
yarn test:desktop:electron
```

Follow apps/desktop/CLAUDE.md and platform-specific gate/launch rules. Bind TMPDIR
and test profiles to this worktree. Compare the complete Linux gate against the
recorded `gate-baseline.md`; no new failures/skips or relaxed assertions. Preserve
all user data, do not rerecord regressions as accepted. Real macOS/Windows behavior
must be marked unverified until checked there. Document order, metadata/override
policy, Default one-launch behavior, data/sync implications and recovery in
`docs/design/startup-profile-picker.md`. Commit verified work and record concrete
verification and remaining blockers in the track handoff. Do not merge/push/remove
worktrees from a worker; coordinator owns landing and CI artifact delivery.
