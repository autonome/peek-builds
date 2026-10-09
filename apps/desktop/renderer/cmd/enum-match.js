/**
 * Enum match tiers - how well typed text matches an option's name.
 *
 * Lower is better: exact, prefix of the name, prefix of a later word, substring anywhere.
 * Word boundaries are space, -, _, / and camelCase humps.
 */

export const TIER_EXACT = 0;
export const TIER_PREFIX = 1;
export const TIER_WORD = 2;
export const TIER_SUBSTRING = 3;
export const NO_MATCH = -1;

const SEPARATORS = ' -_/';

function isWordStart(name, i) {
  const prev = name[i - 1];
  if (SEPARATORS.includes(prev)) return true;
  const cur = name[i];
  return prev !== prev.toUpperCase() && cur !== cur.toLowerCase();
}

function nameTier(query, name) {
  const lowerName = name.toLowerCase();
  if (lowerName === query) return TIER_EXACT;
  if (lowerName.startsWith(query)) return TIER_PREFIX;
  let tier = NO_MATCH;
  for (let i = lowerName.indexOf(query, 1); i !== -1; i = lowerName.indexOf(query, i + 1)) {
    if (isWordStart(name, i)) return TIER_WORD;
    tier = TIER_SUBSTRING;
  }
  return tier;
}

/**
 * Best tier of the typed text across the given names (value, title, ...).
 * @param {string} query - Typed text, any case
 * @param {...(string|undefined)} names - Candidate names; missing ones are skipped
 * @returns {number} TIER_* constant, or NO_MATCH
 */
export function matchTier(query, ...names) {
  const q = (query || '').toLowerCase();
  let best = NO_MATCH;
  for (const name of names) {
    if (typeof name !== 'string') continue;
    const tier = q ? nameTier(q, name) : TIER_EXACT;
    if (tier === NO_MATCH) continue;
    if (best === NO_MATCH || tier < best) best = tier;
  }
  return best;
}
