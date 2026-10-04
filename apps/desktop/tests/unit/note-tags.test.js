/**
 * Unit tests for renderer/lib/note-tags.js — splitting trailing hashtags off note text.
 *
 * Run via: node --test tests/unit/note-tags.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { splitTrailingTags } = await import(
  join(__dirname, '../../renderer/lib/note-tags.js')
);

describe('splitTrailingTags', () => {
  it('trims trailing tags from the body', () => {
    assert.deepEqual(splitTrailingTags('buy milk #todo #today'), { body: 'buy milk', tags: ['todo', 'today'] });
  });

  it('leaves mid-text tags in the body', () => {
    assert.deepEqual(splitTrailingTags('a #b c'), { body: 'a #b c', tags: [] });
    assert.deepEqual(splitTrailingTags('a #b c #d'), { body: 'a #b c', tags: ['d'] });
  });

  it('returns text without tags unchanged apart from trailing whitespace', () => {
    assert.deepEqual(splitTrailingTags('plain note  \n'), { body: 'plain note', tags: [] });
  });

  it('does not treat a tag glued to a word as a tag', () => {
    assert.deepEqual(splitTrailingTags('foo#bar'), { body: 'foo#bar', tags: [] });
  });

  it('handles trailing tags after a newline', () => {
    assert.deepEqual(splitTrailingTags('line one\nline two\n#a #b'), { body: 'line one\nline two', tags: ['a', 'b'] });
  });

  it('yields an empty body when the text is only tags', () => {
    assert.deepEqual(splitTrailingTags('#a #b'), { body: '', tags: ['a', 'b'] });
  });

  it('deduplicates repeated tags', () => {
    assert.deepEqual(splitTrailingTags('x #a #a'), { body: 'x', tags: ['a'] });
  });

  it('handles empty and missing input', () => {
    assert.deepEqual(splitTrailingTags(''), { body: '', tags: [] });
    assert.deepEqual(splitTrailingTags(undefined), { body: '', tags: [] });
  });
});
