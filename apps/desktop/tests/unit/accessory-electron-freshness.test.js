/**
 * Rebuild/reuse decision for the copied "accessory" Electron.app — see
 * tests/helpers/accessory-electron-freshness.js for why a plain mtime
 * comparison misses a copy that macOS has partially purged.
 */
// @no-product-import: the module under test is test infrastructure (tests/helpers/), imported for real below — no shipping module is involved.
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { shouldRebuildAccessoryElectron } from '../helpers/accessory-electron-freshness.js';

// A copy that is whole and at least as new as the source — the base case
// every other test perturbs exactly one field of.
const WHOLE_AND_CURRENT = {
  binaryExists: true,
  sourceMtimeMs: 1000,
  copyMtimeMs: 2000,
  markerExists: true,
  missingRequiredFiles: [],
};

describe('shouldRebuildAccessoryElectron', () => {
  it('reuses a copy that is whole and current', () => {
    assert.equal(shouldRebuildAccessoryElectron(WHOLE_AND_CURRENT), false);
  });

  it('rebuilds when the copied binary is missing', () => {
    assert.equal(
      shouldRebuildAccessoryElectron({ ...WHOLE_AND_CURRENT, binaryExists: false }),
      true
    );
  });

  it('rebuilds when the copy is older than the source (an Electron upgrade)', () => {
    assert.equal(
      shouldRebuildAccessoryElectron({ ...WHOLE_AND_CURRENT, copyMtimeMs: 500 }),
      true
    );
  });

  it('rebuilds when the completion marker is missing (an interrupted copy)', () => {
    assert.equal(
      shouldRebuildAccessoryElectron({ ...WHOLE_AND_CURRENT, markerExists: false }),
      true
    );
  });

  it('rebuilds when a required bundle file is missing (a purged copy)', () => {
    assert.equal(
      shouldRebuildAccessoryElectron({
        ...WHOLE_AND_CURRENT,
        missingRequiredFiles: ['Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler'],
      }),
      true
    );
  });
});
