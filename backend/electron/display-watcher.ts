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
import { getWindowInfo } from './main.js';
import { DEBUG, WEB_CORE_ADDRESS } from './config.js';
import { computePlacement, type Placement } from './window-placement.js';

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

  const allWindows = BrowserWindow.getAllWindows();
  let placedCount = 0;

  for (const win of allWindows) {
    if (win.isDestroyed()) continue;
    if (!win.isVisible()) continue;

    const entry = getWindowInfo(win.id);
    // Skip the background window — never positioned, never visible.
    if (!entry || entry.params.address === WEB_CORE_ADDRESS) continue;
    const placement = entry.params.placement as Placement | undefined;
    if (!placement) continue;

    const bounds = win.getBounds();
    let parentBounds: Electron.Rectangle | undefined;
    if (placement.mode === 'parent-centered') {
      const parent = BrowserWindow.fromId(placement.parentId);
      if (parent && !parent.isDestroyed()) {
        parentBounds = parent.getBounds();
      }
    }

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
        `[display-watcher] Repositioning window ${win.id} (${placement.mode}): ` +
        `(${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}) -> ` +
        `(${result.bounds.x},${result.bounds.y} ${result.bounds.width}x${result.bounds.height})`
      );
      win.setBounds(result.bounds);
      placedCount++;
    }
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
