/**
 * Unit tests for features/sheets/image-drop.js (pure module).
 *
 * Run via: node --test tests/unit/sheet-image-drop.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mod = await import(join(__dirname, '..', '..', 'features', 'sheets', 'image-drop.js'));
const {
  dragHasFiles, pickImageFile, imageCardBounds, isImageItem,
  IMAGE_CARD_WIDTH, IMAGE_CARD_MIN_HEIGHT, IMAGE_CARD_MAX_HEIGHT
} = mod;

describe('dragHasFiles', () => {
  it('is true only when the drag carries files', () => {
    assert.equal(dragHasFiles({ types: ['Files'] }), true);
    assert.equal(dragHasFiles({ types: ['text/uri-list', 'text/plain'] }), false);
    assert.equal(dragHasFiles(null), false);
  });
});

describe('pickImageFile', () => {
  const png = { type: 'image/png', name: 'a.png' };
  it('picks the first image from files', () => {
    assert.equal(pickImageFile({ files: [{ type: 'text/plain' }, png] }), png);
  });
  it('falls back to file items', () => {
    const dt = { files: [], items: [{ kind: 'string', type: 'text/plain' }, { kind: 'file', type: 'image/jpeg', getAsFile: () => png }] };
    assert.equal(pickImageFile(dt), png);
  });
  it('ignores links, text and non-image files', () => {
    const dt = { files: [{ type: 'application/pdf' }], items: [{ kind: 'string', type: 'text/uri-list' }] };
    assert.equal(pickImageFile(dt), null);
    assert.equal(pickImageFile(null), null);
  });
});

describe('imageCardBounds', () => {
  it('centres on the drop point with the image aspect ratio', () => {
    const b = imageCardBounds({ x: 400, y: 300 }, { width: 600, height: 300 });
    assert.deepEqual(b, { x: 250, y: 225, w: IMAGE_CARD_WIDTH, h: 150 });
  });
  it('snaps to the grid', () => {
    const b = imageCardBounds({ x: 403, y: 297 }, { width: 300, height: 300 }, 20);
    assert.equal(b.x % 20, 0);
    assert.equal(b.y % 20, 0);
  });
  it('never goes negative', () => {
    const b = imageCardBounds({ x: 5, y: 5 }, { width: 300, height: 300 });
    assert.equal(b.x, 0);
    assert.equal(b.y, 0);
  });
  it('clamps extreme aspect ratios', () => {
    assert.equal(imageCardBounds({ x: 0, y: 0 }, { width: 3000, height: 10 }).h, IMAGE_CARD_MIN_HEIGHT);
    assert.equal(imageCardBounds({ x: 0, y: 0 }, { width: 10, height: 3000 }).h, IMAGE_CARD_MAX_HEIGHT);
  });
});

describe('isImageItem', () => {
  it('needs the image kind and a stored image', () => {
    assert.equal(isImageItem({ kind: 'image', image: 'data:image/webp;base64,AA' }), true);
    assert.equal(isImageItem({ kind: 'image' }), false);
    assert.equal(isImageItem({ id: 'x', url: 'https://a.b' }), false);
  });
});
