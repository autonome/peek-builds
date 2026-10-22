/**
 * The dwell bookkeeping behind `item_visits.duration`: only time in front of
 * the user is counted, the clock is the test's to choose, and a window with no
 * open visit is ignored.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { createVisitDwell } from './visit-dwell.js';

describe('createVisitDwell', () => {
  it('counts a span that was in front and then left', () => {
    const dwell = createVisitDwell();
    dwell.visitStarted('w1', 'v1', 1000);
    dwell.inFront('w1', 1000);
    dwell.notInFront('w1', 3500);
    assert.deepStrictEqual(dwell.visitEnded('w1', 9000), { visitId: 'v1', durationMs: 2500 });
  });

  it('counts nothing for a visit that was never in front', () => {
    const dwell = createVisitDwell();
    dwell.visitStarted('w1', 'v1', 1000);
    assert.deepStrictEqual(dwell.visitEnded('w1', 60_000), { visitId: 'v1', durationMs: 0 });
  });

  it('sums the spans when the page comes back in front', () => {
    const dwell = createVisitDwell();
    dwell.visitStarted('w1', 'v1', 0);
    dwell.inFront('w1', 100);
    dwell.notInFront('w1', 400);
    dwell.inFront('w1', 1000);
    dwell.notInFront('w1', 1700);
    assert.deepStrictEqual(dwell.visitEnded('w1', 5000), { visitId: 'v1', durationMs: 1000 });
  });

  it('counts up to the end when the visit ends while in front', () => {
    const dwell = createVisitDwell();
    dwell.visitStarted('w1', 'v1', 0);
    dwell.inFront('w1', 0);
    assert.deepStrictEqual(dwell.visitEnded('w1', 1234), { visitId: 'v1', durationMs: 1234 });
  });

  it('ends the open visit when a new one starts, and keeps counting the new one while still in front', () => {
    const dwell = createVisitDwell();
    dwell.visitStarted('w1', 'v1', 0);
    dwell.inFront('w1', 0);
    assert.deepStrictEqual(dwell.visitStarted('w1', 'v2', 500), { visitId: 'v1', durationMs: 500 });
    assert.deepStrictEqual(dwell.visitEnded('w1', 900), { visitId: 'v2', durationMs: 400 });
  });

  it('starts a replacement visit at zero and leaves it uncounted while the page is not in front', () => {
    const dwell = createVisitDwell();
    dwell.visitStarted('w1', 'v1', 0);
    dwell.inFront('w1', 0);
    dwell.notInFront('w1', 300);
    assert.deepStrictEqual(dwell.visitStarted('w1', 'v2', 400), { visitId: 'v1', durationMs: 300 });
    assert.deepStrictEqual(dwell.visitEnded('w1', 5000), { visitId: 'v2', durationMs: 0 });
  });

  it('ignores every event for a window with no open visit', () => {
    const dwell = createVisitDwell();
    dwell.inFront('ghost', 0);
    dwell.notInFront('ghost', 100);
    assert.strictEqual(dwell.visitEnded('ghost', 200), null);
    assert.deepStrictEqual(dwell.openWindows(), []);
  });

  it('keeps each window on its own clock', () => {
    const dwell = createVisitDwell();
    dwell.visitStarted('w1', 'v1', 0);
    dwell.visitStarted('w2', 'v2', 0);
    dwell.inFront('w1', 0);
    dwell.notInFront('w1', 1000);
    dwell.inFront('w2', 1000);
    assert.deepStrictEqual(dwell.openWindows(), ['w1', 'w2']);
    assert.deepStrictEqual(dwell.visitEnded('w1', 1500), { visitId: 'v1', durationMs: 1000 });
    assert.deepStrictEqual(dwell.visitEnded('w2', 1500), { visitId: 'v2', durationMs: 500 });
    assert.deepStrictEqual(dwell.openWindows(), []);
  });

  it('ignores a repeated in-front report rather than restarting the span', () => {
    const dwell = createVisitDwell();
    dwell.visitStarted('w1', 'v1', 0);
    dwell.inFront('w1', 0);
    dwell.inFront('w1', 800);
    assert.deepStrictEqual(dwell.visitEnded('w1', 1000), { visitId: 'v1', durationMs: 1000 });
  });

  it('ignores a not-in-front report for a page that was already behind', () => {
    const dwell = createVisitDwell();
    dwell.visitStarted('w1', 'v1', 0);
    dwell.inFront('w1', 0);
    dwell.notInFront('w1', 200);
    dwell.notInFront('w1', 900);
    assert.deepStrictEqual(dwell.visitEnded('w1', 1000), { visitId: 'v1', durationMs: 200 });
  });

  it('never counts a negative span when reports arrive out of order', () => {
    const dwell = createVisitDwell();
    dwell.visitStarted('w1', 'v1', 1000);
    dwell.inFront('w1', 1000);
    assert.deepStrictEqual(dwell.visitEnded('w1', 900), { visitId: 'v1', durationMs: 0 });
  });
});
