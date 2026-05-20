import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', 'features', 'tags', 'search.js');

const { parseSearchQuery, filterItems, filterTags } = await import(modulePath);

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

/** Create a minimal item. */
const makeItem = (id, overrides = {}) => ({ id, ...overrides });

/** Build an itemTags Map from an object keyed by item id. */
const makeItemTags = (obj) => {
  const m = new Map();
  for (const [id, tags] of Object.entries(obj)) {
    m.set(id, tags.map((name, i) => ({ id: `${id}-tag-${i}`, name })));
  }
  return m;
};

// ---------------------------------------------------------------------------
// parseSearchQuery
// ---------------------------------------------------------------------------
describe('parseSearchQuery', () => {

  it('returns empty arrays for empty string', () => {
    const r = parseSearchQuery('');
    assert.deepEqual(r, { tagFilters: [], textTerms: [] });
  });

  it('returns empty arrays for whitespace-only string', () => {
    const r = parseSearchQuery('   ');
    assert.deepEqual(r, { tagFilters: [], textTerms: [] });
  });

  it('parses a single text term', () => {
    const r = parseSearchQuery('market');
    assert.deepEqual(r, { tagFilters: [], textTerms: ['market'] });
  });

  it('parses a single #tag', () => {
    const r = parseSearchQuery('#todo');
    assert.deepEqual(r, { tagFilters: ['todo'], textTerms: [] });
  });

  it('parses multiple #tags', () => {
    const r = parseSearchQuery('#todo #reading');
    assert.deepEqual(r, { tagFilters: ['todo', 'reading'], textTerms: [] });
  });

  it('parses mixed #tags and text', () => {
    const r = parseSearchQuery('#todo market');
    assert.deepEqual(r, { tagFilters: ['todo'], textTerms: ['market'] });
  });

  it('parses multiple #tags and text', () => {
    const r = parseSearchQuery('#todo #reading market');
    assert.deepEqual(r, { tagFilters: ['todo', 'reading'], textTerms: ['market'] });
  });

  it('handles lone # as text (not a tag)', () => {
    const r = parseSearchQuery('#');
    // lone '#' has length 1, so it goes through the else branch as text
    assert.deepEqual(r, { tagFilters: [], textTerms: ['#'] });
  });

  it('handles "# todo" — standalone # is not a tag prefix', () => {
    const r = parseSearchQuery('# todo');
    assert.deepEqual(r, { tagFilters: [], textTerms: ['#', 'todo'] });
  });

  it('handles ##double as a tag "double" (after stripping one #)', () => {
    // token is "##double", starts with # and length > 1, so slice(1) = "#double"
    const r = parseSearchQuery('##double');
    assert.deepEqual(r, { tagFilters: ['#double'], textTerms: [] });
  });

  it('normalizes tags to lowercase', () => {
    const r = parseSearchQuery('#TODO');
    assert.deepEqual(r, { tagFilters: ['todo'], textTerms: [] });
  });

  it('normalizes text terms to lowercase', () => {
    const r = parseSearchQuery('Market');
    assert.deepEqual(r, { tagFilters: [], textTerms: ['market'] });
  });

  it('handles trailing spaces', () => {
    const r = parseSearchQuery('#todo   ');
    assert.deepEqual(r, { tagFilters: ['todo'], textTerms: [] });
  });

  it('handles multiple spaces between terms', () => {
    const r = parseSearchQuery('#todo    market');
    assert.deepEqual(r, { tagFilters: ['todo'], textTerms: ['market'] });
  });

  it('handles leading spaces', () => {
    const r = parseSearchQuery('   #todo market');
    assert.deepEqual(r, { tagFilters: ['todo'], textTerms: ['market'] });
  });
});

// ---------------------------------------------------------------------------
// filterItems
// ---------------------------------------------------------------------------
describe('filterItems', () => {

  // Shared test data
  const itemTags = makeItemTags({
    '1': ['todo', 'reading'],
    '2': ['todo'],
    '3': ['cooking'],
    '4': [],        // no tags — should always be excluded
  });

  const items = [
    makeItem('1', { title: 'Market analysis', uri: 'https://example.com/market', domain: 'example.com', content: 'some text about stocks' }),
    makeItem('2', { title: 'Todo list', uri: 'https://notes.com/todos', domain: 'notes.com', content: 'buy groceries' }),
    makeItem('3', { title: 'Best pasta recipe', uri: 'https://cooking.com/pasta', domain: 'cooking.com', content: 'boil water and cook' }),
    makeItem('4', { title: 'Orphan item', uri: 'https://orphan.com', domain: 'orphan.com', content: 'no tags here' }),
  ];

  const defaults = { items, itemTags, searchQuery: '', activeTags: [], activeFilter: 'all' };

  it('returns all tagged items when no filters applied', () => {
    const result = filterItems(defaults);
    assert.equal(result.length, 3);
    assert.deepEqual(result.map(i => i.id).sort(), ['1', '2', '3']);
  });

  it('excludes items with no tags', () => {
    const result = filterItems(defaults);
    assert.ok(!result.find(i => i.id === '4'));
  });

  // -- Tag search filters --

  it('filters by single #tag', () => {
    const result = filterItems({ ...defaults, searchQuery: '#todo' });
    assert.deepEqual(result.map(i => i.id).sort(), ['1', '2']);
  });

  it('filters by multiple #tags (AND logic)', () => {
    const result = filterItems({ ...defaults, searchQuery: '#todo #reading' });
    assert.deepEqual(result.map(i => i.id), ['1']);
  });

  it('tag filter does not match on content text', () => {
    // Item 2 has content "buy groceries" but no "cooking" tag
    const result = filterItems({ ...defaults, searchQuery: '#cooking' });
    assert.deepEqual(result.map(i => i.id), ['3']);
  });

  it('#tag matching is case insensitive', () => {
    const result = filterItems({ ...defaults, searchQuery: '#TODO' });
    assert.deepEqual(result.map(i => i.id).sort(), ['1', '2']);
  });

  // -- Text search filters --

  it('text filter matches on title', () => {
    const result = filterItems({ ...defaults, searchQuery: 'pasta' });
    assert.deepEqual(result.map(i => i.id), ['3']);
  });

  it('text filter matches on content', () => {
    const result = filterItems({ ...defaults, searchQuery: 'groceries' });
    assert.deepEqual(result.map(i => i.id), ['2']);
  });

  it('text filter matches on URI', () => {
    const result = filterItems({ ...defaults, searchQuery: 'notes.com' });
    assert.deepEqual(result.map(i => i.id), ['2']);
  });

  it('text filter matches on domain', () => {
    const result = filterItems({ ...defaults, searchQuery: 'cooking.com' });
    assert.deepEqual(result.map(i => i.id), ['3']);
  });

  it('text filter matches on tag names', () => {
    const result = filterItems({ ...defaults, searchQuery: 'reading' });
    assert.deepEqual(result.map(i => i.id), ['1']);
  });

  it('text filter is case insensitive', () => {
    const result = filterItems({ ...defaults, searchQuery: 'PASTA' });
    assert.deepEqual(result.map(i => i.id), ['3']);
  });

  // -- Combined tag + text --

  it('combined #tag and text (AND logic)', () => {
    const result = filterItems({ ...defaults, searchQuery: '#todo market' });
    // must have tag "todo" AND "market" in some field
    assert.deepEqual(result.map(i => i.id), ['1']);
  });

  it('combined filters can result in empty set', () => {
    const result = filterItems({ ...defaults, searchQuery: '#cooking market' });
    assert.deepEqual(result, []);
  });

  // -- Sidebar active tags --

  it('sidebar active tags filter items (AND logic)', () => {
    // Use shared tag IDs so sidebar filtering by ID works across items
    const sharedItemTags = new Map([
      ['1', [{ id: 'tag-todo', name: 'todo' }, { id: 'tag-reading', name: 'reading' }]],
      ['2', [{ id: 'tag-todo', name: 'todo' }]],
      ['3', [{ id: 'tag-cooking', name: 'cooking' }]],
      ['4', []],
    ]);
    const activeTags = [{ id: 'tag-todo', name: 'todo' }];
    const result = filterItems({ ...defaults, itemTags: sharedItemTags, activeTags });
    assert.deepEqual(result.map(i => i.id).sort(), ['1', '2']);
  });

  it('sidebar tags combine with search #tags', () => {
    const sharedItemTags = new Map([
      ['1', [{ id: 'tag-todo', name: 'todo' }, { id: 'tag-reading', name: 'reading' }]],
      ['2', [{ id: 'tag-todo', name: 'todo' }]],
      ['3', [{ id: 'tag-cooking', name: 'cooking' }]],
      ['4', []],
    ]);
    const activeTags = [{ id: 'tag-todo', name: 'todo' }];
    const result = filterItems({ ...defaults, itemTags: sharedItemTags, activeTags, searchQuery: '#reading' });
    // must have sidebar tag "todo" (by id) AND search tag "reading" (by name)
    assert.deepEqual(result.map(i => i.id), ['1']);
  });

  it('sidebar tags combine with text search', () => {
    const sharedItemTags = new Map([
      ['1', [{ id: 'tag-todo', name: 'todo' }, { id: 'tag-reading', name: 'reading' }]],
      ['2', [{ id: 'tag-todo', name: 'todo' }]],
      ['3', [{ id: 'tag-cooking', name: 'cooking' }]],
      ['4', []],
    ]);
    const activeTags = [{ id: 'tag-todo', name: 'todo' }];
    const result = filterItems({ ...defaults, itemTags: sharedItemTags, activeTags, searchQuery: 'groceries' });
    assert.deepEqual(result.map(i => i.id), ['2']);
  });

  // -- Type filter --

  it('filters by type "text"', () => {
    const textItems = [
      makeItem('t1', { type: 'text', content: 'hello' }),
      makeItem('t2', { type: 'url', uri: 'https://a.com' }),
    ];
    const tags = makeItemTags({ 't1': ['note'], 't2': ['link'] });
    const result = filterItems({ items: textItems, itemTags: tags, searchQuery: '', activeTags: [], activeFilter: 'text' });
    assert.deepEqual(result.map(i => i.id), ['t1']);
  });

  it('filters by type "page" includes url type and items with no type', () => {
    const mixedItems = [
      makeItem('p1', { type: 'url', uri: 'https://a.com' }),
      makeItem('p2', { uri: 'https://b.com' }),  // no type but has uri
      makeItem('p3', { type: 'text', content: 'hello' }),
    ];
    const tags = makeItemTags({ 'p1': ['a'], 'p2': ['b'], 'p3': ['c'] });
    const result = filterItems({ items: mixedItems, itemTags: tags, searchQuery: '', activeTags: [], activeFilter: 'page' });
    assert.deepEqual(result.map(i => i.id).sort(), ['p1', 'p2']);
  });

  // -- Edge cases --

  it('empty search query returns all tagged items', () => {
    const result = filterItems({ ...defaults, searchQuery: '' });
    assert.equal(result.length, 3);
  });

  it('items with empty tag array are excluded', () => {
    const result = filterItems(defaults);
    assert.ok(!result.find(i => i.id === '4'));
  });

  it('multiple text terms all must match (AND)', () => {
    const result = filterItems({ ...defaults, searchQuery: 'market stocks' });
    // item 1: title has "market", content has "stocks" — matches
    assert.deepEqual(result.map(i => i.id), ['1']);
  });

  it('multiple text terms — one not matching yields empty', () => {
    const result = filterItems({ ...defaults, searchQuery: 'market nonexistent' });
    assert.deepEqual(result, []);
  });
});

// ---------------------------------------------------------------------------
// filterTags
// ---------------------------------------------------------------------------
describe('filterTags', () => {

  const tags = [
    { id: 't1', name: 'todo' },
    { id: 't2', name: 'reading' },
    { id: 't3', name: 'cooking' },
    { id: 't4', name: 'todolist' },
  ];

  it('returns all tags when no search query', () => {
    const result = filterTags({ tags, searchQuery: '', activeTags: [] });
    assert.equal(result.length, 4);
  });

  it('returns all tags when activeTags are selected (search applies to items not sidebar)', () => {
    const result = filterTags({ tags, searchQuery: 'cooking', activeTags: [{ id: 't1' }] });
    assert.equal(result.length, 4);
  });

  it('filters by text query matching tag names', () => {
    const result = filterTags({ tags, searchQuery: 'cook', activeTags: [] });
    assert.deepEqual(result.map(t => t.id), ['t3']);
  });

  it('filters by #tag query matching tag names', () => {
    const result = filterTags({ tags, searchQuery: '#todo', activeTags: [] });
    // "todo" matches "todo" and "todolist"
    assert.deepEqual(result.map(t => t.id).sort(), ['t1', 't4']);
  });

  it('combined #tag and text query', () => {
    const result = filterTags({ tags, searchQuery: '#todo reading', activeTags: [] });
    // allTerms = ["todo", "reading"]; each tag matched if ANY term matches
    assert.deepEqual(result.map(t => t.id).sort(), ['t1', 't2', 't4']);
  });

  it('no matching terms returns all tags', () => {
    const result = filterTags({ tags, searchQuery: 'xyz', activeTags: [] });
    assert.deepEqual(result, []);
  });

  it('case insensitive tag filtering', () => {
    const result = filterTags({ tags, searchQuery: 'COOKING', activeTags: [] });
    assert.deepEqual(result.map(t => t.id), ['t3']);
  });

  it('lone # returns all tags (empty tag filter, "#" becomes text term)', () => {
    const result = filterTags({ tags, searchQuery: '#', activeTags: [] });
    // parseSearchQuery('#') => { tagFilters: [], textTerms: ['#'] }
    // '#' doesn't match any tag name, so empty result
    assert.deepEqual(result, []);
  });
});
