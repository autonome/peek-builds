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

### `space.peek.feature.defs` (definitions)

Known category values: productivity, developer, social, media, search, privacy, theme, utility, fun.

### Future lexicons (deferred)
- Recommendations / "installed" signals — social discovery mechanisms, deferred until base system is functional
- Abuse/safety reporting — flagging malicious features

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
- List non-built-in features from registry, filterable by source (dev, local, atproto, url). Built-in features excluded for now — will be added once the system stabilizes.
- Per-feature: name, version, source badge, status (active/disabled/pending), update status
- Actions (always visible, never hover-reveal):
  - All features: enable/disable toggle, remove, open settings (if applicable)
  - Atproto features: check for update, update now, per-feature update policy selector (auto / notify / pinned)
  - Dev features: "Reload" (re-reads files from source dir without restart), "Open DevTools" (opens Electron DevTools on the tile's webcontents), "Validate" (checks manifest, resources, capabilities), "Publish" (opens publish wizard pre-selecting this feature)
- Capability detail view (granted vs denied)
- Install history section (chronological log)
- "Install from AT URI" input field
- **"Create Feature" button** — prompts user for a directory location (native directory picker), scaffolds a new feature there, registers in registry with `source.type = 'dev'`
- "Check for Updates" button (triggers manual check for all features)
- Update status badge on features with available updates

### publish.html — Publish Feature
- Requires active AT Protocol session (prompts to log in via Lex if not)
- Can be opened from manage UI's per-feature "Publish" button (pre-selects that feature) or standalone
- Step 1: Select feature to publish (pre-selected if opened from a dev feature card, otherwise pick from local/dev features)
- Step 2: Preview (manifest, files, sizes, capabilities)
- Step 3: Add metadata (description, categories, screenshots, readme)
- Step 4: Confirm and publish (upload blobs, create record)
- Step 5: Success with AT URI for sharing

---

## Feature Development

The features manager is the full dev hub for creating, developing, debugging, and publishing features. No CLI commands — everything flows from the manage UI.

### Source type: `dev`

A new source type alongside `builtin`, `local`, `atproto`, `url`. Dev features:
- Point directly at the developer's source directory (no file copy)
- The developer owns the source location — Peek just stores the absolute path in the registry
- Capabilities are auto-approved in dev mode (no approval prompt)
- CSP is relaxed for dev features to allow DevTools and debugging
- Appear in the manage UI with dev-specific actions

### Create Feature flow

1. User clicks **"Create Feature"** button in manage UI
2. Native directory picker opens — user chooses where to create the feature (e.g., `~/Projects/my-feature/`)
3. User enters a feature name/id in a simple dialog
4. Scaffold is written to the chosen directory:
   ```
   my-feature/
     manifest.json      # v2 manifest with id, name, one background tile, minimal capabilities
     background.html    # minimal with api.initialize() call
     background.js      # empty init function, ready to add logic
     home.html          # optional UI page template
     home.js            # minimal UI setup
     home.css           # basic styles with theme variables
   ```
5. Feature is registered in registry with `source.type = 'dev'`, `path` pointing at chosen directory, `userApproved = true`
6. Feature appears in manage UI immediately with dev-specific actions

### Dev-specific actions in manage UI

- **Reload** — re-reads files from the source directory and reloads the tile without restarting Peek. For background tiles: destroys and recreates the iframe/worker. For window tiles: reloads the window.
- **Open DevTools** — opens Electron DevTools on the tile's BrowserWindow or iframe webcontents. Essential for console.log debugging, network inspection, DOM inspection.
- **Validate** — runs manifest validation (schema, required fields), checks all declared resource files exist, checks capability declarations match what the code actually uses (best-effort), reports warnings and errors inline.
- **Publish** — opens the publish wizard with this feature pre-selected. Same publish flow as Phase 4, just pre-populated.

### Dev feature lifecycle

- Dev features are loaded on startup like any other feature (read from registry, load manifest from path, launch tile)
- Since path points to the dev's source dir, any file changes are picked up on reload (no re-install needed)
- Dev features persist across restarts (registered in registry)
- Removing a dev feature from the manage UI only removes the registry entry — source files on disk are untouched
- When ready to distribute, the dev publishes from the feature card → publish wizard → atproto

### IPC handlers for dev workflow

- `feature-dev:create` — takes directory path + feature name, writes scaffold files, registers in registry
- `feature-dev:reload` — takes feature id, destroys and recreates the tile context from the source path
- `feature-dev:open-devtools` — takes feature id, finds the tile's webcontents, opens DevTools
- `feature-dev:validate` — takes feature id, reads manifest + files, runs validation checks, returns results

### Scaffold template

The manifest.json scaffold:
```json
{
  "manifestVersion": 3,
  "id": "{feature-id}",
  "name": "{Feature Name}",
  "version": "0.1.0",
  "description": "",
  "tiles": [
    {
      "id": "background",
      "url": "background.html",
      "lazy": true
    },
    {
      "id": "home",
      "url": "home.html",
      "width": 800,
      "height": 600,
      "title": "{Feature Name}"
    }
  ],
  "capabilities": {
    "pubsub": { "scopes": ["self", "global"] },
    "commands": true
  },
  "commands": [
    {
      "name": "{feature-id}",
      "description": "Open {Feature Name}",
      "action": { "type": "window", "url": "home.html" }
    }
  ]
}
```

### Registry changes for dev

- Add `'dev'` to `FeatureSource.type` union: `'builtin' | 'local' | 'atproto' | 'url' | 'dev'`
- Dev features: `userApproved` always true, `path` is the external source directory (not under app data)

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
2. For each feature with an available update, first compare capabilities:
   - **If capabilities unchanged or reduced**: proceed based on update policy
   - **If capabilities expanded (new or broader permissions requested)**: regardless of update policy, do NOT auto-install. Set `availableVersion` in registry, publish `feature:update-available` event with `{capabilitiesChanged: true}`, show notification and visual indicator in manage UI so the user can review and approve the new capabilities.
3. For features that pass the capability check:
   - If `updatePolicy: 'auto'`: fetch new version from publisher PDS, validate manifest and bundle, install over existing, update registry entry (version, availableVersion cleared), write `update` event to `features_history`
   - If `updatePolicy: 'notify'`: set `availableVersion` in registry, publish `feature:update-available` event, show badge in manage UI
   - If `updatePolicy: 'pinned'`: skip entirely
4. **Preserve user data**: update installs replace feature files but preserve any user settings or data associated with that feature
5. **Failed updates**: if download or validation fails (corrupt files, invalid manifest, hash mismatch), the update is not applied — the existing version remains in place. The failure is logged to `features_history`. The user can re-install previous versions from their install history (AT URI + version are recorded).

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
6. **Update atomicity** — if download/validation fails, don't install (old version stays). No complex rollback needed — users can re-install previous versions from install history.

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
24. Add capability-change detection (block auto-update if permissions expanded, require re-approval)
25. Add `feature:update-available` pubsub event and HUD/badge integration

### Phase 6 — Feature Development Workflow
26. Add `'dev'` source type to registry
27. Implement `feature-dev:create` IPC handler (scaffold writer + registry registration)
28. Implement `feature-dev:reload` IPC handler (destroy and recreate tile context)
29. Implement `feature-dev:open-devtools` IPC handler (find tile webcontents, open DevTools)
30. Implement `feature-dev:validate` IPC handler (manifest + resource validation)
31. Add "Create Feature" button to manage UI with native directory picker + name dialog
32. Add dev-specific action buttons to dev feature cards (Reload, Open DevTools, Validate, Publish)
33. Wire "Publish" button on dev cards to open publish wizard pre-selecting the feature
34. Write scaffold templates (manifest.json, background.html/js, home.html/js/css)

### Phase 7 — Polish + Indexing
35. Curated feature directory (well-known list)
36. Relay/indexer service (separate repo)
37. Wire browse UI to indexer search API
