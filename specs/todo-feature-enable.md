---
enabled: true
touches: [apps/desktop/features/todo/manifest.json.disabled, apps/desktop/features/todo/manifest.json, apps/desktop/features/todo/README.md, apps/desktop/main/todo-manifest.test.ts, docs/tiles-single-file.md, talk/peek-talk-overview.md]
depends-on: [todo-list-and-done-picker, todo-verb-rename]
---

# Ship the todo feature on by default

Part of Peek item `b0ebd143`. This slice is the switch: once `todos`, `done` and `complete` exist, the
feature's manifest is renamed so discovery loads it, with a test that keeps it from shipping off again.

## Problem

`apps/desktop/features/todo/manifest.json.disabled` has no `manifest.json` beside it, so feature
discovery skips the directory and none of the `todo`, `todos`, `done` or `complete` commands reach the cmd panel.
Several files describe that state as deliberate: the feature's `README.md` ("DISABLED", "Why
disabled", "Re-enabling"), `docs/tiles-single-file.md` (the sentence starting "`todo` ships disabled"
below the "Tiles not yet migrated" table), and the "Reference features" bullet for `todo/` in
`talk/peek-talk-overview.md`. Nothing tests that the manifest is live, so the rename could be undone
unnoticed.

The tile is lazy (`"lazy": true`, no `resident`), so enabling it adds three commands to the panel and
arms a wake-on-command stub; it opens no window and adds no boot-time process. The existing drift test
`main/manifest-subscribe-drift.test.ts` reads every `features/*/manifest.json`, so once the file is
live it also checks that every topic `background.js` subscribes to is in the manifest's topic list.

## What goes

- `git mv apps/desktop/features/todo/manifest.json.disabled apps/desktop/features/todo/manifest.json`.
  The contents come from the earlier slice `todo-list-and-done-picker`; change nothing else in the
  file except the top-level `description`, which should mention the `todos` command.
- `apps/desktop/features/todo/README.md`: replace the "disabled" narrative with a short description of
  the four commands (`todo <text> [#tag ...]`, `complete <partial>` with the suggestion picker and what
  Tab and Enter do there, `todos` listing outstanding todos and `done` listing finished ones, Enter on
  either opening the editor) and a file list (`manifest.json`,
  `background.html`, `background.js`, `todo-items.js`, `config.js`).
- `docs/tiles-single-file.md`: drop the `todo` half of the "ships disabled" sentence (keep its theme
  manifests half) and add a `todo` row to the table of tiles that are already one renderer process
  (the one listing `peeks`, `slides`, `files`, `pagewidgets-sample`, `debug`), noting it wakes on
  `cmd:execute:todo`, `cmd:execute:todos`, `cmd:execute:done` and `cmd:execute:complete`.
- `talk/peek-talk-overview.md`: rewrite the `todo/` bullet under "Reference features" to say it is an
  ordinary lazy command feature (create, list, complete) and no longer disabled.

## What stays

- `background.js`, `todo-items.js`, `config.js`, `background.html`: no code change.
- The cmd panel and its tests.
- No new Playwright spec: the pure decisions are covered by the previous slice's unit tests and the
  wiring by the manifest test below. Typing `todos`, `done` or `complete` into a live panel is not covered by any
  automated test; say so under **Result**.

## Tests to change

New `apps/desktop/main/todo-manifest.test.ts`, following `main/entities-open-command.test.ts` (repo
root taken from `process.cwd()`, `node:test` plus `node:assert`). Assert:

- `apps/desktop/features/todo/manifest.json` exists and parses, and `manifest.json.disabled` does not
  exist.
- `id` is `todo`; the `commands` array has exactly `todo`, `todos`, `done`, `complete`.
- Every command has its `cmd:execute:<name>` topic in `capabilities.pubsub.topics`.
- The `complete` command's first param has `type: 'item'` and `tag: 'todo'`; `done` has no params.
- The single tile is lazy and not resident (`lazy` true, `resident` absent or false), so enabling
  cannot add a boot-time window.

## Verify

```
yarn workspace @peek/desktop build && NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js && NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
yarn workspace @peek/desktop test:grep "Command Execution"
yarn workspace @peek/desktop test:grep "cmd hashtag"
```

Done when the electron and node runners report `fail 0` with the new test file and
`manifest-subscribe-drift.test.ts` (now covering the todo manifest) included, and both Playwright greps
collect at least one test and pass; record every count under **Result**. If a grep fails, compare the
failing spec against `apps/desktop/tests/gate-baseline.md` before attributing it to this change, and
report it as a pre-existing failure only when it is listed there. The full `yarn test:desktop:electron`
gate cannot go green on Linux; leave it to the macOS sign-off and note that under **Result**.

## Working rules

Run one command per Bash call.
