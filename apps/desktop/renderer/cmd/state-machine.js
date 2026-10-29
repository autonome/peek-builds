/**
 * Cmd Panel State Machine
 *
 * Pure state machine module for the command panel.
 * No DOM or IPC dependencies — all side effects are handled by action callbacks.
 *
 * States: IDLE, TYPING, RESULTS_OPEN, PARAM_MODE, EXECUTING, OUTPUT_SELECTION,
 *         CHAIN_MODE, CHAIN_POPUP, ERROR, CLOSING
 *
 * Usage:
 *   import { createStateMachine, States, Events } from './state-machine.js';
 *   const machine = createStateMachine(actionHandlers);
 *   machine.dispatch(Events.INPUT, { value: 'tags' });
 */

// ===== Derived UI State =====
// One owner for "is the results list open" and "which row is selected".
// Both DERIVE from (currentState, data) — there is no boolean flag to go stale.
// Pure: no DOM, no config reads. The `enterRunsInlineSuggestion` pref is carried
// in `data`, synced by the panel from prefs.

import { openWindowForCommand } from './open-window-commands.js';

/**
 * Is the results list visible?
 * @param {string} currentState - a States value
 * @param {Object} data - machine data
 */
export function resultsListOpen(currentState, data) {
  if (currentState === States.OUTPUT_SELECTION) return false; // rendered by its own path
  if (currentState === States.PARAM_MODE) return data.paramSuggestions.length > 0;
  const isChain = currentState === States.CHAIN_MODE;
  const total = data.matches.length + (isChain ? 0 : (data.urlMatches?.length || 0));
  if (total === 0) return false;
  if (isChain) return true;
  if (currentState === States.RESULTS_OPEN) return true;
  if (data.resultsDismissed) return false; // Escape peeled the auto-opened list off
  return total > 1; // auto-open in TYPING/IDLE
}

/**
 * The command row (if any) that TYPING/IDLE auto-selects, plus WHY.
 * `reason` is 'committed' (the typed text already names the command) or
 * 'suggestion' (any other non-empty typed text, pref-gated). The row is
 * always the ranked top of `data.matches` (or a Tab-cycled matchIndex) — the
 * SAME row updateCommandUI (panel.js) draws the inline ghost from. Enter runs
 * the row the ghost promises, so this is not restricted to a strict-prefix
 * completion: a substring/fuzzy match at that row is selected too.
 * @returns {{row: number, reason: string}|null}
 */
function commandRowAutoSelect(data) {
  if (data.matches.length === 0) return null;
  // Normally 0 (computeMatches resets matchIndex on every INPUT), but Tab-cycling
  // in TYPING moves it — the selected row must follow, or Enter would run a
  // different command than the one the typed text completed to.
  const row = (data.matchIndex >= 0 && data.matchIndex < data.matches.length) ? data.matchIndex : 0;
  const name = data.matches[row];
  if (!name) return null;
  const typed = (data.typed || '').trim().toLowerCase();
  const lower = name.toLowerCase();
  if (typed === lower || typed.startsWith(lower + ' ')) return { row, reason: 'committed' };
  if (data.enterRunsInlineSuggestion && typed.length > 0) {
    return { row, reason: 'suggestion' };
  }
  return null;
}

/**
 * The row auto-selected in TYPING/IDLE: 0 for a lone url lane, a command row, or null.
 */
export function autoSelectableRow(data) {
  if (data.matches.length === 0) {
    // urlMatches[0] is the same item the inline ghost is drawn from — no ambiguity.
    return (data.urlMatches?.length || 0) > 0 ? 0 : null;
  }
  const hit = commandRowAutoSelect(data);
  return hit ? hit.row : null;
}

/**
 * The globally-indexed HIGHLIGHTED row, or null when nothing is selected.
 * Nothing visible ⇒ nothing highlighted.
 *
 * This is the RENDERING contract (and the url lane's Enter rule). It is NOT the
 * whole of Enter: a fully-typed command executes with the list closed, so the
 * command lane reads commandRowAutoSelect() directly — see the commandRowSelected
 * guard for why.
 */
export function selectedRow(currentState, data) {
  if (!resultsListOpen(currentState, data)) return null;
  if (currentState === States.RESULTS_OPEN || currentState === States.CHAIN_MODE) return data.matchIndex;
  return autoSelectableRow(data);
}

// ===== State Enum =====
export const States = Object.freeze({
  IDLE: 'IDLE',
  TYPING: 'TYPING',
  RESULTS_OPEN: 'RESULTS_OPEN',
  PARAM_MODE: 'PARAM_MODE',
  EXECUTING: 'EXECUTING',
  OUTPUT_SELECTION: 'OUTPUT_SELECTION',
  CHAIN_MODE: 'CHAIN_MODE',
  CHAIN_POPUP: 'CHAIN_POPUP',
  ERROR: 'ERROR',
  CLOSING: 'CLOSING',
});

// ===== Event Enum =====
export const Events = Object.freeze({
  // Input events
  INPUT: 'input',                   // User typed or cleared text
  // Key events
  ARROW_DOWN: 'ArrowDown',
  ARROW_UP: 'ArrowUp',
  ARROW_RIGHT: 'ArrowRight',
  TAB: 'Tab',
  SHIFT_TAB: 'ShiftTab',
  ENTER: 'Enter',
  URL_ACTION: 'url_action',         // Cmd+Enter or the URL action button: switch to / open the panel's address
  ESCAPE: 'Escape',
  // Click events
  CLICK_RESULT: 'click_result',     // Clicked a command result item
  CLICK_PARAM: 'click_param',       // Clicked a param suggestion
  CLICK_OUTPUT: 'click_output',     // Clicked an output selection item
  CLICK_CANCEL: 'cancel_click',     // Clicked cancel on execution
  CLICK_CHAIN_CANCEL: 'chain_cancel_click',
  // Lifecycle events
  VISIBILITY_SHOWN: 'visibility:shown',
  VISIBILITY_HIDDEN: 'visibility:hidden',
  // Execution result events
  COMMAND_COMPLETE: 'command_complete',
  COMMAND_ERROR: 'command_error',
  COMMAND_TIMEOUT: 'command_timeout',
  // Chain popup events
  POPUP_RESULT: 'popup_result',
  // Error auto-hide
  ERROR_TIMEOUT: 'error_timeout',
  // Mode cycling
  CYCLE_MODE: 'cycle_mode',
  // URL ghost (inline ghost-text completion)
  GHOST_RESOLVED: 'ghost_resolved',   // Async ghost query resolved (suggestion or null)
  ACCEPT_GHOST: 'accept_ghost',       // Tab / ArrowRight accepted the ghost
  CLICK_URL_RESULT: 'click_url_result',
});

/**
 * Creates a new state machine instance.
 *
 * @param {Object} actions - Object of action handler functions.
 *   Each action receives (payload, state) and can perform side effects.
 *   Actions should NOT mutate state directly — the machine handles state transitions.
 * @param {Object} guards - Object of guard functions.
 *   Each guard receives (payload, state) and returns a boolean.
 * @param {Function} [logger] - Optional logging function (tag, ...args)
 * @param {Function} [onClosing] - Optional diagnostic hook (prevState, event, actions),
 *   called after any transition into CLOSING.
 * @returns {Object} State machine interface
 */
export function createStateMachine(actions = {}, guards = {}, logger = null, onClosing = null) {
  // ===== Internal State =====
  let currentState = States.IDLE;

  // Discriminated-union mode state. The `type` field always matches `currentState`.
  // Additional mode-specific fields live alongside `type`.
  let modeState = { type: States.IDLE };

  // Shared data that persists across state transitions
  let data = {
    // Command matching
    commands: {},           // command name -> command object
    matches: [],            // command names matching typed text
    matchIndex: 0,
    matchCounts: {},        // frecency counts
    adaptiveFeedback: {},   // adaptive matching data
    typed: '',              // current input text
    originalTyped: '',      // text before Tab completion
    lastExecuted: '',       // last executed command name

    // UI flags
    urlMatches: [],   // url-history items matching typed text (parallel lane)
    openWindowIds: new Map(), // address -> id of the window showing it, mirrored by the panel
    // Escape hid the auto-opened list for the current text; owned by this module.
    resultsDismissed: false,

    // Pref mirror, synced by the panel from prefs (see config.js prefs.enterRunsInlineSuggestion).
    // Lives in `data` so the derivation functions stay pure — they never read config.
    // Survives reset(): it's a user preference, not per-invocation session state.
    enterRunsInlineSuggestion: true,

    // Output selection
    outputItems: [],
    outputItemIndex: 0,
    outputMimeType: null,
    outputSourceCommand: null,

    // Chain mode
    chainContext: null,     // { data, mimeType, title, sourceCommand }
    chainStack: [],

    // Param mode
    paramCommand: null,
    paramSuggestions: [],
    paramIndex: -1,
    paramGeneration: 0,

    // Execution
    executingCommand: null,
    executionTimeout: null,
    executionError: null,

    // Chain popup
    chainPopupActive: false,
    chainPopupWindowId: null,
  };

  // ===== Guard Helpers =====
  // Default guards that use `data` directly. Can be overridden via the `guards` parameter.

  const defaultGuards = {
    hasMatches: () => data.matches.length > 0,
    hasAnyResults: () => (data.matches.length + (data.urlMatches?.length || 0)) > 0,
    selectedIsUrlResult: () => data.matchIndex >= data.matches.length && data.matchIndex < (data.matches.length + (data.urlMatches?.length || 0)),
    hasParamSuggestions: () => data.paramSuggestions.length > 0,
    resultsVisible: () => resultsListOpen(currentState, data),
    commandHasParams: (payload) => {
      const cmdName = payload?.commandName || data.matches[data.matchIndex];
      const cmd = cmdName && data.commands[cmdName];
      return cmd && cmd.params && cmd.params.length > 0;
    },
    textAlreadyMatchesCommand: (payload) => {
      // Check if the typed text already fully matches the selected command name.
      // Used to decide whether Tab should complete the name (partial) or enter param mode (already complete).
      const cmdName = payload?.commandName || data.matches[data.matchIndex];
      if (!cmdName) return false;
      const trimmed = (data.typed || '').trim().toLowerCase();
      const lowerCmd = cmdName.toLowerCase();
      return trimmed === lowerCmd || trimmed.startsWith(lowerCmd + ' ');
    },
    isItemTypeParam: () => {
      const cmd = data.paramCommand && data.commands[data.paramCommand];
      const paramDef = cmd && cmd.params && cmd.params[0];
      return paramDef && paramDef.type === 'item';
    },
    // The highlighted (Enter) or clicked (CLICK_PARAM) suggestion is a row that carries no
    // item and means "run the command with the typed text" (e.g. the tag query row).
    paramRowRunsTypedText: (payload) => {
      const idx = payload?.index !== undefined ? payload.index : data.paramIndex;
      return data.paramSuggestions[idx]?.runTypedText === true;
    },
    hasUrlGhost: (payload) => payload?.hasUrlGhost === true,
    urlGhostAcceptable: (payload) => payload?.urlGhostAcceptable === true,
    isURL: (payload) => {
      return payload?.isURL === true;
    },
    hasActionUrl: (payload) => typeof payload?.url === 'string' && payload.url.length > 0,
    // The typed text matches no command name and a command claims it (input-claims.js)
    inputClaimedByCommand: (payload) => {
      return typeof payload?.claimedBy === 'string' && payload.claimedBy.length > 0;
    },
    // "The row the user can SEE selected is a url-history row / a command row."
    // Derived from the FSM — no payload backdoor, so what Enter does always
    // matches what the list renders.
    selectedRowIsUrl: () => {
      const row = selectedRow(currentState, data);
      return row !== null && row >= data.matches.length;
    },
    // NOTE the deliberate asymmetry with selectedRowIsUrl above, which gates on
    // the list being open. A fully-typed command executes with the list CLOSED —
    // "tags" + Enter, one match, nothing rendered (total 1 is below the >1
    // auto-open threshold). That is the palette's most common interaction, so the
    // command lane derives from the typed text alone. The url lane must NOT: a
    // lone un-rendered url row must never be opened by a bare Enter.
    commandRowSelected: () => {
      if (currentState !== States.TYPING && currentState !== States.IDLE) return false;
      return commandRowAutoSelect(data) !== null;
    },
    // The command Enter is about to run opens a window (`opensUrl`) that is already
    // open: switch to that window instead of running the command.
    commandOpensOpenWindow: () => {
      // In TYPING/IDLE Enter only runs a command row when one is auto-selected.
      if (currentState === States.TYPING || currentState === States.IDLE) {
        if (commandRowAutoSelect(data) === null) return false;
      }
      return openWindowForCommand(data.commands[data.matches[data.matchIndex]], data.openWindowIds) !== null;
    },
    // Same, for a clicked command row (the click names its row).
    clickedCommandOpensOpenWindow: (payload) => {
      return openWindowForCommand(data.commands[payload?.commandName], data.openWindowIds) !== null;
    },
    // The auto-selected command came from a suggestion (not yet committed) AND
    // takes params → complete the name and enter param mode rather than
    // executing with empty params (previously the panel faked this by
    // dispatching a TAB).
    suggestedCommandNeedsParams: () => {
      if (currentState !== States.TYPING && currentState !== States.IDLE) return false;
      const hit = commandRowAutoSelect(data);
      if (!hit || hit.reason !== 'suggestion') return false;
      const cmd = data.commands[data.matches[hit.row]];
      return !!(cmd && cmd.params && cmd.params.length > 0);
    },
    hasChainableOutput: (payload) => {
      const result = payload?.result;
      return result && result.output && result.output.data && result.output.mimeType;
    },
    hasDownstreamCommands: (payload) => {
      return payload?.hasDownstream === true;
    },
    isArrayOutput: (payload) => {
      const d = payload?.result?.output?.data;
      return Array.isArray(d) && d.length > 0;
    },
    // The command named messages to publish; it skips output selection
    outputPublishes: (payload) => {
      const publish = payload?.result?.output?.publish;
      return Array.isArray(publish) && publish.length > 0;
    },
    isNotExecuting: () => currentState !== States.EXECUTING,
    inputEmpty: (payload) => !payload?.value || payload.value.trim().length === 0,
    inputNonEmpty: (payload) => payload?.value && payload.value.trim().length > 0,
    textNonEmpty: () => data.typed && data.typed.trim().length > 0,
    textEmpty: () => !data.typed || data.typed.trim().length === 0,
    inParamMode: () => currentState === States.PARAM_MODE,
    inChainMode: () => currentState === States.CHAIN_MODE,
    inOutputSelection: () => currentState === States.OUTPUT_SELECTION,
    chainStackDeep: () => data.chainStack.length > 1,
    canNavigateDown: () => data.matchIndex + 1 < (data.matches.length + (data.urlMatches?.length || 0)),
    canNavigateUp: () => data.matchIndex > 0,
    // Param arrows wrap around the list ends (like Tab); the action does the wrapping
    canNavigateParamDown: () => data.paramSuggestions.length > 0,
    canNavigateParamUp: () => data.paramSuggestions.length > 0,
    canNavigateOutputDown: () => data.outputItemIndex + 1 < data.outputItems.length,
    canNavigateOutputUp: () => data.outputItemIndex > 0,
    isPromptAction: (payload) => payload?.result?.action === 'prompt',
    popupDone: (payload) => payload?.done === true,
    paramInputStillMatches: (payload) => {
      return payload?.paramStillMatches === true;
    },
  };

  function guard(name, payload) {
    const fn = guards[name] || defaultGuards[name];
    if (!fn) {
      log('warn', `Guard "${name}" not found, returning false`);
      return false;
    }
    return fn(payload, data);
  }

  // ===== Logging =====
  function log(...args) {
    if (logger) logger('cmd:sm', ...args);
  }

  // ===== Machine-Internal Actions =====
  // Actions that write machine-owned data rather than driving the DOM. They are
  // looked up BEFORE the injected `actions`, because the test harness proxies
  // every action name and would otherwise shadow them.
  const internalActions = {
    dismissResults() { data.resultsDismissed = true; },
    undismissResults() { data.resultsDismissed = false; },
  };

  // ===== Action Runner =====
  // `fromState` is the state the transition left; currentState already holds its target.
  function runAction(name, payload, fromState) {
    const internal = internalActions[name];
    if (internal) {
      try {
        internal(payload, data);
      } catch (err) {
        log('error', `Internal action "${name}" threw:`, err);
      }
    }
    const fn = actions[name];
    if (fn) {
      try {
        fn(payload, data, fromState);
      } catch (err) {
        log('error', `Action "${name}" threw:`, err);
      }
    }
  }

  // ===== Transition Table =====
  // Each entry: { guard?: string|function, target: State, actions?: string[] }
  // First matching transition wins (guards evaluated in order).

  const transitions = {
    // ===== IDLE =====
    [States.IDLE]: {
      [Events.INPUT]: [
        {
          // Direct to param mode when input already contains "command " with params
          guard: (p) => p?.enterParamMode === true,
          target: States.PARAM_MODE,
          actions: ['setTyped', 'computeMatches', 'enterParamMode', 'updateGhostText', 'updateResults'],
        },
        {
          guard: 'inputNonEmpty',
          target: States.TYPING,
          actions: ['setTyped', 'computeMatches', 'checkParamEntry', 'updateGhostText', 'updateResults'],
        },
        // Empty input stays IDLE (no-op)
      ],
      [Events.ARROW_DOWN]: [
        { guard: 'hasAnyResults', target: States.RESULTS_OPEN, actions: ['renderResults'] },
      ],
      [Events.ESCAPE]: [
        { target: States.CLOSING, actions: ['shutdown'] },
      ],
      [Events.ENTER]: [
        // Empty input — no-op
      ],
      [Events.VISIBILITY_HIDDEN]: [
        { target: States.CLOSING, actions: ['shutdown'] },
      ],
      [Events.CYCLE_MODE]: [
        { target: States.IDLE, actions: ['cycleMode'] },
      ],
      [Events.ERROR_TIMEOUT]: [
        // Can receive late error timeout — ignore
      ],
    },

    // ===== TYPING =====
    [States.TYPING]: {
      [Events.INPUT]: [
        {
          guard: 'inputEmpty',
          target: States.IDLE,
          actions: ['clearInput', 'exitParamMode', 'updateGhostText', 'updateResults'],
        },
        {
          // Check if typing enters param mode
          guard: (p) => p?.enterParamMode === true,
          target: States.PARAM_MODE,
          actions: ['setTyped', 'computeMatches', 'enterParamMode', 'updateGhostText', 'updateResults'],
        },
        {
          guard: 'inputNonEmpty',
          target: States.TYPING,
          actions: ['undismissResults', 'setTyped', 'computeMatches', 'updateGhostText', 'updateResults'],
        },
      ],
      [Events.ARROW_DOWN]: [
        { guard: 'hasAnyResults', target: States.RESULTS_OPEN, actions: ['renderResults'] },
      ],
      [Events.TAB]: [
        {
          // Command has params → complete name and enter param mode in one step
          guard: (p) => guard('hasMatches', p) && guard('commandHasParams', p),
          target: States.PARAM_MODE,
          actions: ['tabCompleteCommand', 'enterParamMode', 'updateGhostText', 'updateResults'],
        },
        {
          // No params — just complete/cycle the name
          guard: 'hasMatches',
          target: States.TYPING,
          actions: ['tabCompleteCommand', 'updateGhostText', 'updateResults'],
        },
      ],
      [Events.SHIFT_TAB]: [
        {
          guard: 'hasMatches',
          target: States.TYPING,
          actions: ['shiftTabCycleCommand', 'updateGhostText', 'updateResults'],
        },
      ],
      [Events.ENTER]: [
        {
          guard: 'hasUrlGhost',
          target: States.CLOSING,
          actions: ['openUrlGhost', 'clearInput', 'shutdown'],
        },
        {
          guard: 'isURL',
          target: States.CLOSING,
          actions: ['openURL', 'recordFrecency', 'clearInput', 'shutdown'],
        },
        {
          // Input a command declares it claims (e.g. "#todo #today") runs that
          // command with the typed text. Claims are narrow shapes, distinct from
          // the generic "type random text → web search" fallback that was
          // intentionally removed.
          guard: 'inputClaimedByCommand',
          target: States.CLOSING,
          actions: ['executeClaimingCommand', 'clearInput', 'shutdown'],
        },
        {
          // A url-history row is visibly selected (the list auto-opened and the
          // user never arrowed) → open it. Enter must do what the highlight says.
          guard: 'selectedRowIsUrl',
          target: States.CLOSING,
          actions: ['openSelectedUrlResult', 'clearInput', 'shutdown'],
        },
        {
          // The command opens a window that is already open → switch to it.
          guard: 'commandOpensOpenWindow',
          target: States.CLOSING,
          actions: ['recordFrecency', 'switchToCommandWindow', 'clearInput', 'shutdown'],
        },
        {
          // Strict-prefix suggestion that takes params → complete + param mode,
          // don't execute with empty params.
          guard: 'suggestedCommandNeedsParams',
          target: States.PARAM_MODE,
          actions: ['tabCompleteCommand', 'enterParamMode', 'updateGhostText', 'updateResults'],
        },
        {
          guard: 'commandRowSelected',
          target: States.EXECUTING,
          actions: ['recordFrecency', 'exitParamMode', 'executeCommand', 'clearInput', 'updateGhostText', 'updateResults'],
        },
        // No URL, no all-hashtag query, no selected row → no-op
        // (do NOT fall back to web search; typing random text and pressing
        // Enter should not silently route to a web search — the user invokes
        // `search` explicitly if they want one).
      ],
      [Events.URL_ACTION]: [
        { guard: 'hasActionUrl', target: States.CLOSING, actions: ['runUrlAction', 'clearInput', 'shutdown'] },
      ],
      [Events.ESCAPE]: [
        // Escape peels one layer per press. Visible dropdown first — hide it and
        // keep the typed text; only a later press clears the text, then closes.
        {
          guard: 'resultsVisible',
          target: States.TYPING,
          actions: ['dismissResults', 'dropInlineGhost', 'updateGhostText', 'updateResults'],
        },
        { guard: 'textNonEmpty', target: States.IDLE, actions: ['clearInput', 'clearMatches', 'updateGhostText', 'updateResults'] },
        { target: States.CLOSING, actions: ['shutdown'] },
      ],
      [Events.VISIBILITY_HIDDEN]: [
        { target: States.CLOSING, actions: ['shutdown'] },
      ],
      [Events.CYCLE_MODE]: [
        { target: States.TYPING, actions: ['cycleMode'] },
      ],
      [Events.GHOST_RESOLVED]: [
        { target: null, actions: ['applyGhostResolution'] },
      ],
      [Events.ACCEPT_GHOST]: [
        { guard: 'urlGhostAcceptable', target: null, actions: ['acceptUrlGhost'] },
      ],
      [Events.CLICK_RESULT]: [
        {
          guard: 'clickedCommandOpensOpenWindow',
          target: States.CLOSING,
          actions: ['setMatchIndexFromClick', 'recordFrecencyFromResults', 'switchToCommandWindow', 'clearInput', 'shutdown'],
        },
        { target: States.EXECUTING, actions: ['setMatchIndexFromClick', 'recordFrecencyFromResults', 'exitParamMode', 'executeCommand', 'clearInput', 'updateGhostText', 'updateResults'] },
      ],
      [Events.CLICK_URL_RESULT]: [
        { target: States.CLOSING, actions: ['openClickedUrlResult', 'clearInput', 'shutdown'] },
      ],
    },

    // ===== RESULTS_OPEN =====
    [States.RESULTS_OPEN]: {
      [Events.INPUT]: [
        {
          guard: 'inputEmpty',
          target: States.IDLE,
          actions: ['clearInput', 'updateGhostText', 'updateResults'],
        },
        {
          guard: (p) => p?.enterParamMode === true,
          target: States.PARAM_MODE,
          actions: ['setTyped', 'computeMatches', 'enterParamMode', 'updateGhostText', 'updateResults'],
        },
        {
          target: States.TYPING,
          actions: ['setTyped', 'computeMatches', 'updateGhostText', 'updateResults'],
        },
      ],
      [Events.ARROW_DOWN]: [
        {
          guard: 'canNavigateDown',
          target: States.RESULTS_OPEN,
          actions: ['navigateDown', 'updateGhostText', 'renderResults'],
        },
      ],
      [Events.ARROW_UP]: [
        {
          guard: 'canNavigateUp',
          target: States.RESULTS_OPEN,
          actions: ['navigateUp', 'updateGhostText', 'renderResults'],
        },
      ],
      [Events.TAB]: [
        {
          // Command has params AND name is already fully typed → enter param mode
          guard: (p) => guard('hasMatches', p) && guard('commandHasParams', p) && guard('textAlreadyMatchesCommand', p),
          target: States.PARAM_MODE,
          actions: ['tabCompleteCommand', 'enterParamMode', 'updateGhostText', 'updateResults'],
        },
        {
          // In RESULTS_OPEN, Tab cycles through results — only enter param mode
          // when the name is already fully typed (above guard). Otherwise cycle.
          guard: 'hasMatches',
          target: States.RESULTS_OPEN,
          actions: ['tabCycleInResults', 'updateGhostText', 'renderResults'],
        },
      ],
      [Events.SHIFT_TAB]: [
        { guard: 'hasMatches', target: States.RESULTS_OPEN,
          actions: ['shiftTabCycleInResults', 'updateGhostText', 'renderResults'] },
      ],
      [Events.ENTER]: [
        { guard: 'selectedIsUrlResult', target: States.CLOSING, actions: ['openSelectedUrlResult', 'clearInput', 'shutdown'] },
        {
          // The highlighted command opens a window that is already open → switch to it.
          guard: 'commandOpensOpenWindow',
          target: States.CLOSING,
          actions: ['recordFrecencyFromResults', 'switchToCommandWindow', 'clearInput', 'shutdown'],
        },
        {
          // Explicit selected command match wins. Reaching RESULTS_OPEN means the
          // user navigated the results list (ArrowDown), so the highlighted row
          // (state.matchIndex) is an intentional selection — execute it. The
          // typed-text URL heuristics below (hasUrlGhost / isURL) are derived from
          // the raw input, NOT from matchIndex, so they must NOT preempt an arrowed
          // command selection. (Regression: a URL-ish typed string opened the URL
          // instead of the command the user had arrowed to and highlighted.)
          guard: 'hasMatches',
          target: States.EXECUTING,
          actions: ['recordFrecencyFromResults', 'exitParamMode', 'executeCommand', 'clearInput', 'updateGhostText', 'updateResults'],
        },
        {
          guard: 'hasUrlGhost',
          target: States.CLOSING,
          actions: ['openUrlGhost', 'clearInput', 'shutdown'],
        },
        {
          guard: 'isURL',
          target: States.CLOSING,
          actions: ['openURL', 'recordFrecency', 'clearInput', 'shutdown'],
        },
      ],
      [Events.URL_ACTION]: [
        { guard: 'hasActionUrl', target: States.CLOSING, actions: ['runUrlAction', 'clearInput', 'shutdown'] },
      ],
      [Events.CLICK_RESULT]: [
        {
          guard: 'clickedCommandOpensOpenWindow',
          target: States.CLOSING,
          actions: ['setMatchIndexFromClick', 'recordFrecencyFromResults', 'switchToCommandWindow', 'clearInput', 'shutdown'],
        },
        {
          target: States.EXECUTING,
          actions: ['setMatchIndexFromClick', 'recordFrecencyFromResults', 'exitParamMode', 'executeCommand', 'clearInput', 'updateGhostText', 'updateResults'],
        },
      ],
      [Events.CLICK_URL_RESULT]: [
        { target: States.CLOSING, actions: ['openClickedUrlResult', 'clearInput', 'shutdown'] },
      ],
      [Events.ESCAPE]: [
        // Back to TYPING with the list staying shut — TYPING would otherwise
        // re-derive it as open whenever the combined lane total is above 1.
        { target: States.TYPING, actions: ['dismissResults', 'dropInlineGhost', 'updateGhostText', 'updateResults'] },
      ],
      [Events.VISIBILITY_HIDDEN]: [
        { target: States.CLOSING, actions: ['shutdown'] },
      ],
      [Events.GHOST_RESOLVED]: [
        { target: null, actions: ['applyGhostResolution'] },
      ],
      [Events.ACCEPT_GHOST]: [
        { guard: 'urlGhostAcceptable', target: null, actions: ['acceptUrlGhost'] },
      ],
    },

    // ===== PARAM_MODE =====
    [States.PARAM_MODE]: {
      [Events.INPUT]: [
        {
          guard: 'inputEmpty',
          target: States.IDLE,
          actions: ['clearInput', 'exitParamMode', 'updateGhostText', 'updateResults'],
        },
        {
          guard: 'paramInputStillMatches',
          target: States.PARAM_MODE,
          actions: ['setTyped', 'updateParamSuggestions', 'updateGhostText', 'updateResults'],
        },
        {
          // Input no longer matches the param command — exit param mode
          target: States.TYPING,
          actions: ['setTyped', 'exitParamMode', 'computeMatches', 'checkParamEntry', 'updateGhostText', 'updateResults'],
        },
      ],
      [Events.ARROW_DOWN]: [
        {
          guard: 'canNavigateParamDown',
          target: States.PARAM_MODE,
          actions: ['navigateParamDown', 'updateGhostText', 'updateResults'],
        },
      ],
      [Events.ARROW_UP]: [
        {
          guard: 'canNavigateParamUp',
          target: States.PARAM_MODE,
          actions: ['navigateParamUp', 'updateGhostText', 'updateResults'],
        },
      ],
      [Events.TAB]: [
        {
          guard: 'hasParamSuggestions',
          target: States.PARAM_MODE,
          actions: ['fillParamText', 'updateGhostText', 'updateResults'],
        },
      ],
      [Events.SHIFT_TAB]: [
        {
          guard: 'hasParamSuggestions',
          target: States.PARAM_MODE,
          actions: ['fillParamTextReverse', 'updateGhostText', 'updateResults'],
        },
      ],
      [Events.ENTER]: [
        {
          // A row that runs the typed text (tag query) — no fill, the typed text is the argument
          guard: 'paramRowRunsTypedText',
          target: States.EXECUTING,
          actions: ['recordFrecency', 'executeCommandWithParams', 'clearInput', 'exitParamMode', 'updateGhostText', 'updateResults'],
        },
        {
          guard: (p) => guard('isItemTypeParam', p) && guard('hasParamSuggestions', p),
          target: States.EXECUTING,
          actions: ['acceptParamItem', 'exitParamMode'],
        },
        {
          // Non-item param or no suggestions — execute with typed text
          target: States.EXECUTING,
          actions: ['fillHighlightedParam', 'recordFrecency', 'executeCommandWithParams', 'clearInput', 'exitParamMode', 'updateGhostText', 'updateResults'],
        },
      ],
      [Events.CLICK_PARAM]: [
        {
          guard: 'paramRowRunsTypedText',
          target: States.EXECUTING,
          actions: ['recordFrecency', 'executeCommandWithParams', 'clearInput', 'exitParamMode', 'updateGhostText', 'updateResults'],
        },
        {
          guard: 'isItemTypeParam',
          target: States.EXECUTING,
          actions: ['setParamIndexFromClick', 'acceptParamItem', 'exitParamMode'],
        },
        {
          target: States.EXECUTING,
          actions: ['setParamIndexFromClick', 'recordFrecency', 'executeCommandWithParams', 'clearInput', 'exitParamMode', 'updateGhostText', 'updateResults'],
        },
      ],
      [Events.ESCAPE]: [
        { target: States.TYPING, actions: ['exitParamMode', 'updateResults', 'updateGhostText'] },
      ],
      [Events.VISIBILITY_HIDDEN]: [
        { target: States.CLOSING, actions: ['exitParamMode', 'shutdown'] },
      ],
    },

    // ===== EXECUTING =====
    [States.EXECUTING]: {
      [Events.COMMAND_COMPLETE]: [
        {
          guard: 'isPromptAction',
          target: States.IDLE,
          actions: ['hideSpinner'],
        },
        {
          guard: 'outputPublishes',
          target: States.CLOSING,
          actions: ['hideSpinner', 'publishOutput', 'shutdown'],
        },
        {
          // Array output always enters OUTPUT_SELECTION first. From there the
          // user selects a row (Enter/Tab) and the ITEM_SELECTED handler
          // decides whether to branch into CHAIN_MODE (if downstream commands
          // exist for the row's mimeType) or invoke a default action. This
          // keeps the "see your rows first" ergonomic consistent regardless
          // of whether chain commands happen to be registered — see
          // docs/cmd-chain-architecture.md for the full rationale.
          guard: (p) => guard('isArrayOutput', p),
          target: States.OUTPUT_SELECTION,
          actions: ['hideSpinner', 'enterOutputSelection'],
        },
        {
          // Non-array chainable output (single string, url, etc.) goes direct
          // to CHAIN_MODE — there are no rows to select among.
          guard: 'hasChainableOutput',
          target: States.CHAIN_MODE,
          actions: ['hideSpinner', 'enterChainMode'],
        },
        {
          // No output — close
          target: States.CLOSING,
          actions: ['hideSpinner', 'exitChainModeIfActive', 'shutdownDelayed'],
        },
      ],
      [Events.COMMAND_ERROR]: [
        { target: States.ERROR, actions: ['hideSpinner', 'showError'] },
      ],
      [Events.COMMAND_TIMEOUT]: [
        { target: States.ERROR, actions: ['hideSpinner', 'showError'] },
      ],
      [Events.CLICK_CANCEL]: [
        { target: States.IDLE, actions: ['cancelExecution'] },
      ],
      [Events.ESCAPE]: [
        { target: States.IDLE, actions: ['cancelExecution'] },
      ],
      // Block all other input while executing
      [Events.INPUT]: [],
      [Events.ENTER]: [],
      [Events.TAB]: [],
      [Events.ARROW_DOWN]: [],
      [Events.ARROW_UP]: [],
      [Events.VISIBILITY_HIDDEN]: [
        { target: States.CLOSING, actions: ['cancelExecution', 'shutdown'] },
      ],
    },

    // ===== OUTPUT_SELECTION =====
    [States.OUTPUT_SELECTION]: {
      [Events.ARROW_DOWN]: [
        {
          guard: 'canNavigateOutputDown',
          target: States.OUTPUT_SELECTION,
          actions: ['navigateOutputDown', 'updateOutputUI'],
        },
      ],
      [Events.ARROW_UP]: [
        {
          guard: 'canNavigateOutputUp',
          target: States.OUTPUT_SELECTION,
          actions: ['navigateOutputUp', 'updateOutputUI'],
        },
      ],
      [Events.ENTER]: [
        { target: null, actions: ['selectOutputItem'] }, // target determined by action
      ],
      [Events.ARROW_RIGHT]: [
        { target: null, actions: ['selectOutputItem'] }, // target determined by action
      ],
      [Events.CLICK_OUTPUT]: [
        { target: null, actions: ['setOutputIndexFromClick', 'selectOutputItem'] },
      ],
      [Events.ESCAPE]: [
        { target: States.IDLE, actions: ['exitOutputSelection', 'clearInput', 'updateGhostText', 'updateResults'] },
      ],
      [Events.VISIBILITY_HIDDEN]: [
        { target: States.CLOSING, actions: ['exitOutputSelection', 'shutdown'] },
      ],
    },

    // ===== CHAIN_MODE =====
    [States.CHAIN_MODE]: {
      [Events.INPUT]: [
        {
          guard: 'inputEmpty',
          target: States.CHAIN_MODE,
          actions: ['clearTypedKeepChain', 'computeChainMatches', 'updateGhostText', 'updateResults'],
        },
        {
          target: States.CHAIN_MODE,
          actions: ['setTyped', 'computeChainMatches', 'updateGhostText', 'updateResults'],
        },
      ],
      [Events.ARROW_DOWN]: [
        {
          guard: 'canNavigateDown',
          target: States.CHAIN_MODE,
          actions: ['navigateDown', 'updateGhostText', 'renderResults'],
        },
      ],
      [Events.ARROW_UP]: [
        {
          guard: 'canNavigateUp',
          target: States.CHAIN_MODE,
          actions: ['navigateUp', 'updateGhostText', 'renderResults'],
        },
      ],
      [Events.TAB]: [
        {
          guard: 'hasMatches',
          target: States.CHAIN_MODE,
          actions: ['tabCompleteCommand', 'updateGhostText', 'updateResults'],
        },
      ],
      [Events.ENTER]: [
        {
          guard: 'hasMatches',
          target: States.EXECUTING,
          actions: ['recordFrecencyFromResults', 'executeChainCommand', 'clearInput', 'updateGhostText', 'updateResults'],
        },
      ],
      [Events.ESCAPE]: [
        { guard: 'chainStackDeep', target: States.CHAIN_MODE, actions: ['chainUndo'] },
        { target: States.IDLE, actions: ['exitChainMode', 'clearInput', 'updateGhostText', 'updateResults'] },
      ],
      [Events.CLICK_CHAIN_CANCEL]: [
        { target: States.IDLE, actions: ['exitChainMode', 'clearInput', 'updateGhostText', 'updateResults'] },
      ],
      [Events.CLICK_RESULT]: [
        {
          target: States.EXECUTING,
          actions: ['setMatchIndexFromClick', 'recordFrecencyFromResults', 'executeChainCommand', 'clearInput', 'updateGhostText', 'updateResults'],
        },
      ],
      [Events.POPUP_RESULT]: [
        { guard: 'popupDone', target: States.CLOSING, actions: ['shutdown'] },
        { target: States.CHAIN_MODE, actions: ['updateChainFromPopup', 'computeChainMatches', 'updateGhostText', 'updateResults', 'refocusPanel'] },
      ],
      [Events.VISIBILITY_HIDDEN]: [
        { target: States.CLOSING, actions: ['exitChainMode', 'shutdown'] },
      ],
    },

    // ===== CHAIN_POPUP =====
    [States.CHAIN_POPUP]: {
      [Events.POPUP_RESULT]: [
        { guard: 'popupDone', target: States.CLOSING, actions: ['shutdown'] },
        { target: States.CHAIN_MODE, actions: ['updateChainFromPopup', 'computeChainMatches', 'updateGhostText', 'updateResults', 'refocusPanel'] },
      ],
      [Events.ESCAPE]: [
        { target: States.CHAIN_MODE, actions: ['closeChainPopup'] },
      ],
      [Events.VISIBILITY_HIDDEN]: [
        { target: States.CLOSING, actions: ['exitChainMode', 'shutdown'] },
      ],
    },

    // ===== ERROR =====
    [States.ERROR]: {
      [Events.ERROR_TIMEOUT]: [
        { target: States.IDLE, actions: ['hideError'] },
      ],
      [Events.INPUT]: [
        {
          guard: 'inputNonEmpty',
          target: States.TYPING,
          actions: ['hideError', 'setTyped', 'computeMatches', 'updateGhostText', 'updateResults'],
        },
        { target: States.IDLE, actions: ['hideError'] },
      ],
      [Events.ESCAPE]: [
        { target: States.IDLE, actions: ['hideError'] },
      ],
      [Events.VISIBILITY_HIDDEN]: [
        { target: States.CLOSING, actions: ['hideError', 'shutdown'] },
      ],
    },

    // ===== CLOSING =====
    [States.CLOSING]: {
      // Terminal state — panel hides and resets on next visibility change.
      [Events.VISIBILITY_SHOWN]: [
        { target: States.IDLE, actions: ['resetAllState'] },
      ],
      // Absorb everything else
    },
  };

  // VISIBILITY_SHOWN from ANY state resets the panel to IDLE. The keepLive
  // reuse path (api.window.open with key → win.show() on an existing hidden
  // panel) delivers this event via `api.onVisible` (tile:lifecycle:visible
  // IPC from main). Handling it in every state means the reset is a
  // first-class FSM transition, not a DOM-event backdoor via setState().
  // The CLOSING handler above is preserved — it's the natural post-
  // shutdown reset path. The loop adds the same handler to every OTHER
  // state.
  for (const state of Object.values(States)) {
    if (!transitions[state]) continue;
    if (transitions[state][Events.VISIBILITY_SHOWN]) continue;
    transitions[state][Events.VISIBILITY_SHOWN] = [
      { target: States.IDLE, actions: ['resetAllState'] },
    ];
  }

  // ===== Dispatch =====

  /**
   * Dispatch an event to the state machine.
   * Evaluates guards in order and fires the first matching transition.
   *
   * @param {string} event - Event name from Events enum
   * @param {Object} [payload] - Optional event payload
   * @returns {{ handled: boolean, prevState: string, nextState: string|null }}
   */
  function dispatch(event, payload = {}) {
    const stateTransitions = transitions[currentState];
    if (!stateTransitions) {
      log('warn', `No transitions defined for state "${currentState}"`);
      return { handled: false, prevState: currentState, nextState: null };
    }

    const eventTransitions = stateTransitions[event];
    if (!eventTransitions || eventTransitions.length === 0) {
      log('debug', `No transition for (${currentState}, ${event})`);
      return { handled: false, prevState: currentState, nextState: null };
    }

    const prevState = currentState;

    for (const transition of eventTransitions) {
      // Evaluate guard
      if (transition.guard) {
        let guardResult;
        if (typeof transition.guard === 'function') {
          guardResult = transition.guard(payload);
        } else {
          guardResult = guard(transition.guard, payload);
        }
        if (!guardResult) continue;
      }

      // Transition matched — execute
      const target = transition.target;

      // Flip state BEFORE running actions so every action observes the state it
      // is transitioning INTO, not the one being left. The renderers derive from
      // machine.getState() (panel.js updateResultsUI -> resultsListOpen /
      // selectedRow); if they ran while currentState still held the old value, a
      // single-match ArrowDown-to-open (TYPING -> RESULTS_OPEN, total === 1)
      // would evaluate the TYPING auto-open rule (total > 1 -> false) and hide
      // the list it was in the act of opening. `prevState` (captured above) is
      // the only thing that still needs the old value, and it is kept separately.
      // target === null means the action decides the state itself (e.g.
      // GHOST_RESOLVED via machine.setState) — leave currentState untouched.
      if (target !== null && target !== undefined) {
        currentState = target;
      }

      // Run actions
      if (transition.actions) {
        for (const actionName of transition.actions) {
          runAction(actionName, payload, prevState);
        }
      }

      // Enforce invariants
      enforceInvariants();

      log('transition', `${prevState} + ${event} → ${currentState}`, payload?.value !== undefined ? `(input: "${payload.value}")` : '');
      if (target === States.CLOSING && typeof onClosing === 'function') {
        try { onClosing(prevState, event, transition.actions || []); } catch { /* diagnostics only */ }
      }

      return { handled: true, prevState, nextState: currentState };
    }

    // No guard matched
    log('debug', `No guard matched for (${currentState}, ${event})`);
    return { handled: false, prevState: currentState, nextState: null };
  }

  // ===== Invariant Enforcement =====

  function enforceInvariants() {
    // A dismissed list only survives inside TYPING. Leaving TYPING at all —
    // ArrowDown to RESULTS_OPEN, the clear to IDLE, param mode, execution —
    // means the next arrival re-derives visibility from scratch.
    if (currentState !== States.TYPING) data.resultsDismissed = false;

    // Bound matchIndex against the COMBINED command + url-history total
    const totalResults = data.matches.length + (data.urlMatches?.length || 0);
    if (totalResults === 0) {
      data.matchIndex = 0;
    } else if (data.matchIndex >= totalResults) {
      data.matchIndex = totalResults - 1;
    } else if (data.matchIndex < 0) {
      data.matchIndex = 0;
    }

    // Bound paramIndex
    if (data.paramSuggestions.length === 0) {
      data.paramIndex = -1;
    } else if (data.paramIndex >= data.paramSuggestions.length) {
      data.paramIndex = data.paramSuggestions.length - 1;
    }

    // Bound outputItemIndex
    if (data.outputItems.length === 0) {
      data.outputItemIndex = 0;
    } else if (data.outputItemIndex >= data.outputItems.length) {
      data.outputItemIndex = data.outputItems.length - 1;
    } else if (data.outputItemIndex < 0) {
      data.outputItemIndex = 0;
    }

    // Mutual exclusivity — if we're not in the right state, clear mode data
    if (currentState !== States.PARAM_MODE) {
      data.paramCommand = null;
      data.paramSuggestions = [];
      data.paramIndex = -1;
    }

    if (currentState !== States.OUTPUT_SELECTION) {
      data.outputItems = [];
      data.outputItemIndex = 0;
      data.outputMimeType = null;
      data.outputSourceCommand = null;
    }

    if (currentState !== States.CHAIN_MODE && currentState !== States.CHAIN_POPUP && currentState !== States.EXECUTING) {
      // Don't clear chain state during EXECUTING since we might return to chain mode
    }
  }

  // ===== Public Interface =====

  return {
    /**
     * Dispatch an event to the state machine
     */
    dispatch,

    /**
     * Get the current state name
     */
    getState() {
      return currentState;
    },

    /**
     * Get a read-only snapshot of the data
     */
    getData() {
      return data;
    },

    /**
     * Get mutable reference to data (for action handlers to modify)
     */
    getMutableData() {
      return data;
    },

    /**
     * Force-set state (for testing or reset on visibility change)
     */
    setState(newState) {
      currentState = newState;
    },

    /**
     * Reset the machine to initial state with fresh data
     */
    reset() {
      currentState = States.IDLE;
      data.typed = '';
      data.originalTyped = '';
      data.matches = [];
      data.urlMatches = [];
      data.resultsDismissed = false;
      data.matchIndex = 0;
      data.outputItems = [];
      data.outputItemIndex = 0;
      data.outputMimeType = null;
      data.outputSourceCommand = null;
      data.chainContext = null;
      data.chainStack = [];
      data.paramCommand = null;
      data.paramSuggestions = [];
      data.paramIndex = -1;
      data.executingCommand = null;
      data.executionTimeout = null;
      data.executionError = null;
      data.chainPopupActive = false;
      data.chainPopupWindowId = null;
      data.lastExecuted = '';
    },

    /**
     * Check if the machine is in a specific state
     */
    is(stateName) {
      return currentState === stateName;
    },

    /**
     * Returns the IZUI escape handler result.
     * Delegates to dispatch(ESCAPE) and returns { handled } for the IZUI flow.
     */
    handleEscape() {
      const result = dispatch(Events.ESCAPE, { kernelCloses: true });
      // If we transitioned to CLOSING, the backend should close the window
      if (currentState === States.CLOSING) {
        return { handled: false };
      }
      return { handled: result.handled };
    },
  };
}
