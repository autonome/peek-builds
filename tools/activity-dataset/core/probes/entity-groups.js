import { addEdge, describeGroups, groupsFromEdges, scoreGroups } from '../graph.js';

export const name = 'entity-groups';
export const HUB_FRACTION = 0.05;
export const MIN_LINK_WEIGHT = 2.0;

// Pages joined by shared entities, each entity weighted by inverse page frequency; hub entities dropped.
export function edges(tables, options = {}) {
  const hubFraction = options.hubFraction ?? HUB_FRACTION;
  const nPages = tables.pages.length;
  const pagesOf = new Map();
  for (const s of tables.sightings) {
    if (!s.pageId) continue;
    if (!pagesOf.has(s.entityId)) pagesOf.set(s.entityId, new Set());
    pagesOf.get(s.entityId).add(s.pageId);
  }
  const out = new Map();
  let hubsDropped = 0;
  for (const set of pagesOf.values()) {
    if (set.size > hubFraction * nPages) {
      hubsDropped++;
      continue;
    }
    const weight = Math.log(nPages / set.size);
    const ids = [...set];
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) addEdge(out, ids[i], ids[j], weight);
  }
  return { edges: out, hubsDropped };
}

export function run(tables, options = {}) {
  const { edges: e, hubsDropped } = edges(tables, options);
  const groups = groupsFromEdges(e, options.minLinkWeight ?? MIN_LINK_WEIGHT);
  const score = scoreGroups(groups, tables.pages);
  return {
    name,
    summary: { ...score, hubsDropped },
    rows: describeGroups(groups, tables.pages),
    score,
  };
}
