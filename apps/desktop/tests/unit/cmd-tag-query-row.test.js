/**
 * Unit tests for tagQueryRow in renderer/cmd/tag-query-row.js: the first param
 * suggestion for `edit #todo`, which runs the command with the typed text.
 * Run via: node --test tests/unit/cmd-tag-query-row.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { tagQueryRow } = await import(join(__dirname, '..', '..', 'renderer', 'cmd', 'tag-query-row.js'));

const itemParam = { type: 'item', itemType: 'text' };

function fakeDatastore() {
  const tags = [{ id: 't1', name: 'todo' }, { id: 't2', name: 'today' }];
  const byTag = {
    t1: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    t2: [{ id: 'b' }, { id: 'c' }, { id: 'd' }],
  };
  return {
    getTagsByFrecency: async () => ({ success: true, data: tags }),
    getItemsByTag: async (id) => ({ success: true, data: byTag[id] || [] }),
  };
}

describe('tagQueryRow', () => {
  it('counts items for a single tag and runs the typed text', async () => {
    const row = await tagQueryRow(itemParam, '#todo', fakeDatastore());
    assert.equal(row.title, 'All items tagged #todo (3)');
    assert.equal(row.runTypedText, true);
    assert.equal(row._item, undefined);
  });

  it('counts the intersection for several tags', async () => {
    const row = await tagQueryRow(itemParam, '#todo #today', fakeDatastore());
    assert.equal(row.title, 'All items tagged #todo #today (2)');
  });

  it('reports count 0 and says so for an unknown tag', async () => {
    const row = await tagQueryRow(itemParam, '#todo #nope', fakeDatastore());
    assert.equal(row.title, 'All items tagged #todo #nope (0)');
    assert.equal(row.subtitle, 'unknown tag');
  });

  it('returns null for plain text, mixed text, and empty text', async () => {
    const ds = fakeDatastore();
    assert.equal(await tagQueryRow(itemParam, 'foo', ds), null);
    assert.equal(await tagQueryRow(itemParam, '#todo foo', ds), null);
    assert.equal(await tagQueryRow(itemParam, '', ds), null);
  });

  it('returns null for a param that is not an item param', async () => {
    assert.equal(await tagQueryRow({ type: 'tag' }, '#todo', fakeDatastore()), null);
    assert.equal(await tagQueryRow(null, '#todo', fakeDatastore()), null);
  });
});
