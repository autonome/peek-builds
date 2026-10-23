/**
 * Automatic sync scheduling.
 *
 * When the "Auto-sync" setting is on, the app syncs once at startup and then
 * every AUTO_SYNC_INTERVAL_MS. The decision to run a tick is pure
 * (shouldRunAutoSync); the timer wiring around it is thin and takes its
 * dependencies as arguments so it can be tested without a datastore.
 */

/** Time between automatic syncs. Fixed; there is no interval setting. */
export const AUTO_SYNC_INTERVAL_MS = 30 * 60 * 1000;

export interface AutoSyncState {
  /** The Auto-sync setting. */
  enabled: boolean;
  /** Both a server URL and an API key are set. */
  configured: boolean;
  /** A sync run is already in progress. */
  inFlight: boolean;
}

/** Whether a scheduled tick should start a sync. */
export function shouldRunAutoSync(state: AutoSyncState): boolean {
  return state.enabled && state.configured && !state.inFlight;
}

export interface AutoSyncDeps {
  getState: () => AutoSyncState;
  runSync: () => Promise<unknown>;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}

export interface AutoSyncScheduler {
  /** Re-read the setting: start (with an immediate sync) or stop the timer. */
  refresh(): void;
  /** Clear the timer. */
  stop(): void;
  /** True while a timer is active. */
  isRunning(): boolean;
}

export function createAutoSyncScheduler(deps: AutoSyncDeps): AutoSyncScheduler {
  const intervalMs = deps.intervalMs ?? AUTO_SYNC_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | null = null;

  const tick = (): void => {
    let state: AutoSyncState;
    try {
      state = deps.getState();
    } catch (error) {
      deps.onError?.(error);
      return;
    }
    if (!shouldRunAutoSync(state)) return;
    deps.runSync().catch((error) => deps.onError?.(error));
  };

  const stop = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const refresh = (): void => {
    let enabled = false;
    try {
      enabled = deps.getState().enabled;
    } catch (error) {
      deps.onError?.(error);
    }
    if (!enabled) {
      stop();
      return;
    }
    if (timer !== null) return; // already running; the setting did not change
    timer = setInterval(tick, intervalMs);
    timer.unref?.();
    tick();
  };

  return { refresh, stop, isRunning: () => timer !== null };
}
