/**
 * Session Snapshot — Save/Restore window state
 *
 * Captures all visible user windows and writes to feature_settings using
 * synchronous better-sqlite3 APIs (safe for before-quit handler). On startup,
 * reads the snapshot and recreates windows. Periodic autosave timer + manual
 * save/restore commands; crash recovery dialog with snapshot validation.
 *
 * NOTE: Pure logic shared copy lives in app/lib/session.js for frontend/Tauri use.
 */

import { BrowserWindow, dialog, screen, ipcMain } from 'electron';
import type { IpcMainEvent } from 'electron';
import { getAllLiveWindows, getLiveWindow } from './window-registry.js';
import type { WindowContext, WindowDescriptor } from './window-registry.js';
import { getFocusOrder, getFrontWindowId, getWindowIdFor, getNativeWindowFor, dispatchWindowEvent } from './window-state-singleton.js';
import type { WindowId } from './window-state.js';
import { getDb, getContextEntry, addContextEntry } from './datastore.js';
import { getAllWindows, getBackgroundWindow, pushClosedWindow, suppressClosedWindowPush } from './main.js';
import type { ClosedWindowEntry } from './main.js';
import { getRegisteredTileIds } from './protocol.js';
import { getWindowPresentation } from './window-presenter.js';
import { getHybridWindow, getHybridWindowByContentWC } from './hybrid-page-host-registry.js';
import { shouldSkipWindowForSaveEarly } from './session-save-filter.js';
import { invokeWindowOpen } from './ipc.js';
import { getIzuiCoordinator } from './izui-state.js';
import { shouldActivateFocusedOnRestore } from './izui-roles.js';
import { WEB_CORE_ADDRESS } from './config.js';

import { publish, getSystemAddress } from './pubsub.js';
import { DEBUG, isTestProfile, isHeadless } from './config.js';
import { showWindowHeadlessSafe, showHybridHost } from './windows.js';

export type { WindowContext, WindowDescriptor };

// Staged session restore: the first N windows (by focus-recency = zOrder desc,
// with the saved-focused window hoisted to the front) restore EAGERLY — their
// <webview> navigates and loads content immediately, as before. Every window
// beyond N restores DEFERRED: the canvas page-host + window are created (so the
// window is present and save-safe), but the <webview> is NOT navigated. The
// deferred host shows a cheap static placeholder (title + URL + favicon) and
// does zero content compositing until the user first focuses it, at which point
// it navigates to the real URL (navigate-on-focus, wired in ipc.ts).
//
// Why: sustained restore GPU/WindowServer load is dominated by COMPOSITING the
// loaded content of many full-screen webviews — window/canvas creation itself
// is cheap. Deferring content on stale windows cuts sustained GPU ~10-20x while
// keeping every window in place. Measured on the cpu-perf harness.
//
// Tuneable at the code layer only (no UI/pref): bump this constant to keep more
// windows hot at boot. Recency signal is the existing zOrder sort, which now
// holds a focus-recency rank (see focus-order.ts) rather than creation/stacking
// order.
const SESSION_EAGER_RESTORE_COUNT = 5;

// ============================================================================
// Restore-complete flag (mid-restore corruption guard)
//
// Problem: Cmd+Q (or any before-quit / autosave trigger) during the restore
// loop can fire while restored windows still have empty URLs (webContents
// hasn't called loadURL yet). Writing that state as the new snapshot erases
// the user's session — all 35 windows come back with url="" on next launch.
//
// Solution: a module-level boolean that flips to `true` only after
// restoreSessionSnapshot() completes. saveSessionSnapshot() is a no-op while
// the flag is false (logs a warn so the refusal appears in main.log). Also
// applied: empty-URL filter (belt-and-suspenders) strips windows whose
// getURL() is still "" even after restore completes.
//
// Shadow-snapshotting (.partial file that promotes on completion) was
// considered and deferred — these two guards address the failure mode more
// simply with no extra I/O surface.
// ============================================================================

/**
 * True once restoreSessionSnapshot() has finished (success or failure).
 * All production save calls are no-ops until this flips. Prevents a
 * mid-restore Cmd+Q from overwriting the good snapshot with empty-URL garbage.
 * Starts as true so saves work on fresh launch (no restore in flight).
 */
let _restoreComplete = true;

/**
 * Mark restore as in-flight. Called at the top of restoreSessionSnapshot so
 * any save triggered by a Cmd+Q during the loop is rejected.
 */
export function markRestoreInFlight(): void {
  _restoreComplete = false;
}

/**
 * Mark restore as complete. Called at the bottom of restoreSessionSnapshot
 * (regardless of success/failure) so saves can proceed normally.
 */
export function markRestoreComplete(): void {
  _restoreComplete = true;
}

/**
 * Test-only override: set the restore-complete flag to an arbitrary value
 * so tests can simulate mid-restore or post-restore save behavior.
 */
export function setRestoreCompleteForTest(value: boolean): void {
  _restoreComplete = value;
}

// Drift-detection counters for restoreSessionSnapshot. The fix in 853cc48f
// gates .show()/.focus() on isAppFocused() at restore time so a user who
// switched away mid-restore isn't yanked back. The bug class — focus
// stealing from an unconditional .show()/.focus() in the restore loop —
// silently regresses if someone re-introduces those calls without the
// guard. Tests in tests/desktop/session-restore-focus.spec.ts read these
// counters via __peek_test.getRestoreFocusCounters() to assert the gate
// holds. Counters are reset at the top of restoreSessionSnapshot.
let _restoreShowCount = 0;
let _restoreShowInactiveCount = 0;
let _restoreFocusCount = 0;
// `stackDrives` (formerly `moveTops`): how many restored windows the post-loop
// focus block submitted to the window-state machine's saved-order import
// (STACK_ORDER_IMPORTED — the §5 step 5 part B replacement for the deleted
// direct reverse-moveTop walk). 0 when the willActivate gate suppressed the
// restack (switched-away user / headless); === restored count on the happy path.
let _restoreStackDriveCount = 0;
// `hybridActivations`: number of restored HYBRID page-host windows the restore
// loop's focus block activated (raised + made first responder via an activating
// showHybridHost). It must be 0 or 1 — exactly the number of focused
// descriptors. The wrong-focus-on-restart regression was every restored hybrid
// window activating itself at open time (showHybridHost ignored `show:false`),
// so the page the user left focused was not the one raised. With the fix,
// restore opens are inactive and ONLY the focused descriptor is re-activated
// here — so this counter pins the activation to exactly that one window.
// `restoreFocusedId`: the live window id of the window the restore focus block
// raised (BrowserWindow OR hybrid), so an identity test can assert it matches
// the focused descriptor's restored window — not just that *a* focus happened.
let _restoreHybridActivationCount = 0;
let _restoreFocusedId: number | null = null;
// Cold-start z-order fix wiring (see the `hybrid:first-frame` producer below).
// `pageHosts`: restored hybrid page-hosts the willActivate block registered for
// first-frame tracking. `firstFrameReasserts`: how many of those reported their
// first composited frame (the private `hybrid:first-frame` IPC) and drove the
// machine's ordered re-drive (WINDOW_CONTENT_ORDERABLE → SET_STACKING for the
// window + everything above it). firstFrameReasserts === pageHosts means every
// page-host composited and re-drove the saved order — the deterministic signal
// the cold-start spec asserts. NOTE: whether each native raise then STICKS is
// gated by macOS window-server orderability (a frontmost app only), which
// Playwright cannot make true, so the actual on-screen stack is proven manually
// (apps/desktop/tests/helpers/restore-proof/run-real-coldstart.sh), not here.
let _restorePageHostCount = 0;
let _restoreFirstFrameReassertCount = 0;
// Page-hosts from the CURRENT restore still awaiting their first composited
// frame — counter bookkeeping only (dedup for firstFrameReasserts); the
// machine's WINDOW_CONTENT_ORDERABLE clause is the behavior and is inert on
// re-fires by itself.
const _restorePendingFirstFrameIds = new Set<number>();
export function getRestoreFocusCounters(): {
  shows: number;
  showInactives: number;
  focuses: number;
  stackDrives: number;
  hybridActivations: number;
  focusedId: number | null;
  pageHosts: number;
  firstFrameReasserts: number;
} {
  return {
    shows: _restoreShowCount,
    showInactives: _restoreShowInactiveCount,
    focuses: _restoreFocusCount,
    stackDrives: _restoreStackDriveCount,
    hybridActivations: _restoreHybridActivationCount,
    focusedId: _restoreFocusedId,
    pageHosts: _restorePageHostCount,
    firstFrameReasserts: _restoreFirstFrameReassertCount,
  };
}
export function resetRestoreFocusCounters(): void {
  _restoreShowCount = 0;
  _restoreShowInactiveCount = 0;
  _restoreFocusCount = 0;
  _restoreStackDriveCount = 0;
  _restoreHybridActivationCount = 0;
  _restoreFocusedId = null;
  _restorePageHostCount = 0;
  _restoreFirstFrameReassertCount = 0;
  _restorePendingFirstFrameIds.clear();
}

// ----------------------------------------------------------------------------
// The `hybrid:first-frame` boundary signal → WINDOW_CONTENT_ORDERABLE producer.
//
// WHY THIS EXISTS: a hybrid page-host is a BaseWindow whose content
// WebContentsView's NSWindow is not orderable in the macOS window server —
// a relative raise is a window-server no-op — until its content compositor has
// produced a SETTLED FRAME. This is later than `isVisible()` (true right after
// `showInactive()`), and later than `dom-ready`/`did-finish-load`/
// `did-stop-loading` (all load-lifecycle, not compositor-frame). Each page-host
// reports its FIRST COMPOSITED FRAME exactly once per preload run via the
// private `hybrid:first-frame` IPC (double-rAF in runtime-external-preload.cjs).
// This listener is the PRODUCER of the machine's `WINDOW_CONTENT_ORDERABLE`
// event (§5 step 5 part B): the reducer marks the record orderable and re-drives
// SET_STACKING for the window and everything stacked above it, converging native
// order onto the machine's `stackOrder` as each page-host composites — keyed on
// a real per-window lifecycle transition, never a settle timer. (Replaces the
// restore-scoped `reassertStackingOrder` moveTop walk; a stray late re-fire —
// a surviving page-host re-navigating re-runs its preload — is structurally
// inert in the reducer, which was the old listener's disarm.)
//
// Installed once at boot from entry.ts, BEFORE any page-host can load.
let _firstFrameProducerInstalled = false;
export function installFirstFrameOrderableProducer(): void {
  if (_firstFrameProducerInstalled) return;
  _firstFrameProducerInstalled = true;
  ipcMain.on('hybrid:first-frame', (event: IpcMainEvent) => {
    const entry = getHybridWindowByContentWC(event.sender);
    if (!entry) return;
    const machineId = getWindowIdFor(entry.windowId);
    if (machineId != null) {
      dispatchWindowEvent({ type: 'WINDOW_CONTENT_ORDERABLE', id: machineId });
    }
    // Restore-spec bookkeeping only (see the counter block above).
    if (_restorePendingFirstFrameIds.delete(entry.windowId)) {
      _restoreFirstFrameReassertCount++;
    }
  });
}

// ----------------------------------------------------------------------------
// Cold-start trailing-dance re-assert latch (one-shot).
//
// Bulletproofing for the cold-start activation: the post-loop focused-descriptor
// block raises+activates the saved-focused window, but it is possible the macOS
// startup activation dance fires a FINAL `did-resign-active` AFTER that block
// runs, re-stranding Peek in the background (previous app keeps the menubar).
// To cover that, a cold-start restore that wanted to activate the focused
// descriptor (non-headless) ARMS a one-shot latch here. main.ts's existing
// `did-become-active` handler calls `reassertColdStartFocusOnce()` on the FIRST
// activation after restore — which re-runs the ACTIVATION (focus/showHybridHost)
// for the saved focused window EXACTLY ONCE, then disarms. The raise/order half
// is the machine's: APP_ACTIVATED's closing assertion re-drives the front.
//
// FSM-pilled: no timer. The latch is driven by the real `did-become-active`
// lifecycle event, fires at most once, is gated cold-start + non-headless, and
// no-ops if the focused window is gone (isDestroyed guard).
let _coldStartReassertArmed = false;
let _coldStartReassertId: number | null = null;

/** Disarm the cold-start re-assert latch (called on use and on reset). */
function disarmColdStartReassert(): void {
  _coldStartReassertArmed = false;
  _coldStartReassertId = null;
}

/**
 * Re-assert the cold-start focused descriptor ONCE, if armed.
 *
 * Called by main.ts's `did-become-active` handler. If a cold-start restore
 * activated the saved-focused window and the startup dance then fired a trailing
 * `did-resign-active` (re-stranding Peek), this re-runs the activation for
 * the saved focused window on the FIRST subsequent activation, then disarms.
 *
 * Self-disarming + no-op when not armed, when the window is gone (isDestroyed),
 * or under headless. Safe to call on every `did-become-active`. Returns true iff
 * it actually re-raised a window (for logging/tests).
 */
export function reassertColdStartFocusOnce(): boolean {
  if (!_coldStartReassertArmed) return false;
  const id = _coldStartReassertId;
  // Disarm FIRST so this fires at most once regardless of what follows.
  disarmColdStartReassert();
  if (id == null) return false;
  if (isHeadless()) return false;
  // NOTE: this latch is FOCUS-ONLY now (§5 step 5 part B). The raise/order
  // half of the old moveTop+activate pair is subsumed by the machine: the
  // trailing did-resign-active dispatched APP_RESIGNED (assertion invalidated),
  // and the did-become-active that calls this dispatches APP_ACTIVATED, whose
  // closing assertion re-drives RAISE_WINDOW [+FOCUS_CONTENT] + SET_STACKING
  // for the front window. What the machine does NOT own yet is the focus()
  // / showHybridHost() activation below (focus is §5 step 8) — that half keeps
  // its one-shot latch semantics here.
  try {
    const focusWin = getLiveWindow(id);
    if (focusWin && !focusWin.isDestroyed()) {
      focusWin.focus();
      console.log(`[session] cold-start re-assert focused window ${id} on did-become-active`);
      return true;
    }
    const hybridFocus = getHybridWindow(id);
    if (hybridFocus && !hybridFocus.baseWin.isDestroyed()) {
      showHybridHost(hybridFocus.baseWin, hybridFocus.contentWC);
      console.log(`[session] cold-start re-assert activated focused hybrid ${id} on did-become-active`);
      return true;
    }
  } catch {
    // Best-effort re-assert.
  }
  return false;
}

export interface SessionMetadata {
  lastSaveReason: string;
  lastSaveAt: number;
  windowCount: number;
  cleanShutdown: boolean;
  crashCount: number;
  lastRestoreAt?: number;
  restoreCount?: number;
}

export interface SessionSnapshot {
  version: 1;
  createdAt: number;
  reason: 'before-quit' | 'autosave' | 'manual' | 'window-close' | 'window-lifecycle';
  windows: WindowDescriptor[];
}

/**
 * Mirror a Placement intent into flat primitive fields that survive
 * `sanitizeParams` and the IPC boundary, so the window-open handler can
 * re-derive `Placement` on restore against the current display layout
 * instead of pinning to stale absolute coordinates.
 *
 * Persistence shape (per docs/window-placement.md §"Persistence"):
 *   - placementMode: 'centered' | 'edge' | 'proportional' | 'parent-centered'
 *   - placementEdge: 'top' | 'bottom' | 'left' | 'right'  (mode='edge')
 *   - placementRelX, placementRelY: numbers in [0, 1]    (mode='proportional')
 *
 * Legacy `center: true` / `screenEdge` flags are also written for backward
 * compatibility with snapshots restored by older code; new restores
 * prefer the typed `placementMode` field. `parent-centered` is mirrored as
 * `centered` since `parentId` doesn't survive a restart anyway.
 */
export function mirrorPlacementIntent(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const placement = params.placement as
    | { mode?: string; edge?: string; relX?: number; relY?: number }
    | undefined;
  const out: Record<string, unknown> = { ...params };
  if (!placement?.mode) return out;

  switch (placement.mode) {
    case 'centered':
      out.placementMode = 'centered';
      out.center = true;
      break;
    case 'parent-centered':
      // parentId can't survive restart; degrade to centered.
      out.placementMode = 'centered';
      out.center = true;
      break;
    case 'edge':
      if (typeof placement.edge === 'string') {
        out.placementMode = 'edge';
        out.placementEdge = placement.edge;
        out.screenEdge = placement.edge;
      }
      break;
    case 'proportional':
      out.placementMode = 'proportional';
      if (typeof placement.relX === 'number') out.placementRelX = placement.relX;
      if (typeof placement.relY === 'number') out.placementRelY = placement.relY;
      break;
  }
  return out;
}

/**
 * Single-display restore policy: rewrite bounds + drop placement intent for
 * any saved window whose center isn't on the current primary display.
 *
 * Why: we don't (yet) try to remember multi-display layouts. After a topology
 * change between save and restore — display added, removed, or just re-ordered
 * — windows whose saved coords land on a non-primary display would otherwise
 * stay on that display, splitting the user's session across screens. This
 * function collapses everything onto primary at restore time, preserving
 * window size (clamped to fit) and centering inside primary's workArea.
 *
 * Returns a new descriptor when rewriting; returns the input untouched when
 * the saved center is already on primary. `center: true` intent is cleared on
 * rewrite so the explicit bounds reach `buildRestoreBoundsOptions` (and the
 * window lands at our re-centered coords on primary). `screenEdge` intent is
 * preserved — an edge-anchored slide should re-anchor to that edge of the new
 * primary, not float at the rewritten coords.
 *
 * Pure: takes the primary workArea as a parameter so it's unit-testable
 * without Electron's `screen` module.
 */
export function collapseToPrimaryDisplay(
  descriptor: { bounds: Electron.Rectangle; params: Record<string, unknown> },
  primaryWorkArea: Electron.Rectangle,
): { bounds: Electron.Rectangle; params: Record<string, unknown> } {
  const cx = descriptor.bounds.x + Math.round(descriptor.bounds.width / 2);
  const cy = descriptor.bounds.y + Math.round(descriptor.bounds.height / 2);
  const onPrimary =
    cx >= primaryWorkArea.x && cx < primaryWorkArea.x + primaryWorkArea.width &&
    cy >= primaryWorkArea.y && cy < primaryWorkArea.y + primaryWorkArea.height;
  if (onPrimary) return descriptor;

  const w = Math.min(descriptor.bounds.width, primaryWorkArea.width);
  const h = Math.min(descriptor.bounds.height, primaryWorkArea.height);
  const newBounds: Electron.Rectangle = {
    x: primaryWorkArea.x + Math.round((primaryWorkArea.width - w) / 2),
    y: primaryWorkArea.y + Math.round((primaryWorkArea.height - h) / 2),
    width: w,
    height: h,
  };
  const newParams = { ...descriptor.params };
  // Clear `center` intent so the rewritten x/y is what window-open uses
  // rather than computePlacement re-deriving against the cursor display.
  // Preserve `screenEdge` — edge-anchored slides should re-anchor to that
  // edge of the (new) primary display via the window-open re-derivation.
  delete newParams.center;
  return { bounds: newBounds, params: newParams };
}

/**
 * Build the x/y/w/h options the restore path passes to window-open.
 *
 * If the descriptor declares a non-manual placement intent (`center: true`
 * or `screenEdge` set), drop x/y so window-open re-derives placement on the
 * current display layout. Otherwise behave as before: pass saved x/y when
 * the saved center point lands on an active display, drop them when it
 * doesn't (off-screen safety net for old snapshots).
 *
 * Pure: callers inject `isPointOnScreen` so this can be unit-tested without
 * Electron's `screen` module.
 */
export function buildRestoreBoundsOptions(
  descriptor: { bounds: { x: number; y: number; width: number; height: number }; params: Record<string, unknown> },
  isPointOnScreen: (x: number, y: number) => boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    width: descriptor.bounds.width,
    height: descriptor.bounds.height,
  };
  const hasCenterIntent = descriptor.params.center === true;
  const hasEdgeIntent = typeof descriptor.params.screenEdge === 'string';
  const hasNonManualIntent = hasCenterIntent || hasEdgeIntent;
  if (hasNonManualIntent) return out;

  const centerX = descriptor.bounds.x + Math.round(descriptor.bounds.width / 2);
  const centerY = descriptor.bounds.y + Math.round(descriptor.bounds.height / 2);
  if (isPointOnScreen(centerX, centerY)) {
    out.x = descriptor.bounds.x;
    out.y = descriptor.bounds.y;
  }
  return out;
}

/**
 * Sanitize params to only include serializable values.
 * Mirrors the logic in ipc.ts window-list handler.
 *
 * Also strips devtools-open flags (`openDevTools`, `detachedDevTools`) so a
 * window the user happened to have devtools open on at quit time doesn't
 * auto-reopen devtools on restore. Devtools state is intentionally not
 * persisted — it's a transient diagnostic surface.
 */
function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === 'openDevTools' || key === 'detachedDevTools') continue;
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
 * Save a snapshot of all visible user windows to the datastore.
 *
 * MUST be synchronous — runs in the before-quit handler before closeDatabase().
 * Uses better-sqlite3 synchronous APIs via getDb().
 */
export function saveSessionSnapshot(reason: SessionSnapshot['reason'], opts?: { cleanShutdown?: boolean; _forceForTest?: boolean }): void {
  // Skip save in test environments unless _forceForTest is set (used by
  // session-restore Playwright specs that drive save+restore directly).
  if (isTestProfile() && !opts?._forceForTest) return;

  // Guard 1: Restore-complete flag.
  // If a restore is in flight (flag=false), any save is a no-op. The snapshot
  // written mid-restore would contain windows whose webContents.getURL() is
  // still "" because loadURL hasn't resolved yet — effectively wiping the
  // user's session. The flag flips true at the end of restoreSessionSnapshot()
  // regardless of success/failure. _forceForTest bypasses this for Playwright
  // specs that need direct save control.
  if (!_restoreComplete && !opts?._forceForTest) {
    console.warn(`[session] Refusing to save snapshot (reason: ${reason}): restore still in flight. Snapshot preserved.`);
    return;
  }

  DEBUG && console.log(`[session] Saving session snapshot (reason: ${reason})`);

  let db;
  try {
    db = getDb();
  } catch {
    // Database not initialized or already closed
    DEBUG && console.log('[session] Database not available, skipping session save');
    return;
  }

  const registeredWindows = getAllWindows();
  const windowDescriptors: WindowDescriptor[] = [];

  // Collect all "hidden by overlay" window IDs across the registry. When
  // an overlay (Windows switcher, etc.) is open at quit time, the IZUI
  // coordinator has hidden every other window via win.hide() — so they
  // report !isVisible() in the loop below. Without this carve-out the
  // !isVisible() skip drops them from the snapshot, and quitting with
  // an overlay open silently loses every other window. The overlay
  // tracks the IDs in info.params.overlayHiddenWindows; gather them all
  // here so the loop's visibility check can let them through.
  const overlayHiddenIds = new Set<number>();
  for (const [, winData] of registeredWindows) {
    const ids = winData.params.overlayHiddenWindows;
    if (Array.isArray(ids)) {
      for (const hid of ids) {
        if (typeof hid === 'number') overlayHiddenIds.add(hid);
      }
    }
  }

  // The "focused" descriptor drives restore's head-start: that window
  // dispatches first and the rest pause briefly while it reaches dom-ready.
  // Use the persistent focus tracker (last visible content window the user
  // actually focused) rather than `win.isFocused()` at this instant. Save
  // can fire mid-shutdown, with a transient overlay focused, or after the
  // user has switched away — all of which leave `win.isFocused()` pointing
  // at the wrong window (or nothing), and the head-start ends up firing on
  // some unrelated window that just happens to be first in iteration
  // order. The machine's `front` excludes modals/overlays/bg (satellites) and
  // survives focus shifts to other apps, so it captures user intent.
  // The machine speaks WM WindowId; the descriptor loop below is keyed by
  // Electron window ids (the registries' key space), so resolve the front's
  // native handle and compare on ITS id.
  const front = getFrontWindowId();
  const frontWin = front != null ? getNativeWindowFor(front) : null;
  const lastFocusedId = frontWin ? frontWin.id : null;

  for (const [id, winData] of registeredWindows) {
    const win = getLiveWindow(id);

    // Hybrid page-hosts are BaseWindows, so `getLiveWindow` (BrowserWindow.fromId)
    // returns null for them. They live in the hybrid registry instead. Detect
    // them up-front so we source visibility/URL from the hybrid registry rather
    // than the (absent) BrowserWindow, then fall through to the same
    // presentation-based descriptor build the canvas path uses (which already
    // handles hybrid's two-layer URL, bounds, maximized, title, visible).
    const hybridEntry =
      winData.params.hybridPageHost === true ? getHybridWindow(id) : null;

    // Resolve the early-skip inputs from whichever window kind this is, then
    // run the shared (unit-tested) decision so the two paths can't drift.
    let earlyDestroyed: boolean;
    let earlyVisible: boolean;
    let earlyUrl: string;
    if (hybridEntry) {
      earlyDestroyed = hybridEntry.baseWin.isDestroyed();
      // A destroyed baseWin's isVisible() throws; guard it.
      earlyVisible = earlyDestroyed ? false : hybridEntry.baseWin.isVisible();
      // A hybrid window is never the background page; its content URL is safe
      // for the background-URL skip (it can never match background.html).
      earlyUrl = earlyDestroyed ? '' : hybridEntry.url();
    } else if (win) {
      earlyDestroyed = false;
      earlyVisible = win.isVisible();
      earlyUrl = win.webContents.getURL();
    } else {
      // Neither a live BrowserWindow nor a hybrid entry — destroyed/unknown.
      earlyDestroyed = true;
      earlyVisible = false;
      earlyUrl = '';
    }

    if (
      shouldSkipWindowForSaveEarly({
        destroyed: earlyDestroyed,
        visible: earlyVisible,
        url: earlyUrl,
        forceForTest: opts?._forceForTest,
        hiddenByActiveOverlay: overlayHiddenIds.has(id),
      })
    ) {
      continue;
    }

    // Skip modal windows
    if (winData.params.modal) {
      continue;
    }

    // Skip non-focusable utility windows (e.g. HUD overlays).
    // These are extension-managed and shouldn't be restored by session.
    // User-facing utility windows (settings, diagnostic, etc.) ARE saved.
    if (winData.params.role === 'utility' && winData.params.focusable === false) {
      continue;
    }

    // Skip overlay-role / overlay-flagged windows. Overlays (Windows
    // switcher, find-bar, peek-card, etc.) are transient UI surfaces
    // that should not auto-restore on launch. Restoring an overlay
    // also activates the IZUI coordinator's hide-others behavior, so
    // users see startup with everything marked hidden and the overlay
    // sitting on top — never the intent.
    if (winData.params.role === 'overlay' || winData.params.overlay === true) {
      DEBUG && console.log(`[session:save] Skipping overlay window ${id}`);
      continue;
    }

    // Use the window presenter for the canonical user-facing snapshot.
    // It encapsulates page-host's two-layer URL shape, canvas bounds, and
    // maximize state — session.ts no longer special-cases any window type.
    const presentation = getWindowPresentation(id);
    if (!presentation) {
      DEBUG && console.log(`[session:save] No presentation for window ${id}, skipping`);
      continue;
    }
    const realUrl = presentation.address;
    const windowBounds = presentation.bounds;
    const canvasMaximized = presentation.maximized;

    // Skip windows for unknown tiles (stale from renames/removals)
    const extMatch = realUrl.match(/^peek:\/\/ext\/([^/]+)/);
    if (extMatch) {
      const extId = extMatch[1];
      const knownIds = getRegisteredTileIds();
      if (!knownIds.includes(extId)) {
        DEBUG && console.log(`[session:save] Skipping stale tile window ${id}: ${extId}`);
        continue;
      }
    }

    console.log(`[session:save] Window ${id} "${presentation.title}" bounds: (${windowBounds.x},${windowBounds.y}) ${windowBounds.width}x${windowBounds.height}${canvasMaximized ? " [maximized]" : ""} url=${realUrl.substring(0, 80)}`);

    // Capture context state for this window
    let windowContext: WindowContext | undefined;
    try {
      const modeEntry = getContextEntry('mode', id);
      if (modeEntry) {
        windowContext = {
          mode: modeEntry.value as string,
          modeMetadata: (modeEntry.metadata as Record<string, unknown>) || null,
        };
      }
    } catch {
      // Context not available, skip
    }

    const sanitized = sanitizeParams(mirrorPlacementIntent(winData.params));
    // The pass-through above can carry a STALE `winData.params.maximized`
    // for a hybrid window: it's set once at open time (true only when opened
    // via reopen/session-restore of a maximized window) and never updated by
    // page:maximize/page:unmaximize afterward (those update the hybrid
    // registry, not the general window-registry params). `presentation.
    // maximized` is always live, so it — not the pass-through — is
    // authoritative here; explicitly set both branches rather than only
    // adding the true case.
    if (canvasMaximized) {
      sanitized.maximized = true;
      // Pre-maximize bounds ride along as flat primitives (mirroring the old
      // canvas info.params.preMaxX/Y/Width/Height convention) so they survive
      // sanitizeParams and are available on restore to seed the hybrid
      // registry — letting an unmaximize after restore land back at the
      // original pre-maximize size instead of the maximized work-area rect.
      if (presentation.preMaxBounds) {
        sanitized.preMaxX = presentation.preMaxBounds.x;
        sanitized.preMaxY = presentation.preMaxBounds.y;
        sanitized.preMaxWidth = presentation.preMaxBounds.width;
        sanitized.preMaxHeight = presentation.preMaxBounds.height;
      }
    } else {
      delete sanitized.maximized;
      delete sanitized.preMaxX;
      delete sanitized.preMaxY;
      delete sanitized.preMaxWidth;
      delete sanitized.preMaxHeight;
    }

    windowDescriptors.push({
      url: realUrl,
      key: (winData.params.key as string) || undefined,
      title: presentation.title,
      bounds: windowBounds,
      source: winData.source,
      params: sanitized,
      // getFocusOrder is machine-keyed (WM WindowId); `id` is the registry's
      // Electron id — convert through the sanctioned mapping. Unregistered
      // windows rank 0, same as the machine's own "never focused" answer.
      zOrder: (() => {
        const machineId = getWindowIdFor(id);
        return machineId != null ? getFocusOrder(machineId) : 0;
      })(),
      focused: lastFocusedId != null && id === lastFocusedId,
      context: windowContext,
    });
  }

  // Guard 2: Empty-URL filter (belt-and-suspenders).
  // Even when restore is complete, a window may legitimately have an empty URL
  // for a brief moment (e.g., created but not yet navigated). Strip those so
  // they never reach the on-disk snapshot. Log each filtered window so the
  // decision is visible in main.log without re-instrumenting.
  const preFilterCount = windowDescriptors.length;
  const filteredDescriptors = windowDescriptors.filter((d) => {
    const url = d.url;
    if (!url || url.trim() === '' || url === 'about:blank' || url === 'about:newtab') {
      console.warn(`[session:guard] Filtering window with empty/blank URL from snapshot (reason: ${reason})`);
      return false;
    }
    return true;
  });
  if (filteredDescriptors.length < preFilterCount) {
    const dropped = preFilterCount - filteredDescriptors.length;
    console.warn(`[session:guard] Dropped ${dropped} window(s) with empty/blank URLs from snapshot (reason: ${reason})`);
  }

  const snapshot: SessionSnapshot = {
    version: 1,
    createdAt: Date.now(),
    reason,
    windows: filteredDescriptors,
  };

  DEBUG && console.log(`[session] Captured ${filteredDescriptors.length} window(s) (${preFilterCount - filteredDescriptors.length} filtered)`);

  try {
    // Write snapshot to feature_settings table
    db.prepare(`
      INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
      VALUES (?, 'session', 'snapshot', ?, ?)
    `).run('session-snapshot', JSON.stringify(snapshot), Date.now());

    // Read existing metadata to preserve crashCount and restoreCount
    let existingMetadata: Partial<SessionMetadata> = {};
    try {
      const metaRow = db.prepare(
        `SELECT value FROM feature_settings WHERE featureId = 'session' AND key = 'metadata'`
      ).get() as { value: string } | undefined;
      if (metaRow?.value) {
        existingMetadata = JSON.parse(metaRow.value);
      }
    } catch {
      // No existing metadata
    }

    // Write metadata with cleanShutdown flag
    // Default to true (normal quit), but SIGINT/SIGTERM pass false
    // so the user gets the crash recovery prompt on next startup.
    const metadata: SessionMetadata = {
      lastSaveReason: reason,
      lastSaveAt: Date.now(),
      windowCount: windowDescriptors.length,
      cleanShutdown: opts?.cleanShutdown !== false,
      crashCount: existingMetadata.crashCount ?? 0,
      lastRestoreAt: existingMetadata.lastRestoreAt,
      restoreCount: existingMetadata.restoreCount,
    };
    db.prepare(`
      INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
      VALUES (?, 'session', 'metadata', ?, ?)
    `).run('session-metadata', JSON.stringify(metadata), Date.now());

    DEBUG && console.log(`[session] Session snapshot saved successfully`);

    // Push all currently open content windows onto the closed window stack
    // so they can be recovered via undo-close-window if session restore fails.
    // Push web URLs (http/https) and peek:// URLs (ext/app pages, not background).
    // Same filtering as the closed handler in main.ts.
    // Also suppress the per-window 'closed' event push to prevent double entries.
    if (reason === 'before-quit') {
      suppressClosedWindowPush();
      for (const descriptor of windowDescriptors) {
        const isWebUrl = descriptor.url.startsWith('http://') || descriptor.url.startsWith('https://');
        const isPeekUrl = descriptor.url.startsWith('peek://');
        const isBackgroundPage = descriptor.url.includes('background.html');
        const isReopenable = isWebUrl || (isPeekUrl && !isBackgroundPage);
        if (!isReopenable) continue;

        // Check for space mode in context
        let spaceMode: ClosedWindowEntry['spaceMode'] = null;
        if (descriptor.context?.mode === 'space' && descriptor.context.modeMetadata) {
          spaceMode = {
            spaceId: descriptor.context.modeMetadata.spaceId as string,
            spaceName: descriptor.context.modeMetadata.spaceName as string,
            color: descriptor.context.modeMetadata.color as string | undefined,
          };
        }

        // Use the current navigated URL if available (tracks where user actually was)
        const currentUrl = descriptor.params.currentUrl as string | undefined;
        const scrollX = descriptor.params.scrollX as number | undefined;
        const scrollY = descriptor.params.scrollY as number | undefined;

        pushClosedWindow({
          url: currentUrl || descriptor.url,
          originalUrl: currentUrl ? descriptor.url : undefined,
          source: descriptor.source,
          bounds: descriptor.bounds,
          spaceMode,
          role: (descriptor.params.role as string) || undefined,
          scrollX: scrollX || undefined,
          scrollY: scrollY || undefined,
          timestamp: Date.now(),
        });
      }
      DEBUG && console.log(`[session] Pushed ${windowDescriptors.filter(d => {
        const isWeb = d.url.startsWith('http://') || d.url.startsWith('https://');
        const isPeek = d.url.startsWith('peek://');
        const isBg = d.url.includes('background.html');
        return isWeb || (isPeek && !isBg);
      }).length} open window(s) to closed window stack`);
    }

    // Also save per-space workspace snapshots (for space layout restore)
    saveSpaceWorkspaces();
  } catch (error) {
    console.error('[session] Failed to save session snapshot:', error);
  }
}

/**
 * Mark session as dirty (not cleanly shut down).
 * Called on app startup before restore, so if the app crashes
 * before the next save, we know it wasn't clean.
 */
export function markSessionDirty(): void {
  if (isTestProfile()) return;

  let db;
  try {
    db = getDb();
  } catch {
    return;
  }

  try {
    const metaRow = db.prepare(
      `SELECT value FROM feature_settings WHERE featureId = 'session' AND key = 'metadata'`
    ).get() as { value: string } | undefined;

    let metadata: Partial<SessionMetadata> = {};
    if (metaRow?.value) {
      metadata = JSON.parse(metaRow.value);
    }

    // If previous session was not clean, increment crash count
    if (metadata.cleanShutdown === false) {
      metadata.crashCount = (metadata.crashCount ?? 0) + 1;
      DEBUG && console.log(`[session] Detected unclean shutdown, crash count: ${metadata.crashCount}`);
    }

    // Mark current session as dirty
    metadata.cleanShutdown = false;

    db.prepare(`
      INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
      VALUES (?, 'session', 'metadata', ?, ?)
    `).run('session-metadata', JSON.stringify(metadata), Date.now());

    DEBUG && console.log('[session] Marked session as dirty');
  } catch (error) {
    console.error('[session] Failed to mark session dirty:', error);
  }
}

/**
 * Validate that a window descriptor has the required fields for restore.
 * Returns false if the descriptor is invalid and should be skipped.
 */
function isValidDescriptor(descriptor: WindowDescriptor): boolean {
  // Must have a URL
  if (!descriptor.url || typeof descriptor.url !== 'string' || descriptor.url.trim() === '') {
    return false;
  }

  // Filter out ephemeral loopback/localhost callback URLs (e.g. OAuth callbacks
  // to http://127.0.0.1:{port}/callback). These are short-lived servers that won't
  // exist on restart, so restoring them would show a connection-refused error.
  try {
    const parsed = new URL(descriptor.url);
    if ((parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') &&
        parsed.pathname.includes('/callback')) {
      DEBUG && console.log(`[session] Filtering ephemeral callback URL: ${descriptor.url}`);
      return false;
    }
  } catch {
    // URL parsing failed, continue with other checks
  }

  // Orphan filter: legitimate Peek-saved descriptors only carry peek://,
  // http://, or https:// URLs. Anything else — file://, data:, about:,
  // chrome://, chrome-extension://, javascript:, etc. — indicates a raw
  // BrowserWindow opened before the web-contents-created chokepoint
  // (commit 47ab371d) landed. Those orphans have no UI affordance to close,
  // come back on every restore, and shouldn't have been persistable.
  // Filter them out so one more relaunch clears them permanently. Log with
  // the descriptor shape so users hitting unknown-orphan patterns surface
  // to main.log without re-instrumenting.
  try {
    const parsed = new URL(descriptor.url);
    const allowed = parsed.protocol === 'peek:' || parsed.protocol === 'http:' || parsed.protocol === 'https:';
    if (!allowed) {
      console.log(`[session:orphan] Filtering pre-chokepoint window scheme=${parsed.protocol} url=${descriptor.url.substring(0, 120)} source=${descriptor.source || '(empty)'}`);
      return false;
    }
  } catch {
    // Unparseable URL — also orphan-shaped. Real windows have valid URLs.
    console.log(`[session:orphan] Filtering unparseable URL: ${descriptor.url.substring(0, 120)}`);
    return false;
  }

  // Validate extension URLs reference a known extension
  // (e.g. peek://me:core/... from a renamed extension would be stale)
  let extIdFromUrl: string | null = null;
  try {
    const u = new URL(descriptor.url);
    if (u.protocol === 'peek:') {
      if (u.host === 'ext') {
        // Legacy form: peek://ext/<id>/...
        extIdFromUrl = u.pathname.split('/').filter(Boolean)[0] ?? null;
      } else if (u.host !== 'app') {
        // Canonical tile URL: peek://<id>/...
        extIdFromUrl = u.host;
      }
    }
  } catch { /* unparseable URL */ }
  if (extIdFromUrl) {
    const knownIds = getRegisteredTileIds();
    if (!knownIds.includes(extIdFromUrl)) {
      DEBUG && console.log(`[session] Filtering stale tile window: ${extIdFromUrl}`);
      return false;
    }
  }

  return true;
}

/**
 * Show crash recovery dialog and return whether the user wants to restore.
 * Returns true if restore should proceed, false to start fresh.
 */
async function showCrashRecoveryDialog(crashCount: number): Promise<boolean> {
  // Headless/test runs must never surface a native modal dialog (it steals OS
  // focus on the user's real desktop). Force-restore specs reach here with a
  // live unclean-shutdown DB; default to starting fresh rather than prompting.
  if (isHeadless() || isTestProfile()) {
    return false;
  }
  // Too many crashes — skip restore automatically
  if (crashCount > 3) {
    console.warn(`[session] ${crashCount} consecutive crashes detected. Starting fresh to avoid further issues.`);
    return false;
  }

  // Show dialog asking user what to do
  const result = await dialog.showMessageBox({
    type: 'question',
    title: 'Restore Previous Session?',
    message: "Peek didn't shut down cleanly last time. Would you like to restore your previous session?",
    buttons: ['Restore Session', 'Start Fresh'],
    defaultId: 0,
    cancelId: 1,
  });

  // Button index 0 = "Restore Session", 1 = "Start Fresh"
  return result.response === 0;
}

/**
 * Check if a point falls within any active display.
 */
function isPointOnScreen(x: number, y: number): boolean {
  const displays = screen.getAllDisplays();
  for (const display of displays) {
    const { x: dx, y: dy, width, height } = display.bounds;
    if (x >= dx && x < dx + width && y >= dy && y < dy + height) {
      return true;
    }
  }
  return false;
}

/**
 * Restore session snapshot on startup.
 *
 * Reads the saved snapshot from feature_settings, validates it,
 * and recreates windows using the background window's IPC bridge.
 *
 * Returns counts of restored/failed/total windows.
 */
/**
 * Read session metadata to determine crash state BEFORE markSessionDirty() is called.
 * This captures the true previous shutdown state before it gets overwritten.
 * Returns { cleanShutdown, crashCount } for use by restoreSessionSnapshot.
 */
export function readSessionCrashState(): { cleanShutdown: boolean; crashCount: number } {
  try {
    const db = getDb();
    const metaRow = db.prepare(
      `SELECT value FROM feature_settings WHERE featureId = 'session' AND key = 'metadata'`
    ).get() as { value: string } | undefined;

    if (metaRow?.value) {
      const metadata = JSON.parse(metaRow.value);
      return {
        cleanShutdown: metadata.cleanShutdown !== false, // default to true if missing
        crashCount: metadata.crashCount ?? 0,
      };
    }
  } catch {
    // No metadata available
  }
  return { cleanShutdown: true, crashCount: 0 };
}

export async function restoreSessionSnapshot(
  prefs: Record<string, unknown>,
  crashState?: { cleanShutdown: boolean; crashCount: number },
  _forceForTest?: boolean,
  // COLD START signal — true ONLY for the app's boot restore (entry.ts). Kept
  // SEPARATE from `_forceForTest` (which is true for BOTH in-app
  // forceRestoreSession AND test specs, so it cannot distinguish boot from an
  // in-session restore). At cold start the focused descriptor is activated even
  // if the macOS startup dance transiently flipped appFocused false; in-session
  // restore keeps honoring appFocused so a switched-away user isn't yanked back.
  // See shouldActivateFocusedOnRestore() in izui-roles.ts.
  isColdStart: boolean = false,
): Promise<{ restored: number; failed: number; total: number }> {
  const result = { restored: 0, failed: 0, total: 0 };

  // Reset drift-detection counters for this restore pass. Tests read them
  // afterward to verify the isAppFocused() gate held — see counter
  // declaration above.
  resetRestoreFocusCounters();
  // Clear any stale cold-start re-assert latch from a prior restore; this pass
  // re-arms it only if it activates the focused descriptor at cold start.
  disarmColdStartReassert();

  // Skip restore in test environments unless _forceForTest is set (used by
  // session-restore Playwright specs that drive save+restore directly).
  if (isTestProfile() && !_forceForTest) {
    DEBUG && console.log('[session] Skipping session restore in test profile');
    return result;
  }

  // Check restoreSession pref
  if (prefs.restoreSession === false) {
    DEBUG && console.log('[session] Session restore disabled by pref');
    return result;
  }

  // Mark restore as in-flight. Any saveSessionSnapshot call from this point
  // until markRestoreComplete() (at function exit, via finally) will be rejected
  // to prevent a mid-restore Cmd+Q from writing empty-URL windows as the session
  // snapshot. The try/finally guarantees the flag always flips back to true.
  markRestoreInFlight();

  try {

  let db;
  try {
    db = getDb();
  } catch {
    DEBUG && console.log('[session] Database not available, skipping restore');
    return result;
  }

  // Check crash detection — show dialog or skip restore.
  // Use the pre-read crashState (captured before markSessionDirty) if provided,
  // otherwise fall back to reading current metadata (for manual restore calls).
  try {
    let wasCleanShutdown = true;
    let crashCount = 0;

    if (crashState) {
      // Use pre-read state (startup path — read before markSessionDirty contaminated it)
      wasCleanShutdown = crashState.cleanShutdown;
      crashCount = crashState.crashCount;
    } else {
      // Fallback: read current metadata (manual restore path)
      const metaRow = db.prepare(
        `SELECT value FROM feature_settings WHERE featureId = 'session' AND key = 'metadata'`
      ).get() as { value: string } | undefined;
      if (metaRow?.value) {
        const metadata: Partial<SessionMetadata> = JSON.parse(metaRow.value);
        wasCleanShutdown = metadata.cleanShutdown !== false;
        crashCount = metadata.crashCount ?? 0;
      }
    }

    DEBUG && console.log(`[session] Crash state: wasCleanShutdown=${wasCleanShutdown}, crashCount=${crashCount}`);
    if (!wasCleanShutdown && crashCount > 0) {
      // Only show crash dialog after repeated crashes (crashCount > 0).
      // A single unclean shutdown (e.g. Ctrl+C via yarn, power loss) just
      // silently restores — the crash dialog is for crash loops.
      const shouldRestore = await showCrashRecoveryDialog(crashCount);
      if (!shouldRestore) {
        DEBUG && console.log('[session] User chose to start fresh (or too many crashes)');
        return result;
      }
    }
  } catch {
    // Continue with restore if metadata check fails
  }

  // Read the snapshot
  let snapshot: SessionSnapshot;
  try {
    const row = db.prepare(
      `SELECT value FROM feature_settings WHERE featureId = 'session' AND key = 'snapshot'`
    ).get() as { value: string } | undefined;

    if (!row?.value) {
      DEBUG && console.log('[session] No snapshot found');
      return result;
    }

    snapshot = JSON.parse(row.value);
  } catch (error) {
    console.error('[session] Failed to read snapshot:', error);
    return result;
  }

  // Validate version
  if (snapshot.version !== 1) {
    console.warn(`[session] Unknown snapshot version: ${snapshot.version}`);
    return result;
  }

  // Check if there are windows to restore
  if (!snapshot.windows || snapshot.windows.length === 0) {
    DEBUG && console.log('[session] Snapshot has no windows');
    return result;
  }

  // Validate individual window descriptors — filter out invalid/stale entries
  const validWindows = snapshot.windows.filter((descriptor) => {
    if (!isValidDescriptor(descriptor)) {
      DEBUG && console.log(`[session] Skipping invalid/stale window: ${descriptor.url || '(empty)'}`);
      return false;
    }
    // Defense in depth: drop any overlay-role descriptors that snuck into
    // older snapshots before the save-side filter was added. Restoring an
    // overlay activates the IZUI hide-others behavior and produces a
    // startup with everything hidden behind a transient picker.
    const role = descriptor.params?.role;
    const overlayFlag = (descriptor.params as Record<string, unknown> | undefined)?.overlay;
    if (role === 'overlay' || overlayFlag === true) {
      DEBUG && console.log(`[session] Skipping stale overlay window in snapshot: ${descriptor.url || '(empty)'}`);
      return false;
    }
    return true;
  });

  if (validWindows.length === 0) {
    DEBUG && console.log('[session] No valid windows to restore after validation');
    return result;
  }

  if (validWindows.length < snapshot.windows.length) {
    DEBUG && console.log(`[session] Filtered ${snapshot.windows.length - validWindows.length} invalid window(s)`);
  }

  result.total = validWindows.length;
  DEBUG && console.log(`[session] Restoring ${result.total} window(s) from snapshot`);

  // Wait for background window to be ready (needed for IPC)
  const bgWin = getBackgroundWindow();
  if (!bgWin || bgWin.isDestroyed()) {
    console.error('[session] Background window not available for restore');
    return result;
  }

  // Sort windows by zOrder (higher zOrder = more recently focused; see
  // focus-order.ts). Then hoist the focused window (if any) to position 0 so
  // it dispatches first and gets to spawn in low contention — the rest follow
  // after a short head-start window so the user-visible focused window
  // reaches interactive significantly faster than the rest. See
  // FOCUSED_HEAD_START_MS handling further down.
  const zOrderSorted = [...validWindows].sort((a, b) => b.zOrder - a.zOrder);
  const focusedDescriptor = zOrderSorted.find((w) => w.focused) ?? null;
  const orderedWindows = focusedDescriptor
    ? [focusedDescriptor, ...zOrderSorted.filter((w) => w !== focusedDescriptor)]
    : zOrderSorted;

  // Recency split: index < SESSION_EAGER_RESTORE_COUNT restore eagerly (content
  // loaded); the rest restore deferred (placeholder, navigate-on-focus). The
  // loop reads `i < eagerCount` to set `restoreBlank` per window.
  const eagerCount = Math.min(SESSION_EAGER_RESTORE_COUNT, orderedWindows.length);
  const deferredCount = orderedWindows.length - eagerCount;
  console.log(`[session:perf] staged-restore eager=${eagerCount} deferred=${deferredCount} eager_cap=${SESSION_EAGER_RESTORE_COUNT}`);

  // Track which window was focused for later focus restoration
  let focusedWindowId: number | null = null;
  // Every window we successfully restore + show active. Used to arm the IZUI
  // restore focus guard: the trailing 'focus' events from the NON-focused
  // members of this set must not clobber the focused window we seed below.
  const restoredWindowIds: number[] = [];
  // Subset of restoredWindowIds that are hybrid page-hosts (BaseWindow +
  // WebContentsView). Only these hit the compositing race (see the
  // `hybrid:first-frame` producer at the top of this file): their saved-order
  // raises no-op natively until first composited frame, at which point the
  // producer's WINDOW_CONTENT_ORDERABLE has the machine re-drive them against
  // its imported stack order. Collected here for the restore counters.
  const restoredPageHostIds = new Set<number>();

  // Single-display restore policy: every window goes to the current primary
  // display. Avoids the case where reconnecting/swapping displays between
  // save and restore leaves windows stranded on a now-secondary screen.
  const primaryWorkArea = screen.getPrimaryDisplay().workArea;

  // Always-on timing instrumentation — lands in <userData>/logs/main.log
  // so a real large-session profile can be captured and inspected without
  // a debug build. Format chosen for grep: `[session:perf]` prefix +
  // structured fields. See peek task 1d1331e0.
  const restoreStartedAt = Date.now();
  console.log(`[session:perf] restore-begin n=${orderedWindows.length}`);
  const perWindowTimings: Array<{ url: string; ms: number; ok: boolean }> = [];

  // Focused-window head start. After dispatching the focused window, pause
  // the loop until either (a) its dom-ready fires (renderer is interactive)
  // or (b) FOCUSED_HEAD_START_MS elapses. This lets the user-visible window
  // come up in low contention; the other 30+ windows then race normally.
  // No-op if there is no focused descriptor.
  const FOCUSED_HEAD_START_MS = 400;
  let resolveFocusedDomReady: (() => void) | null = null;
  const focusedDomReadyPromise: Promise<void> = new Promise((resolve) => {
    resolveFocusedDomReady = resolve;
  });

  // Renderer-boot tail tracking. `restore-end` only measures the main-process
  // restore loop (BrowserWindow ctor + fire-and-forget loadURL). The actual
  // user-visible "windows ready" moment is when each restored window's
  // `did-finish-load` (or `did-fail-load`) lands. Always-on so a real-world
  // tail regression is visible in main.log without rebuilding.
  let pendingLoads = 0;
  let finishedLoads = 0;
  let failedLoads = 0;
  let timedOutLoads = 0;
  let loopDone = false;
  let allLoadedEmitted = false;
  const LOAD_TIMEOUT_MS = 30000;
  const checkAllLoaded = () => {
    if (allLoadedEmitted || !loopDone) return;
    if (finishedLoads + failedLoads + timedOutLoads < pendingLoads) return;
    allLoadedEmitted = true;
    const allLoadedMs = Date.now() - restoreStartedAt;
    console.log(`[session:perf] all-loaded ms=${allLoadedMs} n=${pendingLoads} finished=${finishedLoads} failed=${failedLoads} timed_out=${timedOutLoads}`);
  };

  for (let i = 0; i < orderedWindows.length; i++) {
    const original = orderedWindows[i];
    try {
      const descriptor = (() => {
        const collapsed = collapseToPrimaryDisplay(original, primaryWorkArea);
        if (collapsed === original) return original;
        return { ...original, bounds: collapsed.bounds, params: collapsed.params };
      })();
      const boundsOptions = buildRestoreBoundsOptions(descriptor, isPointOnScreen);
      const centerX = descriptor.bounds.x + Math.round(descriptor.bounds.width / 2);
      const centerY = descriptor.bounds.y + Math.round(descriptor.bounds.height / 2);

      console.log(`[session:restore] Window "${descriptor.url.substring(0, 80)}" saved bounds: (${descriptor.bounds.x},${descriptor.bounds.y}) ${descriptor.bounds.width}x${descriptor.bounds.height}, center=(${centerX},${centerY}), onScreen=${isPointOnScreen(centerX, centerY)}, boundsOptions: x=${boundsOptions.x} y=${boundsOptions.y}`);

      // Strip params that would interfere with the window-open handler's own logic.
      // These are internal bookkeeping or context-dependent values that should be
      // re-derived from the URL and current environment during restore:
      // - x/y/width/height: stale positions from original creation (bounds are authoritative)
      // - address: internal bookkeeping param, overwritten by window-open anyway
      // - transient/parentWindowId: session state, not applicable to restored windows
      // Note: role and escapeMode are preserved — they're semantic properties that
      // describe how the window should behave (e.g., ESC handling for extension windows).
      const cleanParams: Record<string, unknown> = {};
      // openDevTools / detachedDevTools: a window the user happened to have
      // devtools open on at quit time should not auto-reopen devtools on
      // restore. Devtools is a transient diagnostic surface, not part of the
      // window's persistent state. Also strips them from snapshots saved
      // before this filter was added on the save side.
      // restoreBlank: the eager/deferred split is re-derived per restore from
      // the window's position in the recency order (`i >= eagerCount` below).
      // A stale restoreBlank baked into an older snapshot's params must not
      // override that — it would pin the window to deferred restore forever.
      const stripKeys = new Set(['x', 'y', 'width', 'height', 'address', 'transient', 'parentWindowId', 'skipTracking', 'openDevTools', 'detachedDevTools', 'restoreBlank']);
      for (const [key, value] of Object.entries(descriptor.params)) {
        if (!stripKeys.has(key)) {
          cleanParams[key] = value;
        }
      }

      // Build options from cleaned params, overlaying bounds
      const options: Record<string, unknown> = {
        ...cleanParams,
        ...boundsOptions,
        // Skip visit tracking — restoring a session is not a new navigation
        skipTracking: true,
        // Restored page-host windows boot without chrome. The page-host
        // renderer queues chrome init (widget host, notes/tags/entities
        // subscriptions, per-navigation chrome work) until the window first
        // gets focus. Saves per-window renderer-boot work across the whole
        // restore set; the focused window inits chrome synchronously on its
        // focus event so it's indistinguishable from a fresh open.
        chrome: false,
        // Don't auto-show in the BrowserWindow ctor — we show it ourselves
        // below with .show() or .showInactive() depending on whether the
        // user is still focused on Peek. On macOS, the ctor's show:true
        // path activates the app, which steals focus from whatever app the
        // user switched to mid-restore.
        show: false,
      };

      // Staged restore: windows beyond the eager set restore DEFERRED. The
      // hybrid branch in ipc.ts reads `restoreBlank`, builds the BaseWindow +
      // WebContentsView + registration + frame state (bounds/maximize) as
      // normal, but leaves the content webContents un-navigated (zero content
      // compositing) until the window's first genuine activation — the host
      // BaseWindow 'focus' event releases the load via the hybrid registry's
      // claimHybridDeferredLoad once-guard. `title` rides along so window
      // listings present the saved title until the content loads. Eager
      // windows (i < eagerCount) load content as before.
      if (i >= eagerCount) {
        options.restoreBlank = true;
        options.title = descriptor.title;
      }

      // Ensure the window key is set for deduplication
      if (descriptor.key) {
        options.key = descriptor.key;
      }

      // Open window via the in-process window-open handler. The handler
      // is the single source of truth for window creation regardless of
      // caller; calling it directly bypasses the two IPC round-trips
      // (main → bgWin → main) that the executeJavaScript path required.
      // The handler reads `ev.sender` to identify the opener — pass the
      // bgWin's webContents so opener resolution still yields the
      // background window (which is the correct semantic opener for
      // session-restored windows on startup).
      DEBUG && console.log(`[session] Opening restored window: ${descriptor.url}`);
      const windowStartedAt = Date.now();
      if (!invokeWindowOpen) {
        console.error('[session] invokeWindowOpen not initialized — registerWindowHandlers() must run before restoreSessionSnapshot');
        result.failed++;
        continue;
      }
      const openResult = await invokeWindowOpen(
        { sender: bgWin.webContents },
        { source: WEB_CORE_ADDRESS, url: descriptor.url, options },
      ) as { success: boolean; id?: number; error?: string };
      const windowMs = Date.now() - windowStartedAt;
      DEBUG && console.log(`[session] Window open result:`, JSON.stringify(openResult));

      const ok = !!(openResult && openResult.success && openResult.id);
      perWindowTimings.push({ url: descriptor.url, ms: windowMs, ok });
      console.log(`[session:perf] window-open ms=${windowMs} ok=${ok} mode=${i < eagerCount ? 'eager' : 'deferred'} url=${descriptor.url.substring(0, 100)}`);

      if (ok) {
        result.restored++;
        if (openResult.id != null) {
          restoredWindowIds.push(openResult.id);
        }

        // Attach did-finish-load / did-fail-load listeners to measure the
        // renderer-boot tail. Listener is attached after invokeWindowOpen
        // returns; loadURL fires async so the events still land here.
        if (openResult.id != null) {
          const restoredId = openResult.id;
          const restoredUrl = descriptor.url;
          const win = getLiveWindow(restoredId);
          if (win && !win.isDestroyed()) {
            // Show now that the window exists. If Peek still has OS-level
            // focus, .show() activates normally; if the user has switched
            // away mid-restore, .showInactive() makes the window visible
            // without yanking the user back to Peek. Both paths use
            // showWindowHeadlessSafe so that headless test runs don't flash
            // windows onto the real display (setOpacity(0) + show/showInactive).
            if (getIzuiCoordinator().isAppFocused()) {
              showWindowHeadlessSafe(win, { active: true });
              _restoreShowCount++;
            } else {
              showWindowHeadlessSafe(win);
              _restoreShowInactiveCount++;
            }

            pendingLoads++;
            let settled = false;
            const handle = (kind: string, incCounter: () => void, extra: string = '') => {
              if (settled) return;
              settled = true;
              incCounter();
              const elapsed = Date.now() - restoreStartedAt;
              console.log(`[session:perf] ${kind} ms=${elapsed} id=${restoredId} url=${restoredUrl.substring(0, 100)}${extra}`);
              checkAllLoaded();
            };
            win.webContents.once('did-finish-load', () => handle('window-loaded', () => { finishedLoads++; }));
            win.webContents.once('did-fail-load', (_e, code, desc) => handle('window-load-failed', () => { failedLoads++; }, ` code=${code} desc=${String(desc).substring(0, 80)}`));
            setTimeout(() => handle('window-load-timeout', () => { timedOutLoads++; }), LOAD_TIMEOUT_MS);
            // NOTE: internal-tile BrowserWindows are orderable the instant they
            // exist, so the post-loop saved-order import places them correctly —
            // they need no re-assertion. Only page-hosts hit the compositing race
            // (the `hybrid:first-frame` → WINDOW_CONTENT_ORDERABLE producer).

            // Earlier-phase markers in main's own timeline. These don't gate
            // all-loaded — they're diagnostic to decompose what's happening
            // between fire-and-forget loadURL and window-loaded:
            //   did-start-loading: navigation actually started in renderer
            //   dom-ready: HTML parsed + preload + page.js synchronous
            //     module evaluation complete; document is interactive
            // Pair with renderer-side [preload:perf] and [page-boot:perf]
            // markers to locate the per-renderer cost.
            win.webContents.once('did-start-loading', () => {
              const elapsed = Date.now() - restoreStartedAt;
              console.log(`[session:perf] window-start-loading ms=${elapsed} id=${restoredId} url=${restoredUrl.substring(0, 100)}`);
            });
            const wasFocused = descriptor.focused === true;
            win.webContents.once('dom-ready', () => {
              const elapsed = Date.now() - restoreStartedAt;
              console.log(`[session:perf] window-dom-ready ms=${elapsed} id=${restoredId} url=${restoredUrl.substring(0, 100)}`);
              if (wasFocused && resolveFocusedDomReady) {
                resolveFocusedDomReady();
                resolveFocusedDomReady = null;
              }
            });
          } else {
            // Hybrid page-hosts are BaseWindows — getLiveWindow returns null for
            // them. The hybrid branch in ipc.ts showed the window INACTIVE during
            // open (restore passes `show:false`, which the hybrid show seam now
            // honors), so it is visible but NOT activated — crucially, a restored
            // NON-focused hybrid window must never activate itself and steal
            // frontmost from the page the user left focused at quit. We do NOT
            // raise/activate here; the post-loop focus block is the SINGLE
            // authority that activates exactly the focused descriptor. Here we
            // only resolve the focused-head-start off the focused window's content
            // wc dom-ready so the loop's head-start pause behaves like the canvas
            // path.
            const hybrid = getHybridWindow(restoredId);
            if (hybrid && !hybrid.baseWin.isDestroyed()) {
              const wasFocused = descriptor.focused === true;
              // This page-host is subject to the compositing race: its NSWindow is
              // not orderable until first paint, so the post-loop saved-order raise
              // is a native no-op for it. Record it for the restore counters; the
              // permanent `hybrid:first-frame` producer has the machine re-drive
              // the saved order when it composites.
              restoredPageHostIds.add(restoredId);
              if (wasFocused && !hybrid.contentWC.isDestroyed()) {
                hybrid.contentWC.once('dom-ready', () => {
                  if (resolveFocusedDomReady) {
                    resolveFocusedDomReady();
                    resolveFocusedDomReady = null;
                  }
                });
              }
            }
          }
        }

        // Restore context (mode, spaceId, spaceName) after window creation
        if (descriptor.context?.mode) {
          try {
            addContextEntry('mode', descriptor.context.mode, {
              windowId: openResult.id,
              source: 'session-restore',
              metadata: descriptor.context.modeMetadata || { url: descriptor.url },
            });
            DEBUG && console.log(`[session] Restored context mode=${descriptor.context.mode} for window ${openResult.id}`);
          } catch (ctxError) {
            DEBUG && console.log('[session] Failed to restore context:', ctxError);
          }
        }

        // Track focused window
        if (descriptor.focused && openResult.id != null) {
          focusedWindowId = openResult.id;
        }
      } else {
        result.failed++;
        DEBUG && console.log(`[session] Failed to restore window: ${descriptor.url}`, openResult?.error);
      }
    } catch (error) {
      result.failed++;
      console.error(`[session] Error restoring window ${original.url}:`, error);
    }

    // After dispatching the focused window (position 0 when one exists),
    // pause until its dom-ready arrives or FOCUSED_HEAD_START_MS elapses
    // — whichever comes first. Lets it spawn in low contention before the
    // rest of the restore set piles in.
    if (i === 0 && focusedDescriptor && orderedWindows.length > 1) {
      const headStartBeganAt = Date.now();
      await Promise.race([
        focusedDomReadyPromise,
        new Promise<void>((resolve) => setTimeout(resolve, FOCUSED_HEAD_START_MS)),
      ]);
      const headStartMs = Date.now() - headStartBeganAt;
      const reason = resolveFocusedDomReady === null ? 'dom-ready' : 'cap';
      console.log(`[session:perf] focused-head-start ms=${headStartMs} reason=${reason} cap_ms=${FOCUSED_HEAD_START_MS}`);
    }
  }

  // Allow the renderer-boot tail tracker to fire `all-loaded` once all
  // pending did-finish-load events have landed (or timed out).
  loopDone = true;
  checkAllLoaded();

  // Summary line — total wall clock, success/fail counts, and the
  // top-5 slowest windows so the bottleneck pattern is visible at a
  // glance in main.log.
  const restoreTotalMs = Date.now() - restoreStartedAt;
  const sumMs = perWindowTimings.reduce((s, t) => s + t.ms, 0);
  const avgMs = perWindowTimings.length > 0 ? Math.round(sumMs / perWindowTimings.length) : 0;
  const maxMs = perWindowTimings.reduce((m, t) => Math.max(m, t.ms), 0);
  const slowest = [...perWindowTimings].sort((a, b) => b.ms - a.ms).slice(0, 5);
  console.log(`[session:perf] restore-end total_ms=${restoreTotalMs} n=${perWindowTimings.length} restored=${result.restored} failed=${result.failed} avg_ms=${avgMs} max_ms=${maxMs}`);
  for (const s of slowest) {
    console.log(`[session:perf] slow-window ms=${s.ms} ok=${s.ok} url=${s.url.substring(0, 100)}`);
  }

  // Focus the window that was focused at save time — but only if Peek is
  // still the OS-frontmost app. If the user switched away mid-restore,
  // calling .focus() would yank them back. Best-effort either way.
  //
  // Also seed izui.session.focusedWindowId directly here. The win.on('focus')
  // handler that normally updates it can race with .show()/.focus() during
  // restore — leaving the session with focusedWindowId=null even though
  // the window is visually focused. Two-phase ESC then fails on first
  // visit because enterOverlay reads focusedWindowId to seed
  // preOverlayFocusTarget, and a null pointer leaves exitOverlay with
  // nothing to restore to (symptom: ESC ESC drops to workspace root).
  // Seeding here is deterministic; the focus event remains the source of
  // truth for subsequent user-driven focus changes.
  //
  // NOTE (step 8a): enterOverlay now seeds preOverlayFocusTarget from the
  // window-state machine's `front`, not from this coordinator tracker — the
  // machine's `front` is driven deterministically by restore's own machine-
  // routed show dispatches (every loop show is a WINDOW_SHOW_REQUESTED whose
  // backend synchronously echoes WINDOW_SHOWN, and the hybrid focused
  // descriptor activates through showHybridHost's dispatch), so this guard
  // now protects only the coordinator's own focusedWindowId consumers and is
  // slated for deletion in step 8b/8c.
  if (focusedWindowId) {
    try {
      const coordinator = getIzuiCoordinator();
      // Seed the focused window AND arm the restore focus guard in one step.
      // The guard makes the seed survive the async trailing 'focus' events that
      // the OTHER restored windows fire from their .show() during the loop —
      // without it, whichever non-focused window's focus event lands last (e.g.
      // a Settings BrowserWindow restored after the focused page) clobbers the
      // seed. The guard self-releases once those windows have each fired once,
      // so genuine later user focus changes are honored. Deterministic by
      // construction (independent of focus-event ordering), no timer.
      const otherRestoredIds = restoredWindowIds.filter((id) => id !== focusedWindowId);
      coordinator.beginRestoreFocusGuard(focusedWindowId, otherRestoredIds);
      DEBUG && console.log(`[session] Seeded izui focusedWindowId=${focusedWindowId}, guarding ${otherRestoredIds.length} other restored windows`);
      // Resolve the focused window. A hybrid page-host is a BaseWindow, so
      // getLiveWindow (BrowserWindow.fromId) returns null for it — fall back to
      // the hybrid registry's baseWin. Without this, the web page the user left
      // in front is never raised on restore and Settings (or whatever
      // BrowserWindow restored last) stays frontmost.
      const focusWin = getLiveWindow(focusedWindowId);
      const hybridFocus = focusWin ? null : getHybridWindow(focusedWindowId);

      // Decide whether to RAISE+ACTIVATE the focused descriptor. At cold start
      // Peek is launching and should own the foreground even if the macOS
      // startup dance transiently flipped appFocused false (the two converged
      // bugs: z-order peek 7bb74c90 + not-frontmost peek 8f7010a8). In-session
      // restore honors appFocused so a switched-away user isn't yanked back.
      // Headless never activates (focus-free). See izui-roles.ts.
      const willActivate = shouldActivateFocusedOnRestore(
        isColdStart,
        coordinator.isAppFocused(),
        isHeadless(),
      );
      // Always-on (non-DEBUG) decision log: the original diagnosis rested on an
      // ABSENCE of logs (the gated block was silently skipped). Make the
      // decision self-evident in prod main.log for any future occurrence.
      console.log(`[session] restore-focus-decision coldStart=${isColdStart} appFocused=${coordinator.isAppFocused()} headless=${isHeadless()} willActivate=${willActivate} focusedId=${focusedWindowId}`);

      // Arm the one-shot cold-start re-assert latch BEFORE touching windows: a
      // trailing did-resign-active could re-strand Peek after this block runs.
      // Gated cold-start + non-headless + a window actually present to raise.
      if (isColdStart && !isHeadless() && (focusWin || (hybridFocus && !hybridFocus.baseWin.isDestroyed()))) {
        _coldStartReassertArmed = true;
        _coldStartReassertId = focusedWindowId;
      }

      if (willActivate) {
        // Reproduce the FULL saved stacking order — not just the focused window.
        // During the loop, internal-tile BrowserWindows were show()'d active (each
        // orderFront'd over the previous) and hybrid page-hosts were shown INACTIVE,
        // so the post-loop on-screen stack bears no relation to how the user left
        // it: internal tiles float above the web pages the user had in front.
        //
        // §5 step 5 part B: the machine owns ordering now. Import the saved stack
        // BOTTOM→TOP (`restoredWindowIds` is restore order = [focused, then zOrder
        // desc] = front→back, so REVERSED it is back→front with the focused window
        // last/on top). The reducer replaces its `stackOrder` with this order and
        // emits SET_STACKING per window bottom→top — relative raises only, no
        // activation, no focus steal; only the focused window (activated LAST,
        // below) becomes key/first-responder. Page-hosts that have not composited
        // yet no-op natively and converge via the `hybrid:first-frame` →
        // WINDOW_CONTENT_ORDERABLE producer as each becomes orderable.
        // Deterministic ordered pass, no timer. Gated by willActivate: skips
        // headless AND the switched-away case, so we never yank the user back.
        const savedOrderBottomToTop: WindowId[] = [];
        for (const id of [...restoredWindowIds].reverse()) {
          const machineId = getWindowIdFor(id);
          if (machineId != null) savedOrderBottomToTop.push(machineId);
        }
        dispatchWindowEvent({ type: 'STACK_ORDER_IMPORTED', order: savedOrderBottomToTop });
        _restoreStackDriveCount = savedOrderBottomToTop.length;
        // Counter bookkeeping for the cold-start spec: each restored page-host
        // reports first-frame once; the permanent producer (top of file) counts
        // the ones from THIS restore via the pending set.
        _restorePageHostCount = restoredPageHostIds.size;
        for (const id of restoredPageHostIds) _restorePendingFirstFrameIds.add(id);
        // ACTIVATE the focused descriptor LAST so it lands on top of the rebuilt
        // stack and becomes the key window / macOS first responder (its focus
        // event has the machine re-drive raise + order for it). The hybrid path
        // activates via showHybridHost() (not a bare focus()) so its content
        // WebContentsView becomes first responder (cmd+L works, overlay reveals)
        // — the same full activation a fresh open does.
        if (focusWin) {
          focusWin.focus();
          _restoreFocusCount++;
          _restoreFocusedId = focusedWindowId;
          DEBUG && console.log(`[session] Focused restored window: ${focusedWindowId}`);
        } else if (hybridFocus && !hybridFocus.baseWin.isDestroyed()) {
          showHybridHost(hybridFocus.baseWin, hybridFocus.contentWC);
          _restoreFocusCount++;
          _restoreHybridActivationCount++;
          _restoreFocusedId = focusedWindowId;
          DEBUG && console.log(`[session] Activated restored hybrid window: ${focusedWindowId}`);
        }
      } else if (focusWin || hybridFocus) {
        DEBUG && console.log(`[session] Skipped focus on ${focusedWindowId} — user switched away`);
      }
    } catch {
      // Best-effort focus
    }
  }

  // Check for partial restore — warn if majority of windows failed
  if (result.failed > 0 && result.total > 2 && result.failed > result.total / 2) {
    console.warn(`[session] Partial restore: ${result.failed}/${result.total} windows failed`);
    try {
      publish(getSystemAddress(), 'session:restore-partial', {
        restored: result.restored,
        failed: result.failed,
        total: result.total,
      });
    } catch {
      // Non-critical
    }
  }

  // Publish session:restored event
  try {
    publish(getSystemAddress(), 'session:restored', {
      restored: result.restored,
      failed: result.failed,
      total: result.total,
    });
  } catch {
    // Non-critical
  }

  // Update session metadata with restore info and reset crashCount
  try {
    const metaRow = db.prepare(
      `SELECT value FROM feature_settings WHERE featureId = 'session' AND key = 'metadata'`
    ).get() as { value: string } | undefined;

    let metadata: Partial<SessionMetadata> = {};
    if (metaRow?.value) {
      metadata = JSON.parse(metaRow.value);
    }

    metadata.lastRestoreAt = Date.now();
    metadata.restoreCount = (metadata.restoreCount ?? 0) + 1;
    // Reset crash count after successful restore
    metadata.crashCount = 0;

    db.prepare(`
      INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
      VALUES (?, 'session', 'metadata', ?, ?)
    `).run('session-metadata', JSON.stringify(metadata), Date.now());
  } catch {
    // Non-critical
  }

  DEBUG && console.log(`[session] Restore complete: ${result.restored}/${result.total} windows restored, ${result.failed} failed`);
  return result;

  } finally {
    // Always flip the restore-complete flag back on so subsequent saves
    // (autosave, window-close debounce, next quit) work normally.
    markRestoreComplete();
    DEBUG && console.log('[session] markRestoreComplete: saves re-enabled');
  }
}

// ============================================================================
// Phase 3: Autosave Timer
// ============================================================================

let _autosaveTimer: ReturnType<typeof setInterval> | null = null;
let _autosaveIntervalMinutes = 0;

/**
 * Start or restart the periodic autosave timer.
 *
 * @param intervalMinutes - Interval in minutes (0 = disabled)
 */
export function startAutosaveTimer(intervalMinutes: number): void {
  if (isTestProfile()) return;

  // Stop existing timer first
  stopAutosaveTimer();

  _autosaveIntervalMinutes = intervalMinutes;

  if (intervalMinutes <= 0) {
    DEBUG && console.log('[session] Autosave disabled (interval=0)');
    return;
  }

  const intervalMs = intervalMinutes * 60 * 1000;
  _autosaveTimer = setInterval(() => {
    DEBUG && console.log('[session] Autosave timer fired');
    saveSessionSnapshot('autosave');
  }, intervalMs);

  DEBUG && console.log(`[session] Autosave timer started: every ${intervalMinutes} minute(s)`);
}

/**
 * Stop the periodic autosave timer.
 * Called during quit cleanup, before the final save.
 */
export function stopAutosaveTimer(): void {
  if (_autosaveTimer !== null) {
    clearInterval(_autosaveTimer);
    _autosaveTimer = null;
    DEBUG && console.log('[session] Autosave timer stopped');
  }
}

/**
 * Update the autosave interval if it has changed.
 * Called when prefs change to restart the timer with the new interval.
 */
export function updateAutosaveInterval(intervalMinutes: number): void {
  if (intervalMinutes !== _autosaveIntervalMinutes) {
    DEBUG && console.log(`[session] Autosave interval changed: ${_autosaveIntervalMinutes} -> ${intervalMinutes}`);
    startAutosaveTimer(intervalMinutes);
  }
}

/**
 * Save per-space workspace snapshots to feature_settings.
 *
 * Groups windows by their space mode context and writes a layout snapshot
 * for each space. Used by openGroup() to restore window positions.
 * Synchronous (safe for before-quit handler).
 */
export function saveSpaceWorkspaces(): void {
  let db;
  try {
    db = getDb();
  } catch {
    return;
  }

  const registeredWindows = getAllWindows();

  // Use getAllLiveWindows() order for z-order approximation
  const allBrowserWindows = getAllLiveWindows();
  const zOrderMap = new Map<number, number>();
  allBrowserWindows.forEach((win, index) => {
    zOrderMap.set(win.id, index);
  });

  // Collect windows grouped by spaceId
  const spaceWindows = new Map<string, { spaceName: string; windows: Array<{ url: string; bounds: Electron.Rectangle; zOrder: number; focused: boolean }> }>();

  for (const [id] of registeredWindows) {
    const win = getLiveWindow(id);
    if (!win || !win.isVisible()) continue;

    const rawUrl = win.webContents.getURL();
    if (rawUrl.includes('peek://app/background.html')) continue;

    // Check if this window is in space mode
    let modeEntry;
    try {
      modeEntry = getContextEntry('mode', id);
    } catch {
      continue;
    }
    if (!modeEntry || modeEntry.value !== 'space') continue;

    const metadata = modeEntry.metadata as Record<string, unknown> | null;
    const spaceId = metadata?.spaceId as string | undefined;
    const spaceName = metadata?.spaceName as string | undefined;
    if (!spaceId) continue;

    const presentation = getWindowPresentation(id);
    if (!presentation) continue;

    if (!spaceWindows.has(spaceId)) {
      spaceWindows.set(spaceId, { spaceName: spaceName || '', windows: [] });
    }
    spaceWindows.get(spaceId)!.windows.push({
      url: presentation.address,
      bounds: presentation.bounds,
      zOrder: zOrderMap.get(id) ?? 0,
      focused: presentation.focused,
    });
  }

  // Write each space's workspace snapshot
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
    VALUES (?, 'space-workspaces', ?, ?, ?)
  `);

  for (const [spaceId, space] of spaceWindows) {
    const snapshot = {
      version: 1,
      spaceId,
      spaceName: space.spaceName,
      createdAt: Date.now(),
      windows: space.windows,
    };
    const key = `workspace:${spaceId}`;
    upsert.run(`space-workspaces:${key}`, key, JSON.stringify(snapshot), Date.now());
  }

  DEBUG && console.log(`[session] Saved workspace snapshots for ${spaceWindows.size} space(s)`);
}

/**
 * Get info about the saved session snapshot without restoring it.
 * Returns null if no valid snapshot exists.
 */
export function getSessionSnapshotInfo(): { windowCount: number; savedAt: number; reason: string } | null {
  try {
    const db = getDb();
    const row = db.prepare(
      `SELECT value FROM feature_settings WHERE featureId = 'session' AND key = 'snapshot'`
    ).get() as { value: string } | undefined;

    if (!row?.value) return null;

    const snapshot: SessionSnapshot = JSON.parse(row.value);
    if (snapshot.version !== 1 || !snapshot.windows?.length) return null;

    const validCount = snapshot.windows.filter(d => isValidDescriptor(d)).length;
    if (validCount === 0) return null;

    return {
      windowCount: validCount,
      savedAt: snapshot.createdAt,
      reason: snapshot.reason,
    };
  } catch {
    return null;
  }
}
