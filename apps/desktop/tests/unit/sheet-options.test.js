/**
 * Unit tests for features/sheets/sheet-options.js (pure leaf module).
 *
 * Run via: node --test tests/unit/sheet-options.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', 'features', 'sheets', 'sheet-options.js');
const { resolveSheetOptions, windowParamsForSheet } = await import(modulePath);

describe('resolveSheetOptions', () => {
  it('reads a config without the new fields as today\'s behaviour', () => {
    const cfg = { version: 1, name: 'x', createdAt: 1, items: [] };
    assert.deepEqual(resolveSheetOptions(cfg), { maximized: false, background: { kind: 'opaque' } });
  });

  it('tolerates a missing config', () => {
    assert.deepEqual(resolveSheetOptions(null), { maximized: false, background: { kind: 'opaque' } });
    assert.deepEqual(resolveSheetOptions(undefined), { maximized: false, background: { kind: 'opaque' } });
  });

  it('reads maximized only when exactly true', () => {
    assert.equal(resolveSheetOptions({ maximized: true }).maximized, true);
    assert.equal(resolveSheetOptions({ maximized: 'yes' }).maximized, false);
    assert.equal(resolveSheetOptions({ maximized: false }).maximized, false);
  });

  it('keeps transparent and image backgrounds', () => {
    assert.deepEqual(resolveSheetOptions({ background: { kind: 'transparent' } }).background, { kind: 'transparent' });
    assert.deepEqual(
      resolveSheetOptions({ background: { kind: 'image', image: '/a/b.png' } }).background,
      { kind: 'image', image: '/a/b.png' },
    );
  });

  it('falls back to opaque for an unknown kind or an image with no image', () => {
    assert.deepEqual(resolveSheetOptions({ background: { kind: 'glitter' } }).background, { kind: 'opaque' });
    assert.deepEqual(resolveSheetOptions({ background: { kind: 'image' } }).background, { kind: 'opaque' });
    assert.deepEqual(resolveSheetOptions({ background: 'transparent' }).background, { kind: 'opaque' });
  });
});

describe('windowParamsForSheet', () => {
  it('adds nothing for a default sheet', () => {
    assert.deepEqual(windowParamsForSheet({ items: [] }), {});
  });

  it('asks for a maximized window', () => {
    assert.deepEqual(windowParamsForSheet({ maximized: true }), { maximized: true, maximize: true });
  });

  it('asks for a transparent window only for the transparent background', () => {
    assert.deepEqual(windowParamsForSheet({ background: { kind: 'transparent' } }), { transparent: true });
    assert.deepEqual(windowParamsForSheet({ background: { kind: 'image', image: 'p' } }), {});
  });
});
