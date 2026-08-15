# Sync coverage gaps — what a server restore would not bring back

Research note. Surveys which parts of the datastore reach the sync server and which
are local-only, on the question: if a laptop is lost, what does restoring from the
server produce?

Nothing here is scheduled work. Each gap names what settles it.

Sources: `packages/schema/v1.json` (the canonical schema, `sync` flag per column),
`apps/desktop/main/sync.ts` (`pushSingleItem()`, `mergeServerItem()`,
`pullFromServer()`, `pushToServer()`, `syncTagsToItem()`, `pushTagsToServer()`,
`pullTagsFromServer()`, `mergeServerTag()`), and `apps/server/db.js`
(`initializeSchema()`, `saveItem()`, `saveTags()`, `getTagsSince()`).

## Short answer

A restore returns items, their tags, tag frecency, and tag metadata (color,
description, hierarchy). It does not return item titles, domains, visit history,
any item event, or user-created rules.

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

### `starred` and `archived` are the same shape of gap

Both are `"sync": true` on `items` in `packages/schema/v1.json`, and neither appears
in the body `sync.ts pushSingleItem()` builds or the columns `mergeServerItem()`
inserts. Until the MCP work added them, the server had no column to receive them
either.

So a starred item is starred on one laptop only, and archiving something on one
device leaves it unarchived everywhere else. Lower stakes than the event tables, and
the same root cause: the schema's `sync` flag describes an intention that the sync
engine was never made to honour.

**Settled by:** carrying both in `pushSingleItem()` and `mergeServerItem()`. The
server columns now exist, so this is the smaller half of the change.

## 3. Tag metadata now syncs; tag identity and deletion are the remaining gaps

`slug`, `color`, `parentId`, `description`, and `metadata` on `tags` are `"sync":
true` as of DATASTORE_VERSION 3. `sync.ts pushTagsToServer()` /
`pullTagsFromServer()` / `mergeServerTag()` carry them, keyed by the tag's `name` —
the same identity `apps/server/db.js getOrCreateTagWithConn()` already used for tag
rows an item push derives. `parentId` travels on the wire under that same field
name but holds the parent's name, not any id — the server column of the same name
stores that name too, not a row id — resolved back to a local tag id on pull in a
second pass so a parent arriving after its child in the same pull still links
correctly; an incoming cycle of `parentId` (name) links is broken deterministically
(newest `updatedAt` loses its parent link, ties going to the lower `id`) so every
device that pulls the same cycle breaks the same link.

Two gaps remain, accepted rather than fixed:

- **Renaming a tag on one device creates a second tag rather than renaming the
  first.** Identity on the wire is the name; a syncId would give the same row two
  sources of truth to reconcile, and the push/pull code was built to avoid that
  rather than build rename support.
- **Tag deletion does not propagate.** There is no tombstone column on `tags` — a
  tag deleted on one device still exists, and can still be pulled back, on every
  other device.

**Settled by:** a real tag identity beyond name (needed for rename to sync) and a
`deletedAt` column plus tombstone push/pull (needed for delete to propagate) — both
separate, unscheduled work.

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

## 7. A push with no `tags` field wipes the item's existing tag links

Every other item column `apps/server/db.js saveItem()` writes goes through
`COALESCE(?, existingColumn)`, so a client that omits a field on a re-push (e.g.
an older client that doesn't carry `title`/`domain`/`starred`/etc.) leaves the
stored value untouched. `tags` is the one exception: `saveItem()` unconditionally
runs `DELETE FROM item_tags WHERE itemId = ?` and rebuilds the links from the
pushed `tags` array, and `POST /items` defaults an absent `tags` field to `[]`. A
push with no `tags` field at all therefore clears the item's tags, where the same
omission on any other field is a no-op.

This is latent, not live: every current client (desktop, mobile, extension) always
sends a full `tags` array on every item push. Pinned by
`apps/server/test.js` "a push with no tags field wipes the item's existing tags
(latent hazard, not desirable)".

**Settled by:** giving `tags` the same COALESCE-style omitted-means-unchanged
treatment as every other column — unscheduled work, since no current client hits it.

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
