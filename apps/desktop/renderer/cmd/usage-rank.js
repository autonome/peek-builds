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

/**
 * Suggestions with usage first, by score descending; unused ones follow in the order given.
 * Returns a new array.
 */
export function rankByUsage(suggestions, usage, command, now) {
  const forCommand = usage && usage[command];
  if (!forCommand) return suggestions.slice();
  const scored = suggestions.map((suggestion, index) => ({
    suggestion,
    index,
    score: scoreAt(forCommand[String(suggestion.value).toLowerCase()], now),
  }));
  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  return scored.map(s => s.suggestion);
}
