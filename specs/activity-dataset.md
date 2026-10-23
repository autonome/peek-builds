---
enabled: true
touches: [tools/activity-dataset/**]
depends-on: []
---

# A reproducible dataset and use-case report built from activity history

Grouping, similarity and interest work so far has been one-off scripts kept outside the repo
(`docs/design/background-grouping.md`, "First step: result"). Each rerun starts from scratch, and
nothing scores one approach against another. This spec adds `tools/activity-dataset/`: one
offline tool that turns a datastore snapshot into normalized tables and a scored report covering
many use cases at once, so a new signal or grouper is a function added and a number compared.

## Shape

- `tools/activity-dataset/core/` — pure ES modules, **no I/O, no `node:` imports**. Every
  function takes plain arrays of row objects and returns plain data. This is the part that later
  runs as a server worker (`docs/worker-runtime-portability.md`, section 4.1 `WorkerEntry`), so it
  must not touch files, env or the network.
- `tools/activity-dataset/load-snapshot.mjs` — `loadSnapshot(path)` opens the file with
  `new DatabaseSync(path, { readOnly: true })` from `node:sqlite` and returns
  `{ items, events, tags, itemTags, visits }` as arrays. It works on both a desktop
  `datastore.sqlite` and a server snapshot: a missing table (`item_visits` is absent on the server
  today) yields `[]`, and missing columns are read as `undefined`. Treat `deletedAt` of `0`,
  `null` or `''` as not deleted.
- `tools/activity-dataset/run.mjs` — CLI. Reads the snapshot path from `ACTIVITY_SNAPSHOT` and the
  output directory from `ACTIVITY_OUT`; exits 2 with a one-line message if either is unset.
  Refuses to write when `ACTIVITY_OUT` resolves inside the git repo (compare against
  `git rev-parse --show-toplevel`), because outputs contain personal data. Writes the tables as
  JSON Lines and `report.md` + `report.json` into `ACTIVITY_OUT`.
- `tools/activity-dataset/README.md` — what each table and report section means, how to run it,
  and the rule that outputs and snapshots never enter the repo.
- Tests: `tools/activity-dataset/*.test.mjs`, run with `node --test`. Fixtures are built in the
  test from literal synthetic rows (invented sites such as `example.test`), never from a real
  snapshot. One test builds a temporary sqlite file in `os.tmpdir()` and runs `loadSnapshot()` on
  it.

## Normalized tables (`core/normalize.js`)

- `pages` — one row per non-deleted `url` item: `id`, `url`, `host` (lowercased, `www.`
  stripped), `title` (empty when the title is only a URL or equals the host), `text` (title +
  `metadata._og.description` + `metadata.selectedText`, joined), `visitCount`, `lastVisitAt`,
  `createdAt`, `topicalTags` (see labels). Drop sign-in, OAuth and redirect pages: path or host
  matching `login|signin|sign-in|oauth|authorize|auth/|sso|redirect|callback`. Export the pattern
  as `AUTH_PAGE_RE` so tests can cover it.
- `entities` — one row per non-deleted `entity` item with a clean name: `id`, `name`, `type`
  (`metadata.entityType`). `cleanEntityName()` returns `null` (entity dropped) for names
  containing a newline or tab, names under 3 letters, names where more than half the
  whitespace-separated tokens are 1–2 letters (catches calendar headers like `Su Mo Tu`), and
  names that are only weekday or month abbreviations.
- `sightings` — one row per `item_events` row whose item is a kept entity and whose `content`
  starts with `http`: `entityId`, `url`, `pageId` (the page whose `url` matches, else `null`),
  `occurredAt`, `confidence` (`value`).
- `sessions` — from `visits` when present: visits sorted by `timestamp`, split where the gap
  exceeds 30 minutes (`SESSION_GAP_MS`). Each row: `id` (first visit id), `start`, `end`,
  `pageIds`, `totalDurationMs`. Empty when there are no visits.
- `labels` — weak labels for scoring:
  - `topical` — tags on pages and notes that are not machine tags. Machine tags have a prefix
    such as `peek:`, `entity:` or `from:`, or are one of `todo`, `done`, `today`, `note`,
    `readme`. Export them as `MACHINE_TAG_RE` and `MACHINE_TAGS`.
  - `feedback` — entity accept/reject state from entity item metadata where present.

## Use-case probes (`core/probes/*.js`, one file each)

Each probe exports `run(tables, options) → { name, summary, rows, score? }`. `summary` holds only
counts and ratios. `rows` may hold titles and names, and goes into the output files only, never
into anything committed.

1. `entity-groups` — page groups from shared entities. Weight each entity by inverse page
   frequency, `log(nPages / pagesWithEntity)`. Drop entities seen on more than
   `HUB_FRACTION = 0.05` of pages, which damps inbox, calendar and other hub pages. Two pages link
   when the summed weight of their shared entities is at least `minLinkWeight` (default 2.0).
   Group with union-find, and keep groups of 3 or more pages. Name each group from the most
   frequent title words (stopwords removed), never from URL fragments.
2. `text-similarity` — TF-IDF cosine over `pages.text`, built in plain JS without dependencies.
   For each page, list its top 5 neighbours above 0.2.
3. `session-groups` — pages co-occurring in sessions, with each co-occurrence weighted by
   `log(1 + durationMs/1000)`. Skipped with `summary.skipped = 'no visits'` when `sessions` is
   empty.
4. `combined-groups` — the same union-find over the edge-weight sum of probes 1–3, each
   normalized to [0,1].
5. `interests` — entities ranked by distinct days seen, with `weeks` (distinct ISO weeks), `first`
   and `last`. Mark `durable` when weeks ≥ 4.
6. `bursts` — entities whose sightings in the last 30 days of data cover 3 or more pages, ranked
   by pages. "Now" is the latest `occurredAt` in the data, never the wall clock, so runs
   reproduce.
7. `forgotten-saves` — pages with `visitCount ≤ 1` that were shared or had text selected
   (`metadata.sharedAt` or `metadata.selectedText`).
8. `notes-to-pages` — text items whose content names a kept entity of type place, organization,
   creative_work, event or person (case-insensitive whole-word match), linked to that entity's
   pages.
9. `habits` — hosts ranked by summed `visitCount`, with page count.

**Scores** use topical tags as weak labels. Only pages that carry one are scored.

- Each grouping probe (1, 3, 4) reports:
  - `purity`: for each group, the share of its labelled pages that carry the group's majority
    tag, averaged with weights by group size.
  - `coverage`: grouped pages ÷ all pages.
  - `groups`: the group count.
- `text-similarity` reports `precisionAt5`: the share of a labelled page's neighbours that share
  one of its topical tags, averaged over labelled pages.
- Probes without labels report counts only.

`report.md` lists every probe, its summary and score in one table, then the top rows of each
probe. `report.json` holds the same data, so two runs can be diffed.

## Tests (each in `tools/activity-dataset/`)

- `normalize.test.mjs`:
  - `AUTH_PAGE_RE` drops login and OAuth URLs.
  - A title that is only a URL becomes empty.
  - `cleanEntityName()` rejects `"Su Mo Tu"`, `"Su\nMo"` and `"Jan"`, and keeps `"Lisbon"`.
  - Sessions split at a 31-minute gap and not at a 29-minute one.
  - Deleted rows are excluded under each of the three `deletedAt` forms.
- `probes.test.mjs`, on one synthetic fixture with two topics plus a hub entity seen on every
  page:
  - `entity-groups` does not merge the topics through the hub entity, and has purity 1.0.
  - `text-similarity` neighbours stay within a topic.
  - `bursts` uses the data's latest time.
  - `session-groups` is skipped with no visits.
  - `notes-to-pages` links a note naming a place to that place's pages.
- `load-snapshot.test.mjs`:
  - It builds a temp sqlite file with only `items`, `item_events`, `tags` and `item_tags`, and
    checks that `visits` comes back as `[]`.
  - It confirms the database is opened read-only: a write through the same handle throws.
- `run.test.mjs`:
  - With `ACTIVITY_OUT` unset, the CLI exits 2.
  - With `ACTIVITY_OUT` inside the repo, it refuses.
  - With a temp out dir and the fixture snapshot, it writes `report.json` with one entry per
    probe.

## Verify

```
node --test tools/activity-dataset/
```

Done when it exits 0 with `fail 0`. Record the tally under `**Result**` in the handoff.

## Working rules

- Change only files under `tools/activity-dataset/`. Add no npm dependencies.
- Never read, copy or commit a real snapshot or its outputs. Tests use synthetic rows only.
- Run one command per Bash call.
