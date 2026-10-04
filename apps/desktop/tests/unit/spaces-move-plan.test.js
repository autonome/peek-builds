/**
 * Unit tests for planMoveToSpace in features/spaces/config.js.
 *
 * Run via: node --test tests/unit/spaces-move-plan.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', 'features', 'spaces', 'config.js');
const { planMoveToSpace } = await import(modulePath);

describe('planMoveToSpace', () => {
  it('asks for a name when none is given', () => {
    for (const targetName of [undefined, '', '   ']) {
      const plan = planMoveToSpace({ targetName, activeSpaceName: 'Work', pinScope: null });
      assert.equal(plan.action, 'error');
      assert.match(plan.error, /Usage: move to space/);
    }
  });

  it('sets membership when the target is the active space', () => {
    const plan = planMoveToSpace({ targetName: 'Work', activeSpaceName: 'Work', pinScope: null });
    assert.equal(plan.action, 'set-membership');
  });

  it('ignores surrounding spaces in the target name, as switch space does', () => {
    const plan = planMoveToSpace({ targetName: '  Work ', activeSpaceName: 'Work', pinScope: null });
    assert.equal(plan.action, 'set-membership');
  });

  it('re-associates a workspace-pinned window', () => {
    const plan = planMoveToSpace({ targetName: 'Work', activeSpaceName: 'Work', pinScope: 'workspace' });
    assert.equal(plan.action, 'set-membership');
  });

  it('leaves a globally pinned window alone and says so', () => {
    const plan = planMoveToSpace({ targetName: 'Work', activeSpaceName: 'Work', pinScope: 'global' });
    assert.equal(plan.action, 'error');
    assert.match(plan.error, /every workspace/);
  });

  it('refuses an inactive target, since its saved snapshot cannot take the window yet', () => {
    const plan = planMoveToSpace({ targetName: 'Play', activeSpaceName: 'Work', pinScope: null });
    assert.equal(plan.action, 'error');
    assert.match(plan.error, /not the active space/);
  });
});
