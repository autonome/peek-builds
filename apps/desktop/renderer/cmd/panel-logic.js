/**
 * Pure computations behind the cmd panel.
 *
 * `panel.js` touches the DOM, `window.app` and the panel state machine at module
 * load, so nothing in it can be imported under node. These helpers are the parts
 * that need no DOM, no Electron and no panel state: every piece of panel state
 * they read arrives as an argument, and the caller in `panel.js` passes it.
 * That keeps them exercisable by `tests/unit/cmd-chain.test.js` and
 * `tests/unit/cmd-logic.test.js` against the shipping code rather than a copy.
 *
 * No imports: this module must stay loadable on its own.
 */

// ===== Chain Mode =====

/**
 * Does a MIME pattern from a command's `accepts` list match an actual MIME type?
 * A pattern of two wildcards matches anything; a wildcard subtype matches any
 * subtype of the same type.
 */
export function mimeTypeMatches(pattern, actual) {
  if (!pattern || !actual) return false;
  if (pattern === '*/*' || pattern === actual) return true;
  const [pType, pSub] = pattern.split('/');
  const [aType] = actual.split('/');
  return pSub === '*' && pType === aType;
}

/**
 * The commands that can take `mimeType` as chained input.
 *
 * @param {Object} commands registry keyed by command name
 * @param {string} mimeType MIME type produced by the previous chain step
 */
export function findChainingCommands(commands, mimeType) {
  return Object.values(commands).filter(cmd => {
    if (!cmd.accepts?.length) return false;
    return cmd.accepts.some(acceptedType => mimeTypeMatches(acceptedType, mimeType));
  });
}

// ===== Execution Context Builder =====

/**
 * The context object a command's `execute` receives.
 *
 * `name` is the matched command name and `typed` the raw panel text; the
 * parameters are whatever follows the name, tolerating a partially-typed name.
 * `inputValue` is the live input field's value (the panel reads the DOM for it)
 * and `chainContext` is the current chain step, or null when not chaining.
 */
export function buildExecutionContext(name, typed, inputValue, chainContext) {
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

  const context = { typed, name, params, search, value: inputValue };

  if (chainContext) {
    context.input = chainContext.data;
    context.inputMimeType = chainContext.mimeType;
    context.inputTitle = chainContext.title;
    context.inputSource = chainContext.sourceCommand;
  }

  return context;
}

// ===== Tab Cycling =====

/**
 * The match Tab should land on next.
 *
 * The first Tab only completes the highlighted match, so the index holds; once
 * the input already reads as that match (alone, or followed by parameters) a
 * further Tab steps through the rest, wrapping at either end. `shiftKey` steps
 * backwards. A single match, or none, never moves.
 *
 * @param {{matches: string[], matchIndex: number, inputValue: string, shiftKey: boolean}} params
 * @returns {number} the new index
 */
export function getTabCycleIndex({ matches, matchIndex, inputValue, shiftKey }) {
  if (matches.length === 0) return matchIndex;

  const currentMatch = matches[matchIndex];
  const currentValue = inputValue.trim();

  const alreadyCompleted = currentValue === currentMatch ||
                            currentValue.startsWith(currentMatch + ' ');

  if (alreadyCompleted && matches.length > 1) {
    return shiftKey
      ? (matchIndex - 1 + matches.length) % matches.length
      : (matchIndex + 1) % matches.length;
  }

  return matchIndex;
}

// ===== Adaptive Feedback =====

/**
 * Record that `typed` led to picking `name`, mutating `feedback` in place.
 *
 * Existing counts for that exact text decay first, so the ranking follows a
 * change in habit instead of being pinned by history. Sub-prefixes of each word
 * of the command name get a smaller share, skipping the word the typed text is
 * already a prefix of (or vice versa) — that one needs no boost.
 *
 * @param {Object} feedback typed-text -> command name -> weight
 */
export function updateAdaptiveFeedback(feedback, typed, name) {
  // Apply decay to existing entries for this typed prefix (adapts to changing behavior)
  const DECAY = 0.95;
  const PRUNE_THRESHOLD = 0.1;
  if (feedback[typed]) {
    for (const key of Object.keys(feedback[typed])) {
      feedback[typed][key] *= DECAY;
      if (feedback[typed][key] < PRUNE_THRESHOLD) {
        delete feedback[typed][key];
      }
    }
  }

  if (!feedback[typed]) {
    feedback[typed] = {};
  }
  if (!feedback[typed][name]) {
    feedback[typed][name] = 0;
  }
  feedback[typed][name]++;

  const lowerName = name.toLowerCase();
  const lowerTyped = typed.toLowerCase();
  const words = lowerName.split(/[\s-]+/);

  for (const word of words) {
    if (lowerTyped.startsWith(word) || word.startsWith(lowerTyped)) continue;
    for (let len = 2; len <= word.length; len++) {
      const sub = word.substring(0, len);
      // Decay sub-prefix entries too
      if (feedback[sub]) {
        for (const key of Object.keys(feedback[sub])) {
          feedback[sub][key] *= DECAY;
          if (feedback[sub][key] < PRUNE_THRESHOLD) {
            delete feedback[sub][key];
          }
        }
      }
      if (!feedback[sub]) feedback[sub] = {};
      if (!feedback[sub][name]) feedback[sub][name] = 0;
      feedback[sub][name] += 0.25;
    }
  }
}

/** How strongly `typed` has led to `name` before, saturating towards 1. */
export function getAdaptiveScore(feedback, typed, name) {
  const k = 3;
  const entry = feedback[typed];
  if (!entry || !entry[name]) return 0;
  return entry[name] / (entry[name] + k);
}

/** How often `name` has been picked at all, saturating towards 1. */
export function getFrecencyScore(matchCounts, name) {
  const k = 10;
  const count = matchCounts[name] || 0;
  if (count === 0) return 0;
  return count / (count + k);
}
