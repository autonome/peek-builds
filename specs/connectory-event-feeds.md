---
enabled: true
touches: [apps/desktop/features/connectory/, apps/desktop/tests/unit/connectory-events.test.js, apps/desktop/tests/unit/fixtures/connectory/, apps/desktop/tests/desktop/connectory-events.spec.ts]
depends-on: []
---

# Connectory follows organizers' event feeds and saves new events as `event:new` items

Peek item `2a8bcc3f` (Connectory), a peeklet under `28914048`. An item tagged `event:source`
whose URL is an organizer's iCal calendar or RSS/Atom feed is checked on a schedule. Each event
not seen before becomes an item tagged `event:new`, and an `events` command lists them.

Decisions:

- Sources are iCal (`.ics`) and RSS/Atom only. Scraping an organizer's events page is Peek
  `84c87c82`. Finding sources automatically (publisher, promoter, affiliated organisations) is a
  later slice; in this one a source is any URL item the account holder tags `event:source`.
- The kind of source is read from the response body, not the URL: a body starting (after
  whitespace) with `BEGIN:VCALENDAR` is iCal, anything else goes to the RSS/Atom parser, and a
  body neither parser accepts marks the source `metadata.connectory = { error, checkedAt }` and
  produces no events.
- An iCal `VEVENT` is an event. Every entry of an RSS/Atom source is an event too: a feed tagged
  `event:source` is by that tag an organizer's event feed. A feed entry carries no event date, so
  its `startDate` is absent and only `publishedAt` is kept.
- A new event is saved as a URL item when it has a link (iCal `URL`, feed entry link) and as a
  text item titled with its summary otherwise. It is tagged `event:new` and carries
  `metadata.event = { uid, sourceItemId, title, startDate?, endDate?, location?, publishedAt? }`.
  `startDate`, `endDate` and `location` use the attribute names that
  `features/entities/extractors/structured-data.js` gives `event` entities, so a later "what's on
  today" view (Peek `4e8a9ff2`) reads both kinds with one shape. Dates are ISO 8601 strings; an
  iCal all-day `DTSTART;VALUE=DATE` stays a date with no time.
- An event's identity is its iCal `UID`, else the feed entry's `guid`/`id`, else its link, else
  its title plus `startDate`. The identities already saved are kept per source in the feature's
  settings (`seen: { [sourceItemId]: uid[] }`, newest 500 per source), so removing `event:new`
  dismisses an event for good and deleting the event item does not bring it back.
- Past iCal events (an `endDate`, or else a `startDate`, before the check time) are not saved.
  A recurring iCal event (`RRULE`) is saved once, as its first occurrence still to come; expanding
  recurrences is out of scope.
- No notification: surfacing is the tag plus the command, as in `specs/remindme-tags.md`.
- `events` opens the search window on `#event:new` through the `cmd:execute:search` publish, as
  the `reminders` command does.

## What the code does now

- `features/reminders/` is the model: a lazy built-in background tile with a manifest
  `schedule`, a command, a pure module (`remind.js`) holding every decision, and `background.js`
  applying its planned actions through `api.datastore`.
- `features/feeds/background.js parseFeed()`, `parseRSS()` and `parseAtom()` parse RSS/Atom with
  `DOMParser`. They are module-private; Connectory gets its own parsing rather than reaching into
  another feature.
- `features/feeds/manifest.json` shows the `network: { domains: ["*"] }` capability a tile needs
  to `fetch` an arbitrary URL.
- No iCal parsing exists in the app.

## What changes

New built-in feature `features/connectory/` (`manifest.json`, `background.html`,
`background.js`, `events.js`, `settings-schema.json`), laid out like `features/reminders/`.

- Manifest: one lazy background tile with `"schedule": [{ "topic": "connectory:check",
  "everyMinutes": 60 }]`, the command `events`, pubsub topics `connectory:check`,
  `cmd:execute:search`, `ext:ready` and `app:shutdown`, datastore tables `items`, `tags` and
  `item_tags`, and `network: { domains: ["*"] }`.
- `events.js`, pure (no `api`, window or DOM):
  - `parseICal(text)` returns the `VEVENT`s as `{ uid, title, startDate, endDate, location, url,
    rrule }`, handling line unfolding, `TZID`/`Z`/date-only `DTSTART`, and escaped text
    (`\,`, `\;`, `\n`).
  - `eventsFromFeedEntries(entries)` maps already-parsed feed entries (`{ id, title, link,
    published }`) to the same event shape.
  - `planNewEvents(sourceItemId, events, seenUids, now)` applies the identity, past-event and
    recurrence rules above and returns `{ toSave: event[], seen: uid[] }`.
- `background.js` registers `connectory:check` and `events` synchronously in `init()`, before any
  `await` (`apps/desktop/CLAUDE.md`, lazy tile init-order rule). Each check reads the items tagged
  `event:source`, fetches each URL, parses (iCal through `parseICal`; RSS/Atom through
  `DOMParser` in `background.js`, reduced to plain entries before `eventsFromFeedEntries`), runs
  `planNewEvents`, saves and tags each event, and writes the updated `seen` lists. One source
  failing (network error, bad body) records its error and does not stop the others.

## Tests to change

New `tests/unit/connectory-events.test.js` (import pattern as in
`tests/unit/reminders-remind.test.js`) with iCal fixtures under
`tests/unit/fixtures/connectory/`:

- `parseICal`: folded lines, a `TZID` start, a UTC start, an all-day event, escaped commas and
  newlines in `SUMMARY`/`LOCATION`, a calendar with no events, and a `VTODO` that is ignored.
- `eventsFromFeedEntries`: an entry with a guid, one with only a link, one with neither.
- `planNewEvents`: a new event is saved; a seen one is not; a past one is not; a recurring one is
  saved once; identity falls back in the order given in Decisions; the seen list keeps the newest
  500.

New `tests/desktop/connectory-events.spec.ts`, on a test profile: serve an `.ics` fixture and an
Atom fixture from a local HTTP server started by the spec, save each URL as an item tagged
`event:source`, publish `connectory:check`, and confirm one `event:new` item per future event with
`metadata.event` filled. Remove `event:new` from one, publish `connectory:check` again, and confirm
it is not re-added and no duplicates appear. Run `events` and confirm a search window opens on
`#event:new` listing the remaining events.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
yarn workspace @peek/desktop test:grep "connectory|reminders|search|feeds-schedule"
```

Done when the unit tallies report `fail 0`, the new tests pass, and the other collected specs
show no new failure compared with `apps/desktop/tests/gate-baseline.md`. Record the `test:grep`
pass/fail count under `**Result**` in the handoff.

## Working rules

`apps/desktop/CLAUDE.md` governs the desktop app. Read it before editing. Job logic stays free of
window and DOM calls so a peeklet can later run off the desktop. Tests never reach the network
beyond the spec's own local server. Run one command per Bash call.
