/**
 * Cmd Panel - command input and execution UI
 *
 * Runs in isolated panel window (peek://ext/cmd/panel.html)
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

log('cmd:panel', 'loaded');

const api = window.app;

// Storage keys for persistent adaptive matching
const STORAGE_KEY_FEEDBACK = 'adaptiveFeedback';
const STORAGE_KEY_COUNTS = 'matchCounts';
const STORAGE_KEY_VERSION = 'adaptiveVersion';
// Version 2: removed prefix feedback that caused cross-contamination
const ADAPTIVE_VERSION = 2;

// Cache for adaptive data
let adaptiveDataCache = null;

/**
 * Load persisted adaptive data from extension settings
 */
const loadAdaptiveData = async () => {
  if (adaptiveDataCache) {
    return adaptiveDataCache;
  }

  const result = await api.settings.get();
  if (result.success && result.data) {
    const storedVersion = result.data[STORAGE_KEY_VERSION] || 0;

    if (storedVersion < ADAPTIVE_VERSION) {
      log('cmd:panel', 'loadAdaptiveData: resetting stale feedback data (version', storedVersion, '->', ADAPTIVE_VERSION + ')');
      adaptiveDataCache = {
        feedback: {},
        counts: result.data[STORAGE_KEY_COUNTS] || {}
      };
      await Promise.all([
        api.settings.setKey(STORAGE_KEY_FEEDBACK, {}),
        api.settings.setKey(STORAGE_KEY_VERSION, ADAPTIVE_VERSION)
      ]);
    } else {
      adaptiveDataCache = {
        feedback: result.data[STORAGE_KEY_FEEDBACK] || {},
        counts: result.data[STORAGE_KEY_COUNTS] || {}
      };
    }
  } else {
    adaptiveDataCache = { feedback: {}, counts: {} };
    await api.settings.setKey(STORAGE_KEY_VERSION, ADAPTIVE_VERSION);
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
    api.settings.setKey(STORAGE_KEY_FEEDBACK, feedback),
    api.settings.setKey(STORAGE_KEY_COUNTS, counts)
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

// Listen for URL mode activation (from Cmd+L shortcut in background.js)
api.subscribe('cmd:url-mode', () => {
  log('cmd:panel', 'URL mode requested');
  pendingUrlMode = true;
  // If panel is already visible (no upcoming visibilitychange), enter immediately
  if (!document.hidden && !urlModeActive) {
    enterUrlMode();
  }
}, api.scopes.GLOBAL);

// Chain popup state (module-level for cleanup)
let chainPopupWindowId = null;

// URL search state — async URL results mixed into normal cmd results
let urlSearchGeneration = 0;
let urlSearchResults = [];  // [{title, domain, content (url), favicon, ...}]
let urlSearchTimer = null;
const URL_SEARCH_DEBOUNCE_MS = 150;

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
    const isTransient = await api.window.isTransient();
    if (isTransient) {
      log('cmd:panel', 'Transient invocation - using default mode');
      currentMode = 'default';
      currentModeMetadata = {};
      modeWasSet = true;
      updateModeIndicator();
      const result = await api.modes.getCommandContext();
      if (result.success) {
        commandContext = result.data;
      }
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

    const result = await api.modes.getCommandContext();
    if (result.success) {
      commandContext = result.data;
      log('cmd:panel', 'Loaded command context:', commandContext);
      if (!modeWasSet && commandContext?.mode?.major) {
        currentMode = commandContext.mode.major;
        modeWasSet = true;
        updateModeIndicator();
      }
    }
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

  if (api.context) {
    const targetWindowId = await api.window.getFocusedVisibleWindowId();
    const result = await api.context.setMode(nextMode, { windowId: targetWindowId });
    if (result.success) {
      currentMode = nextMode;
      currentModeMetadata = {};
      updateModeIndicator();
      await loadCommandContext();
      return;
    }
  }

  const result = await api.modes.setMajorMode(nextMode);
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
      currentMode = mode || 'default';
      currentModeMetadata = entry?.metadata || {};
      updateModeIndicator();
    });
  }

  api.modes.onModeChange((modeState, windowId) => {
    log('cmd:panel', 'Mode changed (modes API):', modeState, 'for window:', windowId);
    if (!currentMode || currentMode === 'default') {
      currentMode = modeState.major || 'default';
      updateModeIndicator();
    }
  });

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
  'text/': 'peek://ext/cmd/chain-editor.html',
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
  }, api.scopes.GLOBAL);

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
  }, api.scopes.GLOBAL);
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
    api.publish('editor:open', { itemId: selectedItem.id }, api.scopes.GLOBAL);
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

function findMatchingUrlCommand(url) {
  if (!url) return null;
  const lowerUrl = url.toLowerCase();

  if (state.commands[url]) return url;

  let bestMatch = null;
  let bestLength = Infinity;

  for (const name of Object.keys(state.commands)) {
    const lowerName = name.toLowerCase();
    if (lowerName.startsWith(lowerUrl) || lowerUrl.startsWith(lowerName)) {
      if (name.length < bestLength) {
        bestMatch = name;
        bestLength = name.length;
      }
    }
  }

  return bestMatch;
}

// ===== Async URL Search for Normal Cmd Mode =====

/**
 * Trigger async URL search to mix visited URLs into normal cmd results.
 * Debounced to avoid DB thrashing on every keystroke.
 * Results are appended below command matches in updateResultsUI.
 */
function triggerUrlSearch(text) {
  if (urlSearchTimer) {
    clearTimeout(urlSearchTimer);
    urlSearchTimer = null;
  }

  if (!text || text.length < 2) {
    urlSearchResults = [];
    urlSearchGeneration++;
    return;
  }

  const generation = ++urlSearchGeneration;

  urlSearchTimer = setTimeout(async () => {
    try {
      const query = { type: 'url', sortBy: 'frecency', limit: 5 };
      query.search = text;
      const result = await api.datastore.queryItems(query);
      if (generation !== urlSearchGeneration) return; // stale
      urlSearchResults = (result.success && result.data) ? result.data : [];
      // Re-render results to include URL items
      updateResultsUI();
      updateWindowSize();
    } catch (e) {
      log.error('cmd:panel', 'URL search failed:', e);
    }
  }, URL_SEARCH_DEBOUNCE_MS);
}

/**
 * Open a URL from the inline URL search results.
 */
function openUrlSearchResult(index) {
  const item = urlSearchResults[index];
  if (!item) return;

  const url = item.content;
  if (!url) return;

  log('cmd:panel', 'Opening URL search result:', url);

  api.window.open(url, {
    role: 'content',
    width: 1024,
    height: 768,
    trackingSource: 'cmd',
    trackingSourceId: 'url-search'
  }).catch(error => {
    log.error('cmd:panel', 'Failed to open URL search result:', error);
  });

  updateMatchCount(url);
  setTimeout(shutdown, 100);
}

// ===== URL Mode Functions =====

/**
 * Query frecency-sorted URL items from the datastore.
 * Optionally filter by search text (matches title, domain, content).
 */
async function queryUrlsByFrecency(search = '', limit = 20) {
  const query = { type: 'url', sortBy: 'frecency', limit };
  if (search) query.search = search;

  const result = await api.datastore.queryItems(query);
  if (!result.success) return [];
  return result.data || [];
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
  setTimeout(() => window.close(), 100);
}

/**
 * Update the ghost text overlay in URL mode.
 * Shows the selected URL's title as ghost completion.
 */
function updateCommandUI_UrlMode(trimmedText) {
  const commandText = document.getElementById('command-text');
  commandText.innerHTML = '';

  if (!trimmedText) return;

  const typedSpan = document.createElement('span');
  typedSpan.className = 'typed';
  typedSpan.textContent = trimmedText;
  commandText.appendChild(typedSpan);
}

function hasModifier(e) {
  return e.altKey || e.ctrlKey || e.metaKey;
}

// ===== UI Update Functions =====

function updateCommandUI() {
  const commandText = document.getElementById('command-text');
  commandText.innerHTML = '';

  if (!state.typed) return;

  if (state.matches.length === 0) {
    const typedSpan = document.createElement('span');
    typedSpan.className = 'typed';
    typedSpan.textContent = state.typed;
    commandText.appendChild(typedSpan);
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
  const hasUrlResults = urlSearchResults.length > 0 && !isChainState && !urlModeActive;
  if ((state.matches.length === 0 && !hasUrlResults) || (!state.showResults && !isChainState && !hasUrlResults)) {
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

  // Append visited URL results below command matches
  if (hasUrlResults) {
    // Separator label
    const separator = document.createElement('div');
    separator.className = 'url-results-separator';
    separator.textContent = 'Visited Pages';
    resultsContainer.appendChild(separator);

    urlSearchResults.forEach((urlItem, urlIndex) => {
      const el = document.createElement('div');
      el.className = 'command-item url-result-item';

      // Favicon
      const faviconUrl = urlItem.favicon || '';
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
      let title = urlItem.title || '';
      if (!title && urlItem.metadata) {
        try {
          const meta = typeof urlItem.metadata === 'string' ? JSON.parse(urlItem.metadata) : urlItem.metadata;
          title = meta.title || '';
        } catch (e) {}
      }
      titleSpan.textContent = title || urlItem.content || 'Untitled';
      el.appendChild(titleSpan);

      // Domain / URL subtitle
      const urlSpan = document.createElement('span');
      urlSpan.className = 'cmd-desc url-subtitle';
      urlSpan.textContent = urlItem.domain || urlItem.content || '';
      el.appendChild(urlSpan);

      el.addEventListener('click', () => {
        openUrlSearchResult(urlIndex);
      });

      resultsContainer.appendChild(el);
    });
  }

  updateWindowSize();
}

// ===== Shutdown =====

async function shutdown() {
  window.close();
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

    clearInput() {
      const input = commandInput();
      if (input) {
        input.value = '';
      }
      state.typed = '';
      state.originalTyped = '';
      state.matches = [];
      state.matchIndex = 0;
      urlSearchResults = [];
      urlSearchGeneration++;
    },

    clearMatches() {
      state.matches = [];
      state.matchIndex = 0;
      urlSearchResults = [];
      urlSearchGeneration++;
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
        } else {
          state.matches = findMatchingCommands(typed);
          // Also search visited URLs asynchronously (results appear below commands)
          triggerUrlSearch(typed.trim());
        }
        state.matchIndex = 0;
      } else {
        state.matches = [];
        state.matchIndex = 0;
        urlSearchResults = [];
        urlSearchGeneration++;
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

      const matchingUrlCommand = findMatchingUrlCommand(urlResult.url);
      const frecencyTarget = matchingUrlCommand || urlResult.url;
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
      api.window.open(`peek://ext/search/home.html?q=${encodeURIComponent(trimmedText)}`, {
        role: 'workspace',
        key: 'search-home',
        width: 700,
        height: 768,
        trackingSource: 'cmd',
        trackingSourceId: 'search'
      }).catch(error => {
        log.error('cmd:panel', 'Failed to open search:', error);
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
        api.publish('editor:add', { type: outputData.type || 'text' }, api.scopes.GLOBAL);
      } else if (outputData.id) {
        api.publish('editor:open', { itemId: outputData.id }, api.scopes.GLOBAL);
        if (result.output.isNew) {
          api.publish('editor:changed', { action: 'add', itemId: outputData.id }, api.scopes.GLOBAL);
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

      // Clear inline URL search results
      urlSearchResults = [];
      urlSearchGeneration++;
      if (urlSearchTimer) {
        clearTimeout(urlSearchTimer);
        urlSearchTimer = null;
      }

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

  // Input event -> dispatch to state machine (or filter URL mode)
  commandInput.addEventListener('input', () => {
    const value = commandInput.value;
    const trimmedText = value.trim();

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
          setTimeout(() => window.close(), 100);
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

      const committed = name && (
        typedLower === nameLower ||
        typedLower.startsWith(nameLower + ' ') ||
        state.showResults ||
        machine.getState() === States.CHAIN_MODE
      );

      machine.dispatch(Events.ENTER, {
        value: commandInput.value,
        isURL: urlResult.valid,
        url: urlResult.url,
        committed,
        commandName: name,
        typed: commandInput.value,
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

  // Handle visibility changes — single handler for panel show/hide
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      // Panel is now visible — dispatch visibility:shown
      // If we're in CLOSING state, this resets everything
      if (machine.getState() === States.CLOSING) {
        machine.dispatch(Events.VISIBILITY_SHOWN);
      } else {
        // Force reset on re-show regardless (keepLive reuse)
        machine.setState(States.CLOSING);
        machine.dispatch(Events.VISIBILITY_SHOWN);
      }
    }
  });

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
