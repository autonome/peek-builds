/**
 * Unit tests for the settings-panel helpers in features/sheets/sheet-options.js.
 *
 * Run via: node --test tests/unit/sheet-options-panel.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', 'features', 'sheets', 'sheet-options.js');
const { fitWithin, isStoredImageDataUrl, withSheetOptions, backgroundNeedsReopen } = await import(modulePath);

describe('fitWithin', () => {
  it('scales a large image down to fit, keeping its aspect ratio', () => {
    assert.deepEqual(fitWithin(4000, 2000, 1000, 1000), { width: 1000, height: 500 });
    assert.deepEqual(fitWithin(2000, 4000, 1000, 1000), { width: 500, height: 1000 });
  });

  it('never enlarges a small image', () => {
    assert.deepEqual(fitWithin(300, 200, 1920, 1080), { width: 300, height: 200 });
  });

  it('returns at least one pixel and survives bad input', () => {
    assert.deepEqual(fitWithin(10000, 1, 100, 100), { width: 100, height: 1 });
    assert.deepEqual(fitWithin(0, NaN, 100, 100), { width: 1, height: 1 });
    assert.deepEqual(fitWithin(100, 100, 0, 0), { width: 1, height: 1 });
  });
});

describe('isStoredImageDataUrl', () => {
  it('accepts webp and jpeg data urls only', () => {
    assert.equal(isStoredImageDataUrl('data:image/webp;base64,AAAA'), true);
    assert.equal(isStoredImageDataUrl('data:image/jpeg;base64,AAAA'), true);
    assert.equal(isStoredImageDataUrl('data:image/png;base64,AAAA'), false);
    assert.equal(isStoredImageDataUrl('file:///tmp/a.png'), false);
    assert.equal(isStoredImageDataUrl(null), false);
  });
});

describe('withSheetOptions', () => {
  it('changes only the given fields and does not mutate the input', () => {
    const config = { name: 'a', items: [], maximized: false };
    const next = withSheetOptions(config, { maximized: true });
    assert.equal(next.maximized, true);
    assert.equal(next.name, 'a');
    assert.equal(config.maximized, false);
  });

  it('keeps the chosen image and drops it when another kind is chosen', () => {
    const img = 'data:image/webp;base64,AAAA';
    const withImage = withSheetOptions({}, { background: { kind: 'image', image: img } });
    assert.deepEqual(withImage.background, { kind: 'image', image: img });
    assert.deepEqual(withSheetOptions(withImage, { background: { kind: 'image' } }).background, { kind: 'image', image: img });
    assert.deepEqual(withSheetOptions(withImage, { background: { kind: 'transparent' } }).background, { kind: 'transparent' });
  });

  it('falls back to opaque for an image kind with no image or an unknown kind', () => {
    assert.deepEqual(withSheetOptions({}, { background: { kind: 'image' } }).background, { kind: 'opaque' });
    assert.deepEqual(withSheetOptions({}, { background: { kind: 'plaid' } }).background, { kind: 'opaque' });
  });
});

describe('backgroundNeedsReopen', () => {
  it('is true only when the change is to or from transparent', () => {
    assert.equal(backgroundNeedsReopen('opaque', 'transparent'), true);
    assert.equal(backgroundNeedsReopen('transparent', 'image'), true);
    assert.equal(backgroundNeedsReopen('opaque', 'image'), false);
    assert.equal(backgroundNeedsReopen('transparent', 'transparent'), false);
  });
});
