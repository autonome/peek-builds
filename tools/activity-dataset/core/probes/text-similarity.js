import { edgeKey, tokenize } from '../graph.js';

export const name = 'text-similarity';
export const TOP_N = 5;
export const MIN_SIMILARITY = 0.2;

// TF-IDF cosine over page text; returns each page's top neighbours above the threshold.
export function neighbours(tables, options = {}) {
  const topN = options.topN ?? TOP_N;
  const minSimilarity = options.minSimilarity ?? MIN_SIMILARITY;
  const docs = [];
  const df = new Map();
  for (const p of tables.pages) {
    const tf = new Map();
    for (const w of tokenize(p.text)) tf.set(w, (tf.get(w) ?? 0) + 1);
    if (!tf.size) continue;
    docs.push({ id: p.id, tf });
    for (const w of tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);
  }
  const n = docs.length;
  const postings = new Map();
  for (const d of docs) {
    let norm = 0;
    d.vec = new Map();
    for (const [w, c] of d.tf) {
      const x = (1 + Math.log(c)) * (Math.log((1 + n) / (1 + df.get(w))) + 1);
      d.vec.set(w, x);
      norm += x * x;
    }
    norm = Math.sqrt(norm);
    for (const [w, x] of d.vec) {
      const v = x / norm;
      d.vec.set(w, v);
      if (!postings.has(w)) postings.set(w, []);
      postings.get(w).push([d.id, v]);
    }
  }
  const out = new Map();
  for (const d of docs) {
    const acc = new Map();
    for (const [w, v] of d.vec) {
      for (const [otherId, ov] of postings.get(w)) {
        if (otherId !== d.id) acc.set(otherId, (acc.get(otherId) ?? 0) + v * ov);
      }
    }
    const top = [...acc]
      .filter(([, s]) => s > minSimilarity)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, topN)
      .map(([id, similarity]) => ({ id, similarity }));
    if (top.length) out.set(d.id, top);
  }
  return out;
}

export function edges(tables, options = {}) {
  const out = new Map();
  for (const [id, list] of neighbours(tables, options)) {
    for (const { id: other, similarity } of list) {
      // each pair is seen from both sides; keep the larger score rather than summing
      const key = edgeKey(id, other);
      if (!out.has(key) || out.get(key) < similarity) out.set(key, similarity);
    }
  }
  return out;
}

export function run(tables, options = {}) {
  const found = neighbours(tables, options);
  const tagsOf = new Map(tables.pages.map((p) => [p.id, p.topicalTags]));
  const titleOf = new Map(tables.pages.map((p) => [p.id, p.title]));
  let total = 0;
  let scored = 0;
  for (const [id, list] of found) {
    const mine = tagsOf.get(id);
    if (!mine?.length) continue;
    const shared = list.filter((nb) => (tagsOf.get(nb.id) ?? []).some((t) => mine.includes(t))).length;
    total += shared / list.length;
    scored++;
  }
  const precisionAt5 = scored ? total / scored : null;
  const rows = [...found].map(([id, list]) => ({
    pageId: id,
    title: titleOf.get(id),
    neighbours: list.map((nb) => ({ ...nb, title: titleOf.get(nb.id) })),
  }));
  return {
    name,
    summary: { pagesWithNeighbours: found.size, labelledScored: scored, precisionAt5 },
    rows,
    score: { precisionAt5 },
  };
}
