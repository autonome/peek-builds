/**
 * page-fsm.js — pure state machine for the page-host renderer.
 *
 * No DOM, no IPC, no api.* calls. The FSM owns the lifecycle state +
 * derives the side-effects each transition should produce; the runtime
 * adapter in `page.js` is the only thing that touches the DOM, calls
 * setBounds, or writes URL params.
 *
 * Today's scope: just the NORMAL ↔ MAXIMIZED lifecycle, because that's
 * the surface of the user-reported regression (restored maximized
 * windows losing their maximize state). DRAGGING / RESIZING /
 * DRAGGING_OUT_OF_MAXIMIZED states from the design doc are not yet
 * promoted into the FSM — page.js still owns those flags. Folding them
 * in is a follow-up; the test for that lives in
 * docs/page-host-state-machine.md.
 *
 * See: docs/page-host-state-machine.md, docs/cmd-state-machine.md
 */

export const STATES = Object.freeze({
  INITIALIZING: 'INITIALIZING',
  NORMAL: 'NORMAL',
  MAXIMIZED: 'MAXIMIZED',
});

export const EVENTS = Object.freeze({
  /** Page-host module finished evaluating; URL inputs parsed. */
  INIT_COMPLETE: 'INIT_COMPLETE',
  /** User asked to toggle maximize (cmd, navbar dblclick, pubsub). */
  TOGGLE_MAXIMIZE: 'TOGGLE_MAXIMIZE',
});

/** Initial FSM state. */
export const INITIAL_STATE = STATES.INITIALIZING;

/**
 * Effect descriptors emitted by transitions. The runtime adapter
 * pattern-matches on `type` and applies them.
 */
export const EFFECTS = Object.freeze({
  /** Add or remove the `maximized` class on document.body. */
  SET_BODY_MAXIMIZED: 'SET_BODY_MAXIMIZED',
  /** Add or remove the `maximized=1` URL param. */
  SET_URL_MAXIMIZED: 'SET_URL_MAXIMIZED',
  /** Hide or show the resize handles + show/hide the maximized layout. */
  SET_HANDLES_VISIBLE: 'SET_HANDLES_VISIBLE',
  /** Capture pre-maximize screen + window bounds before transitioning. */
  CAPTURE_PRE_MAXIMIZE: 'CAPTURE_PRE_MAXIMIZE',
  /** Restore screen + window bounds to the captured pre-maximize state. */
  RESTORE_PRE_MAXIMIZE: 'RESTORE_PRE_MAXIMIZE',
  /** Set screen bounds to the display work area (maximize). */
  ENTER_MAXIMIZED_LAYOUT: 'ENTER_MAXIMIZED_LAYOUT',
});

const e = (type, payload = {}) => ({ type, ...payload });

/**
 * Transition the FSM.
 *
 * @param {string} state Current FSM state.
 * @param {{ type: string, [key: string]: any }} event
 * @returns {{ state: string, effects: Array<object>, warning?: string }}
 *   New state and the side effects the runtime should apply, in order.
 */
export function transition(state, event) {
  if (!event || typeof event.type !== 'string') {
    return { state, effects: [], warning: `transition: malformed event ${JSON.stringify(event)}` };
  }

  switch (state) {
    case STATES.INITIALIZING: {
      if (event.type === EVENTS.INIT_COMPLETE) {
        // Init reads the page-host URL param `maximized`. If present,
        // we boot directly into MAXIMIZED — window-open has already
        // sized the BrowserWindow to the work area for us, so there's
        // no setBounds work to do. Otherwise enter NORMAL.
        if (event.maximized === true) {
          return {
            state: STATES.MAXIMIZED,
            effects: [
              e(EFFECTS.SET_BODY_MAXIMIZED, { value: true }),
              e(EFFECTS.SET_HANDLES_VISIBLE, { value: false }),
              // Note: no ENTER_MAXIMIZED_LAYOUT here — init's screenBounds
              // already came in as workArea (the saved URL params reflect
              // the maximized screenBounds). No setBounds either.
            ],
          };
        }
        return { state: STATES.NORMAL, effects: [] };
      }
      return { state, effects: [], warning: `Illegal event ${event.type} in ${state}` };
    }

    case STATES.NORMAL: {
      if (event.type === EVENTS.TOGGLE_MAXIMIZE) {
        return {
          state: STATES.MAXIMIZED,
          effects: [
            e(EFFECTS.CAPTURE_PRE_MAXIMIZE),
            e(EFFECTS.ENTER_MAXIMIZED_LAYOUT),
            e(EFFECTS.SET_BODY_MAXIMIZED, { value: true }),
            e(EFFECTS.SET_HANDLES_VISIBLE, { value: false }),
            e(EFFECTS.SET_URL_MAXIMIZED, { value: true }),
          ],
        };
      }
      if (event.type === EVENTS.INIT_COMPLETE) {
        return { state, effects: [], warning: 'Duplicate INIT_COMPLETE in NORMAL' };
      }
      return { state, effects: [], warning: `Illegal event ${event.type} in ${state}` };
    }

    case STATES.MAXIMIZED: {
      if (event.type === EVENTS.TOGGLE_MAXIMIZE) {
        return {
          state: STATES.NORMAL,
          effects: [
            e(EFFECTS.RESTORE_PRE_MAXIMIZE),
            e(EFFECTS.SET_BODY_MAXIMIZED, { value: false }),
            e(EFFECTS.SET_HANDLES_VISIBLE, { value: true }),
            e(EFFECTS.SET_URL_MAXIMIZED, { value: false }),
          ],
        };
      }
      if (event.type === EVENTS.INIT_COMPLETE) {
        return { state, effects: [], warning: 'Duplicate INIT_COMPLETE in MAXIMIZED' };
      }
      return { state, effects: [], warning: `Illegal event ${event.type} in ${state}` };
    }

    default:
      return { state, effects: [], warning: `Unknown state ${state}` };
  }
}

/**
 * Convenience: thread a sequence of events through the FSM and return
 * the final state + collected effects. Useful for test setup.
 */
export function run(events, initial = INITIAL_STATE) {
  let state = initial;
  const effects = [];
  for (const event of events) {
    const next = transition(state, event);
    state = next.state;
    effects.push(...next.effects);
  }
  return { state, effects };
}
