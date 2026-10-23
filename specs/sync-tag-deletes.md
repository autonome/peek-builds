---
enabled: true
touches: [apps/server/db.js, apps/server/index.js, apps/server/mcp-items.js, apps/server/test.js, apps/desktop/main/sync.ts, apps/desktop/main/sync.test.ts, apps/desktop/main/datastore.ts, apps/desktop/main/tag-tombstones.test.ts, docs/sync-coverage-gaps.md]
depends-on: [sync-feature-settings]
---

# A deleted tag stays deleted on every device

Deleting a tag on the desktop (`datastore.ts deleteTag()`) hard-deletes the row and its
`item_tags` links. Nothing tells the server, so the next tag pull (`sync.ts pullTagsFromServer()`)
brings the tag back. `docs/sync-coverage-gaps.md` section 3 records this gap. Tag identity on the
wire is the tag's `name`, and that stays unchanged. This spec carries deletions as tombstones
keyed by name.

## Decisions

- **Desktop keeps hard deletes**, so no tag read path changes. A new local table records each
  deletion:

  ```sql
  CREATE TABLE IF NOT EXISTS tag_tombstones (
    name TEXT PRIMARY KEY,
    deletedAt INTEGER NOT NULL,
    pushedAt INTEGER NOT NULL DEFAULT 0
  )
  ```

  It sits in `datastore.ts` beside the other `CREATE TABLE` statements. `deleteTag()` upserts a
  row for the deleted tag's name, with `deletedAt = Date.now()` and `pushedAt = 0`.
- The duplicate-merge delete in `datastore.ts` (the `DELETE FROM tags WHERE id = ?` on `dupeId`,
  in the duplicate-tag clean-up) does **not** write a tombstone, because the name survives on the
  kept row.
- **Creating a tag with a tombstoned name removes its tombstone.** A user re-creating the tag
  means it. Put the removal in the function that inserts new tags (the one `addTagToItem` and the
  tag-create paths call). Find it with `grep -n "INSERT INTO tags" apps/desktop/main/datastore.ts`.
- **Server:**
  - Add `deletedAt INTEGER NOT NULL DEFAULT 0` to `tags`. Add it in `initializeSchema()` with the
    same add-missing-column pattern used for other late columns there.
  - `saveTags()` accepts rows carrying `deletedAt`. When an incoming `deletedAt` is newer than
    both the stored `updatedAt` and the stored `deletedAt`:
    - set `deletedAt`, and set `updatedAt` to the same value, so `getTagsSince()` returns it;
    - delete that tag's `item_tags` rows.
  - An incoming non-tombstone row with `updatedAt` newer than the stored `deletedAt` clears
    `deletedAt` back to 0.
  - `getOrCreateTagWithConn()` clears `deletedAt` when an item push re-uses the name. A device
    that still tags items with it is re-creating it.
  - `getTagsSince()` returns `deletedAt`. Every other server read of tags filters
    `deletedAt = 0`: `GET /tags`, the tag list in `mcp-items.js`, and any tag join in `db.js`.
    Find them with `grep -n "FROM tags" apps/server/db.js apps/server/mcp-items.js`.
- **Desktop sync:**
  - `pushTagsToServer()` also sends unpushed tombstones, as `{ name, deletedAt }` rows in the same
    request body. It stamps `pushedAt` on success.
  - `mergeServerTag()` handles a row with `deletedAt > 0` as follows:
    - It hard-deletes the local tag of that name, through the same statements `deleteTag()` uses,
      when the local tag's `updatedAt` is older than the incoming `deletedAt`.
    - It writes the tombstone locally with `pushedAt` set, so it is not pushed straight back.
    - It publishes `tag:deleted`, as `deleteTag()` does.
- **Phone:** the phone sends tags only inside item bodies. A phone that still tags an item with a
  deleted name re-creates the tag through `getOrCreateTagWithConn()`. That is consistent with the
  re-creation rule above, and it is recorded in the doc.

## Tests

- `apps/desktop/main/tag-tombstones.test.ts`:
  - `deleteTag()` writes one tombstone.
  - Re-creating the name removes it.
  - The duplicate merge writes none.
- `apps/server/test.js`:
  - A tombstone newer than the tag deletes it and its links, and `getTagsSince()` returns it with
    `deletedAt`.
  - An older tombstone is ignored.
  - `GET /tags` omits deleted tags.
  - An item push using the name revives the tag.
- `apps/desktop/main/sync.test.ts`, with the same fake server as the tag tests:
  - A local delete is pushed once.
  - A pulled tombstone removes the local tag and its item links, and is not re-pushed.
  - A pulled tombstone older than a local edit is ignored.

## Docs

Rewrite the deletion bullet in `docs/sync-coverage-gaps.md` section 3 to describe tombstones and
the phone caveat. Leave the rename bullet as it is.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
yarn server:test
yarn test:sync
```

Done when every command exits 0 with `fail 0` in each tally. Record each tally under
`**Result**` in the handoff.

## Working rules

- `apps/desktop/CLAUDE.md` and `apps/server/CLAUDE.md` govern. Read both before editing.
- Change only the files in `touches`.
- Do not bump `DATASTORE_VERSION`.
- Never add `yarn.lock` under `apps/server/`.
- Do not deploy the server.
- Run one command per Bash call.
