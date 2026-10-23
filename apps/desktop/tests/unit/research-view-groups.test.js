/**
 * The research view's grouping and the order within each group.
 *
 * `features/research/groups.js` is pure, so what a research's three groups hold
 * and the order their rows come out in is decided here rather than through a
 * window.
 *
 *   NODE_ENV=test node --test apps/desktop/tests/unit/research-view-groups.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  groupSpaceItems,
  orderSearchRounds,
  orderNotesNewestFirst,
  formatRunCount,
  SEARCH_ROUND_TAG,
  SEARCH_RUN_KIND,
} from '../../features/research/groups.js';

/** An item event the way `search-rounds.js recordSearchRound` writes one. */
const runEvent = (itemId, occurredAt, kind = SEARCH_RUN_KIND) => ({
  itemId,
  occurredAt,
  metadata: JSON.stringify({ kind, engineId: 'ddg', url: 'https://example.test/?q=x' }),
});

describe('groupSpaceItems', () => {
  test('splits a research into pages, searches and notes', () => {
    const items = [
      { id: 'p1', type: 'url', content: 'https://example.test/a' },
      { id: 's1', type: 'text', content: 'otter diet' },
      { id: 'n1', type: 'text', content: 'they use rocks' },
    ];
    const itemTags = new Map([
      ['p1', ['space:otters']],
      ['s1', ['space:otters', SEARCH_ROUND_TAG]],
      ['n1', ['space:otters']],
    ]);

    const { pages, searches, notes } = groupSpaceItems(items, itemTags);
    assert.deepEqual(pages.map((i) => i.id), ['p1']);
    assert.deepEqual(searches.map((i) => i.id), ['s1']);
    assert.deepEqual(notes.map((i) => i.id), ['n1']);
  });

  test('reads the tag names from a plain object as well as a Map', () => {
    const items = [{ id: 's1', type: 'text', content: 'otter diet' }];
    const { searches, notes } = groupSpaceItems(items, { s1: ['space:otters', SEARCH_ROUND_TAG] });
    assert.deepEqual(searches.map((i) => i.id), ['s1']);
    assert.deepEqual(notes, []);
  });

  test('a text item with no tags known is a note, not a search', () => {
    const { searches, notes } = groupSpaceItems([{ id: 'n1', type: 'text' }], undefined);
    assert.deepEqual(searches, []);
    assert.deepEqual(notes.map((i) => i.id), ['n1']);
  });

  test('leaves out what belongs to none of the three groups', () => {
    const items = [
      { id: 'i1', type: 'image', content: 'otter.png' },
      { id: 'p1', type: 'url', content: 'https://example.test/a' },
    ];
    const { pages, searches, notes } = groupSpaceItems(items, new Map());
    assert.deepEqual(pages.map((i) => i.id), ['p1']);
    assert.deepEqual(searches, []);
    assert.deepEqual(notes, []);
  });

  test('keeps the order the items arrived in within each group', () => {
    const items = [
      { id: 'p2', type: 'url' },
      { id: 'p1', type: 'url' },
      { id: 'p3', type: 'url' },
    ];
    assert.deepEqual(groupSpaceItems(items, new Map()).pages.map((i) => i.id), ['p2', 'p1', 'p3']);
  });

  test('answers three empty groups for nothing at all', () => {
    assert.deepEqual(groupSpaceItems(null, null), { pages: [], searches: [], notes: [] });
    assert.deepEqual(groupSpaceItems([null, { type: 'url' }], null).pages, []);
  });
});

describe('orderSearchRounds', () => {
  test('orders by when a search was first run, not by when its item was written', () => {
    const rounds = [
      { id: 'later', type: 'text', content: 'otter habitat', createdAt: 1000 },
      { id: 'earlier', type: 'text', content: 'otter diet', createdAt: 9000 },
    ];
    const events = [runEvent('later', 5000), runEvent('earlier', 2000)];

    assert.deepEqual(
      orderSearchRounds(rounds, events).map((r) => r.item.id),
      ['earlier', 'later'],
    );
  });

  test('the first run of a search run several times is the one that places it', () => {
    const rounds = [
      { id: 'a', createdAt: 1 },
      { id: 'b', createdAt: 2 },
    ];
    const events = [runEvent('a', 8000), runEvent('a', 3000), runEvent('b', 5000)];

    assert.deepEqual(orderSearchRounds(rounds, events).map((r) => r.item.id), ['a', 'b']);
  });

  test('counts every run of a search', () => {
    const rounds = [{ id: 'a', createdAt: 1 }];
    const events = [runEvent('a', 1000), runEvent('a', 2000), runEvent('a', 3000)];

    const [only] = orderSearchRounds(rounds, events);
    assert.equal(only.runCount, 3);
    assert.equal(only.firstRunAt, 1000);
  });

  test('ignores events of another kind and events on another item', () => {
    const rounds = [{ id: 'a', createdAt: 100 }];
    const events = [
      runEvent('a', 1000),
      runEvent('a', 2000, 'note-written'),
      runEvent('other', 500),
    ];

    const [only] = orderSearchRounds(rounds, events);
    assert.equal(only.runCount, 1);
    assert.equal(only.firstRunAt, 1000);
  });

  test('reads metadata that is already an object', () => {
    const rounds = [{ id: 'a', createdAt: 100 }];
    const events = [{ itemId: 'a', occurredAt: 1000, metadata: { kind: SEARCH_RUN_KIND } }];

    assert.equal(orderSearchRounds(rounds, events)[0].runCount, 1);
  });

  test('a round with no run events falls back to when its item was created', () => {
    const rounds = [
      { id: 'ran', createdAt: 9000 },
      { id: 'unrun', createdAt: 1000 },
    ];
    const events = [runEvent('ran', 5000)];

    const ordered = orderSearchRounds(rounds, events);
    assert.deepEqual(ordered.map((r) => r.item.id), ['unrun', 'ran']);
    assert.equal(ordered[0].runCount, 0);
  });

  test('a round with neither a run nor a creation time sorts last', () => {
    const rounds = [{ id: 'nowhere' }, { id: 'ran', createdAt: 5000 }];
    assert.deepEqual(
      orderSearchRounds(rounds, [runEvent('ran', 7000)]).map((r) => r.item.id),
      ['ran', 'nowhere'],
    );
  });

  test('rounds that tie keep the order they arrived in', () => {
    const rounds = [{ id: 'a', createdAt: 5 }, { id: 'b', createdAt: 5 }];
    const events = [runEvent('a', 100), runEvent('b', 100)];
    assert.deepEqual(orderSearchRounds(rounds, events).map((r) => r.item.id), ['a', 'b']);
  });

  test('answers an empty list for nothing at all', () => {
    assert.deepEqual(orderSearchRounds(null, null), []);
    assert.deepEqual(orderSearchRounds([{ noId: true }], []), []);
  });

  test('does not mutate what it was given', () => {
    const rounds = [{ id: 'b', createdAt: 20 }, { id: 'a', createdAt: 10 }];
    orderSearchRounds(rounds, []);
    assert.deepEqual(rounds.map((r) => r.id), ['b', 'a']);
  });
});

describe('orderNotesNewestFirst', () => {
  test('newest first', () => {
    const notes = [
      { id: 'old', createdAt: 100 },
      { id: 'new', createdAt: 900 },
      { id: 'middle', createdAt: 500 },
    ];
    assert.deepEqual(orderNotesNewestFirst(notes).map((n) => n.id), ['new', 'middle', 'old']);
  });

  test('a note with no creation time sorts last', () => {
    const notes = [{ id: 'undated' }, { id: 'dated', createdAt: 100 }];
    assert.deepEqual(orderNotesNewestFirst(notes).map((n) => n.id), ['dated', 'undated']);
  });

  test('notes that tie keep the order they arrived in', () => {
    const notes = [{ id: 'a', createdAt: 5 }, { id: 'b', createdAt: 5 }];
    assert.deepEqual(orderNotesNewestFirst(notes).map((n) => n.id), ['a', 'b']);
  });

  test('answers an empty list for nothing at all', () => {
    assert.deepEqual(orderNotesNewestFirst(null), []);
    assert.deepEqual(orderNotesNewestFirst([null, { noId: true }]), []);
  });

  test('does not mutate what it was given', () => {
    const notes = [{ id: 'old', createdAt: 1 }, { id: 'new', createdAt: 9 }];
    orderNotesNewestFirst(notes);
    assert.deepEqual(notes.map((n) => n.id), ['old', 'new']);
  });
});

describe('formatRunCount', () => {
  test('one run reads as one', () => {
    assert.equal(formatRunCount(1), '1 run');
  });

  test('several runs read as several', () => {
    assert.equal(formatRunCount(4), '4 runs');
  });

  test('no recorded run says so rather than showing a zero', () => {
    assert.equal(formatRunCount(0), 'no runs recorded');
    assert.equal(formatRunCount(undefined), 'no runs recorded');
    assert.equal(formatRunCount(-1), 'no runs recorded');
  });
});
