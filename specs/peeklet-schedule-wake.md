---
enabled: true
touches: [apps/desktop/main/tile-schedule.ts, apps/desktop/main/tile-schedule.test.ts, apps/desktop/main/tile-lazy.ts, apps/desktop/main/tile-arm.ts, apps/desktop/main/datastore.ts, apps/desktop/main/main.ts, packages/capabilities/index.js, packages/capabilities/index.d.ts, apps/desktop/features/feeds/manifest.json, apps/desktop/features/feeds/background.js, apps/desktop/tests/desktop/feeds-schedule-wake.spec.ts, apps/desktop/tests/unit/*.test.js, README.md]
depends-on: []
---

# A sleeping feature wakes on a schedule declared in its manifest

Peek item `28914048` (peeklets), first slice. A peeklet is an ordinary feature that runs
unattended; its first trigger is a schedule. Nothing wakes a sleeping feature on a timer today, so
this spec adds one and moves `feeds` onto it as the first user.

Decisions:

- A schedule entry names a pubsub topic and an interval in whole minutes, minimum 1. When it comes
  due, main publishes the topic, and the existing load-on-dispatch hook wakes the owning tile if
  it is asleep, the same path a `lazyEvents` topic takes. A tile already awake just receives the
  publish.
- A run missed while the app was closed runs **once** at boot, never once per missed interval. A
  feature that asked to run every N minutes expects to run soon after the app starts when N
  minutes have passed, and a later reminder feature needs exactly that. A schedule that has never
  fired counts as due.
- The last time each schedule fired is persisted per profile, so restarts do not reset the clock.
- The timers live in main, never in a tile, so a feature stays asleep until its schedule is due.
  Once woken a tile stays loaded for the session, as every lazy tile does now; putting it back to
  sleep is out of scope.
- The schedule is fixed by the manifest. `feeds`' `pollInterval` setting
  (`features/feeds/settings-schema.json`) is already ignored by its code (`POLL_INTERVAL_MS` is a
  constant) and stays unwired here. A settings-driven interval is a later slice.

## What the code does now

- `main/tile-lazy.ts registerLazyTile()` adds each tile entry's `lazyEvents` topics to the
  predicate set the pre-publish hook (`installLoadOnDispatchHook`, `handleLazyEventDispatch`)
  matches; `unregisterLazyTile()` drops them. `findTileByLazyEventTopic()` maps a topic to its
  owner, and `ensureTileLoaded()` boots the tile and waits for ready.
- `main/tile-arm.ts` routes a manifest through `registerLazyTile` only when it has no resident
  entry and has commands or `lazyEvents` (the predicate under its "Whether a manifest is a lazy
  tile" comment).
- `packages/capabilities/index.js validateTileManifest()` validates `lazyEvents` per tile entry;
  `index.d.ts` types the tile entry (`lazy`, `lazyEvents`, `resident`).
- `main/datastore.ts` keeps lazy-wake state in `lazy_wake_shortcuts` and `lazy_wake_declared`.
  There is no table for schedule runs.
- `features/feeds/background.js init()` starts `setInterval(pollAllFeeds, POLL_INTERVAL_MS)` and a
  5 s first poll, but its background tile is lazy and wakes only on its commands, so feeds poll
  only after the user runs a feeds command in that session.

## What changes

- Manifest: a tile entry may declare `"schedule": [{ "topic": "<topic>", "everyMinutes": <n> }]`.
  `validateTileManifest` rejects a non-array, an empty or non-string topic, and an `everyMinutes`
  that is not an integer ≥ 1, with the same error shape as the `lazyEvents` checks.
  `index.d.ts` gains the field with a doc comment.
- `tile-arm.ts`: a manifest with a schedule and no resident entry counts as lazy, like one with
  `lazyEvents`.
- `tile-lazy.ts`: schedule topics join the predicate set and the owner lookup alongside
  `lazyEvents` topics, on register and unregister.
- New `main/tile-schedule.ts`: arms one timer per schedule entry when its tile is registered and
  clears it when the tile is unregistered (disabling a feature stops its schedule). On arming it
  reads the entry's last-fired time; if the entry has never fired or an interval has passed, it
  fires once after boot finishes registering tiles, then every interval. Firing publishes the
  topic with `{ scheduledAt, lastRunAt }` from the system address and records the fire time.
  Clock and timers are injectable for unit tests, following the `__set…ForTest` pattern in
  `tile-lazy.ts`.
- `datastore.ts`: new table `tile_schedule_runs (ownerTileId TEXT, topic TEXT, lastRunAt INTEGER,
  PRIMARY KEY (ownerTileId, topic))`, created with the other `CREATE TABLE IF NOT EXISTS`
  statements.
- `features/feeds`: the background entry declares `"schedule": [{ "topic": "feeds:poll",
  "everyMinutes": 15 }]` and lists `feeds:poll` in its `pubsub.topics`. `background.js` drops
  the `setInterval` and the 5 s first poll, and subscribes to `feeds:poll` → `pollAllFeeds()`
  synchronously in `init()`, before any `await` (`apps/desktop/CLAUDE.md`, lazy tile init-order
  rule). `uninit()` no longer clears a timer.
- `README.md`: the line `"Peeklets" HUD — select parts of pages to add to a collection rendered
  as an overlay` describes an old meaning; replace it with one line saying a peeklet is a feature
  that runs unattended, woken on a schedule or an event.

## Tests to change

New `main/tile-schedule.test.ts` (fake clock and timers, fake launcher as in
`tile-lazy-events.test.ts`):

1. A schedule entry that has never fired publishes its topic once after arming, then once per
   interval.
2. An entry whose last run is more than one interval old fires exactly once at arming, however
   many intervals were missed; one whose last run is recent first fires when the remainder of the
   interval has passed.
3. Each fire records `lastRunAt`; a re-arm (simulated restart) reads it back.
4. Unregistering the tile clears its timers: no further publishes.
5. Publishing a schedule topic wakes the sleeping owning tile through the dispatch hook, and the
   tile's handler receives the message.

Manifest validation cases in the existing capabilities unit tests (find them under
`apps/desktop/tests/unit/` by `validateTileManifest`): a valid schedule passes; a missing topic, a
zero or fractional `everyMinutes`, and a non-array each fail with a path naming the field.

New `tests/desktop/feeds-schedule-wake.spec.ts`: on a fresh test profile, with no user action,
the feeds background tile becomes loaded within a few seconds of boot (the `feeds:poll` boot fire)
and a `tile_schedule_runs` row exists for `feeds` / `feeds:poll`.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
yarn workspace @peek/desktop test:grep "feeds|lazy-wake|lazy wake|lazyEvents|features-toggle"
```

Done when the unit tallies report `fail 0`, the new tests pass, and the other collected specs
show no new failure compared with `apps/desktop/tests/gate-baseline.md`. Record the `test:grep`
pass/fail count under `**Result**` in the handoff.

## Working rules

`apps/desktop/CLAUDE.md` governs the desktop app. Read it before editing. Job logic stays free of
window and DOM calls so a peeklet can later run off the desktop. Run one command per Bash call.
