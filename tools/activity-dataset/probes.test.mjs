import assert from 'node:assert/strict';
import test from 'node:test';
import { PROBES, analyze } from './core/index.js';
import { BASE, DAY, buildRows } from './fixture.mjs';

const { tables, results } = analyze(buildRows());
const byName = Object.fromEntries(results.map((r) => [r.name, r]));
const topicOf = (pageId) => pageId.split('-')[0];

test('every probe runs and reports its name', () => {
  assert.equal(results.length, PROBES.length);
  assert.equal(new Set(results.map((r) => r.name)).size, 9);
});

test('entity-groups does not merge the topics through the hub entity, and has purity 1.0', () => {
  const r = byName['entity-groups'];
  assert.equal(r.summary.hubsDropped, 1);
  assert.equal(r.score.purity, 1);
  assert.equal(r.score.groups, 20);
  assert.equal(r.score.coverage, 1);
  for (const g of r.rows) assert.equal(new Set(g.pageIds.map(topicOf)).size, 1);
  assert.ok(r.rows.every((g) => g.name && !/https?|example|test/.test(g.name)));
});

test('text-similarity neighbours stay within a topic', () => {
  const r = byName['text-similarity'];
  assert.ok(r.rows.length > 0);
  for (const row of r.rows) {
    assert.ok(row.neighbours.length <= 5);
    for (const nb of row.neighbours) {
      assert.ok(nb.similarity > 0.2);
      assert.equal(topicOf(nb.id), topicOf(row.pageId));
    }
  }
  assert.equal(r.score.precisionAt5, 1);
});

test('bursts measure from the latest sighting, not the wall clock', () => {
  const r = byName.bursts;
  assert.equal(r.summary.now, new Date(BASE + 59 * DAY).toISOString());
  const names = r.rows.map((x) => x.name);
  assert.ok(names.includes('Levain Starter'));
  assert.ok(!names.includes('Alfama District'));
});

test('session-groups is skipped with no visits', () => {
  assert.equal(byName['session-groups'].summary.skipped, 'no visits');
  assert.equal(byName['session-groups'].rows.length, 0);
});

test('session-groups and combined-groups use sessions when visits exist', () => {
  const withVisits = analyze(buildRows({ withVisits: true })).results;
  const s = withVisits.find((r) => r.name === 'session-groups');
  assert.equal(s.summary.skipped, undefined);
  assert.ok(s.score.groups > 0);
  assert.equal(withVisits.find((r) => r.name === 'combined-groups').summary.sources, 3);
});

test('combined-groups keeps topics apart', () => {
  const r = byName['combined-groups'];
  assert.equal(r.summary.sources, 2);
  assert.equal(r.score.purity, 1);
});

test('notes-to-pages links a note naming a place to that place pages', () => {
  const r = byName['notes-to-pages'];
  assert.equal(r.summary.notes, 2);
  assert.equal(r.summary.notesLinked, 1);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].entityName, 'Belem Tower');
  assert.deepEqual(r.rows[0].pageIds.sort(), ['a-page-3', 'a-page-4', 'a-page-5']);
});

test('interests counts days and weeks; the hub is durable', () => {
  const rows = byName.interests.rows;
  const hub = rows.find((x) => x.name === 'Inbox Central');
  assert.equal(hub.days, 60);
  assert.ok(hub.durable);
  assert.equal(hub.first, '2020-01-01');
  assert.ok(!rows.find((x) => x.name === 'Dutch Oven').durable);
});

test('forgotten-saves finds low-visit pages that were shared or highlighted', () => {
  const r = byName['forgotten-saves'];
  assert.equal(r.rows.length, 4);
  assert.deepEqual(new Set(r.rows.map((x) => x.pageId)), new Set(['a-page-0', 'a-page-1', 'b-page-0', 'b-page-1']));
});

test('habits ranks hosts with www stripped', () => {
  const rows = byName.habits.rows;
  assert.deepEqual(rows.map((x) => x.host).sort(), ['baking.example.test', 'travel.example.test']);
  assert.equal(rows[0].pages, 30);
});

test('tables carry the fixture sizes', () => {
  assert.equal(tables.pages.length, 60);
  assert.equal(tables.entities.length, 21);
});
