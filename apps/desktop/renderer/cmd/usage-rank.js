/**
 * Ranks a command's parameter suggestions by how often and recently each option was picked.
 *
 * Usage is a map { [commandName]: { [optionValue]: anchor } }. Each pick adds PICK_SCORE and the
 * score halves every HALF_LIFE_MS. The stored number is an anchor timestamp, not a score:
 *
 *   score at time t = 2^((anchor - t) / HALF_LIFE_MS)
 *
 * so the score decays by itself and nothing is rewritten as time passes. A pick recomputes the
 * current score, adds PICK_SCORE, and converts the total back to an anchor.
 */

export const PICK_SCORE = 100;
export const HALF_LIFE_MS = 10 * 24 * 60 * 60 * 1000;

/** Score of an anchor at `now`; 0 for an option never picked. */
export function scoreAt(anchor, now) {
  if (typeof anchor !== 'number') return 0;
  return Math.pow(2, (anchor - now) / HALF_LIFE_MS);
}

/** The anchor after one more pick at `now`. */
export function anchorAfterPick(anchor, now) {
  const score = scoreAt(anchor, now) + PICK_SCORE;
  return now + HALF_LIFE_MS * Math.log2(score);
}

/** A copy of `usage` with one more pick of `value` for `command`. */
export function recordPick(usage, command, value, now) {
  const key = String(value).toLowerCase();
  const forCommand = (usage && usage[command]) || {};
  return {
    ...usage,
    [command]: { ...forCommand, [key]: anchorAfterPick(forCommand[key], now) },
  };
}

/** `usage` with a pick of the suggestion at `index` (by its value); unchanged when there is none. */
export function recordSuggestionPick(usage, command, suggestions, index, now) {
  const suggestion = suggestions[index];
  return suggestion ? recordPick(usage, command, suggestion.value, now) : usage;
}

/**
 * The suggestion that the typed parameter text names: one whose value equals it, else one whose
 * title does (an item param types the title but its value is the item id), case-insensitively.
 * Null when nothing matches.
 */
export function pickedSuggestion(suggestions, typedParam) {
  const rest = String(typedParam == null ? '' : typedParam).trim().toLowerCase();
  if (!rest) return null;
  const same = (text) => String(text == null ? '' : text).toLowerCase() === rest;
  return suggestions.find(s => same(s.value)) || suggestions.find(s => same(s.title)) || null;
}

function withoutPrefix(text, prefix) {
  const lower = String(text == null ? '' : text).toLowerCase();
  const lowerPrefix = (prefix || '').toLowerCase();
  return lowerPrefix && lower.startsWith(lowerPrefix) ? lower.slice(lowerPrefix.length) : lower;
}

/**
 * Suggestions with an exact match of the typed text first, then usage by score descending;
 * unused ones follow in the order given. Exact means the value or title equals the typed text,
 * case-insensitively and ignoring the param prefix. Returns a new array.
 */
export function rankByUsage(suggestions, usage, command, now, typed, prefix) {
  const forCommand = usage && usage[command];
  const query = withoutPrefix(typed, prefix);
  if (!forCommand && !query) return suggestions.slice();
  const scored = suggestions.map((suggestion, index) => ({
    suggestion,
    index,
    exact: query !== '' && (withoutPrefix(suggestion.value, prefix) === query ||
      withoutPrefix(suggestion.title, prefix) === query),
    score: forCommand ? scoreAt(forCommand[String(suggestion.value).toLowerCase()], now) : 0,
  }));
  scored.sort((a, b) => (b.exact - a.exact) || (b.score - a.score) || (a.index - b.index));
  return scored.map(s => s.suggestion);
}
