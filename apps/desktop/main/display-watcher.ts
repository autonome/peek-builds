/**
 * Display Change Watcher
 *
 * Listens for display configuration changes and re-projects every live
 * window's placement intent through the pure engine in
 * `window-placement.ts`. Per the placement spec
 * (docs/window-placement.md):
 *
 * - `display-added` and `display-removed` run **synchronously** — no
 *   debounce. Idempotent: macOS may fire several events in a row during
 *   a single switch; projecting N times in a row produces the same
 *   bounds. Synchronous handling is the click-drag-snap fix: the user
 *   cannot start a drag during a deferred reposition window.
 *
 * - `display-metrics-changed` is coalesced at <=50ms. Resolution / scale /
 *   rotation events arrive in tight bursts that don't materially change
 *   placement, so a small debounce keeps redundant projection passes off
 *   the main thread without exposing user-input race surface.
 *
 * - No "stranded rescue" pass. The placement engine projects onto a
 *   present display (own or primary) for every mode, so windows cannot
 *   end up off-screen by construction.
 *
 * THIS MODULE NO LONGER TOUCHES WINDOWS (window-manager.md §5 step 10). It is
 * a pure PRODUCER: it reads the OS (the display layout, the two window
 * registries, the open-time params), decides via `display-projection.ts` who
 * moves and where, and dispatches ONE `DISPLAY_CHANGED` carrying the batch.
 * The state machine emits the `SET_BOUNDS` effects and the port performs them
 * — the single geometry funnel (R2). `dispatchWindowEvent` drains its queue
 * before returning, so an add/remove pass is still synchronous end to end.
 */

import { BrowserWindow, screen } from 'electron';
import { getAllLiveWindows, getLiveWindow } from './window-registry.js';
import { getAllHybridWindows, getHybridWindow } from './hybrid-page-host-registry.js';
import { getWindowInfo } from './main.js';
import { DEBUG } from './config.js';
import { collectDisplayProjection, type ProjectionWindow } from './display-projection.js';
import { dispatchWindowEvent, getWindowIdFor } from './window-state-singleton.js';

/**
 * Resolve the bounds of a `parent-centered` placement's parent. The parent may
 * be a plain window (`window-registry`) or a hybrid page-host
 * (`hybrid-page-host-registry`) — checked in that order since the two
 * registries cover disjoint id spaces.
 */
function resolveParentBounds(parentId: number): Electron.Rectangle | undefined {
  const parent = getLiveWindow(parentId);
  if (parent) return parent.getBounds();
  const hybridParent = getHybridWindow(parentId);
  return hybridParent ? hybridParent.baseWin.getBounds() : undefined;
}

/**
 * Every live window as a projection candidate: plain windows first, then
 * hybrid page-hosts. Hybrid hosts are invisible to `getAllLiveWindows()` — it
 * only knows `BrowserWindow`s (see that registry's module doc) — so they are
 * gathered separately and run through the same placement math, which is what
 * makes display add/remove/rescale reposition them too.
 *
 * No `isVisible()` filter: the machine's own `visible` mirror answers that
 * inside the reducer, so asking the OS here would be a second authority for
 * one question (design §3).
 *
 * `getBounds()` runs here, BEFORE `getWindowInfo`/placement filter this list
 * down in `collectDisplayProjection`, and `getAllHybridWindows()` (unlike
 * `getAllLiveWindows()`) does not filter destroyed entries. A window that has
 * gone away between the registry snapshot and this call would otherwise throw
 * mid-loop and lose the ENTIRE projection pass for every other window. Guard
 * `isDestroyed()` and wrap the read so one bad window is skipped, not fatal.
 */
function collectCandidates(): ProjectionWindow[] {
  const windows: ProjectionWindow[] = [];
  for (const win of getAllLiveWindows()) {
    try {
      if (win.isDestroyed()) continue;
      windows.push({ nativeId: win.id, label: 'window', bounds: win.getBounds() });
    } catch (err) {
      console.error(`[display-watcher] Skipping window ${win.id} — getBounds() failed:`, err);
    }
  }
  for (const hybrid of getAllHybridWindows()) {
    try {
      if (hybrid.baseWin.isDestroyed()) continue;
      windows.push({ nativeId: hybrid.windowId, label: 'hybrid window', bounds: hybrid.baseWin.getBounds() });
    } catch (err) {
      console.error(`[display-watcher] Skipping hybrid window ${hybrid.windowId} — getBounds() failed:`, err);
    }
  }
  return windows;
}

/** Coalesce metrics-changed events. Add/remove are synchronous. */
let _metricsDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const METRICS_DEBOUNCE_MS = 50;

/**
 * Project every live window's placement intent onto the live display layout
 * and dispatch the batch. Called synchronously on add/remove and after a small
 * coalescing window on metrics-changed.
 */
function projectAllWindows(reason: string): void {
  const displays = screen.getAllDisplays();
  const primaryDisplayId = screen.getPrimaryDisplay().id;

  console.log(
    `[display-watcher] ${reason} — projecting all windows. ` +
    `${displays.length} display(s) [${displays.map(d => `${d.id}(${d.workArea.x},${d.workArea.y} ${d.workArea.width}x${d.workArea.height})`).join(', ')}], ` +
    `primary=${primaryDisplayId}`
  );

  const decisions = collectDisplayProjection(
    {
      windows: collectCandidates(),
      getWindowInfo,
      getMachineId: (nativeId) => getWindowIdFor(nativeId),
      getParentBounds: resolveParentBounds,
    },
    displays,
    primaryDisplayId,
  );

  if (decisions.length === 0) {
    DEBUG && console.log('[display-watcher] No windows needed repositioning');
    return;
  }

  for (const d of decisions) {
    console.log(
      `[display-watcher] Repositioning ${d.label} ${d.nativeId} (${d.mode}): ` +
      `(${d.from.x},${d.from.y} ${d.from.width}x${d.from.height}) -> ` +
      `(${d.bounds.x},${d.bounds.y} ${d.bounds.width}x${d.bounds.height})`
    );
  }

  // ONE event for the whole pass — the machine decides which entries survive
  // (unknown / hidden / non-normal fsMode are dropped there) and emits the
  // SET_BOUNDS effects. Dispatch is synchronous, so the add/remove path keeps
  // its no-deferred-reposition guarantee.
  dispatchWindowEvent({
    type: 'DISPLAY_CHANGED',
    projected: decisions.map(({ id, bounds }) => ({ id, bounds })),
  });

  console.log(`[display-watcher] Dispatched reprojection for ${decisions.length} window(s)`);
}

/** Coalescing handler for metrics-changed events. */
function onMetricsChanged(): void {
  if (_metricsDebounceTimer) clearTimeout(_metricsDebounceTimer);
  _metricsDebounceTimer = setTimeout(() => {
    _metricsDebounceTimer = null;
    projectAllWindows('display-metrics-changed (coalesced)');
  }, METRICS_DEBOUNCE_MS);
}

/**
 * Initialize the display watcher.
 * Call this after app.ready (screen API requires it).
 */
export function initDisplayWatcher(): void {
  const initial = screen.getAllDisplays();
  console.log(
    `[display-watcher] Initialized with ${initial.length} display(s): ` +
    initial.map(d => `${d.id} (${d.workArea.x},${d.workArea.y} ${d.workArea.width}x${d.workArea.height})`).join(', ')
  );

  // Add/remove: synchronous projection. Per spec, no debounce — the
  // projection is idempotent so multiple events in a row are harmless,
  // and synchronous handling closes the user-input race.
  screen.on('display-added', () => {
    console.log('[display-watcher] display-added event');
    projectAllWindows('display-added');
  });

  screen.on('display-removed', () => {
    console.log('[display-watcher] display-removed event');
    projectAllWindows('display-removed');
  });

  // Metrics changes: coalesce only. Most metrics events don't move windows.
  screen.on('display-metrics-changed', (_event, _display, changedMetrics: string[]) => {
    DEBUG && console.log('[display-watcher] display-metrics-changed event, metrics:', changedMetrics.join(', '));
    const meaningful = changedMetrics.some(m => ['bounds', 'workArea', 'scaleFactor'].includes(m));
    if (meaningful) onMetricsChanged();
  });
}

/**
 * Track a window for display change handling.
 * No-op today — kept as an API hook for callers that want a per-window
 * close listener attached.
 */
export function trackWindow(win: BrowserWindow): void {
  win.on('closed', () => {
    // No per-window state in the new model.
  });
}

/** Clean up the display watcher. */
export function cleanupDisplayWatcher(): void {
  if (_metricsDebounceTimer) {
    clearTimeout(_metricsDebounceTimer);
    _metricsDebounceTimer = null;
  }
  screen.removeAllListeners('display-added');
  screen.removeAllListeners('display-removed');
  screen.removeAllListeners('display-metrics-changed');
  DEBUG && console.log('[display-watcher] Cleaned up');
}
