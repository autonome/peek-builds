/**
 * Unit tests for the CodeMirror block surface's block <-> document-range mapping.
 *
 * Run via: node --test tests/unit/query-surface-cm.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', 'features', 'editor', 'query-surface-cm.js');
const { buildBlockDoc, blockIndexAt, clampIndex } = await import(modulePath);

const items = [
  { title: 'Alpha', content: 'line one\nline two' },
  { title: 'Beta' },
  { title: 'Gamma', content: 'only line\n\n' },
];

describe('buildBlockDoc', () => {
  it('lays blocks out as title, body, blank separator', () => {
    const { text } = buildBlockDoc(items);
    assert.equal(text, 'Alpha\nline one\nline two\n\nBeta\n\nGamma\nonly line');
  });

  it('records spans that slice back to the block text', () => {
    const { text, blocks } = buildBlockDoc(items);
    assert.equal(text.slice(blocks[0].titleFrom, blocks[0].titleTo), 'Alpha');
    assert.equal(text.slice(blocks[0].bodyFrom, blocks[0].to), '\nline one\nline two');
    assert.equal(text.slice(blocks[1].titleFrom, blocks[1].to), 'Beta');
    assert.equal(text.slice(blocks[2].titleFrom, blocks[2].to), 'Gamma\nonly line');
  });

  it('marks a block with no body as having nothing to fold', () => {
    const { blocks } = buildBlockDoc(items);
    assert.equal(blocks[1].bodyFrom, blocks[1].to);
    assert.ok(blocks[0].to > blocks[0].bodyFrom);
  });

  it('handles no items', () => {
    assert.deepEqual(buildBlockDoc([]), { text: '', blocks: [] });
  });
});

describe('blockIndexAt', () => {
  const { blocks } = buildBlockDoc(items);

  it('maps every offset of a block to that block', () => {
    for (let pos = blocks[0].titleFrom; pos <= blocks[0].to; pos++) assert.equal(blockIndexAt(blocks, pos), 0);
    assert.equal(blockIndexAt(blocks, blocks[1].titleFrom), 1);
    assert.equal(blockIndexAt(blocks, blocks[2].to), 2);
  });

  it('assigns the blank separator to the preceding block', () => {
    assert.equal(blockIndexAt(blocks, blocks[0].to + 1), 0);
  });

  it('clamps out-of-range offsets and handles no blocks', () => {
    assert.equal(blockIndexAt(blocks, -5), 0);
    assert.equal(blockIndexAt(blocks, 9999), 2);
    assert.equal(blockIndexAt([], 3), -1);
  });
});

describe('clampIndex', () => {
  it('clamps at both ends and truncates', () => {
    assert.equal(clampIndex(3, -1), 0);
    assert.equal(clampIndex(3, 99), 2);
    assert.equal(clampIndex(3, 1.9), 1);
  });

  it('returns -1 for no blocks or a non-finite index', () => {
    assert.equal(clampIndex(0, 1), -1);
    assert.equal(clampIndex(3, NaN), -1);
  });
});
