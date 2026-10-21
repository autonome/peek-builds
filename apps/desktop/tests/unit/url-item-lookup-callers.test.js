import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Tile scripts depend on window.app, so the functions under test are cut out of
// the real source and run against a fake datastore. The fake mirrors the real
// behaviours that matter: queryItems substring-matches the RAW url, while
// findUrlItem canonicalizes (non-root trailing slash stripped) and matches exactly.

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function extract(file, startMarker, endMarker) {
  const src = readFileSync(path.join(desktop, file), 'utf8');
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `${startMarker} not found in ${file}`);
  const end = src.indexOf(endMarker, start);
  assert.ok(end > start, `end of ${startMarker} not found in ${file}`);
  return src.slice(start, end + endMarker.length);
}

const canonical = (u) => {
  const x = new URL(u);
  if (x.pathname.length > 1 && x.pathname.endsWith('/')) x.pathname = x.pathname.slice(0, -1);
  return x.toString();
};

function makeApi(stored) {
  const calls = { updateItem: [], addItem: [] };
  const api = {
    datastore: {
      queryItems: async ({ search }) => ({
        success: true,
        data: stored.filter((i) => i.content.includes(search)),
      }),
      findUrlItem: async (url) => ({
        success: true,
        data: stored.find((i) => canonical(i.content) === canonical(url)) || null,
      }),
      addItem: async (type, opts) => {
        calls.addItem.push(opts);
        return { success: true, data: { id: 'new' } };
      },
      updateItem: async (id, opts) => { calls.updateItem.push([id, opts]); return { success: true }; },
      updateItemTitle: async () => ({ success: true }),
      updateItemFavicon: async () => ({ success: true }),
    },
  };
  return { api, calls };
}

describe('url item lookup for slash-terminated urls', () => {
  it('groups getOrCreateUrlItem reuses the stored slash-less item', async () => {
    const normalizeSrc = extract('features/groups/group-logic.js', 'const normalizeUrlForCompare = ', '\n};\n');
    const fnSrc = extract('features/groups/home.js', 'const getOrCreateUrlItem = ', '\n};\n');
    const { api, calls } = makeApi([{ id: 'a1', content: 'https://example.com/post' }]);
    const getOrCreateUrlItem = new Function('api', `${normalizeSrc}\n${fnSrc}\nreturn getOrCreateUrlItem;`)(api);
    const item = await getOrCreateUrlItem('https://example.com/post/');
    assert.equal(item.id, 'a1');
    assert.equal(calls.addItem.length, 0);
  });

  it('entities enrichUrlItem updates the stored slash-less item', async () => {
    const fnSrc = extract('features/entities/background.js', 'async function enrichUrlItem(', '\n}\n');
    const { api, calls } = makeApi([{ id: 'a1', content: 'https://example.com/post', metadata: '{}' }]);
    const enrich = new Function('api', `${fnSrc}\nreturn enrichUrlItem;`)(api);
    await enrich('https://example.com/post/', { title: 'T' });
    assert.equal(calls.updateItem.length, 1);
    assert.equal(calls.updateItem[0][0], 'a1');
  });
});
