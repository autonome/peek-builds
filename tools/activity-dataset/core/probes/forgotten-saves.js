export const name = 'forgotten-saves';

// Pages visited at most once that were shared or had text selected.
export function run(tables) {
  const rows = tables.pages
    .filter((p) => p.visitCount <= 1 && (p.sharedAt || p.selectedText))
    .map((p) => ({
      pageId: p.id,
      title: p.title,
      host: p.host,
      shared: Boolean(p.sharedAt),
      selected: Boolean(p.selectedText),
      createdAt: p.createdAt,
    }))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return { name, summary: { pages: rows.length, ofPages: tables.pages.length }, rows };
}
