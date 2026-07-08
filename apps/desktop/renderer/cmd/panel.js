/**
 * Cmd Panel - command input and execution UI
 *
 * Runs in isolated panel window (peek://cmd/panel.html)
 * Uses api.settings for persistent adaptive matching data
 *
 * State management is handled by the state machine module (state-machine.js).
 * All DOM events dispatch to the machine; actions perform side effects.
 */
import { id, labels, schemas, storageKeys, defaults } from './config.js';
import './commands.js'; // Load commands module to dispatch cmd-update-commands event
import { log } from 'peek://app/log.js';
import { getSuggestions, invalidateCache as invalidateCompleterCache } from './completers.js';
import { createStateMachine, States, Events } from './state-machine.js';
import { urlMatchable, urlCompletionAtGranularity, URL_GRANULARITY_ORDER } from './url-completion.js';

log('cmd:panel', 'loaded');

const api = window.app;

// Initialize the tile-preload surface before any API calls. Without this,
// `tokenValid` is false and api.settings / api.subscribe / api.commands
// all silently no-op or reject.
if (api.initialize) {
  await api.initialize();
}

// Storage keys for persistent adaptive matching
const STORAGE_KEY_FEEDBACK = 'adaptiveFeedback';
const STORAGE_KEY_COUNTS = 'matchCounts';
const STORAGE_KEY_VERSION = 'adaptiveVersion';
// Version 2: removed prefix feedback that caused cross-contamination
const ADAPTIVE_VERSION = 2;

// Cache for adaptive data
let adaptiveDataCache = null;

/**
 * Load persisted adaptive data from tile settings. Each key is fetched
 * individually via api.settings.get(key).
 */
const loadAdaptiveData = async () => {
  if (adaptiveDataCache) {
    return adaptiveDataCache;
  }

  const [versionRes, feedbackRes, countsRes] = await Promise.all([
    api.settings.get(STORAGE_KEY_VERSION),
    api.settings.get(STORAGE_KEY_FEEDBACK),
    api.settings.get(STORAGE_KEY_COUNTS),
  ]);

  const storedVersion = (versionRes.success && versionRes.data) || 0;
  const storedCounts = (countsRes.success && countsRes.data) || {};
  const storedFeedback = (feedbackRes.success && feedbackRes.data) || {};

  if (storedVersion < ADAPTIVE_VERSION) {
    log('cmd:panel', 'loadAdaptiveData: resetting stale feedback data (version', storedVersion, '->', ADAPTIVE_VERSION + ')');
    adaptiveDataCache = {
      feedback: {},
      counts: storedCounts,
    };
    await Promise.all([
      api.settings.set(STORAGE_KEY_FEEDBACK, {}),
      api.settings.set(STORAGE_KEY_VERSION, ADAPTIVE_VERSION),
    ]);
  } else {
    adaptiveDataCache = {
      feedback: storedFeedback,
      counts: storedCounts,
    };
  }
  log('cmd:panel', 'loadAdaptiveData: loaded', Object.keys(adaptiveDataCache.feedback).length, 'feedback entries,', Object.keys(adaptiveDataCache.counts).length, 'count entries');
  return adaptiveDataCache;
};

/**
 * Save adaptive data to extension settings
 */
const saveAdaptiveData = async (feedback, counts) => {
  adaptiveDataCache = { feedback, counts };
  await Promise.all([
    api.settings.set(STORAGE_KEY_FEEDBACK, feedback),
    api.settings.set(STORAGE_KEY_COUNTS, counts),
  ]);
};

// ===== State Machine Setup =====

// Create the state machine with action handlers and guards
const machine = createStateMachine(actionHandlers(), {}, (...args) => log(...args));
const state = machine.getMutableData();

// Load adaptive data on startup
loadAdaptiveData().then(data => {
  state.adaptiveFeedback = data.feedback;
  state.matchCounts = data.counts;
  log('cmd:panel', 'Loaded adaptive data');
});

// Cached prefs for URL search behavior
let showUrlsInResults = defaults.prefs.showUrlsInResults;
let enterRunsInlineSuggestion = defaults.prefs.enterRunsInlineSuggestion;

// Load prefs on startup. api.settings.get(key) requires the per-row key;
// the legacy no-arg whole-object form was removed.
api.settings.get('prefs').then(result => {
  if (result.success && result.data) {
    showUrlsInResults = result.data.showUrlsInResults ?? defaults.prefs.showUrlsInResults;
    enterRunsInlineSuggestion = result.data.enterRunsInlineSuggestion ?? defaults.prefs.enterRunsInlineSuggestion;
  }
  log('cmd:panel', 'showUrlsInResults:', showUrlsInResults);
});

// Listen for settings changes (e.g., user toggles in settings UI)
api.subscribe('settings:changed', (payload) => {
  if (payload?.prefs?.showUrlsInResults !== undefined) {
    showUrlsInResults = payload.prefs.showUrlsInResults;
    log('cmd:panel', 'showUrlsInResults updated:', showUrlsInResults);
  }
  if (payload?.prefs?.enterRunsInlineSuggestion !== undefined) {
    enterRunsInlineSuggestion = payload.prefs.enterRunsInlineSuggestion;
    log('cmd:panel', 'enterRunsInlineSuggestion updated:', enterRunsInlineSuggestion);
  }
});

// Listen for URL mode activation (from Cmd+L shortcut in background.js)
api.subscribe('cmd:url-mode', () => {
  log('cmd:panel', 'URL mode requested');
  pendingUrlMode = true;
  // If panel is already visible (no upcoming visibilitychange), enter immediately
  if (!document.hidden && !urlModeActive) {
    enterUrlMode();
  }
});

// Close the panel when the user focuses another Peek window.
//
// macOS Cmd+` cycles through "standard" windows only — panel-type +
// alwaysOnTop windows (like this cmd panel) are skipped, so the panel
// never fires `blur` in that flow and the modal blur handler can't
// clean up. Subscribe to the global `window:focused` pubsub (published
// by apps/desktop/main/ipc.ts for every focus event) and hide the
// panel when another non-utility window gains focus. Utility children
// (chain popup, etc.) are excluded so opening one doesn't dismiss the
// panel it spawned.
let ownWindowId = null;
api.window.getWindowId().then((result) => {
  ownWindowId = result?.id ?? result;
});
api.subscribe('window:focused', async (msg) => {
  if (!msg || !msg.id) return;
  if (msg.id === ownWindowId) return;
  if (msg.role === 'utility') return;
  if (!ownWindowId) return;
  try {
    await api.window.hide(ownWindowId);
  } catch (err) {
    log.error('cmd:panel', 'Failed to hide panel on other-window focus:', err);
  }
});

// Chain popup state (module-level for cleanup)
let chainPopupWindowId = null;

// URL ghost-text state — inline ghost completion in command input
let urlGhostGeneration = 0;
let urlGhostSuggestion = null; // { url, matchable } | null
// Current inline-completion stop-point (host -> path1 -> path -> full). The ghost
// first shows at the smallest stop that extends the typed text; Tab expands it.
let urlGhostGranularity = 'host';
let urlGhostTimer = null;
const URL_GHOST_DEBOUNCE_MS = 150;
const URL_RESULT_LANE_LIMIT = 6;

// Current command context (mode, target window, etc.)
let commandContext = null;

// Major modes for cycling
const MAJOR_MODES = ['default', 'page', 'space', 'settings'];

// Current mode for UI display
let currentMode = 'default';
let currentModeMetadata = {};
let modeWasSet = false;

// URL mode state — activated by Cmd+L shortcut
let pendingUrlMode = false;
let urlModeActive = false;
let urlModeItems = [];  // frecency-sorted URL items for display

// Expose state for testing — allows waitForFunction to check command loading
// Provide backward-compatible boolean accessors on top of machine data
window._cmdState = new Proxy(state, {
  get(target, prop) {
    if (prop === 'paramMode') return machine.getState() === States.PARAM_MODE;
    if (prop === 'outputSelectionMode') return machine.getState() === States.OUTPUT_SELECTION;
    if (prop === 'chainMode') return machine.getState() === States.CHAIN_MODE || machine.getState() === States.CHAIN_POPUP;
    if (prop === 'executing') return machine.getState() === States.EXECUTING;
    if (prop === 'currentState') return machine.getState();
    if (prop === 'urlGhostSuggestion') return urlGhostSuggestion;
    return target[prop];
  }
});


// ===== Window Sizing =====

const COLLAPSED_HEIGHT = 60;
const EXPANDED_HEIGHT = 400;

function updateWindowSize() {
  const resultsVisible = document.getElementById('results')?.classList.contains('visible');
  const previewVisible = document.getElementById('preview-container')?.classList.contains('visible');
  const chainVisible = document.getElementById('chain-indicator')?.classList.contains('visible');
  const execVisible = document.getElementById('execution-state')?.classList.contains('visible');
  const chainStepsVisible = document.getElementById('chain-steps')?.classList.contains('visible');
  const isOutputSelection = machine.getState() === States.OUTPUT_SELECTION;

  const needsExpanded = resultsVisible || previewVisible || chainVisible || execVisible || isOutputSelection || chainStepsVisible;
  const targetHeight = needsExpanded ? EXPANDED_HEIGHT : COLLAPSED_HEIGHT;

  api.window.resize(600, targetHeight);
}

// ===== Command Update Listener =====

window.addEventListener('cmd-update-commands', function(e) {
  log('cmd:panel', 'received updated commands');
  state.commands = e.detail;
});

// ===== Mode Indicator Functions =====

function updateModeIndicator() {
  const indicator = document.getElementById('mode-indicator');
  if (!indicator) return;

  const label = indicator.querySelector('.mode-label');
  indicator.setAttribute('data-mode', currentMode);

  if (currentMode === 'space' && currentModeMetadata.spaceName) {
    label.textContent = currentModeMetadata.spaceName;
  } else {
    label.textContent = currentMode;
  }

  log('cmd:panel', 'Mode indicator updated:', currentMode, currentModeMetadata);
}

const loadCommandContext = async () => {
  try {
    const isTransient = await api.izui.isTransient();
    if (isTransient) {
      log('cmd:panel', 'Transient invocation - using default mode');
      currentMode = 'default';
      currentModeMetadata = {};
      modeWasSet = true;
      updateModeIndicator();
      commandContext = { mode: { major: 'default' } };
      return;
    }

    const targetWindowId = await api.window.getFocusedVisibleWindowId();

    if (api.context) {
      const modeResult = await api.context.get('mode', targetWindowId);
      if (modeResult.success && modeResult.data) {
        currentMode = modeResult.data.value || 'default';
        currentModeMetadata = modeResult.data.metadata || {};
        modeWasSet = true;
        log('cmd:panel', 'Loaded mode from context:', currentMode, currentModeMetadata);
        updateModeIndicator();
      }
    }

    // Construct commandContext from the resolved mode. The legacy
    // api.modes.getCommandContext() returned a richer shape, but the
    // only field consumed downstream (isCommandAvailable) is
    // commandContext.mode.major — derive it from currentMode.
    commandContext = { mode: { major: currentMode || 'default' } };
    log('cmd:panel', 'Loaded command context:', commandContext);
  } catch (err) {
    log.error('cmd:panel', 'Failed to load command context:', err);
    commandContext = null;
  }
};

async function cycleMode() {
  const currentIndex = MAJOR_MODES.indexOf(currentMode);
  const nextIndex = (currentIndex + 1) % MAJOR_MODES.length;
  const nextMode = MAJOR_MODES[nextIndex];

  log('cmd:panel', 'Cycling mode from', currentMode, 'to', nextMode);

  const targetWindowId = await api.window.getFocusedVisibleWindowId();
  const result = await api.context.setMode(nextMode, { windowId: targetWindowId });
  if (result.success) {
    currentMode = nextMode;
    currentModeMetadata = {};
    updateModeIndicator();
    await loadCommandContext();
  } else {
    log.error('cmd:panel', 'Failed to set mode:', result.error);
  }
}

async function initModeIndicator() {
  if (modeWasSet) {
    updateModeIndicator();
  } else if (commandContext?.mode?.major) {
    currentMode = commandContext.mode.major;
    modeWasSet = true;
    updateModeIndicator();
  } else {
    updateModeIndicator();
  }

  const indicator = document.getElementById('mode-indicator');
  if (indicator) {
    indicator.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      machine.dispatch(Events.CYCLE_MODE);
    });
  }

  if (api.context) {
    api.context.watchMode((mode, entry) => {
      log('cmd:panel', 'Context mode changed:', mode, entry);
      // watchMode's initial fire reads the CURRENT window's mode (cmd
      // panel's own window), which has no context entry — `mode` comes
      // back null and would overwrite the correct 'page'/'group'/etc.
      // value that loadCommandContext already set via the focused
      // visible window. Ignore null/empty and let loadCommandContext
      // win on the cold read; real mode changes during panel lifetime
      // still flow through because they publish with their own non-null
      // value.
      if (mode === null || mode === undefined) return;
      currentMode = mode || 'default';
      currentModeMetadata = entry?.metadata || {};
      updateModeIndicator();
    });
  }

  log('cmd:panel', 'Mode indicator initialized with mode:', currentMode);
}

function isCommandAvailable(cmd) {
  if (!cmd) return false;
  if (!cmd.modes || cmd.modes.length === 0) return true;
  if (!commandContext || !commandContext.mode) return true;
  const currentMajorMode = commandContext.mode.major;
  return cmd.modes.includes(currentMajorMode);
}

// ===== Command Matching =====

function findMatchingCommands(text) {
  log('cmd:panel', 'findMatchingCommands', text, Object.keys(state.commands).length);

  let matches = [];
  if (!text) return matches;

  const commandPart = text.split(' ')[0];
  const hasParameters = text.includes(' ');
  const lowerCommandPart = commandPart.toLowerCase();
  const lowerText = text.toLowerCase();

  // Check if typed text starts with a complete multi-word command name + space
  let committedCommand = null;
  if (hasParameters) {
    const trimmedLower = lowerText.trimEnd();
    for (const name of Object.keys(state.commands)) {
      const lowerName = name.toLowerCase();
      if (lowerName.includes(' ') && (trimmedLower === lowerName || lowerText.startsWith(lowerName + ' '))) {
        if (!committedCommand || name.length > committedCommand.length) {
          committedCommand = name;
        }
      }
    }
  }

  for (const name of Object.keys(state.commands)) {
    const cmd = state.commands[name];
    if (!isCommandAvailable(cmd)) continue;

    if (committedCommand) {
      if (name === committedCommand) matches.push(name);
      continue;
    }

    const lowerName = name.toLowerCase();
    const matchesCommand = lowerName.indexOf(lowerCommandPart) !== -1;
    const isCommandWithParams = hasParameters && lowerText.startsWith(lowerName + ' ');

    if (matchesCommand || isCommandWithParams) {
      matches.push(name);
    }
  }

  // Token-prefix predicate: returns true if input is a prefix of any
  // whitespace-separated token in the command name. This brings
  // multi-word variants (e.g. "open tags") into the same rank tier as
  // the bare noun ("tags") for input "tag" — otherwise the multi-word
  // variant has zero frecency and falls past the end of a Tab cycle
  // the user never reaches.
  const tokenPrefixMatch = (name) => {
    const tokens = name.toLowerCase().split(/\s+/);
    for (const tok of tokens) {
      if (tok.startsWith(lowerCommandPart)) return true;
    }
    return false;
  };

  // Sort by combined ranking score
  matches.sort(function(a, b) {
    const aLower = a.toLowerCase();
    const bLower = b.toLowerCase();

    if (hasParameters) {
      const aExact = aLower === lowerCommandPart;
      const bExact = bLower === lowerCommandPart;
      if (aExact && !bExact) return -1;
      if (bExact && !aExact) return 1;
    }

    // Token-prefix tier: any command where the input is a prefix of
    // some token outranks pure substring-only matches. This keeps
    // bare-noun ("tags") and "open <noun>" ("open tags") adjacent in
    // the cycle for input "tag".
    const aTokenPrefix = tokenPrefixMatch(a);
    const bTokenPrefix = tokenPrefixMatch(b);
    if (aTokenPrefix && !bTokenPrefix) return -1;
    if (bTokenPrefix && !aTokenPrefix) return 1;

    const aAdaptive = getAdaptiveScore(commandPart, a);
    const bAdaptive = getAdaptiveScore(commandPart, b);
    const aFrecency = getFrecencyScore(a);
    const bFrecency = getFrecencyScore(b);

    const aScore = (aAdaptive * 3) + aFrecency;
    const bScore = (bAdaptive * 3) + bFrecency;

    if (bScore !== aScore) return bScore - aScore;

    const aPrefix = aLower.startsWith(lowerCommandPart);
    const bPrefix = bLower.startsWith(lowerCommandPart);
    if (aPrefix && !bPrefix) return -1;
    if (bPrefix && !aPrefix) return 1;

    if (a.length !== b.length) return a.length - b.length;
    return a.localeCompare(b);
  });

  return matches;
}

// ===== Adaptive Feedback =====

function updateAdaptiveFeedback(typed, name) {
  log('cmd:panel', 'updateAdaptiveFeedback', typed, '->', name);

  // Apply decay to existing entries for this typed prefix (adapts to changing behavior)
  const DECAY = 0.95;
  const PRUNE_THRESHOLD = 0.1;
  if (state.adaptiveFeedback[typed]) {
    for (const key of Object.keys(state.adaptiveFeedback[typed])) {
      state.adaptiveFeedback[typed][key] *= DECAY;
      if (state.adaptiveFeedback[typed][key] < PRUNE_THRESHOLD) {
        delete state.adaptiveFeedback[typed][key];
      }
    }
  }

  if (!state.adaptiveFeedback[typed]) {
    state.adaptiveFeedback[typed] = {};
  }
  if (!state.adaptiveFeedback[typed][name]) {
    state.adaptiveFeedback[typed][name] = 0;
  }
  state.adaptiveFeedback[typed][name]++;

  const lowerName = name.toLowerCase();
  const lowerTyped = typed.toLowerCase();
  const words = lowerName.split(/[\s-]+/);

  for (const word of words) {
    if (lowerTyped.startsWith(word) || word.startsWith(lowerTyped)) continue;
    for (let len = 2; len <= word.length; len++) {
      const sub = word.substring(0, len);
      // Decay sub-prefix entries too
      if (state.adaptiveFeedback[sub]) {
        for (const key of Object.keys(state.adaptiveFeedback[sub])) {
          state.adaptiveFeedback[sub][key] *= DECAY;
          if (state.adaptiveFeedback[sub][key] < PRUNE_THRESHOLD) {
            delete state.adaptiveFeedback[sub][key];
          }
        }
      }
      if (!state.adaptiveFeedback[sub]) state.adaptiveFeedback[sub] = {};
      if (!state.adaptiveFeedback[sub][name]) state.adaptiveFeedback[sub][name] = 0;
      state.adaptiveFeedback[sub][name] += 0.25;
    }
  }

  saveAdaptiveData(state.adaptiveFeedback, state.matchCounts);
}

function getAdaptiveScore(typed, name) {
  const k = 3;
  const feedback = state.adaptiveFeedback[typed];
  if (!feedback || !feedback[name]) return 0;
  return feedback[name] / (feedback[name] + k);
}

function getFrecencyScore(name) {
  const k = 10;
  const count = state.matchCounts[name] || 0;
  if (count === 0) return 0;
  return count / (count + k);
}

function updateMatchCount(name) {
  if (!state.matchCounts[name]) state.matchCounts[name] = 0;
  state.matchCounts[name]++;
  saveAdaptiveData(state.adaptiveFeedback, state.matchCounts);
}

// ===== Param Mode Helpers =====

function getParamTokens() {
  const commandName = state.paramCommand;
  if (!commandName) return { partial: '', completedTokens: [] };

  const typed = state.typed || '';
  const lowerTyped = typed.toLowerCase();
  const lowerName = commandName.toLowerCase();

  let rest = '';
  if (lowerTyped.startsWith(lowerName + ' ')) {
    rest = typed.slice(commandName.length + 1);
  } else if (lowerTyped.startsWith(lowerName)) {
    rest = typed.slice(commandName.length);
  }

  const tokens = rest.split(/\s+/);
  const endsWithSpace = rest.endsWith(' ') || rest === '';

  if (endsWithSpace) {
    return { partial: '', completedTokens: tokens.filter(t => t.length > 0) };
  }

  const partial = tokens.pop() || '';
  return { partial, completedTokens: tokens.filter(t => t.length > 0) };
}

async function doUpdateParamSuggestions() {
  if (!state.paramCommand) return;

  const cmd = state.commands[state.paramCommand];
  if (!cmd) return;

  const paramDef = (cmd.params && cmd.params[0]) || null;
  if (!paramDef) {
    state.paramSuggestions = [];
    return;
  }

  const generation = ++state.paramGeneration;
  const { partial, completedTokens } = getParamTokens();

  let searchPartial = partial;
  if (paramDef.type === 'item') {
    searchPartial = [...completedTokens, partial].filter(Boolean).join(' ');
  }

  const prefix = paramDef.prefix || '';
  const exclude = paramDef.multiple
    ? new Set(
        completedTokens.map(t => {
          const stripped = prefix && t.toLowerCase().startsWith(prefix.toLowerCase())
            ? t.slice(prefix.length).toLowerCase()
            : t.toLowerCase();
          return stripped;
        })
      )
    : new Set();

  const suggestions = await getSuggestions(paramDef, searchPartial, exclude);

  if (generation !== state.paramGeneration) return;

  state.paramSuggestions = suggestions;
  state.paramIndex = suggestions.length > 0 ? 0 : -1;

  updateResultsUI();
  updateCommandUI();
}

// ===== Execution Context Builder =====

function buildExecutionContext(name, typed) {
  const trimmed = typed.trim();
  const nameLower = name.toLowerCase();
  const trimmedLower = trimmed.toLowerCase();
  let rest;
  if (trimmedLower.startsWith(nameLower)) {
    rest = trimmed.slice(name.length).trim();
  } else {
    const spaceIdx = trimmed.indexOf(' ');
    const firstWord = spaceIdx > 0 ? trimmedLower.slice(0, spaceIdx) : trimmedLower;
    if (nameLower.startsWith(firstWord)) {
      rest = spaceIdx > 0 ? trimmed.slice(spaceIdx + 1).trim() : '';
    } else {
      rest = trimmed;
    }
  }
  const params = rest.length > 0 ? rest.split(/\s+/) : [];
  const search = rest.length > 0 ? rest : null;

  // Also include the raw input value for defensive extraction by handlers
  const inputEl = document.getElementById('command-input');
  const inputValue = inputEl ? inputEl.value : typed;

  const context = { typed, name, params, search, value: inputValue };

  if ((machine.getState() === States.CHAIN_MODE || machine.getState() === States.EXECUTING) && state.chainContext) {
    context.input = state.chainContext.data;
    context.inputMimeType = state.chainContext.mimeType;
    context.inputTitle = state.chainContext.title;
    context.inputSource = state.chainContext.sourceCommand;
  }

  return context;
}

// ===== Chain Mode Functions =====

function mimeTypeMatches(pattern, actual) {
  if (!pattern || !actual) return false;
  if (pattern === '*/*' || pattern === actual) return true;
  const [pType, pSub] = pattern.split('/');
  const [aType] = actual.split('/');
  return pSub === '*' && pType === aType;
}

function findChainingCommands(mimeType) {
  return Object.values(state.commands).filter(cmd => {
    if (!cmd.accepts?.length) return false;
    return cmd.accepts.some(acceptedType => mimeTypeMatches(acceptedType, mimeType));
  });
}

async function doEnterChainMode(output, sourceCommand) {
  log('cmd:panel', 'Entering chain mode with output:', output.mimeType, output.title);

  hidePreview();

  state.chainContext = {
    data: output.data,
    mimeType: output.mimeType,
    title: output.title || 'Output',
    sourceCommand
  };

  state.chainStack.push({ ...state.chainContext });

  const chainingCommands = findChainingCommands(output.mimeType);
  log('cmd:panel', 'Found', chainingCommands.length, 'commands accepting', output.mimeType);

  state.typed = '';
  state.matches = chainingCommands.map(cmd => cmd.name);
  state.matchIndex = 0;

  updateChainUI();
  updateChainStepsUI();
  updateCommandUI();
  updateResultsUI();

  const popupUrl = output.interactive || getDefaultPopupForMime(output.mimeType);
  if (popupUrl && output.data) {
    await openChainPopup(popupUrl, output.data, output.mimeType, output.title);
  } else if (output.data) {
    showPreview(output.data, output.mimeType, output.title);
  }
}

function doExitChainMode() {
  log('cmd:panel', 'Exiting chain mode');

  state.chainContext = null;
  state.chainStack = [];
  state.matches = [];
  state.matchIndex = 0;
  state.chainPopupActive = false;

  if (chainPopupWindowId) {
    api.window.close(chainPopupWindowId);
    chainPopupWindowId = null;
  }

  hidePreview();
  updateChainUI();
  updateChainStepsUI();
  updateCommandUI();
  updateResultsUI();
}

function doChainUndo() {
  if (state.chainStack.length <= 1) {
    doExitChainMode();
    return;
  }

  state.chainStack.pop();
  state.chainContext = { ...state.chainStack[state.chainStack.length - 1] };

  const chainingCommands = findChainingCommands(state.chainContext.mimeType);
  state.matches = chainingCommands.map(cmd => cmd.name);
  state.matchIndex = 0;

  updateChainUI();
  updateChainStepsUI();
  updateCommandUI();
  updateResultsUI();

  if (state.chainContext.data) {
    const popupUrl = getDefaultPopupForMime(state.chainContext.mimeType);
    if (popupUrl) {
      hidePreview();
      openChainPopup(popupUrl, state.chainContext.data, state.chainContext.mimeType, state.chainContext.title);
    } else {
      showPreview(state.chainContext.data, state.chainContext.mimeType, state.chainContext.title);
    }
  }
}

// ===== Chain Popup Functions =====

const DEFAULT_POPUPS = {
  'text/': 'peek://cmd/chain-editor.html',
};

function getDefaultPopupForMime(mimeType) {
  if (!mimeType) return null;
  for (const [prefix, url] of Object.entries(DEFAULT_POPUPS)) {
    if (mimeType.startsWith(prefix)) return url;
  }
  return null;
}

async function openChainPopup(popupUrl, data, mimeType, title) {
  const sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  state.chainPopupActive = true;

  log('cmd:panel', 'Opening chain popup:', popupUrl, 'sessionId:', sessionId);

  let resultReceived = false;
  api.subscribe('chain-popup:result', (msg) => {
    if (msg.sessionId !== sessionId) return;
    if (resultReceived) return;
    resultReceived = true;
    state.chainPopupActive = false;
    chainPopupWindowId = null;

    log('cmd:panel', 'Received chain popup result, length:', (msg.data || '').length, 'done:', !!msg.done);

    machine.dispatch(Events.POPUP_RESULT, {
      done: msg.done,
      data: msg.data,
      mimeType: msg.mimeType || mimeType,
    });
  });

  const panelBounds = await api.window.getBounds();
  const editorHeight = 400;
  const editorY = Math.round(panelBounds.y - editorHeight / 2 + panelBounds.height / 2);

  const url = `${popupUrl}?sessionId=${encodeURIComponent(sessionId)}&mimeType=${encodeURIComponent(mimeType)}&title=${encodeURIComponent(title || 'Edit')}`;

  const openResult = await api.window.open(url, {
    role: 'utility',
    width: panelBounds.width,
    height: editorHeight,
    x: panelBounds.x,
    y: editorY,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    hasShadow: true,
    resizable: true,
  });

  chainPopupWindowId = openResult?.id || null;

  // Wait for popup's ES module to load and subscribe
  // TODO: Replace with proper ready signaling (bug fix #6)
  await new Promise(r => setTimeout(r, 300));

  api.publish('chain-popup:content', {
    sessionId,
    data,
    mimeType,
    title: title || 'Edit'
  });
}

// ===== Chain Steps UI =====

function updateChainStepsUI() {
  const stepsEl = document.getElementById('chain-steps');
  if (!stepsEl) return;

  const isChainState = machine.getState() === States.CHAIN_MODE || machine.getState() === States.CHAIN_POPUP;
  if (!isChainState || state.chainStack.length === 0) {
    stepsEl.classList.remove('visible');
    stepsEl.innerHTML = '';
    return;
  }

  stepsEl.innerHTML = '';
  stepsEl.classList.add('visible');

  state.chainStack.forEach((step, i) => {
    if (i > 0) {
      const arrow = document.createElement('span');
      arrow.className = 'chain-arrow';
      arrow.textContent = '-->';
      stepsEl.appendChild(arrow);
    }

    const stepEl = document.createElement('span');
    stepEl.className = 'chain-step';
    if (i === state.chainStack.length - 1) stepEl.classList.add('active');
    stepEl.textContent = step.sourceCommand || step.title || step.mimeType;
    stepsEl.appendChild(stepEl);
  });

  updateWindowSize();
}

// ===== Output Selection Mode Functions =====

function doEnterOutputSelectionMode(items, mimeType, sourceCommand) {
  log('cmd:panel', 'Entering output selection mode with', items.length, 'items');

  state.outputItems = items;
  state.outputItemIndex = 0;
  state.outputMimeType = mimeType;
  state.outputSourceCommand = sourceCommand;

  state.typed = '';
  state.matches = [];
  state.showResults = false;

  updateOutputSelectionUI();
}

function doExitOutputSelectionMode() {
  log('cmd:panel', 'Exiting output selection mode');

  state.outputItems = [];
  state.outputItemIndex = 0;
  state.outputMimeType = null;
  state.outputSourceCommand = null;

  hidePreview();
  const resultsContainer = document.getElementById('results');
  if (resultsContainer) {
    resultsContainer.classList.remove('visible');
    resultsContainer.innerHTML = '';
  }
}

function doSelectOutputItem() {
  if (state.outputItems.length === 0) return;

  const selectedItem = state.outputItems[state.outputItemIndex];
  log('cmd:panel', 'Selected output item:', state.outputItemIndex, selectedItem);

  const mimeType = state.outputMimeType;
  const sourceCommand = state.outputSourceCommand;
  doExitOutputSelectionMode();

  if (mimeType === 'item' && selectedItem.id) {
    log('cmd:panel', 'Opening editor for selected item:', selectedItem.id);
    api.publish('editor:open', { itemId: selectedItem.id });
    machine.setState(States.CLOSING);
    setTimeout(shutdown, 100);
    return;
  }

  // For other mimeTypes, enter chain mode
  machine.setState(States.CHAIN_MODE);
  doEnterChainMode({
    data: selectedItem,
    mimeType: mimeType,
    title: getItemTitle(selectedItem)
  }, sourceCommand);
}

function getItemTitle(item) {
  if (typeof item === 'string') return item.slice(0, 50);
  if (typeof item === 'object' && item !== null) {
    return item.name || item.title || item.label || item.id || JSON.stringify(item).slice(0, 50);
  }
  return String(item).slice(0, 50);
}

function updateOutputSelectionUI() {
  const resultsContainer = document.getElementById('results');
  if (!resultsContainer) return;

  resultsContainer.innerHTML = '';

  if (state.outputItems.length === 0) {
    resultsContainer.classList.remove('visible');
    return;
  }

  resultsContainer.classList.add('visible');

  state.outputItems.slice(0, 50).forEach((item, index) => {
    const itemEl = document.createElement('div');
    itemEl.className = 'command-item';
    if (index === state.outputItemIndex) itemEl.classList.add('selected');

    const nameSpan = document.createElement('span');
    nameSpan.className = 'cmd-name';
    nameSpan.textContent = getItemTitle(item);
    itemEl.appendChild(nameSpan);

    if (typeof item === 'object' && item !== null) {
      const descSpan = document.createElement('span');
      descSpan.className = 'cmd-desc';
      descSpan.textContent = Object.keys(item).slice(0, 3).join(', ');
      itemEl.appendChild(descSpan);
    }

    itemEl.addEventListener('click', () => {
      machine.dispatch(Events.CLICK_OUTPUT, { index });
    });

    resultsContainer.appendChild(itemEl);
  });

  if (state.outputItems[state.outputItemIndex]) {
    showPreview(
      state.outputItems[state.outputItemIndex],
      state.outputMimeType,
      `Item ${state.outputItemIndex + 1} of ${state.outputItems.length}`
    );
  }
}

// ===== Chain UI =====

function updateChainUI() {
  const chainIndicator = document.getElementById('chain-indicator');
  if (!chainIndicator) return;

  const isChainState = machine.getState() === States.CHAIN_MODE || machine.getState() === States.CHAIN_POPUP;
  if (isChainState && state.chainContext) {
    chainIndicator.classList.add('visible');
    document.getElementById('chain-mime').textContent = state.chainContext.mimeType;
    document.getElementById('chain-title').textContent = state.chainContext.title || '';
  } else {
    chainIndicator.classList.remove('visible');
  }
  updateWindowSize();
}

// ===== Preview Functions =====

function showPreview(data, mimeType, title) {
  const previewContainer = document.getElementById('preview-container');
  const previewContent = document.getElementById('preview-content');
  const previewMime = document.getElementById('preview-mime');
  const previewTitle = document.getElementById('preview-title');

  if (!previewContainer || !previewContent) return;

  const renderer = getRenderer(mimeType);
  previewContent.innerHTML = renderer(data);

  if (previewMime) previewMime.textContent = mimeType;
  if (previewTitle) previewTitle.textContent = title || '';

  previewContainer.classList.add('visible');
  updateWindowSize();
}

function hidePreview() {
  const previewContainer = document.getElementById('preview-container');
  if (previewContainer) previewContainer.classList.remove('visible');
  updateWindowSize();
}

// ===== MIME Type Renderers =====

function getRenderer(mimeType) {
  const renderers = {
    'application/json': renderJson,
    'text/csv': renderCsv,
    'text/plain': renderPlain,
    'text/markdown': renderMarkdown,
    'text/html': renderHtml
  };

  if (renderers[mimeType]) return renderers[mimeType];
  const [type] = mimeType.split('/');
  if (type === 'text') return renderPlain;
  return renderDefault;
}

function renderJson(data) {
  try {
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    if (Array.isArray(parsed) && parsed.length > 0) {
      if (typeof parsed[0] === 'object' && parsed[0] !== null) {
        return renderJsonTable(parsed);
      } else {
        const items = parsed.slice(0, 50).map((item, i) =>
          `<div class="preview-list-item">${i + 1}. ${escapeHtml(String(item))}</div>`
        ).join('');
        const more = parsed.length > 50 ? `<div class="preview-more">... and ${parsed.length - 50} more</div>` : '';
        return `<div class="preview-list">${items}${more}</div>`;
      }
    }
    return `<pre class="preview-json">${escapeHtml(JSON.stringify(parsed, null, 2))}</pre>`;
  } catch (e) {
    return `<pre class="preview-error">Invalid JSON: ${escapeHtml(String(data))}</pre>`;
  }
}

function renderJsonTable(data) {
  const keys = new Set();
  data.forEach(item => {
    if (typeof item === 'object' && item !== null) Object.keys(item).forEach(k => keys.add(k));
  });
  const headers = Array.from(keys).slice(0, 6);
  const headerRow = headers.map(h => `<th>${escapeHtml(String(h))}</th>`).join('');
  const rows = data.slice(0, 30).map(item => {
    const cells = headers.map(h => {
      const val = item[h];
      const display = val === null || val === undefined ? '' :
                      typeof val === 'object' ? JSON.stringify(val) : String(val);
      return `<td>${escapeHtml(display.slice(0, 50))}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');
  const more = data.length > 30 ? `<div class="preview-more">Showing 30 of ${data.length} items</div>` : '';
  return `<table class="preview-table"><thead><tr>${headerRow}</tr></thead><tbody>${rows}</tbody></table>${more}`;
}

function renderCsv(data) {
  const lines = String(data).split('\n').slice(0, 20);
  const rows = lines.map(line => {
    const cells = line.split(',').map(cell => `<td>${escapeHtml(cell.trim())}</td>`).join('');
    return `<tr>${cells}</tr>`;
  }).join('');
  return `<table class="preview-csv">${rows}</table>`;
}

function renderMarkdown(data) {
  const text = String(data).slice(0, 4000);
  const html = text.split('\n').map(line => {
    if (line.startsWith('## ')) return `<h3>${escapeHtml(line.slice(3))}</h3>`;
    if (line.startsWith('# ')) return `<h2>${escapeHtml(line.slice(2))}</h2>`;
    if (line.trim() === '---') return '<hr>';
    let processed = escapeHtml(line);
    processed = processed.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    processed = processed.replace(/\*(.+?)\*/g, '<em>$1</em>');
    if (line.startsWith('- ')) return `<li>${processed.slice(2)}</li>`;
    if (line.trim() === '') return '<br>';
    return `<p>${processed}</p>`;
  }).join('\n');
  return `<div class="preview-markdown">${html}</div>`;
}

function renderPlain(data) {
  return `<pre class="preview-plain">${escapeHtml(String(data).slice(0, 2000))}</pre>`;
}

function renderHtml(data) {
  return `<pre class="preview-html">${escapeHtml(String(data).slice(0, 2000))}</pre>`;
}

function renderDefault(data) {
  return `<pre class="preview-default">${escapeHtml(String(data).slice(0, 1000))}</pre>`;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ===== Execution State UI =====

const EXECUTION_TIMEOUT_MS = 30000;

function showExecutionState(commandName) {
  state.executingCommand = commandName;
  state.executionError = null;

  const execState = document.getElementById('execution-state');
  if (!execState) return;

  execState.classList.remove('error');
  execState.classList.add('visible');

  const spinner = execState.querySelector('.spinner');
  const execText = execState.querySelector('.exec-text');

  if (spinner) spinner.style.display = 'block';
  if (execText) execText.textContent = `Running "${commandName}"...`;
  updateWindowSize();
}

function hideExecutionState() {
  state.executingCommand = null;
  state.executionError = null;

  if (state.executionTimeout) {
    clearTimeout(state.executionTimeout);
    state.executionTimeout = null;
  }

  const execState = document.getElementById('execution-state');
  if (execState) {
    execState.classList.remove('visible');
    execState.classList.remove('error');
  }
  updateWindowSize();
}

function showExecutionError(commandName, errorMsg) {
  state.executionError = errorMsg;

  if (state.executionTimeout) {
    clearTimeout(state.executionTimeout);
    state.executionTimeout = null;
  }

  const execState = document.getElementById('execution-state');
  if (!execState) return;

  execState.classList.add('error');
  execState.classList.add('visible');

  const spinner = execState.querySelector('.spinner');
  const execText = execState.querySelector('.exec-text');

  if (spinner) spinner.style.display = 'none';
  if (execText) {
    execText.innerHTML = `<span class="exec-error">"${escapeHtml(commandName)}" failed: ${escapeHtml(errorMsg)}</span>`;
  }
  updateWindowSize();

  // Auto-hide after 5 seconds
  setTimeout(() => {
    if (state.executionError === errorMsg) {
      machine.dispatch(Events.ERROR_TIMEOUT);
    }
  }, 5000);
}

// ===== Execute Command =====

async function doExecute(name, typed, extra = {}) {
  log('cmd:panel', 'execute() called with:', name, typed);
  if (!state.commands[name]) {
    log.error('cmd:panel', 'Command not found:', name);
    machine.dispatch(Events.COMMAND_ERROR, { name, error: 'Command not found. Try again in a moment.' });
    return;
  }

  log('cmd:panel', 'executing cmd', name, typed);
  const context = buildExecutionContext(name, typed);
  if (extra.selectedItem) {
    context.selectedItem = extra.selectedItem;
  }

  // Delay showing execution state (only show if command takes > 150ms)
  const SHOW_SPINNER_DELAY_MS = 150;
  const showStateTimer = setTimeout(() => {
    showExecutionState(name);
  }, SHOW_SPINNER_DELAY_MS);

  const timeoutPromise = new Promise((_, reject) => {
    state.executionTimeout = setTimeout(() => {
      reject(new Error(`Command timed out after ${EXECUTION_TIMEOUT_MS / 1000}s`));
    }, EXECUTION_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([
      state.commands[name].execute(context),
      timeoutPromise
    ]);

    clearTimeout(showStateTimer);
    if (state.executionTimeout) {
      clearTimeout(state.executionTimeout);
      state.executionTimeout = null;
    }

    log('cmd:panel', 'command result:', result);

    // Determine output routing and dispatch command_complete with routing info
    const payload = { result: result || {}, name };

    if (result && result.output && result.output.data && result.output.mimeType) {
      const outputData = result.output.data;
      const outputMimeType = result.output.mimeType;

      // Check for downstream commands to set hasDownstream
      const downstreamCommands = findChainingCommands(outputMimeType);
      payload.hasDownstream = downstreamCommands.length > 0;
    }

    machine.dispatch(Events.COMMAND_COMPLETE, payload);

  } catch (err) {
    clearTimeout(showStateTimer);
    log.error('cmd:panel', 'Command execution error:', err);
    machine.dispatch(Events.COMMAND_ERROR, { name, error: err.message || 'Unknown error' });
  }
}

// ===== URL Validation =====

function getValidURL(str) {
  if (!str) return { valid: false };

  const hasValidProtocol = /^(https?|ftp|file|peek):\/\//.test(str);

  if (!hasValidProtocol) {
    const isDomainPattern = /^([a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}(\/.*)?$/.test(str);
    const isLocalhost = /^localhost(:\d+)?(\/.*)?$/.test(str);

    if (isDomainPattern || isLocalhost) {
      const urlWithProtocol = 'https://' + str;
      try {
        new URL(urlWithProtocol);
        return { valid: true, url: urlWithProtocol };
      } catch (e) {
        return { valid: false };
      }
    }
    return { valid: false };
  }

  try {
    new URL(str);
    return { valid: true, url: str };
  } catch (e) {
    return { valid: false };
  }
}

// ===== Inline URL Ghost-Text for Normal Cmd Mode =====
// urlMatchable / urlCompletionAtGranularity / URL_GRANULARITY_ORDER are imported
// from ./url-completion.js (a pure, unit-tested leaf module).

/**
 * Clear the URL ghost suggestion and cancel any pending debounce timer.
 */
function clearUrlGhost() {
  state.urlMatches = [];
  urlGhostSuggestion = null;
  urlGhostGranularity = 'host';
  urlGhostGeneration++;
  if (urlGhostTimer) {
    clearTimeout(urlGhostTimer);
    urlGhostTimer = null;
  }
}

/**
 * Debounced query for the best frecency-ranked URL that starts with the
 * typed text. On success, stores the result as urlGhostSuggestion and
 * triggers a UI update so updateCommandUI can render the ghost remainder.
 */
function triggerUrlGhost(text) {
  if (urlGhostTimer) {
    clearTimeout(urlGhostTimer);
    urlGhostTimer = null;
  }

  if (!text || text.length < 2) {
    clearUrlGhost();
    updateCommandUI();
    return;
  }

  const generation = ++urlGhostGeneration;

  urlGhostTimer = setTimeout(async () => {
    try {
      const result = await api.datastore.queryItems({ type: 'url', sortBy: 'frecency', limit: 10, search: text });
      if (generation !== urlGhostGeneration) return; // stale
      const allResults = (result.success && result.data) ? result.data : [];
      const filtered = allResults.filter(item => !item.content?.startsWith('peek://'));
      // Substring-everywhere: the ghost suggestion is the frecency-best SUBSTRING
      // match, not a prefix match. The DB query already substring-filtered
      // (search:text) and frecency-sorted, so filtered[0] is the highest-frecency
      // url containing the typed text — prefix or not. The bet: frecency predicts
      // intent, and the auto-open dropdown shows alternatives for fast correction.
      // When filtered[0] happens to be a prefix, appendUrlGhost still renders the
      // inline remainder; otherwise the inline completion is silent and the lane
      // carries it.
      const best = filtered[0];
      const suggestion = best
        ? { url: best.content, matchable: urlMatchable(best.content) }
        : null;
      const urlMatches = filtered.slice(0, URL_RESULT_LANE_LIMIT);
      machine.dispatch(Events.GHOST_RESOLVED, { suggestion, urlMatches });
    } catch (e) {
      log.error('cmd:panel', 'URL ghost query failed:', e);
    }
  }, URL_GHOST_DEBOUNCE_MS);
}

/**
 * The current-granularity completion string when it is a forward prefix-
 * completion of `anchor` (the user's real typed text), else null. This ONE
 * predicate is the source of truth for "is an inline completion currently
 * shown, and what is it?" — render, fill+select, Tab-gate and Enter-gate all
 * key off it, so the substring (non-prefix) case never shows and never opens.
 *
 * `anchor` is always state.typed (the user's actual keystrokes) — NOT the
 * native input.value, which we overwrite with the completion when we fill.
 */
function currentGhostCompletion(anchor) {
  if (!urlGhostSuggestion) return null;
  const c = urlCompletionAtGranularity(urlGhostSuggestion.url, urlGhostGranularity);
  const t = (anchor || '').trim();
  if (c.toLowerCase().startsWith(t.toLowerCase()) && c.length > t.length) return c;
  return null;
}

/** First granularity whose completion forward-extends `anchor`; 'full' if none. */
function initialGhostGranularity(anchor) {
  if (!urlGhostSuggestion) return 'host';
  const t = (anchor || '').trim();
  for (const g of URL_GRANULARITY_ORDER) {
    const c = urlCompletionAtGranularity(urlGhostSuggestion.url, g);
    if (c.toLowerCase().startsWith(t.toLowerCase()) && c.length > t.length) return g;
  }
  return 'full';
}

/** Next stop-point whose completion is strictly longer; stays put at the last. */
function nextGranularityBeyond(current, currentCompletion) {
  if (!urlGhostSuggestion) return current;
  const idx = URL_GRANULARITY_ORDER.indexOf(current);
  for (let i = idx + 1; i < URL_GRANULARITY_ORDER.length; i++) {
    const g = URL_GRANULARITY_ORDER[i];
    const c = urlCompletionAtGranularity(urlGhostSuggestion.url, g);
    if (c.length > currentCompletion.length) return g;
  }
  return current;
}

/**
 * Camp-1 selected-text mechanic: fill the native input with the current-
 * granularity completion and NATIVELY SELECT the suffix beyond `anchor` (a real
 * DOM selection anchored at the typed length). Backspace / type-over then delete
 * the selected suffix for free, rejecting the completion down to the bare typed
 * text. No-op when a command match owns the input, or when the completion isn't
 * a forward prefix-completion (the substring case shows nothing inline).
 */
function applyGhostSelection(anchor) {
  if (state.matches.length > 0) return; // a command match owns the input
  const commandInput = document.getElementById('command-input');
  if (!commandInput) return;
  const completion = currentGhostCompletion(anchor);
  if (!completion) return;
  const t = (anchor || '').trim();
  commandInput.value = completion;
  commandInput.setSelectionRange(t.length, completion.length, 'backward');
  updateCommandUI();
  syncCommandTextScroll();
}

/**
 * Returns true when the URL ghost can be accepted (Tab / ArrowRight): no command
 * matches and there is a shown forward completion at the current granularity.
 * Keyed off state.typed (not input.value) so it stays true after a fill has
 * overwritten input.value with the completion.
 */
function urlGhostAcceptable() {
  if (state.matches.length > 0) return false;
  return currentGhostCompletion(state.typed) !== null;
}

/**
 * Accept/expand the URL ghost: advance to the next granularity stop-point
 * (host -> path1 -> path -> full) and re-fill + re-select the longer completion.
 * At the last distinct stop it stays put and just re-selects. state.typed is
 * left untouched — it remains the user's real typed text (the selection anchor),
 * so Backspace at any stop still rejects to the bare typed text.
 * Invoked via the FSM's `acceptUrlGhost` action (ACCEPT_GHOST event).
 */
function doAcceptUrlGhost() {
  if (!urlGhostSuggestion) return;
  const currentCompletion = urlCompletionAtGranularity(urlGhostSuggestion.url, urlGhostGranularity);
  urlGhostGranularity = nextGranularityBeyond(urlGhostGranularity, currentCompletion);
  applyGhostSelection(state.typed);
}

// ===== URL Mode Functions =====

/**
 * Query frecency-sorted URL items from the datastore.
 * Optionally filter by search text (matches title, domain, content).
 */
async function queryUrlsByFrecency(search = '', limit = 20) {
  // Request extra items to account for filtered peek:// URLs
  const query = { type: 'url', sortBy: 'frecency', limit: limit + 10 };
  if (search) query.search = search;

  const result = await api.datastore.queryItems(query);
  if (!result.success) return [];
  // Filter out internal peek:// URLs — URL mode should only show web URLs
  const items = (result.data || []).filter(item => !item.content?.startsWith('peek://'));
  return items.slice(0, limit);
}

/**
 * Enter URL mode: query frecency URLs and show them as results.
 */
async function enterUrlMode() {
  urlModeActive = true;
  pendingUrlMode = false;

  // Set mode indicator
  currentMode = 'url';
  updateModeIndicator();

  // Update placeholder
  const input = document.getElementById('command-input');
  if (input) {
    input.placeholder = 'Search URLs or type an address...';
  }

  // Query frecency-sorted URLs
  urlModeItems = await queryUrlsByFrecency('', 20);
  log('cmd:panel', 'URL mode: loaded', urlModeItems.length, 'frecency URLs');

  // Show results immediately
  renderUrlResults(urlModeItems);
}

/**
 * Exit URL mode and restore normal panel behavior.
 */
function exitUrlMode() {
  urlModeActive = false;
  urlModeItems = [];

  const input = document.getElementById('command-input');
  if (input) {
    input.placeholder = 'Feed meeeee';
  }
}

/**
 * Filter URL mode items based on typed text.
 */
async function filterUrlModeItems(text) {
  if (!urlModeActive) return;

  if (!text) {
    // Show default frecency list
    urlModeItems = await queryUrlsByFrecency('', 20);
  } else {
    // Query with search filter
    urlModeItems = await queryUrlsByFrecency(text, 20);
  }

  renderUrlResults(urlModeItems);
}

/**
 * Render URL results in the results container.
 * Shows favicon, title, and domain/URL for each item.
 */
function renderUrlResults(items) {
  const resultsContainer = document.getElementById('results');
  resultsContainer.innerHTML = '';

  if (items.length === 0) {
    resultsContainer.classList.remove('visible');
    updateWindowSize();
    return;
  }

  resultsContainer.classList.add('visible');

  items.forEach((item, index) => {
    const el = document.createElement('div');
    el.className = 'command-item url-result-item';
    if (index === state.matchIndex) el.classList.add('selected');

    // Favicon
    const faviconUrl = item.favicon || '';
    if (faviconUrl) {
      const favicon = document.createElement('img');
      favicon.className = 'url-favicon';
      favicon.src = faviconUrl;
      favicon.width = 16;
      favicon.height = 16;
      favicon.onerror = () => { favicon.style.display = 'none'; };
      el.appendChild(favicon);
    }

    // Title
    const titleSpan = document.createElement('span');
    titleSpan.className = 'cmd-name url-title';
    let title = item.title || '';
    if (!title && item.metadata) {
      try {
        const meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata;
        title = meta.title || '';
      } catch (e) {}
    }
    titleSpan.textContent = title || item.content || 'Untitled';
    el.appendChild(titleSpan);

    // Domain / URL subtitle
    const urlSpan = document.createElement('span');
    urlSpan.className = 'cmd-desc url-subtitle';
    urlSpan.textContent = item.domain || item.content || '';
    el.appendChild(urlSpan);

    el.addEventListener('click', () => {
      state.matchIndex = index;
      openUrlModeItem(index);
    });

    resultsContainer.appendChild(el);
  });

  // Update match state for keyboard navigation
  state.matches = items.map((_, i) => `__url_${i}`);
  state.matchIndex = 0;

  updateWindowSize();
}

/**
 * Open a URL from URL mode results by index.
 */
function openUrlModeItem(index) {
  const item = urlModeItems[index];
  if (!item) return;

  const url = item.content;
  if (!url) return;

  log('cmd:panel', 'URL mode: opening', url);

  api.window.open(url, {
    role: 'content',
    width: 1024,
    height: 768,
    trackingSource: 'cmd',
    trackingSourceId: 'url-mode'
  }).catch(error => {
    log.error('cmd:panel', 'Failed to open URL from URL mode:', error);
  });

  // Record frecency
  updateMatchCount(url);

  // Close panel
  setTimeout(() => api.window.close(), 100);
}

/**
 * Update the ghost text overlay in URL mode.
 * Shows the selected URL's title as ghost completion.
 */
function updateCommandUI_UrlMode(trimmedText) {
  const commandText = document.getElementById('command-text');
  commandText.innerHTML = '';

  if (!trimmedText) {
    syncCommandTextScroll();
    return;
  }

  const typedSpan = document.createElement('span');
  typedSpan.className = 'typed';
  typedSpan.textContent = trimmedText;
  commandText.appendChild(typedSpan);
  syncCommandTextScroll();
}

function hasModifier(e) {
  return e.altKey || e.ctrlKey || e.metaKey;
}

// ===== UI Update Functions =====

/**
 * Mirror the (invisible) command-input's horizontal scroll position onto
 * the (visible) command-text overlay so the caret/typed-end stays inside
 * the visible region when content exceeds the input width.
 *
 * The real <input> has `caret-color: transparent` and `color: transparent`
 * — what the user sees is `#command-text` rendered absolutely over it.
 * The native input scrolls itself to keep the caret visible on every
 * keystroke and arrow-key move; we just reflect that scrollLeft onto
 * the display layer so the same visible region appears.
 *
 * `#command-text` has `overflow: hidden` (no scrollbar) but
 * `scrollLeft` is still settable programmatically — content scrolls
 * underneath the clipping window.
 */
function syncCommandTextScroll() {
  const commandInput = document.getElementById('command-input');
  const commandText = document.getElementById('command-text');
  if (commandInput && commandText) {
    commandText.scrollLeft = commandInput.scrollLeft;
  }
}

/**
 * If the current-granularity completion forward-extends the typed text, append
 * its suffix to #command-text as a HIGHLIGHTED (selected-style) span — mirroring
 * the native selection that applyGhostSelection puts on the transparent input.
 * The substring (non-prefix) case renders nothing (currentGhostCompletion null).
 */
function appendUrlGhost(typed) {
  const completion = currentGhostCompletion(typed);
  if (!completion) return;
  const t = (typed || '').trim();
  const commandText = document.getElementById('command-text');
  const ghostSpan = document.createElement('span');
  ghostSpan.className = 'cmd-inline-selection';
  ghostSpan.textContent = completion.substring(t.length);
  commandText.appendChild(ghostSpan);
}

function updateCommandUI() {
  const commandText = document.getElementById('command-text');
  commandText.innerHTML = '';

  if (!state.typed) return;

  // No command matches: show plain typed text + URL ghost completion.
  if (state.matches.length === 0) {
    const typedSpan = document.createElement('span');
    typedSpan.className = 'typed';
    typedSpan.textContent = state.typed;
    commandText.appendChild(typedSpan);
    appendUrlGhost(state.typed);
    syncCommandTextScroll();
    return;
  }

  const selectedMatch = state.matches[state.matchIndex];
  if (!selectedMatch) {
    const typedSpan = document.createElement('span');
    typedSpan.className = 'typed';
    typedSpan.textContent = state.typed;
    commandText.appendChild(typedSpan);
    return;
  }

  const userTyped = state.originalTyped || state.typed;
  const trimmedUserTyped = userTyped.trim();

  let typedCommand, typedParams;

  if (state.typed.toLowerCase().startsWith(selectedMatch.toLowerCase() + ' ')) {
    typedCommand = trimmedUserTyped.toLowerCase().startsWith(selectedMatch.toLowerCase())
      ? trimmedUserTyped.substring(0, Math.min(trimmedUserTyped.length, selectedMatch.length))
      : trimmedUserTyped;
    typedParams = state.typed.substring(selectedMatch.length);
  } else if (selectedMatch.toLowerCase().startsWith(trimmedUserTyped.toLowerCase())) {
    typedCommand = trimmedUserTyped;
    typedParams = '';
  } else if (trimmedUserTyped.toLowerCase() === selectedMatch.toLowerCase()) {
    typedCommand = trimmedUserTyped;
    typedParams = state.typed.substring(trimmedUserTyped.length);
  } else {
    const hasParameters = userTyped.includes(' ');
    typedCommand = hasParameters ? userTyped.substring(0, userTyped.indexOf(' ')) : userTyped;
    typedParams = hasParameters ? state.typed.substring(state.typed.indexOf(' ')) : '';
  }

  const lowerMatch = selectedMatch.toLowerCase();
  const lowerTyped = typedCommand.toLowerCase();
  const matchIdx = lowerMatch.indexOf(lowerTyped);

  if (matchIdx === 0) {
    const typedSpan = document.createElement('span');
    typedSpan.className = 'typed';
    typedSpan.textContent = typedCommand;
    commandText.appendChild(typedSpan);

    if (selectedMatch.length > typedCommand.length) {
      const restSpan = document.createElement('span');
      restSpan.textContent = selectedMatch.substring(typedCommand.length);
      commandText.appendChild(restSpan);
    }

    if (typedParams) {
      const paramsSpan = document.createElement('span');
      paramsSpan.className = 'typed';
      paramsSpan.textContent = typedParams;
      commandText.appendChild(paramsSpan);
    }
  } else if (matchIdx > 0) {
    const beforeSpan = document.createElement('span');
    beforeSpan.textContent = selectedMatch.substring(0, matchIdx);
    commandText.appendChild(beforeSpan);

    const typedSpan = document.createElement('span');
    typedSpan.className = 'typed';
    typedSpan.textContent = selectedMatch.substring(matchIdx, matchIdx + typedCommand.length);
    commandText.appendChild(typedSpan);

    const afterSpan = document.createElement('span');
    afterSpan.textContent = selectedMatch.substring(matchIdx + typedCommand.length);
    commandText.appendChild(afterSpan);

    if (typedParams) {
      const paramsSpan = document.createElement('span');
      paramsSpan.className = 'typed';
      paramsSpan.textContent = typedParams;
      commandText.appendChild(paramsSpan);
    }
  } else {
    const typedSpan = document.createElement('span');
    typedSpan.className = 'typed';
    typedSpan.textContent = state.typed;
    commandText.appendChild(typedSpan);
  }

  // Param mode ghost completion
  const isParamState = machine.getState() === States.PARAM_MODE;
  if (isParamState && state.paramSuggestions.length > 0) {
    const idx = state.paramIndex >= 0 ? state.paramIndex : 0;
    const suggestion = state.paramSuggestions[idx];
    if (suggestion) {
      const { partial } = getParamTokens();
      const cmd = state.commands[state.paramCommand];
      const paramDef = cmd && cmd.params && cmd.params[0];
      const ghostSource = (paramDef && paramDef.type === 'item') ? suggestion.title : suggestion.value;
      if (partial && ghostSource.toLowerCase().startsWith(partial.toLowerCase())) {
        const ghostText = ghostSource.substring(partial.length);
        if (ghostText) {
          const ghostSpan = document.createElement('span');
          ghostSpan.textContent = ghostText;
          commandText.appendChild(ghostSpan);
        }
      } else if (!partial) {
        const ghostSpan = document.createElement('span');
        ghostSpan.textContent = ghostSource;
        commandText.appendChild(ghostSpan);
      }
    }
  }

  syncCommandTextScroll();
}

function updateResultsUI() {
  const resultsContainer = document.getElementById('results');
  resultsContainer.innerHTML = '';

  const isOutputSelection = machine.getState() === States.OUTPUT_SELECTION;
  if (isOutputSelection) return;

  // Param mode: show parameter suggestions
  const isParamState = machine.getState() === States.PARAM_MODE;
  if (isParamState && state.paramSuggestions.length > 0) {
    resultsContainer.classList.add('visible');

    state.paramSuggestions.forEach((suggestion, index) => {
      const item = document.createElement('div');
      item.className = 'command-item';
      if (index === state.paramIndex) item.classList.add('selected');

      const nameSpan = document.createElement('span');
      nameSpan.className = 'cmd-name';
      nameSpan.textContent = suggestion.title;
      item.appendChild(nameSpan);

      if (suggestion.subtitle) {
        const descSpan = document.createElement('span');
        descSpan.className = 'cmd-desc';
        descSpan.textContent = suggestion.subtitle;
        item.appendChild(descSpan);
      }

      item.addEventListener('click', () => {
        machine.dispatch(Events.CLICK_PARAM, { index });
      });

      resultsContainer.appendChild(item);
    });

    updateWindowSize();
    return;
  }

  if (isParamState) {
    resultsContainer.classList.remove('visible');
    updateWindowSize();
    return;
  }

  const isChainState = machine.getState() === States.CHAIN_MODE;
  const urlMatches = isChainState ? [] : (state.urlMatches || []);
  const totalResults = state.matches.length + urlMatches.length;
  // Auto-open when >1 combined result; otherwise require explicit showResults (ArrowDown) or chain mode.
  if (totalResults === 0 || (totalResults <= 1 && !state.showResults && !isChainState)) {
    resultsContainer.classList.remove('visible');
    updateWindowSize();
    return;
  }
  resultsContainer.classList.add('visible');

  state.matches.forEach((match, index) => {
    const item = document.createElement('div');
    item.className = 'command-item';
    if (index === state.matchIndex) item.classList.add('selected');

    const cmd = state.commands[match];

    const nameSpan = document.createElement('span');
    nameSpan.className = 'cmd-name';
    nameSpan.textContent = match;
    item.appendChild(nameSpan);

    if (cmd && cmd.description) {
      const descSpan = document.createElement('span');
      descSpan.className = 'cmd-desc';
      descSpan.textContent = cmd.description;
      item.appendChild(descSpan);
    }

    if (cmd) {
      const badgesSpan = document.createElement('span');
      badgesSpan.className = 'cmd-badges';

      if (cmd.scope && cmd.scope !== 'global') {
        const scopeBadge = document.createElement('span');
        scopeBadge.className = 'cmd-badge cmd-badge-scope';
        scopeBadge.textContent = cmd.scope === 'window' ? '\u229E' : '\u29C9';
        scopeBadge.title = cmd.scope === 'window' ? 'Window command' : 'Page command';
        badgesSpan.appendChild(scopeBadge);
      }

      if (isChainState && cmd.accepts && cmd.accepts.length > 0) {
        const acceptBadge = document.createElement('span');
        acceptBadge.className = 'cmd-badge';
        acceptBadge.textContent = '\u2190 ' + cmd.accepts[0];
        badgesSpan.appendChild(acceptBadge);
      }

      if (cmd.produces && cmd.produces.length > 0) {
        const produceBadge = document.createElement('span');
        produceBadge.className = 'cmd-badge';
        produceBadge.textContent = '\u2192 ' + cmd.produces[0];
        badgesSpan.appendChild(produceBadge);
      }

      if (badgesSpan.children.length > 0) {
        item.appendChild(badgesSpan);
      }
    }

    // Route clicks through state machine dispatch (bug fix #3)
    item.addEventListener('click', () => {
      machine.dispatch(Events.CLICK_RESULT, { index, commandName: match });
    });

    resultsContainer.appendChild(item);
  });

  if (!isChainState && urlMatches.length > 0) {
    const header = document.createElement('div');
    header.className = 'results-section-header';
    header.textContent = 'Visited';
    resultsContainer.appendChild(header);

    urlMatches.forEach((item, i) => {
      const globalIndex = state.matches.length + i;
      const el = document.createElement('div');
      el.className = 'command-item url-result-item';
      if (globalIndex === state.matchIndex) el.classList.add('selected');

      const faviconUrl = item.favicon || '';
      if (faviconUrl) {
        const favicon = document.createElement('img');
        favicon.className = 'url-favicon';
        favicon.src = faviconUrl;
        favicon.width = 16;
        favicon.height = 16;
        favicon.onerror = () => { favicon.style.display = 'none'; };
        el.appendChild(favicon);
      }

      const titleSpan = document.createElement('span');
      titleSpan.className = 'cmd-name url-title';
      let title = item.title || '';
      if (!title && item.metadata) {
        try {
          const meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata;
          title = meta.title || '';
        } catch (e) {}
      }
      titleSpan.textContent = title || item.content || 'Untitled';
      el.appendChild(titleSpan);

      const urlSpan = document.createElement('span');
      urlSpan.className = 'cmd-desc url-subtitle';
      urlSpan.textContent = item.domain || item.content || '';
      el.appendChild(urlSpan);

      el.addEventListener('click', () => {
        machine.dispatch(Events.CLICK_URL_RESULT, { index: globalIndex });
      });

      resultsContainer.appendChild(el);
    });
  }

  // Keep the keyboard-selected row visible. #results is a fixed max-height
  // overflow-y:auto container, so a selection that moves below the fold — e.g.
  // arrowing down out of the command rows and into the Visited url lane when
  // enough commands match to push it off-screen — would otherwise land on an
  // invisible row with no visual feedback ("ArrowDown won't go into Visited",
  // peek dbaa172d). Deterministic post-render DOM sync, not a timer. Both
  // command and url rows carry the .command-item class, so this covers both.
  const selectedRow = resultsContainer.querySelector('.command-item.selected');
  if (selectedRow) selectedRow.scrollIntoView({ block: 'nearest' });

  updateWindowSize();
}

// ===== Shutdown =====

async function shutdown() {
  // Route through api.window.close() so the panel's keepLive:true flag
  // HIDES the window (closeOrHideWindow in windows.ts:411) instead of
  // destroying it. Raw native `window.close()` bypasses keepLive and
  // destroys, forcing a fresh window on every Cmd+K — and races with
  // the next open call's key-based reuse lookup.
  try {
    await api.window.close();
  } catch {
    // Fall through: worst case the window stays open momentarily until
    // the next user action. Better than throwing mid-shutdown.
  }
}

// ===== Action Handlers =====
// These are called by the state machine's action runner.
// They receive (payload, data) and perform DOM/IPC side effects.

function actionHandlers() {
  const commandInput = () => document.getElementById('command-input');

  return {
    setTyped(payload) {
      state.typed = payload.value;
      state.originalTyped = payload.value;
    },

    applyGhostResolution(payload) {
      urlGhostSuggestion = payload.suggestion || null;
      state.urlMatches = payload.urlMatches || [];
      if (urlGhostSuggestion) {
        // Show at the smallest stop-point that extends the typed text (default
        // host), then fill + natively select the suffix (Camp-1 mechanic).
        urlGhostGranularity = initialGhostGranularity(state.typed);
        applyGhostSelection(state.typed);
      }
      updateCommandUI();
      updateResultsUI();
      updateWindowSize();
    },

    acceptUrlGhost() {
      doAcceptUrlGhost();
    },

    clearInput() {
      const input = commandInput();
      if (input) {
        input.value = '';
      }
      state.typed = '';
      state.originalTyped = '';
      state.matches = [];
      state.matchIndex = 0;
      clearUrlGhost();
    },

    clearMatches() {
      state.matches = [];
      state.matchIndex = 0;
      clearUrlGhost();
    },

    computeMatches(payload) {
      const typed = payload?.value || state.typed;
      if (typed) {
        const isChainState = machine.getState() === States.CHAIN_MODE;
        if (isChainState && state.chainContext) {
          const chainingCommands = findChainingCommands(state.chainContext.mimeType);
          const chainingNames = new Set(chainingCommands.map(cmd => cmd.name));
          const allMatches = findMatchingCommands(typed);
          state.matches = allMatches.filter(name => chainingNames.has(name));
          clearUrlGhost();
        } else {
          state.matches = findMatchingCommands(typed);
          if (payload?.isDeleting) {
            // Reject-on-delete (deterministic per-event signal, no timer): after
            // a Backspace/delete the native input has already removed the
            // selected suffix, so don't re-arm or re-select the ghost.
            clearUrlGhost();
          } else if (showUrlsInResults) {
            triggerUrlGhost(typed.trim());
          } else {
            clearUrlGhost();
          }
        }
        state.matchIndex = 0;
      } else {
        state.matches = [];
        state.matchIndex = 0;
        clearUrlGhost();
      }
    },

    computeChainMatches() {
      if (state.typed && state.chainContext) {
        const chainingCommands = findChainingCommands(state.chainContext.mimeType);
        const chainingNames = new Set(chainingCommands.map(cmd => cmd.name));
        const allMatches = findMatchingCommands(state.typed);
        state.matches = allMatches.filter(name => chainingNames.has(name));
      } else if (state.chainContext) {
        const chainingCommands = findChainingCommands(state.chainContext.mimeType);
        state.matches = chainingCommands.map(cmd => cmd.name);
      } else {
        state.matches = [];
      }
      state.matchIndex = 0;
    },

    clearTypedKeepChain() {
      state.typed = '';
      const input = commandInput();
      if (input) input.value = '';
    },

    checkParamEntry(payload) {
      // Check if typed text auto-enters param mode
      const typed = payload?.value || state.typed;
      if (!typed) return;
      const typedLower = typed.toLowerCase();
      let paramCandidate = null;
      for (const matchName of state.matches) {
        const matchLower = matchName.toLowerCase();
        if (typedLower.startsWith(matchLower + ' ')) {
          if (!paramCandidate || matchName.length > paramCandidate.length) {
            paramCandidate = matchName;
          }
        }
      }
      if (paramCandidate) {
        const cmd = state.commands[paramCandidate];
        if (cmd && cmd.params && cmd.params.length > 0) {
          // Signal to the transition that param mode should be entered
          // This is handled by the INPUT transition's guard
          payload.enterParamMode = true;
          payload.paramCommandName = paramCandidate;
        }
      }
    },

    showResults() {
      state.showResults = true;
    },

    hideResults() {
      state.showResults = false;
    },

    renderResults() {
      updateResultsUI();
    },

    updateGhostText() {
      updateCommandUI();
    },

    updateResults() {
      updateResultsUI();
    },

    navigateDown() {
      state.matchIndex++;
    },

    navigateUp() {
      state.matchIndex--;
    },

    navigateParamDown() {
      state.paramIndex++;
    },

    navigateParamUp() {
      state.paramIndex--;
    },

    navigateOutputDown() {
      state.outputItemIndex++;
    },

    navigateOutputUp() {
      state.outputItemIndex--;
    },

    updateOutputUI() {
      updateOutputSelectionUI();
    },

    tabCompleteCommand() {
      const input = commandInput();
      const currentMatch = state.matches[state.matchIndex];
      const currentValue = (input ? input.value : state.typed).trim();

      const alreadyCompleted = currentValue === currentMatch ||
                                currentValue.startsWith(currentMatch + ' ');

      if (alreadyCompleted && state.matches.length > 1) {
        state.matchIndex = (state.matchIndex + 1) % state.matches.length;
      }

      const match = state.matches[state.matchIndex];
      state.typed = match + ' ';
      if (input) {
        input.value = state.typed;
        setTimeout(() => input.setSelectionRange(input.value.length, input.value.length), 0);
      }
    },

    shiftTabCycleCommand() {
      const input = commandInput();
      const currentMatch = state.matches[state.matchIndex];
      const currentValue = (input ? input.value : state.typed).trim();

      const alreadyCompleted = currentValue === currentMatch ||
                                currentValue.startsWith(currentMatch + ' ');

      if (alreadyCompleted && state.matches.length > 1) {
        state.matchIndex = (state.matchIndex - 1 + state.matches.length) % state.matches.length;
      }

      const match = state.matches[state.matchIndex];
      state.typed = match + ' ';
      if (input) {
        input.value = state.typed;
        setTimeout(() => input.setSelectionRange(input.value.length, input.value.length), 0);
      }
    },

    tabCycleInResults() {
      const input = commandInput();
      const currentMatch = state.matches[state.matchIndex];
      const currentValue = (input ? input.value : state.typed).trim();

      const alreadyCompleted = currentValue === currentMatch ||
                                currentValue.startsWith(currentMatch + ' ');

      if (alreadyCompleted && state.matches.length > 1) {
        state.matchIndex = (state.matchIndex + 1) % state.matches.length;
      }

      const match = state.matches[state.matchIndex];
      state.typed = match + ' ';
      if (input) {
        input.value = state.typed;
        setTimeout(() => input.setSelectionRange(input.value.length, input.value.length), 0);
      }
    },

    enterParamMode(payload) {
      const cmdName = payload?.paramCommandName || state.matches[state.matchIndex];
      const cmd = cmdName && state.commands[cmdName];
      if (!cmd) return;

      if (state.paramCommand !== cmdName) {
        log('cmd:panel', 'Entering param mode for:', cmdName);
        state.paramCommand = cmdName;
        state.paramSuggestions = [];
        state.paramIndex = -1;
      }

      doUpdateParamSuggestions();
    },

    exitParamMode() {
      if (state.paramCommand) {
        log('cmd:panel', 'Exiting param mode');
      }
      state.paramCommand = null;
      state.paramSuggestions = [];
      state.paramIndex = -1;
    },

    updateParamSuggestions() {
      doUpdateParamSuggestions();
    },

    fillParamText(payload) {
      const direction = payload?.direction === -1 ? -1 : 1;
      const cmd = state.commands[state.paramCommand];
      const paramDef = cmd && cmd.params && cmd.params[0];
      const len = state.paramSuggestions.length;
      if (len === 0) return;

      // For single-select, advance index first so highlighted matches displayed text
      let idx;
      if (!paramDef || !paramDef.multiple) {
        const cur = state.paramIndex >= 0 ? state.paramIndex : (direction === 1 ? -1 : 0);
        idx = (cur + direction + len) % len;
      } else {
        idx = state.paramIndex >= 0 ? state.paramIndex : 0;
      }
      if (idx < 0 || idx >= len) return;

      const suggestion = state.paramSuggestions[idx];
      const input = commandInput();
      const commandName = state.paramCommand;

      const fillText = (paramDef && paramDef.type === 'item' && suggestion.title)
        ? suggestion.title
        : suggestion.value;

      const typed = state.typed || '';
      const lowerTyped = typed.toLowerCase();
      const lowerName = commandName.toLowerCase();
      let beforeParams = commandName + ' ';

      let rest = '';
      if (lowerTyped.startsWith(lowerName + ' ')) {
        rest = typed.slice(commandName.length + 1);
      }

      let tokens = rest.split(/\s+/).filter(t => t.length > 0);
      const endsWithSpace = rest.endsWith(' ') || rest === '';

      if (!paramDef || !paramDef.multiple) {
        // Single-select: replace entire param with current selection
        tokens = [fillText];
      } else if (!endsWithSpace && tokens.length > 0) {
        tokens[tokens.length - 1] = fillText;
      } else {
        tokens.push(fillText);
      }

      const newValue = beforeParams + tokens.join(' ') + ' ';
      if (input) {
        input.value = newValue;
        setTimeout(() => input.setSelectionRange(newValue.length, newValue.length), 0);
      }
      state.typed = newValue;
      state.paramIndex = idx;

      if (paramDef && paramDef.multiple) {
        // Multi-select: refresh suggestions to exclude completed tokens
        doUpdateParamSuggestions();
      } else {
        // Single-select: suggestions don't change, just update UI
        updateResultsUI();
        updateCommandUI();
      }
    },

    fillParamTextReverse() {
      actions.fillParamText({ direction: -1 });
    },

    acceptParamItem(payload) {
      const idx = payload?.index !== undefined ? payload.index : (state.paramIndex >= 0 ? state.paramIndex : 0);
      if (idx < 0 || idx >= state.paramSuggestions.length) return;

      const suggestion = state.paramSuggestions[idx];
      const cmd = state.commands[state.paramCommand];
      const paramDef = cmd && cmd.params && cmd.params[0];

      if (paramDef && paramDef.type === 'item' && suggestion._item) {
        const commandName = state.paramCommand;
        const typed = commandName + ' ' + (suggestion.title || suggestion.value || '');
        const selectedItem = suggestion._item;

        // Record frecency
        const commandPart = (state.originalTyped || typed).split(' ')[0];
        updateMatchCount(commandName);
        updateAdaptiveFeedback(commandPart, commandName);
        state.lastExecuted = commandName;

        doExecute(commandName, typed, { selectedItem });
      } else {
        // Fallback: execute with typed text
        const commandName = state.paramCommand;
        const typed = state.typed;
        const commandPart = (state.originalTyped || typed).split(' ')[0];
        updateMatchCount(commandName);
        updateAdaptiveFeedback(commandPart, commandName);
        state.lastExecuted = commandName;

        doExecute(commandName, typed);
      }

      const input = commandInput();
      if (input) { input.value = ''; }
      state.typed = '';
    },

    setParamIndexFromClick(payload) {
      if (payload?.index !== undefined) {
        state.paramIndex = payload.index;
      }
    },

    recordFrecency(payload) {
      const name = payload?.commandName || state.matches[state.matchIndex];
      if (!name) return;
      const typed = state.originalTyped || state.typed || '';
      const commandPart = typed.split(' ')[0];
      state.lastExecuted = name;
      updateMatchCount(name);
      updateAdaptiveFeedback(commandPart, name);
    },

    recordFrecencyFromResults() {
      const name = state.matches[state.matchIndex];
      if (!name) return;
      const typed = state.originalTyped || state.typed || '';
      const commandPart = typed.split(' ')[0];
      state.lastExecuted = name;
      updateMatchCount(name);
      updateAdaptiveFeedback(commandPart, name);
    },

    setMatchIndexFromClick(payload) {
      if (payload?.index !== undefined) {
        state.matchIndex = payload.index;
      }
    },

    executeCommand(payload) {
      const name = payload?.commandName || state.matches[state.matchIndex];
      const typed = payload?.typed || state.typed;
      if (!name) return;
      doExecute(name, typed);
    },

    executeCommandWithParams() {
      const name = state.paramCommand || state.matches[state.matchIndex];
      const typed = state.typed;
      if (!name) return;
      doExecute(name, typed);
      const input = commandInput();
      if (input) { input.value = ''; }
      state.typed = '';
    },

    executeChainCommand() {
      const name = state.matches[state.matchIndex];
      const typed = state.typed;
      if (!name) return;
      doExecute(name, typed);
    },

    openURL(payload) {
      const trimmedText = (payload?.value || state.typed || '').trim();
      const urlResult = getValidURL(trimmedText);
      if (!urlResult.valid) return;

      log('cmd:panel', 'Opening URL:', urlResult.url);

      const frecencyTarget = urlResult.url;
      state.lastExecuted = frecencyTarget;
      updateMatchCount(frecencyTarget);
      updateAdaptiveFeedback(trimmedText, frecencyTarget);

      api.window.open(urlResult.url, {
        role: 'content',
        width: 1024,
        height: 768,
        trackingSource: 'cmd',
        trackingSourceId: 'url-direct'
      }).catch(error => {
        log.error('cmd:panel', 'Failed to open URL:', error);
      });
    },

    openSearch(payload) {
      const trimmedText = (payload?.value || state.typed || '').trim();
      if (!trimmedText) return;

      log('cmd:panel', 'Opening search for:', trimmedText);
      // No `key` — each invocation creates a new search window so users
      // can compare tag results side-by-side. The previous single-instance
      // `key:'search-home'` collapsed every `#tag` invocation onto the same
      // window and discarded the new query because the keepLive-reuse path
      // never gave the renderer the new URL.
      api.window.open(`peek://search/home.html?q=${encodeURIComponent(trimmedText)}`, {
        role: 'workspace',
        width: 700,
        height: 768,
        trackingSource: 'cmd',
        trackingSourceId: 'search'
      }).catch(error => {
        log.error('cmd:panel', 'Failed to open search:', error);
      });
    },

    openUrlGhost() {
      if (!urlGhostSuggestion) return;
      // Open the CURRENT completion, not the full stored URL: at 'full' (or if
      // somehow unshown) open the exact stored URL; otherwise synthesize a clean
      // https origin/path from the granularity completion (kills tracking query).
      const completion = currentGhostCompletion(state.typed);
      const url = (urlGhostGranularity === 'full' || !completion)
        ? urlGhostSuggestion.url
        : 'https://' + completion;
      log('cmd:panel', 'Opening URL ghost suggestion:', url);
      state.lastExecuted = url;
      updateMatchCount(url);
      api.window.open(url, {
        role: 'content',
        width: 1024,
        height: 768,
        trackingSource: 'cmd',
        trackingSourceId: 'url-ghost'
      }).catch(error => {
        log.error('cmd:panel', 'Failed to open URL ghost suggestion:', error);
      });
    },

    openSelectedUrlResult() {
      const urlIndex = state.matchIndex - state.matches.length;
      const item = state.urlMatches[urlIndex];
      if (!item || !item.content) return;
      const url = item.content;
      log('cmd:panel', 'Opening URL history result:', url);
      state.lastExecuted = url;
      updateMatchCount(url);
      api.window.open(url, {
        role: 'content',
        width: 1024,
        height: 768,
        trackingSource: 'cmd',
        trackingSourceId: 'history-result'
      }).catch(error => {
        log.error('cmd:panel', 'Failed to open URL history result:', error);
      });
    },

    shutdown() {
      setTimeout(shutdown, 100);
    },

    shutdownDelayed() {
      setTimeout(shutdown, 100);
    },

    showSpinner(payload) {
      showExecutionState(payload?.name || state.executingCommand);
    },

    hideSpinner() {
      hideExecutionState();
    },

    showError(payload) {
      const name = payload?.name || state.executingCommand || 'command';
      const msg = payload?.error || 'Unknown error';
      showExecutionError(name, msg);
    },

    hideError() {
      hideExecutionState();
    },

    cancelExecution() {
      log('cmd:panel', 'Cancelling execution');
      hideExecutionState();
    },

    enterOutputSelection(payload) {
      const result = payload?.result;
      if (!result || !result.output) return;
      doEnterOutputSelectionMode(result.output.data, result.output.mimeType, payload.name);
      const input = commandInput();
      if (input) { input.value = ''; input.focus(); }
    },

    exitOutputSelection() {
      doExitOutputSelectionMode();
    },

    selectOutputItem() {
      doSelectOutputItem();
    },

    setOutputIndexFromClick(payload) {
      if (payload?.index !== undefined) {
        state.outputItemIndex = payload.index;
      }
    },

    enterChainMode(payload) {
      const result = payload?.result;
      if (!result || !result.output) return;
      machine.setState(States.CHAIN_MODE);
      doEnterChainMode(result.output, payload.name);
      const input = commandInput();
      if (input) { input.value = ''; input.focus(); }
    },

    exitChainMode() {
      doExitChainMode();
    },

    exitChainModeIfActive() {
      if (state.chainContext) {
        doExitChainMode();
      }
    },

    chainUndo() {
      doChainUndo();
    },

    publishEditorOpen(payload) {
      const result = payload?.result;
      if (!result || !result.output) return;
      const outputData = result.output.data;
      const outputMimeType = result.output.mimeType;

      if (outputMimeType === 'new-item') {
        api.publish('editor:add', { type: outputData.type || 'text' });
      } else if (outputData.id) {
        api.publish('editor:open', { itemId: outputData.id });
        if (result.output.isNew) {
          api.publish('editor:changed', { action: 'add', itemId: outputData.id });
        }
      }
    },

    updateChainFromPopup(payload) {
      if (state.chainContext) {
        state.chainContext.data = payload.data;
        state.chainContext.mimeType = payload.mimeType || state.chainContext.mimeType;
        if (state.chainStack.length > 0) {
          state.chainStack[state.chainStack.length - 1].data = payload.data;
        }
      }

      state.typed = '';
      state.showResults = true;

      updateChainUI();
      updateChainStepsUI();
    },

    closeChainPopup() {
      if (chainPopupWindowId) {
        api.window.close(chainPopupWindowId);
        chainPopupWindowId = null;
      }
      state.chainPopupActive = false;
    },

    refocusPanel() {
      api.window.getWindowId().then(id => {
        if (id) api.window.focus(id);
      });
      setTimeout(() => {
        const input = commandInput();
        if (input) input.focus();
      }, 100);
    },

    cycleMode() {
      cycleMode();
    },

    resetAllState() {
      machine.reset();

      hideExecutionState();
      doExitOutputSelectionMode();
      doExitChainMode();

      state.paramCommand = null;
      state.paramSuggestions = [];
      state.paramIndex = -1;

      invalidateCompleterCache();

      state.chainPopupActive = false;
      state.showResults = false;

      // Clear inline URL ghost suggestion
      clearUrlGhost();

      // Exit URL mode if active from previous invocation
      exitUrlMode();

      currentMode = 'default';
      currentModeMetadata = {};
      modeWasSet = false;

      loadCommandContext();
      adaptiveDataCache = null;
      loadAdaptiveData().then(d => {
        state.adaptiveFeedback = d.feedback;
        state.matchCounts = d.counts;
        log('cmd:panel', 'Reloaded adaptive data on panel show');
      });

      const input = commandInput();
      if (input) {
        input.value = '';
        input.focus();
      }

      updateCommandUI();
      updateResultsUI();

      // Check if URL mode was requested (Cmd+L)
      if (pendingUrlMode) {
        enterUrlMode();
      }
    },
  };
}

// ===== DOM Event Wiring =====

async function render() {
  const commandInput = document.getElementById('command-input');
  const commandText = document.getElementById('command-text');

  commandInput.value = '';
  commandInput.focus();

  // Mirror the input's horizontal scroll onto #command-text so the typed
  // end / caret stays visible when content exceeds the input width.
  // Native <input> fires scroll events on caret-driven scroll (typing,
  // arrow keys, click) — listening once here covers all cases regardless
  // of whether the keystroke also triggered an FSM-driven re-render.
  commandInput.addEventListener('scroll', syncCommandTextScroll);

  // Input event -> dispatch to state machine (or filter URL mode)
  commandInput.addEventListener('input', (e) => {
    const value = commandInput.value;
    const trimmedText = value.trim();
    // A deletion (Backspace/Delete/cut) — used to reject the selected ghost
    // suffix without re-arming it. inputType is absent on programmatic .value
    // sets (which don't fire this event anyway), so treat missing as non-delete.
    const isDeleting = typeof e.inputType === 'string' && e.inputType.startsWith('delete');

    // URL mode: filter URLs instead of dispatching normal command matching
    if (urlModeActive) {
      state.typed = value;
      state.matchIndex = 0;
      filterUrlModeItems(trimmedText);
      updateCommandUI_UrlMode(trimmedText);
      return;
    }

    // Pre-compute whether param mode should be entered
    // (the action handler will check, but the guard needs the signal)
    let enterParamMode = false;
    let paramCommandName = null;

    if (trimmedText) {
      // Compute matches first to check for param candidates
      const matches = findMatchingCommands(value);
      const typedLower = value.toLowerCase();

      for (const matchName of matches) {
        const matchLower = matchName.toLowerCase();
        if (typedLower.startsWith(matchLower + ' ')) {
          if (!paramCommandName || matchName.length > paramCommandName.length) {
            paramCommandName = matchName;
          }
        }
      }

      if (paramCommandName) {
        const cmd = state.commands[paramCommandName];
        if (cmd && cmd.params && cmd.params.length > 0) {
          enterParamMode = true;
        }
      }
    }

    // For param mode, check if input still matches the param command
    let paramStillMatches = false;
    if (machine.getState() === States.PARAM_MODE && state.paramCommand) {
      const lowerVal = value.toLowerCase();
      const lowerCmd = state.paramCommand.toLowerCase();
      paramStillMatches = lowerVal.startsWith(lowerCmd + ' ') || lowerVal.startsWith(lowerCmd);
    }

    machine.dispatch(Events.INPUT, {
      value,
      enterParamMode,
      paramCommandName,
      paramStillMatches,
      isDeleting,
    });
  });

  // Keydown event -> dispatch special keys through state machine
  commandInput.addEventListener('keydown', (e) => {
    // URL mode handles its own key events
    if (urlModeActive) {
      if (e.key === 'Escape' && !hasModifier(e)) {
        e.preventDefault();
        exitUrlMode();
        machine.dispatch(Events.ESCAPE);
        return;
      }
      if (e.key === 'Enter' && !hasModifier(e)) {
        e.preventDefault();
        const trimmedText = commandInput.value.trim();
        const urlResult = getValidURL(trimmedText);

        if (urlModeItems.length > 0 && state.matchIndex < urlModeItems.length) {
          // Open selected URL from results
          openUrlModeItem(state.matchIndex);
        } else if (urlResult.valid) {
          // Open typed URL directly
          log('cmd:panel', 'URL mode: opening typed URL', urlResult.url);
          api.window.open(urlResult.url, {
            role: 'content',
            width: 1024,
            height: 768,
            trackingSource: 'cmd',
            trackingSourceId: 'url-mode-typed'
          }).catch(error => {
            log.error('cmd:panel', 'Failed to open typed URL:', error);
          });
          updateMatchCount(urlResult.url);
          setTimeout(() => api.window.close(), 100);
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (urlModeItems.length > 0) {
          state.matchIndex = Math.min(state.matchIndex + 1, urlModeItems.length - 1);
          renderUrlResults(urlModeItems);
        }
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (urlModeItems.length > 0) {
          state.matchIndex = Math.max(state.matchIndex - 1, 0);
          renderUrlResults(urlModeItems);
        }
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        // Tab cycles forward through results in URL mode
        if (urlModeItems.length > 0) {
          state.matchIndex = (state.matchIndex + 1) % urlModeItems.length;
          renderUrlResults(urlModeItems);
        }
        return;
      }
      // Let other keys through to the input handler
      return;
    }

    if (e.key === 'Escape' && !hasModifier(e)) {
      // Primary escape handler — dispatch directly to the state machine.
      // The IZUI before-input-event handler may also fire (calling onEscape below),
      // but it calls e.preventDefault() which blocks this keydown in production.
      // In test (Playwright), before-input-event may not fire, so we handle here.
      e.preventDefault();
      machine.dispatch(Events.ESCAPE);
      return;
    }

    if (e.key === 'Enter' && !hasModifier(e)) {
      e.preventDefault();
      const trimmedText = commandInput.value.trim();
      const urlResult = getValidURL(trimmedText);
      const name = state.matches[state.matchIndex];
      const nameLower = name ? name.toLowerCase() : '';
      const typedLower = trimmedText.toLowerCase();

      let committed = name && (
        typedLower === nameLower ||
        typedLower.startsWith(nameLower + ' ') ||
        state.showResults ||
        machine.getState() === States.CHAIN_MODE
      );

      // Pref: Enter runs the inline-suggested command for a genuine PREFIX completion
      // (the ghost-completion case). NEVER for substring/fuzzy matches —
      // findMatchingCommands does substring matching, and auto-running a fuzzy match
      // would execute a command the user didn't intend (why this was disabled before).
      if (!committed && enterRunsInlineSuggestion && name && !typedLower.includes(' ')
          && typedLower.length > 0 && nameLower.startsWith(typedLower) && nameLower !== typedLower) {
        const suggestedCmd = state.commands[name];
        const suggestedHasParams = suggestedCmd && suggestedCmd.params && suggestedCmd.params.length > 0;
        if (suggestedHasParams) {
          // Param command: complete the name + enter param mode (like Tab), don't execute with empty params.
          e.preventDefault();
          machine.dispatch(Events.TAB, { commandName: name, hasParams: true });
          return;
        }
        committed = true; // no-param command → execute via the userCommittedToCommand guard
      }

      // All tokens are `#name` (no inner whitespace, no `#`-only): treat as
      // a tag-search shortcut. Routes to the `search` view filtered by tags.
      const tokens = trimmedText.split(/\s+/).filter(Boolean);
      const allHashtags = tokens.length > 0 && tokens.every(t => /^#[^\s#]+$/.test(t));

      // URL ghost: active when there's a ghost suggestion (the frecency-best
      // substring match) and there are no command matches. Substring-everywhere:
      // Enter opens that match even when the typed text is mid-string and not a
      // prefix — the auto-open Visited dropdown surfaces alternatives so the user
      // can arrow/click to correct. (Inline append only renders for the prefix
      // case; this guard is independent of that.)
      // A typed VALID URL (e.g. "example.com") opens via the isURL path below,
      // not the history ghost — otherwise a substring history match would hijack
      // a literal address the user explicitly typed.
      // neverOpenUnshown: only when a completion was actually SHOWN inline
      // (currentGhostCompletion non-null) may Enter open it — a substring match
      // that never rendered must NOT be silently opened.
      const hasUrlGhost = state.matches.length === 0 &&
        !urlResult.valid &&
        currentGhostCompletion(state.typed) !== null;

      machine.dispatch(Events.ENTER, {
        value: commandInput.value,
        isURL: urlResult.valid,
        url: urlResult.url,
        allHashtags,
        committed,
        commandName: name,
        typed: commandInput.value,
        hasUrlGhost,
      });
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      machine.dispatch(Events.ARROW_DOWN);
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      machine.dispatch(Events.ARROW_UP);
      return;
    }

    if (e.key === 'ArrowRight') {
      // Accept URL ghost when caret is at end of input and ghost is present
      if (commandInput.selectionStart === commandInput.value.length && urlGhostAcceptable()) {
        e.preventDefault();
        machine.dispatch(Events.ACCEPT_GHOST, { urlGhostAcceptable: true });
        return;
      }
      if (machine.getState() === States.OUTPUT_SELECTION) {
        e.preventDefault();
        machine.dispatch(Events.ARROW_RIGHT);
      }
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) {
        machine.dispatch(Events.SHIFT_TAB);
      } else {
        // Accept URL ghost with Tab when no command matches
        if (urlGhostAcceptable()) {
          machine.dispatch(Events.ACCEPT_GHOST, { urlGhostAcceptable: true });
          return;
        }
        // For Tab, check if the selected command has params
        const name = state.matches[state.matchIndex];
        const cmd = name && state.commands[name];
        const hasParams = cmd && cmd.params && cmd.params.length > 0;
        machine.dispatch(Events.TAB, { commandName: name, hasParams });
      }
      return;
    }
  });

  // Keep focus on input (unless chain popup is active)
  window.addEventListener('blur', () => {
    if (!state.chainPopupActive) {
      setTimeout(() => commandInput.focus(), 10);
    }
  });

  window.addEventListener('focus', () => {
    commandInput.focus();
  });

  // Reset state when the panel is re-shown via keepLive reuse.
  //
  // `api.onVisible` fires from a private `tile:lifecycle:visible` IPC
  // that main sends from api.window.open's reuse path (ipc.ts:~949).
  // The IPC is queued before the open call resolves, so by the time any
  // subsequent user input reaches the renderer, this handler has already
  // dispatched VISIBILITY_SHOWN and the FSM is in IDLE.
  //
  // Previously this was wired to the DOM `visibilitychange` event, which
  // races with input arrival — keystrokes could land on a CLOSING state
  // and be silently absorbed. The FSM's per-state VISIBILITY_SHOWN
  // handlers (state-machine.js) make the reset a first-class transition
  // from any state, not a setState() backdoor.
  if (typeof api.onVisible === 'function') {
    api.onVisible(() => {
      machine.dispatch(Events.VISIBILITY_SHOWN);
    });
  }

  // Initial focus
  setTimeout(() => commandInput.focus(), 50);

  // Load command context on initial render
  await loadCommandContext();

  // Initialize mode indicator
  initModeIndicator();

  // Chain cancel button handler — dispatch through state machine
  const chainCancelBtn = document.getElementById('chain-cancel');
  if (chainCancelBtn) {
    chainCancelBtn.addEventListener('click', () => {
      machine.dispatch(Events.CLICK_CHAIN_CANCEL);
    });
  }

  // Execution cancel button handler — dispatch through state machine
  const execCancelBtn = document.querySelector('#execution-state .exec-cancel');
  if (execCancelBtn) {
    execCancelBtn.addEventListener('click', () => {
      machine.dispatch(Events.CLICK_CANCEL);
    });
  }
}

render();

// Register IZUI escape handler — single escape through dispatch (bug fix #1)
api.escape.onEscape(() => {
  if (urlModeActive) {
    exitUrlMode();
  }
  return machine.handleEscape();
});

// Module-end sentinel. If any top-level statement above throws (e.g. an api.*
// surface was renamed or removed), module evaluation halts and this flag is
// never set. A regression test asserts this flips within a short timeout.
// See tests/desktop/module-health.spec.ts + feedback_top_level_await_silent_halt.md.
window.__cmdPanelModuleReady = true;
