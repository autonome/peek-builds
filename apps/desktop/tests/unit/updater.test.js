/**
 * Tests for features-manager updater module.
 *
 * Tests compareCapabilities(), shouldAutoUpdate(), and compareSemver().
 * Runs under Node.js test runner (no Electron dependency).
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

// Import the functions directly from the updater module.
// Since updater.js is a plain ES module with no DOM/Electron deps, it works in Node.
import {
  compareCapabilities,
  shouldAutoUpdate,
  compareSemver,
} from '../../features/features-manager/updater.js';

// ─── compareSemver ──────────────────────────────────────────────────

describe('compareSemver', () => {
  it('should return 0 for equal versions', () => {
    assert.equal(compareSemver('1.0.0', '1.0.0'), 0);
  });

  it('should return 1 when a > b (major)', () => {
    assert.equal(compareSemver('2.0.0', '1.0.0'), 1);
  });

  it('should return -1 when a < b (major)', () => {
    assert.equal(compareSemver('1.0.0', '2.0.0'), -1);
  });

  it('should return 1 when a > b (minor)', () => {
    assert.equal(compareSemver('1.2.0', '1.1.0'), 1);
  });

  it('should return 1 when a > b (patch)', () => {
    assert.equal(compareSemver('1.0.2', '1.0.1'), 1);
  });

  it('should handle missing version gracefully', () => {
    assert.equal(compareSemver(null, '1.0.0'), -1);
    assert.equal(compareSemver('1.0.0', null), 1);
    assert.equal(compareSemver(null, null), 0);
  });
});

// ─── compareCapabilities ─────────────────────────────────────────────

describe('compareCapabilities', () => {
  it('should report identical capabilities as unchanged', () => {
    const caps = {
      commands: true,
      network: { domains: ['api.example.com'] },
      pubsub: { scopes: ['global'], topics: ['foo:*'] },
    };
    const result = compareCapabilities(caps, caps);
    assert.equal(result.changed, false);
    assert.equal(result.expanded, false);
    assert.deepEqual(result.added, []);
    assert.deepEqual(result.removed, []);
  });

  it('should report identical capabilities with same structure as unchanged', () => {
    const current = {
      commands: true,
      network: { domains: ['api.example.com'] },
    };
    const next = {
      commands: true,
      network: { domains: ['api.example.com'] },
    };
    const result = compareCapabilities(current, next);
    assert.equal(result.changed, false);
    assert.equal(result.expanded, false);
  });

  it('should detect reduced capabilities (removed network domain)', () => {
    const current = {
      network: { domains: ['api.example.com', 'cdn.example.com'] },
    };
    const next = {
      network: { domains: ['api.example.com'] },
    };
    const result = compareCapabilities(current, next);
    assert.equal(result.changed, true);
    assert.equal(result.expanded, false);
    assert.ok(result.removed.some(r => r.includes('cdn.example.com')));
  });

  it('should detect expanded capabilities (added network domain)', () => {
    const current = {
      network: { domains: ['api.example.com'] },
    };
    const next = {
      network: { domains: ['api.example.com', 'evil.com'] },
    };
    const result = compareCapabilities(current, next);
    assert.equal(result.changed, true);
    assert.equal(result.expanded, true);
    assert.ok(result.added.some(a => a.includes('evil.com')));
  });

  it('should detect added boolean capability', () => {
    const current = { commands: true };
    const next = { commands: true, shortcuts: true };
    const result = compareCapabilities(current, next);
    assert.equal(result.changed, true);
    assert.equal(result.expanded, true);
    assert.ok(result.added.includes('shortcuts'));
  });

  it('should detect removed boolean capability as changed but not expanded', () => {
    const current = { commands: true, shortcuts: true };
    const next = { commands: true };
    const result = compareCapabilities(current, next);
    assert.equal(result.changed, true);
    assert.equal(result.expanded, false);
    assert.ok(result.removed.includes('shortcuts'));
  });

  it('should detect entirely new capability type (filesystem)', () => {
    const current = { commands: true };
    const next = { commands: true, filesystem: { read: ['/tmp/*'] } };
    const result = compareCapabilities(current, next);
    assert.equal(result.changed, true);
    assert.equal(result.expanded, true);
    assert.ok(result.added.some(a => a.includes('filesystem')));
  });

  it('should detect added pubsub scope as expanded', () => {
    const current = { pubsub: { scopes: ['global'] } };
    const next = { pubsub: { scopes: ['global', 'system'] } };
    const result = compareCapabilities(current, next);
    assert.equal(result.changed, true);
    assert.equal(result.expanded, true);
    assert.ok(result.added.some(a => a.includes('system')));
  });

  it('should detect removed pubsub scope as changed but not expanded', () => {
    const current = { pubsub: { scopes: ['global', 'system'] } };
    const next = { pubsub: { scopes: ['global'] } };
    const result = compareCapabilities(current, next);
    assert.equal(result.changed, true);
    assert.equal(result.expanded, false);
    assert.ok(result.removed.some(r => r.includes('system')));
  });

  it('should detect added datastore table as expanded', () => {
    const current = { datastore: { tables: ['items'] } };
    const next = { datastore: { tables: ['items', 'secrets'] } };
    const result = compareCapabilities(current, next);
    assert.equal(result.changed, true);
    assert.equal(result.expanded, true);
    assert.ok(result.added.some(a => a.includes('secrets')));
  });

  it('should detect added window permission as expanded', () => {
    const current = { window: { create: true } };
    const next = { window: { create: true, manage: true } };
    const result = compareCapabilities(current, next);
    assert.equal(result.changed, true);
    assert.equal(result.expanded, true);
    assert.ok(result.added.some(a => a.includes('window.manage')));
  });

  it('should detect new pubsub capability entirely as expanded', () => {
    const current = {};
    const next = { pubsub: { scopes: ['global'] } };
    const result = compareCapabilities(current, next);
    assert.equal(result.changed, true);
    assert.equal(result.expanded, true);
    assert.ok(result.added.includes('pubsub'));
  });

  it('should detect removed pubsub entirely as changed but not expanded', () => {
    const current = { pubsub: { scopes: ['global'] } };
    const next = {};
    const result = compareCapabilities(current, next);
    assert.equal(result.changed, true);
    assert.equal(result.expanded, false);
    assert.ok(result.removed.includes('pubsub'));
  });

  it('should handle null/undefined inputs gracefully', () => {
    const result = compareCapabilities(null, null);
    assert.equal(result.changed, false);
    assert.equal(result.expanded, false);
  });

  it('should detect expansion when going from null to some capabilities', () => {
    const result = compareCapabilities(null, { commands: true });
    assert.equal(result.changed, true);
    assert.equal(result.expanded, true);
  });

  it('should detect reduction when going from some capabilities to null', () => {
    const result = compareCapabilities({ commands: true }, null);
    assert.equal(result.changed, true);
    assert.equal(result.expanded, false);
  });

  it('should detect added pubsub topics as expanded', () => {
    const current = { pubsub: { scopes: ['global'], topics: ['foo:*'] } };
    const next = { pubsub: { scopes: ['global'], topics: ['foo:*', 'bar:*'] } };
    const result = compareCapabilities(current, next);
    assert.equal(result.changed, true);
    assert.equal(result.expanded, true);
    assert.ok(result.added.some(a => a.includes('bar:*')));
  });

  it('should handle complex mixed changes', () => {
    const current = {
      commands: true,
      shortcuts: true,
      network: { domains: ['api.old.com', 'cdn.old.com'] },
      pubsub: { scopes: ['global'] },
    };
    const next = {
      commands: true,
      // shortcuts removed
      network: { domains: ['api.old.com', 'api.new.com'] }, // cdn.old.com removed, api.new.com added
      pubsub: { scopes: ['global', 'system'] }, // system added
      filesystem: { read: ['/tmp/*'] }, // entirely new
    };
    const result = compareCapabilities(current, next);
    assert.equal(result.changed, true);
    assert.equal(result.expanded, true);
    // Added: api.new.com, pubsub system scope, filesystem
    assert.ok(result.added.length >= 3);
    // Removed: shortcuts, cdn.old.com
    assert.ok(result.removed.length >= 2);
  });
});

// ─── shouldAutoUpdate ───────────────────────────────────────────────

describe('shouldAutoUpdate', () => {
  it('should return true for auto policy with no capability change', () => {
    const feature = {
      updatePolicy: 'auto',
      grantedCapabilities: { commands: true },
    };
    const newManifest = { capabilities: { commands: true } };
    assert.equal(shouldAutoUpdate(feature, newManifest), true);
  });

  it('should return false for auto policy with expanded capabilities', () => {
    const feature = {
      updatePolicy: 'auto',
      grantedCapabilities: { commands: true },
    };
    const newManifest = { capabilities: { commands: true, filesystem: { read: ['/tmp'] } } };
    assert.equal(shouldAutoUpdate(feature, newManifest), false);
  });

  it('should return true for auto policy with reduced capabilities', () => {
    const feature = {
      updatePolicy: 'auto',
      grantedCapabilities: { commands: true, shortcuts: true },
    };
    const newManifest = { capabilities: { commands: true } };
    assert.equal(shouldAutoUpdate(feature, newManifest), true);
  });

  it('should return false for notify policy', () => {
    const feature = {
      updatePolicy: 'notify',
      grantedCapabilities: { commands: true },
    };
    const newManifest = { capabilities: { commands: true } };
    assert.equal(shouldAutoUpdate(feature, newManifest), false);
  });

  it('should return false for pinned policy', () => {
    const feature = {
      updatePolicy: 'pinned',
      grantedCapabilities: { commands: true },
    };
    const newManifest = { capabilities: { commands: true } };
    assert.equal(shouldAutoUpdate(feature, newManifest), false);
  });

  it('should default to auto policy when updatePolicy is undefined', () => {
    const feature = {
      grantedCapabilities: { commands: true },
    };
    const newManifest = { capabilities: { commands: true } };
    assert.equal(shouldAutoUpdate(feature, newManifest), true);
  });

  it('should return false for null feature', () => {
    assert.equal(shouldAutoUpdate(null, { capabilities: {} }), false);
  });

  it('should return false for null manifest', () => {
    assert.equal(shouldAutoUpdate({ updatePolicy: 'auto', grantedCapabilities: {} }, null), false);
  });
});
