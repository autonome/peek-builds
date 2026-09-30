/**
 * Unit tests for the pure item-suggestion helpers.
 *
 * Run via: node --test tests/unit/item-suggestions.test.js
 * (leaf module — no DOM/electron deps, imported directly.)
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', 'renderer', 'cmd', 'item-suggestions.js');
const { findTagByName, filterTaggedItems, toItemSuggestion } = await import(modulePath);

const TAGS = [
  { id: 't1', name: 'todo' },
  { id: 't2', name: 'Reading' }
];

describe('findTagByName', () => {
  it('finds a tag by its exact name', () => {
    assert.deepStrictEqual(findTagByName(TAGS, 'todo'), { id: 't1', name: 'todo' });
  });

  it('matches ignoring case in either direction', () => {
    assert.strictEqual(findTagByName(TAGS, 'TODO').id, 't1');
    assert.strictEqual(findTagByName(TAGS, 'reading').id, 't2');
  });

  it('returns undefined when the tag does not exist', () => {
    assert.strictEqual(findTagByName(TAGS, 'nope'), undefined);
  });
});

describe('filterTaggedItems', () => {
  const items = [
    { id: 'a', type: 'text', title: 'Buy milk', content: 'from the corner shop', updatedAt: 3000 },
    { id: 'b', type: 'text', title: 'Call plumber', content: 'about the LEAKY tap', updatedAt: 5000 },
    { id: 'c', type: 'link', title: 'Read spec', content: 'milk run planning', updatedAt: 1000 }
  ];

  it('matches the search text against the title, case-insensitively', () => {
    const result = filterTaggedItems(items, { search: 'PLUMBER' });
    assert.deepStrictEqual(result.map(i => i.id), ['b']);
  });

  it('matches the search text against the content, case-insensitively', () => {
    const result = filterTaggedItems(items, { search: 'leaky' });
    assert.deepStrictEqual(result.map(i => i.id), ['b']);
  });

  it('keeps everything when the search is blank', () => {
    assert.strictEqual(filterTaggedItems(items, { search: '' }).length, 3);
    assert.strictEqual(filterTaggedItems(items, {}).length, 3);
  });

  it('sorts by updatedAt with the newest first', () => {
    const result = filterTaggedItems(items);
    assert.deepStrictEqual(result.map(i => i.id), ['b', 'a', 'c']);
  });

  it('caps the result at limit', () => {
    const result = filterTaggedItems(items, { limit: 2 });
    assert.deepStrictEqual(result.map(i => i.id), ['b', 'a']);
  });

  it('applies a type filter only when itemType is passed', () => {
    assert.deepStrictEqual(
      filterTaggedItems(items, { itemType: 'text' }).map(i => i.id),
      ['b', 'a']
    );
    // Without itemType the 'link' item is kept.
    assert.ok(filterTaggedItems(items).some(i => i.id === 'c'));
  });
});

describe('toItemSuggestion', () => {
  it('strips a heading marker from the first content line', () => {
    const suggestion = toItemSuggestion({ id: 'x', content: '## Groceries\nmilk' });
    assert.strictEqual(suggestion.title, 'Groceries');
  });

  it('truncates a long first line and marks it with an ellipsis', () => {
    const long = 'a'.repeat(80);
    const suggestion = toItemSuggestion({ id: 'x', content: long });
    assert.strictEqual(suggestion.title, 'a'.repeat(60) + '...');
  });

  it('falls back to Untitled when the content is empty', () => {
    assert.strictEqual(toItemSuggestion({ id: 'x', content: '' }).title, 'Untitled');
    assert.strictEqual(toItemSuggestion({ id: 'x' }).title, 'Untitled');
  });

  it('uses the item id as the value and carries the item through', () => {
    const item = { id: 'item-42', content: 'hello' };
    const suggestion = toItemSuggestion(item);
    assert.strictEqual(suggestion.value, 'item-42');
    assert.strictEqual(suggestion._item, item);
  });

  it('gives an empty subtitle when the item has no updatedAt', () => {
    assert.strictEqual(toItemSuggestion({ id: 'x', content: 'hello' }).subtitle, '');
  });

  it('gives the locale date as the subtitle when updatedAt is set', () => {
    const updatedAt = Date.UTC(2026, 0, 5);
    const suggestion = toItemSuggestion({ id: 'x', content: 'hello', updatedAt });
    assert.strictEqual(suggestion.subtitle, new Date(updatedAt).toLocaleDateString());
  });
});
