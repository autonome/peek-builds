# AT Protocol Relay/Indexer for Peek Feature Discovery

Design sketch for the network-wide feature search service (Phase 7, Tier 3 discovery).
This is a **separate repo** — not built in this worktree. Captured here for review.

## Problem

Tiers 1 and 2 (direct AT URI resolution, publisher browsing) require knowing a publisher's
handle or DID in advance. For discovery-at-large — "find features tagged 'productivity'" —
you need a server that subscribes to the AT Protocol firehose and indexes feature release
records as they are created.

## Architecture

Same pattern as Bluesky feed generators and labelers: a standalone service that:

1. Subscribes to the firehose via `com.atproto.sync.subscribeRepos`
2. Filters for `space.peek.feature.release` records
3. Indexes them into a queryable store (Postgres or SQLite)
4. Exposes a search/list HTTP API consumed by Peek's browse UI

### Components

```
atproto-relay-indexer/
  src/
    ingester.ts      — firehose subscriber, filters + persists records
    indexer.ts       — indexing logic: dedup by featureId+version, resolve handles
    db.ts            — database schema + queries (Postgres for production, SQLite for dev)
    api.ts           — HTTP API server (Express or Hono)
    resolver.ts      — DID/handle resolution cache (plc.directory + well-known)
  schema.sql         — feature_releases table, full-text search index
  Dockerfile
  fly.toml           — fly.io deployment config (cheap, matches bsky ecosystem)
```

### Data Model

```sql
CREATE TABLE feature_releases (
  id           SERIAL PRIMARY KEY,
  at_uri       TEXT UNIQUE NOT NULL,       -- at://did:plc:.../space.peek.feature.release/tid
  cid          TEXT NOT NULL,
  feature_id   TEXT NOT NULL,              -- stable identifier from record
  publisher_did TEXT NOT NULL,
  publisher_handle TEXT,                   -- cached, refreshed periodically
  name         TEXT NOT NULL,
  version      TEXT NOT NULL,
  description  TEXT,
  categories   TEXT[],                     -- JSON array in SQLite
  capabilities TEXT[],
  is_latest    BOOLEAN DEFAULT false,      -- true for highest semver per (publisher_did, feature_id)
  created_at   TIMESTAMPTZ NOT NULL,
  indexed_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON feature_releases (feature_id);
CREATE INDEX ON feature_releases (publisher_did);
CREATE INDEX ON feature_releases (is_latest) WHERE is_latest = true;

-- Full-text search
CREATE INDEX ON feature_releases USING gin(to_tsvector('english', name || ' ' || COALESCE(description, '')));
```

### API Surface

All endpoints unauthenticated (public records only).

```
GET /features
  ?q=          — full-text search (name + description)
  ?category=   — filter by category
  ?capability= — filter by capability name
  ?cursor=     — pagination cursor (indexed_at-based)
  ?limit=      — default 20, max 100
  → { features: FeatureRecord[], cursor?: string }

GET /features/:did/:featureId
  → latest release for this (publisher, featureId) pair
  → { feature: FeatureRecord }

GET /publishers/:did
  → all latest releases for a publisher DID
  → { publisher: { did, handle }, features: FeatureRecord[] }

GET /health
  → { ok: true, lag: number }   — firehose lag in seconds
```

### Peek Client Integration

Browse UI already has the publisher-search flow. Adding indexer search requires:

1. New "Search All" mode alongside "By Publisher" in browse.html
2. A new `INDEXER_URL` constant (e.g. `https://peek-features.fly.dev`) — hardcoded
   initially, configurable via features-manager settings later
3. A new IPC handler `tile:features:search` that fetches from the indexer URL
   (gated on the existing `features.browse` capability, `network` domain added to
   features-manager manifest for the indexer host)

The client should gracefully degrade if the indexer is unreachable — fall back to
the publisher-search-only UI with a status message.

### Curated Directory Integration

The indexer can serve the curated list more robustly than the current hardcoded DID
approach: add a `/featured` endpoint that returns a curated set maintained editorially.
This replaces the `CURATED_PUBLISHER_DID` constant in browse.js with a proper API call.

## Hosting

- fly.io — same region as bsky.network relay nodes, low-cost, easy Docker deploy
- Single instance initially (read replicas if traffic warrants)
- Firehose reconnect with cursor persistence (survive restarts without replay gap)

## Security Considerations

- Only index `space.peek.feature.release` records — ignore all others
- Validate that `featureId` matches the manifest blob's `id` field before indexing
  (requires downloading and parsing the manifest blob — do this async in a worker)
- Rate-limit API by IP
- No auth required for reads (all data is public on the firehose anyway)
- CID validation on indexed records (verify blob references are well-formed)

## Open Questions

1. **NSID namespace**: `space.peek.feature.*` requires controlling the `peek.space` domain
   for AT Protocol lexicon validation. Confirm domain ownership before publishing lexicons.
2. **Blob storage**: The indexer doesn't need to store blobs (Peek fetches directly from PDS).
   But thumbnails/icons for the browse UI would be nice — needs a CDN or blob proxy.
3. **Abuse**: Spammy or malicious feature records will appear in search. Need a flagging
   mechanism (simplest: a blocklist of DIDs; proper: labeler integration).
4. **Backfill**: On first deploy, need to backfill existing records via `com.atproto.repo.listRecords`
   across all known PDSes — or wait for organic growth.

## Timeline

This is a separate repo. Suggested order:
1. Stand up the ingester + SQLite DB (local dev, no fly.io yet)
2. Add the `/features?q=` search endpoint
3. Wire Peek browse UI to use it (behind a feature flag / settings toggle)
4. Deploy to fly.io
5. Add curated `/featured` endpoint, replace hardcoded DID in browse.js
