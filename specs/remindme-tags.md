---
enabled: true
touches: [apps/desktop/features/reminders/, apps/desktop/tests/unit/reminders-remind.test.js, apps/desktop/tests/desktop/reminders-due.spec.ts]
depends-on: [peeklet-schedule-wake]
---

# A `remind:<duration>` tag brings an item back when it comes due

Peek item `19da7046` (remindme), a peeklet under `28914048`. Tagging an item `remind:3d` asks for
it back in three days. When that time has passed, the tag becomes `remind:due`, and a `reminders`
command lists every due item.

Decisions:

- A due reminder surfaces through a tag and a list command, not a notification. Notifications
  (Peek `dc85246d`) are unbuilt. A later slice can add one on top of the same due check.
- Tag shape: `remind:<n><unit>` with a whole number `n` ≥ 1 and unit `m` (minutes), `h`
  (hours), `d` (days) or `w` (weeks), one unit only (`remind:90m`, `remind:3d`). The prefix
  follows the `space:` convention in `features/spaces/config.js SPACE_TAG_PREFIX`. A `remind:`
  tag that does not parse, other than `remind:due`, is left alone and never comes due.
- The clock starts when the reminders feature first sees the tag, not when the tag was added.
  Tiles cannot read `item_tags.createdAt`, and a tag synced from another device was not added on
  this one. A check runs every 5 minutes, so a reminder is at most about 5 minutes late while
  the app is open. A reminder that came due while the app was closed is marked at the boot
  check, the run-once-at-boot behaviour of `peeklet-schedule-wake`.
- The due time is stored on the item as `metadata.reminder = { tag, dueAt }`. A different
  `remind:` tag on the same item replaces it and restarts the clock. Removing the `remind:` tag
  makes the next check drop `metadata.reminder`.
- When a reminder comes due, the item loses its `remind:<duration>` tag, gains `remind:due`, and
  keeps `metadata.reminder` so `dueAt` stays visible. To dismiss it, remove `remind:due`. The
  next check then clears `metadata.reminder`.
- `reminders` opens the search window on the query `#remind:due`, through the same
  `cmd:execute:search` publish the search feature's own command handles. It does not build a
  new list UI.

## What the code does now

- `features/tag-actions/background.js runTagSwap()` swaps one tag for another with
  `api.datastore.getOrCreateTag`, `untagItem` and `tagItem`. Its manifest shows a lazy background
  tile woken by a `lazyEvents` topic, with `datastore: { tables: ["items", "tags", "item_tags"] }`.
- `tile-preload.cts` gives tiles `api.datastore.getAllItemTags()` (a map of itemId to tags),
  `getItem`, and `updateItem`.
- `features/search/background.js` answers `cmd:execute:search` with `data.query` by opening the
  search window on that query, and `search/home.js parseQuery()` reads `#<tag>` tokens as tag
  filters, including tags that contain `:`.
- `features/timers/background.js parseDuration()` parses timer durations but has no days or
  weeks, and is module-private. Reminders gets its own parser.
- After `peeklet-schedule-wake` lands, a tile entry can declare
  `"schedule": [{ "topic", "everyMinutes" }]`, and main wakes the tile with that publish.

## What changes

- New feature `features/reminders/` (`manifest.json`, `background.html`, `background.js`,
  `remind.js`), with `"builtin": true` like `tag-actions`. Built-in features are found by
  scanning `features/`, so no registry changes.
  - Manifest: one lazy background tile with `"schedule": [{ "topic": "reminders:check",
    "everyMinutes": 5 }]`, the command `reminders`, and pubsub topics `reminders:check`,
    `cmd:execute:search`, plus the usual `ext:ready` and `app:shutdown`. Datastore tables are
    `items`, `tags` and `item_tags`.
  - `remind.js`, pure, with no `api`, window or DOM (job logic stays portable):
    `parseRemindTag(name)` returns `{ ms }`, `{ due: true }` or `null`.
    `planReminders(itemTags, itemsById, now)` takes the tags per item, each item's current
    `metadata.reminder`, and the time, and returns a list of actions:
    `{ itemId, kind: 'start', reminder }`, `{ itemId, kind: 'due', fromTag }` and
    `{ itemId, kind: 'clear' }`. Every case in Decisions is decided here.
  - `background.js`: subscribes to `reminders:check` and registers the `reminders` command
    synchronously in `init()`, before any `await` (`apps/desktop/CLAUDE.md`, lazy tile
    init-order rule). On each check it reads `getAllItemTags()`, fetches only the items that
    carry a `remind:` tag or a `metadata.reminder`, runs `planReminders`, and applies each
    action: `updateItem` for metadata, and the tag swap the way `runTagSwap()` does it. The
    item set for `clear` comes from a `queryItems` filter on `metadata.reminder` if that filter
    exists. Otherwise it comes from a list of reminded item ids kept in the feature's settings.
    The implementer picks one and notes it in the handoff.
  - The `reminders` command publishes `cmd:execute:search` with `{ query: '#remind:due' }`.

## Tests to change

New `tests/unit/reminders-remind.test.js` (import pattern as in `name-validator.test.js`):

- `parseRemindTag`: each unit, a multi-digit number, `remind:due`, and nulls for `remind:`,
  `remind:0d`, `remind:3x`, `remind:1h30m` and a tag without the prefix.
- `planReminders`: a new tag starts a reminder with `dueAt = now + duration`. One not yet due
  produces no action. One past due produces `due` exactly once. A changed duration tag restarts
  the clock. A removed tag clears. `remind:due` alone with `metadata.reminder` produces nothing,
  and once it is removed the item clears. An unparseable tag produces nothing.

New `tests/desktop/reminders-due.spec.ts`, on a test profile: tag a URL item `remind:1m`, publish
`reminders:check`, and confirm `metadata.reminder.dueAt` is about one minute ahead. Set `dueAt` in
the past through the datastore, publish `reminders:check` again, and confirm the item now carries
`remind:due` and not `remind:1m`. Run the `reminders` command and confirm a search window opens
with `#remind:due` and lists the item.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
yarn workspace @peek/desktop test:grep "reminders|tag-actions|search|feeds-schedule"
```

Done when the unit tallies report `fail 0`, the new tests pass, and the other collected specs
show no new failure compared with `apps/desktop/tests/gate-baseline.md`. Record the `test:grep`
pass/fail count under `**Result**` in the handoff.

## Working rules

`apps/desktop/CLAUDE.md` governs the desktop app. Read it before editing. Job logic stays free of
window and DOM calls so a peeklet can later run off the desktop. Run one command per Bash call.
