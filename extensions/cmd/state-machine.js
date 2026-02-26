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
 * @returns {Object} State machine interface
 */
export function createStateMachine(actions = {}, guards = {}, logger = null) {
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
    showResults: false,

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
    hasParamSuggestions: () => data.paramSuggestions.length > 0,
    commandHasParams: (payload) => {
      const cmdName = payload?.commandName || data.matches[data.matchIndex];
      const cmd = cmdName && data.commands[cmdName];
      return cmd && cmd.params && cmd.params.length > 0 && !(cmd.produces && cmd.produces.length > 0);
    },
    isItemTypeParam: () => {
      const cmd = data.paramCommand && data.commands[data.paramCommand];
      const paramDef = cmd && cmd.params && cmd.params[0];
      return paramDef && paramDef.type === 'item';
    },
    isURL: (payload) => {
      return payload?.isURL === true;
    },
    userCommittedToCommand: (payload) => {
      return payload?.committed === true;
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
    isEditorMimeType: (payload) => {
      const mt = payload?.result?.output?.mimeType;
      return mt === 'item' || mt === 'new-item';
    },
    isNotExecuting: () => currentState !== States.EXECUTING,
    inputEmpty: (payload) => !payload?.value || payload.value.trim().length === 0,
    inputNonEmpty: (payload) => payload?.value && payload.value.trim().length > 0,
    textNonEmpty: () => data.typed && data.typed.trim().length > 0,
    textEmpty: () => !data.typed || data.typed.trim().length === 0,
    resultsVisible: () => data.showResults,
    inParamMode: () => currentState === States.PARAM_MODE,
    inChainMode: () => currentState === States.CHAIN_MODE,
    inOutputSelection: () => currentState === States.OUTPUT_SELECTION,
    chainStackDeep: () => data.chainStack.length > 1,
    canNavigateDown: () => data.matchIndex + 1 < data.matches.length,
    canNavigateUp: () => data.matchIndex > 0,
    canNavigateParamDown: () => data.paramIndex + 1 < data.paramSuggestions.length,
    canNavigateParamUp: () => data.paramIndex > 0,
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

  // ===== Action Runner =====
  function runAction(name, payload) {
    const fn = actions[name];
    if (fn) {
      try {
        fn(payload, data);
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
        { guard: 'hasMatches', target: States.RESULTS_OPEN, actions: ['showResults', 'renderResults'] },
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
          actions: ['setTyped', 'computeMatches', 'updateGhostText', 'updateResults'],
        },
      ],
      [Events.ARROW_DOWN]: [
        { guard: 'hasMatches', target: States.RESULTS_OPEN, actions: ['showResults', 'renderResults'] },
      ],
      [Events.TAB]: [
        {
          guard: (p) => guard('hasMatches', p) && guard('commandHasParams', p),
          target: States.PARAM_MODE,
          actions: ['tabCompleteCommand', 'enterParamMode', 'updateGhostText', 'updateResults'],
        },
        {
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
          guard: 'isURL',
          target: States.CLOSING,
          actions: ['openURL', 'recordFrecency', 'clearInput', 'shutdown'],
        },
        {
          guard: 'userCommittedToCommand',
          target: States.EXECUTING,
          actions: ['recordFrecency', 'exitParamMode', 'executeCommand', 'clearInput', 'updateGhostText', 'updateResults'],
        },
        {
          guard: 'inputNonEmpty',
          target: States.CLOSING,
          actions: ['openSearch', 'clearInput', 'shutdown'],
        },
        // Empty input — no-op
      ],
      [Events.ESCAPE]: [
        { guard: 'textNonEmpty', target: States.IDLE, actions: ['clearInput', 'clearMatches', 'updateGhostText', 'updateResults'] },
        { target: States.CLOSING, actions: ['shutdown'] },
      ],
      [Events.VISIBILITY_HIDDEN]: [
        { target: States.CLOSING, actions: ['shutdown'] },
      ],
      [Events.CYCLE_MODE]: [
        { target: States.TYPING, actions: ['cycleMode'] },
      ],
    },

    // ===== RESULTS_OPEN =====
    [States.RESULTS_OPEN]: {
      [Events.INPUT]: [
        {
          guard: 'inputEmpty',
          target: States.IDLE,
          actions: ['clearInput', 'hideResults', 'updateGhostText', 'updateResults'],
        },
        {
          guard: (p) => p?.enterParamMode === true,
          target: States.PARAM_MODE,
          actions: ['setTyped', 'hideResults', 'computeMatches', 'enterParamMode', 'updateGhostText', 'updateResults'],
        },
        {
          target: States.TYPING,
          actions: ['setTyped', 'hideResults', 'computeMatches', 'updateGhostText', 'updateResults'],
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
          guard: (p) => guard('hasMatches', p) && guard('commandHasParams', p),
          target: States.PARAM_MODE,
          actions: ['tabCompleteCommand', 'enterParamMode', 'updateGhostText', 'updateResults'],
        },
        {
          guard: 'hasMatches',
          target: States.RESULTS_OPEN,
          actions: ['tabCycleInResults', 'updateGhostText', 'renderResults'],
        },
      ],
      [Events.ENTER]: [
        {
          guard: 'isURL',
          target: States.CLOSING,
          actions: ['openURL', 'recordFrecency', 'clearInput', 'shutdown'],
        },
        {
          // User committed — execute selected command
          target: States.EXECUTING,
          actions: ['recordFrecencyFromResults', 'exitParamMode', 'executeCommand', 'clearInput', 'hideResults', 'updateGhostText', 'updateResults'],
        },
      ],
      [Events.CLICK_RESULT]: [
        {
          target: States.EXECUTING,
          actions: ['setMatchIndexFromClick', 'recordFrecencyFromResults', 'exitParamMode', 'executeCommand', 'clearInput', 'hideResults', 'updateGhostText', 'updateResults'],
        },
      ],
      [Events.ESCAPE]: [
        { target: States.TYPING, actions: ['hideResults', 'updateResults'] },
      ],
      [Events.VISIBILITY_HIDDEN]: [
        { target: States.CLOSING, actions: ['shutdown'] },
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
          guard: (p) => guard('isItemTypeParam', p) && guard('hasParamSuggestions', p),
          target: States.EXECUTING,
          actions: ['acceptParamItem', 'exitParamMode'],
        },
        {
          // Non-item param or no suggestions — execute with typed text
          target: States.EXECUTING,
          actions: ['recordFrecency', 'executeCommandWithParams', 'clearInput', 'exitParamMode', 'updateGhostText', 'updateResults'],
        },
      ],
      [Events.CLICK_PARAM]: [
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
          guard: (p) => guard('isEditorMimeType', p) && guard('isArrayOutput', p),
          target: States.OUTPUT_SELECTION,
          actions: ['hideSpinner', 'enterOutputSelection'],
        },
        {
          guard: (p) => guard('isEditorMimeType', p),
          target: States.CLOSING,
          actions: ['hideSpinner', 'publishEditorOpen', 'shutdown'],
        },
        {
          guard: (p) => guard('isArrayOutput', p) && guard('hasDownstreamCommands', p),
          target: States.CHAIN_MODE,
          actions: ['hideSpinner', 'enterChainMode'],
        },
        {
          guard: (p) => guard('isArrayOutput', p),
          target: States.OUTPUT_SELECTION,
          actions: ['hideSpinner', 'enterOutputSelection'],
        },
        {
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
        { target: States.CHAIN_MODE, actions: ['updateChainFromPopup', 'computeChainMatches', 'showResults', 'updateGhostText', 'updateResults', 'refocusPanel'] },
      ],
      [Events.VISIBILITY_HIDDEN]: [
        { target: States.CLOSING, actions: ['exitChainMode', 'shutdown'] },
      ],
    },

    // ===== CHAIN_POPUP =====
    [States.CHAIN_POPUP]: {
      [Events.POPUP_RESULT]: [
        { guard: 'popupDone', target: States.CLOSING, actions: ['shutdown'] },
        { target: States.CHAIN_MODE, actions: ['updateChainFromPopup', 'computeChainMatches', 'showResults', 'updateGhostText', 'updateResults', 'refocusPanel'] },
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

      // Run actions
      if (transition.actions) {
        for (const actionName of transition.actions) {
          runAction(actionName, payload);
        }
      }

      // Update state (target can be null for actions that determine state themselves)
      if (target !== null && target !== undefined) {
        currentState = target;
      }

      // Enforce invariants
      enforceInvariants();

      log('transition', `${prevState} + ${event} → ${currentState}`, payload?.value !== undefined ? `(input: "${payload.value}")` : '');

      return { handled: true, prevState, nextState: currentState };
    }

    // No guard matched
    log('debug', `No guard matched for (${currentState}, ${event})`);
    return { handled: false, prevState: currentState, nextState: null };
  }

  // ===== Invariant Enforcement =====

  function enforceInvariants() {
    // Bound matchIndex
    if (data.matches.length === 0) {
      data.matchIndex = 0;
    } else if (data.matchIndex >= data.matches.length) {
      data.matchIndex = data.matches.length - 1;
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
      data.matchIndex = 0;
      data.showResults = false;
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
      const result = dispatch(Events.ESCAPE);
      // If we transitioned to CLOSING, the backend should close the window
      if (currentState === States.CLOSING) {
        return { handled: false };
      }
      return { handled: result.handled };
    },
  };
}
