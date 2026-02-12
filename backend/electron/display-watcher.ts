/**
 * Display Change Watcher
 *
 * Monitors display configuration changes (monitor plug/unplug, resolution changes)
 * and repositions windows to maintain approximate relative positions.
 *
 * When a display is removed or resized, windows that were on that display may end up
 * off-screen or bunched in corners. This module detects those cases and moves windows
 * to valid positions on the remaining/changed displays.
 *
 * Algorithm:
 * - Snapshot display layout at startup and after each change
 * - On display change, for each BrowserWindow:
 *   - Find which old display the window center was on
 *   - Find the best new display to place it on
 *   - Calculate the window's relative position (% of old display workArea)
 *   - Apply that relative position to the new display workArea
 *   - Clamp so the window stays fully visible
 * - Skip windows that are still fully visible on a valid display
 */

import { BrowserWindow, screen, Display } from 'electron';
import { getWindowInfo } from './main.js';
import { WEB_CORE_ADDRESS } from './config.js';

const DEBUG = !!process.env.DEBUG;

/** Snapshot of a display's work area at a point in time */
interface DisplaySnapshot {
  id: number;
  bounds: Electron.Rectangle;
  workArea: Electron.Rectangle;
}

/** Last known display layout */
let _previousDisplays: DisplaySnapshot[] = [];

/** Debounce timer for display changes (macOS fires multiple events rapidly) */
let _debounceTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 500;

/**
 * Take a snapshot of the current display layout.
 */
function snapshotDisplays(): DisplaySnapshot[] {
  return screen.getAllDisplays().map(d => ({
    id: d.id,
    bounds: { ...d.bounds },
    workArea: { ...d.workArea },
  }));
}

/**
 * Find which display a point falls within (using workArea).
 * Returns null if the point is not on any display.
 */
function findDisplayForPoint(displays: DisplaySnapshot[], x: number, y: number): DisplaySnapshot | null {
  for (const d of displays) {
    const wa = d.workArea;
    if (x >= wa.x && x < wa.x + wa.width && y >= wa.y && y < wa.y + wa.height) {
      return d;
    }
  }
  // Fallback: check bounds (workArea excludes taskbar/dock, but window could be in that zone)
  for (const d of displays) {
    const b = d.bounds;
    if (x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height) {
      return d;
    }
  }
  return null;
}

/**
 * Check if a window is still accessible on the current displays.
 * "Accessible" means the window's center-top region (title bar area)
 * is on a valid display, so the user can still grab and move it.
 */
function isWindowAccessible(displays: DisplaySnapshot[], bounds: Electron.Rectangle): boolean {
  const centerX = bounds.x + Math.round(bounds.width / 2);
  const topY = bounds.y + 15; // Title bar midpoint
  return findDisplayForPoint(displays, centerX, topY) !== null;
}

/**
 * Find the best new display to place a window on.
 * Tries to match by display ID first, then by proximity of old display position.
 */
function findBestNewDisplay(
  oldDisplay: DisplaySnapshot | null,
  newDisplays: DisplaySnapshot[]
): DisplaySnapshot {
  if (newDisplays.length === 0) {
    // Should never happen, but safety fallback
    const primary = screen.getPrimaryDisplay();
    return {
      id: primary.id,
      bounds: { ...primary.bounds },
      workArea: { ...primary.workArea },
    };
  }

  // If we know the old display, try to find it by ID in the new layout
  if (oldDisplay) {
    const sameId = newDisplays.find(d => d.id === oldDisplay.id);
    if (sameId) return sameId;

    // Find the display whose workArea center is closest to the old display's center
    const oldCenterX = oldDisplay.workArea.x + oldDisplay.workArea.width / 2;
    const oldCenterY = oldDisplay.workArea.y + oldDisplay.workArea.height / 2;

    let best = newDisplays[0];
    let bestDist = Infinity;
    for (const d of newDisplays) {
      const cx = d.workArea.x + d.workArea.width / 2;
      const cy = d.workArea.y + d.workArea.height / 2;
      const dist = Math.hypot(cx - oldCenterX, cy - oldCenterY);
      if (dist < bestDist) {
        bestDist = dist;
        best = d;
      }
    }
    return best;
  }

  // No old display info - use primary
  const primary = newDisplays.find(d => {
    const pd = screen.getPrimaryDisplay();
    return d.id === pd.id;
  });
  return primary || newDisplays[0];
}

/**
 * Reposition a window from an old display to a new display,
 * preserving its relative position.
 */
function repositionWindow(
  win: BrowserWindow,
  winBounds: Electron.Rectangle,
  oldDisplay: DisplaySnapshot,
  newDisplay: DisplaySnapshot
): void {
  const oldWA = oldDisplay.workArea;
  const newWA = newDisplay.workArea;

  // Calculate relative position within old workArea (0..1)
  const relX = oldWA.width > 0 ? (winBounds.x - oldWA.x) / oldWA.width : 0;
  const relY = oldWA.height > 0 ? (winBounds.y - oldWA.y) / oldWA.height : 0;
  const relW = oldWA.width > 0 ? winBounds.width / oldWA.width : 0.5;
  const relH = oldWA.height > 0 ? winBounds.height / oldWA.height : 0.5;

  // Apply relative position to new workArea
  let newW = Math.round(relW * newWA.width);
  let newH = Math.round(relH * newWA.height);

  // Minimum window size
  newW = Math.max(newW, 200);
  newH = Math.max(newH, 150);

  // Cap to new workArea size
  newW = Math.min(newW, newWA.width);
  newH = Math.min(newH, newWA.height);

  let newX = Math.round(newWA.x + relX * newWA.width);
  let newY = Math.round(newWA.y + relY * newWA.height);

  // Clamp so window stays fully within the new workArea
  newX = Math.max(newWA.x, Math.min(newX, newWA.x + newWA.width - newW));
  newY = Math.max(newWA.y, Math.min(newY, newWA.y + newWA.height - newH));

  DEBUG && console.log(
    `[display-watcher] Repositioning window ${win.id}: ` +
    `(${winBounds.x},${winBounds.y} ${winBounds.width}x${winBounds.height}) -> ` +
    `(${newX},${newY} ${newW}x${newH}) ` +
    `[display ${oldDisplay.id} -> ${newDisplay.id}]`
  );

  win.setBounds({ x: newX, y: newY, width: newW, height: newH });
}

/**
 * Handle a display configuration change.
 * Checks all windows and repositions any that are off-screen or on a changed display.
 */
function handleDisplayChange(): void {
  const newDisplays = snapshotDisplays();
  const oldDisplays = _previousDisplays;

  DEBUG && console.log(
    `[display-watcher] Display change detected. ` +
    `Old: ${oldDisplays.length} display(s), New: ${newDisplays.length} display(s)`
  );

  // Build a map of new displays by ID for quick lookup
  const newById = new Map(newDisplays.map(d => [d.id, d]));

  // Determine which displays changed (removed, resized, or moved)
  const changedDisplayIds = new Set<number>();
  for (const old of oldDisplays) {
    const cur = newById.get(old.id);
    if (!cur) {
      // Display was removed
      changedDisplayIds.add(old.id);
    } else if (
      cur.workArea.x !== old.workArea.x ||
      cur.workArea.y !== old.workArea.y ||
      cur.workArea.width !== old.workArea.width ||
      cur.workArea.height !== old.workArea.height
    ) {
      // Display workArea changed (resolution, scaling, or dock/taskbar change)
      changedDisplayIds.add(old.id);
    }
  }

  if (changedDisplayIds.size === 0) {
    DEBUG && console.log('[display-watcher] No display workAreas changed, skipping repositioning');
    _previousDisplays = newDisplays;
    return;
  }

  DEBUG && console.log(`[display-watcher] Changed display IDs: ${[...changedDisplayIds].join(', ')}`);

  // Iterate all BrowserWindows
  const allWindows = BrowserWindow.getAllWindows();
  for (const win of allWindows) {
    if (win.isDestroyed()) continue;
    if (!win.isVisible()) continue;

    // Skip the background window
    const entry = getWindowInfo(win.id);
    if (entry && entry.params.address === WEB_CORE_ADDRESS) continue;

    const bounds = win.getBounds();
    const centerX = bounds.x + Math.round(bounds.width / 2);
    const centerY = bounds.y + Math.round(bounds.height / 2);

    // Check if window is still accessible on a current display
    if (isWindowAccessible(newDisplays, bounds)) {
      // Window is still reachable - but check if its display changed size
      // (e.g. switching from a 2560px monitor to a 1440px one on the same port)
      const oldDisplay = findDisplayForPoint(oldDisplays, centerX, centerY);
      if (oldDisplay && changedDisplayIds.has(oldDisplay.id)) {
        const newDisplay = newById.get(oldDisplay.id);
        if (newDisplay) {
          // Same display ID but different size - reposition proportionally
          repositionWindow(win, bounds, oldDisplay, newDisplay);
        }
      }
      // Otherwise, window is fine where it is
      continue;
    }

    // Window center is off-screen - find where it was and move it
    const oldDisplay = findDisplayForPoint(oldDisplays, centerX, centerY);
    const newDisplay = findBestNewDisplay(oldDisplay, newDisplays);

    if (oldDisplay) {
      repositionWindow(win, bounds, oldDisplay, newDisplay);
    } else {
      // Can't determine old display - just center on the best new display
      const wa = newDisplay.workArea;
      const w = Math.min(bounds.width, wa.width);
      const h = Math.min(bounds.height, wa.height);
      const x = wa.x + Math.round((wa.width - w) / 2);
      const y = wa.y + Math.round((wa.height - h) / 2);
      DEBUG && console.log(
        `[display-watcher] Centering orphaned window ${win.id} on display ${newDisplay.id}: (${x},${y} ${w}x${h})`
      );
      win.setBounds({ x, y, width: w, height: h });
    }
  }

  // Update snapshot for next change
  _previousDisplays = newDisplays;
}

/**
 * Debounced display change handler.
 * macOS fires multiple display events in quick succession (e.g. resolution + workArea).
 * We debounce to handle them as a single batch.
 */
function onDisplayChange(): void {
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
  }
  _debounceTimer = setTimeout(() => {
    _debounceTimer = null;
    handleDisplayChange();
  }, DEBOUNCE_MS);
}

/**
 * Initialize the display watcher.
 * Call this after app.ready (screen API requires it).
 */
export function initDisplayWatcher(): void {
  // Take initial snapshot
  _previousDisplays = snapshotDisplays();

  DEBUG && console.log(
    `[display-watcher] Initialized with ${_previousDisplays.length} display(s): ` +
    _previousDisplays.map(d => `${d.id} (${d.workArea.width}x${d.workArea.height})`).join(', ')
  );

  // Listen for display changes
  screen.on('display-added', () => {
    DEBUG && console.log('[display-watcher] display-added event');
    onDisplayChange();
  });

  screen.on('display-removed', () => {
    DEBUG && console.log('[display-watcher] display-removed event');
    onDisplayChange();
  });

  screen.on('display-metrics-changed', (_event: Electron.Event, _display: Display, changedMetrics: string[]) => {
    DEBUG && console.log('[display-watcher] display-metrics-changed event, metrics:', changedMetrics.join(', '));
    // Only react to meaningful changes (bounds, workArea, scaleFactor)
    // Ignore rotation-only changes
    const meaningful = changedMetrics.some(m => ['bounds', 'workArea', 'scaleFactor'].includes(m));
    if (meaningful) {
      onDisplayChange();
    }
  });
}

/**
 * Clean up the display watcher.
 * Call this during app shutdown.
 */
export function cleanupDisplayWatcher(): void {
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }
  screen.removeAllListeners('display-added');
  screen.removeAllListeners('display-removed');
  screen.removeAllListeners('display-metrics-changed');
  DEBUG && console.log('[display-watcher] Cleaned up');
}
