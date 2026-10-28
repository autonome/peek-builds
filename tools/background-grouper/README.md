# background-grouper

Read-only offline tool that groups the last two weeks of web pages from a profile's
`datastore.sqlite` and writes a report of proposed groups with their top signals. Design, data
findings and the reasoning behind the signals: `docs/design/background-grouping.md`.

## Run

Copy the database first (stop the app, or copy a backup from `yarn profile:backup:datastore`):

```bash
cp "<profile dir>/datastore.sqlite" "$TMPDIR/datastore-copy.sqlite"
node tools/background-grouper/cli.mjs "$TMPDIR/datastore-copy.sqlite" "$TMPDIR/groups-report.md" [--days 14] [--cutoff 0.20] [--no-embed] [--model-cache DIR]
```

The database copy and the report hold real browsing data. The tool refuses an input or output
path inside this repository; keep both in a temp directory and delete them afterwards. The
database is opened read-only, but never point it at the live profile.

Needs Node 22.5 or newer (`node:sqlite`). Install the tool's own dependency once with
`npm install` inside `tools/background-grouper/` (it is not a yarn workspace).

The text-similarity signal embeds each page's title and site with `Xenova/all-MiniLM-L6-v2`. The
first run downloads the model (about 90 MB) into `$XDG_CACHE_HOME/background-grouper/models`
(default `~/.cache/...`); `--model-cache <dir>` picks another directory, which must be outside
the repository. `--no-embed` skips the signal: no download, no install needed, and the earlier
weights apply. The report header says whether the signal was on and which model.

## What it does

- Pages: `items` of type `url` with an http(s) address and `deletedAt` of 0, visited in the window.
- Dropped before grouping: sign-in, OAuth and redirect pages; a title that is only a URL counts as
  no title.
- Sessions: visits cut at a 30 minute idle gap. A visit counts by dwell time and interaction, not
  presence alone.
- Pair score: weighted sum of title similarity, same site / path prefix, session co-occurrence,
  consecutive visits, shared entities (entities seen on many pages are dropped) and shared tags
  (`space:` and `from:` tags excluded), and embedding similarity of title plus site. Weights are hand-set in `grouper.mjs` `WEIGHTS`.
- Groups: average-linkage clustering, cut at the cutoff, then kept only with at least 3 pages and
  2 sessions. Named from title words only.

## Test

```bash
node --test 'tools/background-grouper/*.test.mjs'
```

The tests build a small synthetic database; they use no real data.
