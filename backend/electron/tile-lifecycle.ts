/**
 * tile-lifecycle — Main-process enforcement engine for the tile FSM.
 *
 * Owns the authoritative `tileId → state` map. Wires renderer events
 * (`tile:ready` pubsub, `render-process-gone` on BrowserWindow
 * webContents, window close) to state transitions. All callers that
 * mutate tile lifecycle go through this module rather than poking
 * BrowserWindow / tileWindows / token registries directly.
 *
 * The transition table lives in `./tile-fsm.ts` as a pure module
 * (no electron / node imports). This file is the side-effectful
 * engine that applies those transitions against concrete electron
 * primitives.
 *
 * Phase A (this commit): exports + state store + transition helper.
 * No callers are wired yet. Phase D replaces the direct uses of
 * `launchTile` / `registerTrustedBuiltinWindow` / ad-hoc token revoke
 * calls with `requestLoad()` / `requestShow()` / `requestShutdown()`.
 *
 * See docs/tile-lifecycle-fsm.md.
 */

import {
  STATES,
  TRIGGERS,
  validateTransition,
  isDispatchable,
  acceptsDynamicRegistration,
} from './tile-fsm.js';

export { STATES, TRIGGERS, isDispatchable, acceptsDynamicRegistration };

// ---------------------------------------------------------------------------
// State store
// ---------------------------------------------------------------------------

/**
 * Stored per tile entry. We keep `tileId` and `entryId` as separate
 * fields rather than encoding them into a compound key string: feature
 * ids may contain colons (e.g. atproto handles like `at://did:plc:…`),
 * so a `${tileId}:${entryId}` key can't be split back reliably.
 */
interface TileRecord {
  tileId: string;
  entryId: string;
  state: string;
}
const records = new Map<string, TileRecord>();

/** Last-transition metadata for drift diagnostics. */
interface TransitionRecord {
  from: string;
  to: string;
  trigger: string;
  timestamp: number;
  context?: Record<string, unknown>;
}
const lastTransition = new Map<string, TransitionRecord>();

/**
 * Key builder — JSON so any characters in tileId / entryId (including
 * colons, slashes) round-trip losslessly without parsing.
 */
function key(tileId: string, entryId: string): string {
  return JSON.stringify([tileId, entryId]);
}

// ---------------------------------------------------------------------------
// Transition — the only way state changes
// ---------------------------------------------------------------------------

export interface TransitionResult {
  ok: boolean;
  from: string;
  to?: string;
  error?: string;
}

/**
 * Request a transition. Returns a result object. Never throws.
 *
 * On success, updates the internal state map and records the
 * transition. On failure, leaves the state map unchanged and returns
 * an error — caller decides whether to log, surface, or ignore.
 *
 * Rationale for never throwing: the enforcement engine is called from
 * IPC handlers, event listeners, and renderer-driven requests. Throws
 * across those boundaries are harder to reason about than a result
 * check.
 */
export function transition(
  tileId: string,
  entryId: string,
  trigger: string,
  context?: Record<string, unknown>,
): TransitionResult {
  const k = key(tileId, entryId);
  const existing = records.get(k);
  const from = existing?.state ?? STATES.UNREGISTERED;

  const result = validateTransition(from, trigger);
  if (!result.ok) {
    return { ok: false, from, error: result.error };
  }

  // Transitions back to `unregistered` drop the record entirely — the
  // tile is gone, so dangling state-map entries for uninstalled tiles
  // would leak over install/uninstall cycles. The record is recreated
  // on the next INSTALL.
  if (result.to === STATES.UNREGISTERED) {
    records.delete(k);
  } else {
    records.set(k, { tileId, entryId, state: result.to });
  }

  lastTransition.set(k, {
    from,
    to: result.to,
    trigger,
    timestamp: Date.now(),
    context,
  });

  return { ok: true, from, to: result.to };
}

// Deliberately no `setStateUnchecked()` — every state change MUST go
// through `transition()` so the FSM is the only source of truth. Tests
// that need a specific state walk the transition graph like production
// code would.

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Current state of a tile entry, or `unregistered` if unknown. */
export function getState(tileId: string, entryId: string): string {
  return records.get(key(tileId, entryId))?.state ?? STATES.UNREGISTERED;
}

/** All tracked tile entries and their states. Read-only snapshot. */
export function listStates(): Array<{ tileId: string; entryId: string; state: string }> {
  return Array.from(records.values()).map(r => ({ ...r }));
}

/** Last recorded transition for a tile entry, or null. Used by drift diagnostics. */
export function getLastTransition(tileId: string, entryId: string): TransitionRecord | null {
  return lastTransition.get(key(tileId, entryId)) ?? null;
}

/** True iff the tile is in a state that accepts command dispatch. */
export function isDispatchReady(tileId: string, entryId: string): boolean {
  return isDispatchable(getState(tileId, entryId));
}

/**
 * True iff dynamic registrations (api.commands.register etc.) from
 * this tile should be accepted. Dev mode drift detection uses this
 * to reject out-of-state publishes.
 */
export function acceptsRegistration(tileId: string, entryId: string): boolean {
  return acceptsDynamicRegistration(getState(tileId, entryId));
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

/**
 * Wipe all tracked state. Only callable when `NODE_ENV === 'test'` —
 * production code that hits this throws immediately so we notice the
 * misuse in review rather than silently corrupting state. Tests must
 * set `NODE_ENV=test` in their runner invocation.
 */
export function resetForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('[tile-lifecycle] resetForTests() called outside NODE_ENV=test');
  }
  records.clear();
  lastTransition.clear();
}
