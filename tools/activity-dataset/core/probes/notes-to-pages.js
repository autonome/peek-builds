export const name = 'notes-to-pages';
export const LINKED_TYPES = new Set(['place', 'organization', 'creative_work', 'event', 'person']);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Notes naming a kept entity (whole word, any case) linked to the pages that entity was seen on.
export function run(tables) {
  const pagesOf = new Map();
  for (const s of tables.sightings) {
    if (!s.pageId) continue;
    if (!pagesOf.has(s.entityId)) pagesOf.set(s.entityId, new Set());
    pagesOf.get(s.entityId).add(s.pageId);
  }
  const candidates = tables.entities
    .filter((e) => LINKED_TYPES.has(e.type) && pagesOf.has(e.id))
    .map((e) => ({ e, re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(e.name)}(?![\\p{L}\\p{N}])`, 'iu') }));
  const pageById = new Map(tables.pages.map((p) => [p.id, p]));
  const rows = [];
  const linkedNotes = new Set();
  for (const note of tables.notes) {
    for (const { e, re } of candidates) {
      if (!re.test(note.text)) continue;
      linkedNotes.add(note.id);
      const pageIds = [...pagesOf.get(e.id)];
      rows.push({
        noteId: note.id,
        note: note.text.slice(0, 200),
        entityId: e.id,
        entityName: e.name,
        pageIds,
        titles: pageIds.map((id) => pageById.get(id)?.title ?? '').filter(Boolean),
      });
    }
  }
  return {
    name,
    summary: { notes: tables.notes.length, notesLinked: linkedNotes.size, links: rows.length },
    rows,
  };
}
