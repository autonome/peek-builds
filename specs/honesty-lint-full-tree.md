---
enabled: true
touches: [apps/desktop/package.json, scripts/lint-test-honesty.mjs]
depends-on: [honesty-retarget-affordances-editor, honesty-mode-and-navigation-tests, honesty-cmd-tests, honesty-groups-and-item-actions, honesty-closed-window-stack]
---

# Make the desktop gate run the test-honesty lint over the whole tree

Last slice of Peek item `57895545`. Once the other honesty slices have landed, no unit test should
be flagged, so the gate can stop limiting the lint to changed files.

## Problem

- `apps/desktop/package.json` `test:desktop:electron` runs
  `node scripts/lint-test-honesty.mjs --changed main apps/desktop/main apps/desktop/tests/unit`, so a
  test that was already dishonest never blocks the gate.
- `scripts/lint-test-honesty.mjs` reports success when a scan root does not exist. Run from
  `apps/desktop` with no arguments, its default roots (`apps/desktop/main`,
  `apps/desktop/tests/unit`) resolve to nothing, and it prints "all unit tests import product code"
  having scanned no files.

## What goes

1. In `test:desktop:electron`, drop `--changed main` from the lint invocation. Leave
   `lint:test-honesty:changed` as it is.
2. In `lint-test-honesty.mjs`, exit non-zero with a clear message when any scan root does not exist
   or contains no test files.

## What stays

- The lint's rules for what counts as importing product code.
- Every other step of `test:desktop:electron`.

## Verify

Run each in its own Bash call and record output under **Result**.

```
node scripts/lint-test-honesty.mjs
grep -c -- '--changed main' apps/desktop/package.json
cd apps/desktop && node ../../scripts/lint-test-honesty.mjs
```

Done when the first, run from the repo root, exits 0 and lists no files. The second prints `1`. The
third, run from inside `apps/desktop`, exits non-zero naming the missing root. If the first lists any file, a dependency
did not finish its job: record which file, and do not add an escape hatch to make it pass.
