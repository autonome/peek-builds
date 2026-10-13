---
enabled: true
touches: [docs/**, README.md, DEVELOPMENT.md, CLAUDE.md, apps/**/CLAUDE.md]
depends-on: [docs-features-rewrite]
---

# Sort docs/ into current reference and history, with an index

Peek item `8fe5f28e`, second half (after `specs/docs-features-rewrite.md`). `docs/` holds about
fifty files; reference material sits next to finished migration plans, investigations and
research spikes, and nothing tells a newcomer which is which.

## Decisions

- Historical docs move to `docs/historical/`, chosen over `docs/archive/` because the repo
  already has an unrelated top-level `archive/`.
- Nothing is deleted. Moves use `git mv` so history follows.
- `docs/feed.xml` and `docs/perf/` are not prose; skip them. `docs/tasks.md` (a one-line
  pointer at the Peek queue) folds into the new index and is moved to `docs/historical/`.
- `docs/features.md` is already handled by the previous spec; leave it.

## What changes

For each file in `docs/` (subdirectories included, except those skipped above), decide one of:

1. **Current reference**: someone building on or contributing to Peek should read it. Check
   every file path and code symbol it names still exists (`test -e`, `grep`), and fix what has
   drifted. Do not rewrite prose beyond what drift requires.
2. **Mixed**: mostly current with a historical tail. Move the historical part to the bottom
   under "## History" so it no longer reads as guidance; fix drift in the current part as in 1.
3. **Historical**: the whole doc records finished work (a migration plan, an investigation, a
   research spike, an audit). `git mv` it to `docs/historical/` unchanged except for a one-line
   note at the top: "Historical: <what it records>; not current guidance."

Filenames suggest but do not decide the bucket; read each doc. Likely historical, to verify:
`v1-removal-*`, `core-extraction-plan.md`, `click-through-investigation.md`,
`navbar-hide-flash-analysis.md`, `cmd-space-switching-analysis.md`, `macos-spaces-analysis.md`,
`overnight-audit.md`, `command-audit.md`, `tile-preload-trimming-*`, `sync-source-refactor.md`,
`window-placement-refactor.md`, `*-research.md`, `atproto-relay-indexer-design.md`,
`atproto-signature-verification-plan.md`, `editor-remaining-work.md`. The state-machine docs
(`cmd-state-machine.md`, `pubsub-state-machine.md`, `tile-lifecycle-fsm.md`,
`page-host-state-machine.md`), `cmd-palette-spec.md` and `feature-tour.md` are likely current or
mixed. `docs/design/` holds design proposals; a proposal that shipped and is described
elsewhere is historical, one still under review (`docs/design/tile-protocols.md`) or still the
governing description (`docs/design/window-manager.md`, `docs/design/window-rules.md`) stays.

After sorting, fix links: any link in `docs/`, the root `README.md`, `DEVELOPMENT.md`,
`CLAUDE.md` files or `apps/**/CLAUDE.md` that points at a moved doc is updated to its new path.
Change nothing else in those files.

Write `docs/README.md`: where to start (`docs/features.md`, then the architecture and API
references), the current reference docs grouped by topic with one line each, and a line saying
`docs/historical/` holds records of finished work that are kept for their reasoning and are not
current guidance.

## Verify

```
test -f docs/README.md
git diff --diff-filter=D --name-only main -- docs
git diff -M --name-status main -- docs
```

The first succeeds; the second prints nothing; the third lists each moved doc as an `R` entry.
Every relative link in `docs/**/*.md` and in `docs/README.md` resolves to an existing file
(check with a small script in the scratch directory, not committed). Under `**Result**` in the
handoff, record a table of every file with its bucket and a few words of reason, plus the link
check's output. The repo gate in `tracks.json` must still pass.

## Working rules

Docs only; edit no code. Run one command per Bash call.
