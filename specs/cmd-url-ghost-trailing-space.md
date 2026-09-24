---
enabled: true
touches: [apps/desktop/renderer/cmd/panel.js, apps/desktop/renderer/cmd/url-completion.js, apps/desktop/tests/unit/url-completion.test.js, apps/desktop/tests/desktop/cmd-url-ghost.spec.ts]
depends-on: []
---

# Cmd URL ghost must not fill or select when the typed text ends in whitespace

Peek item `c761a520`. Typing `tangled`, a space, then `p` in the cmd panel yields `tangledp`: the
inline URL ghost fills `tangled.org` over the input while the overlay still shows `tangled ` plus a
highlighted `.org`, so the next keystroke replaces the native selection in a value the user never
saw. The item's diagnosis holds against the code today (its line numbers are stale; the symbols
below are current). Param mode is not involved: `checkParamEntry` and the `input` listener in
`panel.js` gate it on a matching command name, and there is no `tangled` command.

## What the code does now

All in `apps/desktop/renderer/cmd/panel.js`:

- `setTyped` stores `payload.value` verbatim, so `state.typed` is `"tangled "`.
- `computeMatches` calls `triggerUrlGhost(typed.trim())`; the debounced query resolves and
  dispatches `GHOST_RESOLVED`, whose action `applyGhostResolution` calls
  `initialGhostGranularity(state.typed)` then `applyGhostSelection(state.typed)`.
- `currentGhostCompletion(anchor)`, `initialGhostGranularity(anchor)` and `appendUrlGhost(typed)`
  each `.trim()` the anchor before the prefix test, so `"tangled "` still forward-matches
  `tangled.org`.
- `applyGhostSelection(anchor)` trims, then does `commandInput.value = completion` and
  `setSelectionRange(t.length, completion.length, 'backward')`. The trailing space is gone from
  the input at this point.
- `updateCommandUI` renders `state.typed` untrimmed into `span.typed`, then `appendUrlGhost`
  appends `completion.substring(t.length)`. Overlay: `tangled ` + `.org`. Input: `tangled.org`.

`currentGhostCompletion` is, per its own comment, the one predicate that render, fill, Tab-gate
(`urlGhostAcceptable`) and Enter-gate (`hasUrlGhost` in the keydown handler) key off. The fix
belongs there, not only in `applyGhostSelection`: gating the fill alone would leave the overlay
rendering a highlighted suffix the input does not have.

## The change

1. `apps/desktop/renderer/cmd/url-completion.js` (pure leaf module, no DOM): add and export
   `inlineCompletionFor(completion, anchor)`. Returns `completion` when `anchor` is non-empty,
   `anchor === anchor.trim()` (no leading or trailing whitespace), `completion` is longer than
   `anchor`, and `completion.toLowerCase().startsWith(anchor.toLowerCase())`; otherwise `null`.
   The anchor is used verbatim, never trimmed. Document why: whitespace at either end means the
   user is not extending a URL, and the overlay offset must equal the input offset.

2. `apps/desktop/renderer/cmd/panel.js`:
   - `currentGhostCompletion(anchor)`: keep the `urlGhostSuggestion` null check; replace the
     trim-and-startsWith body with `inlineCompletionFor(urlCompletionAtGranularity(...), anchor)`.
   - `initialGhostGranularity(anchor)`: the loop's per-granularity test becomes
     `inlineCompletionFor(c, anchor) !== null`. Keep the `'full'` fallback.
   - `applyGhostSelection(anchor)`: delete the `const t = (anchor || '').trim()` line; the
     selection range starts at `anchor.length`.
   - `appendUrlGhost(typed)`: same; the suffix is `completion.substring(typed.length)`.
   Import `inlineCompletionFor` beside the existing `urlCompletionAtGranularity` import.

Decisions already made, do not reopen: leading whitespace disables the inline completion exactly
like trailing whitespace (one rule, no offset arithmetic). With a trailing space, Enter no longer
opens the ghost URL (`hasUrlGhost` is false) and Tab does not accept it; both fall through to the
existing no-ghost behaviour.

## What stays

- `computeMatches` still calls `triggerUrlGhost(typed.trim())`, and `applyGhostResolution` still
  stores `state.urlMatches`. The Visited lane keeps showing the URL for `tangled `; only the
  inline fill and highlighted suffix are suppressed.
- `state-machine.js`, `cmd-state-machine.test.js`, the `keydown` listener (Tab, Shift+Tab,
  Enter), `openUrlGhost`, `doAcceptUrlGhost`, `nextGranularityBeyond`, `clearUrlGhost`: untouched.
  The `keydown` listener and `state-machine.js` belong to the parallel spec
  `cmd-shift-tab-reverse`; stay out of them.

## Tests to change

`apps/desktop/tests/unit/url-completion.test.js`: add a `describe('inlineCompletionFor')` with
cases: plain prefix returns the completion; case-insensitive prefix; trailing space returns null;
leading space returns null; empty anchor returns null; anchor equal to the completion returns
null; non-prefix (substring) returns null.

`apps/desktop/tests/desktop/cmd-url-ghost.spec.ts`: add a standalone describe
`'cmd URL ghost trailing space @desktop'` with its own `createPerDescribeApp('cmd-url-ghost-trailing-space')`,
copying the `openPanel`/`closePanel`/`waitForGhost` helpers from the Camp-1 describe. Seed
`https://tangledspace.example.com/burrito/peek` via `trackNavigation` in `beforeAll`. One test,
titled `'typing a trailing space suppresses the ghost fill and keeps the space'`:
`fill('input', 'tangled ')`; wait for `_cmdState.urlGhostSuggestion.matchable ===
'tangledspace.example.com/burrito/peek'` (the query still resolves); then assert
`#command-input` value is exactly `'tangled '`, `selectionStart === selectionEnd`, and
`#command-text` has no `.cmd-inline-selection` span; then `keyboard.type('p')`, wait for
`_cmdState.urlGhostSuggestion` to be null (no URL contains `tangled p`), and assert the value is
`'tangled p'`. Pre-fix this fails at the first value assertion (`tangledspace.example.com` filled).

## Verify

The repo gate covers the unit test. The Playwright describes are not in the gate; run these and
record collected/passed/failed counts under `**Result**` in the handoff:

```
yarn workspace @peek/desktop test:grep "trailing space"
yarn workspace @peek/desktop test:grep "cmd URL"
```

The second pattern collects every describe in `cmd-url-ghost.spec.ts` plus any other spec whose
title starts with `cmd URL`; all must pass, including the Camp-1 fill/select and Backspace tests,
whose prefixes have no whitespace and must be unaffected.

## Working rules

Run one command per Bash call.
