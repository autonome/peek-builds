/**
 * Unit tests for key bindings on tag action affordances
 * (renderer/lib/tag-action-affordances.js) and their dispatch from the tag-query
 * block keys (features/editor/query-keys.js attachQueryKeys).
 * Run via: NODE_ENV=test node --test tests/unit/tag-action-keys.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  resolveAffordances,
  findAffordanceByKey,
  triggerAffordance,
} from '../../renderer/lib/tag-action-affordances.js';
import { attachQueryKeys } from '../../features/editor/query-keys.js';

const todoRule = (display = {}) => ({
  id: 'r1',
  enabled: true,
  scriptId: 'tag-swap',
  config: { activeTag: 'todo', completedTag: 'done' },
  display: { icon: 'unchecked', checkedIcon: 'checked', key: 'x', ...display },
});

describe('affordance keys', () => {
  it('resolveAffordances carries the declared key, null otherwise', () => {
    assert.equal(resolveAffordances(['todo'], [todoRule()])[0].key, 'x');
    assert.equal(resolveAffordances(['todo'], [todoRule({ key: undefined })])[0].key, null);
    assert.equal(resolveAffordances(['todo'], [todoRule({ key: 'xx' })])[0].key, null);
  });

  it('findAffordanceByKey matches only items the rule applies to', () => {
    assert.equal(findAffordanceByKey(['todo'], [todoRule()], 'x').ruleId, 'r1');
    assert.equal(findAffordanceByKey(['other'], [todoRule()], 'x'), null);
    assert.equal(findAffordanceByKey(['todo'], [todoRule()], 'y'), null);
    assert.equal(findAffordanceByKey(['todo'], [todoRule()], 'Enter'), null);
  });

  it('triggerAffordance publishes the click the checkbox publishes', () => {
    const published = [];
    const api = { pubsub: { publish: (topic, msg) => published.push([topic, msg]) } };
    const aff = findAffordanceByKey(['todo'], [todoRule()], 'x');
    assert.equal(triggerAffordance('i1', aff, api), true);
    assert.deepEqual(published, [['affordance:click', {
      ruleId: 'r1', itemId: 'i1', checked: true, activeTag: 'todo', completedTag: 'done',
    }]]);
  });
});

describe('attachQueryKeys: tagKey', () => {
  const surface = (selected, count = 3) => ({
    selectedIndex: () => selected,
    blockCount: () => count,
    isFolded: () => false,
    select() {},
    revealSelected() {},
    fold() {},
    unfold() {},
  });
  const press = (key, surf, tagKey) => {
    let handler;
    let prevented = false;
    const doc = { addEventListener: (_, fn) => { handler = fn; }, removeEventListener() {} };
    attachQueryKeys(surf, doc, null, { tagKey });
    handler({ key, target: { tagName: 'DIV' }, preventDefault() { prevented = true; } });
    return prevented;
  };

  it('offers the key with the selected index and consumes it when handled', () => {
    const calls = [];
    const prevented = press('x', surface(1), (key, index) => { calls.push([key, index]); return true; });
    assert.deepEqual(calls, [['x', 1]]);
    assert.equal(prevented, true);
  });

  it('leaves the key alone when no action takes it', () => {
    assert.equal(press('x', surface(1), () => false), false);
  });

  it('offers nothing without a selected block', () => {
    const calls = [];
    press('x', surface(-1, 0), (key, index) => { calls.push([key, index]); return true; });
    assert.deepEqual(calls, []);
  });
});
