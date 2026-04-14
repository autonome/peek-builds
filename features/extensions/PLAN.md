# Extensions Manager — Implementation Plan

Peek feature for browsing, installing, managing, and publishing tile features via AT Protocol.

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

Directory: `features/extensions/` (avoids `features/features/`)

```
features/extensions/
  manifest.json
  background.html / background.js    — noun, session, install orchestration, history
  atproto-source.js                  — AtprotoSource implementation
  browse.html / browse.js / browse.css — search & browse UI
  manage.html / manage.js / manage.css — installed features management
  publish.html / publish.js / publish.css — publish flow
  history.js                         — install history tracking
```

---

## Manifest

v2 tile manifest. Builtin, lazy background. 4 tiles:
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

Commands: `extensions` (browse), `open extensions`, `manage extensions`, `publish extension`, `install extension`
Shortcut: `Cmd+Shift+X` → open extensions

---

## Background.js Responsibilities

1. Register `extensions` noun (query/browse/open/create) — auto-generates `list extensions`, `open extension`, `new extension`
2. Subscribe to `lex:session-changed` for AT Protocol OAuth session (reuse from Lex, don't duplicate login)
3. Bridge UI ↔ registry via pubsub: `feature:install-request`, `feature:install-result`, `feature:uninstall-request`, etc.
4. Write install/uninstall/update events to `features_history` table
5. Periodic update checking: compare installed version vs latest release record on publisher's PDS

---

## UI Pages

### browse.html — Browse & Search
- Search by publisher handle/DID (Tier 2) or paste AT URI (Tier 1)
- Feature cards: name, publisher avatar+handle, description, version, capabilities, install button
- Detail view: full description, screenshots, readme, version history, license
- "Installed" badge on already-installed features

### manage.html — Manage Installed
- List all features from registry, grouped/filterable by source (builtin, local, atproto, url)
- Per-feature: name, version, source badge, status (active/disabled/pending)
- Actions: enable/disable toggle, remove, check for update, open settings
- Capability detail view (granted vs denied)
- Install history section (chronological log)
- "Install from AT URI" input field

### publish.html — Publish
- Requires active AT Protocol session (prompts to log in via Lex if not)
- Step 1: Select local feature directory
- Step 2: Preview (manifest, files, sizes, capabilities)
- Step 3: Add metadata (description, categories, screenshots, readme)
- Step 4: Confirm and publish (upload blobs, create record)
- Step 5: Success with AT URI for sharing

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

New datastore table `features_history`:
- `id` (autoincrement)
- `featureId`, `event` (install|uninstall|update|approve|deny), `version`
- `sourceType`, `sourceUri`, `publisher`
- `capabilities` (JSON), `timestamp` (ISO datetime)

---

## Registry Changes

- Add `disabled?: boolean` to `FeatureRegistryEntry`
- Add `disableFeature(id)` / `enableFeature(id)` methods
- Factor `installFromBundle(bundle, source)` out of `installFromLocalDirectory()`
- `tile-loader.ts`: skip loading if `entry.disabled`
- Add registry IPC handlers in `tile-ipc.ts` (tiles need runtime access to query/modify registry)

---

## Dependencies & Risks

1. **Registry IPC gap** — registry is main-process only, no IPC for tiles to query at runtime. Must add handlers.
2. **Cross-tile imports** — plan assumes importing `atproto.js` from Lex feature. If isolation prevents this, extract to shared location.
3. **PDS blob limits** — large feature bundles may exceed limits. Show sizes in publish preview.
4. **Capability approval UX** — `userApproved` flow not yet fully implemented in UI. Needed before atproto installs are safe.
5. **NSID namespace** — `space.peek.feature.*` requires controlling `peek.space` domain for AT Protocol validation.

---

## Implementation Phases

### Phase 1 — Foundation (no atproto)
1. Create `features/extensions/` with manifest.json
2. Implement manage.html — list installed features from registry
3. Add registry IPC handlers to tile-ipc.ts
4. Add `disabled` field, enable/disable methods
5. Register noun in background.js
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

### Phase 5 — Polish + Indexing
20. Update checking (installed version vs latest release)
21. Curated feature directory (well-known list)
22. Relay/indexer service (separate repo)
23. Wire browse UI to indexer search API
