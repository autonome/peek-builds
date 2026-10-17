import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  normalizeEditableFocusReport,
  shouldDeferEscapeToEditable,
  shouldDeferEscapeNow,
  DEFER_ESCAPE_TO_EDITABLE,
} from './hybrid-editable-escape.js';

describe('shouldDeferEscapeNow', () => {
  const withText = { editable: true, empty: false };
  it('is off by default, even for an editable holding text', () => {
    assert.strictEqual(DEFER_ESCAPE_TO_EDITABLE, false);
    assert.strictEqual(shouldDeferEscapeNow(withText), false);
  });
  it('follows the predicate when enabled', () => {
    assert.strictEqual(shouldDeferEscapeNow(withText, true), true);
    assert.strictEqual(shouldDeferEscapeNow({ editable: true, empty: true }, true), false);
  });
});

describe('shouldDeferEscapeToEditable', () => {
  it('defers when an editable with text is focused', () => {
    assert.strictEqual(shouldDeferEscapeToEditable({ editable: true, empty: false }), true);
  });
  it('does not defer when the focused editable is empty', () => {
    assert.strictEqual(shouldDeferEscapeToEditable({ editable: true, empty: true }), false);
  });
  it('does not defer when nothing editable is focused', () => {
    assert.strictEqual(shouldDeferEscapeToEditable({ editable: false, empty: true }), false);
    assert.strictEqual(shouldDeferEscapeToEditable({ editable: false, empty: false }), false);
    assert.strictEqual(shouldDeferEscapeToEditable(undefined), false);
  });
});

describe('normalizeEditableFocusReport', () => {
  it('reads the object payload', () => {
    assert.deepStrictEqual(normalizeEditableFocusReport({ editable: true, empty: true }), { editable: true, empty: true });
    assert.deepStrictEqual(normalizeEditableFocusReport({ editable: true, empty: false }), { editable: true, empty: false });
  });
  it('reads a bare true as editable with text', () => {
    assert.deepStrictEqual(normalizeEditableFocusReport(true), { editable: true, empty: false });
  });
  it('collapses anything else to no editable', () => {
    for (const p of [false, null, undefined, 'x', 1, {}, { editable: 'yes' }]) {
      assert.strictEqual(normalizeEditableFocusReport(p).editable, false);
    }
  });
});
