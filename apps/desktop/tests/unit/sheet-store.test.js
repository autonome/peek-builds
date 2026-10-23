/**
 * Unit tests for features/sheets/sheet-store.js.
 *
 * Run via: node --test tests/unit/sheet-store.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', 'features', 'sheets', 'sheet-store.js');
const { mergeLegacySheets, loadSheetsMap, loadSheet, saveSheet } = await import(modulePath);

const fakeApi = (initial) => {
  const store = { ...initial };
  const sets = [];
  return {
    store,
    sets,
    settings: {
      get: async (key) => ({ success: true, data: store[key] ?? null, value: store[key] ?? null }),
      set: async (key, value) => { sets.push(key); store[key] = structuredClone(value); return { success: true }; },
    },
  };
};

const card = { id: 'c1', url: 'https://example.com' };

describe('mergeLegacySheets', () => {
  it('takes cards from the legacy config and the name from the map', () => {
    const map = { 'sheet:a': { version: 1, name: 'Mine', createdAt: 5, items: [] } };
    const legacy = { 'sheet:a': { version: 1, name: 'Untitled Sheet', createdAt: 9, items: [card] } };
    const { map: out, changed } = mergeLegacySheets(map, legacy);
    assert.equal(changed, true);
    assert.equal(out['sheet:a'].name, 'Mine');
    assert.equal(out['sheet:a'].createdAt, 5);
    assert.deepEqual(out['sheet:a'].items, [card]);
    assert.equal(out['sheet:a'].legacyMerged, true);
  });

  it('keeps the map entry as is when there is no legacy config', () => {
    const map = { 'sheet:a': { name: 'Mine', items: [] } };
    const { map: out } = mergeLegacySheets(map, {});
    assert.deepEqual(out['sheet:a'], { name: 'Mine', items: [], legacyMerged: true });
  });

  it('keeps map cards when legacy has none', () => {
    const map = { 'sheet:a': { name: 'Mine', items: [card] } };
    const legacy = { 'sheet:a': { name: 'x', items: [] } };
    assert.deepEqual(mergeLegacySheets(map, legacy).map['sheet:a'].items, [card]);
  });

  it('does not touch an entry already merged, and does not mutate input', () => {
    const map = { 'sheet:a': { name: 'Mine', items: [], legacyMerged: true } };
    const legacy = { 'sheet:a': { items: [card] } };
    const res = mergeLegacySheets(map, legacy);
    assert.equal(res.changed, false);
    assert.deepEqual(res.map['sheet:a'].items, []);
    assert.equal(map['sheet:a'].legacyMerged, true);
  });

  it('survives a missing or malformed map', () => {
    assert.deepEqual(mergeLegacySheets(null, {}), { map: {}, changed: false });
    assert.deepEqual(mergeLegacySheets([], {}), { map: {}, changed: false });
  });
});

describe('loadSheetsMap / loadSheet / saveSheet', () => {
  it('migrates legacy cards once and persists the result', async () => {
    const api = fakeApi({
      sheets: { 'sheet:a': { name: 'Mine', items: [] } },
      'sheet:a': { name: 'Untitled Sheet', items: [card] },
    });
    const cfg = await loadSheet(api, 'a');
    assert.deepEqual(cfg.items, [card]);
    assert.deepEqual(api.sets, ['sheets']);
    // second read does no further writing
    await loadSheetsMap(api);
    assert.deepEqual(api.sets, ['sheets']);
    // the legacy key is left in place
    assert.deepEqual(api.store['sheet:a'].items, [card]);
  });

  it('returns {} with no sheets and null for an unknown sheet', async () => {
    const api = fakeApi({});
    assert.deepEqual(await loadSheetsMap(api), {});
    assert.equal(await loadSheet(api, 'zzz'), null);
    assert.deepEqual(api.sets, []);
  });

  it('reads a map returned under either result field', async () => {
    const api = fakeApi({ sheets: { 'sheet:a': { name: 'A', items: [], legacyMerged: true } } });
    api.settings.get = async () => ({ value: api.store.sheets });
    assert.equal((await loadSheet(api, 'a')).name, 'A');
  });

  it('saveSheet writes into the map and keeps other sheets', async () => {
    const api = fakeApi({
      sheets: {
        'sheet:a': { name: 'A', items: [], legacyMerged: true },
        'sheet:b': { name: 'B', items: [], legacyMerged: true },
      },
    });
    await saveSheet(api, 'a', { name: 'A', items: [card], maximized: true });
    assert.deepEqual(api.store.sheets['sheet:a'].items, [card]);
    assert.equal(api.store.sheets['sheet:a'].maximized, true);
    assert.equal(api.store.sheets['sheet:b'].name, 'B');
  });
});
