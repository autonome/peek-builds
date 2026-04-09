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
