# Sync coverage gaps — what a server restore would not bring back

Research note. Surveys which parts of the datastore reach the sync server and which
are local-only, on the question: if a laptop is lost, what does restoring from the
server produce?

Nothing here is scheduled work. Each gap names what settles it.

Sources: `packages/schema/v1.json` (the canonical schema, `sync` flag per column),
`apps/desktop/main/sync.ts` (`pushSingleItem()`, `mergeServerItem()`,
`pullFromServer()`, `pushToServer()`, `syncTagsToItem()`), and
`apps/server/db.js` (`initializeSchema()`, `saveItem()`).

## Short answer

A restore returns items, their tags, and tag frecency. It does not return item
titles, domains, visit history, any item event, tag hierarchy, tag colors or
descriptions, or user-created rules.

For a library built mostly of saved URLs, the visible result is a set of untitled
entries — the title is what a person recognizes an item by, and it is cached
locally by design.

## 1. Item fields marked local-only

`packages/schema/v1.json` marks these `"sync": false` on `items`, each with a
rationale in its own description:

| Column | Stated rationale | Reconstructable? |
|---|---|---|
| `title` | "cached locally for URL items" | Only by refetching every URL, and not at all for dead links |
| `domain` | "cached locally" | Yes — derivable from content for `type: 'url'` |
| `favicon` | "cached locally" | Yes — refetchable, cosmetic |
| `frecencyScore` | "local calculation" | Recomputes, but only from visit history, which is also local-only |
| `visitCount` | "local tracking" | No — it is history |
| `lastVisitAt` | "local tracking" | No — it is history |

The framing "cached locally" fits a browser-history model, where the record is a
visit and the title is a convenience copy of something the network can return
again. It does not fit a knowledge store, where the item is the record and the
title is often the only human-readable handle on it.

`frecencyScore` is a genuine policy question rather than an oversight: it is
computed per device from that device's visits, so syncing it means deciding
whether a value stays per-device or becomes shared. `title` and `domain` carry no
such conflict.

**Settled by:** deciding whether `title` is authoritative data or a cache.
`apps/desktop/main/datastore.ts` is the policy owner. If authoritative, the change
spans three places — the column in `apps/server/db.js initializeSchema()`, the
push/merge bodies in `sync.ts pushSingleItem()` and `mergeServerItem()`, and
`validation.required_sync_columns.items` in the schema.

## 2. `item_events` is declared syncable and is not synced

The sharpest gap, because it is a contract violation rather than a decision.

`packages/schema/v1.json` marks every `item_events` column `"sync": true` and lists
the table in `validation.required_sync_columns`. `apps/server/db.js
initializeSchema()` creates the table. But `sync.ts` never reads or writes it —
there is no event push, no event pull, and no event merge. Nothing populates the
server-side table.

Consequences, in rising order of cost:

- Item event history — everything `record_event` writes — exists only on the
  laptop. That includes any task status trail.
- `series` and `feed` items are *shells* without it. Those types are in the schema's
  type CHECK and they sync, but their entire payload is rows in `item_events`. A
  restore returns the series with none of its observations.

**Settled by:** either implementing event sync or changing the schema to stop
declaring it. The current state — declared, indexed, unimplemented — reads as
working to anyone who checks the schema instead of the code.

## 3. Tag metadata is local-only

`tags` marks `slug`, `color`, `parentId`, `description`, and `metadata`
`"sync": false`, each described "desktop only".

`slug` is derivable. The rest are authored by a person and unrecoverable —
`parentId` in particular carries the tag hierarchy, so a restore returns a flat tag
list.

**Settled by:** the same policy call as §1, applied to tags. `color` and
`description` are cheap to carry; `parentId` needs an ordering rule so a hierarchy
merges rather than clobbers.

## 4. Rules are entirely local

The `rules` table is `"sync": false` in every column. Rules with
`source: 'manifest'` regenerate from feature manifests. Rules with
`source: 'user'` — authored in the rule editor — do not exist anywhere else.

**Settled by:** deciding whether user-authored rules are content (sync them,
filtering to `source = 'user'`) or configuration (leave them, and say so in the
rule editor).

## 5. Two divergent copies of the canonical schema

`apps/server/schema.json` is a stale copy of `packages/schema/v1.json`. Observed
differences: the older item-type CHECK (no `series`, `feed`, `entity`, `event`), no
`rules` table, no `item_events` table, a non-unique tag-name index, and a
`required_sync_columns` block missing `item_events` and `rules`.

Any schema change made by following one file leaves the other behind, and a drift
test pinned to one copy passes while the other rots.

**Settled by:** deleting the copy and importing `packages/schema/v1.json`, or
generating one from the other. Whichever survives, the server should fail to boot
against a schema it disagrees with rather than diverging silently.

## 6. The server's `items` table is missing columns the schema declares

`apps/server/db.js initializeSchema()` creates `items` with
`id, type, content, metadata, syncId, syncedAt, createdAt, updatedAt, deletedAt,
createdByDevice`. `title`, `domain`, and `frecencyScore` are absent entirely.

This is downstream of §1 — nothing syncs them, so nothing needed a column — but it
is worth stating separately, because it is the piece that blocks any consumer
reading items *from* the server rather than through a local datastore. See
`docs/mcp-remote-backend-design.md` §3.1.

## Verifying any of this

```
grep -n '"sync": false' packages/schema/v1.json
grep -n 'item_events' apps/desktop/main/sync.ts        # returns nothing
diff apps/server/schema.json packages/schema/v1.json
```

The first is the local-only inventory. The second is the contract violation in §2 —
an empty result is the finding. The third is §5.

## Not covered by this note

- Whether the server's backup path (`apps/server/backup.js`) changes any of the
  above. It backs up what the server holds; it cannot restore what never arrived.
- Blob and image storage coverage.
- Whether any of these gaps have already caused loss in practice — no audit of the
  live server's data was run.
