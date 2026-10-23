export const name = 'bursts';
export const WINDOW_MS = 30 * 86400000;
export const MIN_PAGES = 3;

// Entities seen on 3+ distinct pages in the last 30 days of data. "Now" is the latest sighting, not the wall clock.
export function run(tables) {
  const times = tables.sightings.map((s) => s.occurredAt).filter((t) => typeof t === 'number');
  if (!times.length) return { name, summary: { now: null, entities: 0 }, rows: [] };
  const now = Math.max(...times);
  const pagesOf = new Map();
  for (const s of tables.sightings) {
    if (!s.pageId || typeof s.occurredAt !== 'number' || s.occurredAt < now - WINDOW_MS) continue;
    if (!pagesOf.has(s.entityId)) pagesOf.set(s.entityId, new Set());
    pagesOf.get(s.entityId).add(s.pageId);
  }
  const entityById = new Map(tables.entities.map((e) => [e.id, e]));
  const rows = [...pagesOf]
    .filter(([, set]) => set.size >= MIN_PAGES)
    .map(([id, set]) => ({ entityId: id, name: entityById.get(id).name, type: entityById.get(id).type, pages: set.size }))
    .sort((a, b) => b.pages - a.pages || (a.name < b.name ? -1 : 1));
  return { name, summary: { now: new Date(now).toISOString(), entities: rows.length }, rows };
}
