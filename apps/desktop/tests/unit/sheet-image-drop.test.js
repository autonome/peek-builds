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
  dragHasFiles, pickImageFile, pickImageFiles, layoutCardRow, imageCardBounds, isImageItem, fitCardsInView,
  IMAGE_CARD_WIDTH, IMAGE_CARD_MIN_HEIGHT, IMAGE_CARD_MAX_HEIGHT
} = mod;

describe('fitCardsInView', () => {
  const view = { left: 0, top: 0, right: 900, bottom: 600 };
  const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  it('keeps the wrapped layout when it already fits', () => {
    const sizes = [{ w: 300, h: 200 }, { w: 300, h: 150 }];
    const start = { x: 100, y: 50 };
    assert.deepEqual(fitCardsInView(sizes, view, 8, start), layoutCardRow(start, sizes, 900, 8));
  });

  it('fits many cards inside the view, keeps aspect ratios and does not overlap', () => {
    const sizes = Array.from({ length: 24 }, (_, i) => ({ w: 300, h: 100 + (i % 5) * 100 }));
    const rects = fitCardsInView(sizes, view, 8, { x: 450, y: 300 });
    assert.equal(rects.length, 24);
    rects.forEach((r, i) => {
      assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 900 && r.y + r.h <= 600);
      assert.ok(Math.abs(r.w / r.h - sizes[i].w / sizes[i].h) < 0.15 * (sizes[i].w / sizes[i].h));
      assert.ok(r.w < sizes[i].w);
    });
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) assert.ok(!overlaps(rects[i], rects[j]));
    }
  });
});

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

describe('pickImageFiles', () => {
  const a = { type: 'image/png', name: 'a.png' };
  const b = { type: 'image/jpeg', name: 'b.jpg' };
  it('returns every image from files, skipping other types', () => {
    assert.deepEqual(pickImageFiles({ files: [a, { type: 'text/plain' }, b] }), [a, b]);
  });
  it('prefers files over the same images listed as items', () => {
    const items = [a, b].map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f }));
    assert.deepEqual(pickImageFiles({ files: [a, b], items }), [a, b]);
  });
  it('falls back to file items when files is empty', () => {
    const items = [
      { kind: 'string', type: 'text/plain' },
      { kind: 'file', type: 'image/png', getAsFile: () => a },
      { kind: 'file', type: 'image/jpeg', getAsFile: () => b },
      { kind: 'file', type: 'image/png', getAsFile: () => a }
    ];
    assert.deepEqual(pickImageFiles({ files: [], items }), [a, b]);
  });
  it('returns an empty list when there is nothing', () => {
    assert.deepEqual(pickImageFiles(null), []);
    assert.deepEqual(pickImageFiles({ files: [{ type: 'application/pdf' }] }), []);
  });
});

describe('layoutCardRow', () => {
  const size = { w: 300, h: 100 };
  it('places a single card at the start', () => {
    assert.deepEqual(layoutCardRow({ x: 40, y: 60 }, [size], 1000, 10), [{ x: 40, y: 60, w: 300, h: 100 }]);
  });
  it('runs left to right a gap apart', () => {
    const r = layoutCardRow({ x: 0, y: 0 }, [size, size, size], 1000, 10);
    assert.deepEqual(r.map((c) => c.x), [0, 310, 620]);
    assert.deepEqual(r.map((c) => c.y), [0, 0, 0]);
  });
  it('wraps below the tallest card of the row when the next would pass the edge', () => {
    const r = layoutCardRow({ x: 20, y: 0 }, [size, { w: 300, h: 150 }, size], 700, 10);
    assert.deepEqual(r.map((c) => [c.x, c.y]), [[20, 0], [330, 0], [20, 160]]);
  });
  it('never wraps the first card of a row', () => {
    const r = layoutCardRow({ x: 0, y: 0 }, [size, size], 100, 10);
    assert.deepEqual(r.map((c) => [c.x, c.y]), [[0, 0], [0, 110]]);
  });
  it('returns nothing for no cards', () => {
    assert.deepEqual(layoutCardRow({ x: 0, y: 0 }, [], 500, 10), []);
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
