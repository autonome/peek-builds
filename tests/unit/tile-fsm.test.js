/**
 * Tile Lifecycle FSM — pure transition tests.
 *
 * These tests exercise `validateTransition` against every state×trigger
 * combination, asserting the full table from docs/tile-lifecycle-fsm.md.
 * Any drift from the documented policy fails the test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STATES,
  TRIGGERS,
  validateTransition,
  allowedTriggers,
  isDispatchable,
  acceptsDynamicRegistration,
  DISPATCHABLE_STATES,
  DYNAMIC_REGISTRATION_STATES,
} from '../../dist/backend/electron/tile-fsm.js';

// ---------------------------------------------------------------------------
// Allowed transitions (doc source of truth — keep in sync with FSM table)
// ---------------------------------------------------------------------------

const ALLOWED = [
  // unregistered
  { from: STATES.UNREGISTERED, trigger: TRIGGERS.INSTALL,       to: STATES.REGISTERED },

  // registered
  { from: STATES.REGISTERED,   trigger: TRIGGERS.LOAD,          to: STATES.LOADING },
  { from: STATES.REGISTERED,   trigger: TRIGGERS.UNINSTALL,     to: STATES.UNREGISTERED },

  // loading
  { from: STATES.LOADING,      trigger: TRIGGERS.TILE_READY,    to: STATES.READY },
  { from: STATES.LOADING,      trigger: TRIGGERS.RENDER_GONE,   to: STATES.CRASHED },
  { from: STATES.LOADING,      trigger: TRIGGERS.SHUTDOWN,      to: STATES.UNLOADING },

  // ready
  { from: STATES.READY,        trigger: TRIGGERS.SHOW,          to: STATES.VISIBLE },
  { from: STATES.READY,        trigger: TRIGGERS.SHUTDOWN,      to: STATES.UNLOADING },
  { from: STATES.READY,        trigger: TRIGGERS.RENDER_GONE,   to: STATES.CRASHED },

  // visible
  { from: STATES.VISIBLE,      trigger: TRIGGERS.HIDE,          to: STATES.READY },
  { from: STATES.VISIBLE,      trigger: TRIGGERS.SHUTDOWN,      to: STATES.UNLOADING },
  { from: STATES.VISIBLE,      trigger: TRIGGERS.RENDER_GONE,   to: STATES.CRASHED },

  // unloading
  { from: STATES.UNLOADING,    trigger: TRIGGERS.CLEANUP_KEEP,  to: STATES.REGISTERED },
  { from: STATES.UNLOADING,    trigger: TRIGGERS.CLEANUP_PURGE, to: STATES.UNREGISTERED },

  // crashed
  { from: STATES.CRASHED,      trigger: TRIGGERS.CLEANUP_KEEP,  to: STATES.REGISTERED },
  { from: STATES.CRASHED,      trigger: TRIGGERS.RELAUNCH,      to: STATES.LOADING },
  { from: STATES.CRASHED,      trigger: TRIGGERS.UNINSTALL,     to: STATES.UNREGISTERED },
];

test('every documented transition is accepted by validateTransition', () => {
  for (const { from, trigger, to } of ALLOWED) {
    const result = validateTransition(from, trigger);
    assert.deepEqual(result, { ok: true, to }, `expected ${from} —${trigger}→ ${to}`);
  }
});

test('every undocumented transition is rejected', () => {
  const allStates = Object.values(STATES);
  const allTriggers = Object.values(TRIGGERS);
  const allowedSet = new Set(ALLOWED.map(t => `${t.from}|${t.trigger}`));

  for (const from of allStates) {
    for (const trigger of allTriggers) {
      const key = `${from}|${trigger}`;
      if (allowedSet.has(key)) continue;
      const result = validateTransition(from, trigger);
      assert.equal(result.ok, false, `should reject ${from} —${trigger}→ ?`);
      assert.match(result.error, /disallowed|unknown/);
    }
  }
});

test('validateTransition from an unknown state returns an error, does not throw', () => {
  const result = validateTransition('totally-invented', TRIGGERS.LOAD);
  assert.equal(result.ok, false);
  assert.match(result.error, /unknown state/);
});

test('allowedTriggers returns the documented set for each state', () => {
  const expected = {
    [STATES.UNREGISTERED]: [TRIGGERS.INSTALL],
    [STATES.REGISTERED]:   [TRIGGERS.LOAD, TRIGGERS.UNINSTALL],
    [STATES.LOADING]:      [TRIGGERS.TILE_READY, TRIGGERS.RENDER_GONE, TRIGGERS.SHUTDOWN],
    [STATES.READY]:        [TRIGGERS.SHOW, TRIGGERS.SHUTDOWN, TRIGGERS.RENDER_GONE],
    [STATES.VISIBLE]:      [TRIGGERS.HIDE, TRIGGERS.SHUTDOWN, TRIGGERS.RENDER_GONE],
    [STATES.UNLOADING]:    [TRIGGERS.CLEANUP_KEEP, TRIGGERS.CLEANUP_PURGE],
    [STATES.CRASHED]:      [TRIGGERS.CLEANUP_KEEP, TRIGGERS.RELAUNCH, TRIGGERS.UNINSTALL],
  };

  for (const [state, want] of Object.entries(expected)) {
    const got = allowedTriggers(state);
    assert.deepEqual(got.sort(), [...want].sort(), `allowedTriggers(${state})`);
  }
});

test('allowedTriggers returns [] for an unknown state', () => {
  assert.deepEqual(allowedTriggers('not-a-state'), []);
});

// ---------------------------------------------------------------------------
// Policy invariants (dispatch / dynamic registration gating)
// ---------------------------------------------------------------------------

test('dispatchable states: ready + visible only', () => {
  assert.equal(isDispatchable(STATES.READY), true);
  assert.equal(isDispatchable(STATES.VISIBLE), true);

  for (const s of [STATES.UNREGISTERED, STATES.REGISTERED, STATES.LOADING, STATES.UNLOADING, STATES.CRASHED]) {
    assert.equal(isDispatchable(s), false, `${s} should not be dispatchable`);
  }
});

test('dynamic registration states: ready + visible only', () => {
  assert.equal(acceptsDynamicRegistration(STATES.READY), true);
  assert.equal(acceptsDynamicRegistration(STATES.VISIBLE), true);

  for (const s of [STATES.UNREGISTERED, STATES.REGISTERED, STATES.LOADING, STATES.UNLOADING, STATES.CRASHED]) {
    assert.equal(acceptsDynamicRegistration(s), false, `${s} should not accept dynamic registration`);
  }
});

test('dispatchable and dynamic-registration state sets match the doc', () => {
  // Separate exports so they can diverge if policy ever requires it;
  // today they're the same list.
  assert.deepEqual(
    [...DISPATCHABLE_STATES].sort(),
    [STATES.READY, STATES.VISIBLE].sort(),
  );
  assert.deepEqual(
    [...DYNAMIC_REGISTRATION_STATES].sort(),
    [STATES.READY, STATES.VISIBLE].sort(),
  );
});

// ---------------------------------------------------------------------------
// Reachability (sanity — every state reachable from install, and every
// state has a path back to a terminal or recovery state)
// ---------------------------------------------------------------------------

test('every state is reachable from the unregistered root via allowed transitions', () => {
  // BFS from unregistered
  const seen = new Set([STATES.UNREGISTERED]);
  const queue = [STATES.UNREGISTERED];
  const allTriggers = Object.values(TRIGGERS);

  while (queue.length > 0) {
    const state = queue.shift();
    for (const t of allTriggers) {
      const r = validateTransition(state, t);
      if (r.ok && !seen.has(r.to)) {
        seen.add(r.to);
        queue.push(r.to);
      }
    }
  }

  for (const s of Object.values(STATES)) {
    assert.ok(seen.has(s), `state unreachable from unregistered: ${s}`);
  }
});
