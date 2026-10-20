/**
 * Unit tests for renderer/lib/tag-action-affordances.js — the pure resolution
 * of an item's tags plus the affordance rules into UI affordance descriptors.
 *
 * resolveAffordances() and findAffordanceByKey() touch no DOM, so the real
 * module is imported directly (same route as tag-action-keys.test.js).
 *
 * Run via: NODE_ENV=test node --test tests/unit/tag-action-affordances.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  resolveAffordances,
  findAffordanceByKey,
} from '../../renderer/lib/tag-action-affordances.js';

/**
 * A tag-swap rule in the shape api.rules.listAffordances() returns:
 * scriptId picks the affordance kind, config holds the tag pair, display
 * holds the presentation.
 */
const swapRule = ({ id = 'r1', enabled = true, config = {}, display = {}, ...rest } = {}) => ({
  id,
  enabled,
  scriptId: 'tag-swap',
  config: { activeTag: 'todo', completedTag: 'done', ...config },
  display,
  ...rest,
});

describe('Tag Action Affordances', () => {
  describe('resolveAffordances', () => {
    it('returns an empty array when there are no rules', () => {
      assert.deepEqual(resolveAffordances(['todo'], []), []);
    });

    it('returns an empty array when the item has no tags', () => {
      assert.deepEqual(resolveAffordances([], [swapRule()]), []);
    });

    it('returns an empty array for null inputs', () => {
      assert.deepEqual(resolveAffordances(null, null), []);
      assert.deepEqual(resolveAffordances(['todo'], null), []);
      assert.deepEqual(resolveAffordances(null, [swapRule()]), []);
    });

    it('skips a disabled rule', () => {
      assert.deepEqual(resolveAffordances(['todo'], [swapRule({ enabled: false })]), []);
    });

    it('resolves an unchecked toggle when the item carries the active tag', () => {
      const result = resolveAffordances(['todo', 'other'], [swapRule()]);
      assert.equal(result.length, 1);
      assert.equal(result[0].type, 'toggle');
      assert.equal(result[0].ruleId, 'r1');
      assert.equal(result[0].checked, false);
      assert.equal(result[0].activeTag, 'todo');
      assert.equal(result[0].completedTag, 'done');
    });

    it('resolves a checked toggle when the item carries the completed tag', () => {
      const result = resolveAffordances(['done'], [swapRule()]);
      assert.equal(result.length, 1);
      assert.equal(result[0].type, 'toggle');
      assert.equal(result[0].checked, true);
    });

    it('resolves nothing when the item carries neither tag of the pair', () => {
      assert.deepEqual(resolveAffordances(['unrelated'], [swapRule()]), []);
    });

    it('skips a rule whose config omits completedTag', () => {
      const rule = swapRule({ config: { completedTag: undefined } });
      assert.deepEqual(resolveAffordances(['todo'], [rule]), []);
    });

    it('skips a rule whose config omits activeTag', () => {
      const rule = swapRule({ config: { activeTag: undefined } });
      assert.deepEqual(resolveAffordances(['todo', 'done'], [rule]), []);
    });

    it('ignores a rule whose scriptId is not tag-swap', () => {
      const rules = [
        { id: 'p1', enabled: true, scriptId: 'publish', config: { activeTag: 'todo', completedTag: 'done' }, display: {} },
        { id: 'o1', enabled: true, scriptId: 'open-url', config: { activeTag: 'todo', completedTag: 'done' }, display: {} },
        { id: 'n1', enabled: true, config: { activeTag: 'todo', completedTag: 'done' }, display: {} },
      ];
      assert.deepEqual(resolveAffordances(['todo'], rules), []);
    });

    it('resolves one affordance per matching rule, in rule order', () => {
      const rules = [
        swapRule({ id: 'r1', config: { activeTag: 'important', completedTag: 'handled' } }),
        swapRule({ id: 'r2' }),
      ];
      const result = resolveAffordances(['important', 'todo'], rules);
      assert.equal(result.length, 2);
      assert.equal(result[0].ruleId, 'r1');
      assert.equal(result[0].activeTag, 'important');
      assert.equal(result[1].ruleId, 'r2');
      assert.equal(result[1].activeTag, 'todo');
    });

    it('uses display defaults when the display block is empty', () => {
      const result = resolveAffordances(['todo'], [swapRule()]);
      assert.equal(result[0].icon, 'unchecked');
      assert.equal(result[0].checkedIcon, 'checked');
      assert.equal(result[0].color, '#007aff');
      assert.equal(result[0].checkedColor, '#34c759');
    });

    it('takes icons and colours from the display block when given', () => {
      const rule = swapRule({
        display: {
          icon: 'eye-closed',
          checkedIcon: 'eye-open',
          color: '#4a9eff',
          checkedColor: '#ff0000',
        },
      });
      const result = resolveAffordances(['todo'], [rule]);
      assert.equal(result[0].icon, 'eye-closed');
      assert.equal(result[0].checkedIcon, 'eye-open');
      assert.equal(result[0].color, '#4a9eff');
      assert.equal(result[0].checkedColor, '#ff0000');
    });

    it('labels the affordance with the tag pair', () => {
      const result = resolveAffordances(['todo'], [swapRule()]);
      assert.equal(result[0].label, 'todo/done');
    });

    it('labels with the tag pair even when the rule carries a name', () => {
      const result = resolveAffordances(['todo'], [swapRule({ name: 'My Toggle' })]);
      assert.equal(result[0].label, 'todo/done');
    });

    it('carries a single-character display key, and null for anything else', () => {
      const withKey = resolveAffordances(['todo'], [swapRule({ display: { key: 'x' } })]);
      assert.equal(withKey[0].key, 'x');

      const multiChar = resolveAffordances(['todo'], [swapRule({ display: { key: 'ctrl' } })]);
      assert.equal(multiChar[0].key, null);

      const noKey = resolveAffordances(['todo'], [swapRule()]);
      assert.equal(noKey[0].key, null);
    });
  });

  describe('findAffordanceByKey', () => {
    it('finds the affordance whose rule declares that key', () => {
      const rules = [
        swapRule({ id: 'r1', display: { key: 'x' } }),
        swapRule({ id: 'r2', config: { activeTag: 'read-later', completedTag: 'read' }, display: { key: 'r' } }),
      ];
      const found = findAffordanceByKey(['todo', 'read-later'], rules, 'r');
      assert.equal(found.ruleId, 'r2');
      assert.equal(found.activeTag, 'read-later');
    });

    it('returns null when no resolved affordance declares that key', () => {
      const rules = [swapRule({ display: { key: 'x' } })];
      assert.equal(findAffordanceByKey(['todo'], rules, 'q'), null);
    });

    it('returns null when the rule matches the key but not the item tags', () => {
      const rules = [swapRule({ display: { key: 'x' } })];
      assert.equal(findAffordanceByKey(['unrelated'], rules, 'x'), null);
    });

    it('returns null for a key that is not a single character', () => {
      const rules = [swapRule({ display: { key: 'x' } })];
      assert.equal(findAffordanceByKey(['todo'], rules, 'Enter'), null);
      assert.equal(findAffordanceByKey(['todo'], rules, ''), null);
      assert.equal(findAffordanceByKey(['todo'], rules, undefined), null);
    });

    it('returns the first matching affordance when two rules share a key', () => {
      const rules = [
        swapRule({ id: 'first', display: { key: 'x' } }),
        swapRule({ id: 'second', config: { activeTag: 'later', completedTag: 'soon' }, display: { key: 'x' } }),
      ];
      const found = findAffordanceByKey(['todo', 'later'], rules, 'x');
      assert.equal(found.ruleId, 'first');
    });
  });
});
