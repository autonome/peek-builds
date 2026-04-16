# Agent Report — Features Manager Phase 7 Polish

## Audit Summary

Audited all six features-manager files (background.js, browse.js, manage.js, manage.css, manage.html, publish.js, updater.js) against the PLAN.md and previous phase work.

**12 issues found**, split:
- 3 bugs (HIGH)
- 4 UX gaps (MEDIUM)
- 5 minor polish items (LOW)

Full details in `features/features-manager/PHASE7-AUDIT.md`.

## Fixes Applied (6 of 12)

### Bugs fixed (3/3)

1. **Semver string comparison in browse.js** — `installedVersion < record.version` was a JS string comparison, not semver. `"0.9.0" < "0.10.0"` evaluates false because string comparison sorts "9" > "1". Fixed by importing `compareSemver` from `updater.js` and using it in both the badge and action button logic.

2. **Wrong URL prefix in dev card Publish button** — `peek://features-manager/publish.html` should be `peek://ext/features-manager/publish.html`. Without the `/ext/` segment the window doesn't resolve. Other `openPublish()` calls in background.js use the correct URL.

3. **Dead imports in background.js** — `checkForUpdates`, `shouldAutoUpdate`, `compareCapabilities` were imported from updater.js but never called. The background tile delegates entirely to `api.features.updateCheckAll()` and `api.features.updateApply()`. Replaced with a comment explaining the architecture.

### UX gaps fixed (3/4)

4. **search-input unstyled in manage.css** — The `.search-input` class only had `width: 100%`, giving it bare browser-default styling (no border/background/focus theme). Added full input styles matching `.install-input`.

5. **Empty state hint text too narrow** — Hint said "Features installed from AT Protocol URIs will appear here" but dev and local-sourced features also appear in manage. Updated to cover all sources.

6. **Install history section** — `api.features.history()` was fully wired in the backend but had no UI. Added a collapsible "Install History" section at the bottom of manage.html/manage.js/manage.css. Shows event badge (install/update/uninstall/approve/deny), feature ID, and relative timestamp. Loads on first expand (lazy).

7. **`formatCapabilityChange()` mangled domain names** — The function replaced all `.` chars including those in domain values like `api.example.com`. Fixed to only replace dots in the capability key path, not in the value after `:`.

8. **Curated directory placeholder in browse UI** — Added `CURATED_PUBLISHER_DID` constant to browse.js. When set, browse auto-loads it on open and labels the results "Featured". Currently `null` pending the Peek team AT Protocol account setup. Also added `?publisher=` URL query param support so the browse window can be deep-linked.

## UX Gaps Still Open

- **Install history tab (item 7)** — DONE (included above as item 6)
- **Publish wizard step 2 validation (item 11)** — no length/format check before proceeding to step 3. Low risk (maxlength on textareas, server will reject oversized payloads).
- **Validate button warnings inline on card (item 12)** — warnings currently only go to console.log. Would need a per-card expandable result area.

## Test Results

**yarn test:unit**: 1627 tests, 0 failures

yarn test:electron:bg was not run — Electron tests require a running Electron instance and the changes are all frontend JS/CSS with no backend logic changes, so unit tests are the appropriate gate here.

## Design Doc

`docs/atproto-relay-indexer-design.md` — high-level design for the relay/indexer service (Phase 7 Tier 3, separate repo). Covers architecture, data model, API surface (`/features?q=`, `/publishers/:did`, `/featured`), Peek client integration path, fly.io hosting, and four open questions (NSID namespace, blob storage, abuse, backfill).

## Commits

1. `feat features-manager: phase 7 audit + polish fixes` — audit doc + 8 fixes
2. `docs: atproto relay/indexer design for Phase 7 Tier 3 discovery`
