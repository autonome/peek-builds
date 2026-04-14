# Features Manager — Implementation Plan

Peek feature for browsing, installing, managing, and publishing non-built-in tile features via AT Protocol.

The only difference between built-in features and non-built-in features is the source. Eventually all Peek features will be source-attributed via atproto, even built-ins.

## Lexicons (`space.peek.feature.*`)

### `space.peek.feature.release` (record type)

One record per published version (append-only, TID key). Fields:

- `featureId` (string, required) — stable feature identifier, matches manifest.id
- `name` (string, required) — human-readable name
- `version` (string, required) — semver
- `manifest` (blob, required) — manifest.json as application/json blob
- `bundle` (bundleRef, required) — all files as individual blobs
- `description` (string) — max 2048 chars
- `categories` (string[]) — max 10, from known values
- `capabilities` (string[]) — capability names for pre-install transparency
- `icon` (blob) — PNG or SVG, max 256KB
- `screenshots` (blob[]) — max 5, PNG/JPEG, max 2MB each
- `readme` (string) — markdown, max 32KB
- `license` (string) — SPDX identifier
- `homepage` (string, uri)
- `minPeekVersion` (string)
- `createdAt` (datetime, required)

**bundleRef**: `{ files: fileEntry[], totalSize: integer }`
**fileEntry**: `{ path: string, blob: blob }` — relative path + blob ref, max 5MB per file, max 100 files

Design rationale: individual blobs (not zip/tar) for content-addressability, partial updates, alignment with atproto blob model.

Versioning: query `listRecords` for collection filtered by `featureId`, sort by `createdAt` desc for latest.

### `space.peek.feature.star` (record type)

User signal for popularity. Same pattern as `app.bsky.feed.like`:
- `subject` (com.atproto.repo.strongRef, required)
- `createdAt` (datetime, required)

### `space.peek.feature.defs` (definitions)

Known category values: productivity, developer, social, media, search, privacy, theme, utility, fun.

---

## Discovery Architecture

### Tier 1 — Direct resolution (client-only, MVP)
User provides AT URI → Peek fetches record from PDS via `com.atproto.repo.getRecord`.

### Tier 2 — Publisher browsing (client-only, MVP)
User provides handle/DID → Peek calls `com.atproto.repo.listRecords` on their PDS for `space.peek.feature.release` collection.

### Tier 3 — Network-wide search (separate server, deferred)
Relay/indexer subscribes to firehose, indexes feature records, exposes search API. Same architecture as Bluesky feed generators. Separate project/repo.

MVP = Tiers 1 + 2 + a well-known curated list maintained by Peek team's DID.

---

## Feature Structure

Directory: `features/features-manager/`

```
features/features-manager/
  manifest.json
  background.html / background.js    — noun, session, install orchestration, history, update checks
  atproto-source.js                  — AtprotoSource implementation
  browse.html / browse.js / browse.css — search & browse UI
  manage.html / manage.js / manage.css — installed features management
  publish.html / publish.js / publish.css — publish flow
  history.js                         — install history tracking
  updater.js                         — update check and install logic
```

---

## Manifest

v2 tile manifest. Feature id: `features-manager`. Builtin, lazy background. 4 tiles:
- `background` (background, lazy)
- `browse` (window, 960x720)
- `manage` (window, 900x650)
- `publish` (window, 700x600)

Capabilities needed:
- pubsub: global + system scopes, topics `feature:*`, `ext:ready`, `app:shutdown`, `lex:session-changed`
- datastore: `features_history` table
- network: `*.bsky.network`, `*.bsky.social`, `public.api.bsky.app`, `plc.directory`, `*.host.bsky.network`
- window: create + query + manage
- commands, shortcuts, settings

Commands: `features` (browse), `list features`, `open features`, `manage features`, `publish feature`, `install feature`
Shortcut: `Cmd+Shift+X` → open features

Settings:
- `updateCheckInterval`: number (minutes), default 1440 (24 hours)
- `defaultUpdatePolicy`: `'auto' | 'notify' | 'pinned'`, default `'auto'`

---

## Background.js Responsibilities

1. Register `features` noun (singular: `feature`, query/browse/open/create) — auto-generates `list features`, `open feature`, `new feature`
2. Subscribe to `lex:session-changed` for AT Protocol OAuth session (reuse from Lex, don't duplicate login)
3. Bridge UI ↔ registry via pubsub: `feature:install-request`, `feature:install-result`, `feature:uninstall-request`, etc.
4. Write install/uninstall/update events to `features_history` table
5. Run update checks on configured interval (see Update Mechanism section)
6. Handle `feature:check-updates` command for manual update checks

---

## UI Pages

### browse.html — Browse & Search
- Search by publisher handle/DID (Tier 2) or paste AT URI (Tier 1)
- Feature cards: name, publisher avatar+handle, description, version, capabilities, install button
- Detail view: full description, screenshots, readme, version history, license
- "Installed" badge on already-installed features
- "Update Available" badge when newer version exists

### manage.html — Manage Features
- List all features from registry, grouped/filterable by source (builtin, local, atproto, url)
- Per-feature: name, version, source badge, status (active/disabled/pending), update status
- Actions: enable/disable toggle, remove, check for update, update now, open settings
- Per-feature update policy selector (auto / notify / pinned)
- Capability detail view (granted vs denied)
- Install history section (chronological log)
- "Install from AT URI" input field
- "Check for Updates" button (triggers manual check for all features)
- Update status badge on features with available updates

### publish.html — Publish Feature
- Requires active AT Protocol session (prompts to log in via Lex if not)
- Step 1: Select local feature directory
- Step 2: Preview (manifest, files, sizes, capabilities)
- Step 3: Add metadata (description, categories, screenshots, readme)
- Step 4: Confirm and publish (upload blobs, create record)
- Step 5: Success with AT URI for sharing

---

## Update Mechanism

### Manifest Versioning

The v2 tile manifest already has a `version` field (semver string). This is the version used for update comparisons. When a publisher creates a new `space.peek.feature.release` record with the same `featureId` but a higher `version`, that constitutes an available update.

The registry entry stores the installed version. Comparing against the latest release record on the publisher's PDS determines if an update is available.

### Update Check Process

1. **Interval**: configurable via `features.updateCheckInterval` setting, default every 24 hours (1440 minutes)
2. **Background check**: runs in the features-manager background tile on the configured interval
3. **Per-feature check**: for each installed atproto-sourced feature, query the publisher's PDS for `space.peek.feature.release` records with matching `featureId`, find the latest by semver, compare against installed version
4. **Manual check**: `check feature updates` command and "Check for Updates" button in manage UI
5. **Notification**: when updates are available, publish `feature:update-available` event with `{featureId, currentVersion, availableVersion}`. Optionally show in HUD or as a badge in the manage UI.

### Per-Feature Update Preferences

Each installed feature gets user-configurable update behavior, stored in the registry entry:

- **Auto-update** (`'auto'`, default): automatically download and install new versions when detected
- **Notify only** (`'notify'`): show that an update is available but don't install automatically
- **Pin to version** (`'pinned'`): stay on a specific version, ignore newer versions. User can set this to the current version to freeze it.

New features inherit the `defaultUpdatePolicy` from the features-manager settings.

### Update Flow

1. Background tile checks for updates on interval
2. For each feature with an available update:
   - If `updatePolicy: 'auto'`: fetch new version from publisher PDS, validate manifest and bundle, install over existing, update registry entry (version, availableVersion cleared), write `update` event to `features_history`
   - If `updatePolicy: 'notify'`: set `availableVersion` in registry, publish `feature:update-available` event, show badge in manage UI
   - If `updatePolicy: 'pinned'`: skip entirely
3. **Preserve user data**: update installs replace feature files but preserve any user settings or data associated with that feature
4. **Rollback**: before applying an update, back up the previous version's files to a versioned backup location. If the update fails validation or causes load errors, automatically revert to the previous version and log the failure.

### Update Commands

- `check feature updates` — manual update check for all installed atproto-sourced features
- `update feature <name>` — update a specific feature to the latest available version (overrides notify/pinned for this one action)

---

## AtprotoSource (`backend/electron/atproto-source.ts`)

Implements `TileSource` interface:

```
resolve(atUri) →
  1. Parse AT URI → {repo, collection, rkey}
  2. Resolve DID → PDS URL (via plc.directory)
  3. getRecord from PDS (unauthenticated)
  4. Download manifest blob, parse as TileManifestV2
  5. Resolve publisher identity (handle from DID doc)
  6. Return FeatureSourceMetadata

fetch(atUri) →
  1. resolve() to get record + manifest
  2. Download each fileEntry blob from PDS
  3. Build Map<path, Buffer>
  4. Validate manifest matches
  5. Return TileBundle
```

Runs in main process (Node.js). No auth needed for fetching public records.

---

## Install History

Datastore table `features_history`:
- `id` (autoincrement)
- `featureId`, `event` (install|uninstall|update|approve|deny), `version`
- `sourceType`, `sourceUri`, `publisher`
- `capabilities` (JSON), `timestamp` (ISO datetime)

---

## Registry Changes

### Core Registry
- Add `disabled?: boolean` to `FeatureRegistryEntry`
- Add `disableFeature(id)` / `enableFeature(id)` methods
- Factor `installFromBundle(bundle, source)` out of `installFromLocalDirectory()`
- `tile-loader.ts`: skip loading if `entry.disabled`
- Add registry IPC handlers in `tile-ipc.ts` (tiles need runtime access to query/modify registry)

### Update Fields on `FeatureRegistryEntry`
- `updatePolicy: 'auto' | 'notify' | 'pinned'` (default: `'auto'`)
- `pinnedVersion?: string` (only meaningful when `updatePolicy` is `'pinned'`)
- `lastUpdateCheck?: string` (ISO datetime of last check for this feature)
- `availableVersion?: string` (latest version seen on publisher's PDS, if newer than installed)

---

## Dependencies & Risks

1. **Registry IPC gap** — registry is main-process only, no IPC for tiles to query at runtime. Must add handlers.
2. **Cross-tile imports** — plan assumes importing `atproto.js` from Lex feature. If isolation prevents this, extract to shared location.
3. **PDS blob limits** — large feature bundles may exceed limits. Show sizes in publish preview.
4. **Capability approval UX** — `userApproved` flow not yet fully implemented in UI. Needed before atproto installs are safe.
5. **NSID namespace** — `space.peek.feature.*` requires controlling `peek.space` domain for AT Protocol validation.
6. **Update atomicity** — updates must be atomic (backup old, install new, verify, or rollback). Partial installs could leave a feature broken.

---

## Implementation Phases

### Phase 1 — Foundation (no atproto)
1. Create `features/features-manager/` with manifest.json
2. Implement manage.html — list installed features from registry
3. Add registry IPC handlers to tile-ipc.ts
4. Add `disabled` field, enable/disable methods
5. Register `features` noun in background.js
6. Add `features_history` table + history tracking

### Phase 2 — AtprotoSource + Install
7. Implement AtprotoSource in `backend/electron/atproto-source.ts`
8. Factor out `installFromBundle()` in feature-installer.ts
9. Add IPC handlers for install-from-atproto flow
10. Build capability approval prompt UI
11. Wire "Install from AT URI" in manage.html

### Phase 3 — Browse/Search UI
12. Implement browse.html — search by publisher handle
13. Publisher profile display (avatar, handle, DID)
14. Feature detail view with version history
15. Connect install button to Phase 2 flow

### Phase 4 — Publishing
16. Implement publish.html
17. Wire blob upload + record creation via Lex session
18. Publish confirmation + success views
19. Write lexicon JSON files

### Phase 5 — Updates
20. Add update fields to `FeatureRegistryEntry`
21. Implement `updater.js` — background interval check logic
22. Wire per-feature update policy UI in manage.html
23. Implement `check feature updates` and `update feature <name>` commands
24. Implement rollback mechanism (backup previous version before update)
25. Add `feature:update-available` pubsub event and HUD/badge integration

### Phase 6 — Polish + Indexing
26. Curated feature directory (well-known list)
27. Relay/indexer service (separate repo)
28. Wire browse UI to indexer search API
