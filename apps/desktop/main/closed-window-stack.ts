// The recently-closed-window stack behind reopen-last-closed: the LIFO store with its
// capacity cap, and the decision of whether a window that just closed is worth remembering
// plus the entry it is remembered as. Persistence (the `session`/`closed-window-stack`
// `feature_settings` row), debug logging and the quit-time push suppression stay in main.ts,
// which wraps these.
// Pure and Electron-free so it stays unit-testable under ELECTRON_RUN_AS_NODE=1.

import { closedWindowSaveBounds } from './session-projection.js';
import type { NavHistoryEntry, NavHistorySnapshot } from './nav-history.js';

interface Rect { x: number; y: number; width: number; height: number }

// Recently closed windows stack (in-memory, most recent last)
export const MAX_CLOSED_WINDOWS = 50;

export interface ClosedWindowEntry {
  url: string;           // Current URL at time of close (where user actually was)
  originalUrl?: string;  // Original URL the window was opened with
  source: string;
  bounds: Rect | null;
  spaceMode: { spaceId: string; spaceName: string; color?: string } | null;
  role?: string;         // Window role (workspace, content, etc.) — needed to restore peek:// windows correctly
  scrollX?: number;      // Scroll position at time of close
  scrollY?: number;
  // Legacy: only entries persisted by older builds carry these; reopen reads them
  // to come back unmaximized at `preMaximizeBounds`. New entries never set them.
  maximized?: boolean;
  preMaximizeBounds?: Rect;
  // Back/forward trail the window had at close, so undo-close brings the whole
  // trail back instead of just the leaf URL (nav-history.ts owns the shape and
  // the size rule). LOCAL MACHINE STATE: the `session`/`closed-window-stack`
  // `feature_settings` row this stack persists into is not read by sync.ts, and
  // a trail must never leave the device — it describes one machine's browsing
  // and can carry query strings and one-time URLs. Both fields are optional
  // because every entry persisted before they existed lacks them, and such an
  // entry must keep reopening at its leaf URL.
  navHistory?: NavHistoryEntry[];
  navHistoryIndex?: number;
  timestamp: number;
}

/**
 * Bounds/presentation captured for a window BEFORE its native handle is destroyed — the
 * structural shape of main.ts's `CapturedClosePresentation` as entry building needs it.
 * Declared here rather than imported so this module stays clear of `window-presenter.ts`
 * and the Electron typings it carries; the two are assignable in both directions.
 */
export interface CapturedCloseBounds {
  bounds: Rect | null;
  presentation: { bounds: Rect; maximized?: boolean; preMaxBounds?: Rect | null } | null;
}

/**
 * The `mode` context entry as entry building reads it — the two fields it touches, out of
 * datastore.ts's `ContextEntry`. `value` is `unknown` there, so it is `unknown` here.
 */
export interface ClosedWindowModeEntry {
  value: unknown;
  metadata?: Record<string, unknown>;
}

const closedWindowStack: ClosedWindowEntry[] = [];

/**
 * Push a closed window entry onto the stack, dropping the oldest once the cap is reached.
 */
export function pushClosedWindow(entry: ClosedWindowEntry): void {
  closedWindowStack.push(entry);
  if (closedWindowStack.length > MAX_CLOSED_WINDOWS) {
    closedWindowStack.shift();
  }
}

/**
 * Pop the most recently closed window from the stack.
 */
export function popClosedWindow(): ClosedWindowEntry | undefined {
  return closedWindowStack.pop();
}

/**
 * Get the number of closed windows in the stack
 */
export function getClosedWindowCount(): number {
  return closedWindowStack.length;
}

/**
 * Get a copy of the current closed window stack.
 * Used by session save to persist the stack.
 */
export function getClosedWindowStack(): ClosedWindowEntry[] {
  return [...closedWindowStack];
}

/**
 * Replace the whole stack in place — the startup load of the persisted rows, and the reset
 * a test needs between cases. In place rather than reassigning, so a holder of the array
 * identity never goes stale.
 */
export function replaceClosedWindowStack(entries: readonly ClosedWindowEntry[]): void {
  closedWindowStack.length = 0;
  for (const entry of entries) {
    closedWindowStack.push(entry);
  }
}

/**
 * Whether a window that just closed is worth remembering, and the entry it is remembered as
 * — `null` when it is not. Only user-facing content windows with web URLs qualify (not
 * background, modals, palettes, etc.).
 *
 * `params` and `source` come from the open registry's payload, `modeEntry` from the window's
 * `mode` context, `captured` from the pre-destroy bounds/presentation capture, and `trail`
 * from the nav-history cache. Bounds come from the presentation when one resolved: the
 * presenter reads the window-state machine via the ONE restorable-geometry rule
 * (window-presenter.ts getRestorableBounds, §5 step 7D) for every window kind, so a
 * fullscreen window reopens at a sane rect. Maximize is not restored: a maximized window is
 * saved at its pre-maximize rect. Canvas pages used to get a bounds adjustment here
 * (subtracting the fixed canvas chrome margin from window bounds) — that fallback was gated
 * on the canvas shell URL and was deleted along with the canvas page-host, so bounds are now
 * a straight passthrough and this function does no geometry math of its own.
 */
export function createClosedWindowEntry(
  params: Record<string, unknown>,
  modeEntry: ClosedWindowModeEntry | null,
  captured: CapturedCloseBounds,
  source: string,
  trail?: NavHistorySnapshot | null,
): ClosedWindowEntry | null {
  const address = params.address as string | undefined;
  const role = params.role as string | undefined;
  const isKeepLive = params.keepLive === true;
  const isModal = params.modal === true;
  const isWebUrl = address && (address.startsWith('http://') || address.startsWith('https://'));
  const isPeekUrl = address && address.startsWith('peek://');
  const isBackgroundPage = address && address.includes('background.html');
  const isReopenable = (isWebUrl || (isPeekUrl && !isBackgroundPage)) && !!address;
  const isContentRole = !role || role === 'content' || role === 'child-content' || role === 'workspace';

  if (!isReopenable || !isContentRole || isKeepLive || isModal) {
    return null;
  }

  // Check for space mode context
  let spaceMode: ClosedWindowEntry['spaceMode'] = null;
  if (modeEntry && modeEntry.value === 'space' && modeEntry.metadata) {
    spaceMode = {
      spaceId: modeEntry.metadata.spaceId as string,
      spaceName: modeEntry.metadata.spaceName as string,
      color: modeEntry.metadata.color as string | undefined,
    };
  }

  const saveBounds = closedWindowSaveBounds(captured.presentation, captured.bounds);

  // Use the current navigated URL if available (tracks where user actually was)
  const currentUrl = params.currentUrl as string | undefined;
  const scrollX = params.scrollX as number | undefined;
  const scrollY = params.scrollY as number | undefined;

  return {
    url: currentUrl || address!,
    originalUrl: currentUrl ? address : undefined,
    source,
    bounds: saveBounds,
    spaceMode,
    role: role || undefined,
    scrollX: scrollX || undefined,
    scrollY: scrollY || undefined,
    // Spread only when a trail exists, so an entry without one carries no
    // explicit `undefined` keys into the persisted JSON.
    ...(trail
      ? { navHistory: trail.navHistory, navHistoryIndex: trail.navHistoryIndex }
      : {}),
    timestamp: Date.now(),
  };
}
