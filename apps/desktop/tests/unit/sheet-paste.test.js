/**
 * Unit tests for features/sheets/paste.js (pure module).
 *
 * Run via: node --test tests/unit/sheet-paste.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { normalizePastedUrl, classifyPaste, pastePoint, urlCardBounds, clickCardBounds, shouldIgnorePaste } =
  await import(join(__dirname, '..', '..', 'features', 'sheets', 'paste.js'));

const clip = ({ files = [], text = '' } = {}) => ({ files, items: [], getData: () => text });

describe('normalizePastedUrl', () => {
  it('keeps http, https and peek URLs', () => {
    assert.equal(normalizePastedUrl('https://a.com/x?y=1'), 'https://a.com/x?y=1');
    assert.equal(normalizePastedUrl(' http://a.com '), 'http://a.com');
    assert.equal(normalizePastedUrl('peek://app/x'), 'peek://app/x');
  });
  it('adds https to a bare domain', () => {
    assert.equal(normalizePastedUrl('example.com/path'), 'https://example.com/path');
    assert.equal(normalizePastedUrl('sub.example.co.uk'), 'https://sub.example.co.uk');
  });
  it('rejects other text', () => {
    assert.equal(normalizePastedUrl('hello world'), null);
    assert.equal(normalizePastedUrl('hello'), null);
    assert.equal(normalizePastedUrl('see example.com now'), null);
    assert.equal(normalizePastedUrl(''), null);
    assert.equal(normalizePastedUrl(null), null);
  });
});

describe('classifyPaste', () => {
  it('prefers image files over text', () => {
    const file = { type: 'image/png' };
    assert.deepEqual(classifyPaste(clip({ files: [file], text: 'example.com' })), { kind: 'images', files: [file] });
  });
  it('returns every pasted image', () => {
    const a = { type: 'image/png' };
    const b = { type: 'image/jpeg' };
    assert.deepEqual(classifyPaste(clip({ files: [a, b] })), { kind: 'images', files: [a, b] });
  });
  it('classifies URL text', () => {
    assert.deepEqual(classifyPaste(clip({ text: 'example.com' })), { kind: 'url', url: 'https://example.com' });
  });
  it('ignores plain text and empty clipboards', () => {
    assert.equal(classifyPaste(clip({ text: 'just words' })), null);
    assert.equal(classifyPaste(null), null);
  });
});

describe('pastePoint', () => {
  const visible = { width: 800, height: 600 };
  it('uses the pointer when over the grid', () => {
    assert.deepEqual(pastePoint({ x: 100, y: 50 }, visible), { x: 100, y: 50 });
  });
  it('centres in the visible area otherwise', () => {
    assert.deepEqual(pastePoint(null, visible), { x: 400, y: 300 });
    assert.deepEqual(pastePoint({ x: -5, y: 50 }, visible), { x: 400, y: 300 });
    assert.deepEqual(pastePoint({ x: 100, y: 700 }, visible), { x: 400, y: 300 });
  });
});

describe('urlCardBounds', () => {
  it('centres and snaps', () => {
    assert.deepEqual(urlCardBounds({ x: 400, y: 300 }, { w: 300, h: 200 }, 20), { x: 260, y: 200, w: 300, h: 200 });
  });
  it('never goes negative', () => {
    const b = urlCardBounds({ x: 0, y: 0 }, { w: 300, h: 200 }, 0);
    assert.equal(b.x, 0);
    assert.equal(b.y, 0);
  });
});

describe('clickCardBounds', () => {
  const visible = { left: 0, top: 0, right: 800, bottom: 600 };
  it('centres on the click and snaps', () => {
    assert.deepEqual(clickCardBounds({ x: 400, y: 300 }, { w: 300, h: 200 }, 20, visible), { x: 260, y: 200, w: 300, h: 200 });
  });
  it('moves inside the visible area near the far edges', () => {
    const b = clickCardBounds({ x: 790, y: 590 }, { w: 300, h: 200 }, 20, visible);
    assert.deepEqual(b, { x: 500, y: 400, w: 300, h: 200 });
  });
  it('shrinks to a small visible area', () => {
    const b = clickCardBounds({ x: 50, y: 50 }, { w: 300, h: 200 }, 0, { left: 0, top: 0, right: 200, bottom: 100 });
    assert.deepEqual(b, { x: 0, y: 0, w: 200, h: 100 });
  });
});

describe('shouldIgnorePaste', () => {
  it('ignores text fields and editable elements', () => {
    assert.equal(shouldIgnorePaste({ target: { tagName: 'INPUT' } }), true);
    assert.equal(shouldIgnorePaste({ target: { tagName: 'TEXTAREA' } }), true);
    assert.equal(shouldIgnorePaste({ target: { tagName: 'H1', isContentEditable: true } }), true);
  });
  it('ignores while the dialog or panel is open', () => {
    assert.equal(shouldIgnorePaste({ target: { tagName: 'BODY' }, dialogOpen: true }), true);
    assert.equal(shouldIgnorePaste({ target: { tagName: 'BODY' }, panelOpen: true }), true);
  });
  it('allows otherwise', () => {
    assert.equal(shouldIgnorePaste({ target: { tagName: 'BODY' } }), false);
  });
});
