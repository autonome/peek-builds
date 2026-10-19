/**
 * Unit tests for renderer/cmd/completers.js — parameter completion/suggestion providers.
 *
 * Covers completeEnum (static values and rich options) and completeTag (frecency-ordered tags
 * fetched through window.app.datastore, behind a 5-second cache).
 *
 * The module reads `window.app` at import time, so the renderer global is stubbed before the
 * dynamic import. `currentTags` is what the stubbed datastore answers with; because fetchTags()
 * caches for TAG_CACHE_TTL, every completeTag case calls invalidateCache() after setting it so no
 * case inherits the previous one's tag list.
 *
 * Run via: node --test tests/unit/completers.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let currentTags = [];

globalThis.window = {
  app: {
    datastore: {
      getTagsByFrecency: async () => ({ success: true, data: currentTags }),
    },
  },
};

const modulePath = join(__dirname, '..', '..', 'renderer', 'cmd', 'completers.js');
const { completeEnum, completeTag, limitShown, invalidateCache } = await import(modulePath);
const { rankByUsage } = await import(join(__dirname, '..', '..', 'renderer', 'cmd', 'usage-rank.js'));

/** Point the stubbed datastore at a tag list and drop the TTL cache. */
function useTags(tags) {
  currentTags = tags;
  invalidateCache();
}

describe('completeEnum', () => {
  const paramDef = { type: 'enum', values: ['red', 'green', 'blue', 'grey'] };

  it('returns all values when partial is empty', () => {
    const results = completeEnum('', new Set(), paramDef);
    assert.equal(results.length, 4);
    assert.deepEqual(results.map(r => r.value), ['red', 'green', 'blue', 'grey']);
  });

  it('filters by partial match', () => {
    const results = completeEnum('gr', new Set(), paramDef);
    assert.deepEqual(results.map(r => r.value), ['green', 'grey']);
  });

  it('is case-insensitive', () => {
    const results = completeEnum('GR', new Set(), paramDef);
    assert.deepEqual(results.map(r => r.value), ['green', 'grey']);
  });

  it('excludes already-used values', () => {
    const results = completeEnum('', new Set(['red', 'blue']), paramDef);
    assert.deepEqual(results.map(r => r.value), ['green', 'grey']);
  });

  it('combines partial filtering and exclusion', () => {
    const results = completeEnum('gr', new Set(['green']), paramDef);
    assert.deepEqual(results.map(r => r.value), ['grey']);
  });

  it('returns empty when nothing matches', () => {
    const results = completeEnum('xyz', new Set(), paramDef);
    assert.equal(results.length, 0);
  });

  it('returns empty when all excluded', () => {
    const results = completeEnum('', new Set(['red', 'green', 'blue', 'grey']), paramDef);
    assert.equal(results.length, 0);
  });

  describe('with prefix', () => {
    const prefixed = { type: 'enum', values: ['high', 'medium', 'low'], prefix: '!' };

    it('adds prefix to title and value', () => {
      const results = completeEnum('', new Set(), prefixed);
      assert.deepEqual(results.map(r => r.value), ['!high', '!medium', '!low']);
      assert.deepEqual(results.map(r => r.title), ['!high', '!medium', '!low']);
    });

    it('strips prefix from partial before matching', () => {
      const results = completeEnum('!hi', new Set(), prefixed);
      assert.deepEqual(results.map(r => r.value), ['!high']);
    });

    it('matches without prefix typed too', () => {
      const results = completeEnum('hi', new Set(), prefixed);
      assert.deepEqual(results.map(r => r.value), ['!high']);
    });
  });

  describe('with rich options', () => {
    const richDef = {
      type: 'enum',
      options: [
        { value: 'reader', title: 'Reader view', subtitle: 'Strip page chrome' },
        { value: 'raw', title: 'Raw view' },
      ],
    };

    it('takes title and subtitle from the option, value from opt.value', () => {
      const results = completeEnum('', new Set(), richDef);
      assert.deepEqual(results, [
        { title: 'Reader view', subtitle: 'Strip page chrome', value: 'reader' },
        { title: 'Raw view', subtitle: '', value: 'raw' },
      ]);
    });

    it('matches the partial against opt.value', () => {
      const results = completeEnum('ra', new Set(), richDef);
      assert.deepEqual(results.map(r => r.value), ['raw']);
    });
  });

  describe('matching anywhere in the name', () => {
    const projects = {
      type: 'enum',
      options: [
        { value: 'p1', title: 'Client Projects' },
        { value: 'p2', title: 'Projector Manuals' },
        { value: 'p3', title: 'Side-project ideas' },
        { value: 'p4', title: 'Reprojection' },
        { value: 'p5', title: 'Taxes' },
      ],
    };

    it('finds an option by a word inside its title', () => {
      const results = completeEnum('proj', new Set(), projects);
      assert.deepEqual(results.map(r => r.value), ['p2', 'p1', 'p3', 'p4']);
    });

    it('orders by tier, keeping the provider order within a tier', () => {
      const def = { type: 'enum', values: ['xx-red', 'redo', 'bored', 'red', 'a_red'] };
      const results = completeEnum('red', new Set(), def);
      assert.deepEqual(results.map(r => r.value), ['red', 'redo', 'xx-red', 'a_red', 'bored']);
    });

    it('matches a plain value in the middle', () => {
      const def = { type: 'enum', values: ['alpha', 'beta'] };
      assert.deepEqual(completeEnum('lph', new Set(), def).map(r => r.value), ['alpha']);
    });

    it('still excludes used values', () => {
      const results = completeEnum('proj', new Set(['p2']), projects);
      assert.deepEqual(results.map(r => r.value), ['p1', 'p3', 'p4']);
    });
  });
});

describe('completeTag', () => {
  const tags = [
    { name: 'todo', frequency: 12 },
    { name: 'tools', frequency: 8 },
    { name: 'reading', frequency: 5 },
    { name: 'recipe', frequency: 3 },
    { name: 'reference', frequency: 1 },
  ];
  const paramDef = { type: 'tag' };

  it('returns all tags when partial is empty', async () => {
    useTags(tags);
    const results = await completeTag('', new Set(), paramDef);
    assert.equal(results.length, 5);
  });

  it('filters by partial match', async () => {
    useTags(tags);
    const results = await completeTag('to', new Set(), paramDef);
    assert.deepEqual(results.map(r => r.value), ['todo', 'tools']);
  });

  it('is case-insensitive', async () => {
    useTags(tags);
    const results = await completeTag('RE', new Set(), paramDef);
    assert.deepEqual(results.map(r => r.value), ['reading', 'recipe', 'reference']);
  });

  it('excludes already-used tags', async () => {
    useTags(tags);
    const results = await completeTag('to', new Set(['todo']), paramDef);
    assert.deepEqual(results.map(r => r.value), ['tools']);
  });

  it('includes frequency in subtitle', async () => {
    useTags(tags);
    const results = await completeTag('todo', new Set(), paramDef);
    assert.equal(results[0].subtitle, 'used 12x');
  });

  it('shows 0x for missing frequency', async () => {
    useTags([{ name: 'orphan' }]);
    const results = await completeTag('', new Set(), paramDef);
    assert.equal(results[0].subtitle, 'used 0x');
  });

  it('caps the candidates at 200', async () => {
    useTags(Array.from({ length: 250 }, (_, i) => ({ name: `tag${i}`, frequency: 0 })));
    const results = await completeTag('', new Set(), paramDef);
    assert.equal(results.length, 200);
  });

  it('a tag used often but beyond the completer top 20 reaches the shown rows', async () => {
    useTags([
      ...Array.from({ length: 25 }, (_, i) => ({ name: `tag${i}`, frequency: 100 })),
      { name: 'favorite', frequency: 0 },
    ]);
    const candidates = await completeTag('', new Set(), paramDef);
    const usage = { cmd: { favorite: Date.now() } };
    const shown = limitShown(paramDef, rankByUsage(candidates, usage, 'cmd', Date.now(), '', ''));
    assert.equal(shown.length, 20);
    assert.equal(shown[0].value, 'favorite');
  });

  it('limitShown leaves enum suggestions uncut', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ value: `v${i}` }));
    assert.equal(limitShown({ type: 'enum' }, many).length, 30);
    assert.equal(limitShown({ type: 'item' }, many).length, 20);
  });

  describe('matching anywhere in the name', () => {
    const named = [
      { name: 'bored', frequency: 9 },
      { name: 'side-red', frequency: 8 },
      { name: 'redo', frequency: 7 },
      { name: 'red', frequency: 1 },
      { name: 'a_red', frequency: 0 },
    ];

    it('orders by tier, keeping the frecency order within a tier', async () => {
      useTags(named);
      const results = await completeTag('red', new Set(), paramDef);
      assert.deepEqual(results.map(r => r.value), ['red', 'redo', 'side-red', 'a_red', 'bored']);
    });

    it('applies the candidate cap after tier ordering', async () => {
      useTags([
        ...Array.from({ length: 205 }, (_, i) => ({ name: `xred${i}`, frequency: 100 })),
        { name: 'red', frequency: 0 },
      ]);
      const results = await completeTag('red', new Set(), paramDef);
      assert.equal(results.length, 200);
      assert.equal(results[0].value, 'red');
    });

    it('matches in the middle with the # prefix', async () => {
      useTags(named);
      const results = await completeTag('#ore', new Set(), { type: 'tag', prefix: '#' });
      assert.deepEqual(results.map(r => r.value), ['#bored']);
    });
  });

  describe('with # prefix', () => {
    const hashDef = { type: 'tag', prefix: '#' };

    it('adds # prefix to title and value', async () => {
      useTags(tags);
      const results = await completeTag('', new Set(), hashDef);
      assert.equal(results[0].title, '#todo');
      assert.equal(results[0].value, '#todo');
    });

    it('strips # from partial before matching', async () => {
      useTags(tags);
      const results = await completeTag('#to', new Set(), hashDef);
      assert.deepEqual(results.map(r => r.value), ['#todo', '#tools']);
    });

    it('matches without # typed too', async () => {
      useTags(tags);
      const results = await completeTag('to', new Set(), hashDef);
      assert.deepEqual(results.map(r => r.value), ['#todo', '#tools']);
    });
  });
});
