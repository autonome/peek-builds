import { addEdge, describeGroups, groupsFromEdges, scoreGroups } from '../graph.js';

export const name = 'session-groups';
export const MIN_LINK_WEIGHT = 2.0;
export const MAX_SESSION_PAGES = 100;

// Pages seen in the same session, each co-occurrence weighted by log(1 + durationMs/1000).
export function edges(tables, options = {}) {
  const maxPages = options.maxSessionPages ?? MAX_SESSION_PAGES;
  const out = new Map();
  let oversized = 0;
  for (const s of tables.sessions) {
    if (s.pageIds.length > maxPages) {
      oversized++;
      continue;
    }
    const weight = Math.log(1 + s.totalDurationMs / 1000);
    for (let i = 0; i < s.pageIds.length; i++) {
      for (let j = i + 1; j < s.pageIds.length; j++) addEdge(out, s.pageIds[i], s.pageIds[j], weight);
    }
  }
  return { edges: out, oversized };
}

export function run(tables, options = {}) {
  if (!tables.sessions.length) return { name, summary: { skipped: 'no visits' }, rows: [] };
  const { edges: e, oversized } = edges(tables, options);
  const groups = groupsFromEdges(e, options.minLinkWeight ?? MIN_LINK_WEIGHT);
  const score = scoreGroups(groups, tables.pages);
  return {
    name,
    summary: { ...score, sessions: tables.sessions.length, oversizedSessionsSkipped: oversized },
    rows: describeGroups(groups, tables.pages),
    score,
  };
}
