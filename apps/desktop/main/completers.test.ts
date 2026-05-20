/**
 * Unit tests for parameter completion/suggestion system
 *
 * Tests extracted pure functions from:
 * - extensions/cmd/completers.js: completeEnum, completeTag (filtering, prefix, exclusion)
 *
 * These are logic-only tests -- no DOM, no Electron, no extensions runtime.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

// ============================================================================
// completeEnum (from extensions/cmd/completers.js)
// ============================================================================

interface ParamDef {
  type: string;
  prefix?: string;
  values?: string[];
  multiple?: boolean;
}

interface Suggestion {
  title: string;
  subtitle: string;
  value: string;
}

function completeEnum(partial: string, exclude: Set<string>, paramDef: ParamDef): Suggestion[] {
  const prefix = paramDef.prefix || '';
  const lowerPartial = (partial || '').toLowerCase();
  const values = paramDef.values || [];

  const matchText = lowerPartial.startsWith(prefix.toLowerCase())
    ? lowerPartial.slice(prefix.length)
    : lowerPartial;

  return values
    .filter(val => {
      if (exclude.has(val.toLowerCase())) return false;
      if (matchText && !val.toLowerCase().startsWith(matchText)) return false;
      return true;
    })
    .map(val => ({
      title: prefix + val,
      subtitle: '',
      value: prefix + val
    }));
}

// ============================================================================
// completeTag (from extensions/cmd/completers.js)
// Adapted: accepts tags array directly instead of fetching from API
// ============================================================================

interface TagEntry {
  name: string;
  frequency?: number;
}

function completeTag(tags: TagEntry[], partial: string, exclude: Set<string>, paramDef: ParamDef): Suggestion[] {
  const prefix = paramDef.prefix || '';
  const lowerPartial = (partial || '').toLowerCase();

  const matchText = lowerPartial.startsWith(prefix.toLowerCase())
    ? lowerPartial.slice(prefix.length)
    : lowerPartial;

  return tags
    .filter(tag => {
      if (exclude.has(tag.name.toLowerCase())) return false;
      if (matchText && !tag.name.toLowerCase().startsWith(matchText)) return false;
      return true;
    })
    .slice(0, 20)
    .map(tag => ({
      title: prefix + tag.name,
      subtitle: `used ${tag.frequency || 0}x`,
      value: prefix + tag.name
    }));
}

// ============================================================================
// Tests
// ============================================================================

describe('completeEnum', () => {
  const paramDef: ParamDef = { type: 'enum', values: ['red', 'green', 'blue', 'grey'] };

  it('returns all values when partial is empty', () => {
    const results = completeEnum('', new Set(), paramDef);
    assert.strictEqual(results.length, 4);
    assert.deepStrictEqual(results.map(r => r.value), ['red', 'green', 'blue', 'grey']);
  });

  it('filters by partial match', () => {
    const results = completeEnum('gr', new Set(), paramDef);
    assert.deepStrictEqual(results.map(r => r.value), ['green', 'grey']);
  });

  it('is case-insensitive', () => {
    const results = completeEnum('GR', new Set(), paramDef);
    assert.deepStrictEqual(results.map(r => r.value), ['green', 'grey']);
  });

  it('excludes already-used values', () => {
    const results = completeEnum('', new Set(['red', 'blue']), paramDef);
    assert.deepStrictEqual(results.map(r => r.value), ['green', 'grey']);
  });

  it('combines partial filtering and exclusion', () => {
    const results = completeEnum('gr', new Set(['green']), paramDef);
    assert.deepStrictEqual(results.map(r => r.value), ['grey']);
  });

  it('returns empty when nothing matches', () => {
    const results = completeEnum('xyz', new Set(), paramDef);
    assert.strictEqual(results.length, 0);
  });

  it('returns empty when all excluded', () => {
    const results = completeEnum('', new Set(['red', 'green', 'blue', 'grey']), paramDef);
    assert.strictEqual(results.length, 0);
  });

  describe('with prefix', () => {
    const prefixed: ParamDef = { type: 'enum', values: ['high', 'medium', 'low'], prefix: '!' };

    it('adds prefix to title and value', () => {
      const results = completeEnum('', new Set(), prefixed);
      assert.deepStrictEqual(results.map(r => r.value), ['!high', '!medium', '!low']);
      assert.deepStrictEqual(results.map(r => r.title), ['!high', '!medium', '!low']);
    });

    it('strips prefix from partial before matching', () => {
      const results = completeEnum('!hi', new Set(), prefixed);
      assert.deepStrictEqual(results.map(r => r.value), ['!high']);
    });

    it('matches without prefix typed too', () => {
      const results = completeEnum('hi', new Set(), prefixed);
      assert.deepStrictEqual(results.map(r => r.value), ['!high']);
    });
  });
});

describe('completeTag', () => {
  const tags: TagEntry[] = [
    { name: 'todo', frequency: 12 },
    { name: 'tools', frequency: 8 },
    { name: 'reading', frequency: 5 },
    { name: 'recipe', frequency: 3 },
    { name: 'reference', frequency: 1 },
  ];
  const paramDef: ParamDef = { type: 'tag' };

  it('returns all tags when partial is empty', () => {
    const results = completeTag(tags, '', new Set(), paramDef);
    assert.strictEqual(results.length, 5);
  });

  it('filters by partial match', () => {
    const results = completeTag(tags, 'to', new Set(), paramDef);
    assert.deepStrictEqual(results.map(r => r.value), ['todo', 'tools']);
  });

  it('is case-insensitive', () => {
    const results = completeTag(tags, 'RE', new Set(), paramDef);
    assert.deepStrictEqual(results.map(r => r.value), ['reading', 'recipe', 'reference']);
  });

  it('excludes already-used tags', () => {
    const results = completeTag(tags, 'to', new Set(['todo']), paramDef);
    assert.deepStrictEqual(results.map(r => r.value), ['tools']);
  });

  it('includes frequency in subtitle', () => {
    const results = completeTag(tags, 'todo', new Set(), paramDef);
    assert.strictEqual(results[0].subtitle, 'used 12x');
  });

  it('shows 0x for missing frequency', () => {
    const noFreq: TagEntry[] = [{ name: 'orphan' }];
    const results = completeTag(noFreq, '', new Set(), paramDef);
    assert.strictEqual(results[0].subtitle, 'used 0x');
  });

  it('caps at 20 results', () => {
    const manyTags = Array.from({ length: 30 }, (_, i) => ({ name: `tag${i}`, frequency: 0 }));
    const results = completeTag(manyTags, '', new Set(), paramDef);
    assert.strictEqual(results.length, 20);
  });

  describe('with # prefix', () => {
    const hashDef: ParamDef = { type: 'tag', prefix: '#' };

    it('adds # prefix to title and value', () => {
      const results = completeTag(tags, '', new Set(), hashDef);
      assert.strictEqual(results[0].title, '#todo');
      assert.strictEqual(results[0].value, '#todo');
    });

    it('strips # from partial before matching', () => {
      const results = completeTag(tags, '#to', new Set(), hashDef);
      assert.deepStrictEqual(results.map(r => r.value), ['#todo', '#tools']);
    });

    it('matches without # typed too', () => {
      const results = completeTag(tags, 'to', new Set(), hashDef);
      assert.deepStrictEqual(results.map(r => r.value), ['#todo', '#tools']);
    });
  });
});
