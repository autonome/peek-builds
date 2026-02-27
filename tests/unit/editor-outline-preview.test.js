/**
 * Unit tests for editor outline (parseHeaders) and preview (renderMarkdown) modules.
 *
 * Tests pure functions without DOM/CodeMirror dependencies.
 * Run via: node --test tests/unit/editor-outline-preview.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// parseHeaders is exported from outline-sidebar.js but the module also
// imports @codemirror/language which requires a browser-like environment.
// We need to mock the import or extract the function.
// Since parseHeaders is a pure function, we can test it directly by extracting
// the logic inline.

// ---------------------------------------------------------------------------
// parseHeaders (extracted from outline-sidebar.js for testability)
// ---------------------------------------------------------------------------

function parseHeaders(text) {
  const headers = [];
  const lines = text.split('\n');
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^(#{1,6})\s+(.+)$/);

    if (match) {
      headers.push({
        level: match[1].length,
        text: match[2].trim(),
        line: i + 1,
        offset: offset,
      });
    }

    offset += line.length + 1; // +1 for newline
  }

  return headers;
}

// ---------------------------------------------------------------------------
// escapeHtml + renderMarkdown (extracted from preview-sidebar.js)
// ---------------------------------------------------------------------------

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderMarkdown(text) {
  let html = escapeHtml(text);

  // Code blocks (``` ... ```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code class="language-${lang}">${code.trim()}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Headers
  html = html.replace(/^###### (.+)$/gm, '<h6>$1</h6>');
  html = html.replace(/^##### (.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold and italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/___(.+?)___/g, '<strong><em>$1</em></strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
  html = html.replace(/_(.+?)_/g, '<em>$1</em>');

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

  // Images
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%">');

  // Horizontal rule
  html = html.replace(/^(---|\*\*\*|___)$/gm, '<hr>');

  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // Unordered lists
  html = html.replace(/^[-*+] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

  // Ordered lists
  html = html.replace(/^\d+[.)] (.+)$/gm, '<li>$1</li>');

  // Paragraphs
  const lines = html.split('\n');
  const result = [];
  let inParagraph = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isBlock = /^<(h[1-6]|pre|ul|ol|li|blockquote|hr)/.test(line);
    const isEmpty = line.trim() === '';

    if (isBlock) {
      if (inParagraph) {
        result.push('</p>');
        inParagraph = false;
      }
      result.push(line);
    } else if (isEmpty) {
      if (inParagraph) {
        result.push('</p>');
        inParagraph = false;
      }
    } else {
      if (!inParagraph) {
        result.push('<p>');
        inParagraph = true;
      }
      result.push(line);
    }
  }

  if (inParagraph) {
    result.push('</p>');
  }

  return result.join('\n');
}

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

  it('renders images (known limitation: link regex matches first)', () => {
    // Note: In the current renderMarkdown implementation, the link regex runs
    // before the image regex, so ![alt](url) is partially consumed by the link
    // pattern. This test documents the current behavior.
    const html = renderMarkdown('![Alt text](image.png)');
    // The link regex captures [Alt text](image.png) first, leaving "!" prefix
    assert.ok(html.includes('Alt text'));
    assert.ok(html.includes('image.png'));
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
});

// ===========================================================================
// Highlight serialization/deserialization tests
// ===========================================================================

// Inline the pure functions from highlights.js (they depend on CodeMirror
// StateField which can't run in Node, but serialize/deserialize are pure)

function generateHighlightId() {
  return 'hl-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 8);
}

function serializeHighlights(highlights) {
  return highlights.map(hl => ({
    id: hl.id,
    from: hl.from,
    to: hl.to,
    text: hl.text,
    note: hl.note || '',
    color: hl.color,
  }));
}

function deserializeHighlights(data, docLength) {
  if (!Array.isArray(data)) return [];
  return data.filter(hl =>
    hl && typeof hl.from === 'number' && typeof hl.to === 'number' &&
    hl.from >= 0 && hl.to <= docLength && hl.from < hl.to
  ).map(hl => ({
    id: hl.id || generateHighlightId(),
    from: hl.from,
    to: hl.to,
    text: hl.text || '',
    note: hl.note || '',
    color: hl.color || 'var(--base0A)',
  }));
}

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
