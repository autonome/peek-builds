import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTH_PAGE_RE, SESSION_GAP_MS, cleanEntityName, normalize } from './core/normalize.js';

const MIN = 60000;
const url = (id, content, extra = {}) => ({ id, type: 'url', content, title: 'A page', metadata: '{}', createdAt: 1, deletedAt: 0, ...extra });

test('AUTH_PAGE_RE matches login and OAuth URLs', () => {
  for (const u of [
    'https://example.test/login',
    'https://example.test/users/sign-in?next=/',
    'https://accounts.example.test/o/oauth2/auth',
    'https://example.test/auth/callback',
    'https://example.test/redirect?to=x',
  ]) {
    assert.ok(AUTH_PAGE_RE.test(u), u);
  }
  assert.ok(!AUTH_PAGE_RE.test('https://example.test/recipes/bread'));
});

test('normalize drops login and OAuth pages', () => {
  const { pages } = normalize({
    items: [url('keep', 'https://example.test/recipes'), url('login', 'https://example.test/login'), url('oauth', 'https://example.test/oauth/authorize')],
  });
  assert.deepEqual(
    pages.map((p) => p.id),
    ['keep'],
  );
});

test('a title that is only a URL or the host becomes empty; host drops www and lowercases', () => {
  const { pages } = normalize({
    items: [
      url('a', 'https://www.Example.test/x', { title: 'https://www.example.test/x' }),
      url('b', 'https://example.test/y', { title: 'example.test' }),
      url('c', 'https://example.test/z', { title: 'Real title' }),
    ],
  });
  assert.equal(pages[0].title, '');
  assert.equal(pages[0].host, 'example.test');
  assert.equal(pages[1].title, '');
  assert.equal(pages[2].title, 'Real title');
});

test('page text joins title, description and selected text', () => {
  const { pages } = normalize({
    items: [url('a', 'https://example.test/x', { metadata: JSON.stringify({ _og: { description: 'desc' }, selectedText: 'sel' }) })],
  });
  assert.equal(pages[0].text, 'A page desc sel');
});

test('cleanEntityName rejects calendar headers, newlines and month abbreviations', () => {
  assert.equal(cleanEntityName('Su Mo Tu'), null);
  assert.equal(cleanEntityName('Su\nMo'), null);
  assert.equal(cleanEntityName('Jan'), null);
  assert.equal(cleanEntityName('Mon Tue'), null);
  assert.equal(cleanEntityName('ab'), null);
  assert.equal(cleanEntityName('Lisbon'), 'Lisbon');
});

test('sessions split at a 31-minute gap and not at a 29-minute one', () => {
  const items = [url('p1', 'https://example.test/1'), url('p2', 'https://example.test/2'), url('p3', 'https://example.test/3')];
  assert.equal(SESSION_GAP_MS, 30 * MIN);
  const split = normalize({
    items,
    visits: [
      { id: 'v1', itemId: 'p1', timestamp: 0, duration: 1000 },
      { id: 'v2', itemId: 'p2', timestamp: 31 * MIN, duration: 2000 },
    ],
  }).sessions;
  assert.equal(split.length, 2);
  assert.equal(split[0].id, 'v1');
  const joined = normalize({
    items,
    visits: [
      { id: 'v1', itemId: 'p1', timestamp: 0, duration: 1000 },
      { id: 'v2', itemId: 'p2', timestamp: 29 * MIN, duration: 2000 },
      { id: 'v3', itemId: 'p3', timestamp: 58 * MIN, duration: 3000 },
    ],
  }).sessions;
  assert.equal(joined.length, 1);
  assert.deepEqual(joined[0].pageIds, ['p1', 'p2', 'p3']);
  assert.equal(joined[0].totalDurationMs, 6000);
  assert.equal(joined[0].end, 58 * MIN);
});

test('no visits means no sessions', () => {
  assert.deepEqual(normalize({ items: [url('p1', 'https://example.test/1')] }).sessions, []);
});

test('deleted rows are excluded under each deletedAt form', () => {
  const items = [
    url('zero', 'https://example.test/0', { deletedAt: 0 }),
    url('null', 'https://example.test/1', { deletedAt: null }),
    url('empty', 'https://example.test/2', { deletedAt: '' }),
    url('missing', 'https://example.test/3', { deletedAt: undefined }),
    url('gone', 'https://example.test/4', { deletedAt: 1700000000000 }),
    { id: 'ent-gone', type: 'entity', content: 'Lisbon', metadata: '{}', deletedAt: 5 },
    { id: 'ent-ok', type: 'entity', content: 'Lisbon', metadata: '{}', deletedAt: null },
  ];
  const { pages, entities } = normalize({ items });
  assert.deepEqual(
    pages.map((p) => p.id),
    ['zero', 'null', 'empty', 'missing'],
  );
  assert.deepEqual(
    entities.map((e) => e.id),
    ['ent-ok'],
  );
});

test('topical labels skip machine tags; sightings link to pages by url', () => {
  const { pages, labels, sightings } = normalize({
    items: [url('p1', 'https://example.test/1'), { id: 'e1', type: 'entity', content: 'Lisbon', metadata: JSON.stringify({ entityType: 'place', feedback: 'accepted' }), deletedAt: 0 }],
    tags: [
      { id: 't1', name: 'travel' },
      { id: 't2', name: 'peek:saved' },
      { id: 't3', name: 'todo' },
    ],
    itemTags: [
      { itemId: 'p1', tagId: 't1' },
      { itemId: 'p1', tagId: 't2' },
      { itemId: 'p1', tagId: 't3' },
    ],
    events: [
      { itemId: 'e1', content: 'https://example.test/1', value: 0.8, occurredAt: 10 },
      { itemId: 'e1', content: 'not a url', value: 1, occurredAt: 11 },
      { itemId: 'e1', content: 'https://elsewhere.test/', value: 1, occurredAt: 12 },
    ],
  });
  assert.deepEqual(pages[0].topicalTags, ['travel']);
  assert.deepEqual(labels.topical, [{ itemId: 'p1', tag: 'travel' }]);
  assert.deepEqual(labels.feedback, [{ entityId: 'e1', state: 'accepted' }]);
  assert.equal(sightings.length, 2);
  assert.equal(sightings[0].pageId, 'p1');
  assert.equal(sightings[1].pageId, null);
});
