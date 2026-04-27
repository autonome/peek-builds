/**
 * Unit tests for app/page/page-fsm.js — pure state machine for the
 * page-host renderer's NORMAL ↔ MAXIMIZED lifecycle.
 *
 * No DOM; no IPC; no api.* — just transition() input → output.
 * Run via the standard Electron-as-node unit-test runner:
 *   yarn test:unit tests/unit/page-fsm.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATES, EVENTS, EFFECTS, INITIAL_STATE, transition, run,
} from '../../app/page/page-fsm.js';

const effectTypes = (effects) => effects.map(e => e.type);

describe('page-fsm: initial state', () => {
  it('starts in INITIALIZING', () => {
    assert.equal(INITIAL_STATE, STATES.INITIALIZING);
  });
});

describe('page-fsm: INITIALIZING → NORMAL (no maximize hint)', () => {
  it('init.complete with maximized=false transitions to NORMAL with no effects', () => {
    const { state, effects } = transition(STATES.INITIALIZING, {
      type: EVENTS.INIT_COMPLETE,
      maximized: false,
    });
    assert.equal(state, STATES.NORMAL);
    assert.deepEqual(effects, []);
  });

  it('init.complete with maximized omitted defaults to NORMAL', () => {
    const { state, effects } = transition(STATES.INITIALIZING, {
      type: EVENTS.INIT_COMPLETE,
    });
    assert.equal(state, STATES.NORMAL);
    assert.deepEqual(effects, []);
  });
});

describe('page-fsm: INITIALIZING → MAXIMIZED (restored from session)', () => {
  it('init.complete with maximized=true transitions to MAXIMIZED with body/handle effects', () => {
    const { state, effects } = transition(STATES.INITIALIZING, {
      type: EVENTS.INIT_COMPLETE,
      maximized: true,
    });
    assert.equal(state, STATES.MAXIMIZED);
    // The effects must keep DOM observables in sync with the state:
    // body class on, handles hidden. No setBounds — the browser window
    // already came in sized to the work area.
    assert.deepEqual(effectTypes(effects), [
      EFFECTS.SET_BODY_MAXIMIZED,
      EFFECTS.SET_HANDLES_VISIBLE,
    ]);
    assert.equal(effects[0].value, true);
    assert.equal(effects[1].value, false);
  });

  it('does NOT emit ENTER_MAXIMIZED_LAYOUT on init — screenBounds are already maximized', () => {
    const { effects } = transition(STATES.INITIALIZING, {
      type: EVENTS.INIT_COMPLETE,
      maximized: true,
    });
    assert.ok(!effectTypes(effects).includes(EFFECTS.ENTER_MAXIMIZED_LAYOUT));
  });
});

describe('page-fsm: NORMAL → MAXIMIZED', () => {
  it('toggle_maximize captures pre-state, applies layout, syncs body/handles/URL', () => {
    const { state, effects } = transition(STATES.NORMAL, {
      type: EVENTS.TOGGLE_MAXIMIZE,
    });
    assert.equal(state, STATES.MAXIMIZED);
    assert.deepEqual(effectTypes(effects), [
      EFFECTS.CAPTURE_PRE_MAXIMIZE,
      EFFECTS.ENTER_MAXIMIZED_LAYOUT,
      EFFECTS.SET_BODY_MAXIMIZED,
      EFFECTS.SET_HANDLES_VISIBLE,
      EFFECTS.SET_URL_MAXIMIZED,
    ]);
  });

  it('CAPTURE_PRE_MAXIMIZE comes before ENTER_MAXIMIZED_LAYOUT (must capture before clobber)', () => {
    const { effects } = transition(STATES.NORMAL, {
      type: EVENTS.TOGGLE_MAXIMIZE,
    });
    const capIdx = effectTypes(effects).indexOf(EFFECTS.CAPTURE_PRE_MAXIMIZE);
    const enterIdx = effectTypes(effects).indexOf(EFFECTS.ENTER_MAXIMIZED_LAYOUT);
    assert.ok(capIdx >= 0 && enterIdx >= 0);
    assert.ok(capIdx < enterIdx, 'must capture pre-state before entering maximized layout');
  });
});

describe('page-fsm: MAXIMIZED → NORMAL', () => {
  it('toggle_maximize restores pre-state and clears body/handles/URL', () => {
    const { state, effects } = transition(STATES.MAXIMIZED, {
      type: EVENTS.TOGGLE_MAXIMIZE,
    });
    assert.equal(state, STATES.NORMAL);
    assert.deepEqual(effectTypes(effects), [
      EFFECTS.RESTORE_PRE_MAXIMIZE,
      EFFECTS.SET_BODY_MAXIMIZED,
      EFFECTS.SET_HANDLES_VISIBLE,
      EFFECTS.SET_URL_MAXIMIZED,
    ]);
    // body off, handles on, url removed
    const setBody = effects.find(e => e.type === EFFECTS.SET_BODY_MAXIMIZED);
    const setHandles = effects.find(e => e.type === EFFECTS.SET_HANDLES_VISIBLE);
    const setUrl = effects.find(e => e.type === EFFECTS.SET_URL_MAXIMIZED);
    assert.equal(setBody.value, false);
    assert.equal(setHandles.value, true);
    assert.equal(setUrl.value, false);
  });
});

describe('page-fsm: illegal transitions', () => {
  it('TOGGLE_MAXIMIZE in INITIALIZING is rejected with a warning, state unchanged', () => {
    const { state, effects, warning } = transition(STATES.INITIALIZING, {
      type: EVENTS.TOGGLE_MAXIMIZE,
    });
    assert.equal(state, STATES.INITIALIZING);
    assert.deepEqual(effects, []);
    assert.match(warning, /Illegal event/);
  });

  it('duplicate INIT_COMPLETE in NORMAL is a no-op with a warning', () => {
    const { state, effects, warning } = transition(STATES.NORMAL, {
      type: EVENTS.INIT_COMPLETE,
    });
    assert.equal(state, STATES.NORMAL);
    assert.deepEqual(effects, []);
    assert.match(warning, /Duplicate INIT_COMPLETE/);
  });

  it('duplicate INIT_COMPLETE in MAXIMIZED is a no-op with a warning', () => {
    const { state, effects, warning } = transition(STATES.MAXIMIZED, {
      type: EVENTS.INIT_COMPLETE,
    });
    assert.equal(state, STATES.MAXIMIZED);
    assert.deepEqual(effects, []);
    assert.match(warning, /Duplicate INIT_COMPLETE/);
  });

  it('malformed event (missing type) is rejected', () => {
    const { state, effects, warning } = transition(STATES.NORMAL, null);
    assert.equal(state, STATES.NORMAL);
    assert.deepEqual(effects, []);
    assert.match(warning, /malformed event/);
  });
});

// ────────────────────────────────────────────────────────────────────
// Phase 2: drag/resize states
// ────────────────────────────────────────────────────────────────────

describe('page-fsm: NORMAL → DRAGGING', () => {
  it('drag.start from NORMAL transitions to DRAGGING and shows the overlay', () => {
    const { state, effects } = transition(STATES.NORMAL, { type: EVENTS.DRAG_START });
    assert.equal(state, STATES.DRAGGING);
    assert.deepEqual(effectTypes(effects), [EFFECTS.SHOW_DRAG_OVERLAY]);
  });
});

describe('page-fsm: DRAGGING self-loops + exit', () => {
  it('drag.move in DRAGGING is a self-loop with no effects', () => {
    const { state, effects } = transition(STATES.DRAGGING, { type: EVENTS.DRAG_MOVE });
    assert.equal(state, STATES.DRAGGING);
    assert.deepEqual(effects, []);
  });

  it('drag.end from DRAGGING returns to NORMAL and hides the overlay', () => {
    const { state, effects } = transition(STATES.DRAGGING, { type: EVENTS.DRAG_END });
    assert.equal(state, STATES.NORMAL);
    assert.deepEqual(effectTypes(effects), [EFFECTS.HIDE_DRAG_OVERLAY]);
  });

  it('duplicate drag.start in DRAGGING is a tolerated no-op (input race)', () => {
    const { state, effects, warning } = transition(STATES.DRAGGING, { type: EVENTS.DRAG_START });
    assert.equal(state, STATES.DRAGGING);
    assert.deepEqual(effects, []);
    assert.equal(warning, undefined);
  });
});

describe('page-fsm: MAXIMIZED → DRAGGING_OUT_OF_MAXIMIZED', () => {
  it('drag.start from MAXIMIZED exits maximized + transitions to DRAGGING_OUT_OF_MAXIMIZED', () => {
    const { state, effects } = transition(STATES.MAXIMIZED, { type: EVENTS.DRAG_START });
    assert.equal(state, STATES.DRAGGING_OUT_OF_MAXIMIZED);
    // Order matters: exit maximized layout first (to set bounds + sync DOM),
    // then show drag overlay so the user sees the exit.
    assert.deepEqual(effectTypes(effects), [
      EFFECTS.EXIT_MAXIMIZED_FOR_DRAG,
      EFFECTS.SET_BODY_MAXIMIZED,
      EFFECTS.SET_HANDLES_VISIBLE,
      EFFECTS.SET_URL_MAXIMIZED,
      EFFECTS.SHOW_DRAG_OVERLAY,
    ]);
    const setBody = effects.find(e => e.type === EFFECTS.SET_BODY_MAXIMIZED);
    assert.equal(setBody.value, false);
  });

  it('drag.end from DRAGGING_OUT_OF_MAXIMIZED lands in NORMAL (never re-enters MAXIMIZED)', () => {
    const { state, effects } = transition(STATES.DRAGGING_OUT_OF_MAXIMIZED, { type: EVENTS.DRAG_END });
    assert.equal(state, STATES.NORMAL);
    assert.deepEqual(effectTypes(effects), [EFFECTS.HIDE_DRAG_OVERLAY]);
  });

  it('drag.move in DRAGGING_OUT_OF_MAXIMIZED is a self-loop', () => {
    const { state, effects } = transition(STATES.DRAGGING_OUT_OF_MAXIMIZED, { type: EVENTS.DRAG_MOVE });
    assert.equal(state, STATES.DRAGGING_OUT_OF_MAXIMIZED);
    assert.deepEqual(effects, []);
  });
});

describe('page-fsm: NORMAL ↔ RESIZING', () => {
  it('resize.start from NORMAL transitions to RESIZING with no effects (handle visibility unchanged)', () => {
    const { state, effects } = transition(STATES.NORMAL, { type: EVENTS.RESIZE_START });
    assert.equal(state, STATES.RESIZING);
    assert.deepEqual(effects, []);
  });

  it('resize.move in RESIZING is a self-loop', () => {
    const { state, effects } = transition(STATES.RESIZING, { type: EVENTS.RESIZE_MOVE });
    assert.equal(state, STATES.RESIZING);
    assert.deepEqual(effects, []);
  });

  it('resize.end from RESIZING returns to NORMAL', () => {
    const { state, effects } = transition(STATES.RESIZING, { type: EVENTS.RESIZE_END });
    assert.equal(state, STATES.NORMAL);
    assert.deepEqual(effects, []);
  });
});

describe('page-fsm: drag/resize illegal transitions', () => {
  it('drag.start in MAXIMIZED is the drag-out-of-max path, not illegal', () => {
    const { state, warning } = transition(STATES.MAXIMIZED, { type: EVENTS.DRAG_START });
    assert.equal(state, STATES.DRAGGING_OUT_OF_MAXIMIZED);
    assert.equal(warning, undefined);
  });

  it('toggle_maximize in DRAGGING is rejected (must end drag first)', () => {
    const { state, warning } = transition(STATES.DRAGGING, { type: EVENTS.TOGGLE_MAXIMIZE });
    assert.equal(state, STATES.DRAGGING);
    assert.match(warning, /Illegal event/);
  });

  it('resize.start in DRAGGING is rejected', () => {
    const { state, warning } = transition(STATES.DRAGGING, { type: EVENTS.RESIZE_START });
    assert.equal(state, STATES.DRAGGING);
    assert.match(warning, /Illegal event/);
  });

  it('drag.start in RESIZING is rejected', () => {
    const { state, warning } = transition(STATES.RESIZING, { type: EVENTS.DRAG_START });
    assert.equal(state, STATES.RESIZING);
    assert.match(warning, /Illegal event/);
  });

  it('drag.start in INITIALIZING is rejected', () => {
    const { state, warning } = transition(STATES.INITIALIZING, { type: EVENTS.DRAG_START });
    assert.equal(state, STATES.INITIALIZING);
    assert.match(warning, /Illegal event/);
  });
});

describe('page-fsm: drag/resize end-to-end runs', () => {
  it('init→drag.start→drag.move→drag.end lands in NORMAL', () => {
    const { state } = run([
      { type: EVENTS.INIT_COMPLETE, maximized: false },
      { type: EVENTS.DRAG_START },
      { type: EVENTS.DRAG_MOVE },
      { type: EVENTS.DRAG_MOVE },
      { type: EVENTS.DRAG_END },
    ]);
    assert.equal(state, STATES.NORMAL);
  });

  it('init→toggle_maximize→drag.start→drag.end lands in NORMAL (drag-out-of-max never re-enters MAXIMIZED)', () => {
    const { state } = run([
      { type: EVENTS.INIT_COMPLETE, maximized: false },
      { type: EVENTS.TOGGLE_MAXIMIZE },
      { type: EVENTS.DRAG_START },
      { type: EVENTS.DRAG_MOVE },
      { type: EVENTS.DRAG_END },
    ]);
    assert.equal(state, STATES.NORMAL);
  });

  it('init→resize.start→resize.move→resize.end lands in NORMAL', () => {
    const { state } = run([
      { type: EVENTS.INIT_COMPLETE, maximized: false },
      { type: EVENTS.RESIZE_START },
      { type: EVENTS.RESIZE_MOVE },
      { type: EVENTS.RESIZE_END },
    ]);
    assert.equal(state, STATES.NORMAL);
  });
});

describe('page-fsm: end-to-end run() — round-trip via maximize toggle', () => {
  it('init→maximize→unmaximize lands back in NORMAL with no leftover effects', () => {
    const { state } = run([
      { type: EVENTS.INIT_COMPLETE, maximized: false },
      { type: EVENTS.TOGGLE_MAXIMIZE },
      { type: EVENTS.TOGGLE_MAXIMIZE },
    ]);
    assert.equal(state, STATES.NORMAL);
  });

  it('restored maximized window stays MAXIMIZED until user toggles', () => {
    const { state, effects } = run([
      { type: EVENTS.INIT_COMPLETE, maximized: true },
    ]);
    assert.equal(state, STATES.MAXIMIZED);
    // Body class + handle visibility must be set so DOM matches FSM state
    // — this is exactly the assertion the failing Playwright spec encodes.
    const types = effectTypes(effects);
    assert.ok(types.includes(EFFECTS.SET_BODY_MAXIMIZED));
    assert.ok(types.includes(EFFECTS.SET_HANDLES_VISIBLE));
  });

  it('restored maximized window then user toggle: lands in NORMAL with restore effects', () => {
    const { state, effects } = run([
      { type: EVENTS.INIT_COMPLETE, maximized: true },
      { type: EVENTS.TOGGLE_MAXIMIZE },
    ]);
    assert.equal(state, STATES.NORMAL);
    // The exit-MAXIMIZED transition must restore pre-state
    assert.ok(effectTypes(effects).includes(EFFECTS.RESTORE_PRE_MAXIMIZE));
  });
});
