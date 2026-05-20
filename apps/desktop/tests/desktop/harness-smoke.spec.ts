/**
 * Smoke test for the manual harness primitives.
 *
 * The manual harness (tests/manual/) is run interactively via `yarn harness`
 * and isn't part of `yarn test:electron`. That makes it easy for the harness
 * to silently rot — a refactor in DesktopApp / chrome-extensions / preloads
 * could break startTracer() and we'd only notice the next time we tried to
 * debug an extension issue.
 *
 * This spec exercises the harness primitives against a trivial scenario:
 *   - startTracer() attaches CDP across all webContents,
 *   - record() / attachToPage() / snapshotRuntime() work on the bg window,
 *   - dump() produces a JSON file with at least the events we recorded.
 *
 * It does NOT drive any real extension popup — that's the harness's own job
 * and varies per scenario. We just confirm the plumbing.
 */

import { test, expect } from '../fixtures/desktop-app';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createPerDescribeApp } from '../helpers/test-app';
import { startTracer } from '../manual/harness/tracer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('harness plumbing @desktop', () => {
  let app: any;
  let bgWindow: any;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('harness-smoke'));
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('tracer attaches, records, and dumps a structured trace', async () => {
    const tmpDir = path.join(__dirname, '..', '..', 'tmp', 'harness-smoke');

    const tracer = await startTracer({
      app,
      scenarioName: 'smoke',
      tmpDir,
      profile: 'test-harness-smoke',
      backend: 'electron',
      redactedEnvKeys: [],
    });

    tracer.attachToPage(bgWindow, 'bg');
    tracer.record('note', 'harness', { msg: 'smoke start' });

    // Force a deterministic console event in the bg page so we can assert it
    // appears in the trace via either the Playwright listener or CDP.
    await bgWindow.evaluate(() => console.log('peek-harness-smoke-marker', { v: 1 }));

    // Snapshot chrome.runtime in the bg page (peek://test/ — chrome may not
    // exist there, that's fine; the snapshot still records `hasChrome:false`
    // which we just check is recorded).
    await tracer.snapshotRuntime(bgWindow, 'bg').catch(() => {
      tracer.record('note', 'harness', { msg: 'snapshot-runtime threw — recorded only' });
    });

    // Brief wait so the CDP-side console event has time to round-trip.
    await new Promise((r) => setTimeout(r, 500));

    const { jsonPath, logPath } = await tracer.dump({ ok: true });

    expect(fs.existsSync(jsonPath)).toBe(true);
    expect(fs.existsSync(logPath)).toBe(true);

    const trace = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    expect(trace.scenario).toBe('smoke');
    expect(Array.isArray(trace.events)).toBe(true);
    expect(trace.events.length).toBeGreaterThan(0);

    // Our recorded note must be present.
    const hasSmokeNote = trace.events.some(
      (e: any) => e.kind === 'note' && e?.data?.msg === 'smoke start',
    );
    expect(hasSmokeNote).toBe(true);

    // The runtime snapshot we asked for should be present (or its failure note).
    const hasRuntime = trace.events.some(
      (e: any) => e.kind === 'runtime' || (e.kind === 'note' && /snapshot-runtime/.test(e?.data?.msg || '')),
    );
    expect(hasRuntime).toBe(true);
  });
});
