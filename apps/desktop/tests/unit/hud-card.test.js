import { describe, it } from 'node:test';
import assert from 'node:assert';

import { isCardMode } from '../../features/hud/hud-card.js';
import { validateTileManifest, resolveCapabilities } from '../../../../packages/capabilities/index.js';

describe('isCardMode', () => {
  it('is false when the page fills its own window', () => {
    assert.strictEqual(isCardMode({ width: 320, height: 400 }, { width: 320, height: 400 }), false);
  });
  it('allows a title bar between window and page height', () => {
    assert.strictEqual(isCardMode({ width: 320, height: 428 }, { width: 320, height: 400 }), false);
  });
  it('is true when the holding window is much larger than the page', () => {
    assert.strictEqual(isCardMode({ width: 1200, height: 800 }, { width: 320, height: 400 }), true);
  });
  it('is true when the holding window is wider only', () => {
    assert.strictEqual(isCardMode({ width: 900, height: 400 }, { width: 320, height: 400 }), true);
  });
  it('is true when no window bounds are reported', () => {
    assert.strictEqual(isCardMode(null, { width: 320, height: 400 }), true);
    assert.strictEqual(isCardMode({ width: NaN, height: 1 }, { width: 320, height: 400 }), true);
  });
});

describe('diagnostics capability in the manifest schema', () => {
  const base = (diagnostics) => ({
    manifestVersion: 3, id: 'x', shortname: 'x', name: 'X', version: '1.0.0',
    tiles: [{ id: 't', url: 't.html' }],
    capabilities: { diagnostics },
  });
  const diagErrors = (m) => validateTileManifest(m).filter(e => e.path === 'capabilities.diagnostics');
  it('accepts a boolean', () => {
    assert.strictEqual(diagErrors(base(true)).length, 0);
  });
  it('rejects a non-boolean', () => {
    assert.strictEqual(diagErrors(base('yes')).length, 1);
  });
  it('is carried into the resolved grant', () => {
    assert.strictEqual(resolveCapabilities('hud', { diagnostics: true }, true).capabilities.diagnostics, true);
    assert.strictEqual(resolveCapabilities('x', {}, true).capabilities.diagnostics, undefined);
  });
});
