/**
 * Unit tests for the pure parts of process→tile→window attribution.
 *
 * Covers parseTileIdFromUrl + joinMetrics (process-metrics.ts) and the
 * config/formatting helpers (cpu-watch.ts). The Electron-side collectors
 * (gatherWebContents / gatherProcessMetrics / probeVisibilityState) need a live
 * runtime and aren't exercised here — they're thin wrappers over Electron APIs.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  parseTileIdFromUrl,
  joinMetrics,
  type ProcMetric,
  type WcDescriptor,
} from './process-metrics.js';
import {
  resolveConfig,
  formatProcessLine,
} from './cpu-watch.js';

function wc(over: Partial<WcDescriptor>): WcDescriptor {
  return {
    webContentsId: 1,
    osProcessId: 100,
    url: 'peek://editor/home.html',
    wcType: 'window',
    tileId: 'editor',
    windowId: 7,
    windowTitle: 'doc',
    visible: true,
    focused: false,
    hybrid: false,
    ...over,
  };
}

function proc(over: Partial<ProcMetric>): ProcMetric {
  return { pid: 100, procType: 'Tab', percentCpu: 0, memoryKb: 0, ...over };
}

describe('parseTileIdFromUrl', () => {
  it('extracts the tile id from a peek:// URL', () => {
    assert.equal(parseTileIdFromUrl('peek://editor/home.html?itemId=abc'), 'editor');
    assert.equal(parseTileIdFromUrl('peek://windows/home.html'), 'windows');
    assert.equal(parseTileIdFromUrl('PEEK://Editor/x'), 'Editor'); // scheme case-insensitive
  });

  it('returns null for non-peek URLs', () => {
    assert.equal(parseTileIdFromUrl('https://example.com/page'), null);
    assert.equal(parseTileIdFromUrl('devtools://devtools/bundled/x.html'), null);
    assert.equal(parseTileIdFromUrl(''), null);
    assert.equal(parseTileIdFromUrl(undefined as unknown as string), null);
  });
});

describe('joinMetrics', () => {
  it('attaches webContents to their owning pid and sorts by CPU desc', () => {
    const metrics = [
      proc({ pid: 100, percentCpu: 3 }),
      proc({ pid: 200, percentCpu: 42, procType: 'Tab' }),
      proc({ pid: 300, percentCpu: 0, procType: 'GPU' }),
    ];
    const wcs = [
      wc({ webContentsId: 1, osProcessId: 100, tileId: 'editor' }),
      wc({ webContentsId: 2, osProcessId: 200, tileId: 'editor', url: 'peek://editor/home.html?itemId=hot' }),
      wc({ webContentsId: 3, osProcessId: 200, tileId: 'editor', url: 'peek://editor/home.html?itemId=hot2' }),
    ];
    const joined = joinMetrics(metrics, wcs);
    assert.equal(joined[0].pid, 200, 'hottest first');
    assert.equal(joined[0].tiles.length, 2, 'two webContents share the hot pid');
    assert.equal(joined[1].pid, 100);
    assert.equal(joined[1].tiles.length, 1);
    assert.equal(joined[2].pid, 300, 'GPU process with no webContents still listed');
    assert.equal(joined[2].tiles.length, 0);
  });

  it('does not mutate the input metrics', () => {
    const metrics = [proc({ pid: 100 })];
    const joined = joinMetrics(metrics, []);
    assert.ok(!('tiles' in metrics[0]));
    assert.deepEqual(joined[0].tiles, []);
  });
});

describe('resolveConfig', () => {
  it('defaults to enabled with sane numbers', () => {
    const cfg = resolveConfig({});
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.intervalMs, 15_000);
    assert.equal(cfg.thresholdPct, 5);
    assert.equal(cfg.heartbeatEvery, 20);
  });

  it('PEEK_CPU_WATCH=0 disables', () => {
    assert.equal(resolveConfig({ PEEK_CPU_WATCH: '0' }).enabled, false);
    assert.equal(resolveConfig({ PEEK_CPU_WATCH: '1' }).enabled, true);
  });

  it('honors numeric overrides and ignores garbage', () => {
    const cfg = resolveConfig({
      PEEK_CPU_WATCH_INTERVAL_MS: '5000',
      PEEK_CPU_WATCH_THRESHOLD: '8.5',
      PEEK_CPU_WATCH_HEARTBEAT: '0',
    });
    assert.equal(cfg.intervalMs, 5000);
    assert.equal(cfg.thresholdPct, 8.5);
    assert.equal(cfg.heartbeatEvery, 0);

    const bad = resolveConfig({ PEEK_CPU_WATCH_INTERVAL_MS: 'nope', PEEK_CPU_WATCH_THRESHOLD: '-3' });
    assert.equal(bad.intervalMs, 15_000, 'non-numeric falls back');
    assert.equal(bad.thresholdPct, 5, 'negative falls back');
  });
});

describe('formatProcessLine', () => {
  it('formats a hot tile process with attribution', () => {
    const line = formatProcessLine({
      ...proc({ pid: 500, percentCpu: 42.07, memoryKb: 210 * 1024, procType: 'Tab' }),
      tiles: [wc({ webContentsId: 9, osProcessId: 500, url: 'peek://editor/home.html?itemId=abc', windowId: 7, windowTitle: 'greek bank', visible: true })],
    });
    assert.match(line, /pid=500 type=Tab cpu=42\.1% mem=210MB/);
    assert.match(line, /tile=editor/);
    assert.match(line, /url=peek:\/\/editor\/home\.html\?itemId=abc/);
    assert.match(line, /win=#7 "greek bank"/);
    assert.match(line, /vis=true/);
  });

  it('includes visibilityState when provided', () => {
    const visState = new Map([[9, 'hidden']]);
    const line = formatProcessLine({
      ...proc({ pid: 500, percentCpu: 30 }),
      tiles: [wc({ webContentsId: 9, osProcessId: 500 })],
    }, visState);
    assert.match(line, /visState=hidden/);
  });

  it('labels a process with no webContents (GPU/utility)', () => {
    const line = formatProcessLine({
      ...proc({ pid: 99, percentCpu: 12, procType: 'GPU', serviceName: 'gpu-process' }),
      tiles: [],
    });
    assert.match(line, /\(gpu-process, no webContents\)/);
  });
});
