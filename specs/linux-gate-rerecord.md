---
enabled: false
touches: [apps/desktop/tests/gate-baseline.md]
depends-on: []
---

# Attribute the Linux gate regression and re-record the Linux baseline

`yarn test:desktop:electron` on Linux used to fail a recorded set of about 33 desktop tests
(`apps/desktop/tests/gate-baseline.md`, recorded at `43cda804`). Two full gate runs on `main`
(heads `2f1b8c94` and `d270b962`) each failed 97 desktop tests in common: 13 are rows in that
baseline's Linux table and 84 are not. The new failures wipe out whole specs, so the gate no longer
tells a reviewer whether a change broke anything. This spec finds out where the 84 come from and
leaves a baseline that matches what `main` does today.

This spec records and attributes. It does not fix product code.

## First job: A/B attribution

Run the desktop runner on two trees, same box, same display wrapper, and compare failing sets (not
counts):

- the pre-kernel-desktops tree `43cda804` (the baseline's recording head), in its own throwaway
  worktree under this track's `.tmp`, installed and built there;
- the current `main` tip.

Run each side twice. A failure counts as reproducible only if it fails in both runs of a side (the
baseline's own two-consecutive-run bar). For each of the 84 tests absent from the baseline's Linux
table, record which bucket it lands in:

- fails on both trees: a cross-platform or older regression, not caused by the kernel-desktops work;
- fails only on the current tip: introduced since `43cda804`; if `git bisect` over the desktop
  runner's single spec is cheap (one spec, under a few minutes per step), name the first bad commit,
  otherwise name the commit range and stop;
- fails only on the current tip and only intermittently: a flake, list it under the intermittent
  table.

The three signatures that carry most of the 84 are listed in the handoff's evidence below; group
the buckets by signature as well as by spec.

- `overlay renderer never became usable` with `moduleReady: true, activeHandoffApplied: false`
  (`tests/helpers/hybrid-page.ts waitOverlayReady()`), about 60 occurrences, mostly
  `hybrid-overlay.spec.ts`.
- `open failed: ... ERR_FAILED (-2) loading 'peek://cmd/panel.html'`, which includes three
  `desktop-serial` tests (`cmd-noun-commands.spec.ts`, `cmd-palette.spec.ts`,
  `edit-param-mode.spec.ts`) and `window-url.spec.ts` "opening the same URL twice reuses".
- `Window matching windows/windows.html not found within 8000ms` (the Esc switcher never opens).

## What goes

In `apps/desktop/tests/gate-baseline.md`:

- every Linux table row whose test passed in both runs on the current tip (about 14 rows: all six
  `hybrid-content-window-gesture` rows, both `page-layout` rows, `izui-escape`, four of five
  `permission-prompt` rows, the headless Escape-shortcut row, and any others the runs show);
- the statement that the baseline is "recorded at `43cda804`" and the totals table, replaced by the
  new recording head and new runner totals.

## What stays

- The sections about macOS runs and the A/B notes of earlier dates, as history.
- The caveat that the count moves between identical runs, and the instruction to compare failing
  sets.
- Every test that is still failing: it keeps its row, with its cause column updated if the A/B
  shows a different cause.

## What gets added

- A "Linux set at `<head sha>`" section: every test that failed in both runs on the current tip,
  grouped by spec, each with its bucket from the A/B above and its failure signature.
- An intermittent list for tests that failed in only one of the two runs on a side.
- A short "Attribution" section stating, per bucket, the count and the first bad commit or range
  where found, and what was not determined.

Do not add a row for a test whose cause was not looked at; mark its cause `unclassified` instead.

## Tests to change

None. No spec file, product file or test helper is edited. If an A/B run shows a spec that is
plainly broken by its own harness (not by product behaviour), record it under "Attribution" and
leave it.

## Verify

The tree must pass the repo's own gate for the files it touches (none in code), so the check that
matters is the recorded evidence. Run, from this track's worktree:

```
yarn test:desktop:electron
```

Run it twice on the final tip. Done when:

- the failing set of both runs, diffed against the new baseline table plus its intermittent list,
  is empty (every failure is named in the file, and every named row still fails in at least one
  run);
- main-process unit, node unit, components and editor are all `fail 0`;
- the handoff's `**Result**` section carries the per-runner counts of all four runs (two A/B sides,
  two final tip runs), the bucket counts for the 84, and the paths of the saved failing-test lists.

## Working rules

Run one command per Bash call. Run the gate through `yarn test:desktop:electron:bg` and read the
log's exit sentinel (`yarn test:log`), never the launcher's exit code.
