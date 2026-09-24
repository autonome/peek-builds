---
enabled: true
touches: [apps/desktop/renderer/components/peek-navbar.js, apps/desktop/tests/components/peek-navbar-autocomplete.spec.ts]
depends-on: []
---

# Address bar: keep the inline ghost rejected after Backspace

Peek item `876200f9`. In the page-host address bar (`<peek-navbar>`), typing a prefix shows an
inline ghost completion as natively selected text. Backspace removes the selected suffix, which is
correct. Then the debounced query runs again and puts the same ghost back, so Backspace cannot
reject it. The cmd panel already fixed this with a per-event deletion signal; the address bar is a
separate surface with its own code and does not have that fix.

## What's still live and needs to go

`apps/desktop/renderer/components/peek-navbar.js`:

- `_onUrlInput()` takes no event argument and handles every `input` event the same way. It stores
  `input.value` as `_typedAnchor` and calls `_triggerSuggestions(this._typedAnchor)`.
- The debounced callback in `_triggerSuggestions()` (`URL_GHOST_DEBOUNCE_MS`) always rebuilds
  `this._ghost` from `items[0]` and calls `_applyGhostSelection(this._typedAnchor)`. Nothing tells
  it whether the triggering edit was a deletion, so after Backspace the ghost fills in and is
  selected again.

## The model to mirror

`apps/desktop/renderer/cmd/panel.js` classifies each edit from the `input` event itself:
`const isDeleting = typeof e.inputType === 'string' && e.inputType.startsWith('delete');`. It
passes that to the state machine as `payload.isDeleting`, and the `INPUT` action calls
`clearUrlGhost()` rather than re-arming when it is set. The check reads the event itself; it uses
no timer and is not a debounce trick. The debounce stays only to limit how often queries run.

## What changes

- `_onUrlInput(e)` reads `e.inputType` and computes `isDeleting` exactly like the cmd panel. A
  missing `inputType` counts as a non-delete.
- `_triggerSuggestions(text, { isDeleting })` still runs the query and refreshes
  `this._suggestions`, so the dropdown keeps working while deleting. When `isDeleting` is true, the
  callback leaves `this._ghost` null and skips `_applyGhostSelection`. The input keeps exactly what
  was typed, with no selection. The next insertion (any `input` event whose `inputType` is not
  `delete*`) re-arms the ghost through the normal path.
- The suppression is state on the component (for example `this._suppressGhost`), set from the
  classified event and cleared on the next insertion — never inferred later from timing.
- The callback in `_triggerSuggestions()` sets `this._ghostTimer = null` once it has finished, on
  both the apply path and the stale-generation early return. The test uses that state to know the
  query has settled without a fixed sleep.

## What stays

- `URL_GHOST_DEBOUNCE_MS`, the generation counter (`_ghostGeneration`), `_clearGhost()`,
  `_closeDropdown()`, and the Tab/ArrowUp/ArrowDown/Enter/Escape handling in `_onUrlKeydown()`.
  With `_ghost` null, `_currentGhostCompletion()` returns null, so Tab falls through, and the first
  Escape still closes the open dropdown because `_suggestions` is non-empty.
- The cmd panel. Its fix has landed and this spec does not touch it.

## Tests to change

`apps/desktop/tests/components/peek-navbar-autocomplete.spec.ts`, in the describe
`"peek-navbar URL autocomplete @components"`. Add one test with "Backspace" in its title:

1. `typeUrl('git')`, then assert the ghost is showing: value `github.com`, selection `3..10`.
2. Press `Backspace`. Wait with `page.waitForFunction` until the navbar's `_ghostTimer === null`,
   so the debounced query has settled. No fixed sleep.
3. Assert `inputElement.value === 'git'`, `selectionStart === selectionEnd`, and `_ghost` is null.
4. Type one more character (`h`) and wait the same way. Assert the ghost re-arms: value
   `github.com` with the suffix beyond `gith` selected.

The existing 7 tests in the describe must still pass unchanged.

## Verify

This change is covered only by the Playwright `components` project, which runs in Chromium rather
than Electron. `yarn test:grep` and `yarn workspace @peek/desktop test:grep` hard-code
`tests/desktop/` and report "No tests found" for this spec. Run the components project directly
from the repo root:

```
HEADLESS=1 BACKEND=electron ./scripts/playwright-with-display.sh test --config apps/desktop/playwright.config.ts --project=components --grep 'peek-navbar URL autocomplete'
```

Done when the run collects 8 tests (the 7 existing plus the new Backspace test) and reports 8
passed, 0 failed. Record the counts under the handoff's **Result**. Also run the desktop unit gate
to confirm nothing else moved:

```
yarn workspace @peek/desktop test:unit
```

## Working rules

Run one command per Bash call.
