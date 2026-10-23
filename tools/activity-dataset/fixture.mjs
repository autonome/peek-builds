// Synthetic rows shared by the tests. Invented sites only; never derived from a real snapshot.
import { DatabaseSync } from 'node:sqlite';

export const DAY = 86400000;
export const BASE = Date.UTC(2020, 0, 1);

const TOPICS = [
  {
    key: 'a',
    tag: 'lisbon',
    host: 'travel.example.test',
    words: ['lisbon', 'tram', 'pastel', 'alfama', 'fado', 'tile'],
    entityType: 'place',
    entities: ['Alfama District', 'Belem Tower', 'Sintra Palace', 'Cascais Beach', 'Rossio Square', 'Chiado Quarter', 'Bairro Alto', 'Time Out Market', 'Tagus River', 'Pena Park'],
    dayOffset: 0,
  },
  {
    key: 'b',
    tag: 'bread',
    host: 'www.baking.example.test',
    words: ['sourdough', 'levain', 'crumb', 'proofing', 'hydration', 'banneton'],
    entityType: 'creative_work',
    entities: ['Levain Starter', 'Dutch Oven', 'Rye Flour', 'Banneton Basket', 'Bench Scraper', 'Proofing Box', 'Hydration Ratio', 'Autolyse Rest', 'Crumb Structure', 'Scoring Lame'],
    dayOffset: 50,
  },
];

const PAGES_PER_TOPIC = 30;

// Two topics of 30 pages each. Each entity is seen on three consecutive pages of its topic;
// one hub entity is seen on every page.
export function buildRows({ withVisits = false } = {}) {
  const items = [];
  const events = [];
  const tags = [];
  const itemTags = [];
  const visits = [];
  let n = 0;
  const id = (p) => `${p}${++n}`;

  items.push({ id: 'hub', type: 'entity', content: 'Inbox Central', metadata: JSON.stringify({ entityType: 'organization' }), createdAt: BASE, deletedAt: 0 });
  for (const topic of TOPICS) tags.push({ id: `tag-${topic.key}`, name: topic.tag });
  tags.push({ id: 'tag-machine', name: 'peek:saved' }, { id: 'tag-todo', name: 'todo' });

  let pageNo = 0;
  for (const topic of TOPICS) {
    topic.entities.forEach((name, k) => {
      items.push({ id: `${topic.key}-ent-${k}`, type: 'entity', content: name, metadata: JSON.stringify({ entityType: topic.entityType }), createdAt: BASE, deletedAt: 0 });
    });
    for (let i = 0; i < PAGES_PER_TOPIC; i++) {
      const pid = `${topic.key}-page-${i}`;
      const w = topic.words;
      const title = `${w[i % 6]} ${w[(i + 1) % 6]} ${w[(i + 2) % 6]} notes`;
      const meta = { _og: { description: `A page about ${w[i % 6]} and ${w[(i + 3) % 6]}` } };
      if (i === 0) meta.sharedAt = BASE;
      if (i === 1) meta.selectedText = `${w[0]} highlight`;
      items.push({
        id: pid,
        type: 'url',
        content: `https://${topic.host}/p/${i}`,
        title,
        metadata: JSON.stringify(meta),
        createdAt: BASE + pageNo * DAY,
        deletedAt: 0,
        visitCount: i < 2 ? 1 : 2 + (i % 3),
        lastVisitAt: BASE + pageNo * DAY,
      });
      itemTags.push({ id: id('it'), itemId: pid, tagId: `tag-${topic.key}` });
      if (i % 5 === 0) itemTags.push({ id: id('it'), itemId: pid, tagId: 'tag-machine' });
      events.push({ id: id('ev'), itemId: `${topic.key}-ent-${Math.floor(i / 3)}`, content: `https://${topic.host}/p/${i}`, value: 0.9, occurredAt: BASE + (topic.dayOffset + Math.floor(i / 3)) * DAY });
      events.push({ id: id('ev'), itemId: 'hub', content: `https://${topic.host}/p/${i}`, value: 0.5, occurredAt: BASE + pageNo * DAY });
      if (withVisits) {
        visits.push({ id: id('v'), itemId: pid, timestamp: BASE + pageNo * DAY, duration: 60000 });
        visits.push({ id: id('v'), itemId: `${topic.key}-page-${(i + 1) % PAGES_PER_TOPIC}`, timestamp: BASE + pageNo * DAY + 60000, duration: 60000 });
        visits.push({ id: id('v'), itemId: `${topic.key}-page-${(i + 2) % PAGES_PER_TOPIC}`, timestamp: BASE + pageNo * DAY + 120000, duration: 60000 });
      }
      pageNo++;
    }
  }

  items.push({ id: 'note-1', type: 'text', content: 'Book a table near belem tower for Friday', createdAt: BASE, deletedAt: 0 });
  items.push({ id: 'note-2', type: 'text', content: 'Buy milk', createdAt: BASE, deletedAt: 0 });
  return { items, events, tags, itemTags, visits };
}

const DDL = {
  items:
    'CREATE TABLE items (id TEXT PRIMARY KEY, type TEXT, content TEXT, metadata TEXT, createdAt INTEGER, deletedAt INTEGER DEFAULT 0, visitCount INTEGER DEFAULT 0, lastVisitAt INTEGER DEFAULT 0, title TEXT DEFAULT \'\')',
  item_events: 'CREATE TABLE item_events (id TEXT PRIMARY KEY, itemId TEXT, content TEXT, value REAL, occurredAt INTEGER)',
  tags: 'CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT)',
  item_tags: 'CREATE TABLE item_tags (id TEXT PRIMARY KEY, itemId TEXT, tagId TEXT)',
  item_visits: 'CREATE TABLE item_visits (id TEXT PRIMARY KEY, itemId TEXT, timestamp INTEGER, duration INTEGER DEFAULT 0)',
};

const COLUMNS = {
  items: ['id', 'type', 'content', 'metadata', 'createdAt', 'deletedAt', 'visitCount', 'lastVisitAt', 'title'],
  item_events: ['id', 'itemId', 'content', 'value', 'occurredAt'],
  tags: ['id', 'name'],
  item_tags: ['id', 'itemId', 'tagId'],
  item_visits: ['id', 'itemId', 'timestamp', 'duration'],
};

// Writes rows to a sqlite file. `item_visits` is created only when `withVisits`, like a server snapshot without it.
export function writeSnapshot(path, rows, { withVisits = false } = {}) {
  const db = new DatabaseSync(path);
  const plan = [
    ['items', rows.items],
    ['item_events', rows.events],
    ['tags', rows.tags],
    ['item_tags', rows.itemTags],
  ];
  if (withVisits) plan.push(['item_visits', rows.visits]);
  for (const [table, list] of plan) {
    db.exec(DDL[table]);
    const cols = COLUMNS[table];
    const stmt = db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
    for (const row of list) stmt.run(...cols.map((c) => row[c] ?? null));
  }
  db.close();
}
