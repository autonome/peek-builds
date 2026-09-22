---
enabled: true
touches: [apps/desktop/main/datastore.ts, apps/desktop/main/migrate-hud*.ts, apps/desktop/main/session.ts]
depends-on: []
---

# One-shot profile migration that removes every trace of the old HUD

Peek item `a9970bfb`.

## Problem

The old HUD renderer (`apps/desktop/renderer/hud/`), its `peek://hud/*` and `peek://ext/hud/*`
protocol routes, the `hud-overlay` pseudo-tile and the `hud` core renderer id were deleted in
commit `3269f412` ("Delete the old HUD renderer and its dead wiring"). Profiles that ran the HUD
while it was enabled can still carry its data, and with the routes gone that data points at
nothing: a `peek://hud/...` entry in the session snapshot or the closed-window stack opens a
window that fails to load, and stale `hud` feature rows keep a toggle alive for a feature that
no longer exists.

## Requirements

1. A one-shot migration, run once per profile at datastore open and recorded as applied in the
   `migrations` table, the same way the existing `migrate*()` functions listed in
   `apps/desktop/main/datastore.ts` record themselves (`INSERT OR REPLACE INTO migrations (id,
   status, completedAt)` under a `MIGRATION_ID`). It is registered in that same list, not as
   ad-hoc startup code.
2. It removes from the datastore:
   - every window entry whose URL starts with `peek://hud/` or `peek://ext/hud/` from the
     session snapshot (`feature_settings` rows with `featureId = 'session'`, written by
     `main/session.ts saveSessionSnapshot()`), from any per-workspace snapshot rows, and from
     the closed-window stack;
   - every `feature_settings` row whose `featureId` is `hud`, `hud-widget` or `hud-overlay`,
     and the builtin-feature enabled/disabled entry for `hud`;
   - every context entry (`mode`, `pin` or otherwise) attached to a HUD window or keyed by a
     HUD tile id;
   - any other row the inventory step below turns up.
3. Before writing it, inventory what the HUD actually wrote: in the deleted tree at
   `3269f412^` (`git show 3269f412^:apps/desktop/renderer/hud/<file>`, or
   `git ls-tree -r --name-only 3269f412^ -- apps/desktop/renderer/hud`), grep for
   `settings.set`, `datastore`, `context.set` and `pubsub` persistence calls and list each key.
   The migration's header comment lists them, so the list is checkable.
4. The migration is temporary. Its header says it can be deleted once a release has shipped it,
   and names Peek item `a9970bfb`.
5. A profile seeded with a `peek://hud/hud.html` session-snapshot entry, a
   `peek://ext/hud/widgets/mode.html` closed-window entry and a `featureId = 'hud'` settings row
   opens with none of them present, and opens a second time without re-running the migration.
6. A new unit test beside the existing ones (`apps/desktop/main/migrate-*.test.ts`, shaped like
   `migrate-empty-text-cleanup.test.ts`) seeds the rows above, runs the migration and asserts
   they are gone and the applied marker is set.

## Verify

The repo gate (`tracks.json` `verify`) builds the desktop app and runs every
`apps/desktop/dist/main/*.test.js`, which includes the new test. Done when it passes and the test
from requirement 6 is among the passing tests.

## Working rules

- `apps/desktop/CLAUDE.md` governs the desktop app. Read it before editing.
- Run one command per Bash call; use the `yarn` scripts.
- Nothing here runs against a real profile.
