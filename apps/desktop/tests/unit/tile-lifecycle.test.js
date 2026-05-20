/**
 * tile-lifecycle — state store + transition helper tests.
 *
 * Imports from the compiled dist output (the module is TypeScript,
 * compiled by `yarn build` into `dist/backend/electron/tile-lifecycle.js`).
 * Uses Node's built-in test runner under Electron's Node context via
 * `yarn test:unit`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  transition,
  getState,
  listStates,
  getLastTransition,
  isDispatchReady,
  acceptsRegistration,
  resetForTests,
  STATES,
  TRIGGERS,
} from '../../dist/main/tile-lifecycle.js';

/**
 * Walk the FSM from `unregistered` up to `target` via legitimate
 * transitions. Tests use this instead of a back-door state setter so
 * the engine's single-entry-point invariant is preserved.
 */
function seed(tileId, entryId, target) {
  const path = {
    [STATES.UNREGISTERED]: [],
    [STATES.REGISTERED]: [TRIGGERS.INSTALL],
    [STATES.LOADING]: [TRIGGERS.INSTALL, TRIGGERS.LOAD],
    [STATES.READY]: [TRIGGERS.INSTALL, TRIGGERS.LOAD, TRIGGERS.TILE_READY],
    [STATES.VISIBLE]: [TRIGGERS.INSTALL, TRIGGERS.LOAD, TRIGGERS.TILE_READY, TRIGGERS.SHOW],
    [STATES.UNLOADING]: [TRIGGERS.INSTALL, TRIGGERS.LOAD, TRIGGERS.TILE_READY, TRIGGERS.SHUTDOWN],
    [STATES.CRASHED]: [TRIGGERS.INSTALL, TRIGGERS.LOAD, TRIGGERS.TILE_READY, TRIGGERS.RENDER_GONE],
  }[target];
  if (!path) throw new Error(`seed: no path to ${target}`);
  for (const trigger of path) {
    const r = transition(tileId, entryId, trigger);
    if (!r.ok) throw new Error(`seed ${tileId}/${entryId} → ${target}: ${trigger} failed: ${r.error}`);
  }
}

test('unknown tile starts in unregistered state', () => {
  resetForTests();
  assert.equal(getState('example', 'home'), STATES.UNREGISTERED);
});

test('happy path: unregistered → registered → loading → ready → visible', () => {
  resetForTests();
  const tileId = 'example';
  const entryId = 'home';

  assert.equal(transition(tileId, entryId, TRIGGERS.INSTALL).ok, true);
  assert.equal(getState(tileId, entryId), STATES.REGISTERED);

  assert.equal(transition(tileId, entryId, TRIGGERS.LOAD).ok, true);
  assert.equal(getState(tileId, entryId), STATES.LOADING);

  assert.equal(transition(tileId, entryId, TRIGGERS.TILE_READY).ok, true);
  assert.equal(getState(tileId, entryId), STATES.READY);

  assert.equal(transition(tileId, entryId, TRIGGERS.SHOW).ok, true);
  assert.equal(getState(tileId, entryId), STATES.VISIBLE);
});

test('disallowed transition returns ok:false and does not mutate state', () => {
  resetForTests();
  transition('example', 'home', TRIGGERS.INSTALL);
  // Can't skip from registered → ready directly (must go through loading)
  const result = transition('example', 'home', TRIGGERS.TILE_READY);
  assert.equal(result.ok, false);
  assert.equal(getState('example', 'home'), STATES.REGISTERED);
});

test('render crash from ready lands in crashed state', () => {
  resetForTests();
  transition('example', 'home', TRIGGERS.INSTALL);
  transition('example', 'home', TRIGGERS.LOAD);
  transition('example', 'home', TRIGGERS.TILE_READY);
  transition('example', 'home', TRIGGERS.RENDER_GONE);
  assert.equal(getState('example', 'home'), STATES.CRASHED);
});

test('crashed tile can recover via cleanup-keep back to registered', () => {
  resetForTests();
  seed('example', 'home', STATES.CRASHED);
  transition('example', 'home', TRIGGERS.CLEANUP_KEEP);
  assert.equal(getState('example', 'home'), STATES.REGISTERED);
});

test('dispatch-ready only for ready and visible', () => {
  // Walk the FSM to each state that's reachable and check dispatch
  // readiness. `unregistered` is the implicit default (no record
  // yet), so we test it without any seeding.
  resetForTests();
  assert.equal(isDispatchReady('x', 'y'), false); // unregistered

  for (const state of Object.values(STATES)) {
    if (state === STATES.UNREGISTERED) continue;
    resetForTests();
    seed('x', 'y', state);
    const expected = state === STATES.READY || state === STATES.VISIBLE;
    assert.equal(isDispatchReady('x', 'y'), expected, `isDispatchReady for ${state}`);
    assert.equal(acceptsRegistration('x', 'y'), expected, `acceptsRegistration for ${state}`);
  }
});

test('listStates returns snapshot of all tracked tiles', () => {
  resetForTests();
  transition('a', 'home', TRIGGERS.INSTALL);
  transition('b', 'home', TRIGGERS.INSTALL);
  transition('b', 'home', TRIGGERS.LOAD);

  const snap = listStates();
  const byKey = new Map(snap.map(r => [`${r.tileId}:${r.entryId}`, r.state]));
  assert.equal(byKey.get('a:home'), STATES.REGISTERED);
  assert.equal(byKey.get('b:home'), STATES.LOADING);
});

test('getLastTransition records from/to/trigger', () => {
  resetForTests();
  transition('example', 'home', TRIGGERS.INSTALL);
  transition('example', 'home', TRIGGERS.LOAD);
  const last = getLastTransition('example', 'home');
  assert.ok(last);
  assert.equal(last.from, STATES.REGISTERED);
  assert.equal(last.to, STATES.LOADING);
  assert.equal(last.trigger, TRIGGERS.LOAD);
  assert.ok(last.timestamp > 0);
});

test('transition context is preserved in lastTransition record', () => {
  resetForTests();
  transition('example', 'home', TRIGGERS.INSTALL, { source: 'boot-discovery' });
  const last = getLastTransition('example', 'home');
  assert.deepEqual(last?.context, { source: 'boot-discovery' });
});

test('disallowed transition does not record a transition', () => {
  resetForTests();
  transition('example', 'home', TRIGGERS.INSTALL);
  const before = getLastTransition('example', 'home');
  transition('example', 'home', TRIGGERS.TILE_READY); // not allowed from registered
  const after = getLastTransition('example', 'home');
  assert.deepEqual(after, before);
});

test('cleanup-purge removes the record from listStates (no leak)', () => {
  resetForTests();
  transition('example', 'home', TRIGGERS.INSTALL);
  transition('example', 'home', TRIGGERS.LOAD);
  transition('example', 'home', TRIGGERS.SHUTDOWN);
  transition('example', 'home', TRIGGERS.CLEANUP_PURGE);

  assert.equal(getState('example', 'home'), STATES.UNREGISTERED);
  // The record should be gone — listStates is empty, reinstalling
  // starts from a clean slate.
  assert.equal(listStates().length, 0);
});

test('uninstall from registered removes the record', () => {
  resetForTests();
  transition('example', 'home', TRIGGERS.INSTALL);
  transition('example', 'home', TRIGGERS.UNINSTALL);
  assert.equal(listStates().length, 0);
});

test('key encoding handles tileIds with colons (e.g. atproto handles)', () => {
  resetForTests();
  const tileId = 'at://did:plc:abcdef/feature';
  transition(tileId, 'home', TRIGGERS.INSTALL);
  transition(tileId, 'home', TRIGGERS.LOAD);
  assert.equal(getState(tileId, 'home'), STATES.LOADING);

  const snap = listStates();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].tileId, tileId);
  assert.equal(snap[0].entryId, 'home');
});

test('resetForTests() throws outside NODE_ENV=test', () => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(() => resetForTests(), /NODE_ENV=test/);
  } finally {
    process.env.NODE_ENV = original;
  }
});
