# activity-dataset

Turns a datastore snapshot into normalized tables and a scored report covering several use cases at
once, so a new signal or grouper is a function added and a number compared.

## Run

```
ACTIVITY_SNAPSHOT=<path to datastore.sqlite or server snapshot> \
ACTIVITY_OUT=<output directory outside the repo> \
node tools/activity-dataset/run.mjs
```

- Exits 2 if either variable is unset.
- Refuses to write when `ACTIVITY_OUT` resolves inside the git repo.
- The snapshot is opened read-only. A missing table (`item_visits` on the server) reads as empty.
- Needs Node with `node:sqlite` (22.5+).

## Never commit outputs or snapshots

Snapshots and everything written to `ACTIVITY_OUT` contain personal data (URLs, titles, names). They
stay out of the repo; tests use invented rows only (`fixture.mjs`).

## Layout

- `core/` — pure modules, no I/O and no `node:` imports, so it can later run as a server worker.
  - `normalize.js` builds the tables below.
  - `probes/*.js`, one per use case; each exports `run(tables, options) → { name, summary, rows, score? }`.
  - `graph.js` holds shared grouping, naming and scoring code; `index.js` runs all probes and renders the report.
- `load-snapshot.mjs` — `loadSnapshot(path)` → `{ items, events, tags, itemTags, visits }`.
- `run.mjs` — the CLI.

## Tables (`*.jsonl` in the output directory)

- `pages` — live `url` items minus sign-in, OAuth and redirect pages. Has `host`, a `title` that is empty
  when it only repeats the URL or host, `text` (title + description + selected text), `visitCount`,
  `topicalTags`, plus `sharedAt` and `selectedText` for the forgotten-saves probe.
- `entities` — live `entity` items with a clean name (no newlines, no calendar headers, no month or weekday
  abbreviations).
- `sightings` — entity events whose content is a URL, linked to a page when the URL matches.
- `sessions` — visits split where the gap exceeds 30 minutes; empty without visits.
- `notes` — live `text` items; read by `notes-to-pages`.
- `labels` — `topical` (non-machine tags on pages and notes, the weak labels for scoring) and `feedback`
  (entity accepted/rejected state where present). Written as `labels.jsonl` with a `kind` field.

## Report

`report.md` has one table with every probe's summary and score, then the top rows of each probe.
`report.json` holds the same data for diffing two runs. Summaries hold counts and ratios only; `rows`
may hold titles and names.

| probe | what it answers |
| --- | --- |
| `entity-groups` | pages grouped by shared entities, weighted by inverse page frequency; entities on over 5% of pages are dropped as hubs |
| `text-similarity` | TF-IDF cosine nearest neighbours (top 5 above 0.2) |
| `session-groups` | pages that co-occur in sessions, weighted by session duration; skipped without visits |
| `combined-groups` | the three above, each scaled to [0,1] and summed |
| `interests` | entities by distinct days seen, with distinct ISO weeks; durable at 4+ weeks |
| `bursts` | entities on 3+ pages in the last 30 days of data (measured from the latest sighting) |
| `forgotten-saves` | pages visited at most once that were shared or had text selected |
| `notes-to-pages` | notes naming a kept entity, linked to that entity's pages |
| `habits` | hosts by summed visit count |

Scores use topical tags as weak labels and only count pages that carry one:

- `purity` — per group, the share of labelled pages carrying the majority tag, averaged weighted by group size.
- `coverage` — grouped pages ÷ all pages.
- `groups` — group count.
- `precisionAt5` — share of a labelled page's neighbours sharing one of its tags, averaged over labelled
  pages that have neighbours (`labelledScored` in the summary).

## Test

```
node --test tools/activity-dataset/
```

`index.js` exists only so this directory form works on Node 24; `node --test tools/activity-dataset/*.test.mjs`
runs the same tests.
