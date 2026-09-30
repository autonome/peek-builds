import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  normalizeEditableFocusReport,
  shouldDeferEscapeToEditable,
} from './hybrid-editable-escape.js';

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
