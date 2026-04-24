/**
 * tile-lifecycle — Main-process enforcement engine for the tile FSM.
 *
 * Owns the authoritative `tileId → state` map. Wires renderer events
 * (`tile:lifecycle:ready` private IPC, `render-process-gone` on
 * BrowserWindow webContents, window close) to state transitions. All
 * callers that mutate tile lifecycle go through this module rather
 * than poking BrowserWindow / tileWindows / token registries directly.
 *
 * The transition table lives in `./tile-fsm.ts` as a pure module
 * (no electron / node imports). This file is the side-effectful
 * engine that applies those transitions against concrete electron
 * primitives.
 *
 * Owns the private lifecycle IPC channels
 * (`tile:lifecycle:ready` / `tile:lifecycle:shutdown`). Also provides:
 *   - `registerBgWindow()` + bgWindow-ready latch: the subscribe-
 *     before-publish invariant. No non-bgWindow tile may transition
 *     REGISTERED→LOADING until bgWindow signals `tile:lifecycle:ready`.
 *   - `tile:state-changed` System pubsub topic: a read-only mirror of
 *     every lifecycle transition. Observers (drift detectors, HUD
 *     widgets) subscribe; publishers must not publish it directly.
 *
 * See docs/pubsub-state-machine.md §Topics that are NOT pubsub
 * (private lifecycle IPC) and §Subscribe-before-publish invariant.
 */

import { createRequire } from 'node:module';

import {
  STATES,
  TRIGGERS,
  validateTransition,
  isDispatchable,
  acceptsDynamicRegistration,
} from './tile-fsm.js';
import { publish, getSystemAddress } from './pubsub.js';

// Lazy-load ipcMain via CommonJS require so this module can be imported
// under ELECTRON_RUN_AS_NODE=1 (where electron's named ESM exports are
// empty). Consumers that never actually call `registerTileLifecycleIpc`
// (e.g. unit tests) don't trigger the require. Same pattern as
// tile-launcher.ts::getBrowserWindowCtor.
const requireElectron = createRequire(import.meta.url);
let _ipcMain: typeof import('electron').ipcMain | null = null;
function getIpcMain(): typeof import('electron').ipcMain {
  if (_ipcMain) return _ipcMain;
  const electron = requireElectron('electron') as typeof import('electron');
  _ipcMain = electron.ipcMain;
  return _ipcMain;
}

export { STATES, TRIGGERS, isDispatchable, acceptsDynamicRegistration };

/**
 * Injected side-effect callback for the private `tile:lifecycle:ready`
 * IPC handler. Called with `(tileId, entryId)` after the bgWindow-gate
 * latch (if applicable) has been resolved.
 *
 * Historically this was `tile-launcher.signalTileReady`. Registering it
 * via a setter rather than a direct import keeps the dependency arrow
 * tile-launcher → tile-lifecycle (one-way) and avoids a circular
 * import — see docs/pubsub-state-machine.md §Module layout.
 */
type ReadyCallback = (tileId: string, entryId: string) => void;
let onReadyCallback: ReadyCallback | null = null;

/**
 * Inject the `signalTileReady` callback. Called once at startup from
 * `main.ts::initialize()` before `registerTileLifecycleIpc()`.
 */
export function setReadyCallback(cb: ReadyCallback): void {
  onReadyCallback = cb;
}

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
// bgWindow readiness gate — subscribe-before-publish invariant
// ---------------------------------------------------------------------------
//
// Core subscribers (cmd registry, noun registry, core domain topics) live
// inside the bgWindow renderer (`app/background.html` → `app/index.js`).
// Those subscribers are registered synchronously during `init()`. Until
// bgWindow's `tile:lifecycle:ready` IPC arrives, we MUST hold off any
// other tile's REGISTERED→LOADING transition — otherwise the other
// tile's first publishes (`cmd:register`, etc.) race the subscribers
// and are silently dropped.
//
// Implementation: a simple one-shot latch. Once bgWindow signals ready,
// the latch resolves and stays resolved for the rest of the process
// lifetime. Crashing bgWindow mid-boot is a separate concern (handled
// by the load-on-dispatch timeout UX in tile-lazy); a permanent latch
// is sufficient here.

interface BgWindowRegistration {
  tileId: string;
  entryId: string;
}
let bgWindow: BgWindowRegistration | null = null;
let bgWindowReady = false;
let bgWindowReadyResolve: (() => void) | null = null;
let bgWindowReadyPromise: Promise<void> = new Promise<void>((resolve) => {
  bgWindowReadyResolve = resolve;
});

/**
 * Declare which tile entry is the core bgWindow. Called once at startup
 * from `core-glue.ts::initCore()` (before the window signals ready).
 *
 * A second registration replaces the first — tests exercise this by
 * calling `resetForTests()` between scenarios. In production there is
 * exactly one bgWindow.
 */
export function registerBgWindow(tileId: string, entryId: string): void {
  bgWindow = { tileId, entryId };
}

/** True iff bgWindow has signaled `tile:lifecycle:ready`. */
export function isBgWindowReady(): boolean {
  return bgWindowReady;
}

/** Promise that resolves when bgWindow signals ready. Never rejects. */
export function waitForBgWindowReady(): Promise<void> {
  return bgWindowReadyPromise;
}

/**
 * Check whether a tile is the registered bgWindow.
 * Returns false if bgWindow has not been registered yet.
 */
function isBgWindow(tileId: string, entryId: string): boolean {
  return !!bgWindow && bgWindow.tileId === tileId && bgWindow.entryId === entryId;
}

/**
 * Resolve the latch. Called when bgWindow's `tile:lifecycle:ready`
 * IPC lands. Idempotent.
 */
function markBgWindowReady(): void {
  if (bgWindowReady) return;
  bgWindowReady = true;
  if (bgWindowReadyResolve) {
    const r = bgWindowReadyResolve;
    bgWindowReadyResolve = null;
    r();
  }
}

/**
 * Async gate for `REGISTERED → LOADING` transitions.
 *
 * - bgWindow itself: resolves immediately (bgWindow must be allowed
 *   to load before it can signal ready).
 * - Any other tile: awaits the latch.
 * - If no bgWindow has been registered yet we resolve immediately.
 *   This preserves backwards compatibility with unit tests /
 *   trustedBuiltin paths that never call `registerBgWindow()`.
 *   Production always registers bgWindow before launching any feature
 *   tile (see `main.ts` wiring).
 */
export async function requestLoad(tileId: string, entryId: string): Promise<TransitionResult> {
  if (bgWindow && !isBgWindow(tileId, entryId) && !bgWindowReady) {
    await bgWindowReadyPromise;
  }
  return transition(tileId, entryId, TRIGGERS.LOAD, { source: 'requestLoad' });
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
 * On success, updates the internal state map, records the transition,
 * and publishes the observer-mirror `tile:state-changed` System topic.
 * On failure, leaves the state map unchanged and returns an error —
 * caller decides whether to log, surface, or ignore.
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

  const now = Date.now();
  lastTransition.set(k, {
    from,
    to: result.to,
    trigger,
    timestamp: now,
    context,
  });

  // Publish the System-owned observer-mirror topic. Every transition
  // fires this — drift detectors (Phase 8) and HUD widgets that want
  // to display tile state subscribe to it. Publishers must not publish
  // `tile:state-changed` directly; the authorization-rules table
  // restricts writes to System.
  try {
    publish(getSystemAddress(), 'tile:state-changed', {
      tileId,
      entryId,
      from,
      to: result.to,
      trigger,
      ts: now,
    });
  } catch (err) {
    // Observer-topic publish failures must not corrupt the transition —
    // the FSM state is authoritative regardless of whether observers
    // got the mirror event. Log and move on.
    console.error('[tile-lifecycle] tile:state-changed publish threw:', err);
  }

  return { ok: true, from, to: result.to };
}

// ---------------------------------------------------------------------------
// Private lifecycle IPC — tile:lifecycle:ready / tile:lifecycle:shutdown
// ---------------------------------------------------------------------------
//
// These are NOT pubsub topics. They're private IPC between a tile's
// preload and this module. See docs/pubsub-state-machine.md §Topics
// that are NOT pubsub.
//
// `tile:lifecycle:ready`: preload → main, sent once after the tile
//   has called `api.initialize()`. Causes the LOADING → READY
//   transition (via the injected ready callback). If the signaller is
//   the registered bgWindow, also resolves the subscribe-before-publish
//   latch.
//
// `tile:lifecycle:shutdown`: main → preload, sent during the unload
//   grace window. Lives here as a channel name constant; the actual
//   sends live in tile-launcher.ts where the BrowserWindow handle
//   is in scope.

/** Channel name constants — exported so tile-launcher / tile-preload stay in sync. */
export const TILE_LIFECYCLE_READY_CHANNEL = 'tile:lifecycle:ready';
export const TILE_LIFECYCLE_SHUTDOWN_CHANNEL = 'tile:lifecycle:shutdown';

let lifecycleIpcRegistered = false;

/**
 * Register the private lifecycle IPC handlers. Called once from
 * `main.ts::initialize()` (alongside `ensureTileIpcHandlers()`).
 * Idempotent.
 */
export function registerTileLifecycleIpc(): void {
  if (lifecycleIpcRegistered) return;
  lifecycleIpcRegistered = true;

  const ipcMain = getIpcMain();
  ipcMain.on(TILE_LIFECYCLE_READY_CHANNEL, (_event, args: {
    tileId: string;
    tileEntry: string;
  }) => {
    // tile:lifecycle:ready does not carry a capability token (the
    // renderer signals readiness by tile id + entry id only — the
    // launcher already knows which window sent it via the tileWindows
    // map). Phase 8 introduces a main-process IPC gate that will add
    // sender-frame verification here too.
    if (!args || typeof args.tileId !== 'string' || typeof args.tileEntry !== 'string') {
      console.error('[tile-lifecycle] tile:lifecycle:ready dropped: malformed payload');
      return;
    }

    // If the signaller is the registered bgWindow, unlatch first. Doing
    // this BEFORE the ready callback ensures any observer that reacts
    // to the LOADING → READY transition on bgWindow already sees
    // bgWindow marked ready in the same tick.
    if (isBgWindow(args.tileId, args.tileEntry)) {
      markBgWindowReady();
    }

    if (onReadyCallback) {
      onReadyCallback(args.tileId, args.tileEntry);
    } else {
      console.error('[tile-lifecycle] tile:lifecycle:ready arrived before setReadyCallback() — dropping');
    }
  });
}

/** @internal Test hook: simulate a `tile:lifecycle:ready` IPC arrival without wiring ipcMain. */
export function __simulateLifecycleReadyForTest(tileId: string, entryId: string): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('[tile-lifecycle] __simulateLifecycleReadyForTest called outside NODE_ENV=test');
  }
  if (isBgWindow(tileId, entryId)) {
    markBgWindowReady();
  }
  if (onReadyCallback) {
    onReadyCallback(tileId, entryId);
  }
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
  bgWindow = null;
  bgWindowReady = false;
  bgWindowReadyPromise = new Promise<void>((resolve) => {
    bgWindowReadyResolve = resolve;
  });
  onReadyCallback = null;
}
