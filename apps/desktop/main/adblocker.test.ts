/**
 * Unit tests for adblocker resilience.
 *
 * These tests exercise the offline-resilience paths introduced to fix the
 * "Adblocker init failed: FetchError ENOTFOUND raw.githubusercontent.com"
 * regression that left the blocker uninitialised on cold boots with no DNS.
 *
 * `adblocker.ts` itself imports Electron (app.getPath, session) and so cannot
 * be loaded by this runner. Its fallback slice does not: the bundled filter
 * list and `buildFallbackEngine()` live in `adblocker-fallback.js`, which
 * imports only @ghostery/adblocker-electron, and that is the shipping code
 * these cases drive. `initAdblocker()` calls the same `buildFallbackEngine()`
 * in its catch branch, so what holds here is what happens offline.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { ElectronBlocker, Request } from '@ghostery/adblocker-electron';

import { buildFallbackEngine, BUNDLED_FALLBACK_FILTERS } from './adblocker-fallback.js';

// ─── Test: bundled fallback engine is always usable ──────────────────────────

describe('adblocker bundled fallback', () => {
  it('buildFallbackEngine succeeds on the bundled filter list', () => {
    // This is the exact call path taken when both cache and network are absent.
    // It must not throw and must return a non-null engine.
    const engine = buildFallbackEngine();
    assert.ok(engine !== null, 'engine must be non-null');
    assert.ok(engine instanceof ElectronBlocker, 'must be an ElectronBlocker instance');
  });

  it('fallback engine blocks a known ad domain', () => {
    const engine = buildFallbackEngine();

    // Build a synthetic request for a well-known ad domain included in the
    // bundled list and assert that the engine matches it.
    const req = Request.fromRawDetails({
      url: 'https://doubleclick.net/ads/pixel.gif',
      type: 'image',
      sourceUrl: 'https://example.com',
    });

    const { match } = engine.match(req);
    assert.ok(match, 'fallback engine must block doubleclick.net requests');
  });

  it('fallback engine blocks a domain only the shipping list carries', () => {
    // criteo.com is in the real BUNDLED_FALLBACK_FILTERS and was absent from
    // the five-rule copy this file used to keep, so this case fails against
    // anything but the shipping list.
    assert.ok(
      BUNDLED_FALLBACK_FILTERS.includes('||criteo.com^'),
      'bundled list must still carry the criteo.com rule',
    );

    const engine = buildFallbackEngine();
    const req = Request.fromRawDetails({
      url: 'https://criteo.com/x.gif',
      type: 'image',
      sourceUrl: 'https://example.com',
    });

    const { match } = engine.match(req);
    assert.ok(match, 'fallback engine must block criteo.com requests');
  });

  it('fallback engine does NOT block a legitimate URL', () => {
    const engine = buildFallbackEngine();
    const req = Request.fromRawDetails({
      url: 'https://example.com/page.html',
      type: 'main_frame',
      sourceUrl: 'https://example.com',
    });

    const { match } = engine.match(req);
    assert.ok(!match, 'fallback engine must not block legitimate navigation');
  });
});

// ─── Test: the fallback branch of initAdblocker can never be the thing that fails ──

describe('adblocker offline resilience — structural guarantee', () => {
  it('buildFallbackEngine never throws on the bundled filter text', () => {
    // initAdblocker() calls this from its catch block with no guard of its own,
    // so a throw here would turn an offline boot into a hard init failure.
    assert.doesNotThrow(() => {
      buildFallbackEngine();
    });
  });
});
