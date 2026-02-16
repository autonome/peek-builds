/**
 * Display Change Watcher — Safety Net
 *
 * Monitors display configuration changes (monitor plug/unplug, resolution changes)
 * and rescues genuinely orphaned windows that end up off-screen.
 *
 * macOS handles window migration natively when displays are added/removed.
 * This module only intervenes when a window has less than 30% area overlap
 * with any display workArea — meaning it's truly inaccessible to the user.
 *
 * Algorithm (single-pass safety net):
 * - Snapshot display layout at startup and after each change
 * - On display change: check every window's overlap with current displays
 * - If a window has <30% overlap with ANY display, it's orphaned:
 *   find the nearest display and center the window on it
 * - Window size is NEVER changed — only position is adjusted
 * - If all windows are accessible (99% of cases), do nothing
 */

import { BrowserWindow, screen, Display } from 'electron';
import { getWindowInfo } from './main.js';
import { WEB_CORE_ADDRESS } from './config.js';

const DEBUG = !!process.env.DEBUG;

/** Snapshot of a display work area at a point in time */
interface DisplaySnapshot {
  id: number;
  bounds: Electron.Rectangle;
  workArea: Electron.Rectangle;
}

/** A window and its bounds at the time of the display change */
interface WindowEntry {
  win: BrowserWindow;
  bounds: Electron.Rectangle;
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
 * "Accessible" means the window has at least 30% area overlap with
 * any display's workArea, so the user can still interact with it.
 * Zero-size windows are always considered accessible (hidden/minimized).
 */
function isWindowAccessible(displays: DisplaySnapshot[], bounds: Electron.Rectangle): boolean {
  const windowArea = bounds.width * bounds.height;

  // Zero-size windows are always accessible (hidden, minimized, etc.)
  if (windowArea <= 0) return true;

  for (const d of displays) {
    const wa = d.workArea;

    // Calculate overlap rectangle
    const overlapX = Math.max(bounds.x, wa.x);
    const overlapY = Math.max(bounds.y, wa.y);
    const overlapRight = Math.min(bounds.x + bounds.width, wa.x + wa.width);
    const overlapBottom = Math.min(bounds.y + bounds.height, wa.y + wa.height);

    if (overlapRight > overlapX && overlapBottom > overlapY) {
      const overlapArea = (overlapRight - overlapX) * (overlapBottom - overlapY);
      if (overlapArea / windowArea >= 0.3) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Find the best new display to place a window on.
 * Finds the nearest display by center-point proximity.
 * Falls back to primary display when no old display info is available.
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

  // If we know the old display, find the nearest new display by center distance
  if (oldDisplay) {
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
 * Handle a display configuration change.
 * Single-pass safety net: check all windows, rescue any that are orphaned.
 */
function handleDisplayChange(): void {
  const newDisplays = snapshotDisplays();
  const oldDisplays = _previousDisplays;

  console.log(
    `[display-watcher] Display change detected. ` +
    `Old: ${oldDisplays.length} display(s) [${oldDisplays.map(d => `${d.id}(${d.workArea.x},${d.workArea.y} ${d.workArea.width}x${d.workArea.height})`).join(', ')}], ` +
    `New: ${newDisplays.length} display(s) [${newDisplays.map(d => `${d.id}(${d.workArea.x},${d.workArea.y} ${d.workArea.width}x${d.workArea.height})`).join(', ')}]`
  );

  const allWindows = BrowserWindow.getAllWindows();
  let rescuedCount = 0;

  for (const win of allWindows) {
    if (win.isDestroyed()) continue;
    if (!win.isVisible()) continue;

    // Skip the background window
    const entry = getWindowInfo(win.id);
    if (entry && entry.params.address === WEB_CORE_ADDRESS) continue;

    const bounds = win.getBounds();

    // Check if window is accessible on current displays
    if (isWindowAccessible(newDisplays, bounds)) {
      continue;
    }

    // Window is orphaned — rescue it
    const centerX = bounds.x + Math.round(bounds.width / 2);
    const centerY = bounds.y + Math.round(bounds.height / 2);

    // Find which old display this window was on
    const oldDisplay = findDisplayForPoint(oldDisplays, centerX, centerY);

    // Find the best new display to place it on
    const newDisplay = findBestNewDisplay(oldDisplay, newDisplays);
    const wa = newDisplay.workArea;

    // Position window on the target display, preserving original size.
    // Only reposition, never resize — macOS handles display transitions
    // and windows should keep their size even if larger than the new display.
    const x = wa.x + Math.round((wa.width - bounds.width) / 2);
    const y = wa.y + Math.round((wa.height - bounds.height) / 2);

    console.log(
      `[display-watcher] Rescuing orphaned window ${win.id}: ` +
      `(${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}) -> ` +
      `(${x},${y} ${bounds.width}x${bounds.height}) [display ${newDisplay.id}]`
    );

    win.setBounds({ x, y, width: bounds.width, height: bounds.height });
    rescuedCount++;
  }

  if (rescuedCount === 0) {
    DEBUG && console.log("[display-watcher] All windows accessible, no rescue needed");
  } else {
    console.log(`[display-watcher] Rescued ${rescuedCount} orphaned window(s)`);
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

  console.log(
    `[display-watcher] Initialized with ${_previousDisplays.length} display(s): ` +
    _previousDisplays.map(d => `${d.id} (${d.workArea.x},${d.workArea.y} ${d.workArea.width}x${d.workArea.height})`).join(", ")
  );

  // Listen for display changes
  screen.on('display-added', () => {
    console.log("[display-watcher] display-added event");
    onDisplayChange();
  });

  screen.on('display-removed', () => {
    console.log("[display-watcher] display-removed event");
    onDisplayChange();
  });

  screen.on('display-metrics-changed', (_event: Electron.Event, _display: Display, changedMetrics: string[]) => {
    console.log("[display-watcher] display-metrics-changed event, metrics:", changedMetrics.join(", "));
    // Only react to meaningful changes (bounds, workArea, scaleFactor)
    // Ignore rotation-only changes
    const meaningful = changedMetrics.some(m => ['bounds', 'workArea', 'scaleFactor'].includes(m));
    if (meaningful) {
      onDisplayChange();
    }
  });
}

/**
 * Track a window for display change handling.
 * Call this after creating any visible window.
 * Attaches a closed listener to clean up.
 */
export function trackWindow(win: BrowserWindow): void {
  // Clean up on close (future-proofing for any per-window state)
  win.on('closed', () => {
    // No per-window state to clean up in the safety-net approach,
    // but keeping the hook for extensibility.
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
  DEBUG && console.log("[display-watcher] Cleaned up");
}
