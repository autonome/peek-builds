---
enabled: true
touches: [apps/desktop/renderer/cmd/state-machine.js, apps/desktop/renderer/cmd/panel.js, apps/desktop/tests/unit/cmd-state-machine.test.js, apps/desktop/tests/desktop/cmd-shift-tab-reverse.spec.ts]
depends-on: []
---

# Shift+Tab cycles the command palette backward in every mode

Peek item `3202583e`. Shift+Tab already cycles backward in two FSM states
(`apps/desktop/renderer/cmd/state-machine.js`): TYPING maps `Events.SHIFT_TAB` to
`shiftTabCycleCommand`, PARAM_MODE maps it to `fillParamTextReverse`. Both stay as they are.
Two states still do not honour it, and a third defect in the URL-mode branch has to be fixed
for the second one to be observable at all.

## What the code does now

1. **RESULTS_OPEN** (entered by ArrowDown). The transition table has `[Events.TAB]` with a
   PARAM_MODE branch and a `tabCycleInResults` branch, but no `[Events.SHIFT_TAB]` entry.
   `apps/desktop/renderer/cmd/panel.js`'s keydown handler already dispatches
   `machine.dispatch(Events.SHIFT_TAB)` when `e.key === 'Tab' && e.shiftKey`, so the event
   arrives and `dispatch()` logs "No transition" and does nothing.
2. **URL mode** (Cmd+L; `urlModeActive` in `panel.js`). It is a documented FSM exception: the
   keydown handler's `if (urlModeActive)` block runs before any `machine.dispatch`. Its
   `if (e.key === 'Tab')` branch never reads `e.shiftKey`, so Shift+Tab advances
   `state.matchIndex` forward exactly like Tab.
3. **`renderUrlResults(items)`** (`panel.js`) ends with `state.matches = items.map(...)` and
   `state.matchIndex = 0;`. Every URL-mode ArrowDown/ArrowUp/Tab handler mutates
   `state.matchIndex` and then calls `renderUrlResults(urlModeItems)`, which paints the row it
   was just given as `.selected` and then resets the index to 0. Net effect: the index the
   test reads is always 0, a second Tab re-selects row 1 instead of row 2, and the URL-mode
   Enter handler (`openUrlModeItem(state.matchIndex)`) always opens row 0 no matter which row
   is highlighted. This is why the item's "assert `_cmdState.matchIndex` after Tab, Tab" cannot
   work on the current code even for the forward direction.

## What to change

**`state-machine.js`** — in the `[States.RESULTS_OPEN]` block add, directly after
`[Events.TAB]`:

```js
[Events.SHIFT_TAB]: [
  { guard: 'hasMatches', target: States.RESULTS_OPEN,
    actions: ['shiftTabCycleInResults', 'updateGhostText', 'renderResults'] },
],
```

Decision: one branch only, no PARAM_MODE branch. Shift+Tab never enters param mode, matching
TYPING's `SHIFT_TAB` (which also has only the cycle branch).

**`panel.js`** — in `actionHandlers()`, add `shiftTabCycleInResults()` next to
`tabCycleInResults()`. Copy `tabCycleInResults` verbatim and change only the index line to
`(state.matchIndex - 1 + state.matches.length) % state.matches.length`, exactly as
`shiftTabCycleCommand` differs from `tabCompleteCommand`. Keep the `alreadyCompleted` gate:
the first Tab or Shift+Tab after ArrowDown fills the current row's name without moving, the
next one moves. Decision: do not refactor the three existing near-identical cycle actions into
a shared helper; add the fourth in the same style.

**`panel.js`** — URL-mode keydown branch: replace the `if (e.key === 'Tab')` body so that
with `urlModeItems.length > 0` it sets `state.matchIndex` to
`(state.matchIndex - 1 + urlModeItems.length) % urlModeItems.length` when `e.shiftKey` is
true and to `(state.matchIndex + 1) % urlModeItems.length` otherwise, then calls
`renderUrlResults(urlModeItems)` as today. Both wrap.

**`panel.js`** — delete the `state.matchIndex = 0;` line at the end of `renderUrlResults`
(keep the `state.matches = items.map(...)` line above it). Add `state.matchIndex = 0;`
immediately before the `renderUrlResults(...)` call in `enterUrlMode()` and in
`filterUrlModeItems()`, so the index still resets whenever the list is replaced. The URL-mode
`input` listener already sets `state.matchIndex = 0` before calling `filterUrlModeItems`;
leave it. Nothing else in `panel.js` changes — in particular do not touch the URL-ghost code
(`applyGhostSelection`, `doAcceptUrlGhost`, `currentGhostCompletion`, `updateCommandUI`,
`initialGhostGranularity`, `appendUrlGhost`), which the parallel spec
`cmd-url-ghost-trailing-space` owns.

## Tests to change

`apps/desktop/tests/unit/cmd-state-machine.test.js`, inside `describe('RESULTS_OPEN transitions')`
(its `beforeEach` seeds `matches = ['tags','tag','settings']`, `matchIndex = 0`):

- `'RESULTS_OPEN + Shift+Tab -> RESULTS_OPEN (cycles in place, never param mode)'`: seed
  `commands` so `settings` has a `params` entry, set `typed = 'settings'`, `matchIndex = 2`,
  dispatch `Events.SHIFT_TAB`; assert `handled === true`, state is still `RESULTS_OPEN`, and
  `machine._actionLog` contains `'shiftTabCycleInResults'` and `'renderResults'`. (Fails
  pre-fix: `handled` is false.)
- `'RESULTS_OPEN + Shift+Tab with no matches -> not handled'`: set `matches = []`, dispatch,
  assert `handled === false` and state unchanged.

The wrap arithmetic lives in the panel action, not the machine, so it is covered by Playwright:

`apps/desktop/tests/desktop/cmd-shift-tab-reverse.spec.ts` (new; the `desktop` project collects
`tests/desktop/*.spec.ts`). Use `createPerDescribeApp('cmd-shift-tab-reverse')` from
`../helpers/test-app`, `waitForPanelCommandsLoaded` from `../helpers/window-utils`, and the
`openPanel`/`closePanel` shape of `tests/desktop/cmd-enter-runs-suggestion.spec.ts` (open
`peek://cmd/panel.html` via `app.window.open` from the bg window, no `keepLive`). Two tests:

- `'Shift+Tab cycles backward in RESULTS_OPEN'`: fill `input` with `theme`; wait until
  `_cmdState.matches.length >= 2` and assert every match has no `params` (the `theme*`
  commands in `renderer/index.js` are all param-less; if that premise fails, fail loudly).
  Press ArrowDown, wait for `_cmdState.currentState === 'RESULTS_OPEN'`. Press Tab twice and
  read `a = _cmdState.matchIndex` (a is 1 or 2 depending on ranking; assert `a >= 1`). Press
  Shift+Tab, wait for `matchIndex === a - 1` and state still RESULTS_OPEN, and assert the
  `.command-item.selected` row is at that index. Press Shift+Tab until `matchIndex === 0`,
  then once more and expect `matchIndex === matches.length - 1`.
- `'Shift+Tab cycles backward in URL mode'`: in `beforeAll`, seed three distinct
  `https://<x>.example.com/...` URLs with `app.datastore.trackNavigation(url, { source:
  'window', windowType: 'main' })` from the bg window (same call as `cmd-url-ghost.spec.ts`).
  Open the panel, then from the bg window run `app.publish('cmd:url-mode', {})` (the topic
  `renderer/cmd/background.js` publishes on Cmd+L; the panel subscribes in `panel.js`). Wait
  for `document.querySelectorAll('.url-result-item').length >= 3`; call it `n`. Press Tab,
  expect `matchIndex === 1`; Tab, expect 2; Shift+Tab, expect 1; Shift+Tab, expect 0;
  Shift+Tab, expect `n - 1`; each time also assert the `.url-result-item.selected` index.

Both fail pre-fix: the first because SHIFT_TAB is unhandled in RESULTS_OPEN, the second at its
first `matchIndex === 1` because `renderUrlResults` resets the index.

`panel.js` only calls `enterUrlMode()` immediately when `!document.hidden`. There is no
existing Playwright coverage of URL mode. If the rows never appear in the headless run, record
that under `**Result**` as a finding rather than weakening the test.

## Verify

The gate covers the unit test. The Playwright spec is not in the gate; run it and record the
collected/pass/fail counts under `**Result**` in the handoff (`--grep` is a regex, so a
literal `+` would collect nothing):

```
yarn workspace @peek/desktop test:grep "Shift.Tab cycles backward"
```

Done when it collects 2 and both pass, the gate is green, and the existing TYPING and
PARAM_MODE Shift+Tab tests in `cmd-state-machine.test.js` are untouched.

## Working rules

Run one command per Bash call.
