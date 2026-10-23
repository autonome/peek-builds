export const name = 'habits';

// Hosts ranked by summed visit count.
export function run(tables) {
  const byHost = new Map();
  for (const p of tables.pages) {
    if (!p.host) continue;
    const cur = byHost.get(p.host) ?? { host: p.host, visits: 0, pages: 0 };
    cur.visits += p.visitCount;
    cur.pages += 1;
    byHost.set(p.host, cur);
  }
  const rows = [...byHost.values()].sort((a, b) => b.visits - a.visits || (a.host < b.host ? -1 : 1));
  return { name, summary: { hosts: rows.length }, rows };
}
