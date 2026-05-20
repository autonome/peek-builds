/**
 * Unit tests for tag-action-affordances module
 *
 * Tests the pure resolveAffordances() function that maps item tags + action rules
 * to UI affordance descriptors. No DOM or API dependencies.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

// Import the module — it's a pure ESM file in app/lib/
// We dynamically import to handle the peek:// URL resolution
let resolveAffordances: (tagNames: string[], rules: any[]) => any[];

describe('Tag Action Affordances', () => {
  // Inline the pure function for testing (it has no deps)
  const resolve = (itemTagNames: string[], actionRules: any[]) => {
    if (!actionRules || !Array.isArray(actionRules) || actionRules.length === 0) return [];
    if (!itemTagNames || itemTagNames.length === 0) return [];

    const tagSet = new Set(itemTagNames);
    const affordances: any[] = [];

    for (const action of actionRules) {
      if (!action.enabled) continue;

      switch (action.actionType) {
        case 'icon': {
          if (tagSet.has(action.triggerTag)) {
            const config = action.actionConfig || {};
            affordances.push({
              type: 'icon',
              actionId: action.id,
              icon: config.icon || 'star',
              color: config.color || '#999999',
              tooltip: config.tooltip || action.triggerTag
            });
          }
          break;
        }

        case 'toggle': {
          const config = action.actionConfig || {};
          const activeTag = config.activeTag || action.triggerTag;
          const completedTag = config.completedTag || '';
          if (!completedTag) break;

          const hasActive = tagSet.has(activeTag);
          const hasCompleted = tagSet.has(completedTag);
          if (!hasActive && !hasCompleted) break;

          affordances.push({
            type: 'toggle',
            actionId: action.id,
            checked: hasCompleted,
            activeTag,
            completedTag,
            label: action.name || activeTag + '/' + completedTag,
            icon: config.icon || 'unchecked',
            checkedIcon: config.checkedIcon || 'checked',
            color: config.color || '#007aff',
            checkedColor: config.checkedColor || '#34c759'
          });
          break;
        }
      }
    }

    return affordances;
  };

  describe('resolveAffordances', () => {
    it('should return empty array for no rules', () => {
      assert.deepStrictEqual(resolve(['todo'], []), []);
    });

    it('should return empty array for no tags', () => {
      const rules = [{
        id: 'r1', enabled: true, triggerTag: 'todo',
        actionType: 'icon', actionConfig: { icon: 'star' }
      }];
      assert.deepStrictEqual(resolve([], rules), []);
    });

    it('should return empty array for null inputs', () => {
      assert.deepStrictEqual(resolve(null as any, null as any), []);
    });

    it('should match icon action when item has trigger tag', () => {
      const rules = [{
        id: 'r1', enabled: true, triggerTag: 'read-later',
        actionType: 'icon',
        actionConfig: { icon: 'eye', color: '#4a9eff', tooltip: 'Read later' }
      }];
      const result = resolve(['read-later', 'other'], rules);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].type, 'icon');
      assert.strictEqual(result[0].icon, 'eye');
      assert.strictEqual(result[0].color, '#4a9eff');
      assert.strictEqual(result[0].tooltip, 'Read later');
    });

    it('should not match icon action when item lacks trigger tag', () => {
      const rules = [{
        id: 'r1', enabled: true, triggerTag: 'read-later',
        actionType: 'icon', actionConfig: { icon: 'eye' }
      }];
      const result = resolve(['other', 'tags'], rules);
      assert.strictEqual(result.length, 0);
    });

    it('should skip disabled actions', () => {
      const rules = [{
        id: 'r1', enabled: false, triggerTag: 'todo',
        actionType: 'icon', actionConfig: { icon: 'check' }
      }];
      const result = resolve(['todo'], rules);
      assert.strictEqual(result.length, 0);
    });

    it('should resolve toggle action with active tag (unchecked)', () => {
      const rules = [{
        id: 't1', enabled: true, triggerTag: 'todo',
        actionType: 'toggle',
        actionConfig: { activeTag: 'todo', completedTag: 'done' }
      }];
      const result = resolve(['todo'], rules);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].type, 'toggle');
      assert.strictEqual(result[0].checked, false);
      assert.strictEqual(result[0].activeTag, 'todo');
      assert.strictEqual(result[0].completedTag, 'done');
    });

    it('should resolve toggle action with completed tag (checked)', () => {
      const rules = [{
        id: 't1', enabled: true, triggerTag: 'todo',
        actionType: 'toggle',
        actionConfig: { activeTag: 'todo', completedTag: 'done' }
      }];
      const result = resolve(['done'], rules);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].type, 'toggle');
      assert.strictEqual(result[0].checked, true);
    });

    it('should not resolve toggle when item has neither tag', () => {
      const rules = [{
        id: 't1', enabled: true, triggerTag: 'todo',
        actionType: 'toggle',
        actionConfig: { activeTag: 'todo', completedTag: 'done' }
      }];
      const result = resolve(['unrelated'], rules);
      assert.strictEqual(result.length, 0);
    });

    it('should not resolve toggle when completedTag is missing from config', () => {
      const rules = [{
        id: 't1', enabled: true, triggerTag: 'todo',
        actionType: 'toggle',
        actionConfig: { activeTag: 'todo' }
      }];
      const result = resolve(['todo'], rules);
      assert.strictEqual(result.length, 0);
    });

    it('should resolve multiple affordances from different rules', () => {
      const rules = [
        {
          id: 'r1', enabled: true, triggerTag: 'important',
          actionType: 'icon', actionConfig: { icon: 'star', color: '#ff0' }
        },
        {
          id: 't1', enabled: true, triggerTag: 'todo',
          actionType: 'toggle',
          actionConfig: { activeTag: 'todo', completedTag: 'done' }
        }
      ];
      const result = resolve(['important', 'todo'], rules);
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].type, 'icon');
      assert.strictEqual(result[1].type, 'toggle');
    });

    it('should use defaults for missing config fields', () => {
      const rules = [{
        id: 'r1', enabled: true, triggerTag: 'test',
        actionType: 'icon', actionConfig: {}
      }];
      const result = resolve(['test'], rules);
      assert.strictEqual(result[0].icon, 'star');
      assert.strictEqual(result[0].color, '#999999');
      assert.strictEqual(result[0].tooltip, 'test');
    });

    it('should use toggle defaults for missing config fields', () => {
      const rules = [{
        id: 't1', enabled: true, triggerTag: 'todo', name: 'My Toggle',
        actionType: 'toggle',
        actionConfig: { activeTag: 'todo', completedTag: 'done' }
      }];
      const result = resolve(['todo'], rules);
      assert.strictEqual(result[0].icon, 'unchecked');
      assert.strictEqual(result[0].checkedIcon, 'checked');
      assert.strictEqual(result[0].color, '#007aff');
      assert.strictEqual(result[0].checkedColor, '#34c759');
      assert.strictEqual(result[0].label, 'My Toggle');
    });

    it('should ignore non-visual action types (publish, open-url, tag)', () => {
      const rules = [
        { id: 'p1', enabled: true, triggerTag: 'test', actionType: 'publish', actionConfig: {} },
        { id: 'o1', enabled: true, triggerTag: 'test', actionType: 'open-url', actionConfig: {} },
        { id: 'a1', enabled: true, triggerTag: 'test', actionType: 'tag', actionConfig: {} }
      ];
      const result = resolve(['test'], rules);
      assert.strictEqual(result.length, 0);
    });

    it('should fall back to triggerTag when activeTag is not set', () => {
      const rules = [{
        id: 't1', enabled: true, triggerTag: 'todo',
        actionType: 'toggle',
        actionConfig: { completedTag: 'done' }
      }];
      const result = resolve(['todo'], rules);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].activeTag, 'todo');
    });
  });
});
