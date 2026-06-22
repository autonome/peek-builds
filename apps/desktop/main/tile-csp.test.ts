/**
 * Unit tests for Tile CSP generation
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { buildCSPForTile, buildDefaultCSP, injectCSPHeader, isHTMLResponse, resolveTileOriginCSP } from './tile-csp.js';
import type { TileCapabilities, TileManifest } from './tile-manifest.js';

/** Minimal TileManifest carrying only the capabilities the CSP path reads. */
function manifestWith(capabilities: TileCapabilities): TileManifest {
  return { id: 'fixture', capabilities } as unknown as TileManifest;
}

describe('buildDefaultCSP', () => {
  it('should return a valid CSP string', () => {
    const csp = buildDefaultCSP();
    assert.ok(csp.includes("default-src 'self'"));
    assert.ok(csp.includes("script-src 'self' 'unsafe-inline'"));
    assert.ok(csp.includes("connect-src 'self'"));
    assert.ok(csp.includes("form-action 'none'"));
    assert.ok(csp.includes("object-src 'none'"));
    assert.ok(csp.includes("frame-src 'none'"));
    assert.ok(csp.includes("worker-src 'none'"));
  });
});

describe('buildCSPForTile', () => {
  it('should return default CSP for empty capabilities', () => {
    const csp = buildCSPForTile({});
    assert.ok(csp.includes("connect-src 'self'"));
    assert.ok(!csp.includes('https://'));
  });

  it('should add network domains to connect-src', () => {
    const caps: TileCapabilities = {
      network: { domains: ['api.github.com', '*.example.com'] },
    };
    const csp = buildCSPForTile(caps);
    assert.ok(csp.includes('https://api.github.com'));
    assert.ok(csp.includes('https://*.example.com'));
  });

  it('should not double-add https:// for domains with protocol', () => {
    const caps: TileCapabilities = {
      network: { domains: ['https://api.github.com'] },
    };
    const csp = buildCSPForTile(caps);
    assert.ok(csp.includes('https://api.github.com'));
    assert.ok(!csp.includes('https://https://'));
  });

  it('should add theme sources when theme capability is granted', () => {
    const caps: TileCapabilities = {
      theme: true,
    };
    const csp = buildCSPForTile(caps);
    assert.ok(csp.includes('peek://theme'));
  });

  it('should add peek: frame-src when window capability is granted', () => {
    const caps: TileCapabilities = {
      window: { create: true },
    };
    const csp = buildCSPForTile(caps);
    assert.ok(csp.includes('frame-src'));
    assert.ok(csp.includes('peek:'));
  });

  it('should keep frame-src none without window capability', () => {
    const csp = buildCSPForTile({});
    assert.ok(csp.includes("frame-src 'none'"));
  });

  it('should always block form-action', () => {
    const caps: TileCapabilities = {
      network: { domains: ['example.com'] },
      window: { create: true },
    };
    const csp = buildCSPForTile(caps);
    assert.ok(csp.includes("form-action 'none'"));
  });

  it('should always block object-src', () => {
    const csp = buildCSPForTile({ network: { domains: ['*'] } });
    assert.ok(csp.includes("object-src 'none'"));
  });

  it('should always block worker-src', () => {
    const csp = buildCSPForTile({});
    assert.ok(csp.includes("worker-src 'none'"));
  });
});

describe('resolveTileOriginCSP (loaded ?? lazy ?? default precedence)', () => {
  const networkManifest = manifestWith({ network: { domains: ['public.api.bsky.app', '*'] } });

  it('uses the loaded manifest when present', () => {
    const csp = resolveTileOriginCSP(networkManifest, null);
    assert.ok(csp.includes('https://public.api.bsky.app'));
  });

  it("REGRESSION: a lazy tile served before its manifest loads must still get its network CSP, not connect-src 'self'", () => {
    // The bug: protocol.ts only consulted the LOADED manifest, so a
    // lazy-registered tile (e.g. a session-restored Lex window served before
    // `loadedManifests.set()`) fell back to the default CSP — collapsing
    // connect-src to 'self' and blocking every external fetch (Lex login).
    const csp = resolveTileOriginCSP(null, networkManifest);
    assert.ok(csp.includes('https://public.api.bsky.app'), 'lazy manifest network domains must reach connect-src');
    assert.ok(csp.includes('https://*'), 'wildcard network domain must expand');
    const connectSrc = csp.match(/connect-src ([^;]+)/)?.[1] || '';
    assert.notStrictEqual(connectSrc.trim(), "'self'", "connect-src must not collapse to 'self' for a lazy network tile");
  });

  it('prefers the loaded manifest over the lazy one when both exist', () => {
    const loaded = manifestWith({ network: { domains: ['loaded.example.com'] } });
    const lazy = manifestWith({ network: { domains: ['lazy.example.com'] } });
    const csp = resolveTileOriginCSP(loaded, lazy);
    assert.ok(csp.includes('https://loaded.example.com'));
    assert.ok(!csp.includes('https://lazy.example.com'));
  });

  it("falls back to the default 'self'-only CSP for a truly-unknown origin (no manifest at all)", () => {
    const csp = resolveTileOriginCSP(null, null);
    assert.ok(csp.includes("connect-src 'self'"));
    assert.ok(!csp.includes('https://'));
  });
});

// ─── Exfiltration Vector Tests ──────────────────────────────────────

describe('CSP exfiltration vectors', () => {
  it('should block navigator.sendBeacon via connect-src restriction', () => {
    // sendBeacon() is governed by connect-src. Without network capability,
    // connect-src is 'self' only — no external endpoints reachable.
    const csp = buildCSPForTile({});
    const connectSrc = csp.match(/connect-src ([^;]+)/)?.[1] || '';
    assert.ok(connectSrc.includes("'self'"), 'connect-src should include self');
    assert.ok(!connectSrc.includes('https://'), 'connect-src should not allow any external https domains');
    assert.ok(!connectSrc.includes('http://'), 'connect-src should not allow any external http domains');
    assert.ok(!connectSrc.includes('*'), 'connect-src should not contain wildcards');
  });

  it('img-src allows external https/http image sources (favicon rendering)', () => {
    // Tiles routinely render favicons sourced from external favicon services
    // (Google s2, DuckDuckGo, per-domain). img-src schemes 'https:' / 'http:'
    // let those load while keeping connect-src tight. Not a meaningful new
    // attack surface — tiles already have a `network` capability that gates
    // arbitrary fetch(), so img-src restriction wouldn't have prevented
    // exfiltration in practice.
    const csp = buildCSPForTile({});
    const imgSrc = csp.match(/img-src ([^;]+)/)?.[1] || '';
    assert.ok(imgSrc.includes("'self'"), 'img-src should include self');
    assert.ok(imgSrc.includes('data:'), 'img-src should include data:');
    assert.ok(imgSrc.includes('https:'), 'img-src should allow https: scheme');
    assert.ok(imgSrc.includes('http:'), 'img-src should allow http: scheme for parity');
    assert.ok(!imgSrc.includes('*'), 'img-src should not contain wildcards');
  });

  it('should block CSS url() exfiltration via font-src restriction', () => {
    // CSS @font-face url() is governed by font-src.
    const csp = buildCSPForTile({});
    const fontSrc = csp.match(/font-src ([^;]+)/)?.[1] || '';
    assert.ok(fontSrc.includes("'self'"), 'font-src should include self');
    assert.ok(!fontSrc.includes('https://'), 'font-src should not allow external URLs');
    assert.ok(!fontSrc.includes('*'), 'font-src should not contain wildcards');
  });

  it('should block WebSocket connections without network capability', () => {
    // WebSocket connections are governed by connect-src.
    // 'self' does not permit ws:// or wss:// schemes.
    const csp = buildCSPForTile({});
    const connectSrc = csp.match(/connect-src ([^;]+)/)?.[1] || '';
    assert.ok(!connectSrc.includes('ws:'), 'connect-src should not allow ws:// scheme');
    assert.ok(!connectSrc.includes('wss:'), 'connect-src should not allow wss:// scheme');
  });

  it('should block window.open to external URLs via default-src restriction', () => {
    // window.open() for navigation is governed by default-src / navigate-to.
    // default-src 'self' restricts navigation targets.
    const csp = buildCSPForTile({});
    const defaultSrc = csp.match(/default-src ([^;]+)/)?.[1] || '';
    assert.ok(defaultSrc.includes("'self'"), 'default-src should be self');
    assert.ok(!defaultSrc.includes('https://'), 'default-src should not allow external URLs');
    assert.ok(!defaultSrc.includes('*'), 'default-src should not contain wildcards');
  });

  it('should block window.open via frame-src none (no window capability)', () => {
    // Without window capability, frame-src is 'none' — blocks popup windows.
    const csp = buildCSPForTile({});
    assert.ok(csp.includes("frame-src 'none'"), 'frame-src should be none without window capability');
  });

  it('should still restrict sendBeacon even with network capability', () => {
    // With network capability, connect-src allows specific domains only —
    // sendBeacon is limited to those explicit domains, not open to all.
    const caps: TileCapabilities = {
      network: { domains: ['api.example.com'] },
    };
    const csp = buildCSPForTile(caps);
    const connectSrc = csp.match(/connect-src ([^;]+)/)?.[1] || '';
    assert.ok(connectSrc.includes('https://api.example.com'), 'should allow declared domain');
    assert.ok(!connectSrc.includes('*'), 'should not contain wildcards');
    // Verify it's a closed allowlist (self + declared domains only)
    const parts = connectSrc.split(/\s+/).filter(p => p !== "'self'" && p !== '');
    assert.strictEqual(parts.length, 1, 'only one external domain should be allowed');
    assert.strictEqual(parts[0], 'https://api.example.com');
  });
});

// ─── injectCSPHeader — apply to every response path ──────────────────
//
// Regression coverage for the protocol handler fix that extends CSP
// injection to error responses, redirects, and non-HTML sub-resources.
// Previously CSP was only injected when the response was HTML *and* the
// tile manifest was known. The handler now applies CSP on every tile
// response; these tests verify the primitive used to do so.

describe('injectCSPHeader on every response type', () => {
  it('should inject CSP on a 404 error response', () => {
    const original = new Response('Not Found', { status: 404 });
    const csp = buildDefaultCSP();
    const injected = injectCSPHeader(original, csp);
    assert.strictEqual(injected.status, 404);
    assert.strictEqual(injected.headers.get('Content-Security-Policy'), csp);
  });

  it('should inject CSP on a 500 server-error response', () => {
    const original = new Response('Internal Server Error', { status: 500 });
    const csp = buildDefaultCSP();
    const injected = injectCSPHeader(original, csp);
    assert.strictEqual(injected.status, 500);
    assert.ok(injected.headers.get('Content-Security-Policy')?.includes("default-src 'self'"));
  });

  it('should inject CSP on a 403 forbidden response (path traversal)', () => {
    const original = new Response('Forbidden', { status: 403 });
    const csp = buildDefaultCSP();
    const injected = injectCSPHeader(original, csp);
    assert.strictEqual(injected.status, 403);
    assert.ok(injected.headers.get('Content-Security-Policy'));
  });

  it('should inject CSP on a 302 redirect response', () => {
    const original = new Response(null, {
      status: 302,
      headers: { Location: 'https://example.com/' },
    });
    const csp = buildDefaultCSP();
    const injected = injectCSPHeader(original, csp);
    assert.strictEqual(injected.status, 302);
    assert.strictEqual(injected.headers.get('Location'), 'https://example.com/');
    assert.ok(injected.headers.get('Content-Security-Policy'));
  });

  it('should inject CSP on a non-HTML sub-resource (JS)', () => {
    const original = new Response('export const x = 1;', {
      status: 200,
      headers: { 'Content-Type': 'application/javascript' },
    });
    assert.ok(!isHTMLResponse(original), 'sanity: JS response is not HTML');
    const csp = buildDefaultCSP();
    const injected = injectCSPHeader(original, csp);
    assert.strictEqual(injected.status, 200);
    assert.strictEqual(injected.headers.get('Content-Type'), 'application/javascript');
    assert.ok(injected.headers.get('Content-Security-Policy'));
  });

  it('should inject CSP on a non-HTML sub-resource (CSS)', () => {
    const original = new Response('body{}', {
      status: 200,
      headers: { 'Content-Type': 'text/css' },
    });
    assert.ok(!isHTMLResponse(original));
    const injected = injectCSPHeader(original, buildDefaultCSP());
    assert.strictEqual(injected.headers.get('Content-Type'), 'text/css');
    assert.ok(injected.headers.get('Content-Security-Policy'));
  });

  it('should inject CSP on a font binary response', () => {
    const original = new Response(new ArrayBuffer(8), {
      status: 200,
      headers: { 'Content-Type': 'font/woff2' },
    });
    const injected = injectCSPHeader(original, buildDefaultCSP());
    assert.strictEqual(injected.headers.get('Content-Type'), 'font/woff2');
    assert.ok(injected.headers.get('Content-Security-Policy'));
  });

  it('should preserve other headers when injecting CSP', () => {
    const original = new Response('body', {
      status: 200,
      headers: {
        'Content-Type': 'text/html',
        'Cache-Control': 'no-store',
        'X-Custom': 'keep-me',
      },
    });
    const injected = injectCSPHeader(original, buildDefaultCSP());
    assert.strictEqual(injected.headers.get('Cache-Control'), 'no-store');
    assert.strictEqual(injected.headers.get('X-Custom'), 'keep-me');
    assert.ok(injected.headers.get('Content-Security-Policy'));
  });

  it('should use buildDefaultCSP as a safe fallback when manifest is missing', () => {
    // Fallback CSP must still block worker-src, object-src, form-action, and
    // disallow any external connect-src — otherwise the error-response path
    // could be used as an exfiltration escape hatch.
    const csp = buildDefaultCSP();
    assert.ok(csp.includes("worker-src 'none'"));
    assert.ok(csp.includes("object-src 'none'"));
    assert.ok(csp.includes("form-action 'none'"));
    assert.ok(csp.includes("frame-src 'none'"));
    const connectSrc = csp.match(/connect-src ([^;]+)/)?.[1] || '';
    assert.ok(!connectSrc.includes('https://'), 'fallback connect-src must not allow external domains');
  });
});
