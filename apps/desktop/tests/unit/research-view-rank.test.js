/**
 * The research view's order: summed time on page first, visit count as the
 * tie-break. `features/research/rank.js` is pure, so these run in node with no
 * app and no datastore.
 *
 *   NODE_ENV=test node --test apps/desktop/tests/unit/research-view-rank.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { rankPagesByTimeOnPage, formatTimeOnPage } from '../../features/research/rank.js';

const page = (id) => ({ id, type: 'url', content: `https://example.com/${id}` });
const visit = (itemId, duration) => ({ itemId, duration });

const idsOf = (ranked) => ranked.map((row) => row.item.id);

describe('rankPagesByTimeOnPage', () => {
  it('orders pages by their summed visit duration, longest first', () => {
    const items = [page('a'), page('b'), page('c')];
    const visits = [
      visit('a', 1_000),
      visit('b', 5_000),
      visit('c', 3_000),
    ];

    assert.deepEqual(idsOf(rankPagesByTimeOnPage(items, visits)), ['b', 'c', 'a']);
  });

  it('sums every visit of a page, so many short visits can outrank one long one', () => {
    const items = [page('long'), page('many')];
    const visits = [
      visit('long', 9_000),
      visit('many', 4_000),
      visit('many', 4_000),
      visit('many', 4_000),
    ];

    const ranked = rankPagesByTimeOnPage(items, visits);
    assert.deepEqual(idsOf(ranked), ['many', 'long']);
    assert.equal(ranked[0].totalMs, 12_000);
    assert.equal(ranked[1].totalMs, 9_000);
  });

  it('breaks a tie on total time by visit count, most visits first', () => {
    const items = [page('once'), page('thrice')];
    const visits = [
      visit('once', 6_000),
      visit('thrice', 2_000),
      visit('thrice', 2_000),
      visit('thrice', 2_000),
    ];

    const ranked = rankPagesByTimeOnPage(items, visits);
    assert.deepEqual(idsOf(ranked), ['thrice', 'once']);
    assert.equal(ranked[0].totalMs, ranked[1].totalMs);
    assert.equal(ranked[0].visitCount, 3);
    assert.equal(ranked[1].visitCount, 1);
  });

  it('leaves pages that tie on both keys in the order they arrived', () => {
    const items = [page('first'), page('second')];
    const visits = [visit('first', 2_000), visit('second', 2_000)];

    assert.deepEqual(idsOf(rankPagesByTimeOnPage(items, visits)), ['first', 'second']);
  });

  it('keeps a page with no visits, ranked last with zero time', () => {
    const items = [page('unvisited'), page('visited')];
    const visits = [visit('visited', 1_000)];

    const ranked = rankPagesByTimeOnPage(items, visits);
    assert.deepEqual(idsOf(ranked), ['visited', 'unvisited']);
    assert.equal(ranked[1].totalMs, 0);
    assert.equal(ranked[1].visitCount, 0);
  });

  it('counts a visit whose duration was never written as a visit of no time', () => {
    const items = [page('open-visit')];
    const visits = [visit('open-visit', 0), { itemId: 'open-visit' }];

    const ranked = rankPagesByTimeOnPage(items, visits);
    assert.equal(ranked[0].totalMs, 0);
    assert.equal(ranked[0].visitCount, 2);
  });

  it('ignores visits belonging to pages outside the research', () => {
    const items = [page('inside')];
    const visits = [visit('inside', 1_000), visit('outside', 99_000)];

    const ranked = rankPagesByTimeOnPage(items, visits);
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].totalMs, 1_000);
  });

  it('answers an empty list for no pages, whatever the visits say', () => {
    assert.deepEqual(rankPagesByTimeOnPage([], [visit('a', 1_000)]), []);
    assert.deepEqual(rankPagesByTimeOnPage(null, null), []);
  });

  it('does not reorder its input array', () => {
    const items = [page('a'), page('b')];
    rankPagesByTimeOnPage(items, [visit('b', 5_000)]);
    assert.deepEqual(items.map((i) => i.id), ['a', 'b']);
  });
});

describe('formatTimeOnPage', () => {
  it('shows seconds under a minute', () => {
    assert.equal(formatTimeOnPage(38_000), '38s');
  });

  it('rounds a sub-second visit up to a second rather than hiding it', () => {
    assert.equal(formatTimeOnPage(400), '1s');
  });

  it('shows minutes and seconds under an hour', () => {
    assert.equal(formatTimeOnPage(252_000), '4m 12s');
    assert.equal(formatTimeOnPage(180_000), '3m');
  });

  it('shows hours and minutes above an hour', () => {
    assert.equal(formatTimeOnPage(4_020_000), '1h 7m');
    assert.equal(formatTimeOnPage(7_200_000), '2h');
  });

  it('shows a dash for no recorded time', () => {
    assert.equal(formatTimeOnPage(0), '—');
    assert.equal(formatTimeOnPage(undefined), '—');
  });
});
