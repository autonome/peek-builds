import { DatabaseSync } from 'node:sqlite';

const TABLES = {
  items: 'items',
  events: 'item_events',
  tags: 'tags',
  itemTags: 'item_tags',
  visits: 'item_visits',
};

export function openSnapshot(path) {
  return new DatabaseSync(path, { readOnly: true });
}

// Reads a desktop datastore.sqlite or a server snapshot. A missing table yields [];
// a missing column is simply absent from the row (read as undefined).
export function loadSnapshot(path) {
  const db = openSnapshot(path);
  try {
    const present = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => r.name),
    );
    const out = {};
    for (const [key, table] of Object.entries(TABLES)) {
      out[key] = present.has(table) ? db.prepare(`SELECT * FROM "${table}"`).all().map((r) => ({ ...r })) : [];
    }
    return out;
  } finally {
    db.close();
  }
}
