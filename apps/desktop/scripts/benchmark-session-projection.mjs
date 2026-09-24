#!/usr/bin/env node
/**
 * Deterministic in-process benchmark for the pure session data path.
 *
 * Build first so this imports the exact compiled production implementation:
 *   yarn workspace @peek/desktop build
 *   node apps/desktop/scripts/benchmark-session-projection.mjs
 *
 * This does not create Electron/native windows. "restorePlan" measures only
 * JSON parse plus the production saved-stack planning helpers.
 */
import os from 'node:os';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import {
  serializeSession,
  readStackIndex,
  orderRestoredWindowsBottomToTop,
} from '../dist/main/session-projection.js';

const counts = (process.env.SESSION_BENCH_COUNTS || '10,100,1000,10000,50000')
  .split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
const repeats = Number(process.env.SESSION_BENCH_REPEATS || 30);
const warmups = Number(process.env.SESSION_BENCH_WARMUPS || 5);

function fixture(n) {
  const records = new Array(n);
  const windows = new Array(n);
  const presentations = new Map();
  const contexts = new Map();
  const order = new Array(n);
  for (let i = 0; i < n; i++) {
    const id = `wm-${i}`;
    order[i] = id;
    records[i] = {
      id, kind: 'browser', role: 'content', class: 'primary', layer: 0,
      canBecomeKey: true, acceptsInput: true, visible: true, orderable: true,
      fsMode: { name: 'normal' }, maximized: i % 10 === 0,
      preMaxBounds: i % 10 === 0 ? { x: i % 1200, y: i % 700, width: 900, height: 650 } : null,
      pendingProjectedBounds: null, openSeq: i, priorKey: null,
      bounds: { x: i % 1200, y: i % 700, width: 1000, height: 700 },
    };
    windows[i] = {
      nativeId: i + 1, machineId: id, source: 'peek://app', destroyed: false,
      url: `https://example.test/page/${i}`,
      params: { role: 'content', key: `page-${i}`, keepLive: false, tags: ['bench', `bucket-${i % 8}`] },
    };
    presentations.set(i + 1, {
      address: `https://example.test/page/${i}`, title: `Synthetic window ${i}`,
      bounds: records[i].bounds,
    });
    contexts.set(i + 1, {
      mode: 'space', modeMetadata: { spaceId: 'bench-space', spaceName: 'Benchmark' }, pinScope: null,
    });
  }
  return {
    input: {
      snapshot: { order: records }, windows,
      getPresentation: (id) => presentations.get(id) ?? null,
      getContext: (id) => contexts.get(id), registeredTileIds: [],
      reason: 'manual', createdAt: 1700000000000, kernelOrder: order,
      topmostContentWindowId: order[n - 1], workspaceKey: 'default',
    },
  };
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}
function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { mean_ms: +mean.toFixed(3), median_ms: +percentile(sorted, .5).toFixed(3), p95_ms: +percentile(sorted, .95).toFixed(3), min_ms: +sorted[0].toFixed(3), max_ms: +sorted.at(-1).toFixed(3) };
}
function timed(fn) {
  const start = performance.now();
  const result = fn();
  return [performance.now() - start, result];
}

console.log(JSON.stringify({
  benchmark: 'session-projection-v1', node: process.version, electron: process.versions.electron ?? null,
  platform: `${process.platform}/${process.arch}`, os: `${os.type()} ${os.release()}`,
  cpu: os.cpus()[0]?.model, logical_cpus: os.cpus().length,
  memory_bytes: os.totalmem(), repeats, warmups, counts,
}));

for (const n of counts) {
  const { input } = fixture(n);
  for (let i = 0; i < warmups; i++) {
    const projection = serializeSession(input);
    const text = JSON.stringify(projection.snapshot);
    const parsed = JSON.parse(text);
    orderRestoredWindowsBottomToTop(parsed.windows.map((d, j) => ({ id: j + 1, stackIndex: readStackIndex(d) })));
  }
  const project = [], stringify = [], restorePlan = [];
  let bytes = 0;
  for (let i = 0; i < repeats; i++) {
    let projection, text;
    let ms;
    [ms, projection] = timed(() => serializeSession(input));
    project.push(ms);
    [ms, text] = timed(() => JSON.stringify(projection.snapshot));
    stringify.push(ms);
    bytes = Buffer.byteLength(text);
    [ms] = timed(() => {
      const parsed = JSON.parse(text);
      const entries = parsed.windows.map((d, j) => ({ id: j + 1, stackIndex: readStackIndex(d) }));
      return orderRestoredWindowsBottomToTop(entries);
    });
    restorePlan.push(ms);
  }
  console.log(JSON.stringify({ windows: n, snapshot_bytes: bytes, project: summary(project), stringify: summary(stringify), restorePlan: summary(restorePlan) }));
}
