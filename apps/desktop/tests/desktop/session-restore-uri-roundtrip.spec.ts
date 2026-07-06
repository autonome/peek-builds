/**
 * Session restore — nested-encoded / long URL survives byte-for-byte
 *
 * Locks issue #2 (the "URI Too Long" restore report): a page URL that carries
 * heavy nested percent-encoding AND is long must round-trip through
 * save → persist → restore WITHOUT being re-encoded, decoded a layer, or
 * truncated. The decision there was a deliberate RAW pass-through (no code),
 * and this test is the regression guard that keeps it raw.
 *
 * Why snapshot→restore→snapshot (live-to-live) rather than asserting against
 * the string we opened: the snapshot descriptor URL is `presentation.address`,
 * i.e. the LIVE content-URL of the loaded window (session.ts saveSessionSnapshot).
 * Whatever normalization Chromium applied when the page first loaded is already
 * baked into `savedUrl`; a correct restore must reproduce exactly THAT string.
 * Comparing the saved live-URL to the post-restore live-URL isolates the
 * save/persist/restore path from any browser navigation normalization, so a
 * re-encoding or truncation bug in restore is the only thing that can break it.
 *
 * Run with:
 *   yarn test:grep "Session Restore URI Round-Trip"
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import http from 'http';

let app: DesktopApp;
let bgWindow: Page;
let server: http.Server;
let serverPort: number;

// Distinctive, greppable path segment + an end marker at the very tail of the
// query. The tail proves the URL was persisted AND re-navigated at full length
// (a truncation would drop it), and the path segment is how getWindow / the
// snapshot filter below identify our one window.
const SLUG = 'uri-roundtrip';
const TAIL = 'ZZZEND';

// A value that is DOUBLE percent-encoded (%253A = encoded %3A, %252F = encoded
// %2F, %2526 = encoded %26, %253D = encoded %3D). Chromium preserves
// percent-encoded octets in a query string verbatim, so these survive to the
// live URL — and any code that wrongly decodes or re-encodes a layer on restore
// corrupts them detectably.
const NESTED =
  'https%3A%2F%2Fexample.com%2Fpath%3Fq%3Dhttps%253A%252F%252Fnested.example%252Fdeep%253Fx%253D1%2526y%253D2';
// Push it well past any 2KB URL threshold so the "URI Too Long" length concern
// is genuinely exercised, not just the encoding.
const PAD = 'p'.repeat(2600);

test.describe('Session Restore URI Round-Trip @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('session-restore-uri'));

    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          `<!DOCTYPE html><html><head><title>${SLUG}</title></head>` +
            `<body><h1>ok</h1></body></html>`,
        );
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        serverPort = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  test.afterAll(async () => {
    if (server) server.close();
    if (app) await app.close();
  });

  /** The persisted snapshot descriptor URL for our one window, or '' if absent. */
  async function snapshotUrlForSlug(): Promise<string> {
    const snap = (await app.evaluateMain!((() =>
      (globalThis as any).__peek_test.getLastSnapshot()) as never)) as
      { windows?: Array<{ url?: string }> } | null;
    const d = (snap?.windows || []).find(
      (w) => typeof w.url === 'string' && w.url.includes(SLUG),
    );
    return d?.url ?? '';
  }

  test('a nested-encoded, long page URL survives save→restore byte-for-byte', async () => {
    const url = `http://127.0.0.1:${serverPort}/${SLUG}?next=${NESTED}&pad=${PAD}&end=${TAIL}`;

    // Clean baseline: close every listed window so the snapshot contains
    // exactly our test window (a stray first-run window would still be
    // filtered out by the SLUG match, but restoring it back is noise).
    await bgWindow.evaluate(async () => {
      const r = await (window as any).app.window.list({ includeInternal: false });
      if (!r?.success) return;
      for (const w of r.windows || []) {
        await (window as any).app.window.close(w.id);
      }
    });
    await bgWindow.waitForFunction(async () => {
      const r = await (window as any).app.window.list({ includeInternal: false });
      return r?.success ? (r.windows || []).length === 0 : false;
    });

    // Open the window and wait for the page to load so the snapshot carries the
    // real, committed content URL.
    const opened = await bgWindow.evaluate(async (u: string) => {
      return await (window as any).app.window.open(u, { width: 700, height: 500 });
    }, url);
    expect(opened.success).toBe(true);
    await app.getWindow(SLUG, 15000);

    // Save and read back the persisted descriptor URL — the source of truth the
    // round-trip must reproduce.
    await app.evaluateMain!((() =>
      (globalThis as any).__peek_test.forceSaveSession()) as never);
    const savedUrl = await snapshotUrlForSlug();
    expect(savedUrl, 'saved snapshot must contain our window').not.toBe('');
    // Pre-conditions that make this a genuine hard case, not a trivial URL:
    // the whole double-encoded value must persist verbatim (no layer decoded).
    expect(savedUrl, 'double-encoding must persist un-decoded').toContain(NESTED);
    expect(savedUrl.endsWith(TAIL), 'full URL length must persist (no truncation)').toBe(true);
    expect(savedUrl.length, 'URL must be long enough to exercise the length path').toBeGreaterThan(2000);

    // Close it, then restore from the snapshot we just wrote.
    await bgWindow.evaluate(async (id: number) => {
      await (window as any).app.window.close(id);
    }, opened.id);
    await bgWindow.waitForFunction(async (id: number) => {
      const r = await (window as any).app.window.list({ includeInternal: false });
      if (!r?.success) return false;
      return !(r.windows || []).some((w: any) => w.id === id);
    }, opened.id);

    const restoreResult = (await app.evaluateMain!((() =>
      (globalThis as any).__peek_test.forceRestoreSession()) as never)) as
      { restored: number; failed: number; total: number };
    expect(restoreResult.restored).toBeGreaterThanOrEqual(1);

    // The restored window re-navigates; re-saving captures its now-live URL.
    // Poll (re-save + read) until that URL is present and re-navigated to full
    // length (ends with our tail marker) — a real content-commit signal, not a
    // sleep. Then assert exact byte identity against the pre-close save.
    let restoredUrl = '';
    await expect
      .poll(
        async () => {
          await app.evaluateMain!((() =>
            (globalThis as any).__peek_test.forceSaveSession()) as never);
          restoredUrl = await snapshotUrlForSlug();
          return restoredUrl.endsWith(TAIL);
        },
        {
          timeout: 15000,
          message: 'restored window must re-navigate and re-serialize its full URL',
        },
      )
      .toBe(true);

    expect(
      restoredUrl,
      'nested-encoded long URL must survive save→restore byte-for-byte',
    ).toBe(savedUrl);

    // Cleanup.
    await bgWindow.evaluate(async () => {
      const r = await (window as any).app.window.list({ includeInternal: false });
      if (!r?.success) return;
      for (const w of r.windows || []) {
        await (window as any).app.window.close(w.id);
      }
    });
  });
});
