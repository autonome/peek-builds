// Turns raw datastore rows into the tables the probes read. Pure: plain arrays in, plain data out.

export const SESSION_GAP_MS = 30 * 60 * 1000;

export const AUTH_PAGE_RE = /login|signin|sign-in|oauth|authorize|auth\/|sso|redirect|callback/i;

// A prefix such as `peek:`, `entity:` or `from:` marks a tag the app wrote itself.
export const MACHINE_TAG_RE = /^[a-z0-9_-]+:/i;
export const MACHINE_TAGS = new Set(['todo', 'done', 'today', 'note', 'readme']);

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec'];
const CALENDAR_WORDS = new Set([...WEEKDAYS, ...MONTHS]);

export function parseMetadata(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || value === '') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function isDeleted(deletedAt) {
  return !(deletedAt === 0 || deletedAt === null || deletedAt === undefined || deletedAt === '' || deletedAt === '0');
}

export function isMachineTag(name) {
  return MACHINE_TAG_RE.test(name) || MACHINE_TAGS.has(name.toLowerCase());
}

export function cleanEntityName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (/[\n\r\t]/.test(trimmed)) return null;
  if (trimmed.replace(/[^\p{L}]/gu, '').length < 3) return null;
  const tokens = trimmed.split(/\s+/);
  const short = tokens.filter((t) => t.replace(/[^\p{L}]/gu, '').length <= 2).length;
  if (short > tokens.length / 2) return null;
  if (tokens.every((t) => CALENDAR_WORDS.has(t.toLowerCase().replace(/[^\p{L}]/gu, '')))) return null;
  return trimmed;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function pathOf(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return '';
  }
}

function cleanTitle(title, url, host) {
  const t = typeof title === 'string' ? title.trim() : '';
  if (!t) return '';
  if (/^https?:\/\//i.test(t) || t === url) return '';
  if (t.toLowerCase().replace(/^www\./, '') === host) return '';
  return t;
}

function feedbackState(meta) {
  const raw = meta.feedback ?? meta.state ?? meta.status;
  if (typeof raw === 'string' && /^(accepted|rejected)$/i.test(raw)) return raw.toLowerCase();
  if (meta.accepted === true) return 'accepted';
  if (meta.rejected === true) return 'rejected';
  return null;
}

function buildLabels(items, tags, itemTags) {
  const tagName = new Map();
  for (const t of tags) tagName.set(t.id, t.name);
  const live = new Map();
  for (const it of items) if (!isDeleted(it.deletedAt)) live.set(it.id, it);

  const topical = [];
  for (const link of itemTags) {
    const item = live.get(link.itemId);
    const name = tagName.get(link.tagId);
    if (!item || typeof name !== 'string' || name === '') continue;
    if (item.type !== 'url' && item.type !== 'text') continue;
    if (isMachineTag(name)) continue;
    topical.push({ itemId: item.id, tag: name });
  }

  const feedback = [];
  for (const it of live.values()) {
    if (it.type !== 'entity') continue;
    const state = feedbackState(parseMetadata(it.metadata));
    if (state) feedback.push({ entityId: it.id, state });
  }
  return { topical, feedback };
}

function buildSessions(visits, pageIds) {
  const sorted = visits
    .filter((v) => typeof v.timestamp === 'number')
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp);
  const sessions = [];
  let current = null;
  let last = 0;
  for (const v of sorted) {
    if (!current || v.timestamp - last > SESSION_GAP_MS) {
      current = { id: v.id, start: v.timestamp, end: v.timestamp, pageIds: [], totalDurationMs: 0 };
      sessions.push(current);
    }
    current.end = v.timestamp;
    last = v.timestamp;
    current.totalDurationMs += Number(v.duration) || 0;
    if (pageIds.has(v.itemId) && !current.pageIds.includes(v.itemId)) current.pageIds.push(v.itemId);
  }
  return sessions;
}

export function normalize({ items = [], events = [], tags = [], itemTags = [], visits = [] } = {}) {
  const labels = buildLabels(items, tags, itemTags);
  const tagsByItem = new Map();
  for (const { itemId, tag } of labels.topical) {
    if (!tagsByItem.has(itemId)) tagsByItem.set(itemId, []);
    const list = tagsByItem.get(itemId);
    if (!list.includes(tag)) list.push(tag);
  }

  const pages = [];
  const entities = [];
  const notes = [];
  for (const it of items) {
    if (isDeleted(it.deletedAt)) continue;
    const meta = parseMetadata(it.metadata);
    if (it.type === 'url') {
      const url = it.content ?? '';
      const host = hostOf(url);
      if (AUTH_PAGE_RE.test(host + pathOf(url))) continue;
      const title = cleanTitle(it.title || meta.title, url, host);
      const selectedText = typeof meta.selectedText === 'string' ? meta.selectedText : '';
      const description = typeof meta._og?.description === 'string' ? meta._og.description : '';
      pages.push({
        id: it.id,
        url,
        host,
        title,
        text: [title, description, selectedText].filter(Boolean).join(' '),
        visitCount: Number(it.visitCount) || 0,
        lastVisitAt: Number(it.lastVisitAt) || 0,
        createdAt: it.createdAt,
        topicalTags: tagsByItem.get(it.id) ?? [],
        sharedAt: meta.sharedAt ?? null,
        selectedText,
      });
    } else if (it.type === 'entity') {
      const name = cleanEntityName(it.content);
      if (name) entities.push({ id: it.id, name, type: meta.entityType ?? '' });
    } else if (it.type === 'text') {
      notes.push({ id: it.id, text: it.content ?? '', createdAt: it.createdAt });
    }
  }

  const entityIds = new Set(entities.map((e) => e.id));
  const pageByUrl = new Map();
  for (const p of pages) if (!pageByUrl.has(p.url)) pageByUrl.set(p.url, p.id);
  const sightings = [];
  for (const ev of events) {
    if (!entityIds.has(ev.itemId)) continue;
    if (typeof ev.content !== 'string' || !ev.content.startsWith('http')) continue;
    sightings.push({
      entityId: ev.itemId,
      url: ev.content,
      pageId: pageByUrl.get(ev.content) ?? null,
      occurredAt: ev.occurredAt,
      confidence: ev.value,
    });
  }

  const sessions = buildSessions(visits, new Set(pages.map((p) => p.id)));
  return { pages, entities, sightings, sessions, notes, labels };
}
