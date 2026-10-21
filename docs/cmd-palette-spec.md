# Cmd Palette Behavior Spec — Phase 1 Audit
*Generated 2026-05-06. Read-only audit; no code was modified.*

---

## 0. How to Read This Document

Sections 3–4 are prescriptive (what the target behavior should be, the FSM to get there).
Section 5 contains three architectural decisions to settle before implementation starts.
Section 6 lists acceptance-test names that can be written against the finished implementation.
None of it is built: the palette FSM has no `SUCCESS_FLASH` state.

Sections 1–2 are the diagnostic half — what the palette did at the time of the audit, and the
gaps sections 3–6 close. They sit under "History" at the bottom; section 3 onwards still cites
their gap letters.

All line numbers cite `apps/desktop/renderer/cmd/panel.js` or `apps/desktop/renderer/cmd/state-machine.js` from the HEAD at time of audit. They have drifted; treat them as search targets, not stable references.

---

## 3. Proposed Behavior Spec

The following is a precise target behavior. It is scoped strictly to the user's stated symptoms. Each item cites the gap it closes.

### 3.1 Visual Affordances

#### 3.1.A Ghost text in IDLE (closes Gap A)

**Target:** When the panel opens and the input is empty, show a dim ghost hint listing the most frecency-scored command (or a static prompt if no commands are loaded). This makes "something is available to type" visible immediately.

**Precise behavior:**
- When FSM enters IDLE and `state.commands` has at least one entry: show the top frecency command name in `#command-text` as a single `<span>` with class `hint` (new class, color `--theme-text-muted`, lighter than current ghost text).
- When the user starts typing, the hint is replaced by the normal two-tone ghost text.
- When the user clears input back to empty, the hint reappears.
- The hint does NOT respond to Tab or Enter — it is display-only. Only actual user typing activates the matching flow.

**Implementation note:** The `updateCommandUI()` function needs a new branch at `panel.js:1559` — if `state.typed` is empty and FSM is IDLE, render the top frecency command as a hint span. The hint span class should be distinct from `typed` (bold) and from the current ghost completion text (dim) — perhaps even lighter or italic.

#### 3.1.B Unambiguous selected state (closes Gap B)

**Target:** The keyboard-selected item in the dropdown must be visually distinct from hover in a way that survives both light and dark mode, and in cases where the item is not being hovered.

**Precise behavior:**
- Remove the `selected` background color reliance as the sole differentiator.
- Add a left-border accent to `.command-item.selected`: `border-left: 3px solid var(--theme-accent, #007aff)` with `padding-left: 5px` (compensating 3px to maintain alignment).
- In dark mode `--theme-accent` is already defined in theme variables; this is not a new CSS variable.
- Hover style stays as-is (background only). Selected style: background (same as now) + left accent border.

**Implementation:** CSS change only in panel.html. Two rules:
```css
.command-item.selected {
  background-color: var(--cmd-surface-selected);
  border-left: 3px solid var(--theme-accent, #007aff);
  padding-left: 5px;
}
```

#### 3.1.C Command vs parameter visual distinction (closes Gap C)

**Target:** In the `#command-text` ghost overlay, the committed command name portion should render in a visually distinct style from the parameter portion.

**Precise behavior:**
- The committed command name: existing `class="typed"` (bold, full color). No change.
- The parameter portion after the command name: new `class="param"` — same color but NOT bold (font-weight 400), with a faint left border or a subtle background pill to signal "you are inside the parameter slot."
- The ghost completion for the parameter (what Tab would fill): existing dim style (no class, gray).

**Implementation:**
- Add CSS class `param` to panel.html: `color: var(--theme-text); font-weight: 400; border-bottom: 1px solid var(--cmd-surface-divider);` (subtle underline under the param region).
- In `updateCommandUI()` at `panel.js:1620–1625`, change `paramsSpan.className = 'typed'` to `paramsSpan.className = 'param'`.
- In PARAM_MODE ghost completion at `panel.js:1653–1676`, the ghost span (the completion tail) remains unstyled (gray, dim) as now.

#### 3.1.D Scope chips as first-class (closes Gap D)

**Decision required:** See Section 5 Q.2 — are scope chips a state-machine-level concept or a hint? This spec describes the visual design; the state-machine question is deferred to Section 5.

**Visual target (independent of the decision):**
- In the results dropdown, scope chips should be color-coded pill-shaped badges, not Unicode symbols. Use text labels "window" and "page" instead of box-drawing characters.
- CSS target: small pill (border-radius: 10px, padding: 2px 8px), accent color per scope type. Window scope: blue tint. Page scope: purple tint. These do not need new CSS variables — use opacity-modified versions of existing accent colors.
- In the input area, when the panel is in PARAM_MODE for a scoped command: show a small scope chip inside the `.center-wrapper` to the right of the input (same position as the mode indicator, or adjacent to it). This chip is passive — it does not respond to clicks.

---

### 3.2 Completion and Discoverability

#### 3.2.A Sticky completion (closes Gap F)

**Target:** When the user has typed at least one character and there are matches, the dropdown should open automatically without requiring ArrowDown.

**Precise behavior:**
- Transition `TYPING + INPUT (non-empty, has matches)` → RESULTS_OPEN instead of staying in TYPING.
- TYPING state is collapsed: the panel is either IDLE (no input) or RESULTS_OPEN (input + matches).
- Exception: when the user has typed enough to be in PARAM_MODE (command name + space), the dropdown shows parameter suggestions (current behavior), not command matches.
- If there are no matches, the input renders with no dropdown (plain ghost text only, fading to nothing if no ghost match either).

**FSM change:** In the TYPING transitions table:
```
TYPING + INPUT(non-empty, hasMatches) → RESULTS_OPEN   [was: stays TYPING]
TYPING + INPUT(non-empty, no matches) → TYPING         [unchanged]
```
This means the existing `showResults` flag / `RESULTS_OPEN` state merges the "ghost text with no list" and "ghost text with list" cases. TYPING becomes a transient state only reached when input is non-empty but no matches exist.

**Note:** This is a substantial UX change. If the user decides they want the ArrowDown-to-open behavior preserved as an option, add a pref `stickyCompletion: boolean` (default true). The existing ARROW_DOWN → RESULTS_OPEN path would still work for mouse-preference users.

#### 3.2.B Tab affordance visible (closes Gap E)

**Target:** When the user is in RESULTS_OPEN with a command selected that has params, show a hint in the dropdown row saying "Tab to enter params" or show a `<kbd>Tab</kbd>` badge on the row.

**Precise behavior:**
- In `updateResultsUI()`, when rendering the selected item (`index === state.matchIndex`) in RESULTS_OPEN, if `cmd.params && cmd.params.length > 0`: append a `<kbd>Tab</kbd>` badge to the right side of the row.
- This badge is display-only — no interaction needed.
- CSS: small, muted, `font-size: 10px`, `opacity: 0.5`.

**Implementation:** Two lines of DOM construction added to the results renderer at `panel.js:1756` (after the existing badges).

#### 3.2.C Noun vs free-text indicator (closes Gap G)

**Target:** When the user is in PARAM_MODE, add a brief label in the panel indicating what kind of parameter is expected.

**Precise behavior:**
- Below the input (or as a prefix in the results separator row), show a small label describing the param type:
  - `type: 'tag'` → "Tag" + `⌨ type to filter`
  - `type: 'item'` → "Note" + `⌨ type to search`
  - `type: 'enum'` → "Choose one" (or the paramDef description if it exists)
- This label appears only in PARAM_MODE. It disappears when the user exits PARAM_MODE.
- Implementation: add a `<div id="param-hint">` element to the HTML before `#results`. Show/hide it in `updateResultsUI()` and `exitParamMode()`.

---

### 3.3 Command Result Feedback (closes Gap H)

**Target:** When a command succeeds and returns a `message` but no `output` that opens a new view, show the message briefly in the panel before closing.

**Precise behavior:**
- Existing flow: EXECUTING → `COMMAND_COMPLETE` (no output) → CLOSING → panel hides immediately.
- New flow: EXECUTING → `COMMAND_COMPLETE` (no output, has `result.message`) → SUCCESS_FLASH → (1.2s delay) → CLOSING.
- SUCCESS_FLASH is a new sub-state (or a timed action) that:
  1. Replaces the spinner area content with the message text (e.g., "Note saved", "URL saved").
  2. Uses the existing `#execution-state` element with a new class `success` (green background token, analogous to `error`).
  3. After 1200ms, dispatches `SUCCESS_TIMEOUT` → CLOSING.
  4. Pressing Escape during SUCCESS_FLASH dismisses immediately.

**FSM change:** In EXECUTING transitions:
```
COMMAND_COMPLETE (no output, has message) → SUCCESS_FLASH  [new state]
COMMAND_COMPLETE (no output, no message) → CLOSING         [existing]
```
SUCCESS_FLASH:
```
SUCCESS_TIMEOUT → CLOSING
ESCAPE → CLOSING
```

**CSS addition in panel.html:**
```css
#execution-state.success {
  background: rgba(52, 199, 89, 0.25); /* green tint */
}
#execution-state.success .spinner { display: none; }
```

**This requires `SUCCESS_FLASH` to be added to the States enum.** It is a lightweight state — no user input is processed in it except Escape. Alternatively it can be modeled as a timed action within CLOSING, but a state is cleaner and testable.

---

### 3.4 Chaining Discoverability (closes Gap I)

The chaining FSM is functionally correct. The fix is in the UI layer.

**Target:**
1. In the results dropdown, the `produces` badge on a command should use a human-readable label when possible, not the raw MIME type. Map `application/json` → "JSON list", `text/csv` → "CSV", `item` → "opens editor", `new-item` → "new note".
2. In OUTPUT_SELECTION mode, add a UI hint below the results list: "Press Enter or → to chain" (small, muted, not interactive).
3. The chain indicator in CHAIN_MODE should show `"Chaining: <title>"` instead of raw MIME type. The `chain-title` span already contains `output.title` — the `chain-mime` span can be replaced with a human-readable label using the same MIME→label map.
4. The chain breadcrumb (`-->` connector in `#chain-steps`) should use `→` (U+2192) instead of ASCII `-->`.

**Implementation:** These are all display changes in `updateResultsUI()`, `updateChainUI()`, and `updateChainStepsUI()`. No FSM changes needed.

---

## 4. Proposed FSM

The current FSM (`state-machine.js`) has 10 states:
`IDLE`, `TYPING`, `RESULTS_OPEN`, `PARAM_MODE`, `EXECUTING`, `OUTPUT_SELECTION`, `CHAIN_MODE`, `CHAIN_POPUP`, `ERROR`, `CLOSING`.

The proposed changes add one new state and modify several transitions.

### 4.1 New State

- `SUCCESS_FLASH` — panel showing a brief success message before closing. Only handles `SUCCESS_TIMEOUT` and `ESCAPE`.

### 4.2 Modified Transitions

**From IDLE:**
- Add: `INPUT (non-empty, hasMatches)` → RESULTS_OPEN [if sticky completion enabled — see Section 5 Q.2a]
  - **Present in existing FSM:** No. IDLE + INPUT goes to TYPING only.
  - **New transition.**

**From TYPING:**
- Change: `INPUT (non-empty, hasMatches)` → RESULTS_OPEN instead of TYPING
  - **Present in existing FSM:** The existing path stays TYPING regardless of matches.
  - **Modified transition.** Guard: `inputNonEmpty && hasMatches`.
- Keep: `INPUT (non-empty, no matches)` → TYPING (unchanged)

**From EXECUTING:**
- Add: `COMMAND_COMPLETE (no output, has message)` → SUCCESS_FLASH, actions: `[hideSpinner, showSuccessMessage]`
  - **Present in existing FSM:** No. The no-output path goes directly to CLOSING.
  - **New transition.** Guard: `!hasChainableOutput && result.message`.
  - Ordering: place this guard BEFORE the existing `no output → CLOSING` fallback.

**From SUCCESS_FLASH (new state):**
- `SUCCESS_TIMEOUT` → CLOSING, actions: `[shutdown]`
- `ESCAPE` → CLOSING, actions: `[hideSuccess, shutdown]`
- `VISIBILITY_HIDDEN` → CLOSING, actions: `[shutdown]`

### 4.3 Unchanged Transitions

All existing transitions in RESULTS_OPEN, PARAM_MODE, CHAIN_MODE, CHAIN_POPUP, OUTPUT_SELECTION, ERROR, CLOSING remain as-is. The proposals in Section 3 that affect visual rendering only (scope chip styling, badge labels, param hint div) require no FSM changes — they are action-side changes.

### 4.4 Complete State List with Change Markers

```
IDLE                – modified (new optional INPUT→RESULTS_OPEN for sticky completion)
TYPING              – modified (INPUT→RESULTS_OPEN when matches exist)
RESULTS_OPEN        – unchanged (transitions correct; visual changes only)
PARAM_MODE          – unchanged (transitions correct; visual changes only)
EXECUTING           – modified (new no-output+message → SUCCESS_FLASH guard)
OUTPUT_SELECTION    – unchanged
CHAIN_MODE          – unchanged
CHAIN_POPUP         – unchanged
ERROR               – unchanged
SUCCESS_FLASH       – NEW STATE
CLOSING             – unchanged
```

### 4.5 Transition Delta Summary

| From | Event | Old Target | New Target | Notes |
|------|-------|-----------|-----------|-------|
| IDLE | INPUT non-empty | TYPING | RESULTS_OPEN | Sticky completion. Optional/pref-gated. |
| TYPING | INPUT non-empty + matches | TYPING | RESULTS_OPEN | Sticky completion. |
| EXECUTING | COMMAND_COMPLETE no output + has message | CLOSING | SUCCESS_FLASH | New success flash state. |
| SUCCESS_FLASH | SUCCESS_TIMEOUT | — | CLOSING | New. |
| SUCCESS_FLASH | ESCAPE | — | CLOSING | New. |

All other transitions in the existing FSM are already correct and should not be modified.

---

## 5. Open Questions — Recommendations

### Q.1 Is the noun layer separate from the parameter system?

**Question:** Nouns (registered via `registerNoun()` in `nouns.js`) generate commands with `params` arrays via `noun-registry.js`. Some commands also define `params` directly (e.g., `list notes` has `params: [{ type: 'tag', multiple: true, prefix: '#' }]`). Are these the same system or should they be distinct?

**Audit finding:** They are structurally the same. Both use the `params` array on a command definition, and both route through `doUpdateParamSuggestions()` → `getSuggestions()` → the completers. Nouns have the additional capability of registering as `query`/`browse`/`open`/`create` handlers that dispatch via pubsub. But from the panel's perspective, they are commands with params, period.

**Recommendation:** Keep them unified. The panel does not need to distinguish noun-generated commands from hand-written commands. The noun system is a registration convenience; the panel's concern is the `params` array shape only.

**Decision required:** Should `noun-registry.js`'s `generateCommandsFromNoun()` inject a `nounType: true` flag on the generated command so the panel can label param suggestions differently (e.g., "choose a group" vs "choose a tag")? Currently `paramDef.type` covers 'tag'/'item'/'enum' but not "this is a noun". This is a minor discoverability enhancement; not required for the gap closures above.

**User must decide:** Yes/No on the `nounType` flag injection.

---

### Q.2 Are scope chips first-class state or a hint?

**Question:** Should the scope chip (`cmd.scope === 'window'` or `'page'`) affect which commands are *shown* in the dropdown (filtering), or should it only be a *display hint* next to commands that are scope-restricted?

**Audit finding:** Currently, mode filtering (`cmd.modes`) exists and works — `isCommandAvailable()` at `panel.js:336–342` checks `cmd.modes` against the current major mode. Scope filtering does not exist. The `cmd.scope` field is metadata only.

**Two options:**
- **Option A (hint only):** Scope chips are display decorations. All scoped commands are always shown; the chip tells the user "this command operates on the current window/page." No FSM change needed.
- **Option B (first-class state):** Scoped commands are only shown when the relevant scope is active (i.e., a page-scoped command only appears when a page window is focused). This would require checking `cmd.scope` in `isCommandAvailable()` — a three-line change — and would reduce noise in the results when the user is in a non-page context.

**Recommendation:** Option A first, Option B as a follow-up. The discoverability improvement of seeing all commands (even scoped ones) outweighs the noise reduction from hiding them. When the user clicks a scoped command in the wrong context, a clear error is better than confusion about "why is that command missing."

**User must decide:** Option A or B.

---

### Q.3 Is chaining worth keeping?

**Question:** The chaining system (CHAIN_MODE, OUTPUT_SELECTION, chain stack, popup) adds significant code complexity. The tests pass, but the UX is hard to discover. Should it be simplified or removed?

**Audit finding:** Chaining is load-bearing for at least two tested user flows: `list urls → csv` and `list notes → csv`. These require CHAIN_MODE to actually function, not just structurally exist. Removing chaining would break `apps/desktop/features/files/` integration and the `csv` command.

**Against removal:**
- The architecture is already built. The FSM states exist, the tests pass, the pubsub routing is plumbed.
- The UX problem is purely discoverability and labeling — fixable without removing the system.
- "list urls → csv" is a genuinely useful capability once discoverable.

**For simplification:**
- The CHAIN_POPUP sub-state (chain-editor.html) is rarely used and has a 300ms hardcoded timing fragility. It could be removed without affecting the main chain flow.
- The OUTPUT_SELECTION → CHAIN_MODE routing with the `hasDownstreamCommands` guard is the most complex part; `docs/cmd-chain-architecture.md` documents this fragility in detail.

**Recommendation:** Keep chaining. Fix the UX (Section 3.4) and deprecate the CHAIN_POPUP path (chain-editor.html) separately. The core CHAIN_MODE flow is functional and tested.

**User must decide:** Keep, simplify (remove CHAIN_POPUP), or remove entirely.

---

## 6. Acceptance Tests

The following test names can be added to the test suite once the implementation is complete. Each maps to one or more of the behavior spec items above.

### 6.1 Visual Affordances

```
TEST: idle-hint — panel opens empty → command-text shows dim hint for top frecency command
TEST: idle-hint-disappears — start typing → hint replaced by ghost completion
TEST: selected-state-visible — navigate to item 3 in results without hovering → item 3 has left-border accent
TEST: selected-not-identical-to-hover — hover item 2, ArrowDown to item 3 → items 2 and 3 look distinct
TEST: param-portion-style — type "list notes #" → command "list notes" in bold, "#" in distinct param style
TEST: scope-chip-color — window-scoped command in results → blue badge; page-scoped → purple badge
TEST: scope-chip-text — results include "window" label not Unicode U+229E symbol
```

### 6.2 Completion and Discoverability

```
TEST: sticky-completion-opens — type "li" → results dropdown opens automatically without ArrowDown
TEST: sticky-completion-updates — type "li" → results open; type "list" → results update in place
TEST: sticky-completion-closes-on-clear — type "li" → results open; backspace to empty → results closed, IDLE
TEST: tab-badge-visible — in RESULTS_OPEN, selected command has params → Tab badge shown on that row
TEST: tab-badge-absent — in RESULTS_OPEN, selected command has no params → no Tab badge shown
TEST: param-hint-shown — Tab completes "list notes " → param hint "Tag · type to filter" shown
TEST: param-hint-hidden — Escape from PARAM_MODE → param hint hidden
TEST: space-trigger-works — type "list notes " (with space) → PARAM_MODE entered if list notes is exact match
```

### 6.3 Command Result Feedback

```
TEST: success-flash-shown — execute "note hello" → SUCCESS_FLASH state, "Note saved" message visible
TEST: success-flash-duration — SUCCESS_FLASH shown → auto-dismisses after ~1200ms → panel closed
TEST: success-flash-escape — SUCCESS_FLASH shown → press Escape → panel closes immediately
TEST: no-flash-for-chain-output — execute "list notes" → no success flash (output selection shown instead)
TEST: no-flash-for-editor-output — execute "edit" → no success flash (editor opens)
TEST: error-after-flash — result.message present but execute throws → ERROR state, not SUCCESS_FLASH
```

### 6.4 Chaining Discoverability

```
TEST: produces-label-readable — results dropdown shows "JSON list" badge not "application/json"
TEST: chain-hint-shown — OUTPUT_SELECTION entered → "Press Enter or → to chain" hint visible
TEST: chain-indicator-label — CHAIN_MODE entered → chain indicator shows title, not raw MIME type
TEST: chain-breadcrumb-arrow — CHAIN_MODE with 2 steps → breadcrumb uses → not -->
```

### 6.5 Regression Tests (Existing Behavior Must Not Break)

```
TEST: tab-no-space-enters-param-mode — type "list" → Tab → PARAM_MODE entered (existing behavior)
TEST: enter-executes-without-param — type "notes" → Enter → EXECUTING (no param required)
TEST: escape-layering-full — type "list notes " (param mode) → Escape → TYPING; Escape → IDLE; Escape → CLOSING
TEST: chain-flow-still-works — list urls → OUTPUT_SELECTION → Enter → CHAIN_MODE (canonical chain test still passes)
TEST: url-direct-open — type "https://example.com" → Enter → URL opens
TEST: hashtag-search — type "#todo" → Enter → search view opens
```

---

## 7. Stale Docs Note

`docs/cmd-state-machine.md` (the original planning doc) describes the FSM as it was *proposed*, not as it is now implemented. Several discrepancies:

1. The doc describes `state.paramMode`, `state.chainMode`, `state.outputSelectionMode` as boolean flags (§1.3). These are gone — the implementation uses `machine.getState()` comparisons via the FSM module.
2. The doc lists bugs (§1.4) including "click handler bypasses state machine" — this is fixed; click handlers now dispatch through the FSM.
3. The doc's §4.4 "Migration Path" describes a 5-phase plan. The migration is complete; the FSM module (`state-machine.js`) is the canonical implementation.
4. `docs/cmd-chain-architecture.md` is more current but still references some guard-order ambiguities that have since been partially resolved. The "redesign sketch" at the bottom (§Redesign sketch) describes the current implementation's behavior correctly: array output always enters OUTPUT_SELECTION first.

Use this document (`cmd-palette-spec.md`) as the canonical reference going forward.

---

*End of Phase 1 spec. File: `docs/cmd-palette-spec.md`.*

---

## History

The sections below record how things stood when this document was written. They are kept for their reasoning and are not current guidance.

## 1. Current Behavior — Per User-Visible State

### 1.1 Panel Closed

Nothing visible. The panel window exists in memory (keepLive=true, created once, hidden between uses). On the next Cmd+K the window is shown and `VISIBILITY_SHOWN` is dispatched → `resetAllState()` → FSM enters IDLE.

**Relevant code:** `panel.js:2736–2740` (`api.onVisible` handler), `state-machine.js:695–699` (CLOSING → IDLE on VISIBILITY_SHOWN).

---

### 1.2 Panel Open, Input Empty (IDLE)

**What the user sees:**
- Translucent pill, 60 px tall.
- Placeholder text "Feed meeeee".
- Ghost-text overlay (`#command-text`) is empty.
- Mode chip is hidden when mode = "default" — CSS `display: none` on `[data-mode="default"]` (panel.html:513–515).
- No results dropdown.

**Gestures:**
- Any printable character → TYPING.
- ArrowDown → RESULTS_OPEN only if `matches.length > 0` (no matches yet, so no-op effectively).
- Escape → CLOSING (panel hides).
- Enter → no-op.
- Tab → no transition defined in IDLE; Tab in the browser may shift focus to the browser chrome. **This is a gap** — Tab in IDLE has no FSM handler.

---

### 1.3 TYPING — User Has Typed, No Results Dropdown

**What the user sees:**
- Input text rendered in `#command-text` as two-tone: the user-typed portion in `--theme-text` (bold), the ghost completion remainder in `--theme-text-muted` (dim). See `panel.js:1608–1651`.
- No dropdown unless ArrowDown is pressed.
- The ghost completion shows the *first match* from `findMatchingCommands()`, not the selection the user has navigated to (those are the same when no navigation has happened yet).

**Gestures:**
- Typing more chars → stays TYPING, recomputes matches + ghost text.
- Clearing all text → IDLE.
- ArrowDown (matches exist) → RESULTS_OPEN; `showResults = true`.
- Tab (command has params, text partially matches) → PARAM_MODE immediately, filling `command + space` into input. See `state-machine.js:287–297`.
- Tab (no params) → stays TYPING, fills `command + space`, cycles on repeated Tab. See `state-machine.js:298–305`.
- Enter + URL → CLOSING (opens URL).
- Enter + all-hashtag tokens → CLOSING (opens search view).
- Enter + committed command (text equals or starts with the command name + space, OR `showResults=true`, OR in CHAIN_MODE) → EXECUTING. Guard `userCommittedToCommand` at `panel.js:2653–2658`.
- Enter + nothing committed, not URL, not hashtags → **no-op**. No search fallback, by design (comment at `state-machine.js:326–330`).
- Escape (text non-empty) → IDLE (clears text).
- Escape (text empty) → CLOSING.
- Shift+Tab → cycles backward through matches (stays TYPING).

**Key gap:** In TYPING, typing `list` shows ghost completion for "list notes" or "list urls" but the dropdown is not shown unless the user presses ArrowDown. There is no mode where typing alone opens and maintains the dropdown. The ghost text gives one suggestion; the full ranked list is behind a gesture the user may not know to use.

---

### 1.4 RESULTS_OPEN — Dropdown Visible

**What the user sees:**
- `#results` div has class `visible`; up to ~50 command items rendered.
- Each item: `.cmd-name` (bold), `.cmd-desc` (muted), `.cmd-badges` (float right, scope/chain badges).
- The item at `state.matchIndex` gets class `selected` (CSS `background-color: var(--cmd-surface-selected)`).
- Scope badges: window commands get `⊞` (U+229E), page commands get `⧉` (U+29C9). Rendered only when `cmd.scope !== 'global'`. See `panel.js:1760–1772`.
- Chain badges: in CHAIN_MODE, `accepts` badge `← mimeType` shown. In any state, `produces` badge `→ mimeType` shown.
- URL search results appear below a "Visited Pages" separator after 150ms debounce when `showUrlsInResults` pref is on. These URL items do NOT have a `selected` CSS class and cannot be keyboard-navigated (they are not in `state.matches`). **This is a gap.**

**Gestures:**
- ArrowDown / ArrowUp → navigate `matchIndex`, re-render.
- Tab → cycles matches (`tabCycleInResults`), OR if command has params and text already matches command name → enters PARAM_MODE. See `state-machine.js:377–390`.
- Enter → EXECUTING (executes `state.matches[matchIndex]`).
- Click a result item → EXECUTING.
- Any character input → TYPING (hides results, recomputes).
- Escape → TYPING (hides results, does NOT clear text).

**Visual gap — "selected" vs "hovered":** The CSS rules are:
```css
.command-item:hover    { background-color: var(--cmd-surface-hover);    }  /* lighter */
.command-item.selected { background-color: var(--cmd-surface-selected); } /* slightly darker */
```
Both values are small opacity shifts on the same base color (`rgba(0,0,0, 0.06)` vs `0.10`). In practice these look nearly identical, especially in dark mode. There is no border, no indicator dot, no accent color, nothing that unambiguously marks "this item will execute if I press Enter." See `panel.html:159–165`.

---

### 1.5 PARAM_MODE — Command Committed, Parameter Input Active

**Entry conditions** (two paths):
1. User types `commandName ` (command name + space) and the command has `params`. The `input` handler detects this and dispatches `INPUT` with `enterParamMode=true`. See `panel.js:2533–2553`.
2. Tab pressed in TYPING or RESULTS_OPEN when command has params. See `state-machine.js:287–297`.

**What the user sees:**
- Input contains `commandName ` + whatever the user has typed for the parameter.
- Ghost completion appended after the cursor position shows the first suggestion's remainder text. See `panel.js:1653–1676`.
- The dropdown shows *parameter suggestions*, not command matches. Each suggestion: `.cmd-name` (suggestion title), `.cmd-desc` (subtitle — e.g., "used 3x"). See `panel.js:1688–1718`.
- No visual separator between the command portion and the parameter portion in the input — they appear as one continuous string.
- The command name portion is rendered in `class="typed"` (bold), parameter portion also in `class="typed"` (bold). There is no distinct coloring for "this part is the command" vs "this part is the parameter." See `panel.js:1619–1625`.

**Gestures:**
- Typing → stays PARAM_MODE if text still starts with `commandName `, calls `doUpdateParamSuggestions()` async.
- Backspacing past the space → TYPING (exits PARAM_MODE). Guard `paramInputStillMatches` checks `lowerVal.startsWith(lowerCmd + ' ')`. See `panel.js:2557–2561`.
- ArrowDown / ArrowUp → navigate `paramIndex` (not `matchIndex`).
- Tab → fills the highlighted suggestion text into the input (`fillParamText` action); does NOT execute. See `state-machine.js:450–455`.
- Shift+Tab → fills in reverse.
- Enter (item-type param with suggestions) → `acceptParamItem` → EXECUTING. See `state-machine.js:465–469`.
- Enter (non-item param, or no suggestions) → `executeCommandWithParams` → EXECUTING. See `state-machine.js:470–474`.
- Escape → back to TYPING (keeps typed text, exits param).

**Key gap — trailing-space requirement is invisible:**
- The transition from TYPING to PARAM_MODE requires a literal space after the command name. Typing `list<Tab>` in TYPING completes to `list ` (with the space) and immediately enters PARAM_MODE. That part works.
- However, typing `list` and pressing Enter has the `userCommittedToCommand` guard check `typedLower === nameLower || typedLower.startsWith(nameLower + ' ')`. Typing exactly `list` satisfies `typedLower === 'list'` (assuming "list notes" or "list urls" is not the exact match — if there's a bare "list" command it would match, but there isn't). So Enter on `list` without the trailing space may fail to commit.
- More precisely: if the user types `list` and presses Tab (no Shift), and `list notes` is the top match, Tab fills `list notes ` and enters PARAM_MODE. This works. But if the user types `list ` manually (with space) for a command like `list notes` — the space triggers `enterParamMode` only if the FULL command name is already in the input (`list notes `, not `list `). Typing `list ` when the command is `list notes` does NOT enter param mode; `list ` does not start with `list notes `. This is correct behavior but confusing: `list<Tab>` works, `list<Space>` may not if there are multiple matches.
- There is no affordance telling the user to press Tab instead of Space when a command needs a parameter.

**Key gap — no command-vs-param visual distinction:**
The ghost text in param mode appends the suggestion after the cursor without any visual separator. A user who has typed `list notes ` has no way to see which part of the text is "the committed command" vs "the parameter being completed." Both are in the same font, same color, same weight.

---

### 1.6 Scope Chips — Current State

The `cmd-badge-scope` span is appended to result items in `updateResultsUI()` when `cmd.scope !== 'global'`. See `panel.js:1757–1772`. The badges use Unicode box-drawing characters as icons: `⊞` for window scope, `⧉` for page scope.

**What is implemented:**
- Badges render in the results dropdown only.
- Badge text is a Unicode symbol with a tooltip (`title` attribute).
- CSS: float-right, 10px font, 60% opacity.

**What is NOT implemented:**
- No scope chip in the input area itself.
- No filtering of results by scope (mode filtering via `cmd.modes` exists, but that is different from `cmd.scope`).
- The badge has no color distinction between window vs page scope.
- There is no visual in the collapsed (no-results) state indicating that the current command is scoped.

The user's complaint is accurate: scope chips render in the panel but aren't fully designed or implemented. They exist as small dimmed Unicode characters in the results list — not the first-class "chip" UI the user is imagining.

---

### 1.7 EXECUTING — Command Running

**What the user sees:**
- If the command takes > 150ms: `#execution-state` div gets class `visible`, showing a CSS spinner and text `Running "commandName"...`. See `panel.js:1094–1110`.
- The results dropdown is hidden. The input is cleared.
- No other feedback until the command completes or errors.

**On completion:**
- No output → panel closes (CLOSING). User sees nothing.
- Single `item`/`new-item` output → editor opens, panel closes.
- Array output → OUTPUT_SELECTION (see 1.8).
- Chainable output → CHAIN_MODE (see 1.9).
- Error → ERROR state (see 1.11).

**Key gap — no visual response/result:**
When a command succeeds with no output (e.g., "note something" saves a note), the panel simply closes. There is no confirmation message, no toast, no flash of "Saved." The only feedback is absence — the panel disappeared. If the user is not watching the notes list, they have no way to know the command worked.

The `result.message` field exists on command results (e.g., `"Note saved"` in `apps/desktop/renderer/cmd/commands/note.js:198`) but it is never displayed in the panel. The `showExecutionState` and `showExecutionError` functions exist, but there is no `showExecutionSuccess` equivalent. Success paths route directly to CLOSING without surfacing the message.

---

### 1.8 OUTPUT_SELECTION — Array Results to Choose From

**What the user sees:**
- Results list shows the array items, each with `.cmd-name` (title) and `.cmd-desc` (object keys preview).
- The selected item index gets `class="selected"`.
- A preview panel (`#preview-container`) shows a rendered preview of the selected item.

**Gestures:**
- ArrowDown / ArrowUp → navigate `outputItemIndex`.
- Enter / ArrowRight → select item → may open editor (if mimeType=item) or enter CHAIN_MODE.
- Escape → IDLE.

---

### 1.9 CHAIN_MODE — Piping Output Between Commands

**What the user sees:**
- `#chain-indicator` (blue pill) shows mimeType badge and title of the chained data.
- `#chain-steps` shows the history as a breadcrumb: `step1 --> step2 --> (active step)`.
- Input is cleared, suggestions filtered to commands whose `accepts` includes the current mimeType.
- Results dropdown shown.

**Gestures:**
- Type to filter chain commands.
- Tab → cycle/complete a chain command name.
- Enter → EXECUTING with chain context (`ctx.input`, `ctx.inputMimeType`, etc.).
- Escape (stack depth > 1) → undo one step (pop chain stack).
- Escape (stack depth == 1) → exit chain mode entirely → IDLE.
- Click cancel button → IDLE.

**Functional status (re: "chaining is broken"):**
The chaining tests in `apps/desktop/tests/desktop/command-chaining.spec.ts` and `apps/desktop/tests/desktop-serial/cmd-chain.spec.ts` do pass at the unit/integration level. The FSM transitions exist and are wired. "Broken" in the user's sense is UX-broken, not functionally broken:
- The chain indicator shows a raw MIME type string (e.g., `application/json`) which is developer-readable, not user-readable.
- The chain breadcrumb shows source command names in monospace, which is functional but stark.
- There is no way to *start* a chain without first executing a command that returns chainable output. There is no explicit "pipe" affordance.
- The chaining tests confirm the FSM transitions work; the user experience of discovering and using chaining is what's broken.

---

### 1.10 CHAIN_POPUP — Interactive Chain Editor

Not covered in this spec. The popup (chain-editor.html) is for text editing of chain data. The 300ms hardcoded delay before sending content is a known fragility (`panel.js:786`, comment "TODO: Replace with proper ready signaling").

---

### 1.11 ERROR State

- `#execution-state` gets class `error` (red background).
- Error text shown for 5 seconds, then auto-dismissed to IDLE.
- Typing resumes from ERROR → TYPING.

---

### 1.12 Summary of Gesture Table (all states, collapsed)

| Gesture | IDLE | TYPING | RESULTS_OPEN | PARAM_MODE | CHAIN_MODE |
|---------|------|--------|--------------|------------|------------|
| Char input | → TYPING | stays TYPING | → TYPING | stays PARAM | stays CHAIN |
| Backspace to empty | — | → IDLE | → IDLE | → IDLE | stays CHAIN |
| ArrowDown | (no-op if no matches) | → RESULTS_OPEN | navigate down | navigate param down | navigate down |
| ArrowUp | — | — | navigate up | navigate param up | navigate up |
| Tab | — | → PARAM / cycle | → PARAM / cycle | fill param text | complete chain cmd |
| Shift+Tab | — | cycle backward | — | fill param reverse | — |
| Enter | no-op | execute / URL / no-op | execute | execute param | execute chain cmd |
| Escape | → CLOSING | clear / → CLOSING | → TYPING | → TYPING | undo / → IDLE |
| Click result | — | — | execute | execute param | execute chain |

---

## 2. Gap Analysis

### 2.1 Lost Visual Affordances

**Gap A: No signal that a suggestion is *possible* when panel is open.**
- Current: Ghost text only appears if there is at least one match AND the user has typed something. In IDLE the panel is empty. There is no affordance saying "commands are available."
- Code location: `updateCommandUI()` at `panel.js:1559–1679` — returns early if `state.typed` is falsy (`panel.js:1563`).
- Root cause: Ghost text is driven by `state.typed` and `state.matches`. Nothing fires on empty input.

**Gap B: No unambiguous "selected" state in the dropdown.**
- Current: `var(--cmd-surface-hover)` = `rgba(0,0,0,0.06)` (hover), `var(--cmd-surface-selected)` = `rgba(0,0,0,0.10)` (keyboard selected). In dark mode these are near-identical.
- Code location: `panel.html:159–165`.
- Root cause: Both states use opacity-only differentiation. No border, no accent, no left-bar, no icon.

**Gap C: No visual separation of command portion vs parameter portion.**
- Current: Both the command name and the parameter text are in `class="typed"` (bold, full-color). See `panel.js:1609–1625`.
- Root cause: `updateCommandUI()` wraps `typedCommand` and `typedParams` in the same `typed` class. There is no distinct class for the committed command name.

**Gap D: Scope chips are not designed.**
- Current: Exist as dimmed Unicode symbols in the results dropdown. Not in input area, not color-coded, not first-class.
- Code location: `panel.js:1757–1772`.

---

### 2.2 Completion and Discoverability

**Gap E: Trailing-space requirement is invisible.**
- The transition to PARAM_MODE requires the user to have typed `commandName ` (with trailing space) or pressed Tab. Tab works in TYPING and RESULTS_OPEN. But if the user types `list notes` and presses Enter (no space, no Tab), the guard `userCommittedToCommand` is satisfied (exact name match), the command executes without parameters, and all notes are returned (the command defaults to listing all if `ctx.search` is empty). This is functionally correct but the user doesn't know they could have typed `list notes #todo` to filter.
- More critically: if the user types a partial like `list ` (intending `list notes` with a tag), nothing happens — the space after `list` does not trigger param entry because `list ` does not match `list notes ` exactly.
- Code location: `panel.js:2533–2553` (param detection in input handler), `state-machine.js:263–275` (TYPING INPUT transitions).

**Gap F: No sticky/always-open completion.**
- Current: Results dropdown requires ArrowDown to open, even when there are matches. Typing does not auto-open the dropdown.
- Code location: `state-machine.js:263–275`. The `inputNonEmpty` path goes to TYPING (not RESULTS_OPEN). Only `ARROW_DOWN` opens results from TYPING.
- Root cause: Deliberate design decision at some point. The user now wants to revisit it.

**Gap G: Noun vs string parameter distinction not surfaced.**
- Current: `paramDef.type` can be `'tag'`, `'enum'`, or `'item'`. All three show suggestions in the dropdown. But there is no visual indicator in the input saying "you are now providing a tag" vs "you are typing free text."
- Code location: `completers.js:166–177` (getSuggestions router), `panel.js:1688–1718` (dropdown renderer). The `paramDef` shape is not exposed in the UI.

---

### 2.3 Command Result Feedback

**Gap H: No standard visual result/reply in the panel.**
- Current: `result.message` exists on command return objects (`apps/desktop/renderer/cmd/commands/note.js:198`: `"Note saved"`, `"URL saved"`, etc.) but is never rendered. All success paths go directly to CLOSING or to OUTPUT_SELECTION.
- Code location: `doExecute()` at `panel.js:1188–1220`. The `result` object is passed to `machine.dispatch(Events.COMMAND_COMPLETE, payload)` but only `result.output` is checked; `result.message` is discarded.
- Root cause: No `showExecutionSuccess` function exists. `hideExecutionState()` and `hideExecutionState` don't display the message before hiding.

---

### 2.4 Chaining

**Gap I: Chaining is UX-broken, not functionally broken.**
- The FSM handles chaining correctly (tests pass). But:
  1. There is no way for a user to *discover* chaining. Nothing in the UI says "this command produces output you can pipe."
  2. The chain indicator shows raw MIME types (`application/json`), not user-readable labels.
  3. The chain breadcrumb (`-->` connector) is ASCII, monospace, technical.
  4. There is no verb in the UI. The user doesn't know to "press Enter on a result to continue the chain." The OUTPUT_SELECTION state presents a list of items but no affordance saying "select one to chain."
  5. The `produces` badge in the results dropdown (`→ mimeType`) is the only discoverability hint, and it's 10px, 60% opacity.
- Code location: `updateResultsUI()` panel.js:1775–1783 (produces badge), `updateChainUI()` panel.js:946–958 (chain indicator).

---
