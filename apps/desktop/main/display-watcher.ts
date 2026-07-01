/**
 * Display Change Watcher
 *
 * Listens for display configuration changes and re-projects every visible
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
 */

import { BrowserWindow, screen } from 'electron';
import { getAllLiveWindows, getLiveWindow } from './window-registry.js';
import { getAllHybridWindows, getHybridWindow } from './hybrid-page-host-registry.js';
import { getWindowInfo } from './main.js';
import { DEBUG, WEB_CORE_ADDRESS } from './config.js';
import { computePlacement, type Placement } from './window-placement.js';

/**
 * Minimal shape `projectWindow` needs. `BrowserWindow` and the hybrid
 * page-host's `BaseWindow` both satisfy this structurally (`BrowserWindow
 * extends BaseWindow`), so one projection path drives both without either
 * type having to pretend to be the other.
 */
type PositionableWindow = Pick<Electron.BaseWindow, 'getBounds' | 'setBounds' | 'isVisible'>;

/**
 * Resolve the bounds of a placement's `parentId` for `parent-centered`
 * mode. The parent may be a plain window (`window-registry`) or a hybrid
 * page-host (`hybrid-page-host-registry`) — checked in that order since the
 * two registries cover disjoint id spaces.
 */
function resolveParentBounds(placement: Placement): Electron.Rectangle | undefined {
  if (placement.mode !== 'parent-centered') return undefined;
  const parent = getLiveWindow(placement.parentId);
  if (parent) return parent.getBounds();
  const hybridParent = getHybridWindow(placement.parentId);
  return hybridParent ? hybridParent.baseWin.getBounds() : undefined;
}

/**
 * Project one window's (or hybrid page-host's) placement intent onto the
 * live display layout and apply the result. Shared by both the plain-window
 * and hybrid-window passes in `projectAllWindows` — same lookup
 * (`getWindowInfo`), same filters (background window, no placement), same
 * `computePlacement` call. Returns true if the window was repositioned.
 */
function projectWindow(
  id: number,
  win: PositionableWindow,
  displays: Electron.Display[],
  primaryDisplayId: number,
  label: string,
): boolean {
  if (!win.isVisible()) return false;

  const entry = getWindowInfo(id);
  // Skip the background window — never positioned, never visible.
  if (!entry || entry.params.address === WEB_CORE_ADDRESS) return false;
  const placement = entry.params.placement as Placement | undefined;
  if (!placement) return false;

  const bounds = win.getBounds();
  const parentBounds = resolveParentBounds(placement);

  const result = computePlacement({
    placement,
    currentBounds: bounds,
    windowSize: { width: bounds.width, height: bounds.height },
    displays,
    primaryDisplayId,
    parentBounds,
  });

  if (result.kind === 'reposition') {
    console.log(
      `[display-watcher] Repositioning ${label} ${id} (${placement.mode}): ` +
      `(${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}) -> ` +
      `(${result.bounds.x},${result.bounds.y} ${result.bounds.width}x${result.bounds.height})`
    );
    win.setBounds(result.bounds);
    return true;
  }
  return false;
}

/** Coalesce metrics-changed events. Add/remove are synchronous. */
let _metricsDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const METRICS_DEBOUNCE_MS = 50;

/**
 * Project every visible window's placement intent onto the live display
 * layout and apply the result. Called synchronously on add/remove and
 * after a small coalescing window on metrics-changed.
 */
function projectAllWindows(reason: string): void {
  const displays = screen.getAllDisplays();
  const primaryDisplayId = screen.getPrimaryDisplay().id;

  console.log(
    `[display-watcher] ${reason} — projecting all windows. ` +
    `${displays.length} display(s) [${displays.map(d => `${d.id}(${d.workArea.x},${d.workArea.y} ${d.workArea.width}x${d.workArea.height})`).join(', ')}], ` +
    `primary=${primaryDisplayId}`
  );

  let placedCount = 0;

  for (const win of getAllLiveWindows()) {
    if (projectWindow(win.id, win, displays, primaryDisplayId, 'window')) placedCount++;
  }

  // Hybrid page-host windows (BaseWindow + WebContentsView, tracked in
  // hybrid-page-host-registry.ts) are invisible to getAllLiveWindows() — it
  // only knows BrowserWindows (see that registry's module doc). Project them
  // through the same placement math so display add/remove/rescale repositions
  // them too.
  for (const hybrid of getAllHybridWindows()) {
    if (projectWindow(hybrid.windowId, hybrid.baseWin, displays, primaryDisplayId, 'hybrid window')) placedCount++;
  }

  if (placedCount > 0) {
    console.log(`[display-watcher] Repositioned ${placedCount} window(s)`);
  } else {
    DEBUG && console.log('[display-watcher] No windows needed repositioning');
  }
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
