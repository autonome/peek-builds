/**
 * The window opened when a space with no saved windows is entered is a user
 * gesture: it must declare itself regular so it is not registered as a
 * transient window and brings the app forward.
 *
 * Run via: node --test tests/unit/spaces-empty-space-window.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', 'features', 'spaces', 'config.js');
const { emptySpaceWindowOptions } = await import(modulePath);

describe('emptySpaceWindowOptions', () => {
  it('opens as a regular window so it is not transient', () => {
    const options = emptySpaceWindowOptions({ id: 't1' }, 'Work', '#fff');
    assert.equal(options.regular, true);
  });

  it('keeps the workspace role, size and space mode', () => {
    const options = emptySpaceWindowOptions({ id: 't1' }, 'Work', '#fff');
    assert.equal(options.role, 'workspace');
    assert.equal(options.width, 1024);
    assert.equal(options.height, 768);
    assert.deepEqual(options.spaceMode, { spaceId: 't1', spaceName: 'Work', color: '#fff' });
  });
});
