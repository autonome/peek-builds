/**
 * Unit tests for planDeleteSpace in features/spaces/config.js.
 *
 * Run via: node --test tests/unit/spaces-delete-plan.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', 'features', 'spaces', 'config.js');
const { planDeleteSpace } = await import(modulePath);

const tags = [
  { id: 'tag-default', name: 'space:Default' },
  { id: 'tag-work', name: 'space:Work' },
  { id: 'tag-play', name: 'space:play-raw', metadata: { displayName: 'Play' } },
];

const plan = (targetName, activeSpaceId) => planDeleteSpace({
  targetName,
  tags,
  activeSpaceId,
  defaultSpaceId: 'tag-default',
  defaultSpaceName: 'Default',
});

describe('planDeleteSpace', () => {
  it('asks for a name when none is given', () => {
    for (const name of [undefined, null, '', '   ']) {
      const p = plan(name, 'tag-default');
      assert.equal(p.action, 'error');
      assert.match(p.error, /Usage: delete space/);
    }
  });

  it('refuses the default space by name, in any case', () => {
    for (const name of ['Default', ' default ']) {
      const p = plan(name, 'tag-work');
      assert.equal(p.action, 'error');
      assert.match(p.error, /default space cannot be deleted/);
    }
  });

  it('refuses the default space when its tag is matched by display name too', () => {
    const p = planDeleteSpace({
      targetName: 'Home',
      tags: [{ id: 'tag-default', name: 'space:Home' }],
      activeSpaceId: null,
      defaultSpaceId: 'tag-default',
      defaultSpaceName: 'Default',
    });
    assert.equal(p.action, 'error');
    assert.match(p.error, /default space cannot be deleted/);
  });

  it('reports a name that matches no space', () => {
    const p = plan(' Nope ', 'tag-default');
    assert.equal(p.action, 'error');
    assert.equal(p.error, 'No space named "Nope"');
  });

  it('reopens the default when the space being deleted is active', () => {
    const p = plan('work', 'tag-work');
    assert.deepEqual(p, { action: 'reload-default', targetId: 'tag-work', targetName: 'Work' });
  });

  it('reopens the default when the default is active, so its own windows are saved first', () => {
    const p = plan('Work', 'tag-default');
    assert.deepEqual(p, { action: 'reload-default', targetId: 'tag-work', targetName: 'Work' });
  });

  it('treats no active space as the default being active', () => {
    const p = plan('Work', null);
    assert.equal(p.action, 'reload-default');
  });

  it('only moves saved rows when some third space is active', () => {
    const p = plan('Play', 'tag-work');
    assert.deepEqual(p, { action: 'rows-only', targetId: 'tag-play', targetName: 'Play' });
  });

  it('copes with a missing tag list', () => {
    const p = planDeleteSpace({
      targetName: 'Work', tags: undefined, activeSpaceId: 'tag-default',
      defaultSpaceId: 'tag-default', defaultSpaceName: 'Default',
    });
    assert.equal(p.action, 'error');
    assert.equal(p.error, 'No space named "Work"');
  });
});
