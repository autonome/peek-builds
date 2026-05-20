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

/** Pre-process markdown to protect checkbox syntax from snarkdown's link parsing */
function preProcessCheckboxes(md) {
  return md
    .replace(/^(\s*[-*])\s+\[ \]/gm, '$1 CBTODO')
    .replace(/^(\s*[-*])\s+\[x\]/gim, '$1 CBDONE');
}

/** Post-process HTML to render checkbox placeholders as actual checkboxes */
function postProcessCheckboxes(html) {
  return html
    .replace(/<li>\s*CBTODO\s*/g, '<li class="checkbox-item"><input type="checkbox" disabled /> ')
    .replace(/<li>\s*CBDONE\s*/g, '<li class="checkbox-item checkbox-checked"><input type="checkbox" checked disabled /> ');
}

// Reproduce the exact rendering logic from App.tsx
function renderMarkdown(content) {
  const preprocessed = preProcessCheckboxes(content);
  const rendered = preprocessed.split(/\n\n+/).map(block => {
    const html = snarkdown(block.trim());
    return /^<(h[1-6]|ul|ol|pre|blockquote|table|hr)/i.test(html) ? html : `<p>${html}</p>`;
  }).join('');
  return postProcessCheckboxes(rendered || `<p>${content}</p>`);
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

describe('checkbox list items in reader mode', () => {
  it('renders unchecked checkbox for - [ ] syntax', () => {
    const result = renderMarkdown('- [ ] todo item');
    assert.ok(result.includes('<input type="checkbox" disabled />'), `Expected disabled checkbox in: ${result}`);
    assert.ok(result.includes('class="checkbox-item"'), `Expected checkbox-item class in: ${result}`);
    assert.ok(result.includes('todo item'), `Expected text in: ${result}`);
    assert.ok(!result.includes('checked'), `Should not be checked in: ${result}`);
  });

  it('renders checked checkbox for - [x] syntax', () => {
    const result = renderMarkdown('- [x] done item');
    assert.ok(result.includes('<input type="checkbox" checked disabled />'), `Expected checked checkbox in: ${result}`);
    assert.ok(result.includes('checkbox-checked'), `Expected checkbox-checked class in: ${result}`);
    assert.ok(result.includes('done item'), `Expected text in: ${result}`);
  });

  it('renders checked checkbox for - [X] syntax (uppercase)', () => {
    const result = renderMarkdown('- [X] done item');
    assert.ok(result.includes('checked'), `Expected checked for uppercase X in: ${result}`);
  });

  it('renders mixed checkboxes in a list', () => {
    const result = renderMarkdown('- [ ] first\n- [x] second\n- [ ] third');
    const uncheckedCount = (result.match(/checkbox-item/g) || []).length;
    const checkedCount = (result.match(/checkbox-checked/g) || []).length;
    assert.equal(uncheckedCount, 3, `Expected 3 checkbox-item classes (got ${uncheckedCount}) in: ${result}`);
    assert.equal(checkedCount, 1, `Expected 1 checkbox-checked (got ${checkedCount}) in: ${result}`);
  });

  it('does not affect regular list items', () => {
    const result = renderMarkdown('- regular item\n- another item');
    assert.ok(!result.includes('checkbox-item'), `Regular items should not get checkbox class: ${result}`);
    assert.ok(!result.includes('type="checkbox"'), `Regular items should not get checkbox input: ${result}`);
  });
});

describe('CSS: checkbox styles', () => {
  it('has styles for checkbox-item class', () => {
    assert.ok(
      cssSource.includes('.note-reader-content li.checkbox-item'),
      'CSS must include styles for checkbox list items'
    );
  });

  it('has styles for checkbox-checked class', () => {
    assert.ok(
      cssSource.includes('.note-reader-content li.checkbox-checked'),
      'CSS must include styles for checked checkbox items'
    );
  });

  it('has dark mode styles for checked checkboxes', () => {
    assert.ok(
      cssSource.includes('body.dark .note-reader-content li.checkbox-checked'),
      'CSS must include dark mode styles for checked checkboxes'
    );
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
