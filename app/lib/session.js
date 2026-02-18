/**
 * Session snapshot — shared pure logic for save/restore.
 *
 * Contains type definitions, URL extraction, parameter sanitization,
 * snapshot validation, crash detection heuristics, and restore
 * sequencing/ordering logic. All functions are pure — no BrowserWindow,
 * no database, no Electron imports.
 *
 * Backend-specific operations (window enumeration, window creation,
 * database persistence, dialog display) remain in each backend's
 * session implementation.
 *
 * @module session
 */

// ============================================================================
// Constants
// ============================================================================

/**
 * Maximum consecutive crash count before auto-skipping restore.
 * After this many crashes, the app starts fresh without asking.
 * @type {number}
 */
export const MAX_CRASH_COUNT = 3;

/**
 * Keys stripped from window params during restore.
 * These are internal bookkeeping or context-dependent values that should be
 * re-derived from the URL and current environment during restore:
 * - x/y/width/height: stale positions from original creation (bounds are authoritative)
 * - role: saved role can trigger hasNonContentRole in window-open, preventing
 *   canvas mode for web pages that had role 'workspace'
 * - escapeMode: affects role detection (escapeMode:'navigate' -> role:'workspace')
 *   which also disables canvas mode for web pages
 * - address: internal bookkeeping param, overwritten by window-open anyway
 * - transient/parentWindowId: session state, not applicable to restored windows
 * @type {Set<string>}
 */
export const RESTORE_STRIP_KEYS = new Set([
  'x', 'y', 'width', 'height',
  'role', 'escapeMode', 'address',
  'transient', 'parentWindowId',
]);

/**
 * URLs that identify internal system windows (should be excluded from snapshots).
 * @type {string[]}
 */
export const SYSTEM_WINDOW_URLS = [
  'peek://app/background.html',
  'peek://app/extension-host.html',
];

// ============================================================================
// URL extraction
// ============================================================================

/**
 * Extract the real URL from a page container URL.
 * Page containers use peek://app/page/index.html?url=<actual-url>
 * Returns the actual URL, or the original URL if not a container.
 *
 * @param {string} url - The possibly-rewritten peek:// URL
 * @returns {string} The actual URL
 */
export function extractRealUrl(url) {
  if (url.startsWith('peek://app/page')) {
    try {
      const parsed = new URL(url);
      const actualUrl = parsed.searchParams.get('url');
      if (actualUrl) {
        return actualUrl;
      }
    } catch {
      // If URL parsing fails, keep the original
    }
  }
  return url;
}

/**
 * Extract webview bounds from a canvas page container URL.
 * Canvas pages encode the visible webview position/size in URL params.
 * Returns null if the URL is not a canvas page or params are missing.
 *
 * @param {string} url - The peek:// container URL
 * @returns {{ x: number, y: number, width: number, height: number } | null}
 */
export function extractCanvasBounds(url) {
  if (!url.startsWith('peek://app/page')) return null;
  try {
    const parsed = new URL(url);
    const x = parsed.searchParams.get('x');
    const y = parsed.searchParams.get('y');
    const width = parsed.searchParams.get('width');
    const height = parsed.searchParams.get('height');
    if (x && y && width && height) {
      return {
        x: parseInt(x, 10),
        y: parseInt(y, 10),
        width: parseInt(width, 10),
        height: parseInt(height, 10),
      };
    }
  } catch {
    // If URL parsing fails, skip
  }
  return null;
}

// ============================================================================
// Parameter sanitization
// ============================================================================

/**
 * Sanitize params to only include serializable values.
 * Filters out functions, complex objects, and other non-JSON-safe types.
 * Mirrors the logic in ipc.ts window-list handler.
 *
 * @param {Record<string, unknown>} params - Raw window params
 * @returns {Record<string, unknown>} Params safe for JSON serialization
 */
export function sanitizeParams(params) {
  const safe = {};
  for (const [key, value] of Object.entries(params)) {
    const type = typeof value;
    if (type === 'string' || type === 'number' || type === 'boolean' || value === null) {
      safe[key] = value;
    } else if (Array.isArray(value)) {
      if (value.every(v => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null)) {
        safe[key] = value;
      }
    }
    // Skip functions, objects, etc. that may not serialize safely
  }
  return safe;
}

/**
 * Strip internal bookkeeping keys from params for restore.
 * Returns a new object without the keys that should be re-derived
 * from the URL and environment during window restoration.
 *
 * @param {Record<string, unknown>} params - Saved window params
 * @returns {Record<string, unknown>} Cleaned params for window-open
 */
export function stripRestoreParams(params) {
  const clean = {};
  for (const [key, value] of Object.entries(params)) {
    if (!RESTORE_STRIP_KEYS.has(key)) {
      clean[key] = value;
    }
  }
  return clean;
}

// ============================================================================
// Snapshot validation
// ============================================================================

/**
 * Validate that a window descriptor has the required fields for restore.
 * Returns false if the descriptor is invalid and should be skipped.
 *
 * @param {WindowDescriptor} descriptor
 * @returns {boolean}
 */
export function isValidDescriptor(descriptor) {
  // Must have a URL
  if (!descriptor.url || typeof descriptor.url !== 'string' || descriptor.url.trim() === '') {
    return false;
  }
  return true;
}

/**
 * Check if a URL belongs to an internal system window.
 *
 * @param {string} url - The window URL to check
 * @returns {boolean} True if this is a system window URL
 */
export function isSystemWindowUrl(url) {
  return SYSTEM_WINDOW_URLS.some(sysUrl => url.includes(sysUrl));
}

/**
 * Validate a session snapshot and return valid window descriptors.
 * Checks version, filters invalid descriptors, returns null if nothing to restore.
 *
 * @param {SessionSnapshot} snapshot - The raw parsed snapshot
 * @returns {{ validWindows: WindowDescriptor[] } | null} Valid windows or null
 */
export function validateSnapshot(snapshot) {
  // Validate version
  if (!snapshot || snapshot.version !== 1) {
    return null;
  }

  // Check if there are windows to restore
  if (!snapshot.windows || snapshot.windows.length === 0) {
    return null;
  }

  // Filter out invalid descriptors
  const validWindows = snapshot.windows.filter(d => isValidDescriptor(d));

  if (validWindows.length === 0) {
    return null;
  }

  return { validWindows };
}

// ============================================================================
// Crash detection heuristics
// ============================================================================

/**
 * Determine whether crash recovery dialog should be shown.
 * Only shown after repeated crashes (crashCount > 0 with unclean shutdown).
 * A single unclean shutdown (e.g. Ctrl+C, power loss) silently restores.
 *
 * @param {boolean} wasCleanShutdown - Whether last session shut down cleanly
 * @param {number} crashCount - Number of consecutive crashes
 * @returns {'restore' | 'ask' | 'skip'} Action to take
 */
export function determineCrashAction(wasCleanShutdown, crashCount) {
  if (wasCleanShutdown || crashCount === 0) {
    return 'restore';
  }
  if (crashCount > MAX_CRASH_COUNT) {
    return 'skip';
  }
  return 'ask';
}

/**
 * Compute updated crash count based on previous shutdown state.
 * If the previous session was not clean, increments the crash count.
 *
 * @param {boolean} wasCleanShutdown - Previous session's clean shutdown flag
 * @param {number} previousCrashCount - Previous crash count
 * @returns {number} Updated crash count
 */
export function computeCrashCount(wasCleanShutdown, previousCrashCount) {
  if (wasCleanShutdown === false) {
    return previousCrashCount + 1;
  }
  return previousCrashCount;
}

// ============================================================================
// Restore sequencing / ordering
// ============================================================================

/**
 * Sort window descriptors by z-order for restore sequencing.
 * Higher zOrder = later in stack = opened later.
 * Returns a new sorted array (does not mutate input).
 *
 * @param {WindowDescriptor[]} windows - Window descriptors to sort
 * @returns {WindowDescriptor[]} Sorted descriptors (back-to-front)
 */
export function sortWindowsByZOrder(windows) {
  return [...windows].sort((a, b) => b.zOrder - a.zOrder);
}

/**
 * Compute restore bounds for a window descriptor.
 * Calculates the center point and returns bounds options for window-open.
 * If the center point is off-screen (as determined by the caller's
 * isOnScreen callback), x/y are omitted so the backend can center the window.
 *
 * @param {{ x: number, y: number, width: number, height: number }} bounds - Saved window bounds
 * @param {(x: number, y: number) => boolean} isOnScreen - Callback to check if a point is on screen
 * @returns {{ width: number, height: number, x?: number, y?: number }}
 */
export function computeRestoreBounds(bounds, isOnScreen) {
  const centerX = bounds.x + Math.round(bounds.width / 2);
  const centerY = bounds.y + Math.round(bounds.height / 2);

  const result = {
    width: bounds.width,
    height: bounds.height,
  };

  if (isOnScreen(centerX, centerY)) {
    result.x = bounds.x;
    result.y = bounds.y;
  }

  return result;
}

/**
 * Build restore options for a window from its descriptor.
 * Combines cleaned params with computed bounds and key.
 *
 * @param {WindowDescriptor} descriptor - The window descriptor
 * @param {(x: number, y: number) => boolean} isOnScreen - Screen bounds checker
 * @returns {Record<string, unknown>} Options object for window-open
 */
export function buildRestoreOptions(descriptor, isOnScreen) {
  const cleanParams = stripRestoreParams(descriptor.params);
  const boundsOptions = computeRestoreBounds(descriptor.bounds, isOnScreen);

  const options = {
    ...cleanParams,
    ...boundsOptions,
  };

  if (descriptor.key) {
    options.key = descriptor.key;
  }

  return options;
}

// ============================================================================
// Restore result analysis
// ============================================================================

/**
 * Check if a restore result indicates a problematic partial restore.
 * Returns true if more than half the windows failed (and there were
 * enough windows for this to be meaningful).
 *
 * @param {{ restored: number, failed: number, total: number }} result
 * @returns {boolean}
 */
export function isPartialRestore(result) {
  return result.failed > 0 && result.total > 2 && result.failed > result.total / 2;
}

// ============================================================================
// Snapshot construction helpers
// ============================================================================

/**
 * Build a SessionSnapshot object from an array of window descriptors.
 *
 * @param {WindowDescriptor[]} windows - Collected window descriptors
 * @param {'before-quit' | 'autosave' | 'manual'} reason - Why the snapshot is being taken
 * @returns {SessionSnapshot}
 */
export function buildSnapshot(windows, reason) {
  return {
    version: 1,
    createdAt: Date.now(),
    reason,
    windows,
  };
}

/**
 * Build a SessionMetadata object, preserving fields from existing metadata.
 *
 * @param {'before-quit' | 'autosave' | 'manual'} reason
 * @param {number} windowCount
 * @param {Partial<SessionMetadata>} [existing] - Previous metadata to merge
 * @param {{ cleanShutdown?: boolean }} [opts]
 * @returns {SessionMetadata}
 */
export function buildMetadata(reason, windowCount, existing, opts) {
  return {
    lastSaveReason: reason,
    lastSaveAt: Date.now(),
    windowCount,
    cleanShutdown: opts?.cleanShutdown !== false,
    crashCount: existing?.crashCount ?? 0,
    lastRestoreAt: existing?.lastRestoreAt,
    restoreCount: existing?.restoreCount,
  };
}
