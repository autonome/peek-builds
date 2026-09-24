---
enabled: true
touches: [apps/desktop/renderer/cmd/state-machine.js, apps/desktop/renderer/cmd/panel.js, apps/desktop/tests/unit/cmd-state-machine.test.js, apps/desktop/tests/desktop/cmd-url-ghost.spec.ts, docs/cmd-state-machine.md]
depends-on: []
---

# Staged Escape in the command palette: dropdown, then text, then panel

Peek item `cc3532f6`. In the cmd panel with typed text and a visible suggestion dropdown, one
Escape hides the dropdown and wipes the text in the same press. Wanted: each Escape peels one
layer — (1) hide the dropdown and keep the text, (2) clear the text, (3) close the panel.
Degenerate cases: no dropdown visible → clear text, then close; empty input → close.

This is the cmd panel only (`apps/desktop/renderer/cmd/`). The page-host address bar's own
two-stage Escape is correct and out of scope. Item `c61da706` (Escape while an input is focused,
still in design) does not block this. This item is one of the four cmd fixes named in epic
`6ca06b49`'s open question; the other shipped ones (`cmd-shift-tab-reverse`,
`cmd-url-ghost-trailing-space`) landed as standalone fixes ahead of any state-machine rewrite,
and this one follows the same pattern.

## What the code does now

`apps/desktop/renderer/cmd/state-machine.js`:

- `resultsListOpen(currentState, data)` derives list visibility. In TYPING and IDLE the list
  auto-opens whenever `data.matches.length + data.urlMatches.length > 1`. Nothing can suppress it.
- `[States.TYPING]` `[Events.ESCAPE]`: `textNonEmpty` → IDLE with
  `['clearInput', 'clearMatches', 'updateGhostText', 'updateResults']`, else CLOSING. When the
  list auto-opened in TYPING (the usual case once the Visited lane resolves), this one press
  hides the list and wipes the text: the reported defect.
- `[States.RESULTS_OPEN]` `[Events.ESCAPE]`: → TYPING with `['updateResults']`. The text is
  kept, but TYPING re-derives visibility and the list reappears whenever `total > 1`. So even
  after ArrowDown, the first Escape does not visibly close the dropdown, and the second one
  clears everything at once.

`apps/desktop/renderer/cmd/panel.js`:

- The `commandInput` `keydown` listener dispatches `Events.ESCAPE` for an unmodified Escape
  (outside URL mode). `api.escape.onEscape` routes the IZUI path through `machine.handleEscape()`,
  which is the same `dispatch(Events.ESCAPE, { kernelCloses: true })`. Both paths go through the
  transition table, so the fix belongs there alone.
- When the URL ghost resolves to a prefix completion, `applyGhostSelection(anchor)` overwrites
  `#command-input`'s value with the completion and natively selects the suffix. `state.typed`
  keeps the real typed text. So "keep the typed text" has to put the input's value back to
  `state.typed`. Otherwise the first Escape leaves a filled URL in the input that no dropdown or
  ghost explains.

## What changes

**`state-machine.js`**

1. Add `resultsDismissed: false` to the initial `data` object, next to `urlMatches`, commented
   as "Escape hid the auto-opened list for the current text; owned by this module". In `reset()`,
   set it back to `false`.

2. In `resultsListOpen`, directly before the final `return total > 1;` (the TYPING/IDLE
   auto-open rule), add `if (data.resultsDismissed) return false;`. RESULTS_OPEN, CHAIN_MODE and
   PARAM_MODE are unaffected. `selectedRow()` already returns null when the list is closed, so
   the `selectedRowIsUrl` Enter guard stops opening an unseen url row with no further change.
   `commandRowSelected` still runs a fully typed command on Enter, as it does today when the
   list is closed.

3. Machine-internal actions. Inside `createStateMachine`, add a
   `const internalActions = { dismissResults() { data.resultsDismissed = true; },
   undismissResults() { data.resultsDismissed = false; } };`. In `runAction(name, payload)`,
   run `internalActions[name]` when present, before looking at `actions[name]` (the test harness
   proxies every action name, so the internal lookup must come first). Only this module writes
   the flag. `panel.js` reads it, never writes it.

4. Add a default guard `resultsVisible: () => resultsListOpen(currentState, data)`.

5. `[States.TYPING]` `[Events.ESCAPE]` becomes three branches, in this order:
   - `{ guard: 'resultsVisible', target: States.TYPING, actions: ['dismissResults', 'dropInlineGhost', 'updateGhostText', 'updateResults'] }`
   - the existing `textNonEmpty` → IDLE branch, unchanged
   - the existing → CLOSING branch, unchanged

6. `[States.RESULTS_OPEN]` `[Events.ESCAPE]` becomes
   `{ target: States.TYPING, actions: ['dismissResults', 'dropInlineGhost', 'updateGhostText', 'updateResults'] }`.

7. Clearing the flag:
   - In `[States.TYPING]` `[Events.INPUT]`, put `'undismissResults'` first in the
     `inputNonEmpty` branch's actions. New text re-opens the list.
   - In `enforceInvariants()`, add `if (currentState !== States.TYPING) data.resultsDismissed = false;`.
     This covers ArrowDown (TYPING → RESULTS_OPEN reopens the list), the clear to IDLE, param
     mode, and every other exit.

   Decision: Tab, Shift+Tab, GHOST_RESOLVED and ACCEPT_GHOST in TYPING leave the flag alone. A
   late ghost resolution must not re-open a dismissed list. ArrowDown is the explicit reopen
   gesture.

**`panel.js`**

8. In `actionHandlers()`, add `dropInlineGhost()` next to `clearMatches()`. It does three things:
   - calls `clearUrlGhost()`, which nulls `urlGhostSuggestion`, clears `state.urlMatches`, bumps
     `urlGhostGeneration` so a pending query is discarded, and cancels `urlGhostTimer`;
   - sets `#command-input`'s value to `state.typed`;
   - collapses the selection to the end of that value.

   `state.typed` and `state.matches` are untouched. As a result, Enter after the first Escape
   cannot open a ghost URL that is no longer shown (`hasUrlGhost` is false), and ArrowDown
   reopens the command rows only.

9. Update `docs/cmd-state-machine.md`:
   - TYPING Escape table row: add the `results visible → TYPING (dismiss list, keep text)` row
     above the existing two.
   - RESULTS_OPEN Escape row: replace the stale `showResults=false` wording with
     "dismiss list, keep text".
   - Checklist entry "Escape layering order": insert "visible results → text → close" to match.

## What stays

- The Escape transitions of PARAM_MODE, EXECUTING, OUTPUT_SELECTION, CHAIN_MODE, CHAIN_POPUP,
  ERROR and IDLE.
- `handleEscape()` and its `kernelCloses` contract.
- The URL-mode (Cmd+L) `keydown` branch (`exitUrlMode()` then dispatch). It is a documented FSM
  exception and not part of this change.
- `computeMatches`, `triggerUrlGhost`, `applyGhostResolution`, `applyGhostSelection`,
  `currentGhostCompletion` (owned by the landed `cmd-url-ghost-trailing-space` work).
- The Shift+Tab actions from `cmd-shift-tab-reverse`.

## Tests to add or change

`apps/desktop/tests/unit/cmd-state-machine.test.js`:

- In `describe('Escape layering')`, add
  `'staged Escape: dropdown, then text, then close'`: `makeMachine()`, `setState(States.TYPING)`,
  `typed = 'ta'`, `matches = ['tags', 'tag']`.
  1. Assert `resultsListOpen(TYPING, data)` is true.
  2. Escape: state TYPING, `resultsListOpen(getState(), getData())` false, `typed === 'ta'`,
     `_actionLog` includes `'dropInlineGhost'` and not `'clearInput'`.
  3. Escape: state IDLE, `typed === ''`.
  4. Escape: state CLOSING.

  Fails pre-fix: the first Escape lands in IDLE.
- Same describe, add `'staged Escape from RESULTS_OPEN keeps the list closed in TYPING'`: RESULTS_OPEN,
  `typed = 'ta'`, `matches = ['tags', 'tag', 'settings']`.
  1. Escape: TYPING, list closed, text kept.
  2. Escape: IDLE.

  Fails pre-fix: the list re-derives as open after the first Escape.
- Same describe, add `'dismissed list reopens on new input and on ArrowDown'`: after a
  dismissing Escape, dispatch `INPUT { value: 'tag' }` and assert the list is open again. Dismiss
  again, dispatch `ARROW_DOWN`, assert RESULTS_OPEN and `resultsDismissed === false`.
- Degenerate cases in the same describe:
  - `'no dropdown: Escape clears, then closes'`: TYPING, `typed = 'tags'`, `matches = ['tags']`
    (total 1, list closed). Escape → IDLE, Escape → CLOSING.
  - `'empty input: Escape closes'`: IDLE, Escape → CLOSING. The existing `'IDLE + Escape -> CLOSING'`
    already covers this; reference it rather than duplicating if preferred.
- `'TYPING + Escape with text -> IDLE'` (in `describe('TYPING transitions')`) still passes as
  written (empty `matches`, list closed). Leave it.
- `describe('Regression: openSelectedUrlResult resolves through selectedRow, not raw matchIndex')`:
  after the Escape, its "list stays open, re-highlights row 0" premise no longer holds. Keep the
  regression's purpose:
  1. After the Escape, assert `resultsListOpen` is false.
  2. Dispatch `Events.INPUT, { value: 'x' }`. The stub `computeMatches` leaves `matchIndex` stale
     at 1 and `undismissResults` reopens the list.
  3. Assert `selectedRow` is 0, then run the existing Enter and `resolvedRow === highlighted`
     assertion.

  Update the comment block above the describe to match.
- `describe('Machine reset')`: add `resultsDismissed = true` before `reset()` and assert it is
  `false` after.

`apps/desktop/tests/desktop/cmd-url-ghost.spec.ts`: add a standalone describe
`'cmd URL staged Escape @desktop'` with its own `createPerDescribeApp('cmd-url-staged-escape')`.
Copy the `openPanel` helper (`keepLive: true`, `role: 'palette'`) and the `closePanel` helper
from the `'cmd URL ghost trailing space @desktop'` describe. In `beforeAll`, seed
`https://stagedescape.example.com/alpha` and `https://stagedescape.example.com/beta` via
`trackNavigation(u, { source: 'window', windowType: 'main' })`.

One test, `'staged Escape: dropdown, then text, then panel'`:
1. `fill('input', 'stagedesc')`. Wait until `_cmdState.matches.length === 0` and
   `_cmdState.urlMatches.length >= 2`, then until `#results` has class `visible`. The ghost may
   have filled the input with `stagedescape.example.com`; that is expected.
2. `keyboard.press('Escape')`. Wait for `#results` to lose `visible`, then assert:
   - `_cmdState.currentState === 'TYPING'`;
   - `#command-input` value `=== 'stagedesc'`;
   - `selectionStart === selectionEnd`.
3. `keyboard.press('Escape')`. Wait for `#command-input` value `=== ''` and
   `_cmdState.currentState === 'IDLE'`.
4. `keyboard.press('Escape')`. Wait for `_cmdState.currentState === 'CLOSING'`. The `keepLive`
   panel hides rather than being destroyed, so the page stays evaluable.
5. `closePanel`.

Pre-fix this fails in step 2 (the input is emptied and the state is IDLE).

## Verify

The repo gate covers the unit test. The Playwright spec is not in the gate. Run these and record
collected/passed/failed counts under `**Result**` in the handoff:

    yarn workspace @peek/desktop test:unit
    yarn workspace @peek/desktop test:grep "staged Escape"
    yarn workspace @peek/desktop test:grep "cmd URL"

Done when:
- `test:unit` reports `fail 0`, including the new `Escape layering` cases and the rewritten
  `openSelectedUrlResult` regression;
- `"staged Escape"` collects 1 and it passes;
- every existing describe in `cmd-url-ghost.spec.ts` still passes under `"cmd URL"` (the
  auto-opened-lane Enter test and the Camp-1 fill/Backspace tests must be unaffected, since they
  never press Escape).

## Working rules

Run one command per Bash call.
