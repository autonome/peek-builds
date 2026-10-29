/**
 * Unit tests for extraParamRows / prependRows in renderer/cmd/param-rows.js, and the
 * edit command's declaration of the hook.
 * Run via: node --test tests/unit/cmd-param-rows.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { extraParamRows, prependRows } = await import(join(__dirname, '..', '..', 'renderer', 'cmd', 'param-rows.js'));

describe('extraParamRows', () => {
  it('yields no rows for a param def without the hook', async () => {
    assert.deepEqual(await extraParamRows({ type: 'item' }, '#todo', {}), []);
    assert.deepEqual(await extraParamRows(null, '#todo', {}), []);
  });

  it('awaits the hook and passes typed text and context', async () => {
    const ctx = { datastore: {} };
    let seen;
    const def = { extraRows: async (text, c) => { seen = [text, c]; return [{ title: 'x' }]; } };
    assert.deepEqual(await extraParamRows(def, 'abc', ctx), [{ title: 'x' }]);
    assert.deepEqual(seen, ['abc', ctx]);
  });

  it('treats a null result as no rows', async () => {
    assert.deepEqual(await extraParamRows({ extraRows: () => null }, 'a', {}), []);
  });
});

describe('prependRows', () => {
  it('puts extra rows before the suggestions', () => {
    assert.deepEqual(prependRows([{ id: 1 }], [{ id: 2 }]), [{ id: 1 }, { id: 2 }]);
  });

  it('returns the suggestions unchanged when there are no extra rows', () => {
    const s = [{ id: 2 }];
    assert.equal(prependRows([], s), s);
  });
});
