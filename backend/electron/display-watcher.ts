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
 * Algorithm (three-phase display change handling):
 * - Snapshot display layout at startup and after each change
 * - Phase 1 (Save): When displays are removed, save "home display" info for displaced
 *   windows (display ID, resolution, relative position within the workArea)
 * - Phase 2 (Restore): When displays are added and there are displaced windows, try to
 *   match each window's home display to a newly added display (by ID first, then by
 *   resolution with 5% tolerance). Restore matched windows to their original positions.
 * - Phase 3 (Reposition): For remaining windows on changed displays, use group-based
 *   distance scaling:
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

/** Records a window's "home" display info when it gets displaced */
interface WindowHomeDisplay {
  displayId: number;
  resolution: { width: number; height: number };
  relativePosition: {
    centerX: number; // 0-1 ratio within workArea width
    centerY: number; // 0-1 ratio within workArea height
    width: number;   // 0-1 ratio within workArea width
    height: number;  // 0-1 ratio within workArea height
  };
}

/** Last known display layout */
let _previousDisplays: DisplaySnapshot[] = [];

/** Displaced windows awaiting restoration, keyed by BrowserWindow id */
let _windowHomeDisplays: Map<number, WindowHomeDisplay> = new Map();

/** Pre-debounce snapshot of window positions, captured immediately on display-removed.
 * macOS moves windows from disconnected displays BEFORE our debounced handler fires,
 * so we must capture window-to-display mappings eagerly. Maps windowId -> bounds. */
let _preDebounceWindowBounds: Map<number, Electron.Rectangle> | null = null;

/** Debounce timer for display changes (macOS fires multiple events rapidly) */
let _debounceTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 500;

/** When true, display changes update the snapshot but skip window repositioning.
 * Used during session restore to prevent newly restored windows from being moved. */
let _suppressRepositioning = false;

/**
 * Suppress window repositioning during a critical section (e.g., session restore).
 * The display snapshot is still updated on changes, but windows are not moved.
 * Call with true before restore, false after.
 */
export function suppressDisplayRepositioning(suppress: boolean): void {
  _suppressRepositioning = suppress;
  if (suppress) {
    // Cancel any pending debounced display change handler.
    // Without this, a display event that fired before suppression could trigger
    // repositioning AFTER suppression ends (the debounce timer outlasts the suppress window).
    if (_debounceTimer) {
      clearTimeout(_debounceTimer);
      _debounceTimer = null;
    }
    _preDebounceWindowBounds = null;
    console.log("[display-watcher] Repositioning SUPPRESSED (session restore in progress)");
  } else {
    // Cancel any pending debounced events that accumulated during suppression.
    // These would use stale snapshots and could reposition windows incorrectly.
    if (_debounceTimer) {
      clearTimeout(_debounceTimer);
      _debounceTimer = null;
    }
    _preDebounceWindowBounds = null;
    // Take a fresh snapshot so the watcher has the correct baseline
    // after session restore created new windows
    _previousDisplays = snapshotDisplays();
    console.log("[display-watcher] Repositioning RE-ENABLED, snapshot refreshed");
  }
}

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

    console.log(`[display-watcher] REPOSITIONING window ${win.id}: (${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}) -> (${newBounds.x},${newBounds.y} ${newBounds.width}x${newBounds.height})`);
    win.setBounds(newBounds);
  }
}

/**
 * Save a window's home display info before it gets displaced.
 * Captures the window's relative position within the display's workArea
 * so it can be restored later if the same display reappears.
 */
function saveWindowHomeDisplay(
  win: BrowserWindow,
  bounds: Electron.Rectangle,
  display: DisplaySnapshot
): void {
  const wa = display.workArea;
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;

  const homeDisplay: WindowHomeDisplay = {
    displayId: display.id,
    resolution: { width: wa.width, height: wa.height },
    relativePosition: {
      centerX: wa.width > 0 ? (centerX - wa.x) / wa.width : 0.5,
      centerY: wa.height > 0 ? (centerY - wa.y) / wa.height : 0.5,
      width: wa.width > 0 ? bounds.width / wa.width : 0.5,
      height: wa.height > 0 ? bounds.height / wa.height : 0.5,
    },
  };

  _windowHomeDisplays.set(win.id, homeDisplay);
  DEBUG && console.log(
    `[display-watcher] Saved home display for window ${win.id}: ` +
    `display ${display.id} (${wa.width}x${wa.height}), ` +
    `rel center (${homeDisplay.relativePosition.centerX.toFixed(3)}, ${homeDisplay.relativePosition.centerY.toFixed(3)})`
  );
}

/**
 * Find a matching new display for a displaced window's home display.
 * Matches by display ID first, then falls back to resolution matching
 * within a 5% tolerance.
 */
function findMatchingNewDisplay(
  home: WindowHomeDisplay,
  addedDisplays: DisplaySnapshot[]
): DisplaySnapshot | null {
  // First try exact display ID match
  const byId = addedDisplays.find(d => d.id === home.displayId);
  if (byId) return byId;

  // Fallback: match by resolution within 5% tolerance
  const tolerance = 0.05;
  for (const d of addedDisplays) {
    const wa = d.workArea;
    const widthRatio = home.resolution.width > 0
      ? Math.abs(wa.width - home.resolution.width) / home.resolution.width
      : (wa.width === 0 ? 0 : 1);
    const heightRatio = home.resolution.height > 0
      ? Math.abs(wa.height - home.resolution.height) / home.resolution.height
      : (wa.height === 0 ? 0 : 1);

    if (widthRatio <= tolerance && heightRatio <= tolerance) {
      DEBUG && console.log(
        `[display-watcher] Resolution match: home (${home.resolution.width}x${home.resolution.height}) ` +
        `-> display ${d.id} (${wa.width}x${wa.height}), ` +
        `delta (${(widthRatio * 100).toFixed(1)}%, ${(heightRatio * 100).toFixed(1)}%)`
      );
      return d;
    }
  }

  return null;
}

/**
 * Restore a window to its saved home display position.
 * Places the window at the same relative position within the new display's workArea.
 */
function restoreWindowToHomeDisplay(
  win: BrowserWindow,
  home: WindowHomeDisplay,
  display: DisplaySnapshot
): void {
  const wa = display.workArea;
  const rel = home.relativePosition;

  // Restore window dimensions from relative sizes
  let newW = Math.round(rel.width * wa.width);
  let newH = Math.round(rel.height * wa.height);

  // Enforce minimum window size
  newW = Math.max(newW, 200);
  newH = Math.max(newH, 150);

  // Cap to workArea size
  newW = Math.min(newW, wa.width);
  newH = Math.min(newH, wa.height);

  // Restore center position from relative coordinates
  const centerX = wa.x + rel.centerX * wa.width;
  const centerY = wa.y + rel.centerY * wa.height;

  // Convert center to top-left
  let newX = Math.round(centerX - newW / 2);
  let newY = Math.round(centerY - newH / 2);

  // Clamp within workArea
  newX = Math.max(wa.x, Math.min(newX, wa.x + wa.width - newW));
  newY = Math.max(wa.y, Math.min(newY, wa.y + wa.height - newH));

  const newBounds = { x: newX, y: newY, width: newW, height: newH };

  DEBUG && console.log(
    `[display-watcher] Restoring window ${win.id} to home display ${display.id}: ` +
    `(${newBounds.x},${newBounds.y} ${newBounds.width}x${newBounds.height})`
  );

  console.log(`[display-watcher] RESTORING window ${win.id} to home display: (${newBounds.x},${newBounds.y} ${newBounds.width}x${newBounds.height})`);
  win.setBounds(newBounds);
}

/**
 * Handle a display configuration change.
 * Three-phase approach:
 *   Phase 1: Save home display info for windows on removed displays
 *   Phase 2: Restore displaced windows to matching newly-added displays
 *   Phase 3: Reposition remaining off-screen/resized windows (existing logic)
 */
function handleDisplayChange(): void {
  console.log(`[display-watcher] handleDisplayChange fired — checking for window repositioning`);
  if (_suppressRepositioning) {
    console.log("[display-watcher] Repositioning suppressed during session restore — updating snapshot only");
    _previousDisplays = snapshotDisplays();
    return;
  }
  const newDisplays = snapshotDisplays();
  const oldDisplays = _previousDisplays;

  DEBUG && console.log(
    `[display-watcher] Display change detected. ` +
    `Old: ${oldDisplays.length} display(s), New: ${newDisplays.length} display(s)`
  );

  // Build maps for quick lookup
  const newById = new Map(newDisplays.map(d => [d.id, d]));
  const oldById = new Map(oldDisplays.map(d => [d.id, d]));

  // Determine which displays were removed, added, or changed
  const removedDisplayIds = new Set<number>();
  const changedDisplayIds = new Set<number>();
  for (const old of oldDisplays) {
    const cur = newById.get(old.id);
    if (!cur) {
      removedDisplayIds.add(old.id);
      changedDisplayIds.add(old.id);
    } else if (
      cur.workArea.x !== old.workArea.x ||
      cur.workArea.y !== old.workArea.y ||
      cur.workArea.width !== old.workArea.width ||
      cur.workArea.height !== old.workArea.height
    ) {
      changedDisplayIds.add(old.id);
    }
  }

  const addedDisplays: DisplaySnapshot[] = [];
  for (const d of newDisplays) {
    if (!oldById.has(d.id)) {
      addedDisplays.push(d);
    }
  }

  DEBUG && console.log(
    `[display-watcher] Removed: ${[...removedDisplayIds].join(", ") || "none"}, ` +
    `Added: ${addedDisplays.map(d => d.id).join(", ") || "none"}, ` +
    `Changed: ${[...changedDisplayIds].join(", ") || "none"}`
  );

  // ========================================================================
  // Phase 1 (Save): Save home display info for windows on removed displays.
  // Use pre-debounce window bounds if available — macOS auto-relocates windows from
  // disconnected displays BEFORE our debounced handler runs, so win.getBounds() at this
  // point returns the post-relocation position (on the laptop), not the original position
  // (on the external display). The pre-debounce capture gives us the true positions.
  // ========================================================================
  if (removedDisplayIds.size > 0) {
    const allWindows = BrowserWindow.getAllWindows();
    for (const win of allWindows) {
      if (win.isDestroyed()) continue;
      if (!win.isVisible()) continue;

      // Skip the background window
      const entry = getWindowInfo(win.id);
      if (entry && entry.params.address === WEB_CORE_ADDRESS) continue;

      // Only save if we haven't already saved a home display for this window
      if (_windowHomeDisplays.has(win.id)) continue;

      // Use pre-debounce bounds (captured before macOS moved windows) if available,
      // otherwise fall back to current bounds (may already be post-relocation).
      const bounds = _preDebounceWindowBounds?.get(win.id) ?? win.getBounds();
      const centerX = bounds.x + Math.round(bounds.width / 2);
      const centerY = bounds.y + Math.round(bounds.height / 2);

      // Check if the window was on a removed display
      const oldDisplay = findDisplayForPoint(oldDisplays, centerX, centerY);
      if (oldDisplay && removedDisplayIds.has(oldDisplay.id)) {
        saveWindowHomeDisplay(win, bounds, oldDisplay);
      }
    }

    DEBUG && console.log(
      `[display-watcher] Phase 1: Saved ${_windowHomeDisplays.size} displaced window(s)` +
      (_preDebounceWindowBounds ? ' (using pre-debounce bounds)' : ' (using current bounds)')
    );
  }

  // ========================================================================
  // Phase 2 (Restore): Restore displaced windows to matching new displays
  // ========================================================================
  if (addedDisplays.length > 0 && _windowHomeDisplays.size > 0) {
    const restoredWindowIds: number[] = [];

    for (const [winId, home] of _windowHomeDisplays) {
      const win = BrowserWindow.fromId(winId);
      if (!win || win.isDestroyed()) {
        restoredWindowIds.push(winId); // Clean up stale entries
        continue;
      }

      const matchingDisplay = findMatchingNewDisplay(home, addedDisplays);
      if (matchingDisplay) {
        restoreWindowToHomeDisplay(win, home, matchingDisplay);
        restoredWindowIds.push(winId);
      }
    }

    // Remove restored/stale entries from the map
    for (const id of restoredWindowIds) {
      _windowHomeDisplays.delete(id);
    }

    DEBUG && console.log(
      `[display-watcher] Phase 2: Restored ${restoredWindowIds.length} window(s), ` +
      `${_windowHomeDisplays.size} still displaced`
    );
  }

  // ========================================================================
  // Phase 3 (Reposition): Handle remaining off-screen/resized windows
  // ========================================================================

  if (changedDisplayIds.size === 0 && addedDisplays.length === 0) {
    DEBUG && console.log("[display-watcher] Phase 3: No display workAreas changed, skipping repositioning");
    _previousDisplays = newDisplays;
    return;
  }

  DEBUG && console.log(`[display-watcher] Phase 3: Changed display IDs: ${[...changedDisplayIds].join(", ")}`);

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
 * Capture a snapshot of all window bounds right now.
 * Called immediately (before debounce) on display-removed events so we know
 * which display each window was on BEFORE macOS auto-relocates them.
 */
function captureWindowBounds(): Map<number, Electron.Rectangle> {
  const bounds = new Map<number, Electron.Rectangle>();
  const allWindows = BrowserWindow.getAllWindows();
  for (const win of allWindows) {
    if (win.isDestroyed() || !win.isVisible()) continue;
    bounds.set(win.id, win.getBounds());
  }
  return bounds;
}

/**
 * Debounced display change handler.
 * macOS fires multiple display events in quick succession (e.g. resolution + workArea).
 * We debounce to handle them as a single batch.
 *
 * @param isRemoval - if true, capture window bounds immediately before macOS moves them
 */
function onDisplayChange(isRemoval = false): void {
  // On the FIRST event in a debounce window, capture window bounds eagerly.
  // macOS moves windows from disconnected displays before our debounced handler fires,
  // so we need the pre-move positions to correctly identify which display each window was on.
  if (!_debounceTimer && isRemoval) {
    _preDebounceWindowBounds = captureWindowBounds();
    DEBUG && console.log(`[display-watcher] Captured pre-debounce window bounds: ${_preDebounceWindowBounds.size} windows`);
  }

  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
  }
  _debounceTimer = setTimeout(() => {
    _debounceTimer = null;
    handleDisplayChange();
    // Clear pre-debounce bounds after handling
    _preDebounceWindowBounds = null;
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
    onDisplayChange(/* isRemoval */ true);
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
