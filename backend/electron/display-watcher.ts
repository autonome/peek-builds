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
 * Algorithm (group-based distance scaling):
 * - Snapshot display layout at startup and after each change
 * - On display change, for each group of windows on a changed display:
 *   1. Find the bounding box of all window centers on the old display
 *   2. Calculate the center of that bounding box
 *   3. For each window, compute its offset from the bounding box center
 *   4. Scale those offsets by (new display size / old display size)
 *   5. Place windows at (new display center + scaled offset)
 *   6. Scale window dimensions proportionally
 *   7. Clamp to keep all windows on-screen
 * - This preserves the spatial LAYOUT and scales DISTANCES between windows,
 *   rather than mapping each window proportional position independently.
 * - Skip windows that are still fully visible on a valid display
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
 * "Accessible" means the window center-top region (title bar area)
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

    // Find the display whose workArea center is closest to the old display center
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
 * Calculate repositioned bounds for a group of windows moving between displays.
 *
 * Uses center-of-group scaling: finds the bounding box of all window centers,
 * then scales each window offset from that center by the display size ratio.
 * This preserves the spatial layout and scales distances proportionally.
 *
 * For a single window, this degrades gracefully: the window center is mapped
 * to the same relative position on the new display, with scaled dimensions.
 *
 * @param windowBounds Array of window bounds to reposition
 * @param oldDisplay The display windows are moving from
 * @param newDisplay The display windows are moving to
 * @returns Array of new bounds, one per input window
 */
function calculateGroupRepositionedBounds(
  windowBounds: Electron.Rectangle[],
  oldDisplay: DisplaySnapshot,
  newDisplay: DisplaySnapshot
): Electron.Rectangle[] {
  const oldWA = oldDisplay.workArea;
  const newWA = newDisplay.workArea;

  // Scale factors for distances
  const scaleX = oldWA.width > 0 ? newWA.width / oldWA.width : 1;
  const scaleY = oldWA.height > 0 ? newWA.height / oldWA.height : 1;

  // Calculate the center of each window
  const centers = windowBounds.map(wb => ({
    x: wb.x + wb.width / 2,
    y: wb.y + wb.height / 2,
  }));

  // Find the bounding box of all window centers
  let minCX = Infinity, maxCX = -Infinity;
  let minCY = Infinity, maxCY = -Infinity;
  for (const c of centers) {
    minCX = Math.min(minCX, c.x);
    maxCX = Math.max(maxCX, c.x);
    minCY = Math.min(minCY, c.y);
    maxCY = Math.max(maxCY, c.y);
  }

  // Center of the bounding box of window centers (on old display)
  const groupCenterX = (minCX + maxCX) / 2;
  const groupCenterY = (minCY + maxCY) / 2;

  // Map the group center to new display: preserve its relative position within the workArea
  const groupRelX = oldWA.width > 0 ? (groupCenterX - oldWA.x) / oldWA.width : 0.5;
  const groupRelY = oldWA.height > 0 ? (groupCenterY - oldWA.y) / oldWA.height : 0.5;
  const newGroupCenterX = newWA.x + groupRelX * newWA.width;
  const newGroupCenterY = newWA.y + groupRelY * newWA.height;

  const results: Electron.Rectangle[] = [];

  for (let i = 0; i < windowBounds.length; i++) {
    const wb = windowBounds[i];
    const center = centers[i];

    // Offset from group center on old display
    const offsetX = center.x - groupCenterX;
    const offsetY = center.y - groupCenterY;

    // Scale the offset by display size ratio
    const scaledOffsetX = offsetX * scaleX;
    const scaledOffsetY = offsetY * scaleY;

    // Scale window dimensions proportionally
    let newW = Math.round(wb.width * scaleX);
    let newH = Math.round(wb.height * scaleY);

    // Enforce minimum window size
    newW = Math.max(newW, 200);
    newH = Math.max(newH, 150);

    // Cap to new workArea size
    newW = Math.min(newW, newWA.width);
    newH = Math.min(newH, newWA.height);

    // New center = new group center + scaled offset
    const newCenterX = newGroupCenterX + scaledOffsetX;
    const newCenterY = newGroupCenterY + scaledOffsetY;

    // Convert center to top-left
    let newX = Math.round(newCenterX - newW / 2);
    let newY = Math.round(newCenterY - newH / 2);

    // Clamp so window stays fully within the new workArea
    newX = Math.max(newWA.x, Math.min(newX, newWA.x + newWA.width - newW));
    newY = Math.max(newWA.y, Math.min(newY, newWA.y + newWA.height - newH));

    results.push({ x: newX, y: newY, width: newW, height: newH });
  }

  return results;
}

/**
 * Reposition a group of windows from an old display to a new display,
 * preserving their spatial layout with scaled distances.
 */
function repositionWindowGroup(
  entries: WindowEntry[],
  oldDisplay: DisplaySnapshot,
  newDisplay: DisplaySnapshot
): void {
  const windowBounds = entries.map(e => e.bounds);
  const newBoundsList = calculateGroupRepositionedBounds(windowBounds, oldDisplay, newDisplay);

  for (let i = 0; i < entries.length; i++) {
    const { win, bounds } = entries[i];
    const newBounds = newBoundsList[i];

    DEBUG && console.log(
      `[display-watcher] Repositioning window ${win.id}: ` +
      `(${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}) -> ` +
      `(${newBounds.x},${newBounds.y} ${newBounds.width}x${newBounds.height}) ` +
      `[display ${oldDisplay.id} -> ${newDisplay.id}]`
    );

    win.setBounds(newBounds);
  }
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
    DEBUG && console.log("[display-watcher] No display workAreas changed, skipping repositioning");
    _previousDisplays = newDisplays;
    return;
  }

  DEBUG && console.log(`[display-watcher] Changed display IDs: ${[...changedDisplayIds].join(", ")}`);

  // Collect windows that need repositioning, grouped by (oldDisplay -> newDisplay) transition
  // Key: "oldDisplayId->newDisplayId"
  const transitionGroups = new Map<string, {
    entries: WindowEntry[];
    oldDisplay: DisplaySnapshot;
    newDisplay: DisplaySnapshot;
  }>();

  // Also track orphaned windows (center off-screen, no old display found)
  const orphanedWindows: WindowEntry[] = [];

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
      const oldDisplay = findDisplayForPoint(oldDisplays, centerX, centerY);
      if (oldDisplay && changedDisplayIds.has(oldDisplay.id)) {
        const newDisplay = newById.get(oldDisplay.id);
        if (newDisplay) {
          // Same display ID but different size - needs repositioning
          const key = `${oldDisplay.id}->${newDisplay.id}`;
          if (!transitionGroups.has(key)) {
            transitionGroups.set(key, { entries: [], oldDisplay, newDisplay });
          }
          transitionGroups.get(key)!.entries.push({ win, bounds });
        }
      }
      // Otherwise, window is fine where it is
      continue;
    }

    // Window center is off-screen - find where it was and move it
    const oldDisplay = findDisplayForPoint(oldDisplays, centerX, centerY);
    if (oldDisplay) {
      const newDisplay = findBestNewDisplay(oldDisplay, newDisplays);
      const key = `${oldDisplay.id}->${newDisplay.id}`;
      if (!transitionGroups.has(key)) {
        transitionGroups.set(key, { entries: [], oldDisplay, newDisplay });
      }
      transitionGroups.get(key)!.entries.push({ win, bounds });
    } else {
      // Cannot determine old display
      orphanedWindows.push({ win, bounds });
    }
  }

  // Reposition each group with distance scaling
  for (const [key, group] of transitionGroups) {
    DEBUG && console.log(
      `[display-watcher] Repositioning group [${key}]: ${group.entries.length} window(s)`
    );
    repositionWindowGroup(group.entries, group.oldDisplay, group.newDisplay);
  }

  // Handle orphaned windows: center them on the best available display
  for (const { win, bounds } of orphanedWindows) {
    const newDisplay = findBestNewDisplay(null, newDisplays);
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
    _previousDisplays.map(d => `${d.id} (${d.workArea.width}x${d.workArea.height})`).join(", ")
  );

  // Listen for display changes
  screen.on('display-added', () => {
    DEBUG && console.log("[display-watcher] display-added event");
    onDisplayChange();
  });

  screen.on('display-removed', () => {
    DEBUG && console.log("[display-watcher] display-removed event");
    onDisplayChange();
  });

  screen.on('display-metrics-changed', (_event: Electron.Event, _display: Display, changedMetrics: string[]) => {
    DEBUG && console.log("[display-watcher] display-metrics-changed event, metrics:", changedMetrics.join(", "));
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
  DEBUG && console.log("[display-watcher] Cleaned up");
}
