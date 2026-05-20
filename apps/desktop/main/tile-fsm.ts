/**
 * Tile Lifecycle FSM — pure transition table.
 *
 * Single source of truth for what state transitions are allowed and
 * what event triggers each one. No electron / node imports; pure TS
 * that's safe to import from tests or any other isolated context.
 *
 * The enforcement engine in `tile-lifecycle.ts` imports this and wires
 * state changes to BrowserWindow events, token lifecycle, and the
 * `tileWindows` broadcaster registration.
 *
 * If a renderer ever needs policy introspection (e.g. cmd panel drift
 * detection surface), we'll expose a snapshot via strict IPC rather
 * than importing this file cross-process.
 *
 * See docs/tile-lifecycle-fsm.md for the policy this enforces.
 */

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export const STATES = {
  UNREGISTERED: 'unregistered',
  REGISTERED:   'registered',
  LOADING:      'loading',
  READY:        'ready',
  VISIBLE:      'visible',
  UNLOADING:    'unloading',
  CRASHED:      'crashed',
} as const;

export type TileState = typeof STATES[keyof typeof STATES];

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

export const TRIGGERS = {
  INSTALL:        'install',
  UNINSTALL:      'uninstall',
  LOAD:           'load',
  TILE_READY:     'tile-ready',
  SHOW:           'show',
  HIDE:           'hide',
  SHUTDOWN:       'shutdown',
  CLEANUP_KEEP:   'cleanup-keep',     // unloading → registered
  CLEANUP_PURGE:  'cleanup-purge',    // unloading → unregistered
  RENDER_GONE:    'render-gone',
  RELAUNCH:       'relaunch',         // crashed → loading (manual, never auto per policy)
} as const;

export type TileTrigger = typeof TRIGGERS[keyof typeof TRIGGERS];

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------
//
// Read as: from[state][trigger] = toState. Missing = disallowed.

type TransitionTable = Partial<Record<TileState, Partial<Record<TileTrigger, TileState>>>>;

const TRANSITIONS: TransitionTable = {
  [STATES.UNREGISTERED]: {
    [TRIGGERS.INSTALL]:    STATES.REGISTERED,
  },
  [STATES.REGISTERED]: {
    [TRIGGERS.LOAD]:       STATES.LOADING,
    [TRIGGERS.UNINSTALL]:  STATES.UNREGISTERED,
  },
  [STATES.LOADING]: {
    [TRIGGERS.TILE_READY]: STATES.READY,
    [TRIGGERS.RENDER_GONE]: STATES.CRASHED,
    // Shutdown mid-load (e.g. disable during boot) → bypass ready.
    [TRIGGERS.SHUTDOWN]:   STATES.UNLOADING,
  },
  [STATES.READY]: {
    [TRIGGERS.SHOW]:       STATES.VISIBLE,
    [TRIGGERS.SHUTDOWN]:   STATES.UNLOADING,
    [TRIGGERS.RENDER_GONE]: STATES.CRASHED,
  },
  [STATES.VISIBLE]: {
    [TRIGGERS.HIDE]:       STATES.READY,
    [TRIGGERS.SHUTDOWN]:   STATES.UNLOADING,
    [TRIGGERS.RENDER_GONE]: STATES.CRASHED,
  },
  [STATES.UNLOADING]: {
    [TRIGGERS.CLEANUP_KEEP]:  STATES.REGISTERED,
    [TRIGGERS.CLEANUP_PURGE]: STATES.UNREGISTERED,
  },
  [STATES.CRASHED]: {
    [TRIGGERS.CLEANUP_KEEP]:  STATES.REGISTERED,
    [TRIGGERS.RELAUNCH]:      STATES.LOADING,   // policy: only user-initiated
    [TRIGGERS.UNINSTALL]:     STATES.UNREGISTERED,
  },
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ValidateTransitionResult =
  | { ok: true; to: TileState }
  | { ok: false; error: string };

/**
 * Validate a transition. Returns `{ ok: true, to }` on success or
 * `{ ok: false, error }` on disallowed transition. Never throws.
 */
export function validateTransition(from: string, trigger: string): ValidateTransitionResult {
  const fromTable = TRANSITIONS[from as TileState];
  if (!fromTable) {
    return { ok: false, error: `unknown state: ${from}` };
  }
  const to = fromTable[trigger as TileTrigger];
  if (to === undefined) {
    return { ok: false, error: `disallowed transition: ${from} —${trigger}→ ?` };
  }
  return { ok: true, to };
}

/**
 * Returns an array of valid triggers from the given state. Useful for
 * dev assertions and debugging.
 */
export function allowedTriggers(state: string): string[] {
  const t = TRANSITIONS[state as TileState];
  return t ? Object.keys(t) : [];
}

// ---------------------------------------------------------------------------
// Policy helpers (read-only — describe invariants from the doc)
// ---------------------------------------------------------------------------

/**
 * States in which dynamic registrations (api.commands.register,
 * registerNoun) are accepted. Publishes arriving when the source tile
 * is NOT in one of these states should be treated as drift violations.
 */
export const DYNAMIC_REGISTRATION_STATES: readonly TileState[] = Object.freeze([
  STATES.READY,
  STATES.VISIBLE,
]);

/**
 * States in which command / noun dispatch CAN complete without a
 * prior load. When the target is not in one of these, the dispatcher
 * MUST trigger LOAD and wait for TILE_READY before dispatching.
 */
export const DISPATCHABLE_STATES: readonly TileState[] = Object.freeze([
  STATES.READY,
  STATES.VISIBLE,
]);

export function isDispatchable(state: string): boolean {
  return (DISPATCHABLE_STATES as readonly string[]).includes(state);
}

export function acceptsDynamicRegistration(state: string): boolean {
  return (DYNAMIC_REGISTRATION_STATES as readonly string[]).includes(state);
}
