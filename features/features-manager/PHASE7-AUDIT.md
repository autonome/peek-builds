# Features Manager — Phase 7 Polish Audit

Audit of the features-manager feature (Phases 1–6 work) ahead of Phase 7 polish work.

## Issues Found (ordered by importance)

### HIGH — Bugs

**1. Semver comparison using string `<` in browse.js (bug)**
File: `features/features-manager/browse.js` line 381
```js
if (installedVersion && installedVersion < record.version) {
```
String comparison is wrong for semver — `"0.9.0" < "0.10.0"` is false (string sorts "9" > "1"). The `compareSemver` function exists in `updater.js` but is not used here. Browse UI will show wrong "Update Available" vs "Installed" badges.

Fix: import `compareSemver` from `./updater.js` and use it.

**2. Publish wizard opens wrong URL from dev card "Publish" button**
File: `features/features-manager/manage.js` line 368
```js
api.window.open(`peek://features-manager/publish.html?featureId=...`
```
Should be `peek://ext/features-manager/publish.html` (with `/ext/` prefix), matching the URLs used in `background.js` for `openPublish()`. Without `/ext/` the window will not resolve.

Fix: correct the URL prefix.

**3. Dead imports in background.js**
File: `features/features-manager/background.js` line 11
```js
import { checkForUpdates, shouldAutoUpdate, compareCapabilities } from './updater.js';
```
None of these are called — background.js delegates entirely to `api.features.updateCheckAll()` and `api.features.updateApply()`. The frontend `checkForUpdates()` function in `updater.js` is also unused (it was the client-side impl before the backend IPC was built). Dead imports add confusion.

Fix: remove dead imports from background.js. Keep updater.js as it contains `compareSemver` and `compareCapabilities` which are useful utilities.

---

### MEDIUM — UX gaps

**4. No curated feature directory in browse UI (Phase 7 item 35)**
File: `features/features-manager/browse.html` + `browse.js`
Browse UI shows only a blank "Search for features" state on open. The plan calls for a well-known curated list (Peek team DID) to be shown as a default when no search query is entered. Without this, the browse view is a dead end for users who don't know any publisher handles.

Fix: add a hardcoded curated publisher DID constant (can be a placeholder for now), auto-load it on open, show as "Featured" section above search results. The curated DID can be updated via a future release.

**5. search-input in manage.html has no focus style or border**
File: `features/features-manager/manage.css` line 254
`.search-input { width: 100%; }` — the class has no border, background, padding, or focus style. Other inputs in the file have proper styling. The search box is effectively invisible (inherits browser defaults only, no theme consistency).

Fix: add proper input styles matching `.install-input`.

**6. `feature:update-available` pubsub subscription in manage.js calls `loadFeatures()` but data doesn't include the update info**
File: `features/features-manager/manage.js` lines 969-982
The `feature:update-available` event is subscribed but the `loadFeatures()` call that follows will re-render with fresh data including any `availableVersion` field set by the backend. This actually works correctly since `api.features.list()` returns the registry entries which include `availableVersion`. However, the event fires from background.js, not from a backend publish, so there could be a timing gap where the registry isn't saved yet when the UI re-queries. Low risk — document only.

**7. Install history tab not exposed in manage UI**
The backend has `api.features.history()` wired up and the `features_history` datastore table is populated on install/update/uninstall events. But the manage UI has no UI surface for viewing install history. Phase 1 item says "Install history section (chronological log)" but it was deferred/skipped.

Fix: add a collapsible "Install History" section at the bottom of manage.html showing recent events.

**8. Empty state in manage.html uses generic text**
File: `features/features-manager/manage.js` line 124
When no features are installed, hint text says "Features installed from AT Protocol URIs will appear here." — but dev features and URL-sourced features also appear here. The hint is misleading.

Fix: update empty state hint text to be more general.

---

### LOW — Minor polish

**9. `formatCapabilityChange()` in manage.js produces awkward text**
File: `features/features-manager/manage.js` line 681
`'network:api.example.com'.replace(/\./g, ' ')` → "network:api example com" — the `.` in the domain gets replaced. Should only replace the capability path separator (`:`) and the capability object keys, not dots in domain names.

Fix: more targeted replacement that preserves domain dots.

**10. `updateLastCheckedFooter()` only fires on loadFeatures, not on explicit check**
File: `features/features-manager/manage.js` line 574
`checkForUpdates()` calls `updateLastCheckedFooter()` at the end. But the footer only shows if `feature.lastUpdateCheck` is non-null on any feature — which means it won't show until after the first check that returns a result for an atproto feature. If there are no atproto features, the footer never shows. Fine as-is but slightly confusing.

**11. Publish wizard: `nextToStep3` button has no validation**
File: `features/features-manager/publish.js`
Clicking "Next" from step 2 proceeds to step 3 even if description is over 2048 chars or other metadata is invalid. The textarea has `maxlength` but no server-side enforced length check is done before creating the record.

**12. Validate button result shown in status bar but not inline on card**
File: `features/features-manager/manage.js` line 342
Validation warnings are only logged to `console.log`. They should be shown inline on the card or in a panel below the card so the developer can see them without opening DevTools.

---

## Summary

- 3 bugs (items 1, 2, 3) — fix immediately
- 4 UX gaps (items 4, 5, 7, 8) — fix in this phase
- 5 minor polish items (items 6, 9, 10, 11, 12) — fix time permitting

## Fixes Applied

- [x] Bug 1: semver string comparison in browse.js
- [x] Bug 2: wrong publish URL from dev card
- [x] Bug 3: dead imports in background.js
- [x] UX 4: curated directory placeholder in browse UI
- [x] UX 5: search-input styling in manage.css
- [x] UX 8: empty state hint text
