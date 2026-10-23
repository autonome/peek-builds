// Shared pieces for the probes: edge maps, union-find grouping, group naming, scoring, tokenizing.

export const STOPWORDS = new Set(
  (
    'the and for with that this from your you are was were have has had not but all can will about into out ' +
    'how what why when who more most new one two get got just than then them they their its our his her she him ' +
    'any only over also been being very after before between through www com org net http https'
  ).split(' '),
);

export function tokenize(text) {
  const words = String(text ?? '')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu);
  return (words ?? []).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

export function edgeKey(a, b) {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

export function addEdge(edges, a, b, weight) {
  if (a === b) return;
  const key = edgeKey(a, b);
  edges.set(key, (edges.get(key) ?? 0) + weight);
}

export function normalizeEdges(edges) {
  let max = 0;
  for (const w of edges.values()) if (w > max) max = w;
  const out = new Map();
  if (max > 0) for (const [k, w] of edges) out.set(k, w / max);
  return out;
}

// Groups of `minSize`+ nodes joined by edges whose weight is at least `minWeight`.
export function groupsFromEdges(edges, minWeight, minSize = 3) {
  const parent = new Map();
  const find = (x) => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(x) !== root) {
      const next = parent.get(x);
      parent.set(x, root);
      x = next;
    }
    return root;
  };
  for (const [key, w] of edges) {
    if (w < minWeight) continue;
    const [a, b] = key.split('\u0000');
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const byRoot = new Map();
  for (const node of parent.keys()) {
    const root = find(node);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(node);
  }
  return [...byRoot.values()]
    .filter((g) => g.length >= minSize)
    .map((g) => g.sort())
    .sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : 1));
}

// The most frequent title words in the group, never URL fragments.
export function nameGroup(pageIds, pageById, wordCount = 3) {
  const counts = new Map();
  for (const id of pageIds) {
    for (const w of new Set(tokenize(pageById.get(id)?.title))) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, wordCount)
    .map(([w]) => w)
    .join(' ');
}

export function describeGroups(groups, pages) {
  const pageById = new Map(pages.map((p) => [p.id, p]));
  return groups.map((ids) => ({
    name: nameGroup(ids, pageById),
    size: ids.length,
    pageIds: ids,
    titles: ids.map((id) => pageById.get(id)?.title ?? '').filter(Boolean),
  }));
}

// Purity (size-weighted share of labelled pages carrying each group's majority tag), coverage, group count.
export function scoreGroups(groups, pages) {
  const tagsOf = new Map(pages.map((p) => [p.id, p.topicalTags ?? []]));
  let weighted = 0;
  let weight = 0;
  for (const ids of groups) {
    const labelled = ids.filter((id) => tagsOf.get(id)?.length);
    if (!labelled.length) continue;
    const counts = new Map();
    for (const id of labelled) for (const t of new Set(tagsOf.get(id))) counts.set(t, (counts.get(t) ?? 0) + 1);
    const majority = Math.max(...counts.values());
    weighted += ids.length * (majority / labelled.length);
    weight += ids.length;
  }
  const grouped = new Set(groups.flat()).size;
  return {
    purity: weight ? weighted / weight : null,
    coverage: pages.length ? grouped / pages.length : 0,
    groups: groups.length,
  };
}
