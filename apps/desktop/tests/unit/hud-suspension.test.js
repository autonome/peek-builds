import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySuspensionChange, suspensionRows } from '../../features/hud/hud-suspension.js';

const change = (tileId, from, to, observeOnly = false) => ({ tileId, from, to, observeOnly });

test('tracks the latest state and counts carried-out unloads', () => {
  const state = new Map();
  applySuspensionChange(state, change('notes', 'suspended', 'waking'));
  applySuspensionChange(state, change('notes', 'waking', 'idle'));
  applySuspensionChange(state, change('notes', 'idle', 'suspending'));
  applySuspensionChange(state, change('notes', 'suspending', 'suspended'));
  assert.deepEqual(suspensionRows(state), [['notes', 'unloaded (unloaded 1x)']]);
});

test('an observe-only decision is not counted as an unload', () => {
  const state = new Map();
  applySuspensionChange(state, change('notes', 'idle', 'suspending', true));
  applySuspensionChange(state, change('notes', 'suspending', 'suspended', true));
  assert.deepEqual(suspensionRows(state), [['notes', 'unloaded']]);
});

test('unloaded features sort first, then by name', () => {
  const state = new Map();
  applySuspensionChange(state, change('b', 'waking', 'idle'));
  applySuspensionChange(state, change('c', 'idle', 'suspended'));
  applySuspensionChange(state, change('a', 'waking', 'active'));
  assert.deepEqual(suspensionRows(state).map(r => r[0]), ['c', 'a', 'b']);
});

test('ignores malformed messages', () => {
  const state = new Map();
  applySuspensionChange(state, null);
  applySuspensionChange(state, { tileId: 3 });
  assert.equal(state.size, 0);
});
