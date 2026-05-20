import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { autoListContinue } from '../src/auto-list.js';

describe('autoListContinue', () => {
  // Helper: simulate pressing Enter at end of the given text
  function atEnd(text) {
    return autoListContinue(text, text.length);
  }

  describe('basic list markers', () => {
    it('continues - list item', () => {
      const r = atEnd('- hello');
      assert.equal(r.newValue, '- hello\n- ');
      assert.equal(r.cursorPos, '- hello\n- '.length);
    });

    it('continues * list item', () => {
      const r = atEnd('* hello');
      assert.equal(r.newValue, '* hello\n* ');
      assert.equal(r.cursorPos, '* hello\n* '.length);
    });

    it('continues + list item', () => {
      const r = atEnd('+ hello');
      assert.equal(r.newValue, '+ hello\n+ ');
      assert.equal(r.cursorPos, '+ hello\n+ '.length);
    });

    it('continues numbered list and increments', () => {
      const r = atEnd('1. hello');
      assert.equal(r.newValue, '1. hello\n2. ');
      assert.equal(r.cursorPos, '1. hello\n2. '.length);
    });

    it('increments from higher numbers', () => {
      const r = atEnd('9. hello');
      assert.equal(r.newValue, '9. hello\n10. ');
      assert.equal(r.cursorPos, '9. hello\n10. '.length);
    });
  });

  describe('checkbox patterns', () => {
    it('continues - [ ] with unchecked checkbox', () => {
      const r = atEnd('- [ ] todo item');
      assert.equal(r.newValue, '- [ ] todo item\n- [ ] ');
      assert.equal(r.cursorPos, '- [ ] todo item\n- [ ] '.length);
    });

    it('continues - [x] with unchecked checkbox', () => {
      const r = atEnd('- [x] done item');
      assert.equal(r.newValue, '- [x] done item\n- [ ] ');
      assert.equal(r.cursorPos, '- [x] done item\n- [ ] '.length);
    });

    it('continues * [ ] with unchecked checkbox', () => {
      const r = atEnd('* [ ] todo item');
      assert.equal(r.newValue, '* [ ] todo item\n* [ ] ');
      assert.equal(r.cursorPos, '* [ ] todo item\n* [ ] '.length);
    });

    it('continues * [x] with unchecked checkbox', () => {
      const r = atEnd('* [x] done item');
      assert.equal(r.newValue, '* [x] done item\n* [ ] ');
      assert.equal(r.cursorPos, '* [x] done item\n* [ ] '.length);
    });

    it('continues numbered checkbox list', () => {
      const r = atEnd('1. [ ] todo item');
      assert.equal(r.newValue, '1. [ ] todo item\n2. [ ] ');
      assert.equal(r.cursorPos, '1. [ ] todo item\n2. [ ] '.length);
    });

    it('continues numbered checked checkbox with unchecked', () => {
      const r = atEnd('3. [x] done item');
      assert.equal(r.newValue, '3. [x] done item\n4. [ ] ');
      assert.equal(r.cursorPos, '3. [x] done item\n4. [ ] '.length);
    });
  });

  describe('indented variants', () => {
    it('preserves indent for - list', () => {
      const r = atEnd('  - hello');
      assert.equal(r.newValue, '  - hello\n  - ');
    });

    it('preserves indent for * [ ] checkbox', () => {
      const r = atEnd('    * [ ] task');
      assert.equal(r.newValue, '    * [ ] task\n    * [ ] ');
    });

    it('preserves indent for - [x] checkbox', () => {
      const r = atEnd('  - [x] done');
      assert.equal(r.newValue, '  - [x] done\n  - [ ] ');
    });

    it('preserves indent for numbered list', () => {
      const r = atEnd('   2. item');
      assert.equal(r.newValue, '   2. item\n   3. ');
    });

    it('preserves indent for numbered checkbox', () => {
      const r = atEnd('  1. [ ] task');
      assert.equal(r.newValue, '  1. [ ] task\n  2. [ ] ');
    });
  });

  describe('empty item removal (exit list mode)', () => {
    it('removes empty - prefix', () => {
      const r = atEnd('- first\n- ');
      assert.equal(r.newValue, '- first\n\n');
      assert.equal(r.cursorPos, '- first\n\n'.length);
    });

    it('removes empty * prefix', () => {
      const r = atEnd('* first\n* ');
      assert.equal(r.newValue, '* first\n\n');
    });

    it('removes empty numbered prefix', () => {
      const r = atEnd('1. first\n2. ');
      assert.equal(r.newValue, '1. first\n\n');
    });

    it('removes empty - [ ] prefix', () => {
      const r = atEnd('- [ ] task\n- [ ] ');
      assert.equal(r.newValue, '- [ ] task\n\n');
    });

    it('removes empty indented prefix', () => {
      const r = atEnd('  - item\n  - ');
      assert.equal(r.newValue, '  - item\n\n');
    });

    it('removes empty indented checkbox prefix', () => {
      const r = atEnd('  - [ ] task\n  - [ ] ');
      assert.equal(r.newValue, '  - [ ] task\n\n');
    });
  });

  describe('non-list lines', () => {
    it('returns null for plain text', () => {
      assert.equal(atEnd('hello world'), null);
    });

    it('returns null for empty string', () => {
      assert.equal(atEnd(''), null);
    });

    it('returns null for line without list prefix', () => {
      assert.equal(atEnd('some text here'), null);
    });

    it('returns null for marker without space after', () => {
      assert.equal(atEnd('-no space'), null);
    });
  });

  describe('mid-text cursor', () => {
    it('handles cursor in the middle of text', () => {
      const text = '- item one\n- item two\nsome other text';
      const cursor = '- item one'.length; // end of first line
      const r = autoListContinue(text, cursor);
      assert.equal(r.newValue, '- item one\n- \n- item two\nsome other text');
      assert.equal(r.cursorPos, '- item one\n- '.length);
    });

    it('handles cursor at end of checkbox line mid-text', () => {
      const text = '- [ ] first task\n- [ ] second task';
      const cursor = '- [ ] first task'.length;
      const r = autoListContinue(text, cursor);
      assert.equal(r.newValue, '- [ ] first task\n- [ ] \n- [ ] second task');
    });
  });
});
