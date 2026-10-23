// Heuristic background grouper: pure scoring and clustering, plus a read-only
// loader for a copy of a profile's datastore.sqlite. Design and data findings:
// docs/design/background-grouping.md.

import { DatabaseSync } from 'node:sqlite';

export const DEFAULTS = {
  days: 14,
  cutoff: 0.2,
  sessionGapMs: 30 * 60 * 1000,
  minItems: 3,
  minSessions: 2,
  // An entity seen on more pages than this share of all pages (or this many,
  // whichever is larger) separates nothing and is dropped.
  entityMaxPages: 8,
};

// Hand-set weights; they sum to 1 so a pair score stays in 0..1.
export const WEIGHTS = {
  title: 0.25,
  site: 0.15,
  session: 0.3,
  navigation: 0.1,
  entities: 0.1,
  tags: 0.1,
};

const STOPWORDS = new Set(
  ('the and for with from that this your you are was were have has not but all can any new ' +
    'home page index about welcome login sign https http www com org net html')
    .split(' ')
);

// ---------------------------------------------------------------- page filter

const AUTH_PATH_SEGMENTS = new Set([
  'signin', 'sign-in', 'sign_in', 'login', 'log-in', 'log_in', 'logout', 'signout', 'sign-out',
  'oauth', 'oauth2', 'authorize', 'sso', 'saml', 'callback', 'redirect', 'auth', 'authenticate',
  'consent', 'signup', 'sign-up', 'register',
]);
const AUTH_HOST_PREFIXES = ['accounts.', 'login.', 'auth.', 'sso.', 'signin.', 'id.', 'oauth.'];
const AUTH_QUERY_KEYS = ['redirect_uri', 'redirect_url', 'client_id', 'response_type', 'continue', 'return_to', 'returnurl', 'saml', 'sso'];
const AUTH_TITLE = /^\s*(sign[\s-]?in|log[\s-]?in|log[\s-]?out|sign[\s-]?up|redirecting|authori[sz]e|authenticat|verify your|just a moment)/i;

/** True for sign-in, OAuth and redirect pages, which formed groups of their own. */
export function isAuthPage(url, title = '') {
  if (AUTH_TITLE.test(title || '')) return true;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  if (AUTH_HOST_PREFIXES.some((p) => host.startsWith(p))) return true;
  const segs = u.pathname.toLowerCase().split('/').filter(Boolean);
  if (segs.some((s) => AUTH_PATH_SEGMENTS.has(s))) return true;
  for (const k of u.searchParams.keys()) {
    if (AUTH_QUERY_KEYS.includes(k.toLowerCase())) return true;
  }
  return false;
}

/** A title that is just a URL (or host/path) counts as no title. */
export function effectiveTitle(title, url = '') {
  const t = (title || '').trim();
  if (!t) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return '';
  if (url && (t === url || t === url.replace(/^https?:\/\//, ''))) return '';
  // bare host or host/path with no spaces: "example.com/foo?x=1"
  if (!/\s/.test(t) && /^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(t)) return '';
  return t;
}

export function titleTokens(title) {
  return (title || '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

// ------------------------------------------------------------------- site

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu']);

export function registrableDomain(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const n = SECOND_LEVEL.has(parts[parts.length - 2]) && parts[parts.length - 1].length === 2 ? 3 : 2;
  return parts.slice(-n).join('.');
}

function pathSegments(url) {
  try {
    return new URL(url).pathname.split('/').filter(Boolean);
  } catch {
    return [];
  }
}

export function siteSignal(urlA, urlB) {
  const da = registrableDomain(urlA);
  if (!da || da !== registrableDomain(urlB)) return 0;
  const a = pathSegments(urlA);
  const b = pathSegments(urlB);
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
  return 0.6 + 0.4 * Math.min(1, shared / 2);
}

// --------------------------------------------------------------- sessions

/** Weight of one visit: dwell time and interaction, not presence alone. Duration is in ms. */
export function visitWeight(visit) {
  const dwell = Math.min(1, Math.max(0, visit.duration || 0) / 60000);
  const touched = visit.interacted ? 1 : 0;
  return Math.min(1, 0.2 + 0.5 * dwell + 0.3 * touched);
}

/** Cut visits (sorted or not) into sessions at an idle gap. */
export function cutSessions(visits, gapMs = DEFAULTS.sessionGapMs) {
  const sorted = [...visits].sort((a, b) => a.timestamp - b.timestamp);
  const sessions = [];
  let cur = null;
  let last = 0;
  for (const v of sorted) {
    if (!cur || v.timestamp - last > gapMs) {
      cur = [];
      sessions.push(cur);
    }
    cur.push(v);
    last = v.timestamp;
  }
  return sessions;
}

/**
 * Pair co-occurrence in 0..1. Each shared session adds the smaller of the two pages'
 * best visit weights, damped by session size so one marathon session cannot link everything.
 * Returns Map<"a|b", number> with a < b.
 */
export function sessionCooccurrence(sessions) {
  const sums = new Map();
  for (const s of sessions) {
    const w = new Map();
    for (const v of s) w.set(v.itemId, Math.max(w.get(v.itemId) || 0, visitWeight(v)));
    const ids = [...w.keys()].sort();
    const damp = 1 / (1 + Math.log(Math.max(1, ids.length / 2)));
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const k = ids[i] + '|' + ids[j];
        sums.set(k, (sums.get(k) || 0) + Math.min(w.get(ids[i]), w.get(ids[j])) * damp);
      }
    }
  }
  const out = new Map();
  for (const [k, s] of sums) out.set(k, 1 - Math.exp(-s));
  return out;
}

/** Consecutive visits inside a session count as navigated-from. Returns Set<"a|b">. */
export function adjacentPairs(sessions) {
  const out = new Set();
  for (const s of sessions) {
    for (let i = 1; i < s.length; i++) {
      const a = s[i - 1].itemId;
      const b = s[i].itemId;
      if (a !== b) out.add(a < b ? a + '|' + b : b + '|' + a);
    }
  }
  return out;
}

// ------------------------------------------------------------------ signals

function cosine(a, b) {
  let dot = 0;
  for (const [t, w] of a.vec) {
    const o = b.vec.get(t);
    if (o) dot += w * o;
  }
  return a.norm && b.norm ? dot / (a.norm * b.norm) : 0;
}

export function buildTfidf(pages) {
  const df = new Map();
  for (const p of pages) for (const t of new Set(p.tokens)) df.set(t, (df.get(t) || 0) + 1);
  const n = pages.length;
  const vecs = new Map();
  for (const p of pages) {
    const tf = new Map();
    for (const t of p.tokens) tf.set(t, (tf.get(t) || 0) + 1);
    const vec = new Map();
    let sq = 0;
    for (const [t, c] of tf) {
      const w = c * Math.log(1 + n / df.get(t));
      vec.set(t, w);
      sq += w * w;
    }
    vecs.set(p.id, { vec, norm: Math.sqrt(sq) });
  }
  return vecs;
}

function jaccard(a, b) {
  if (!a || !b || !a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Per-pair signal vector (each 0..1) for every pair that has any signal. */
export function pairSignals(pages, sessions, opts = {}) {
  const tfidf = buildTfidf(pages);
  const cooc = sessionCooccurrence(sessions);
  const adj = adjacentPairs(sessions);
  const out = new Map();
  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      const a = pages[i];
      const b = pages[j];
      const key = a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id;
      const s = {
        title: cosine(tfidf.get(a.id), tfidf.get(b.id)),
        site: siteSignal(a.url, b.url),
        session: cooc.get(key) || 0,
        navigation: adj.has(key) ? 1 : 0,
        entities: jaccard(a.entities, b.entities),
        tags: jaccard(a.tags, b.tags),
      };
      s.score = scoreOf(s, opts.weights);
      if (s.score > 0) out.set(key, s);
    }
  }
  return out;
}

export function scoreOf(signals, weights = WEIGHTS) {
  let t = 0;
  for (const k of Object.keys(weights)) t += weights[k] * (signals[k] || 0);
  return t;
}

// -------------------------------------------------------------- clustering

/** Agglomerative average-linkage over a sparse pair-score map; missing pairs score 0. */
export function cluster(ids, pairs, cutoff) {
  let nextId = 0;
  const members = new Map(); // cluster id -> ids[]
  const idOf = new Map();
  for (const id of ids) {
    members.set(nextId, [id]);
    idOf.set(id, nextId++);
  }
  const sums = new Map(); // "ca|cb" (ca<cb) -> sum of pair scores
  const keyOf = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
  for (const [k, s] of pairs) {
    const [a, b] = k.split('|');
    if (!idOf.has(a) || !idOf.has(b)) continue;
    sums.set(keyOf(idOf.get(a), idOf.get(b)), s.score);
  }
  for (;;) {
    let best = null;
    let bestAvg = cutoff;
    for (const [k, sum] of sums) {
      const [x, y] = k.split('|').map(Number);
      const avg = sum / (members.get(x).length * members.get(y).length);
      if (avg >= bestAvg) {
        bestAvg = avg;
        best = [x, y];
      }
    }
    if (!best) break;
    const [x, y] = best;
    const merged = nextId++;
    members.set(merged, [...members.get(x), ...members.get(y)]);
    const next = new Map();
    for (const [k, sum] of sums) {
      const [p, q] = k.split('|').map(Number);
      const inX = p === x || q === x;
      const inY = p === y || q === y;
      if (inX && inY) continue;
      if (inX || inY) {
        const other = p === x || p === y ? q : p;
        const nk = keyOf(merged, other);
        next.set(nk, (next.get(nk) || 0) + sum);
      } else {
        next.set(k, sum);
      }
    }
    members.delete(x);
    members.delete(y);
    sums.clear();
    for (const [k, v] of next) sums.set(k, v);
  }
  return [...members.values()].filter((m) => m.length > 1);
}

/** Name a group from its most frequent title words only, never URL fragments. */
export function nameGroup(titles, max = 3) {
  const counts = new Map();
  for (const t of titles) {
    for (const w of new Set(titleTokens(t))) counts.set(w, (counts.get(w) || 0) + 1);
  }
  const top = [...counts.entries()]
    .filter(([, c]) => c >= 2 || titles.length === 1)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, max)
    .map(([w]) => w);
  return top.length ? top.join(' ') : '(no common title words)';
}

/** Cluster pages, apply the cohesion filter, and describe each group. */
export function groupPages(pages, sessions, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const pairs = pairSignals(pages, sessions, o);
  const byId = new Map(pages.map((p) => [p.id, p]));
  const sessionOf = new Map(); // page id -> Set(session index)
  sessions.forEach((s, i) => {
    for (const v of s) {
      if (!sessionOf.has(v.itemId)) sessionOf.set(v.itemId, new Set());
      sessionOf.get(v.itemId).add(i);
    }
  });
  const groups = [];
  for (const ids of cluster(pages.map((p) => p.id), pairs, o.cutoff)) {
    if (ids.length < o.minItems) continue;
    const sess = new Set();
    for (const id of ids) for (const s of sessionOf.get(id) || []) sess.add(s);
    if (sess.size < o.minSessions) continue;
    const contrib = Object.fromEntries(Object.keys(WEIGHTS).map((k) => [k, 0]));
    let total = 0;
    let n = 0;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const k = ids[i] < ids[j] ? ids[i] + '|' + ids[j] : ids[j] + '|' + ids[i];
        const s = pairs.get(k);
        n++;
        if (!s) continue;
        total += s.score;
        for (const w of Object.keys(WEIGHTS)) contrib[w] += WEIGHTS[w] * s[w];
      }
    }
    for (const w of Object.keys(contrib)) contrib[w] /= n;
    const avg = total / n;
    if (avg < o.cutoff) continue;
    const members = ids.map((id) => byId.get(id));
    groups.push({
      name: nameGroup(members.map((m) => m.title)),
      avgScore: avg,
      sessions: sess.size,
      domains: new Set(members.map((m) => registrableDomain(m.url))).size,
      signals: Object.entries(contrib).sort((a, b) => b[1] - a[1]),
      members,
    });
  }
  return groups.sort((a, b) => b.members.length - a.members.length);
}

// ------------------------------------------------------------------ loading

/** Read pages, visits, entities and tags from a database copy, opened read-only. */
export function loadData(dbPath, { days = DEFAULTS.days, now = Date.now(), entityMaxPages = DEFAULTS.entityMaxPages } = {}) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const since = now - days * 86400000;
    const rows = db
      .prepare(
        `SELECT v.itemId, v.timestamp, v.duration, v.interacted, i.title, i.content AS url
         FROM item_visits v JOIN items i ON i.id = v.itemId
         WHERE v.timestamp >= ? AND v.timestamp <= ? AND i.type = 'url'
           AND (i.deletedAt IS NULL OR i.deletedAt = 0)`
      )
      .all(since, now);
    const visits = [];
    const pageMap = new Map();
    let excludedAuth = 0;
    const excluded = new Set();
    for (const r of rows) {
      if (!/^https?:\/\//i.test(r.url || '')) continue;
      if (excluded.has(r.itemId)) continue;
      if (!pageMap.has(r.itemId)) {
        if (isAuthPage(r.url, r.title)) {
          excluded.add(r.itemId);
          excludedAuth++;
          continue;
        }
        const title = effectiveTitle(r.title, r.url);
        pageMap.set(r.itemId, {
          id: r.itemId,
          url: r.url,
          title,
          tokens: titleTokens(title),
          entities: new Set(),
          tags: new Set(),
        });
      }
      visits.push({ itemId: r.itemId, timestamp: r.timestamp, duration: r.duration, interacted: r.interacted });
    }
    const pages = [...pageMap.values()];

    const byUrl = new Map(pages.map((p) => [p.url, p]));
    const ev = db.prepare(`SELECT itemId, content FROM item_events WHERE content LIKE 'http%'`).all();
    const entityPages = new Map();
    for (const e of ev) {
      const p = byUrl.get(e.content);
      if (!p) continue;
      if (!entityPages.has(e.itemId)) entityPages.set(e.itemId, new Set());
      entityPages.get(e.itemId).add(p);
    }
    const cap = Math.max(entityMaxPages, 0);
    for (const [eid, set] of entityPages) {
      if (set.size > cap) continue;
      for (const p of set) p.entities.add(eid);
    }

    const tagRows = db
      .prepare(`SELECT it.itemId, t.name FROM item_tags it JOIN tags t ON t.id = it.tagId`)
      .all();
    const byId = new Map(pages.map((p) => [p.id, p]));
    for (const r of tagRows) {
      const p = byId.get(r.itemId);
      if (!p) continue;
      if (r.name.startsWith('space:') || r.name.startsWith('from:')) continue;
      p.tags.add(r.name);
    }
    return { pages, visits, excludedAuth };
  } finally {
    db.close();
  }
}

export function runGrouper(dbPath, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const { pages, visits, excludedAuth } = loadData(dbPath, o);
  const sessions = cutSessions(visits, o.sessionGapMs);
  const groups = groupPages(pages, sessions, o);
  return { groups, stats: { visits: visits.length, pages: pages.length, sessions: sessions.length, excludedAuth } };
}

export function formatReport({ groups, stats }, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const grouped = groups.reduce((n, g) => n + g.members.length, 0);
  const lines = [
    '# Background grouper report',
    '',
    `Window: last ${o.days} days. Cutoff: ${o.cutoff}.`,
    `${stats.visits} visits, ${stats.pages} web pages after filtering (${stats.excludedAuth} sign-in/redirect pages dropped), ${stats.sessions} sessions.`,
    `${groups.length} groups, ${grouped} of ${stats.pages} pages grouped.`,
    '',
  ];
  groups.forEach((g, i) => {
    lines.push(`## ${i + 1}. ${g.name}`);
    lines.push(
      `${g.members.length} pages, ${g.sessions} sessions, ${g.domains} sites, average pair score ${g.avgScore.toFixed(2)}`
    );
    lines.push('Top signals: ' + g.signals.slice(0, 3).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', '));
    lines.push('');
    for (const m of g.members) lines.push(`- ${m.title || '(no title)'} <${m.url}>`);
    lines.push('');
  });
  return lines.join('\n');
}
