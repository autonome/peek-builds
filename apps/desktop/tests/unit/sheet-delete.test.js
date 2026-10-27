/**
 * Unit tests for sheet delete/create in features/sheets/sheet-store.js and
 * the shared card-view window params.
 *
 * Run via: node --test tests/unit/sheet-delete.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktop = join(__dirname, '..', '..');
const { withoutSheet, deleteSheet, createSheet, loadSheetsMap } =
  await import(join(desktop, 'features', 'sheets', 'sheet-store.js'));
const { cardViewWindowParams } =
  await import(join(desktop, 'renderer', 'lib', 'card-view-params.js'));

const fakeApi = (initial) => {
  const store = { ...initial };
  return {
    store,
    settings: {
      get: async (key) => ({ success: true, data: store[key] ?? null }),
      set: async (key, value) => { store[key] = structuredClone(value); return { success: true }; },
    },
  };
};

const entry = (name) => ({ version: 1, name, items: [], legacyMerged: true });

describe('withoutSheet', () => {
  it('drops only the named sheet and does not mutate', () => {
    const map = { 'sheet:a': entry('A'), 'sheet:b': entry('B') };
    const out = withoutSheet(map, 'a');
    assert.deepEqual(Object.keys(out), ['sheet:b']);
    assert.deepEqual(Object.keys(map), ['sheet:a', 'sheet:b']);
  });

  it('returns the same map when the sheet is absent', () => {
    const map = { 'sheet:a': entry('A') };
    assert.equal(withoutSheet(map, 'zzz'), map);
  });
});

describe('deleteSheet', () => {
  it('removes the sheet from the stored map and keeps the others', async () => {
    const api = fakeApi({ sheets: { 'sheet:a': entry('A'), 'sheet:b': entry('B') } });
    await deleteSheet(api, 'a');
    assert.deepEqual(Object.keys(api.store.sheets), ['sheet:b']);
  });
});

describe('createSheet', () => {
  it('adds a named empty sheet to the map', async () => {
    const api = fakeApi({});
    const { sheetId, key } = await createSheet(api, 'Fresh');
    const map = await loadSheetsMap(api);
    assert.equal(map[key].name, 'Fresh');
    assert.deepEqual(map[key].items, []);
    assert.equal(key, `sheet:${sheetId}`);
  });
});

describe('cardViewWindowParams', () => {
  it('builds workspace transparent params keyed by url', () => {
    const p = cardViewWindowParams({ url: 'peek://x/home.html', title: 'X' });
    assert.equal(p.key, 'peek://x/home.html');
    assert.equal(p.role, 'workspace');
    assert.equal(p.transparent, true);
    assert.equal(p.title, 'X');
    assert.equal(p.width, 800);
  });

  it('lets size and extra params override', () => {
    const p = cardViewWindowParams({ url: 'u', title: 't', width: 500, extra: { height: 321 } });
    assert.equal(p.width, 500);
    assert.equal(p.height, 321);
  });
});
