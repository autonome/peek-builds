import { describeGroups, groupsFromEdges, normalizeEdges, scoreGroups } from '../graph.js';
import { edges as entityEdges } from './entity-groups.js';
import { edges as sessionEdges } from './session-groups.js';
import { edges as textEdges } from './text-similarity.js';

export const name = 'combined-groups';
// Each source is scaled to [0,1] first, so a link needs about half of one source's strongest link.
export const MIN_LINK_WEIGHT = 0.5;

export function run(tables, options = {}) {
  const sources = [normalizeEdges(entityEdges(tables, options).edges), normalizeEdges(textEdges(tables, options))];
  if (tables.sessions.length) sources.push(normalizeEdges(sessionEdges(tables, options).edges));
  const sum = new Map();
  for (const src of sources) for (const [k, w] of src) sum.set(k, (sum.get(k) ?? 0) + w);
  const groups = groupsFromEdges(sum, options.combinedMinLinkWeight ?? MIN_LINK_WEIGHT);
  const score = scoreGroups(groups, tables.pages);
  return {
    name,
    summary: { ...score, sources: sources.length },
    rows: describeGroups(groups, tables.pages),
    score,
  };
}
