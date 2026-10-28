export const name = 'interests';
export const DURABLE_WEEKS = 4;

const DAY_MS = 86400000;

function isoWeek(ms) {
  const d = new Date(ms);
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date - yearStart) / DAY_MS + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

// Entities ranked by distinct days seen; durable when seen in 4+ distinct ISO weeks.
export function run(tables) {
  const byEntity = new Map();
  for (const s of tables.sightings) {
    if (typeof s.occurredAt !== 'number') continue;
    if (!byEntity.has(s.entityId)) byEntity.set(s.entityId, []);
    byEntity.get(s.entityId).push(s.occurredAt);
  }
  const entityById = new Map(tables.entities.map((e) => [e.id, e]));
  const rows = [];
  for (const [id, times] of byEntity) {
    const e = entityById.get(id);
    const days = new Set(times.map(dayOf));
    const weeks = new Set(times.map(isoWeek));
    rows.push({
      entityId: id,
      name: e.name,
      type: e.type,
      days: days.size,
      weeks: weeks.size,
      first: dayOf(Math.min(...times)),
      last: dayOf(Math.max(...times)),
      durable: weeks.size >= DURABLE_WEEKS,
    });
  }
  rows.sort((a, b) => b.days - a.days || b.weeks - a.weeks || (a.name < b.name ? -1 : 1));
  return {
    name,
    summary: { entities: rows.length, durable: rows.filter((r) => r.durable).length },
    rows,
  };
}
