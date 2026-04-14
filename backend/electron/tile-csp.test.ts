/**
 * Unit tests for Tile CSP generation
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { buildCSPForTile, buildDefaultCSP } from './tile-csp.js';
import type { TileCapabilities } from './tile-manifest.js';

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

  it('should block CSS url() exfiltration via img-src restriction', () => {
    // CSS background-image url() is governed by img-src.
    // Without network capability, img-src is 'self' + data: only.
    const csp = buildCSPForTile({});
    const imgSrc = csp.match(/img-src ([^;]+)/)?.[1] || '';
    assert.ok(imgSrc.includes("'self'"), 'img-src should include self');
    assert.ok(!imgSrc.includes('https://'), 'img-src should not allow external https URLs');
    assert.ok(!imgSrc.includes('http://'), 'img-src should not allow external http URLs');
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
