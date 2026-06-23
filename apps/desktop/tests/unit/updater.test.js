/**
 * Tests for features-manager updater module (renderer-side helper).
 *
 * Covers compareSemver() — the only pure helper still living in updater.js
 * (used by browse.js at renderer runtime).
 *
 * The capability-expansion comparison + auto-update decision that used to be
 * tested here (compareCapabilities / shouldAutoUpdate) moved to the MAIN
 * PROCESS — they are the live security gate the `tile:features:update-apply`
 * handler calls. Those cases now live in, and test the real gate code at,
 * apps/desktop/main/capability-compare.test.ts (compareCapabilities +
 * evaluateUpdateGate). This file no longer carries a divergent second copy.
 *
 * Runs under Node.js test runner (no Electron dependency).
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

// Import the functions directly from the updater module.
// Since updater.js is a plain ES module with no DOM/Electron deps, it works in Node.
import {
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
