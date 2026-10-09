/**
 * Top-level rows that pair a command with one of its enum options, so typing an object's name
 * ("work") offers "open space work", "move to space work" before any command is chosen.
 *
 * Only single-value enum parameters without a prefix take part. Pair usage is the per-command
 * parameter usage from usage-rank.js, so a pick here and a pick in parameter mode count the same.
 */

import { matchTier, NO_MATCH, TIER_EXACT } from './enum-match.js';
import { scoreAt } from './usage-rank.js';

/** Typed text shorter than this (after trimming) offers no pair rows. */
export const MIN_PAIR_QUERY = 2;

function enumOptions(paramDef) {
  if (!paramDef || paramDef.type !== 'enum' || paramDef.multiple || paramDef.prefix) return [];
  const options = paramDef.options && paramDef.options.length > 0 ? paramDef.options : (paramDef.values || []);
  return options.map(opt => (typeof opt === 'string'
    ? { value: opt, title: opt }
    : { value: opt.value, title: opt.title || opt.value }));
}

/**
 * Pair rows for the typed text, best first: pair usage, then match tier, then option order,
 * then command order.
 *
 * @param {string} typed - Text typed at the top level
 * @param {Array<{name: string, params?: Array}>} commands - Commands available right now
 * @param {Object} usage - Per-command option usage (usage-rank.js)
 * @param {number} now - Current time in ms
 * @returns {Array<{name: string, command: string, value: string, exact: boolean}>}
 */
export function pairRowsFor(typed, commands, usage, now) {
  const query = String(typed || '').trim();
  if (query.length < MIN_PAIR_QUERY) return [];
  const found = [];
  commands.forEach((cmd, commandIndex) => {
    const options = enumOptions(cmd && cmd.params && cmd.params[0]);
    options.forEach((opt, optionIndex) => {
      if (opt.value == null) return;
      const tier = matchTier(query, String(opt.value), opt.title);
      if (tier === NO_MATCH) return;
      const forCommand = usage && usage[cmd.name];
      found.push({
        name: `${cmd.name} ${opt.title}`,
        command: cmd.name,
        value: String(opt.value),
        exact: tier === TIER_EXACT,
        tier,
        score: forCommand ? scoreAt(forCommand[String(opt.value).toLowerCase()], now) : 0,
        optionIndex,
        commandIndex,
      });
    });
  });
  found.sort((a, b) => (b.score - a.score) || (a.tier - b.tier) ||
    (a.optionIndex - b.optionIndex) || (a.commandIndex - b.commandIndex));
  return found.map(({ name, command, value, exact }) => ({ name, command, value, exact }));
}

/**
 * The top-level row names: pair rows whose option name equals the typed text first, then the
 * command matches in their own order, then the remaining pair rows. A pair row whose text is
 * already a command match is dropped.
 *
 * @param {string[]} commandMatches - Ranked command names
 * @param {Array<{name: string, exact: boolean}>} pairs - From pairRowsFor, in its order
 * @returns {string[]}
 */
export function withPairRows(commandMatches, pairs) {
  const taken = new Set(commandMatches);
  const fresh = pairs.filter(p => !taken.has(p.name));
  return [
    ...fresh.filter(p => p.exact).map(p => p.name),
    ...commandMatches,
    ...fresh.filter(p => !p.exact).map(p => p.name),
  ];
}
