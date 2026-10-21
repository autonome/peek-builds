/**
 * Unit tests for editor outline (parseHeaders), preview (renderMarkdown,
 * resolveImgSrc) and highlight serialisation.
 *
 * The real modules are imported. outline-sidebar.js pulls in
 * @codemirror/language and highlights.js pulls in @codemirror/state and
 * @codemirror/view; all three load under plain node with no DOM, so the
 * functions under test need no stub.
 *
 * Run via: node --test tests/unit/editor-outline-preview.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { parseHeaders } from '../../features/editor/outline-sidebar.js';
import { renderMarkdown, resolveImgSrc } from '../../features/editor/preview-sidebar.js';
import {
  serializeHighlights,
  deserializeHighlights,
} from '../../features/editor/highlights.js';

// ===========================================================================
// parseHeaders tests
// ===========================================================================

describe('parseHeaders', () => {
  it('returns empty array for empty string', () => {
    const result = parseHeaders('');
    assert.deepEqual(result, []);
  });

  it('returns empty array for text with no headers', () => {
    const result = parseHeaders('Just some plain text.\nAnother line.');
    assert.deepEqual(result, []);
  });

  it('parses a single H1 header', () => {
    const result = parseHeaders('# Hello World');
    assert.equal(result.length, 1);
    assert.equal(result[0].level, 1);
    assert.equal(result[0].text, 'Hello World');
    assert.equal(result[0].line, 1);
    assert.equal(result[0].offset, 0);
  });

  it('parses all header levels (H1-H6)', () => {
    const text = [
      '# H1',
      '## H2',
      '### H3',
      '#### H4',
      '##### H5',
      '###### H6',
    ].join('\n');

    const result = parseHeaders(text);
    assert.equal(result.length, 6);
    for (let i = 0; i < 6; i++) {
      assert.equal(result[i].level, i + 1);
      assert.equal(result[i].text, `H${i + 1}`);
    }
  });

  it('calculates correct line numbers', () => {
    const text = 'intro\n\n# First\n\nsome text\n\n## Second';
    const result = parseHeaders(text);
    assert.equal(result.length, 2);
    assert.equal(result[0].line, 3);
    assert.equal(result[1].line, 7);
  });

  it('calculates correct offsets', () => {
    const text = '# A\n\n## B';
    const result = parseHeaders(text);
    assert.equal(result[0].offset, 0); // "# A" starts at 0
    assert.equal(result[1].offset, 5); // "# A\n\n" = 3+1+1 = 5
  });

  it('does not treat lines without space after # as headers', () => {
    const result = parseHeaders('#NoSpace\n##AlsoNot');
    assert.equal(result.length, 0);
  });

  it('does not parse more than 6 # characters as a header', () => {
    const result = parseHeaders('####### Seven hashes');
    assert.equal(result.length, 0);
  });

  it('trims header text', () => {
    const result = parseHeaders('# Hello World  ');
    assert.equal(result[0].text, 'Hello World');
  });

  it('parses headers with inline formatting', () => {
    const result = parseHeaders('## **Bold** and *italic*');
    assert.equal(result.length, 1);
    assert.equal(result[0].text, '**Bold** and *italic*');
  });

  it('handles multiple headers interspersed with content', () => {
    const text = [
      '# Intro',
      'Some paragraph.',
      '',
      '## Section A',
      'Content A.',
      '',
      '### Subsection A1',
      'Details.',
      '',
      '## Section B',
    ].join('\n');

    const result = parseHeaders(text);
    assert.equal(result.length, 4);
    assert.equal(result[0].text, 'Intro');
    assert.equal(result[1].text, 'Section A');
    assert.equal(result[2].text, 'Subsection A1');
    assert.equal(result[3].text, 'Section B');
  });

  it('handles headers at end of document without trailing newline', () => {
    const result = parseHeaders('# Last');
    assert.equal(result.length, 1);
    assert.equal(result[0].text, 'Last');
  });

  it('handles consecutive headers without content between them', () => {
    const text = '# One\n## Two\n### Three';
    const result = parseHeaders(text);
    assert.equal(result.length, 3);
    assert.equal(result[0].line, 1);
    assert.equal(result[1].line, 2);
    assert.equal(result[2].line, 3);
  });
});

// ===========================================================================
// renderMarkdown tests
// ===========================================================================

describe('renderMarkdown', () => {
  it('renders H1 through H6 headers', () => {
    const md = '# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6';
    const html = renderMarkdown(md);
    assert.ok(html.includes('<h1>H1</h1>'));
    assert.ok(html.includes('<h2>H2</h2>'));
    assert.ok(html.includes('<h3>H3</h3>'));
    assert.ok(html.includes('<h4>H4</h4>'));
    assert.ok(html.includes('<h5>H5</h5>'));
    assert.ok(html.includes('<h6>H6</h6>'));
  });

  it('renders bold text', () => {
    const html = renderMarkdown('**bold**');
    assert.ok(html.includes('<strong>bold</strong>'));
  });

  it('renders italic text with asterisks', () => {
    const html = renderMarkdown('*italic*');
    assert.ok(html.includes('<em>italic</em>'));
  });

  it('renders italic text with underscores', () => {
    const html = renderMarkdown('_italic_');
    assert.ok(html.includes('<em>italic</em>'));
  });

  it('renders bold+italic with triple asterisks', () => {
    const html = renderMarkdown('***bolditalic***');
    assert.ok(html.includes('<strong><em>bolditalic</em></strong>'));
  });

  it('renders inline code', () => {
    const html = renderMarkdown('Use `code` here');
    assert.ok(html.includes('<code>code</code>'));
  });

  it('renders fenced code blocks', () => {
    const md = '```javascript\nconst x = 1;\n```';
    const html = renderMarkdown(md);
    assert.ok(html.includes('<pre><code class="language-javascript">'));
    assert.ok(html.includes('const x = 1;'));
  });

  it('renders links', () => {
    const html = renderMarkdown('[Click me](https://example.com)');
    assert.ok(html.includes('<a href="https://example.com" target="_blank">Click me</a>'));
  });

  it('renders markdown images', () => {
    // Image regex runs before link regex so ![alt](url) is handled correctly
    const html = renderMarkdown('![Alt text](https://example.com/image.png)');
    assert.ok(html.includes('<img src="https://example.com/image.png"'));
    assert.ok(html.includes('alt="Alt text"'));
  });

  it('renders horizontal rules', () => {
    const html = renderMarkdown('---');
    assert.ok(html.includes('<hr>'));
  });

  it('renders blockquotes', () => {
    const html = renderMarkdown('> Quote text');
    assert.ok(html.includes('<blockquote>Quote text</blockquote>'));
  });

  it('renders unordered lists', () => {
    const md = '- Item one\n- Item two';
    const html = renderMarkdown(md);
    assert.ok(html.includes('<li>Item one</li>'));
    assert.ok(html.includes('<li>Item two</li>'));
    assert.ok(html.includes('<ul>'));
  });

  it('escapes HTML in content', () => {
    const html = renderMarkdown('Use <div> tags');
    assert.ok(html.includes('&lt;div&gt;'));
    assert.ok(!html.includes('<div>'));
  });

  it('wraps plain text in paragraphs', () => {
    const html = renderMarkdown('Hello world');
    assert.ok(html.includes('<p>'));
    assert.ok(html.includes('Hello world'));
    assert.ok(html.includes('</p>'));
  });

  it('separates paragraphs on blank lines', () => {
    const md = 'First paragraph.\n\nSecond paragraph.';
    const html = renderMarkdown(md);
    // Should have two paragraph blocks
    const pCount = (html.match(/<p>/g) || []).length;
    assert.equal(pCount, 2);
  });

  it('does not double-wrap block elements in paragraphs', () => {
    const md = '# Header\n\nParagraph text.';
    const html = renderMarkdown(md);
    // The header should not be inside a <p> tag
    assert.ok(!html.includes('<p>\n<h1>'));
  });

  it('handles empty string', () => {
    const html = renderMarkdown('');
    assert.equal(typeof html, 'string');
  });

  it('renders bold with underscores', () => {
    const html = renderMarkdown('__bold__');
    assert.ok(html.includes('<strong>bold</strong>'));
  });

  it('renders ordered list items', () => {
    const md = '1. First\n2. Second';
    const html = renderMarkdown(md);
    assert.ok(html.includes('<li>First</li>'));
    assert.ok(html.includes('<li>Second</li>'));
  });

  it('handles code blocks without language specifier', () => {
    const md = '```\nplain code\n```';
    const html = renderMarkdown(md);
    assert.ok(html.includes('<pre><code'));
    assert.ok(html.includes('plain code'));
  });

  // HTML img tag tests
  it('renders HTML img tags with https src', () => {
    const html = renderMarkdown('<img src="https://example.com/photo.png" alt="photo">');
    assert.ok(html.includes('<img src="https://example.com/photo.png" alt="photo"'));
    assert.ok(!html.includes('&lt;img'));
  });

  it('renders HTML img tags with data:image src', () => {
    const html = renderMarkdown('<img src="data:image/png;base64,abc123" alt="inline">');
    assert.ok(html.includes('<img src="data:image/png;base64,abc123"'));
  });

  it('blocks HTML img tags with javascript: src', () => {
    const html = renderMarkdown('<img src="javascript:alert(1)">');
    assert.ok(!html.includes('<img src='));
    assert.ok(html.includes('&lt;img'));
  });

  it('blocks HTML img tags with http:// (non-https) src', () => {
    const html = renderMarkdown('<img src="http://example.com/photo.png">');
    assert.ok(!html.includes('<img src='));
    assert.ok(html.includes('&lt;img'));
  });

  it('strips disallowed attributes like onerror from img tags', () => {
    const html = renderMarkdown('<img src="https://example.com/x.png" onerror="alert(1)">');
    assert.ok(html.includes('<img src="https://example.com/x.png"'));
    assert.ok(!html.includes('onerror'));
  });

  it('renders self-closing HTML img tags', () => {
    const html = renderMarkdown('<img src="https://example.com/x.png" />');
    assert.ok(html.includes('<img src="https://example.com/x.png"'));
  });

  it('preserves width and height attributes on img tags', () => {
    const html = renderMarkdown('<img src="https://example.com/x.png" width="200" height="100">');
    assert.ok(html.includes('width="200"'));
    assert.ok(html.includes('height="100"'));
  });

  it('adds max-width style to img tags without explicit style', () => {
    const html = renderMarkdown('<img src="https://example.com/x.png">');
    assert.ok(html.includes('style="max-width:100%"'));
  });

  it('preserves explicit style on img tags', () => {
    const html = renderMarkdown('<img src="https://example.com/x.png" style="border:1px solid red">');
    assert.ok(html.includes('style="border:1px solid red"'));
    // Should NOT add default max-width since style was provided
    assert.ok(!html.includes('max-width:100%'));
  });

  // file:// protocol tests
  it('renders HTML img tags with file:// src', () => {
    const html = renderMarkdown('<img src="file:///Users/me/photo.png" alt="local">');
    assert.ok(html.includes('<img src="file:///Users/me/photo.png"'));
    assert.ok(!html.includes('&lt;img'));
  });

  it('blocks HTML img tags with ftp:// src', () => {
    const html = renderMarkdown('<img src="ftp://example.com/photo.png">');
    assert.ok(!html.includes('<img src='));
    assert.ok(html.includes('&lt;img'));
  });

  it('blocks HTML img tags with vbscript: src', () => {
    const html = renderMarkdown('<img src="vbscript:alert(1)">');
    assert.ok(!html.includes('<img src='));
  });

  // Relative path resolution tests
  it('resolves relative image paths with basePath', () => {
    const html = renderMarkdown('<img src="./screenshot.png">', { basePath: '/Users/me/docs' });
    assert.ok(html.includes('<img src="peek://local-file/Users/me/docs/screenshot.png"'));
  });

  it('resolves parent-relative image paths with basePath', () => {
    const html = renderMarkdown('<img src="../images/photo.jpg">', { basePath: '/Users/me/docs' });
    assert.ok(html.includes('<img src="peek://local-file/Users/me/images/photo.jpg"'));
  });

  it('resolves bare filename image paths with basePath', () => {
    const html = renderMarkdown('<img src="image.png">', { basePath: '/Users/me/docs' });
    assert.ok(html.includes('<img src="peek://local-file/Users/me/docs/image.png"'));
  });

  it('resolves absolute filesystem paths with basePath', () => {
    const html = renderMarkdown('<img src="/tmp/image.png">', { basePath: '/Users/me/docs' });
    assert.ok(html.includes('<img src="peek://local-file/tmp/image.png"'));
  });

  it('blocks relative image paths without basePath', () => {
    const html = renderMarkdown('<img src="./screenshot.png">');
    assert.ok(!html.includes('<img src='));
    assert.ok(html.includes('&lt;img'));
  });

  it('still allows https with basePath set', () => {
    const html = renderMarkdown('<img src="https://example.com/photo.png">', { basePath: '/Users/me/docs' });
    assert.ok(html.includes('<img src="https://example.com/photo.png"'));
  });

  it('still blocks javascript: with basePath set', () => {
    const html = renderMarkdown('<img src="javascript:alert(1)">', { basePath: '/Users/me/docs' });
    assert.ok(!html.includes('<img src='));
  });

  // Markdown image syntax with basePath
  it('resolves relative markdown image paths with basePath', () => {
    const html = renderMarkdown('![Alt text](./image.png)', { basePath: '/Users/me/docs' });
    assert.ok(html.includes('src="peek://local-file/Users/me/docs/image.png"'));
    assert.ok(html.includes('alt="Alt text"'));
  });

  it('resolves parent-relative markdown image paths with basePath', () => {
    const html = renderMarkdown('![Photo](../images/photo.jpg)', { basePath: '/Users/me/docs' });
    assert.ok(html.includes('src="peek://local-file/Users/me/images/photo.jpg"'));
  });
});

// ===========================================================================
// resolveImgSrc tests
// ===========================================================================

describe('resolveImgSrc', () => {
  it('passes through https:// URLs', () => {
    assert.equal(resolveImgSrc('https://example.com/img.png'), 'https://example.com/img.png');
  });

  it('passes through data:image/ URLs', () => {
    const src = 'data:image/png;base64,abc123';
    assert.equal(resolveImgSrc(src), src);
  });

  it('passes through file:// URLs', () => {
    assert.equal(resolveImgSrc('file:///Users/me/photo.png'), 'file:///Users/me/photo.png');
  });

  it('blocks javascript: protocol', () => {
    assert.equal(resolveImgSrc('javascript:alert(1)'), null);
  });

  it('blocks http:// protocol', () => {
    assert.equal(resolveImgSrc('http://example.com/img.png'), null);
  });

  it('blocks ftp:// protocol', () => {
    assert.equal(resolveImgSrc('ftp://example.com/img.png'), null);
  });

  it('blocks vbscript: protocol', () => {
    assert.equal(resolveImgSrc('vbscript:code'), null);
  });

  it('blocks blob: protocol', () => {
    assert.equal(resolveImgSrc('blob:http://example.com/uuid'), null);
  });

  it('resolves relative path with basePath', () => {
    assert.equal(resolveImgSrc('image.png', '/Users/me/docs'), 'peek://local-file/Users/me/docs/image.png');
  });

  it('resolves ./ relative path', () => {
    assert.equal(resolveImgSrc('./image.png', '/Users/me/docs'), 'peek://local-file/Users/me/docs/image.png');
  });

  it('resolves ../ relative path', () => {
    assert.equal(resolveImgSrc('../image.png', '/Users/me/docs'), 'peek://local-file/Users/me/image.png');
  });

  it('resolves deeply nested relative path', () => {
    assert.equal(resolveImgSrc('sub/dir/image.png', '/Users/me/docs'), 'peek://local-file/Users/me/docs/sub/dir/image.png');
  });

  it('resolves absolute path with basePath', () => {
    assert.equal(resolveImgSrc('/tmp/image.png', '/Users/me/docs'), 'peek://local-file/tmp/image.png');
  });

  it('returns null for relative path without basePath', () => {
    assert.equal(resolveImgSrc('image.png'), null);
  });

  it('handles basePath with trailing slash', () => {
    assert.equal(resolveImgSrc('image.png', '/Users/me/docs/'), 'peek://local-file/Users/me/docs/image.png');
  });
});

describe('resolveImgSrc - non-image file types', () => {
  it('resolves PDF files with basePath', () => {
    assert.equal(resolveImgSrc('document.pdf', '/Users/me/docs'), 'peek://local-file/Users/me/docs/document.pdf');
  });

  it('resolves CSS files with basePath', () => {
    assert.equal(resolveImgSrc('styles.css', '/Users/me/docs'), 'peek://local-file/Users/me/docs/styles.css');
  });

  it('resolves font files with basePath', () => {
    assert.equal(resolveImgSrc('font.woff2', '/Users/me/fonts'), 'peek://local-file/Users/me/fonts/font.woff2');
  });

  it('resolves video files with basePath', () => {
    assert.equal(resolveImgSrc('video.mp4', '/Users/me/media'), 'peek://local-file/Users/me/media/video.mp4');
  });

  it('resolves audio files with basePath', () => {
    assert.equal(resolveImgSrc('audio.mp3', '/Users/me/media'), 'peek://local-file/Users/me/media/audio.mp3');
  });
});

// ===========================================================================
// Highlight serialization/deserialization tests
// ===========================================================================

describe('serializeHighlights', () => {
  it('serializes highlights with empty text field', () => {
    const highlights = [
      { id: 'hl-1', from: 0, to: 10, text: '', note: '', color: 'var(--base0A)' },
    ];
    const result = serializeHighlights(highlights);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, '');
    assert.equal(result[0].from, 0);
    assert.equal(result[0].to, 10);
  });

  it('serializes highlights with note but empty text', () => {
    const highlights = [
      { id: 'hl-2', from: 5, to: 15, text: '', note: 'My note', color: 'var(--base0B)' },
    ];
    const result = serializeHighlights(highlights);
    assert.equal(result[0].text, '');
    assert.equal(result[0].note, 'My note');
  });

  it('preserves all fields during serialization', () => {
    const hl = { id: 'hl-3', from: 10, to: 20, text: '', note: 'test', color: 'var(--base0C)' };
    const result = serializeHighlights([hl]);
    assert.deepEqual(result[0], hl);
  });
});

describe('deserializeHighlights', () => {
  it('deserializes highlights with empty text', () => {
    const data = [
      { id: 'hl-1', from: 0, to: 10, text: '', note: '', color: 'var(--base0A)' },
    ];
    const result = deserializeHighlights(data, 100);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, '');
  });

  it('defaults missing text to empty string', () => {
    const data = [
      { id: 'hl-1', from: 0, to: 10, note: '', color: 'var(--base0A)' },
    ];
    const result = deserializeHighlights(data, 100);
    assert.equal(result[0].text, '');
  });

  it('filters out highlights beyond doc length', () => {
    const data = [
      { id: 'hl-1', from: 0, to: 50, text: '', note: '', color: 'var(--base0A)' },
    ];
    const result = deserializeHighlights(data, 20);
    assert.equal(result.length, 0);
  });

  it('filters out invalid highlights (from >= to)', () => {
    const data = [
      { id: 'hl-1', from: 10, to: 10, text: '', note: '', color: 'var(--base0A)' },
      { id: 'hl-2', from: 15, to: 5, text: '', note: '', color: 'var(--base0A)' },
    ];
    const result = deserializeHighlights(data, 100);
    assert.equal(result.length, 0);
  });

  it('generates ID if missing', () => {
    const data = [
      { from: 0, to: 10, text: '', note: '', color: 'var(--base0A)' },
    ];
    const result = deserializeHighlights(data, 100);
    assert.equal(result.length, 1);
    assert.ok(result[0].id.startsWith('hl-'));
  });

  it('defaults color if missing', () => {
    const data = [
      { id: 'hl-1', from: 0, to: 10, text: '' },
    ];
    const result = deserializeHighlights(data, 100);
    assert.equal(result[0].color, 'var(--base0A)');
  });

  it('round-trips through serialize and deserialize with empty text', () => {
    const original = [
      { id: 'hl-1', from: 0, to: 10, text: '', note: 'A note', color: 'var(--base0B)' },
      { id: 'hl-2', from: 15, to: 25, text: '', note: '', color: 'var(--base0C)' },
    ];
    const serialized = serializeHighlights(original);
    const deserialized = deserializeHighlights(serialized, 100);
    assert.equal(deserialized.length, 2);
    assert.equal(deserialized[0].text, '');
    assert.equal(deserialized[0].note, 'A note');
    assert.equal(deserialized[1].text, '');
    assert.equal(deserialized[1].note, '');
  });

  it('returns empty array for non-array input', () => {
    assert.deepEqual(deserializeHighlights(null, 100), []);
    assert.deepEqual(deserializeHighlights(undefined, 100), []);
    assert.deepEqual(deserializeHighlights('invalid', 100), []);
  });

  it('handles line-anchored highlights (full line range)', () => {
    // Simulating a line-anchored highlight: from=start of line, to=end of line
    const data = [
      { id: 'hl-line', from: 11, to: 22, text: '', note: '', color: 'var(--base0D)' },
    ];
    const result = deserializeHighlights(data, 50);
    assert.equal(result.length, 1);
    assert.equal(result[0].from, 11);
    assert.equal(result[0].to, 22);
    assert.equal(result[0].text, '');
  });
});
