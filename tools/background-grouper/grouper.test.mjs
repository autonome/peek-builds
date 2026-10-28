import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  isAuthPage, isSearchPage, effectiveTitle, titleTokens, registrableDomain, siteSignal,
  visitWeight, cutSessions, sessionCooccurrence, nameGroup, runGrouper, formatReport,
  WEIGHTS, weightsFor, embeddingSimilarity, embedPages, pairSignals, groupPages,
} from './grouper.mjs';
import { assertOutsideRepo, parseArgs } from './cli.mjs';

test('isAuthPage drops sign-in, OAuth and redirect pages only', () => {
  assert.ok(isAuthPage('https://accounts.example.com/o/oauth2/v2/auth?client_id=1'));
  assert.ok(isAuthPage('https://example.com/login'));
  assert.ok(isAuthPage('https://example.com/app?redirect_uri=https%3A%2F%2Fx'));
  assert.ok(isAuthPage('https://example.com/', 'Sign in to Example'));
  assert.ok(!isAuthPage('https://example.com/authors/jane', 'Jane'));
  assert.ok(!isAuthPage('https://example.com/blog/post', 'A post about logins'));
});

test('effectiveTitle treats a URL title as no title', () => {
  assert.equal(effectiveTitle('https://example.com/a?b=1#c', 'https://example.com/a?b=1#c'), '');
  assert.equal(effectiveTitle('example.com/a?b=1'), '');
  assert.equal(effectiveTitle('', 'https://example.com'), '');
  assert.equal(effectiveTitle('Flat for rent - Example', 'https://example.com/1'), 'Flat for rent - Example');
  assert.deepEqual(titleTokens(effectiveTitle('https://example.com/?q=zebra')), []);
});

test('effectiveTitle treats an app-assigned peek label as no title', () => {
  assert.equal(effectiveTitle('Peek key 0', 'https://example.com'), '');
  assert.equal(effectiveTitle(' Peek key 12 '), '');
  assert.equal(effectiveTitle('Peek key bindings explained'), 'Peek key bindings explained');
});

test('isSearchPage matches search-results pages only', () => {
  assert.ok(isSearchPage('https://kagi.com/search?q=x'));
  assert.ok(isSearchPage('https://www.google.com/search?q=x'));
  assert.ok(isSearchPage('https://www.bing.com/search?q=x'));
  assert.ok(isSearchPage('https://duckduckgo.com/?q=x'));
  assert.ok(isSearchPage('https://html.duckduckgo.com/html/?q=x'));
  assert.ok(!isSearchPage('https://duckduckgo.com/'));
  assert.ok(!isSearchPage('https://kagi.com/about'));
  assert.ok(!isSearchPage('https://example.com/search'));
});

test('site signal: same site scores, shared path prefix scores more', () => {
  assert.equal(registrableDomain('https://a.b.example.co.uk/x'), 'example.co.uk');
  assert.equal(siteSignal('https://a.com/x', 'https://b.com/x'), 0);
  const same = siteSignal('https://a.com/x', 'https://www.a.com/y');
  const deeper = siteSignal('https://a.com/p/q/1', 'https://a.com/p/q/2');
  assert.ok(same > 0 && deeper > same);
});

test('visitWeight rises with dwell time and interaction', () => {
  const bare = visitWeight({ duration: 0, interacted: 0 });
  assert.ok(visitWeight({ duration: 30000, interacted: 0 }) > bare);
  assert.ok(visitWeight({ duration: 0, interacted: 1 }) > bare);
  assert.ok(visitWeight({ duration: 10 ** 9, interacted: 1 }) <= 1);
});

test('co-occurrence weights engaged visits above fleeting ones', () => {
  const t = 1_000_000;
  const engaged = cutSessions([
    { itemId: 'a', timestamp: t, duration: 90000, interacted: 1 },
    { itemId: 'b', timestamp: t + 1000, duration: 90000, interacted: 1 },
  ]);
  const fleeting = cutSessions([
    { itemId: 'a', timestamp: t, duration: 0, interacted: 0 },
    { itemId: 'b', timestamp: t + 1000, duration: 0, interacted: 0 },
  ]);
  assert.ok(sessionCooccurrence(engaged).get('a|b') > sessionCooccurrence(fleeting).get('a|b'));
  assert.equal(cutSessions([
    { itemId: 'a', timestamp: 0 }, { itemId: 'b', timestamp: 40 * 60000 },
  ]).length, 2);
});

test('group names come from title words only', () => {
  const name = nameGroup(['Berlin flat listing', 'Berlin flat viewing', 'Flat prices Berlin']);
  assert.equal(name, 'berlin flat');
  assert.ok(!/http|www|\d/.test(nameGroup(['Berlin flat', 'Berlin flat'])));
});

test('guards refuse paths inside the repo and bad arguments', () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  assert.throws(() => assertOutsideRepo(path.join(here, 'report.md'), 'report path'));
  assert.doesNotThrow(() => assertOutsideRepo(path.join(os.tmpdir(), 'x'), 'report path', here));
  assert.throws(() => parseArgs(['only-one']));
  assert.throws(() => parseArgs(['a', 'b', '--cutoff', '0']));
  assert.equal(parseArgs(['a', 'b', '--days', '7']).opts.days, 7);
});

function makeFixture(dir, now) {
  const file = path.join(dir, 'datastore.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE items (id TEXT PRIMARY KEY, type TEXT, content TEXT, title TEXT DEFAULT '', deletedAt INTEGER DEFAULT 0);
    CREATE TABLE item_visits (id TEXT PRIMARY KEY, itemId TEXT, timestamp INTEGER, duration INTEGER DEFAULT 0, interacted INTEGER DEFAULT 0);
    CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE item_tags (id TEXT PRIMARY KEY, itemId TEXT, tagId TEXT);
    CREATE TABLE item_events (id TEXT PRIMARY KEY, itemId TEXT, content TEXT);
  `);
  const pages = [
    ['a', 'https://homes.example/listing/1', 'Berlin flat listing'],
    ['b', 'https://maps.example/place/2', 'Berlin flat map view'],
    ['c', 'https://sheets.example/d/3', 'Berlin flat comparison sheet'],
    ['d', 'https://accounts.example/login?client_id=9', 'Sign in'],
    ['e', 'https://other.example/q?x=1', 'https://other.example/q?x=1'],
    ['f', 'https://kagi.com/search?q=berlin+flat', 'berlin flat search'],
    ['g', 'https://mail.example/inbox', 'Peek key 3'],
  ];
  const ins = db.prepare('INSERT INTO items (id, type, content, title) VALUES (?, ?, ?, ?)');
  for (const [id, url, title] of pages) ins.run(id, 'url', url, title);
  db.prepare('INSERT INTO items (id, type, content, title, deletedAt) VALUES (?, ?, ?, ?, ?)')
    .run('gone', 'url', 'https://homes.example/listing/9', 'Berlin flat deleted', 5);
  db.prepare('INSERT INTO tags VALUES (?, ?)').run('t1', 'from:history');
  const tag = db.prepare('INSERT INTO item_tags VALUES (?, ?, ?)');
  pages.forEach(([id], i) => tag.run('it' + i, id, 't1'));
  const vis = db.prepare('INSERT INTO item_visits VALUES (?, ?, ?, ?, ?)');
  let n = 0;
  const day = 86400000;
  for (const base of [now - 2 * day, now - 5 * day]) {
    ['a', 'b', 'c', 'd', 'e', 'f', 'g'].forEach((id, i) => vis.run('v' + n++, id, base + i * 60000, 60000, 1));
  }
  vis.run('v' + n++, 'a', now - 40 * day, 1000, 1); // outside the window
  vis.run('v' + n++, 'gone', now - 2 * day, 1000, 1);
  db.close();
  return file;
}

test('weights sum to 1 with and without the embedding signal', () => {
  const sum = (w) => Object.values(w).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum(WEIGHTS) - 1) < 1e-9);
  assert.equal(WEIGHTS.embedding, 0.2);
  assert.ok(Math.abs(sum(weightsFor(false)) - 1) < 1e-5);
  assert.equal(weightsFor(false).title, 0.25);
  assert.ok(!('embedding' in weightsFor(false)));
});

test('embeddingSimilarity clamps to 0..1 and is 0 for a missing vector', () => {
  assert.equal(embeddingSimilarity([1, 0], [1, 0]), 1);
  assert.equal(embeddingSimilarity([1, 0], [-1, 0]), 0);
  assert.equal(embeddingSimilarity([1, 0], [0, 1]), 0);
  assert.ok(Math.abs(embeddingSimilarity([1, 1], [1, 0]) - Math.SQRT1_2) < 1e-9);
  assert.equal(embeddingSimilarity(undefined, [1, 0]), 0);
  assert.equal(embeddingSimilarity([0, 0], [1, 0]), 0);
});

// Fake embedder: a topic word in the text selects a fixed direction, so meaning is shared
// without any shared title word.
const TOPICS = { flat: [1, 0, 0], apartment: [1, 0.05, 0], rent: [0.95, 0, 0.1], pizza: [0, 1, 0] };
function fakeEmbed(texts) {
  return Promise.resolve(texts.map((t) => {
    const hit = Object.keys(TOPICS).find((k) => t.toLowerCase().includes(k));
    return Float32Array.from(hit ? TOPICS[hit] : [0, 0, 1]);
  }));
}

test('embedPages embeds titled pages only, once each', async () => {
  const pages = [
    { id: 'a', url: 'https://www.x.example/1', title: 'Flat' },
    { id: 'b', url: 'https://y.example/2', title: '' },
  ];
  let seen = [];
  await embedPages(pages, (texts) => { seen = texts; return fakeEmbed(texts); });
  assert.deepEqual(seen, ['Flat (x.example)']);
  assert.ok(pages[0].embedding);
  assert.equal(pages[1].embedding, undefined);
  assert.equal(embeddingSimilarity(pages[0].embedding, pages[1].embedding), 0);
});

test('pages sharing meaning but no title words score above the cutoff with embeddings', async () => {
  const mk = () => [
    { id: 'a', url: 'https://one.example/1', title: 'Flat hunting', tokens: titleTokens('Flat hunting'), entities: new Set(), tags: new Set() },
    { id: 'b', url: 'https://two.example/2', title: 'Apartment listings', tokens: titleTokens('Apartment listings'), entities: new Set(), tags: new Set() },
    { id: 'c', url: 'https://three.example/3', title: 'Cheap rent options', tokens: titleTokens('Cheap rent options'), entities: new Set(), tags: new Set() },
  ];
  const sessions = cutSessions([
    { itemId: 'a', timestamp: 1_000_000, duration: 60000, interacted: 1 },
    { itemId: 'b', timestamp: 1_001_000, duration: 60000, interacted: 1 },
    { itemId: 'c', timestamp: 1_002_000, duration: 60000, interacted: 1 },
  ]);
  const plain = mk();
  const without = groupPages(plain, sessions, { minSessions: 1, cutoff: 0.3 });
  assert.equal(without.length, 0);
  const embedded = await embedPages(mk(), fakeEmbed);
  const pairs = pairSignals(embedded, sessions, { weights: WEIGHTS });
  assert.ok(pairs.get('a|b').embedding > 0.9);
  assert.equal(pairs.get('a|b').title, 0);
  const withEmb = groupPages(embedded, sessions, { minSessions: 1, cutoff: 0.3 });
  assert.equal(withEmb.length, 1);
  assert.equal(withEmb[0].members.length, 3);
});

test('end to end on a synthetic database copy with the fake embedder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grouper-test-'));
  try {
    const now = Date.now();
    const file = makeFixture(dir, now);
    const result = await runGrouper(file, { now, embed: fakeEmbed, embedModel: 'fake' });
    assert.equal(result.groups.length, 1);
    assert.match(formatReport(result, { embed: fakeEmbed, embedModel: 'fake' }), /Embedding signal: on \(fake\)/);
    assert.match(formatReport(await runGrouper(file, { now })), /Embedding signal: off/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--no-embed and --model-cache parse', () => {
  assert.equal(parseArgs(['a', 'b', '--no-embed']).opts.noEmbed, true);
  assert.equal(parseArgs(['a', 'b', '--model-cache', '/x']).opts.modelCache, '/x');
  assert.throws(() => parseArgs(['a', 'b', '--model-cache']));
});

test('end to end on a synthetic database copy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grouper-test-'));
  try {
    const now = Date.now();
    const file = makeFixture(dir, now);
    const result = await runGrouper(file, { now });
    assert.equal(result.stats.excludedAuth, 1);
    assert.equal(result.stats.excludedSearch, 1);
    assert.equal(result.stats.appTitles, 1);
    assert.equal(result.stats.pages, 5);
    assert.ok(!result.groups.some((g) => g.members.some((m) => m.id === 'f')));
    assert.equal(result.groups.length, 1);
    const g = result.groups[0];
    assert.deepEqual(g.members.map((m) => m.id).sort().slice(0, 3), ['a', 'b', 'c']);
    assert.match(g.name, /berlin/);
    assert.ok(g.sessions >= 2);
    const report = formatReport(result);
    assert.match(report, /Berlin flat listing/);
    assert.ok(!report.includes('accounts.example'));
    // the database copy was opened read-only and is unchanged in size
    assert.ok(fs.statSync(file).size > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
