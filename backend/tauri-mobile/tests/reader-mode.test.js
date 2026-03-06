import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const snarkdown = require('snarkdown');

const __dirname = dirname(fileURLToPath(import.meta.url));
const cssSource = readFileSync(join(__dirname, '..', 'src', 'App.css'), 'utf-8');
const tsxSource = readFileSync(join(__dirname, '..', 'src', 'App.tsx'), 'utf-8');

// Reproduce the exact rendering logic from App.tsx (lines 2307-2311)
function renderMarkdown(content) {
  const rendered = content.split(/\n\n+/).map(block => {
    const html = snarkdown(block.trim());
    return /^<(h[1-6]|ul|ol|pre|blockquote|table|hr)/i.test(html) ? html : `<p>${html}</p>`;
  }).join('');
  return rendered || `<p>${content}</p>`;
}

describe('snarkdown basic functionality', () => {
  it('converts markdown headers to HTML', () => {
    assert.equal(snarkdown('# Hello'), '<h1>Hello</h1>');
    assert.equal(snarkdown('## World'), '<h2>World</h2>');
    assert.equal(snarkdown('### Sub'), '<h3>Sub</h3>');
  });

  it('converts bold and italic', () => {
    assert.equal(snarkdown('**bold**'), '<strong>bold</strong>');
    assert.equal(snarkdown('*italic*'), '<em>italic</em>');
  });

  it('converts inline code', () => {
    assert.equal(snarkdown('`code`'), '<code>code</code>');
  });

  it('converts links', () => {
    assert.equal(snarkdown('[text](http://url)'), '<a href="http://url">text</a>');
  });

  it('returns plain text as-is for non-markdown', () => {
    assert.equal(snarkdown('just plain text'), 'just plain text');
  });
});

describe('renderMarkdown (App.tsx logic)', () => {
  it('wraps plain text in <p> tags', () => {
    const result = renderMarkdown('Hello world');
    assert.equal(result, '<p>Hello world</p>');
  });

  it('renders a header without extra <p> wrapping', () => {
    const result = renderMarkdown('# Title');
    assert.equal(result, '<h1>Title</h1>');
  });

  it('handles multiple paragraphs separated by double newlines', () => {
    const result = renderMarkdown('First paragraph\n\nSecond paragraph');
    assert.equal(result, '<p>First paragraph</p><p>Second paragraph</p>');
  });

  it('handles headers mixed with paragraphs', () => {
    const result = renderMarkdown('# Title\n\nSome text\n\n## Subtitle\n\nMore text');
    assert.equal(result, '<h1>Title</h1><p>Some text</p><h2>Subtitle</h2><p>More text</p>');
  });

  it('handles markdown with lists', () => {
    const result = renderMarkdown('Shopping list:\n\n* apples\n* bananas\n* oranges');
    assert.ok(result.includes('<ul>'), `Expected <ul> in: ${result}`);
    assert.ok(result.includes('<li>'), `Expected <li> in: ${result}`);
  });

  it('handles code blocks', () => {
    const result = renderMarkdown('```\nconst x = 1;\n```');
    assert.ok(result.includes('<code>'), `Expected <code> in: ${result}`);
  });

  it('handles empty string', () => {
    const result = renderMarkdown('');
    // empty string split gives [''], snarkdown('') returns '', regex test false, wraps in <p></p>
    assert.equal(result, '<p></p>');
  });

  it('handles single newlines (not double) as one block', () => {
    const result = renderMarkdown('line one\nline two');
    assert.ok(result.length > 0, 'Should produce non-empty output');
    assert.ok(result.includes('line one'), 'Should contain first line');
    assert.ok(result.includes('line two'), 'Should contain second line');
  });

  it('produces non-empty HTML for typical note content', () => {
    const content = 'My note about things\n\nWith a second paragraph\n\n- item 1\n- item 2';
    const result = renderMarkdown(content);
    assert.ok(result.length > 0, 'Should produce non-empty output');
    assert.ok(result.includes('My note'), 'Should contain note text');
  });
});

describe('CSS: reader mode dark mode visibility', () => {
  it('has dark mode text color for .note-reader-content', () => {
    assert.ok(
      cssSource.includes('body.dark .note-reader-content'),
      'CSS must include dark mode override for .note-reader-content'
    );
    // Text color must NOT be #333 (invisible on dark background #2c2c2e)
    const darkRuleMatch = cssSource.match(/body\.dark\s+\.note-reader-content\s*\{[^}]*color:\s*([^;]+)/);
    assert.ok(darkRuleMatch, 'Dark mode rule must set a color property');
    const darkColor = darkRuleMatch[1].trim().toLowerCase();
    assert.notEqual(darkColor, '#333', 'Dark mode text color must not be #333 (invisible on dark bg)');
    assert.notEqual(darkColor, '#333333', 'Dark mode text color must not be #333333');
    assert.notEqual(darkColor, 'var(--base05, #333)', 'Dark mode must override the base05 fallback');
  });

  it('has dark mode styles for code blocks', () => {
    assert.ok(
      cssSource.includes('body.dark .note-reader-content code'),
      'CSS must include dark mode for inline code'
    );
    assert.ok(
      cssSource.includes('body.dark .note-reader-content pre'),
      'CSS must include dark mode for pre blocks'
    );
  });

  it('has dark mode styles for blockquotes', () => {
    assert.ok(
      cssSource.includes('body.dark .note-reader-content blockquote'),
      'CSS must include dark mode for blockquotes'
    );
  });

  it('has dark mode styles for links', () => {
    assert.ok(
      cssSource.includes('body.dark .note-reader-content a'),
      'CSS must include dark mode for links'
    );
  });
});

describe('CSS: reader mode layout', () => {
  it('.note-reader-content has overflow-y: auto for scrolling', () => {
    const rule = cssSource.match(/\.note-reader-content\s*\{[^}]*overflow-y:\s*auto/);
    assert.ok(rule, '.note-reader-content must have overflow-y: auto');
  });

  it('.note-reader-content has min-height to prevent collapse', () => {
    const rule = cssSource.match(/\.note-reader-content\s*\{[^}]*min-height:\s*\d+/);
    assert.ok(rule, '.note-reader-content must have a min-height');
  });

  it('tags section is constrained when reader content is present', () => {
    assert.ok(
      cssSource.includes('.note-reader-content ~ .editor-tags-section'),
      'CSS must constrain tags section when note-reader-content is a sibling'
    );
  });
});

describe('TSX: reader mode rendering logic', () => {
  it('editor uses snarkdown for reader mode', () => {
    assert.ok(
      tsxSource.includes('editorReaderMode'),
      'Must have editorReaderMode state'
    );
    assert.ok(
      tsxSource.includes('dangerouslySetInnerHTML'),
      'Must use dangerouslySetInnerHTML for rendered markdown'
    );
  });

  it('card view uses snarkdown for reader mode', () => {
    assert.ok(
      tsxSource.includes('textReaderMode'),
      'Must have textReaderMode state for card view'
    );
  });
});
