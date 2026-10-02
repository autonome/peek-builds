/**
 * Unit tests for the tag-query block rows model (features/editor/query-blocks.js).
 * Pure functions, no DOM.
 * Run via: NODE_ENV=test node --test tests/unit/query-blocks.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { blockRowsModel, isBlockItem, imageSource } from '../../features/editor/query-blocks.js';

describe('blockRowsModel: text', () => {
  it('uses the first content line without its heading marker as the title', () => {
    const m = blockRowsModel({ type: 'text', content: '## Buy milk\n\nTwo litres, **whole**.' });
    assert.equal(m.type, 'text');
    assert.equal(m.title, 'Buy milk');
    assert.deepEqual(m.rows, ['title', 'body']);
    assert.equal(m.bodyMarkdown, 'Two litres, **whole**.');
  });

  it('shows plain first line as title when there is no heading', () => {
    const m = blockRowsModel({ type: 'text', content: 'just a line\nsecond line' });
    assert.equal(m.title, 'just a line');
    assert.equal(m.bodyMarkdown, 'second line');
  });

  it('has only a title row when the content is a single line', () => {
    const m = blockRowsModel({ type: 'text', content: '# Only a heading' });
    assert.equal(m.title, 'Only a heading');
    assert.deepEqual(m.rows, ['title']);
    assert.equal(m.bodyMarkdown, '');
  });

  it('prefers the stored title and keeps the whole content as the body', () => {
    const m = blockRowsModel({ type: 'text', title: '# Stored', content: 'line one\nline two' });
    assert.equal(m.title, 'Stored');
    assert.equal(m.bodyMarkdown, 'line one\nline two');
    assert.deepEqual(m.rows, ['title', 'body']);
  });

  it('falls back to Untitled for empty content', () => {
    for (const content of ['', '  \n \n', undefined]) {
      const m = blockRowsModel({ type: 'text', content });
      assert.equal(m.title, 'Untitled');
      assert.deepEqual(m.rows, ['title']);
    }
  });

  it('uses the injected title extractor when given', () => {
    const m = blockRowsModel({ type: 'text', content: 'x' }, (item, fallback) => 'From helper');
    assert.equal(m.title, 'From helper');
  });

  it('treats the extractor fallback as no title', () => {
    const m = blockRowsModel({ type: 'text', content: 'first\nrest' }, (item, fallback) => fallback);
    assert.equal(m.title, 'first');
    assert.equal(m.bodyMarkdown, 'rest');
  });
});

describe('blockRowsModel: url', () => {
  it('has title and link rows without notes', () => {
    const m = blockRowsModel({ type: 'url', title: 'Example', content: 'https://example.com/a' });
    assert.equal(m.type, 'url');
    assert.equal(m.title, 'Example');
    assert.equal(m.url, 'https://example.com/a');
    assert.deepEqual(m.rows, ['title', 'link']);
  });

  it('adds a notes row from the notes metadata', () => {
    const m = blockRowsModel({
      type: 'url',
      title: 'Example',
      content: 'https://example.com',
      metadata: JSON.stringify({ notes: 'read later\nmore' }),
    });
    assert.deepEqual(m.rows, ['title', 'link', 'notes']);
    assert.equal(m.notes, 'read later\nmore');
  });

  it('falls back to the first line of the notes, then to the URL', () => {
    const withNotes = blockRowsModel({
      type: 'url', content: 'https://example.com', metadata: { notes: '# Worth a look\nbody' },
    });
    assert.equal(withNotes.title, 'Worth a look');
    const bare = blockRowsModel({ type: 'url', content: 'https://example.com' });
    assert.equal(bare.title, 'https://example.com');
  });

  it('ignores unparseable metadata', () => {
    const m = blockRowsModel({ type: 'url', title: 'T', content: 'https://e.com', metadata: '{nope' });
    assert.deepEqual(m.rows, ['title', 'link']);
  });
});

describe('blockRowsModel: image', () => {
  it('has title, image and notes rows', () => {
    const m = blockRowsModel({
      type: 'image',
      title: 'Whiteboard',
      content: 'https://example.com/a.png',
      metadata: { notes: 'from the meeting' },
    });
    assert.equal(m.type, 'image');
    assert.deepEqual(m.rows, ['title', 'image', 'notes']);
    assert.equal(m.imageSrc, 'https://example.com/a.png');
  });

  it('drops the image row when no source can be found', () => {
    const m = blockRowsModel({ type: 'image', content: 'opaque-id' });
    assert.equal(m.title, 'Image');
    assert.deepEqual(m.rows, ['title']);
  });

  it('falls back to the first line of the notes for the title', () => {
    const m = blockRowsModel({ type: 'image', content: 'x', metadata: { notes: 'a sketch\nmore' } });
    assert.equal(m.title, 'a sketch');
  });

  it('finds the source in metadata or the thumbnail', () => {
    assert.equal(imageSource({ content: 'id', metadata: { src: 'data:image/png;base64,AA' } }), 'data:image/png;base64,AA');
    assert.equal(imageSource({ content: 'id', thumbnail: 'abc' }), 'peek://thumbnail/abc');
    assert.equal(imageSource({ content: 'http://insecure.example/a.png' }), null);
  });
});

describe('unsupported types', () => {
  it('are left out', () => {
    for (const type of ['tagset', 'tag', 'entity', 'feed', 'series', 'event', undefined]) {
      assert.equal(blockRowsModel({ type, content: 'x' }), null);
      assert.equal(isBlockItem({ type }), false);
    }
    assert.equal(blockRowsModel(null), null);
  });

  it('keeps text, url and image', () => {
    for (const type of ['text', 'url', 'image']) assert.equal(isBlockItem({ type }), true);
  });
});
