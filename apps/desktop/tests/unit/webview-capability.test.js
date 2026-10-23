/**
 * The `webview` capability: carried into a builtin feature's grant, refused
 * for any other, and asked for by the features that host <webview> cards.
 *
 * Run via: node --test tests/unit/webview-capability.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { resolveCapabilities } = await import(
  join(__dirname, '..', '..', '..', '..', 'packages', 'capabilities', 'index.js')
);

describe('webview capability', () => {
  it('is granted to a builtin feature that asks', () => {
    const r = resolveCapabilities('x', { webview: true }, true);
    assert.equal(r.capabilities.webview, true);
    assert.deepEqual(r.denied, []);
  });

  it('is refused to a non-builtin feature', () => {
    const r = resolveCapabilities('x', { webview: true }, false);
    assert.equal(r.capabilities.webview, undefined);
    assert.ok(r.denied.includes('webview'));
  });

  it('is absent unless asked for', () => {
    const r = resolveCapabilities('x', { commands: true }, true);
    assert.equal(r.capabilities.webview, undefined);
  });

  for (const feature of ['sheets', 'widget-demo']) {
    it(`${feature} manifest asks for it`, () => {
      const manifest = JSON.parse(
        readFileSync(join(__dirname, '..', '..', 'features', feature, 'manifest.json'), 'utf8'),
      );
      assert.equal(manifest.capabilities.webview, true);
    });
  }
});
