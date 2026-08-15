/**
 * Unit tests for rules.ts — the rule registry storage layer (Stage 1
 * of peek MCP plan 3d7d9239).
 *
 * Mirrors permission-store.test.ts: in-memory node:sqlite database with the
 * `rules` table shape from datastore.ts. Runs under Electron-as-node
 * via ELECTRON_RUN_AS_NODE.
 */

import { describe, it, before, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';

import {
  computeManifestRuleId,
  deleteRule,
  deleteRulesByFeature,
  getRule,
  listRules,
  parseRule,
  serializeRule,
  syncManifestRules,
  upsertRule,
  type ManifestRule,
  type Rule,
  type RulesDb,
} from './rules.js';

let db: DatabaseSync;

function makeDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE rules (
      id TEXT PRIMARY KEY NOT NULL,
      featureId TEXT NOT NULL,
      topic TEXT NOT NULL,
      match TEXT DEFAULT '{}',
      scriptId TEXT NOT NULL,
      config TEXT DEFAULT '{}',
      display TEXT DEFAULT '',
      enabled INTEGER DEFAULT 1,
      source TEXT NOT NULL CHECK(source IN ('manifest', 'user', 'runtime')),
      ordering INTEGER DEFAULT 0,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE INDEX idx_rules_topic ON rules(topic);
    CREATE INDEX idx_rules_featureId ON rules(featureId);
    CREATE INDEX idx_rules_source ON rules(source);
    CREATE INDEX idx_rules_enabled ON rules(enabled);
  `);
  return d;
}

function asRulesDb(d: DatabaseSync): RulesDb {
  return d as unknown as RulesDb;
}

function makeRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 'rule_test',
    featureId: 'tag-actions',
    topic: 'tag:added',
    match: { tagName: 'todo' },
    scriptId: 'tag-swap',
    config: { activeTag: 'todo', completedTag: 'done' },
    display: { icon: 'check' },
    enabled: true,
    source: 'manifest',
    ordering: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe('rules: serialize / parse round-trip', () => {
  it('round-trips a fully-populated rule', () => {
    const rule = makeRule();
    const back = parseRule(serializeRule(rule));
    assert.deepStrictEqual(back, rule);
  });

  it('round-trips a rule with display=null', () => {
    const rule = makeRule({ display: null });
    const back = parseRule(serializeRule(rule));
    assert.strictEqual(back.display, null);
  });

  it('round-trips disabled state', () => {
    const rule = makeRule({ enabled: false });
    const back = parseRule(serializeRule(rule));
    assert.strictEqual(back.enabled, false);
  });

  it('falls back to {} for malformed JSON in match/config', () => {
    const back = parseRule({
      id: 'r', featureId: 'f', topic: 't', match: '{not json',
      scriptId: 's', config: '{also bad', display: '',
      enabled: 1, source: 'user', ordering: 0,
      createdAt: 0, updatedAt: 0,
    });
    assert.deepStrictEqual(back.match, {});
    assert.deepStrictEqual(back.config, {});
    assert.strictEqual(back.display, null);
  });
});

describe('rules: CRUD', () => {
  before(() => { db = makeDb(); });
  beforeEach(() => { db.exec('DELETE FROM rules'); });

  it('upsert -> get returns the same rule', () => {
    upsertRule(asRulesDb(db), makeRule());
    const got = getRule(asRulesDb(db), 'rule_test');
    assert.ok(got);
    assert.strictEqual(got.topic, 'tag:added');
    assert.strictEqual(got.scriptId, 'tag-swap');
    assert.deepStrictEqual(got.config, { activeTag: 'todo', completedTag: 'done' });
  });

  it('getRule returns null for unknown id', () => {
    assert.strictEqual(getRule(asRulesDb(db), 'nope'), null);
  });

  it('upsert preserves createdAt on update but advances updatedAt', () => {
    upsertRule(asRulesDb(db), makeRule({ createdAt: 1000, updatedAt: 1000 }));
    upsertRule(asRulesDb(db), makeRule({ createdAt: 9999, updatedAt: 2000, scriptId: 'other' }));
    const got = getRule(asRulesDb(db), 'rule_test');
    assert.strictEqual(got!.createdAt, 1000, 'createdAt frozen on update');
    assert.strictEqual(got!.updatedAt, 2000);
    assert.strictEqual(got!.scriptId, 'other');
  });

  it('deleteRule returns true when row existed and false otherwise', () => {
    upsertRule(asRulesDb(db), makeRule());
    assert.strictEqual(deleteRule(asRulesDb(db), 'rule_test'), true);
    assert.strictEqual(deleteRule(asRulesDb(db), 'rule_test'), false);
    assert.strictEqual(getRule(asRulesDb(db), 'rule_test'), null);
  });
});

describe('rules: listRules filters', () => {
  before(() => { db = makeDb(); });
  beforeEach(() => { db.exec('DELETE FROM rules'); });

  it('filters by topic / featureId / source / enabled', () => {
    upsertRule(asRulesDb(db), makeRule({ id: 'a', topic: 'tag:added', featureId: 'tag-actions', source: 'manifest', enabled: true }));
    upsertRule(asRulesDb(db), makeRule({ id: 'b', topic: 'tag:removed', featureId: 'tag-actions', source: 'manifest', enabled: true }));
    upsertRule(asRulesDb(db), makeRule({ id: 'c', topic: 'tag:added', featureId: 'entities', source: 'user', enabled: false }));

    assert.deepStrictEqual(
      listRules(asRulesDb(db), { topic: 'tag:added' }).map(r => r.id).sort(),
      ['a', 'c'],
    );
    assert.deepStrictEqual(
      listRules(asRulesDb(db), { featureId: 'tag-actions' }).map(r => r.id).sort(),
      ['a', 'b'],
    );
    assert.deepStrictEqual(
      listRules(asRulesDb(db), { source: 'user' }).map(r => r.id),
      ['c'],
    );
    assert.deepStrictEqual(
      listRules(asRulesDb(db), { enabled: false }).map(r => r.id),
      ['c'],
    );
  });

  it('orders by ordering ASC then createdAt ASC', () => {
    upsertRule(asRulesDb(db), makeRule({ id: 'late-low', ordering: 0, createdAt: 200 }));
    upsertRule(asRulesDb(db), makeRule({ id: 'early-low', ordering: 0, createdAt: 100 }));
    upsertRule(asRulesDb(db), makeRule({ id: 'high', ordering: 5, createdAt: 50 }));
    assert.deepStrictEqual(
      listRules(asRulesDb(db)).map(r => r.id),
      ['early-low', 'late-low', 'high'],
    );
  });

  it('empty filter returns all rules', () => {
    upsertRule(asRulesDb(db), makeRule({ id: 'a' }));
    upsertRule(asRulesDb(db), makeRule({ id: 'b' }));
    assert.strictEqual(listRules(asRulesDb(db)).length, 2);
  });
});

describe('rules: deleteRulesByFeature', () => {
  before(() => { db = makeDb(); });
  beforeEach(() => { db.exec('DELETE FROM rules'); });

  it('deletes only rows for the named feature', () => {
    upsertRule(asRulesDb(db), makeRule({ id: 'a', featureId: 'tag-actions' }));
    upsertRule(asRulesDb(db), makeRule({ id: 'b', featureId: 'tag-actions' }));
    upsertRule(asRulesDb(db), makeRule({ id: 'c', featureId: 'entities' }));
    const n = deleteRulesByFeature(asRulesDb(db), 'tag-actions');
    assert.strictEqual(n, 2);
    const remaining = listRules(asRulesDb(db));
    assert.strictEqual(remaining.length, 1);
    assert.strictEqual(remaining[0].id, 'c');
  });

  it('returns 0 when no rows match', () => {
    assert.strictEqual(deleteRulesByFeature(asRulesDb(db), 'ghost'), 0);
  });
});

describe('rules: computeManifestRuleId', () => {
  it('is stable across calls for identical input', () => {
    const m: ManifestRule = { topic: 't', scriptId: 's', match: { x: 1 } };
    assert.strictEqual(computeManifestRuleId('f', m), computeManifestRuleId('f', m));
  });

  it('changes when topic / scriptId / match / config / display / ordering changes', () => {
    const base: ManifestRule = { topic: 't', scriptId: 's' };
    const id0 = computeManifestRuleId('f', base);
    assert.notStrictEqual(id0, computeManifestRuleId('f', { ...base, topic: 't2' }));
    assert.notStrictEqual(id0, computeManifestRuleId('f', { ...base, scriptId: 's2' }));
    assert.notStrictEqual(id0, computeManifestRuleId('f', { ...base, match: { y: 1 } }));
    assert.notStrictEqual(id0, computeManifestRuleId('f', { ...base, config: { y: 1 } }));
    assert.notStrictEqual(id0, computeManifestRuleId('f', { ...base, display: { icon: 'x' } }));
    assert.notStrictEqual(id0, computeManifestRuleId('f', { ...base, ordering: 5 }));
  });

  it('does NOT change when only enabled flips — users toggling off must not lose identity', () => {
    const base: ManifestRule = { topic: 't', scriptId: 's', enabled: true };
    const off: ManifestRule = { ...base, enabled: false };
    assert.strictEqual(computeManifestRuleId('f', base), computeManifestRuleId('f', off));
  });

  it('changes when featureId changes', () => {
    const m: ManifestRule = { topic: 't', scriptId: 's' };
    assert.notStrictEqual(computeManifestRuleId('a', m), computeManifestRuleId('b', m));
  });
});

describe('rules: syncManifestRules', () => {
  before(() => { db = makeDb(); });
  beforeEach(() => { db.exec('DELETE FROM rules'); });

  it('inserts declared rules and assigns content-hash ids', () => {
    const declared: ManifestRule[] = [
      { topic: 'tag:added', scriptId: 'swap', config: { a: 1 } },
      { topic: 'tag:removed', scriptId: 'swap-back' },
    ];
    const out = syncManifestRules(asRulesDb(db), 'tag-actions', declared, 1000);
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].id, computeManifestRuleId('tag-actions', declared[0]));
    assert.strictEqual(out[0].source, 'manifest');
    assert.strictEqual(out[0].featureId, 'tag-actions');
  });

  it('is idempotent on identical input — second run preserves createdAt', () => {
    const declared: ManifestRule[] = [{ topic: 't', scriptId: 's' }];
    const first = syncManifestRules(asRulesDb(db), 'f', declared, 1000);
    const second = syncManifestRules(asRulesDb(db), 'f', declared, 2000);
    assert.strictEqual(first[0].id, second[0].id);
    const got = getRule(asRulesDb(db), first[0].id);
    assert.strictEqual(got!.createdAt, 1000, 'createdAt preserved');
    assert.strictEqual(got!.updatedAt, 2000, 'updatedAt advances');
  });

  it('removes manifest rules whose declarations are gone', () => {
    const v1: ManifestRule[] = [
      { topic: 'a', scriptId: 's' },
      { topic: 'b', scriptId: 's' },
    ];
    syncManifestRules(asRulesDb(db), 'f', v1, 1000);
    assert.strictEqual(listRules(asRulesDb(db)).length, 2);

    const v2: ManifestRule[] = [{ topic: 'a', scriptId: 's' }];
    syncManifestRules(asRulesDb(db), 'f', v2, 2000);
    const remaining = listRules(asRulesDb(db));
    assert.strictEqual(remaining.length, 1);
    assert.strictEqual(remaining[0].topic, 'a');
  });

  it('leaves user/runtime rules for the same feature untouched', () => {
    upsertRule(asRulesDb(db), makeRule({ id: 'user-rule', featureId: 'f', source: 'user' }));
    upsertRule(asRulesDb(db), makeRule({ id: 'rt-rule', featureId: 'f', source: 'runtime' }));
    syncManifestRules(asRulesDb(db), 'f', [{ topic: 't', scriptId: 's' }], 1000);
    const ids = listRules(asRulesDb(db), { featureId: 'f' }).map(r => r.id).sort();
    assert.ok(ids.includes('user-rule'));
    assert.ok(ids.includes('rt-rule'));
    assert.strictEqual(ids.length, 3);
  });

  it('clearing the declaration list deletes all manifest rules for the feature', () => {
    syncManifestRules(asRulesDb(db), 'f', [
      { topic: 'a', scriptId: 's' },
      { topic: 'b', scriptId: 's' },
    ], 1000);
    syncManifestRules(asRulesDb(db), 'f', [], 2000);
    assert.strictEqual(listRules(asRulesDb(db), { featureId: 'f', source: 'manifest' }).length, 0);
  });
});
