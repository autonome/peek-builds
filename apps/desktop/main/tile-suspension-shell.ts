// Tile suspension shell: feeds the pure policy core (tile-suspension.ts) from the real event
// sources, keeps one state and one timer per lazy tile, publishes each policy change on
// `tile:suspension-changed`, and runs the core's effects.
//
// Observe-only mode (the default): an `unload` effect is logged and published as a
// "would suspend" decision, then the tile's policy is put back to what the still-loaded tile
// really is (idle, timer restarted), so nothing is unloaded and the next idle period reports
// again. The `load` effect is never run here: every wake request comes from the dispatch hook
// in tile-lazy.ts, which does the load itself.
//
// The wake gate: `beginWake` returns a promise that is pending while the tile is `suspending`
// and resolves when the unload has finished, so the hook delivers a wake only to a fresh load.
//
// No electron imports; every outside dependency is injected (`configureSuspensionShell`), and
// before configuration every call is a no-op, so modules that report events need no setup in
// tests.

import {
  decideSuspension,
  initialSuspensionState,
  nextCheckAt,
  type SuspensionConfig,
  type SuspensionEffect,
  type SuspensionEvent,
  type SuspensionPolicy,
  type SuspensionState,
} from './tile-suspension.js';

export const SUSPENSION_CHANGED_TOPIC = 'tile:suspension-changed';

const ACTIVITY_MIN_GAP_MS = 1000;

/** An implicit result hold ends here even if the result topic is never published. */
export const RESULT_HOLD_TIMEOUT_MS = 30_000;

export interface SuspensionChange {
  tileId: string;
  from: SuspensionPolicy;
  to: SuspensionPolicy;
  /** The event that caused it. */
  reason: string;
  ts: number;
  /** True when this decision was not carried out (no unload happens). */
  observeOnly: boolean;
  /** An `idle -> suspending` decision that observe-only mode did not carry out. */
  wouldSuspend?: boolean;
  /** Idle time that applied to a would-suspend decision. */
  idleMs?: number;
}

export interface SuspensionShellDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Publish `tile:suspension-changed` (from the system address). */
  publishChange(change: SuspensionChange): void;
  log(message: string): void;
  /** Only lazy tiles are tracked. */
  isTracked(tileId: string): boolean;
  /** Is the tile's background entry loaded right now? Syncs a tile first seen already awake. */
  isLoaded(tileId: string): boolean;
  /** Is `entryId` the tile's background entry? Its own window never counts as a use. */
  isBackgroundEntry(tileId: string, entryId: string): boolean;
  /** Per-tile overrides (schedule interval, settings). */
  configFor(tileId: string): Partial<SuspensionConfig>;
  /** Run the existing unloadTile for the tile's background entry; only used when not observe-only. */
  unload(tileId: string): Promise<void>;
  /** Call `fn` on the next publish of `topic`; returns a disposer. */
  onceOnTopic(topic: string, fn: () => void): () => void;
  /** Default true. */
  observeOnly?: boolean;
}

interface TileRecord {
  state: SuspensionState;
  timer: { at: number; handle: unknown } | null;
  waiters: Array<() => void>;
  /** Releases of the implicit result holds still open. */
  resultHolds: Set<() => void>;
}

export interface SuspensionShell {
  /** A wake is about to be delivered. Pending while the tile is suspending; resolves once the unload is done. */
  beginWake(tileId: string): Promise<void>;
  wakeReady(tileId: string): void;
  wakeFailed(tileId: string): void;
  dispatchPending(tileId: string): void;
  dispatchSettled(tileId: string): void;
  /** The tile was sent a command carrying a result topic: hold it until that topic publishes or 30 s pass. */
  holdForResult(tileId: string, resultTopic: string): void;
  activity(tileId: string): void;
  /** A tile window (any entry) opened; the background entry is ignored. */
  tileWindowOpened(tileId: string, entryId: string, windowId: string): void;
  tileWindowClosed(tileId: string, entryId: string, windowId: string): void;
  /** A keepLive content window the tile opened. */
  ownedWindowOpened(tileId: string, windowId: string): void;
  ownedWindowClosed(tileId: string, windowId: string): void;
  crashed(tileId: string): void;
  disabled(tileId: string): void;
  /** The user changed the suspension setting: applies to every tracked tile now and to tiles first seen later. */
  settingChanged(config: Partial<SuspensionConfig>): void;
  getPolicy(tileId: string): SuspensionPolicy | null;
  getState(tileId: string): SuspensionState | null;
  dispose(): void;
}

export function createSuspensionShell(deps: SuspensionShellDeps): SuspensionShell {
  const observeOnly = deps.observeOnly !== false;
  const records = new Map<string, TileRecord>();
  let userConfig: Partial<SuspensionConfig> = {};

  function record(tileId: string): TileRecord | null {
    let rec = records.get(tileId);
    if (rec) return rec;
    if (!deps.isTracked(tileId)) return null;
    rec = {
      state: initialSuspensionState({ ...userConfig, ...deps.configFor(tileId) }, deps.now()),
      timer: null,
      waiters: [],
      resultHolds: new Set(),
    };
    records.set(tileId, rec);
    // First seen while already awake (loaded by some path other than the dispatch hook).
    if (deps.isLoaded(tileId)) {
      rec.state = decideSuspension(rec.state, { type: 'wake-requested' }, deps.now()).state;
      rec.state = decideSuspension(rec.state, { type: 'wake-ready' }, deps.now()).state;
    }
    return rec;
  }

  function armTimer(tileId: string, rec: TileRecord): void {
    const at = nextCheckAt(rec.state);
    if (at === null) {
      if (rec.timer) deps.clearTimer(rec.timer.handle);
      rec.timer = null;
      return;
    }
    // A pending timer that fires earlier than needed is kept: it ticks, finds nothing due, and
    // re-arms. Only a deadline that moved earlier replaces it, so a busy tile does not churn timers.
    if (rec.timer && rec.timer.at <= at) return;
    if (rec.timer) deps.clearTimer(rec.timer.handle);
    const handle = deps.setTimer(() => {
      rec.timer = null;
      if (records.get(tileId) === rec) send(tileId, { type: 'tick' });
    }, Math.max(0, at - deps.now()));
    rec.timer = { at, handle };
  }

  function change(tileId: string, from: SuspensionPolicy, to: SuspensionPolicy, reason: string, extra?: Partial<SuspensionChange>): void {
    try {
      deps.publishChange({ tileId, from, to, reason, ts: deps.now(), observeOnly, ...extra });
    } catch (err) {
      deps.log(`[tile-suspension] publish failed for ${tileId}: ${String(err)}`);
    }
  }

  function applyEffects(tileId: string, rec: TileRecord, effects: SuspensionEffect[], from: SuspensionPolicy): void {
    for (const effect of effects) {
      switch (effect.type) {
        case 'release-stale-hold':
          deps.log(`[tile-suspension] ${tileId}: stale hold ${effect.id} released after ${effect.heldMs}ms`);
          break;
        case 'unload':
          if (observeOnly) {
            wouldSuspend(tileId, rec, from);
          } else {
            void runUnload(tileId);
          }
          break;
        case 'arm-timer':
        case 'load':
          // The timer is re-derived from the state after every event; the hook owns loads.
          break;
      }
    }
  }

  function wouldSuspend(tileId: string, rec: TileRecord, from: SuspensionPolicy): void {
    const idleMs = Math.max(rec.state.config.idleMs, (rec.state.config.scheduleIntervalMs ?? 0) * 2);
    deps.log(`[tile-suspension] would suspend ${tileId} (idle ${Math.round(idleMs / 1000)}s); observe-only, left loaded`);
    change(tileId, from, 'suspending', 'tick', { wouldSuspend: true, idleMs });
    // The tile is still loaded: replay the core into the state a loaded, unused tile has.
    const now = deps.now();
    for (const e of [{ type: 'unload-finished' }, { type: 'wake-requested' }, { type: 'wake-ready' }] as SuspensionEvent[]) {
      rec.state = decideSuspension(rec.state, e, now).state;
    }
  }

  async function runUnload(tileId: string): Promise<void> {
    try {
      await deps.unload(tileId);
    } catch (err) {
      deps.log(`[tile-suspension] unload of ${tileId} failed: ${String(err)}`);
    }
    send(tileId, { type: 'unload-finished' });
  }

  function send(tileId: string, event: SuspensionEvent): void {
    const rec = record(tileId);
    if (!rec) return;
    const from = rec.state.policy;
    const decision = decideSuspension(rec.state, event, deps.now());
    rec.state = decision.state;
    const to = decision.state.policy;
    // A would-suspend decision replays the core inside applyEffects, so publish ordinary changes first.
    if (from !== to && !decision.effects.some(e => e.type === 'unload' && observeOnly)) {
      change(tileId, from, to, event.type);
    }
    applyEffects(tileId, rec, decision.effects, from);
    if (from === 'suspending' && to !== 'suspending') {
      const waiters = rec.waiters.splice(0);
      for (const resolve of waiters) resolve();
    }
    armTimer(tileId, rec);
  }

  let holdSeq = 0;

  function dropResultHolds(rec: TileRecord): void {
    for (const release of [...rec.resultHolds]) release();
  }

  return {
    holdForResult(tileId, resultTopic) {
      const rec = record(tileId);
      if (!rec) return;
      const id = `result:${++holdSeq}:${resultTopic}`;
      send(tileId, { type: 'hold-acquired', id });
      let done = false;
      let stopListening: () => void = () => {};
      let timer: unknown = null;
      const release = (): void => {
        if (done) return;
        done = true;
        rec.resultHolds.delete(release);
        stopListening();
        if (timer !== null) deps.clearTimer(timer);
        if (records.get(tileId) === rec) send(tileId, { type: 'hold-released', id });
      };
      rec.resultHolds.add(release);
      stopListening = deps.onceOnTopic(resultTopic, release);
      timer = deps.setTimer(release, RESULT_HOLD_TIMEOUT_MS);
    },
    beginWake(tileId) {
      const rec = record(tileId);
      if (!rec) return Promise.resolve();
      const wasSuspending = rec.state.policy === 'suspending';
      send(tileId, { type: 'wake-requested' });
      if (!wasSuspending) return Promise.resolve();
      return new Promise<void>((resolve) => rec.waiters.push(resolve));
    },
    wakeReady: (id) => send(id, { type: 'wake-ready' }),
    wakeFailed: (id) => send(id, { type: 'wake-failed' }),
    dispatchPending: (id) => send(id, { type: 'dispatch-pending' }),
    dispatchSettled: (id) => send(id, { type: 'dispatch-settled' }),
    activity(tileId) {
      // Every publish and delivery reports here; sub-second repeats change nothing worth a decision.
      const rec = records.get(tileId);
      if (rec && deps.now() - rec.state.lastActivityAt < ACTIVITY_MIN_GAP_MS) return;
      send(tileId, { type: 'activity' });
    },
    tileWindowOpened(tileId, entryId, windowId) {
      if (deps.isBackgroundEntry(tileId, entryId)) return;
      send(tileId, { type: 'window-opened', id: windowId });
    },
    tileWindowClosed(tileId, entryId, windowId) {
      if (deps.isBackgroundEntry(tileId, entryId)) return;
      send(tileId, { type: 'window-closed', id: windowId });
    },
    ownedWindowOpened: (id, windowId) => send(id, { type: 'window-opened', id: windowId, owned: true }),
    ownedWindowClosed: (id, windowId) => send(id, { type: 'window-closed', id: windowId, owned: true }),
    crashed: (id) => send(id, { type: 'crashed' }),
    disabled(tileId) {
      const rec = records.get(tileId);
      if (rec) dropResultHolds(rec);
      send(tileId, { type: 'disabled' });
      if (rec?.timer) deps.clearTimer(rec.timer.handle);
      records.delete(tileId);
      for (const resolve of rec?.waiters.splice(0) ?? []) resolve();
    },
    settingChanged(config) {
      userConfig = { ...userConfig, ...config };
      for (const tileId of [...records.keys()]) send(tileId, { type: 'setting-changed', config });
    },
    getPolicy: (id) => records.get(id)?.state.policy ?? null,
    getState: (id) => records.get(id)?.state ?? null,
    dispose() {
      for (const rec of records.values()) {
        dropResultHolds(rec);
        if (rec.timer) deps.clearTimer(rec.timer.handle);
        for (const resolve of rec.waiters.splice(0)) resolve();
      }
      records.clear();
    },
  };
}

// ─── Process-wide instance ───────────────────────────────────────────

let shell: SuspensionShell | null = null;

export function configureSuspensionShell(deps: SuspensionShellDeps | null): void {
  shell?.dispose();
  shell = deps ? createSuspensionShell(deps) : null;
}

/** Event reporting entry points for the rest of main. Every call is a no-op until configured. */
export const suspension = {
  beginWake: (tileId: string): Promise<void> => shell?.beginWake(tileId) ?? Promise.resolve(),
  wakeReady: (tileId: string): void => shell?.wakeReady(tileId),
  wakeFailed: (tileId: string): void => shell?.wakeFailed(tileId),
  dispatchPending: (tileId: string): void => shell?.dispatchPending(tileId),
  dispatchSettled: (tileId: string): void => shell?.dispatchSettled(tileId),
  holdForResult: (tileId: string, resultTopic: string): void => shell?.holdForResult(tileId, resultTopic),
  activity: (tileId: string): void => shell?.activity(tileId),
  tileWindowOpened: (tileId: string, entryId: string, windowId: string): void =>
    shell?.tileWindowOpened(tileId, entryId, windowId),
  tileWindowClosed: (tileId: string, entryId: string, windowId: string): void =>
    shell?.tileWindowClosed(tileId, entryId, windowId),
  ownedWindowOpened: (tileId: string, windowId: string): void => shell?.ownedWindowOpened(tileId, windowId),
  ownedWindowClosed: (tileId: string, windowId: string): void => shell?.ownedWindowClosed(tileId, windowId),
  crashed: (tileId: string): void => shell?.crashed(tileId),
  disabled: (tileId: string): void => shell?.disabled(tileId),
  settingChanged: (config: Partial<SuspensionConfig>): void => shell?.settingChanged(config),
  getPolicy: (tileId: string): SuspensionPolicy | null => shell?.getPolicy(tileId) ?? null,
};
