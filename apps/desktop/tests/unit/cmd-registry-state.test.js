/**
 * Unit tests for createRegistryMirror in renderer/cmd/registry-state.js.
 *
 * Run via: node --test tests/unit/cmd-registry-state.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', 'renderer', 'cmd', 'registry-state.js');
const { createRegistryMirror } = await import(modulePath);

const spaceCmd = (options) => ({ name: 'move to space', params: [{ name: 'space', options }] });

describe('createRegistryMirror', () => {
  it('applies the first state', () => {
    const mirror = createRegistryMirror();
    assert.equal(mirror.apply({ version: 1, commands: [spaceCmd(['a'])] }), true);
    assert.deepEqual(mirror.commands[0].params[0].options, ['a']);
  });

  it('ignores a late snapshot older than the state already applied', () => {
    const mirror = createRegistryMirror();
    mirror.apply({ version: 5, commands: [spaceCmd(['a', 'b'])] });
    assert.equal(mirror.apply({ version: 3, commands: [spaceCmd([])] }), false);
    assert.deepEqual(mirror.commands[0].params[0].options, ['a', 'b']);
    assert.equal(mirror.version, 5);
  });

  it('ignores a repeat of the same version', () => {
    const mirror = createRegistryMirror();
    mirror.apply({ version: 2, commands: [spaceCmd(['a'])] });
    assert.equal(mirror.apply({ version: 2, commands: [spaceCmd([])] }), false);
  });

  it('accepts a restarted registry whose version is lower', () => {
    const mirror = createRegistryMirror();
    mirror.apply({ instance: 'one', version: 9, commands: [spaceCmd(['a'])] });
    assert.equal(mirror.apply({ instance: 'two', version: 1, commands: [spaceCmd(['b'])] }), true);
    assert.deepEqual(mirror.commands[0].params[0].options, ['b']);
    assert.equal(mirror.apply({ instance: 'two', version: 1, commands: [spaceCmd([])] }), false);
    assert.equal(mirror.apply({ instance: 'one', version: 10, commands: [spaceCmd([])] }), true);
  });

  it('ignores a state without a numeric version', () => {
    const mirror = createRegistryMirror();
    assert.equal(mirror.apply({ commands: [spaceCmd(['a'])] }), false);
    assert.deepEqual(mirror.commands, []);
  });

  it('replaces the whole command list, dropping commands absent from the newer state', () => {
    const mirror = createRegistryMirror();
    mirror.apply({ version: 1, commands: [spaceCmd(['a']), { name: 'other' }] });
    mirror.apply({ version: 2, commands: [spaceCmd(['a'])] });
    assert.deepEqual(mirror.commands.map(c => c.name), ['move to space']);
  });
});
