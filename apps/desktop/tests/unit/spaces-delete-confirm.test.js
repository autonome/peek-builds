/**
 * Unit tests for the space-deletion confirmation helpers in
 * features/spaces/config.js: the prompt text, and the spaces-page address
 * the `delete space` command opens to ask it.
 *
 * Run via: node --test tests/unit/spaces-delete-confirm.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', 'features', 'spaces', 'config.js');
const { deleteSpaceConfirmText, deleteSpacePromptUrl, deleteSpaceNameFromQuery } = await import(modulePath);

describe('deleteSpaceConfirmText', () => {
  it('names the space and how many windows move to the default space', () => {
    assert.equal(
      deleteSpaceConfirmText('Work', 3),
      'Delete space "Work"? Its 3 windows will move to the default space.'
    );
  });

  it('uses the singular for one window', () => {
    assert.equal(
      deleteSpaceConfirmText('Work', 1),
      'Delete space "Work"? Its 1 window will move to the default space.'
    );
  });

  it('says there is nothing to move when the space holds no windows', () => {
    assert.equal(
      deleteSpaceConfirmText('Work', 0),
      'Delete space "Work"? It has no windows to move.'
    );
  });

  it('still says windows move to the default space when the count is unknown', () => {
    assert.equal(
      deleteSpaceConfirmText('Work', null),
      'Delete space "Work"? Any windows in it will move to the default space.'
    );
  });
});

describe('deleteSpacePromptUrl / deleteSpaceNameFromQuery', () => {
  it('carries the space name through the spaces page address', () => {
    const url = deleteSpacePromptUrl('Work & Play');
    assert.ok(url.startsWith('peek://spaces/home.html?'));
    assert.equal(deleteSpaceNameFromQuery(new URL(url).search), 'Work & Play');
  });

  it('answers empty for an address that asks no deletion', () => {
    assert.equal(deleteSpaceNameFromQuery(''), '');
    assert.equal(deleteSpaceNameFromQuery('?spaceId=1'), '');
    assert.equal(deleteSpaceNameFromQuery('?deleteSpace=%20%20'), '');
  });
});
