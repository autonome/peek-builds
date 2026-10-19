# Cmd Bar State Machine Design

The machine described here is implemented in
`apps/desktop/renderer/cmd/state-machine.js` and driven by
`apps/desktop/renderer/cmd/panel.js`. Section 1 (the analysis of the panel
before the machine existed) and sections 3–4 (the test plan and migration path
that got it there) are under "History" at the bottom; section numbering is kept
as written.

## 2. State Machine Specification

### 2.1 States

The cmd bar can be in exactly one of these states at any time:

| State | Description | Entry Condition |
|-------|-------------|-----------------|
| **IDLE** | Panel visible, input empty, no results shown | Panel shown (visibility change), or all content cleared |
| **TYPING** | User is typing, matches being computed, ghost text visible | Any character input when in IDLE or TYPING |
| **RESULTS_OPEN** | Results dropdown visible, user can navigate with arrows | ArrowDown when matches exist, or chain mode active with matches |
| **PARAM_MODE** | Command committed, showing parameter suggestions | Tab-complete or typed `commandName + space` for a command with params |
| **EXECUTING** | A command is running (async), spinner may be visible | Enter/click triggers execute() |
| **OUTPUT_SELECTION** | Showing array output items for user selection | Command returned array output with item/new-item mimeType or no downstream commands |
| **CHAIN_MODE** | Piping output between commands, chain indicator visible | Command returned chainable output with downstream consumers |
| **CHAIN_POPUP** | Chain popup window open for interactive editing | Chain mode entered with text/* output |
| **ERROR** | Execution failed, error message displayed | Command threw or timed out |
| **CLOSING** | Panel is shutting down | shutdown() called |

### 2.2 State Transition Diagram

```
                        +---------+
           panel shown  |  IDLE   |  panel hidden
          +------------>|         |<-----------+
          |             +----+----+            |
          |                  |                 |
          |          typing  |  ArrowDown      |
          |          chars   |  (matches>0)    |
          |                  v                 |
          |             +--------+             |
          |             | TYPING |<------+     |
          |             +---+----+       |     |
          |                 |            |     |
          |     ArrowDown   | input      |     |
          |     (matches>0) | changed    |     |
          |                 v            |     |
          |          +-----------+       |     |
          |          | RESULTS   |-------+     |
          |          | _OPEN     | typing      |
          |          +-----+-----+             |
          |                |                   |
          |   Tab/typed    | Enter/click       |
          |   cmd+space    |                   |
          |   (has params) |                   |
          |        v       v                   |
          |  +-----------+  +-----------+      |
          |  | PARAM     |  | EXECUTING |      |
          |  | _MODE     |  +-----+-----+      |
          |  +-----+-----+       |             |
          |        |        +----+----+----+   |
          |  Enter |        |    |    |    |   |
          |  (item)|  no    | array  chain | error
          |        |  output| output output|   |
          |        v  v     v    v    v    v   |
          |  +-----------+ +------+ +------+ +-+-----+
          |  | EXECUTING | |OUTPUT| |CHAIN | | ERROR |
          |  +-----------+ |SELECT| |_MODE | +-------+
          |                +------+ +--+---+
          |                         |
          |                   text/*|output
          |                         v
          |                  +----------+
          |                  |CHAIN     |
          |                  |_POPUP    |
          |                  +----------+
          |
          +--- Escape (layered: paramMode > outputSelect > chain > results > text > close)
```

### 2.3 Transitions

Each transition is defined as: `(CurrentState, Event) -> (NextState, Actions, Guards)`

#### From IDLE

| Event | Guard | Next State | Actions |
|-------|-------|------------|---------|
| `input` (non-empty) | -- | TYPING | Set `typed`, compute matches, update ghost text UI |
| `ArrowDown` | matches.length > 0 | RESULTS_OPEN | Set `showResults=true`, render results list |
| `Escape` | -- | CLOSING | Call `shutdown()` |
| `Enter` | input empty | IDLE | No-op (log "empty input") |
| `visibility:hidden` | -- | CLOSING | Window hidden by system |

#### From TYPING

| Event | Guard | Next State | Actions |
|-------|-------|------------|---------|
| `input` (changed) | text non-empty | TYPING | Recompute matches, check param mode entry, update UI |
| `input` (cleared) | text empty | IDLE | Clear matches, exit param mode if active, update UI |
| `ArrowDown` | matches.length > 0 | RESULTS_OPEN | Set `showResults=true`, render results |
| `Tab` | matches.length > 0, cmd has params | PARAM_MODE | Complete command name + space, enter param mode |
| `Tab` | matches.length > 0, no params | TYPING | Complete command name + space, cycle if already completed |
| `Enter` | typed is URL | CLOSING | Open URL, record frecency, shutdown |
| `Enter` | user committed to command | EXECUTING | Build context, call `execute()` |
| `Enter` | no match, text non-empty | CLOSING | Open search view, shutdown |
| `Escape` | results visible | TYPING | Dismiss list, keep text (drop the inline ghost) |
| `Escape` | text non-empty | IDLE | Clear input and matches |
| `Escape` | text empty | CLOSING | Call `shutdown()` |
| `input` (typed matches `cmdName + space`, cmd has params) | -- | PARAM_MODE | Enter param mode while typing continues |

#### From RESULTS_OPEN

| Event | Guard | Next State | Actions |
|-------|-------|------------|---------|
| `input` (changed) | -- | TYPING | Recompute matches, `showResults=false` |
| `ArrowDown` | matchIndex < matches.length - 1 | RESULTS_OPEN | Increment matchIndex, update selection |
| `ArrowUp` | matchIndex > 0 | RESULTS_OPEN | Decrement matchIndex, update selection |
| `Tab` | cmd has params | PARAM_MODE | Complete selected command, enter param mode |
| `Tab` | no params | RESULTS_OPEN | Cycle through matches |
| `Enter` | user committed | EXECUTING | Execute selected command |
| `click` (result item) | -- | EXECUTING | Set matchIndex, execute command |
| `Escape` | -- | TYPING | Dismiss list, keep text |

#### From PARAM_MODE

| Event | Guard | Next State | Actions |
|-------|-------|------------|---------|
| `input` (changed) | text still starts with `cmdName + space` | PARAM_MODE | Update param suggestions async |
| `input` (changed) | text no longer matches command | TYPING | Exit param mode, recompute matches |
| `input` (cleared) | -- | IDLE | Exit param mode, clear everything |
| `ArrowDown` | paramSuggestions.length > 0 | PARAM_MODE | Increment paramIndex |
| `ArrowUp` | paramIndex > 0 | PARAM_MODE | Decrement paramIndex |
| `Tab` | paramSuggestions.length > 0 | PARAM_MODE | Fill suggestion text into input (do NOT execute) |
| `Enter` | item-type param, suggestions exist | EXECUTING | Accept param suggestion, route through `execute()` with `selectedItem` |
| `Enter` | non-item param | EXECUTING | Execute command with current typed text as params |
| `Escape` | -- | TYPING | Exit param mode, keep typed text |
| `click` (suggestion) | -- | EXECUTING | Accept param suggestion (item-type) or fill + execute |

#### From EXECUTING

| Event | Guard | Next State | Actions |
|-------|-------|------------|---------|
| `command_complete` | no output | CLOSING | Exit chain mode if active, shutdown after 100ms |
| `command_complete` | output mimeType = item/new-item, single | CLOSING | Publish `editor:open`/`editor:add`, shutdown |
| `command_complete` | output mimeType = item/new-item, array | OUTPUT_SELECTION | Enter output selection mode |
| `command_complete` | output with downstream commands, array | CHAIN_MODE | Enter chain mode with full array |
| `command_complete` | output with downstream commands, single | CHAIN_MODE | Enter chain mode |
| `command_complete` | output, no downstream, array | OUTPUT_SELECTION | Enter output selection mode |
| `command_complete` | result.action = 'prompt' | IDLE | Keep panel open for user interaction |
| `command_error` | -- | ERROR | Show error message, clear timers |
| `command_timeout` | 30s elapsed | ERROR | Show timeout error |
| `cancel_click` | -- | IDLE | Hide execution state |
| `Escape` | -- | IDLE | Cancel execution (Note: currently not handled during execution) |

#### From OUTPUT_SELECTION

| Event | Guard | Next State | Actions |
|-------|-------|------------|---------|
| `ArrowDown` | outputItemIndex < outputItems.length - 1 | OUTPUT_SELECTION | Navigate down, update preview |
| `ArrowUp` | outputItemIndex > 0 | OUTPUT_SELECTION | Navigate up, update preview |
| `Enter` / `ArrowRight` | mimeType = item, item has id | CLOSING | Open editor, shutdown |
| `Enter` / `ArrowRight` | other mimeType | CHAIN_MODE | Enter chain mode with selected item |
| `click` (item) | -- | (same as Enter) | Select and proceed |
| `Escape` | -- | IDLE | Exit output selection mode, clear input |

#### From CHAIN_MODE

| Event | Guard | Next State | Actions |
|-------|-------|------------|---------|
| `input` (typing) | -- | CHAIN_MODE | Filter matches to chain-compatible commands |
| `ArrowDown` | -- | CHAIN_MODE | Navigate chain command list |
| `ArrowUp` | -- | CHAIN_MODE | Navigate chain command list |
| `Tab` | -- | CHAIN_MODE | Complete chain command name |
| `Enter` | command selected | EXECUTING | Execute chain command with chain context |
| `Escape` | chainStack.length > 1 | CHAIN_MODE | Undo one step (pop stack) |
| `Escape` | chainStack.length <= 1 | IDLE | Exit chain mode entirely |
| `chain_cancel_click` | -- | IDLE | Exit chain mode, clear input |
| `popup_result` | popup signals done | CLOSING | Shutdown |
| `popup_result` | popup returns data | CHAIN_MODE | Update chain context, show commands |

#### From CHAIN_POPUP

| Event | Guard | Next State | Actions |
|-------|-------|------------|---------|
| `popup:result` | msg.done = true | CLOSING | Shutdown |
| `popup:result` | msg.done = false | CHAIN_MODE | Update chain context, refocus panel |
| `Escape` | -- | CHAIN_MODE | Close popup, return to chain commands |

#### From ERROR

| Event | Guard | Next State | Actions |
|-------|-------|------------|---------|
| `timeout` (5s auto-hide) | -- | IDLE | Hide error state |
| `input` | -- | TYPING | Hide error, start typing |
| `Escape` | -- | IDLE | Hide error state |

#### From CLOSING

Terminal state. Panel hides and resets on next visibility change -> IDLE.

### 2.4 Guards

Guards are boolean conditions that determine which transition fires when multiple transitions share the same (State, Event) pair:

| Guard | Condition |
|-------|-----------|
| `hasMatches` | `state.matches.length > 0` |
| `hasParamSuggestions` | `state.paramSuggestions.length > 0` |
| `commandHasParams` | `cmd.params && cmd.params.length > 0` |
| `isItemTypeParam` | `paramDef.type === 'item'` |
| `isURL` | `getValidURL(typed).valid` |
| `userCommittedToCommand` | Typed equals command name, or starts with `cmdName + space`, or `showResults` is true, or in chain mode |
| `hasChainableOutput` | `result.output && result.output.data && result.output.mimeType` |
| `hasDownstreamCommands` | `findChainingCommands(mimeType).length > 0` |
| `isArrayOutput` | `Array.isArray(outputData) && outputData.length > 0` |
| `isEditorMimeType` | `mimeType === 'item' || mimeType === 'new-item'` |
| `isNotExecuting` | `!state.executing` (currently unenforced) |
| `inputEmpty` | `!commandInput.value` |
| `inputNonEmpty` | `commandInput.value.trim().length > 0` |

### 2.5 Actions

Side effects that occur during transitions:

| Action | Description |
|--------|-------------|
| `computeMatches(typed)` | Run `findMatchingCommands()` with adaptive/frecency sorting |
| `updateGhostText()` | Render the two-tone command suggestion overlay |
| `renderResults()` | Build and show the results dropdown |
| `hideResults()` | Remove results dropdown |
| `enterParamMode(cmdName)` | Set param state, begin async suggestion fetching |
| `exitParamMode()` | Clear param state |
| `fillParamText(index)` | Insert suggestion text into input without executing |
| `acceptParam(index)` | Execute command with selected param item |
| `executeCommand(name, typed, extra)` | Build context, run command, handle output |
| `recordFrecency(name, typed)` | Update adaptive feedback and match counts |
| `showSpinner(name)` | Show execution progress (delayed 150ms) |
| `hideSpinner()` | Hide execution progress |
| `showError(name, msg)` | Show error state with auto-hide timer |
| `enterOutputSelection(items, mime, source)` | Switch to output picking UI |
| `exitOutputSelection()` | Clear output selection state |
| `enterChainMode(output, source)` | Set chain context, filter to compatible commands |
| `exitChainMode()` | Clear chain state, close popups |
| `openChainPopup(url, data, mime)` | Open interactive editor popup |
| `resizeWindow()` | Adjust window height based on visible content |
| `openURL(url)` | Open URL in new content window |
| `openSearch(query)` | Open search view with typed text |
| `publishEditorOpen(itemId)` | Publish `editor:open` event |
| `shutdown()` | Close/hide the panel window |
| `resetAllState()` | Reset all state fields to defaults (on panel re-show) |

### 2.6 Invariants

The state machine must maintain these invariants at all times:

1. **Mutual exclusivity of major modes**: Exactly one of `{paramMode, outputSelectionMode, chainMode}` can be true, or all are false. They cannot overlap.
2. **paramCommand requires paramMode**: If `paramMode` is false, `paramCommand` must be null.
3. **chainContext requires chainMode**: If `chainMode` is false, `chainContext` must be null and `chainStack` must be empty.
4. **executing blocks new execution**: While `executing` is true, no new `execute()` call should be started.
5. **matchIndex in bounds**: `matchIndex` must be `>= 0` and `< matches.length` (or 0 when matches is empty).
6. **paramIndex in bounds**: `paramIndex` must be `>= -1` and `< paramSuggestions.length`.
7. **outputItemIndex in bounds**: When in output selection mode, `outputItemIndex >= 0` and `< outputItems.length`.
8. **Escape layering order**: Escape always exits the innermost active mode first: paramMode -> outputSelection -> chainMode -> visible results -> clearText -> close. One press peels exactly one layer — a visible dropdown is dismissed with the typed text left intact.

---

---

## History

The sections below record how things stood when this document was written. They are kept for their reasoning and are not current guidance.

## 1. Current State Analysis

### 1.1 Recent Changes (Last Week)

Four commits touched cmd bar code in the past week, each addressing regressions or behavioral inconsistencies:

**`oyvpktvp` — fix(cmd): restore param mode for connector commands, route item selection through execute**
- Problem: Param mode (`edit` command's autocomplete) was bypassing `execute()` and directly publishing `editor:open`, which broke chaining, output handling, and lazy extension loading.
- Fix: `acceptParamSuggestion()` now routes item-type params through `execute()`. Added comments clarifying that param mode should enter for any command with `params`, including connector commands.
- Regression risk: The routing change means `execute()` must handle `selectedItem` in context, which was not part of the original contract.

**`ourylmsr` — fix(cmd): editor:open lazy-load interceptor + cmd palette blink on hotkey**
- Problem: When cmd panel fires `editor:open` before the editor extension is loaded, the event is lost. Also, the cmd panel would briefly flash visible then hide when triggered by hotkey while app was not focused (because `did-resign-active` was hiding all `alwaysOnTop` windows, including focusable ones like the cmd panel).
- Fix: Added `registerLazyEventInterceptors()` in main.ts to catch `editor:open`/`editor:add` and load the editor extension first. Fixed `did-resign-active` to skip focusable `alwaysOnTop` windows.
- Note: This fix is in main.ts, not panel.js, but it papers over a sequencing issue that a state machine should address (executing a command before its target extension is loaded).

**`llsxksrz` — fix(cmd): param mode Tab fills text, Enter executes with correct item identity**
- Problem: Tab in param mode was executing the command (calling `acceptParamSuggestion`), and Enter was passing item identity by search text (which could match the wrong item).
- Fix: Split into `fillParamSuggestion()` (Tab, text-only) and `acceptParamSuggestion()` (Enter, executes). Enter now passes `selectedItem` directly through `execute()`. The `edit` command checks `ctx.selectedItem` first.
- New tests added for Tab-fills and Enter-executes semantics.

**`nlxwwmyv` — fix(cmd): restore two-tone inline suggestion styling (bold typed, dim completion)**
- Problem: After Tab-cycling through suggestions, the inline ghost text was using `state.typed` (which now contains the completed command name) for the highlight boundary, making everything bold.
- Fix: Introduced `state.originalTyped` tracking and used it in `updateCommandUI()` so the bold/dim split reflects what the user actually typed, not what Tab inserted.

### 1.2 Architecture Overview

The cmd bar system spans three execution contexts:

1. **Background process** (`background.js`): Owns the command registry. Handles registration/unregistration from other extensions. Opens the panel window.
2. **Panel window** (`panel.js` + `commands.js`): The interactive UI. Maintains local command copies via pubsub proxy. Handles all user interaction.
3. **Commands module** (`commands.js`): Bridges background registry to panel. Creates proxy commands that execute via pubsub round-trip.

The panel is a `keepLive` window -- it is created once and reused by hiding/showing. On visibility change, all modes are reset.

### 1.3 Current State Fields (from `panel.js`)

```javascript
state = {
  // Command matching
  commands: {},           // Object map of command name -> command object
  matches: [],            // Commands matching current typed text
  matchIndex: 0,          // Selected match index
  matchCounts: {},        // Frecency counts (persisted)
  adaptiveFeedback: {},   // Adaptive matching data (persisted)
  typed: '',              // Current input text
  originalTyped: '',      // Text before Tab completion
  lastExecuted: '',       // Last executed command name

  // UI visibility
  showResults: false,     // Whether results dropdown is visible

  // Output selection mode
  outputSelectionMode: false,
  outputItems: [],
  outputItemIndex: 0,
  outputMimeType: null,
  outputSourceCommand: null,

  // Chain mode
  chainMode: false,
  chainContext: null,      // { data, mimeType, title, sourceCommand }
  chainStack: [],

  // Param mode
  paramMode: false,
  paramCommand: null,
  paramSuggestions: [],
  paramIndex: -1,
  paramGeneration: 0,     // Stale async guard

  // Execution
  executing: false,
  executingCommand: null,
  executionTimeout: null,
  executionError: null,
}
```

### 1.4 Current Bugs and Inconsistencies

1. **Escape handler duplication**: Both `api.escape.onEscape()` (IZUI flow, lines 555-606) and `handleSpecialKey()` Escape branch (lines 615-663) implement identical escape-layering logic. If the IZUI escape interception changes, they can drift apart.

2. **No guard against concurrent execution**: `execute()` can be called while a previous command is still running (the `executing` flag is checked nowhere before starting a new execution).

3. **Click handler bypasses state machine**: The click handler on result items (line 2619-2628) calls `execute()` directly and manually updates frecency, duplicating logic from the Enter key path.

4. **`acceptParamSuggestion` for non-item params does not execute**: For non-item-type params (tags, enums), `acceptParamSuggestion()` just fills text and refreshes suggestions -- same as `fillParamSuggestion()`. Enter in param mode only routes through `acceptParamSuggestion` for item-type params (line 670 guard). For tag params, Enter falls through to the normal command execution path, which may or may not work correctly depending on whether the typed text matches the command name.

5. **`originalTyped` not reset on all paths**: `originalTyped` is set in the input handler but not reset when the panel is re-shown via visibility change. It is also not cleared when entering chain mode or output selection mode.

6. **Chain popup timing fragility**: `openChainPopup` uses a hardcoded 300ms delay before publishing content to the popup (line 1210), relying on the popup's ES module loading within that window.

7. **Mode indicator hidden for 'default'**: The CSS rule `display: none` on `[data-mode="default"]` means the mode indicator is invisible most of the time. Mode cycling requires clicking an invisible element first (unless in a non-default mode).

---

## 3. Test Coverage Plan

### 3.1 State Entry/Exit Tests

Each test verifies a single transition fires correctly:

**IDLE transitions:**
- [ ] IDLE + character input -> TYPING (typed set, matches computed)
- [ ] IDLE + ArrowDown with matches -> RESULTS_OPEN
- [ ] IDLE + ArrowDown with no matches -> IDLE (no-op)
- [ ] IDLE + Escape -> CLOSING
- [ ] IDLE + Enter with empty input -> IDLE (no-op)

**TYPING transitions:**
- [ ] TYPING + input changed -> TYPING (matches recomputed)
- [ ] TYPING + input cleared -> IDLE
- [ ] TYPING + ArrowDown -> RESULTS_OPEN
- [ ] TYPING + Tab (has params) -> PARAM_MODE
- [ ] TYPING + Tab (no params) -> TYPING (name completed)
- [ ] TYPING + Tab cycling (already completed) -> TYPING (next match)
- [ ] TYPING + Shift+Tab -> TYPING (previous match)
- [ ] TYPING + Enter with URL -> CLOSING (URL opened)
- [ ] TYPING + Enter with committed command -> EXECUTING
- [ ] TYPING + Enter with no match -> CLOSING (search opened)
- [ ] TYPING + Escape with a visible dropdown -> TYPING (list dismissed, text kept)
- [ ] TYPING + Escape with text -> IDLE (text cleared)
- [ ] TYPING + Escape with empty text -> CLOSING
- [ ] TYPING + typed `cmdName + space` (cmd has params) -> PARAM_MODE (auto-enter)

**RESULTS_OPEN transitions:**
- [ ] RESULTS_OPEN + input changed -> TYPING (results hidden)
- [ ] RESULTS_OPEN + ArrowDown -> RESULTS_OPEN (index incremented)
- [ ] RESULTS_OPEN + ArrowDown at end -> RESULTS_OPEN (no-op)
- [ ] RESULTS_OPEN + ArrowUp -> RESULTS_OPEN (index decremented)
- [ ] RESULTS_OPEN + ArrowUp at 0 -> RESULTS_OPEN (no-op)
- [ ] RESULTS_OPEN + Tab -> RESULTS_OPEN or PARAM_MODE
- [ ] RESULTS_OPEN + Enter -> EXECUTING
- [ ] RESULTS_OPEN + click item -> EXECUTING
- [ ] RESULTS_OPEN + Escape -> TYPING (results hidden, and they stay hidden)

**PARAM_MODE transitions:**
- [ ] PARAM_MODE + input (still matches cmd) -> PARAM_MODE (suggestions updated)
- [ ] PARAM_MODE + input (no longer matches cmd) -> TYPING (param mode exited)
- [ ] PARAM_MODE + input cleared -> IDLE
- [ ] PARAM_MODE + ArrowDown -> PARAM_MODE (paramIndex incremented)
- [ ] PARAM_MODE + ArrowUp -> PARAM_MODE (paramIndex decremented)
- [ ] PARAM_MODE + Tab -> PARAM_MODE (text filled, not executed)
- [ ] PARAM_MODE + Enter (item-type) -> EXECUTING (with selectedItem)
- [ ] PARAM_MODE + Enter (tag-type) -> EXECUTING (with typed params)
- [ ] PARAM_MODE + Escape -> TYPING
- [ ] PARAM_MODE + click suggestion (item-type) -> EXECUTING

**EXECUTING transitions:**
- [ ] EXECUTING + complete (no output) -> CLOSING
- [ ] EXECUTING + complete (item output, single) -> CLOSING (editor opened)
- [ ] EXECUTING + complete (item output, array) -> OUTPUT_SELECTION
- [ ] EXECUTING + complete (chainable output, single) -> CHAIN_MODE
- [ ] EXECUTING + complete (chainable output, array, has downstream) -> CHAIN_MODE
- [ ] EXECUTING + complete (output, array, no downstream) -> OUTPUT_SELECTION
- [ ] EXECUTING + complete (action=prompt) -> IDLE
- [ ] EXECUTING + error -> ERROR
- [ ] EXECUTING + timeout -> ERROR
- [ ] EXECUTING + cancel click -> IDLE

**OUTPUT_SELECTION transitions:**
- [ ] OUTPUT_SELECTION + ArrowDown -> OUTPUT_SELECTION (navigate)
- [ ] OUTPUT_SELECTION + ArrowUp -> OUTPUT_SELECTION (navigate)
- [ ] OUTPUT_SELECTION + Enter (item type) -> CLOSING (editor)
- [ ] OUTPUT_SELECTION + Enter (other type) -> CHAIN_MODE
- [ ] OUTPUT_SELECTION + ArrowRight -> same as Enter
- [ ] OUTPUT_SELECTION + click item -> same as Enter
- [ ] OUTPUT_SELECTION + Escape -> IDLE

**CHAIN_MODE transitions:**
- [ ] CHAIN_MODE + input -> CHAIN_MODE (filtered matches)
- [ ] CHAIN_MODE + Enter (command selected) -> EXECUTING
- [ ] CHAIN_MODE + Escape (stack > 1) -> CHAIN_MODE (undo)
- [ ] CHAIN_MODE + Escape (stack <= 1) -> IDLE
- [ ] CHAIN_MODE + cancel click -> IDLE
- [ ] CHAIN_MODE + popup result (done) -> CLOSING
- [ ] CHAIN_MODE + popup result (data) -> CHAIN_MODE (updated context)

**ERROR transitions:**
- [ ] ERROR + 5s timeout -> IDLE
- [ ] ERROR + input -> TYPING
- [ ] ERROR + Escape -> IDLE

### 3.2 Edge Case Tests

- [ ] **Rapid typing during async param suggestions**: Type fast, verify only the latest generation's results are applied (stale guard via `paramGeneration`)
- [ ] **Escape during execution**: Currently unhandled -- verify graceful behavior
- [ ] **Double Enter**: Press Enter twice quickly -- verify second execute is blocked by `executing` guard
- [ ] **Tab then immediate Enter**: Tab fills param, Enter executes -- verify correct item identity
- [ ] **Panel re-show resets all state**: Hide panel, re-show -- verify all modes cleared
- [ ] **Chain mode Escape layering**: In chain mode with param mode active, Escape exits param first, then chain
- [ ] **Click during param mode**: Click a result item while in param mode -- verify correct execution path
- [ ] **URL typed in chain mode**: Type a URL while in chain mode -- verify it doesn't bypass chain
- [ ] **Empty input Enter in chain mode**: Verify no crash or unexpected behavior
- [ ] **Command not found during execution**: Verify error state shown
- [ ] **Panel visibility change during execution**: Verify execution state cleaned up
- [ ] **originalTyped preserved across Tab cycles**: Tab through 3 matches, verify ghost text always shows original input bold
- [ ] **Param mode auto-entry from typing**: Type "edit " (with space) -- verify param mode entered without Tab
- [ ] **Param mode auto-exit from backspace**: In param mode, backspace to remove space -- verify param mode exited

### 3.3 Integration Tests (Full Sequences)

- [ ] **Basic command**: Open panel -> type "tags" -> ArrowDown -> Enter -> verify command executed -> panel closed
- [ ] **Tab completion -> param mode -> select item**: Open -> type "ed" -> Tab (completes "edit ") -> wait for suggestions -> ArrowDown -> Enter -> verify editor opened with correct item
- [ ] **Chain mode flow**: Open -> type "list notes" -> Enter -> (output selection if array) -> select item -> chain mode -> type next command -> Enter -> verify chaining worked
- [ ] **URL opening**: Open -> type "github.com" -> Enter -> verify URL opened -> panel closed
- [ ] **Search fallback**: Open -> type "xyzzy" (no match) -> Enter -> verify search view opened
- [ ] **Escape layering full sequence**: Open -> type "edit " (param mode) -> Escape (exits param) -> Escape (clears text) -> Escape (closes panel)
- [ ] **Mode cycling**: Open -> click mode indicator -> verify mode cycles -> verify commands filtered by mode
- [ ] **Error recovery**: Open -> execute failing command -> verify error shown -> type new command -> verify error hidden -> execute succeeds

---

## 4. Implementation Notes

### 4.1 Refactoring Strategy

The current `panel.js` implements the state machine implicitly through scattered `if/else` checks in event handlers. To make it explicit:

1. **Define a `currentState` variable** that holds the current state name (string enum).
2. **Create a transition table** as a data structure mapping `(state, event) -> {guard, nextState, actions}`.
3. **Centralize event dispatch** through a single `dispatch(event, payload)` function that:
   - Looks up valid transitions for `(currentState, event)`
   - Evaluates guards
   - Runs actions
   - Updates `currentState`
   - Logs the transition for debugging
4. **Wire DOM events to dispatch calls** rather than directly manipulating state.

### 4.2 Suggested State Object Simplification

Instead of flat boolean flags, group state into mode-specific sub-objects:

```javascript
// Current (flat, error-prone)
state.paramMode = true;
state.paramCommand = 'edit';
state.outputSelectionMode = false; // Must be kept in sync

// Proposed (discriminated union)
state.mode = {
  type: 'param',          // 'idle' | 'typing' | 'results' | 'param' | 'executing' | 'output' | 'chain' | 'error'
  command: 'edit',        // Only present in 'param' mode
  suggestions: [...],     // Only present in 'param' mode
  selectedIndex: 0,       // Only present in 'param' mode
};
```

This makes invalid states unrepresentable -- you cannot have `paramMode=true` and `outputSelectionMode=true` simultaneously.

### 4.3 Key Principles

1. **Commands are data, not control flow**: The state machine should never contain command-specific logic. Commands provide metadata (params, accepts, produces), and the state machine uses that metadata to choose transitions.

2. **Actions are pure side effects**: Each action function should do exactly one thing (update DOM, send IPC, etc.) and should be independently testable.

3. **Escape is always layered**: The escape handler should be a simple lookup: "what is the innermost active layer?" -> exit it. No duplicate implementations.

4. **Execution is a state, not an action**: While a command is executing, the state machine is in EXECUTING state. No other transitions (except cancel/error) should be valid.

5. **`originalTyped` should be first-class**: Instead of patching it in post-hoc, the state machine should distinguish between "user typed text" and "machine-completed text" as separate state fields from the start.

### 4.4 Migration Path

1. **Phase 1**: Extract the state enum and transition table as documentation (this document).
2. **Phase 2**: Add the `currentState` variable and `dispatch()` function alongside existing code. Both run in parallel; dispatch logs but doesn't act.
3. **Phase 3**: Migrate one state at a time, starting with IDLE and TYPING. Verify tests pass after each migration.
4. **Phase 4**: Remove old `if/else` chains once all states are migrated.
5. **Phase 5**: Add the `executing` guard to prevent concurrent execution.

### 4.5 Testing Infrastructure

Tests should use the existing pattern from `smoke.spec.ts`:
- Open cmd panel via `app.window.open()`
- Access internal state via `window._cmdState`
- Simulate input via `cmdWindow.fill()` and `cmdWindow.keyboard.press()`
- Wait for state changes via `cmdWindow.waitForFunction()`
- Verify side effects via pubsub event listeners on `bgWindow`

For unit tests of the state machine itself (no DOM/IPC), extract the transition table and dispatch logic into a separate module that can be tested with `yarn test:unit`.
