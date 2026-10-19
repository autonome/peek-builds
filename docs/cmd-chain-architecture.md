# Cmd / Panel / Chaining / Pubsub Architecture

**Purpose:** one-page map of the cmd chaining flow so we can target the right
break instead of chasing symptom-level test failures.

## Components and ownership

| File | Role |
|------|------|
| `apps/desktop/renderer/background.html` + `apps/desktop/main/core-glue.ts` | **Core background renderer.** Hidden, persistent, trustedBuiltin. `apps/desktop/renderer/index.js` calls `initCmd()` here to bootstrap the cmd system; the separate `peek://cmd/index.html` resident is gone. URL: `peek://app/background.html`. |
| `apps/desktop/renderer/cmd/background.js` | **Registry provider.** Runs inside the cmd resident. Subscribes to `cmd:register`, `cmd:register-batch`, `noun:register-batch`, `cmd:query-commands`. Holds the canonical command list. Responds to queries with `cmd:query-commands-response`. Loads user settings. |
| `apps/desktop/renderer/cmd/panel.html` + `panel.js` | **On-demand palette UI.** Opened by the resident via `api.window.open('peek://ext/cmd/panel.html', ...)`. Has its own local `state.commands` map that it maintains from pubsub. trustedBuiltin (as of Cat 1 routing). |
| `apps/desktop/renderer/cmd/commands.js` | Runs **in the panel renderer**. Populates a local command cache by: (a) loading built-in commands (from `./commands/index.js`), (b) subscribing to `cmd:register`/`cmd:register-batch`/`cmd:query-commands-response`, (c) publishing `cmd:query-commands` on load. Dispatches DOM event `cmd-update-commands` to panel.js. |
| `apps/desktop/renderer/cmd/state-machine.js` | Pure 10-state FSM. IDLE → TYPING → RESULTS_OPEN → PARAM_MODE → EXECUTING → {OUTPUT_SELECTION, CHAIN_MODE, CHAIN_POPUP} → CLOSING. No DOM / IPC deps. |
| Feature tiles (`apps/desktop/features/*/background.js`) | Register their commands via `api.commands.register({name, accepts, produces, ...})` which in tile-preload publishes a `cmd:register` pubsub event with metadata. |

## Pubsub topics (scope: GLOBAL unless noted)

| Topic | Publisher | Subscriber | Payload |
|-------|-----------|------------|---------|
| `cmd:register` | tile-preload's `api.commands.register` | `background.js` + panel's `commands.js` | `{name, description, accepts, produces, params, source, scope, modes}` |
| `cmd:register-batch` | rarely used now; pre-v2 preload batched | both | `{commands: [...]}` |
| `cmd:query-commands` | panel's `commands.js` on load | `background.js` | `{}` |
| `cmd:query-commands-response` | `background.js` | panel's `commands.js` | `{commands: [...]}` |
| `cmd:execute:{name}` | panel proxy command | feature tile's subscribe | context `{...ctx, expectResult, resultTopic}` |
| `cmd:execute:{name}:result` | feature tile after executing | panel proxy command | `{success, data, mimeType, title, ...}` |
| `noun:{cap}:{name}` / `noun:result:{name}:{ts}` | noun proxy | noun handler | analogous |

Non-chain: `cmd:settings-update`, `cmd:settings-changed`, `cmd:unregister`,
`cmd:register-batch-direct-handlers`.

## End-to-end flow for "list urls → csv"

1. User opens panel (global shortcut).
2. `panel.js` + `commands.js` load. `commands.js` publishes `cmd:query-commands`. Also subscribes to `cmd:register` / `cmd:register-batch` / `cmd:query-commands-response`.
3. Resident's `background.js` responds with `cmd:query-commands-response` containing all registered commands (list, new, open, csv, save, tagset, etc.). Panel populates `state.commands`.
4. Features that registered AFTER resident started have their `cmd:register` events flowing through to both the resident (for persistence) and the panel (live updates). Scope is GLOBAL.
5. User types `list urls`. Noun system resolves to a proxy command; panel executes via `noun:list:urls` pubsub. Feature returns `{data: [...urls...], mimeType: 'application/json', title: 'URLs'}`.
6. `state-machine` COMMAND_COMPLETE guard `isArrayOutput && hasDownstreamCommands` decides **OUTPUT_SELECTION vs CHAIN_MODE**. ← *this is where the current flow is ambiguous/fragile*.
7. If OUTPUT_SELECTION: arrow-navigable list of rows; Enter/Tab on a row triggers `ITEM_SELECTED` event → transitions to CHAIN_MODE with the selected item as `chainContext.data`.
8. CHAIN_MODE: `findChainingCommands(output.mimeType)` filters `state.commands` by `accepts` matching the output's mimeType. Shows those as suggestions.
9. User picks `csv`. csv's execute receives `ctx.input = selected row`, returns `{data: csvString, mimeType: 'text/csv'}`. Flow loops: can chain further if something accepts `text/csv`.
10. ESC in CHAIN_MODE → pops chain stack, returns to OUTPUT_SELECTION (or EXITS chain_mode entirely if stack empty). ESC in OUTPUT_SELECTION → CLOSING.

## The fragile bits

1. **OUTPUT_SELECTION vs CHAIN_MODE routing is guard-order-dependent.** In `state-machine.js:486-510` the transitions are checked top-down; the first matching guard wins. Current order:
   - editor mimeType + array → OUTPUT_SELECTION  (editor case)
   - editor mimeType → CLOSING (publishEditorOpen)
   - array + hasDownstreamCommands → CHAIN_MODE
   - array → OUTPUT_SELECTION
   - chainable → CHAIN_MODE

   So **if `hasDownstreamCommands` returns true, we skip OUTPUT_SELECTION entirely for non-editor array outputs**. Tests 3026/3203 expect OUTPUT_SELECTION first, THEN chain on selection. These two expectations are in tension — tests check the "select a row first, then chain" ergonomic, but the state machine's decision to enter CHAIN_MODE direct-from-EXECUTING skips that step.

2. **`findChainingCommands` lives in the panel's local view.** If `state.commands` is missing entries (e.g., feature tile's `cmd:register` didn't reach the panel), `hasDownstreamCommands` is incorrectly false and we enter OUTPUT_SELECTION instead of CHAIN_MODE. Equally, incorrect `accepts` metadata on a command → filter returns nothing.

3. **Pubsub reach.** The panel is a separate BrowserWindow with its own tile token (`cmd-ui` / entry `panel`). It receives pubsub through `extensionBroadcaster`'s iteration over trustedBuiltin-registered windows. If panel isn't registered (via `registerTrustedBuiltinWindow`), it gets no broadcasts and `state.commands` never populates from live events.

4. **mimeType wildcard semantics duplicated.** panel.js:595 `mimeTypeMatches` + the same logic implicit in `hasDownstreamCommands`. Any divergence causes confusing results.

5. **Chain stack is an ad-hoc linear array.** Pops on ESC. No branching support, no invariants. If a chain command produces output that re-enters selection, the stack model loses correspondence.

---

## History

The sections below record how things stood when this document was written. They are kept for their reasoning and are not current guidance.

## Observable test failures (all describe a single architectural gap)

| Test | Asserts | What the architecture can't do reliably |
|------|---------|----------------------------------------|
| 3026 `selecting output item enters chain mode with filtered commands` | OUTPUT_SELECTION → select row → CHAIN_MODE with csv/save filtered | Needs OUTPUT_SELECTION first, then ITEM_SELECTED → CHAIN_MODE |
| 3085 `csv command converts JSON to CSV format` | Full list urls → csv → text/csv output | Needs the chain to reach csv's execute with selected input |
| 3149 `escape exits chain mode before closing panel` | ESC in CHAIN_MODE → OUTPUT_SELECTION (not CLOSING) | Chain-aware ESC layering |
| 3203 `arrow navigation in output selection mode` | Arrow keys move selection cursor | Plain OUTPUT_SELECTION UI |
| 3333 `list notes chains with csv` | Same flow as 3026 for `list notes` | Noun-based source command |

Test 2970 (`list urls command produces array output and enters output selection mode`) passes today because `hasDownstreamCommands` returns false (csv et al not reaching panel's `state.commands`), which routes to OUTPUT_SELECTION. Fixing #2 (pubsub reach) WOULD break 2970 if we keep the current guard order: `hasDownstreamCommands` would be true → CHAIN_MODE (skipping OUTPUT_SELECTION). Tests 2970 and 3026 are in direct tension with the current guard logic.

## Redesign sketch

Keep the pieces, fix the flow:

**Principle:** array output ALWAYS enters OUTPUT_SELECTION. CHAIN_MODE is reached from OUTPUT_SELECTION via explicit item selection (Enter/Tab), not directly from EXECUTING. This matches tests 2970, 3026, 3203 simultaneously and gives users a consistent "see the rows first" ergonomic.

State machine changes:
- Drop the `array + hasDownstreamCommands → CHAIN_MODE` transition (guard-order line 503).
- Keep `array → OUTPUT_SELECTION`.
- In OUTPUT_SELECTION, Enter/Tab on a row:
  - if chain commands exist for the output mimeType → CHAIN_MODE
  - else → default action (open item / close panel)
- Non-array single chainable output (editor string, url, etc.) can still go direct CHAIN_MODE.

Pubsub changes:
- Verify the panel window is `registerTrustedBuiltinWindow`-ed so `extensionBroadcaster` sends pubsub to it. Today the panel's token is minted in `ipc.ts` window-open but we may not be calling `registerTrustedBuiltinWindow`.
- Consolidate mimeType match into one shared util (`apps/desktop/renderer/cmd/mime-match.js`), used by both `hasDownstreamCommands` and `findChainingCommands`.

Scope discipline:
- `state.commands` is the single source of truth in the panel. Bugs in its population show up here.
- Registry owner is the resident. Panel caches. If the panel ever shows stale data, log and requery — no silent drift.
