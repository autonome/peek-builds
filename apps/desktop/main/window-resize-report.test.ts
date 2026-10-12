/**
 * Unit tests for the settled-resize report a window's opener receives
 * (window-resize-report.ts createResizeReporter).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import type { WindowId } from './window-kernel.js';
import { createResizeReporter, type ResizeReport, type ResizeReportRecord } from './window-resize-report.js';

const W = (s: string): WindowId => s as WindowId;
const NORMAL = { name: 'normal' };

function harness(openers: Record<string, { source: string; key?: unknown }>) {
  const sent: ResizeReport[] = [];
  const timers = new Map<number, () => void>();
  let next = 1;
  const reporter = createResizeReporter({
    delayMs: 300,
    lookupOpener: (id) => openers[id],
    send: (r) => sent.push(r),
    setTimer: (fn) => { const h = next++; timers.set(h, fn); return h; },
    clearTimer: (h) => { timers.delete(h as number); },
  });
  const flush = () => { const fns = [...timers.values()]; timers.clear(); fns.forEach((f) => f()); };
  return { reporter, sent, timers, flush };
}

const rec = (id: string, width: number, height: number, extra: Partial<ResizeReportRecord> = {}): ResizeReportRecord => ({
  id: W(id), bounds: { width, height }, maximized: false, fsMode: NORMAL, ...extra,
});

describe('createResizeReporter', () => {
  it('reports the settled size of a keyed window to its opener, once per gesture', () => {
    const h = harness({ a: { source: 'peek://slides/background', key: 'https://x:Left' } });
    h.reporter.observe([rec('a', 800, 600)]);
    h.reporter.observe([rec('a', 820, 600)]);
    h.reporter.observe([rec('a', 900, 650)]);
    assert.strictEqual(h.timers.size, 1, 'one pending report per window');
    h.flush();
    assert.deepStrictEqual(h.sent, [
      { id: W('a'), source: 'peek://slides/background', key: 'https://x:Left', width: 900, height: 650 },
    ]);
  });

  it('does not report the size a window was opened at', () => {
    const h = harness({ a: { source: 's', key: 'k' } });
    h.reporter.observe([{ id: W('a'), maximized: false, fsMode: NORMAL }]);
    h.reporter.observe([rec('a', 800, 600)]);
    h.flush();
    assert.deepStrictEqual(h.sent, []);
  });

  it('does not report a move', () => {
    const h = harness({ a: { source: 's', key: 'k' } });
    h.reporter.observe([rec('a', 800, 600)]);
    h.reporter.observe([rec('a', 800, 600)]);
    h.flush();
    assert.deepStrictEqual(h.sent, []);
  });

  it('does not report a maximized or fullscreen size', () => {
    const h = harness({ a: { source: 's', key: 'k' }, b: { source: 's', key: 'k2' } });
    h.reporter.observe([rec('a', 800, 600), rec('b', 800, 600)]);
    h.reporter.observe([
      rec('a', 1920, 1080, { maximized: true }),
      rec('b', 1920, 1080, { fsMode: { name: 'fullscreen' } }),
    ]);
    h.flush();
    assert.deepStrictEqual(h.sent, []);
  });

  it('does not report a window opened without a key', () => {
    const h = harness({ a: { source: 's' } });
    h.reporter.observe([rec('a', 800, 600)]);
    h.reporter.observe([rec('a', 900, 600)]);
    h.flush();
    assert.deepStrictEqual(h.sent, []);
  });

  it('drops a pending report when the window goes away', () => {
    const h = harness({ a: { source: 's', key: 'k' } });
    h.reporter.observe([rec('a', 800, 600)]);
    h.reporter.observe([rec('a', 900, 600)]);
    h.reporter.observe([]);
    assert.strictEqual(h.timers.size, 0);
    h.flush();
    assert.deepStrictEqual(h.sent, []);
  });
});
