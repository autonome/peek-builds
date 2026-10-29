/**
 * Unit tests for renderer/cmd/panel-logic.js trimUrlOnlyInput.
 *
 * Run via: node --test tests/unit/cmd-trim-url.test.js
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { trimUrlOnlyInput } from '../../renderer/cmd/panel-logic.js';

// Stand-in for the panel's URL validator: a single http(s) token.
const isUrl = (s) => /^https?:\/\/\S+$/.test(s);

describe('trimUrlOnlyInput', () => {
  it('trims a leading space around a URL', () => {
    assert.strictEqual(trimUrlOnlyInput(' https://example.com/x', isUrl), 'https://example.com/x');
  });

  it('trims a trailing space around a URL', () => {
    assert.strictEqual(trimUrlOnlyInput('https://example.com/x  ', isUrl), 'https://example.com/x');
  });

  it('trims both sides', () => {
    assert.strictEqual(trimUrlOnlyInput('\t https://example.com \n', isUrl), 'https://example.com');
  });

  it('leaves a URL with other words untouched', () => {
    assert.strictEqual(trimUrlOnlyInput('note https://x.com', isUrl), 'note https://x.com');
    assert.strictEqual(trimUrlOnlyInput(' https://x.com/a b ', isUrl), ' https://x.com/a b ');
  });

  it('leaves a command name with a trailing space untouched', () => {
    assert.strictEqual(trimUrlOnlyInput('note ', isUrl), 'note ');
  });

  it('leaves already-trimmed and empty input untouched', () => {
    assert.strictEqual(trimUrlOnlyInput('https://example.com', isUrl), 'https://example.com');
    assert.strictEqual(trimUrlOnlyInput('', isUrl), '');
  });
});
