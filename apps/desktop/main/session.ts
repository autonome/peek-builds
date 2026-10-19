/**
 * Session Snapshot — Save/Restore window state
 *
 * Captures all visible user windows and writes to feature_settings using
 * synchronous node:sqlite APIs (safe for before-quit handler). On startup,
 * reads the snapshot and recreates windows. Periodic autosave timer + manual
 * save/restore commands; crash recovery dialog with snapshot validation.
 *
 * NOTE: Pure logic shared copy lives in app/lib/session.js for frontend/Tauri use.
 */

import { BrowserWindow, dialog, screen, ipcMain } from 'electron';
import type { IpcMainEvent } from 'electron';
import { getLiveWindow } from './window-registry.js';
import type { WindowContext, WindowDescriptor } from './window-registry.js';
import { getWindowIdFor, getAppActive, getKernelExecutorForApp } from './window-machine.js';
import { planRestoreActivation } from './window-kernel-executor.js';
import type { State, WindowId } from './window-kernel.js';
import { topmost, isContentWindow, isFrontEligibleWindow } from './window-kernel.js';
import { getDb, getContextEntry, addContextEntry } from './datastore.js';
import { getAllWindows, getBackgroundWindow, pushClosedWindow, suppressClosedWindowPush } from './main.js';
import type { ClosedWindowEntry } from './main.js';
import { getRegisteredTileIds } from './protocol.js';
import { getWindowPresentation } from './window-presenter.js';
import { getHybridWindow, getHybridWindowByContentWC } from './hybrid-page-host-registry.js';
import { serializeSession, addDescriptorsToSnapshot, mergeSnapshotIntoWorkspace, readStackIndex, orderRestoredWindowsBottomToTop, planDesktopRestore, unmaximizedRestoreDescriptor, DEFAULT_WORKSPACE_KEY } from './session-projection.js';
import type { RestoredStackEntry, SessionSaveWindow, SessionSnapshot } from './session-projection.js';
import { invokeWindowOpen } from './ipc.js';
import { WEB_CORE_ADDRESS } from './config.js';
import { publish, getSystemAddress } from './pubsub.js';
import { DEBUG, isTestProfile, isHeadless } from './config.js';
import { showWindowHeadlessSafe, showHybridHost } from './windows.js';
import { kernelImportStackOrder, kernelWindowContentOrderable, kernelArmColdStartFocus, getKernelExecutor } from './window-kernel-dispatch.js';
import { planLazyRestore, mergeHeldIntoSave, planReleaseFocus, noteDesktopSwitch, shouldReadDesktopBeforeRestore } from './restore-hold.js';
import { buildRestoreBoundsOptions } from './session-restore-bounds.js';
import { countDescriptorsExcludingPrefixes } from './session-save-filter.js';

// Longest a launch restore waits for its one desktop read. The provider bounds
// its own requests (a few seconds, then falls back), so this only guards a read
// that never settles; past it, everything opens now, as with no desktop reads.
const RESTORE_DESKTOP_READ_TIMEOUT_MS = 3000;

export type { WindowContext, WindowDescriptor };

// The persisted-snapshot type and the two pure params helpers now live in
// `session-projection.ts` (save is a projection of machine state, not a loop
// in here). Re-exported from their historical home so every existing importer
// — and the on-disk contract they describe — is untouched.
export type { SessionSnapshot } from './session-projection.js';
export { mirrorPlacementIntent, DEFAULT_WORKSPACE_KEY } from './session-projection.js';

// Staged session restore: the first N windows (by stack position = zOrder
// desc, with the saved-focused window hoisted to the front) restore EAGERLY —
// their <webview> navigates and loads content immediately, as before. Every
// window beyond N restores DEFERRED: the canvas page-host + window are
// created (so the window is present and save-safe), but the <webview> is NOT
// navigated. The deferred host shows a cheap static placeholder (title + URL
// + favicon) and does zero content compositing until the user first focuses
// it, at which point it navigates to the real URL (navigate-on-focus, wired
// in ipc.ts).
//
// Why: sustained restore GPU/WindowServer load is dominated by COMPOSITING the
// loaded content of many full-screen webviews — window/canvas creation itself
// is cheap. Deferring content on stale windows cuts sustained GPU ~10-20x while
// keeping every window in place. Measured on the cpu-perf harness.
//
// Tuneable at the code layer only (no UI/pref): bump this constant to keep more
// windows hot at boot. `zOrder` used to be a focus-recency rank (the old
// machine's `WindowRecord.focusSeq`) rather than stacking order — "load what
// you were last using first" even when the visual stack differed from focus
// recency. The kernel cutover deleted that fact (`focusSeq`/`focusSeqCounter`
// are gone, along with the second order they tracked): `zOrder` is now the
// SAME position `stackIndex` reads, so the eager set is simply the TOP of the
// saved stack — stack position is the only ordering fact the kernel has left
// to stage restore by, not a deliberate re-endorsement of "topmost = most
// recently used". The FINAL on-screen order is a separate question and is
// answered by the descriptors' `stackIndex` in the post-loop import below —
// the same numbers, read the same way, for a different purpose (staging load
// order here vs. rebuilding the on-screen stack there).
const SESSION_EAGER_RESTORE_COUNT = 5;

// Params stripped from a saved descriptor before reopening it — shared by the
// boot restore loop and the lazy-restore group open. Per-key reasons are on
// the boot loop's strip comment in `restoreSessionSnapshot`.
const RESTORE_STRIP_KEYS = new Set([
  'x', 'y', 'width', 'height',
  'address', 'transient', 'parentWindowId', 'skipTracking',
  'openDevTools', 'detachedDevTools', 'restoreBlank',
]);

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
 *
 * Module state, not window state: it describes whether THIS module is allowed
 * to write its file, not anything about a window.
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

// ============================================================================
// Lazy-restore hold (docs/design/space-desktop-return-plan.md)
//
// Under public APIs a window's desktop is decided by where the user is when it
// opens, so a restore opens immediately only the descriptors whose recorded
// desktop is the current one (`planLazyRestore`, restore-hold.ts). The rest
// wait here, grouped by desktop, and a group opens when a kernel desktop read
// reports the user arrived on its desktop. Module state, not window state:
// these descriptors have no window yet — that is the point.
// ============================================================================

interface HeldRestoreState {
  /** The workspace whose restore held these; a save under the same key re-saves them. */
  workspaceKey: string;
  groups: Map<string, WindowDescriptor[]>;
  unsubscribe: () => void;
  /** True while a released group's open loop runs — one release at a time. */
  releaseInFlight: boolean;
  /** Desktop switch notices seen, and whether the app was active as the latest began (`noteDesktopSwitch`). */
  switchTracking: { switchesSeen: number; activeAtSwitch: boolean };
}

let _heldRestore: HeldRestoreState | null = null;

function clearHeldRestore(): void {
  if (_heldRestore === null) return;
  _heldRestore.unsubscribe();
  _heldRestore = null;
}

/** Still-held descriptors a save under `workspaceKey` must carry forward. */
function heldDescriptorsFor(workspaceKey: string): WindowDescriptor[] {
  if (_heldRestore === null || _heldRestore.workspaceKey !== workspaceKey) return [];
  const out: WindowDescriptor[] = [];
  for (const group of _heldRestore.groups.values()) out.push(...group);
  return out;
}

/**
 * How many windows are still held (no window yet, waiting for the user to
 * reach their desktop) for `workspaceKey`; 0 when the hold belongs to another
 * workspace or nothing is held. A bare count: it exposes none of the URLs.
 * Descriptors whose url starts with any `excludeUrlPrefixes` entry are skipped.
 */
export function getHeldWindowCount(workspaceKey: string, excludeUrlPrefixes: string[] = []): number {
  return countDescriptorsExcludingPrefixes(heldDescriptorsFor(workspaceKey), excludeUrlPrefixes);
}

/**
 * Replace any previous hold with this restore's held groups and watch kernel
 * state for arrival on one of their desktops. A restore defines the session's
 * composition, so an older hold (a previous workspace's, say) is discarded —
 * its descriptors were re-saved to that workspace's row by the save that
 * preceded the restore.
 */
function installHeldRestore(workspaceKey: string, groups: Map<string, WindowDescriptor[]>): void {
  clearHeldRestore();
  if (groups.size === 0) return;
  const state: HeldRestoreState = {
    workspaceKey,
    groups,
    unsubscribe: () => {},
    releaseInFlight: false,
    switchTracking: { switchesSeen: getKernelExecutorForApp().getState().desktopSwitchCount, activeAtSwitch: false },
  };
  state.unsubscribe = getKernelExecutorForApp().subscribe((kernelState) => {
    // Read before anything else: the notification for the switch notice still
    // carries the app's state from before the switch.
    state.switchTracking = noteDesktopSwitch(state.switchTracking, kernelState);
    maybeReleaseHeldGroup(state, kernelState);
  });
  _heldRestore = state;
  const total = [...groups.values()].reduce((n, g) => n + g.length, 0);
  console.log(
    `[session] lazy-restore-held workspace=${workspaceKey} desktops=${[...groups.keys()].join(',')} windows=${total}`,
  );
}

/**
 * Open the group recorded on the kernel's current desktop, if one is held.
 * Runs on every kernel notification (and once right after a restore
 * completes), so it must be cheap and idempotent: a non-matching state is a
 * no-op, and a matching group is removed before its open loop starts.
 */
function maybeReleaseHeldGroup(state: HeldRestoreState, kernelState: State): void {
  if (_heldRestore !== state || state.releaseInFlight) return;
  // Mid-restore (boot loop or an earlier group's open) — the finally below and
  // later kernel notifications re-check.
  if (!_restoreComplete) return;
  // Mid workspace switch the hold is about to be replaced by the target
  // workspace's restore; opening the outgoing workspace's windows now would
  // put them in the wrong workspace.
  if (_workspaceSwitchInFlight) return;
  const current = kernelState.screens[0]?.current ?? null;
  if (current === null) return;
  const group = state.groups.get(current);
  if (group === undefined) return;
  state.groups.delete(current);
  state.releaseInFlight = true;
  console.log(`[session] lazy-restore-release desktop=${current} n=${group.length}`);
  // The open starts only after this notification returns. A kernel
  // notification runs inside the executor's event pump, which queues any
  // command issued from it (`window-kernel-executor.ts pump()`): a window
  // opened synchronously here has its registration queued, so the open path's
  // show is decided against a state with no such window and rejected
  // (`no-such-window`) — the window exists but never appears. The boot restore
  // runs outside any notification, which is why its page hosts show.
  const activeBeforeSwitch = state.switchTracking.activeAtSwitch;
  void Promise.resolve()
    .then(() => openHeldGroup(group, current, activeBeforeSwitch))
    .catch((err) => console.error('[session] lazy-restore open failed:', err))
    .finally(() => {
      state.releaseInFlight = false;
      if (_heldRestore === state && state.groups.size === 0) clearHeldRestore();
    });
}

/**
 * Open a released group on the desktop the user just arrived on. A slimmed
 * copy of the boot restore loop (same descriptor cleaning, same staged
 * eager/deferred split, same context re-apply) without boot-only machinery:
 * no focused-head-start, no perf tail tracking, no desktop placement (the
 * user's presence IS the placement). Wrapped in the restore-in-flight guard
 * so an ambient save during the open cannot record half-loaded windows —
 * the group was already removed from the hold, so such a save would
 * otherwise drop them.
 */
async function openHeldGroup(descriptors: WindowDescriptor[], desktop: string, activeBeforeSwitch: boolean): Promise<void> {
  if (!invokeWindowOpen) {
    console.error('[session] lazy-restore open skipped — invokeWindowOpen not initialized');
    return;
  }
  const bgWin = getBackgroundWindow();
  if (!bgWin || bgWin.isDestroyed()) {
    console.error('[session] lazy-restore open skipped — background window not available');
    return;
  }
  markRestoreInFlight();
  try {
    const primaryWorkArea = screen.getPrimaryDisplay().workArea;
    const ordered = [...descriptors].sort((a, b) => b.zOrder - a.zOrder);
    const eagerCount = Math.min(SESSION_EAGER_RESTORE_COUNT, ordered.length);
    let focusedWindowId: number | null = null;
    let opened = 0;
    const openedIds: number[] = [];
    for (let i = 0; i < ordered.length; i++) {
      const original = unmaximizedRestoreDescriptor(ordered[i]);
      try {
        const collapsed = collapseToPrimaryDisplay(original, primaryWorkArea);
        const descriptor =
          collapsed === original
            ? original
            : { ...original, bounds: collapsed.bounds, params: collapsed.params };
        const boundsOptions = buildRestoreBoundsOptions(descriptor, isPointOnScreen);
        const cleanParams: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(descriptor.params)) {
          if (!RESTORE_STRIP_KEYS.has(key)) cleanParams[key] = value;
        }
        const options: Record<string, unknown> = {
          ...cleanParams,
          ...boundsOptions,
          skipTracking: true,
          chrome: false,
          show: false,
        };
        if (i >= eagerCount) {
          options.restoreBlank = true;
          options.title = descriptor.title;
        }
        if (descriptor.key) options.key = descriptor.key;
        if (descriptor.context?.pinScope) {
          options.alwaysOnTop = true;
          options.pinScope = descriptor.context.pinScope;
        }
        const openResult = (await invokeWindowOpen(
          { sender: bgWin.webContents },
          { source: descriptor.source || WEB_CORE_ADDRESS, url: descriptor.url, options },
        )) as { success: boolean; id?: number; error?: string };
        if (!openResult?.success || openResult.id == null) {
          console.warn(`[session] lazy-restore window failed: ${descriptor.url}`, openResult?.error);
          continue;
        }
        opened++;
        openedIds.push(openResult.id);
        // BrowserWindows opened show:false need the explicit inactive show; a
        // hybrid page-host was already shown inactive by its open path (which
        // holds only because this loop never runs inside a kernel
        // notification — see `maybeReleaseHeldGroup()`).
        const win = getLiveWindow(openResult.id);
        if (win && !win.isDestroyed()) showWindowHeadlessSafe(win);
        if (descriptor.context?.mode) {
          try {
            addContextEntry('mode', descriptor.context.mode, {
              windowId: openResult.id,
              source: 'session-restore',
              metadata: descriptor.context.modeMetadata || { url: descriptor.url },
            });
          } catch {
            // Context restore is best-effort
          }
        }
        if (descriptor.focused === true) focusedWindowId = openResult.id;
      } catch (err) {
        console.error(`[session] lazy-restore error opening ${original.url}:`, err);
      }
    }
    console.log(`[session] lazy-restore-opened desktop=${desktop} n=${opened}/${descriptors.length}`);
    // The held focus applies now that its group is open — but only under the
    // warm-restore rule (app active, not headless), so a user who arrived on
    // this desktop in another app is not yanked into Peek.
    // With no focused marker, the frontmost released window takes it: the user
    // arrived by switching desktops, and with no key window here the OS returns
    // to the desktop of the one that still is.
    const focusPlan = planReleaseFocus(
      openedIds,
      focusedWindowId,
      getKernelExecutorForApp().shouldRestoreFocus(false, activeBeforeSwitch),
    );
    console.log(`[session] lazy-restore-focus desktop=${desktop} focusedId=${focusPlan.id ?? 'none'} reason=${focusPlan.reason} activeBeforeSwitch=${activeBeforeSwitch}`);
    if (focusPlan.id != null) {
      // macOS resigns the app right after the desktop change, and a raise
      // without a user intent is suppressed while inactive (`planRaise`).
      const restoreIntent = planRestoreActivation(false, activeBeforeSwitch);
      const activation = restoreIntent ? ({ activation: restoreIntent }) : undefined;
      const focusWin = getLiveWindow(focusPlan.id);
      const hybridFocus = focusWin ? null : getHybridWindow(focusPlan.id);
      if (focusWin && !focusWin.isDestroyed()) {
        showWindowHeadlessSafe(focusWin, { active: true, ...activation });
      } else if (hybridFocus && !hybridFocus.baseWin.isDestroyed()) {
        showHybridHost(hybridFocus.baseWin, activation);
      }
    }
  } finally {
    markRestoreComplete();
  }
}

// Test observability, NOT window state — these count what the restore DID, and
// nothing reads them to make a decision. They stay module-level because they
// are per-restore-run bookkeeping with no home in the machine (the machine
// holds what IS, not how many times a boot drove it). Read only through
// `getRestoreFocusCounters()` / `__peek_test`.
//
// Drift-detection counters for restoreSessionSnapshot. Invariant: the
// per-window restore loop NEVER activates — every loop show is inactive
// (`shows` must stay 0), and activation belongs exclusively to the
// post-loop willActivate block. History: 853cc48f first gated the loop's
// .show()/.focus() on isAppFocused() so a switched-away user isn't
// yanked back; that gate later proved insufficient — with the app
// focused, each activating loop .show() queued an async native macOS
// focus event and the LAST to land stole `front` from the descriptor the
// post-loop authority had just focused — so the loop now shows inactive
// unconditionally. Tests in tests/desktop/session-restore-focus.spec.ts
// read these counters via __peek_test.getRestoreFocusCounters() to
// assert the invariant holds. Counters are reset at the top of
// restoreSessionSnapshot.
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
//
// Module state, not window state: an idempotency guard for THIS module's one
// ipcMain listener. It says nothing about any window.
let _firstFrameProducerInstalled = false;
export function installFirstFrameOrderableProducer(): void {
  if (_firstFrameProducerInstalled) return;
  _firstFrameProducerInstalled = true;
  ipcMain.on('hybrid:first-frame', (event: IpcMainEvent) => {
    const entry = getHybridWindowByContentWC(event.sender);
    if (!entry) return;
    const machineId = getWindowIdFor(entry.windowId);
    if (machineId != null) {
      // Feed the kernel (window-kernel-dispatch.ts) — this is what drives the
      // window manager; the sole writer of `orderable`, without which
      // `topmostBaseLayerPageHost` returns null forever.
      kernelWindowContentOrderable(machineId);
    }
    // Restore-spec bookkeeping only (see the counter block above).
    if (_restorePendingFirstFrameIds.delete(entry.windowId)) {
      _restoreFirstFrameReassertCount++;
    }
  });
}

// ----------------------------------------------------------------------------
// Cold-start trailing-dance re-raise: ARMED here, OWNED by the machine.
//
// Bulletproofing for the cold-start activation: the post-loop focused-descriptor
// block raises+activates the saved-focused window, but it is possible the macOS
// startup activation dance fires a FINAL `did-resign-active` AFTER that block
// runs, re-stranding Peek in the background (previous app keeps the menubar).
//
// The latch that covers it used to be two module-level lets in here
// (`_coldStartReassertArmed` / `_coldStartReassertId`) plus a
// `reassertColdStartFocusOnce()` that main.ts's `did-become-active` handler
// called and that drove the OS itself. It is reducer state now (§5 step 11):
// the restore dispatches `COLD_START_FOCUS_ARMED` and `APP_ACTIVATED` — which
// the backend already emits from that same `did-become-active` — consumes it,
// re-fronts the window and lets the closing assertion drive raise + first
// responder + stacking. Same one-shot, no timer, one fewer copy of "which
// window is meant to be in front". See `window-kernel.ts
// State.pendingColdStartFocus`.

export interface SessionMetadata {
  lastSaveReason: string;
  lastSaveAt: number;
  windowCount: number;
  cleanShutdown: boolean;
  crashCount: number;
  lastRestoreAt?: number;
  restoreCount?: number;
  /**
   * The workspace that was active at the last save (`_activeWorkspaceKey`, not
   * the save's own key). Boot reads it to reopen that workspace rather than the
   * default — see `restorableSavedWorkspaceKey`. Absent in metadata written
   * before it existed, which boots into the default as before.
   */
  activeWorkspaceKey?: string;
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

// Pure restore-bounds builder lives in `session-restore-bounds.ts` so it can
// be unit-tested without Electron; re-exported from its historical home.
export { buildRestoreBoundsOptions };

/**
 * Read phase for `saveSessionSnapshot`: gather the one thing the
 * window-state machine does NOT hold for a registered window — is the native
 * handle gone, and what raw URL does the early-skip filter match
 * `background.html` against.
 *
 * Hybrid page-hosts are BaseWindows, so `getLiveWindow` (BrowserWindow.fromId)
 * returns null for them; they live in the hybrid registry instead. Detecting
 * them up-front (via `winData.params.hybridPageHost`) is what makes a hybrid
 * window reach the save path rather than silently vanishing behind a
 * BrowserWindow-only `if (!win) continue` guard.
 */
function buildSessionSaveWindows(
  registeredWindows: ReturnType<typeof getAllWindows>,
): SessionSaveWindow[] {
  const saveWindows: SessionSaveWindow[] = [];
  for (const [id, winData] of registeredWindows) {
    const win = getLiveWindow(id);
    const hybridEntry =
      winData.params.hybridPageHost === true ? getHybridWindow(id) : null;

    let destroyed: boolean;
    let url: string;
    if (hybridEntry) {
      destroyed = hybridEntry.baseWin.isDestroyed();
      // A hybrid window is never the background page; its content URL is safe
      // for the background-URL skip (it can never match background.html).
      url = destroyed ? '' : hybridEntry.url();
    } else if (win) {
      destroyed = false;
      url = win.webContents.getURL();
    } else {
      // Neither a live BrowserWindow nor a hybrid entry — destroyed/unknown.
      destroyed = true;
      url = '';
    }

    saveWindows.push({
      nativeId: id,
      machineId: getWindowIdFor(id),
      source: winData.source,
      params: winData.params,
      destroyed,
      url,
    });
  }
  return saveWindows;
}

/**
 * Read phase shared by both save paths: the kernel's whole state (the
 * `SerializeSessionInput.snapshot` every window-management fact — visibility,
 * bounds, maximize — is read off), plus `.kernelOrder` / `.topmostContentWindowId`
 * (and the space-workspace mirrors of all three). ONE kernel-state read, so
 * every fact a projection call sees comes from the same instant.
 *
 * `kernelState.order` is the kernel's FULL order — every registered window,
 * including an invisible one or a palette/HUD. The old machine's
 * `StateSnapshot.stackOrder` was never that: its membership was exactly
 * `stackingLevel === 'stacked' && visible` (`window-state.ts isStackMember`),
 * which — by that module's own construction note — is the SAME set as
 * `isEligibleFront` (`visible && !satellite`). The kernel's direct port of
 * that rule is `isFrontEligibleWindow` (`window-kernel.ts`: `visible &&
 * canBecomeKey && !roleIn(SATELLITE_ROLES, role)`), so filtering to it here
 * reproduces the old `stackOrder` membership rather than handing
 * `serializeSession` every registered window. Filtered HERE, at the seam —
 * `session-projection.ts` stays pure and receives already-filtered data — so
 * the on-disk meaning of `stackIndex` is unchanged: it stays ABSENT for a
 * window the kernel never stacked, which is what keeps `readStackIndex`'s
 * "no recorded position" migration branch reachable for an aged profile
 * instead of retiring it (every registered window would otherwise almost
 * always have SOME position). `kernelState.order` itself (unfiltered) is
 * what `SerializeSessionInput.snapshot` carries — `serializeSession` looks
 * up individual records by id from it, so the broader membership there is
 * inert for that read.
 */
function readKernelOrderFacts(): { kernelState: State; kernelOrder: WindowId[]; topmostContentWindowId: WindowId | null } {
  const kernelState = getKernelExecutor().getState();
  return {
    kernelState,
    kernelOrder: kernelState.order.filter(isFrontEligibleWindow).map((rec) => rec.id),
    topmostContentWindowId: topmost(kernelState, isContentWindow)?.id ?? null,
  };
}

/**
 * Read a window's saved context row (mode, spaceId/spaceName, pinScope, …)
 * for `serializeSession`'s `getContext` — "no row / read failed" →
 * `undefined`.
 *
 * `mode` and `pin` are independent context keys, read independently: a window
 * pinned across every workspace without ever having been assigned to a
 * space/group (`features/spaces/background.js setPinState()` sets only the
 * 'pin' key for a global pin) has a pin scope and no mode row, and must still
 * read back as pinned — otherwise it is written into a named workspace's row
 * it does not belong to, restored twice on a workspace switch, and comes back
 * unpinned after a relaunch.
 */
function readSaveContext(nativeId: number): WindowContext | undefined {
  let modeEntry: ReturnType<typeof getContextEntry> = null;
  let pinScope: string | null = null;
  try {
    modeEntry = getContextEntry('mode', nativeId);
  } catch {
    // Context not available, treat as no mode
  }
  try {
    const pinEntry = getContextEntry('pin', nativeId);
    pinScope = (pinEntry?.value as string) || null;
  } catch {
    // Pin context not available, treat as unpinned
  }
  if (!modeEntry && !pinScope) return undefined;
  return {
    mode: modeEntry ? (modeEntry.value as string) : null,
    modeMetadata: modeEntry ? ((modeEntry.metadata as Record<string, unknown>) || null) : null,
    pinScope,
  };
}

/**
 * Resolve the `feature_settings` row key for a workspace's snapshot.
 *
 * The default workspace keeps the literal legacy name (`snapshot`) it has
 * always used — an existing profile's boot snapshot reads back with no
 * migration. A named workspace gets its own row, suffixed by its key, so every
 * workspace's snapshot lives in the SAME shape/table, just parameterized
 * (requirement 2: no second `space-workspaces` table). Crash bookkeeping (the
 * `metadata` row: `cleanShutdown`, `crashCount`, …) is about the APP, not a
 * workspace, so there is one such row and no per-workspace variant of it.
 */
export function snapshotRowKey(workspaceKey: string): string {
  return workspaceKey === DEFAULT_WORKSPACE_KEY ? 'snapshot' : `snapshot:${workspaceKey}`;
}

/**
 * The named workspace boot should reopen, or null for the default.
 *
 * The metadata row records which workspace was active at the last save
 * (`SessionMetadata.activeWorkspaceKey`). A named workspace's key is its
 * `space:` tag's id; the workspace comes back only while that tag still exists
 * and its saved row is still there — a workspace deleted since the quit, or one
 * never saved, falls back to the default exactly as boot did before the key
 * was recorded.
 */
function restorableSavedWorkspaceKey(db: ReturnType<typeof getDb>): string | null {
  try {
    const metaRow = db.prepare(
      `SELECT value FROM feature_settings WHERE featureId = 'session' AND key = 'metadata'`
    ).get() as { value: string } | undefined;
    if (!metaRow?.value) return null;
    const saved = (JSON.parse(metaRow.value) as Partial<SessionMetadata>).activeWorkspaceKey;
    if (typeof saved !== 'string' || !saved || saved === DEFAULT_WORKSPACE_KEY) return null;
    const tag = db.prepare('SELECT name FROM tags WHERE id = ?').get(saved) as { name: string } | undefined;
    if (!tag?.name?.startsWith('space:')) return null;
    const row = db.prepare(
      `SELECT 1 AS present FROM feature_settings WHERE featureId = 'session' AND key = ?`
    ).get(snapshotRowKey(saved)) as { present: number } | undefined;
    return row ? saved : null;
  } catch {
    return null;
  }
}

// ============================================================================
// Active workspace
//
// Which workspace's row an AMBIENT save (autosave, before-quit, the debounced
// window-lifecycle save, the manual save command) writes. The spaces feature
// owns the notion of "the active workspace" (`features/spaces/background.js
// activeSpaceId`); it reports every change here through
// `tile:session:set-active-workspace` so that quitting while a named
// workspace is active saves THAT workspace's row — not the default
// workspace's, which would silently replace the default's saved session with
// another workspace's windows.
//
// A workspace switch (save the outgoing workspace → close its windows →
// restore the target) is a window during which no ambient save may run: the
// outgoing workspace's windows are gone and the target's are not open yet, so
// a save keyed to either would record an empty workspace. The 500ms debounced
// window-lifecycle save (`main.ts scheduleSnapshotOnClose`) is triggered by
// exactly the close sweep in the middle of that sequence. The feature brackets
// the switch with `tile:session:begin-workspace-switch` and
// `tile:session:set-active-workspace`; ambient saves are refused in between.
// ============================================================================

let _activeWorkspaceKey: string = DEFAULT_WORKSPACE_KEY;
let _workspaceSwitchInFlight = false;
// Whether the app was the active app when the in-flight switch began; read by the restore's
// focus decision (see `planRestoreFocus`).
let _appActiveAtSwitchStart = false;

/** Suppress ambient saves until `setActiveWorkspaceKey` names the new workspace. */
export function beginWorkspaceSwitch(): void {
  _workspaceSwitchInFlight = true;
  _appActiveAtSwitchStart = getAppActive();
}

/** Record which workspace is active (ending any in-flight switch). */
export function setActiveWorkspaceKey(key: string): void {
  _activeWorkspaceKey = key;
  _workspaceSwitchInFlight = false;
  _appActiveAtSwitchStart = false;
}

export function getActiveWorkspaceKey(): string {
  return _activeWorkspaceKey;
}

/**
 * Save a snapshot of all visible user windows to the datastore.
 *
 * MUST be synchronous — runs in the before-quit handler before closeDatabase().
 * Uses node:sqlite synchronous APIs via getDb().
 *
 * `opts.key` names which workspace this save is for. Left unset (every
 * ambient save: autosave, before-quit, window-lifecycle, manual), the save
 * goes to the ACTIVE workspace's row — see "Active workspace" above. The
 * explicit workspace-leave save (`features/spaces/background.js
 * closeCurrentWorkspaceWindows()`, through `tile:session:save-workspace-
 * snapshot`) passes the outgoing workspace's key. Which windows a key saves
 * is decided by the key alone in `serializeSession` — a named key saves its
 * own windows minus any pinned across every workspace; the default key saves
 * everything on screen — and a save under a named key also refreshes the
 * default row's record of the windows pinned across every workspace, so a
 * pin created while a named workspace is active survives a relaunch (see
 * `refreshGlobalPinsInDefaultSnapshot`).
 *
 * `opts.allowInTestProfile` lets a deliberate, user-initiated save (a
 * workspace switch) run under the test profile the desktop specs use; it
 * bypasses nothing else. `opts._forceForTest` is the test-only escape hatch:
 * it ALSO bypasses the mid-restore guard and the invisible-window filter, and
 * only test bridges may pass it.
 */
// A snapshot records the desktop the kernel last saw each window on, and a window dragged to
// another desktop fires no event. A caller that can wait reads the real desktops first; a
// failed read leaves the last known ones.
export async function refreshDesktopsBeforeSave(): Promise<void> {
  try {
    await getKernelExecutor().refreshDesktops('before-save');
  } catch {
    /* save with what the kernel knows */
  }
}

export function saveSessionSnapshot(
  reason: SessionSnapshot['reason'],
  opts?: { cleanShutdown?: boolean; _forceForTest?: boolean; allowInTestProfile?: boolean; key?: string },
): void {
  // Skip save in test environments unless the caller says otherwise (test
  // bridges via _forceForTest; a real workspace switch via allowInTestProfile).
  if (isTestProfile() && !opts?._forceForTest && !opts?.allowInTestProfile) return;

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

  // Guard 2: Workspace switch in flight — see "Active workspace" above. Only
  // an ambient save (no explicit key) is refused; the switch's own explicit
  // save of the outgoing workspace carries a key.
  if (opts?.key == null && _workspaceSwitchInFlight) {
    console.warn(`[session] Refusing to save snapshot (reason: ${reason}): workspace switch in flight. Snapshot preserved.`);
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
  const workspaceKey = opts?.key ?? _activeWorkspaceKey;

  // ── Read ────────────────────────────────────────────────────────────────
  // Gather ONLY what the kernel does not hold: per window, is the native
  // handle gone, and what raw URL does the early-skip filter match
  // `background.html` against. Visibility/geometry/maximize state are read off
  // the kernel snapshot inside `serializeSession`; stack position and which
  // window was focused also come from the kernel — see `readKernelOrderFacts`.
  const saveWindows = buildSessionSaveWindows(registeredWindows);
  const { kernelState, kernelOrder, topmostContentWindowId } = readKernelOrderFacts();

  // ── Project ─────────────────────────────────────────────────────────────
  // The pure projection owns every window decision: the skip rules, the
  // restorable rect, maximize + its flat preMax bag, stack position, the
  // focused descriptor, and the empty-URL guard.
  const createdAt = Date.now();
  const projectionInput = {
    snapshot: kernelState,
    windows: saveWindows,
    getPresentation: (nativeId: number) => getWindowPresentation(nativeId),
    getContext: readSaveContext,
    registeredTileIds: getRegisteredTileIds(),
    reason,
    createdAt,
    forceForTest: opts?._forceForTest,
    kernelOrder,
    topmostContentWindowId,
  };
  const projection = serializeSession({ ...projectionInput, workspaceKey });

  // The projection decided what to log; this replays it at the levels the
  // save path has always used, in the same order.
  for (const notice of projection.notices) {
    if (notice.level === 'warn') console.warn(notice.message);
    else if (notice.level === 'info') console.log(notice.message);
    else DEBUG && console.log(notice.message);
  }

  // Descriptors still held by lazy restore (never opened this session) have no
  // window for the projection to see, but they are part of the workspace's
  // session: fold them back in with their recorded desktops so a quit while
  // groups are held does not drop them. The live set's focus wins (see
  // `mergeHeldIntoSave`).
  const heldForSave = heldDescriptorsFor(workspaceKey);
  const snapshot =
    heldForSave.length === 0
      ? projection.snapshot
      : { ...projection.snapshot, windows: mergeHeldIntoSave(projection.snapshot.windows, heldForSave) };
  if (heldForSave.length > 0) {
    console.log(`[session] save-merged-held n=${heldForSave.length} key=${workspaceKey}`);
  }
  DEBUG && console.log(`[session] Captured ${snapshot.windows.length} window(s) (${projection.windowCount - snapshot.windows.length} filtered)`);

  // ── Write ───────────────────────────────────────────────────────────────
  const snapshotKey = snapshotRowKey(workspaceKey);
  try {
    // Write snapshot to feature_settings table
    db.prepare(`
      INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
      VALUES (?, 'session', ?, ?, ?)
    `).run(`session-${snapshotKey}`, snapshotKey, JSON.stringify(snapshot), Date.now());

    // A save under a NAMED key left every window pinned across all workspaces
    // out of that row (they are not the workspace's to save). Their home is
    // the default workspace's row, which boot restores — refresh its record of
    // them now, so a pin created while this workspace is active is not lost
    // if the app quits before the default workspace is next active.
    if (workspaceKey !== DEFAULT_WORKSPACE_KEY) {
      const unfiltered = serializeSession({ ...projectionInput, workspaceKey: DEFAULT_WORKSPACE_KEY });
      refreshGlobalPinsInDefaultSnapshot(
        db,
        unfiltered.snapshot.windows.filter((d) => d.context?.pinScope === 'global'),
        reason,
        createdAt,
      );
    }

    // Read existing metadata to preserve crashCount and restoreCount. The
    // metadata row is app-level (one row, never per workspace): it carries the
    // crash bookkeeping `markSessionDirty` / `readSessionCrashState` read at
    // boot, and a quit while a named workspace is active must still record
    // `cleanShutdown` where boot looks for it.
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
      // Deliberately the PRE-empty-URL-guard count, which is what this field
      // has always recorded (`projection.windowCount`), not
      // `snapshot.windows.length`.
      windowCount: projection.windowCount,
      cleanShutdown: opts?.cleanShutdown !== false,
      crashCount: existingMetadata.crashCount ?? 0,
      lastRestoreAt: existingMetadata.lastRestoreAt,
      restoreCount: existingMetadata.restoreCount,
      // The ACTIVE workspace, not `workspaceKey`: the switch's explicit save of
      // the outgoing workspace runs while that workspace is still active, and
      // every ambient save writes the active one's row anyway.
      activeWorkspaceKey: _activeWorkspaceKey,
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
    // (Iterating the PROJECTED windows — i.e. after the empty-URL guard — is
    // the same set the pre-projection loop pushed: a descriptor the guard
    // drops has an empty / about:blank / about:newtab URL, none of which can
    // be http(s) or peek://, so `isReopenable` was already false for it.)
    if (reason === 'before-quit') {
      suppressClosedWindowPush();
      for (const descriptor of snapshot.windows) {
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
      DEBUG && console.log(`[session] Pushed ${snapshot.windows.filter(d => {
        const isWeb = d.url.startsWith('http://') || d.url.startsWith('https://');
        const isPeek = d.url.startsWith('peek://');
        const isBg = d.url.includes('background.html');
        return isWeb || (isPeek && !isBg);
      }).length} open window(s) to closed window stack`);
    }
  } catch (error) {
    console.error('[session] Failed to save session snapshot:', error);
  }
}

/**
 * Append one open window to a workspace's saved snapshot row, keeping the
 * windows the row already holds. The window must already carry that
 * workspace's space membership (the save projection under a named key keeps
 * only windows scoped to it); a window that does not, or a window pinned
 * across every workspace, adds nothing. Creates the row when none exists.
 * Writes the row only — returns no saved URLs.
 */
export function addWindowToWorkspaceSnapshot(
  key: string,
  nativeWindowId: number,
): { success: boolean; added?: boolean; error?: string } {
  if (!key) return { success: false, error: 'key is required' };
  let db;
  try {
    db = getDb();
  } catch {
    return { success: false, error: 'Database not available' };
  }

  const saveWindows = buildSessionSaveWindows(getAllWindows()).filter((w) => w.nativeId === nativeWindowId);
  if (saveWindows.length === 0) return { success: false, error: `Window ${nativeWindowId} not found` };

  const { kernelState, kernelOrder, topmostContentWindowId } = readKernelOrderFacts();
  const createdAt = Date.now();
  const projection = serializeSession({
    snapshot: kernelState,
    windows: saveWindows,
    getPresentation: (nativeId: number) => getWindowPresentation(nativeId),
    getContext: readSaveContext,
    registeredTileIds: getRegisteredTileIds(),
    reason: 'workspace-switch',
    createdAt,
    kernelOrder,
    topmostContentWindowId,
    workspaceKey: key,
  });
  if (projection.snapshot.windows.length === 0) {
    return { success: false, error: 'Window is not saveable into that workspace' };
  }

  const rowKey = snapshotRowKey(key);
  try {
    let existing: SessionSnapshot | null = null;
    const row = db.prepare(
      `SELECT value FROM feature_settings WHERE featureId = 'session' AND key = ?`
    ).get(rowKey) as { value: string } | undefined;
    if (row?.value) {
      const parsed: SessionSnapshot = JSON.parse(row.value);
      if (parsed.version === 1 && Array.isArray(parsed.windows)) existing = parsed;
    }
    const merged = addDescriptorsToSnapshot(existing, projection.snapshot.windows, key, 'workspace-switch', createdAt);
    db.prepare(`
      INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
      VALUES (?, 'session', ?, ?, ?)
    `).run(`session-${rowKey}`, rowKey, JSON.stringify(merged), Date.now());
    return { success: true, added: merged.windows.length > (existing?.windows.length ?? 0) };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Move every window of one workspace's saved snapshot into another's and drop
 * the source row, as when a space is deleted and its windows go to the
 * default space (`session-projection.ts mergeSnapshotIntoWorkspace`).
 * `targetSpace` is the space membership the moved windows carry from now on.
 * Rows only: live windows are the caller's business — save the source first
 * if it is open, and reopen the target afterwards if it is the active one,
 * since an ambient save of the active workspace rewrites its row from what is
 * on screen. Returns how many windows the target row gained.
 */
export function mergeWorkspaceSnapshotInto(
  fromKey: string,
  toKey: string,
  targetSpace: Record<string, unknown>,
): { success: boolean; moved?: number; error?: string } {
  if (!fromKey || !toKey) return { success: false, error: 'fromKey and toKey are required' };
  if (fromKey === toKey) return { success: false, error: 'cannot merge a workspace into itself' };
  if (fromKey === DEFAULT_WORKSPACE_KEY) return { success: false, error: 'the default workspace cannot be merged away' };
  let db;
  try {
    db = getDb();
  } catch {
    return { success: false, error: 'Database not available' };
  }
  const readRow = (rowKey: string): SessionSnapshot | null => {
    const row = db.prepare(
      `SELECT value FROM feature_settings WHERE featureId = 'session' AND key = ?`
    ).get(rowKey) as { value: string } | undefined;
    if (!row?.value) return null;
    const parsed: SessionSnapshot = JSON.parse(row.value);
    return parsed.version === 1 && Array.isArray(parsed.windows) ? parsed : null;
  };
  try {
    const fromRowKey = snapshotRowKey(fromKey);
    const toRowKey = snapshotRowKey(toKey);
    const source = readRow(fromRowKey);
    const target = readRow(toRowKey);
    const before = target?.windows.length ?? 0;
    if (source && source.windows.length > 0) {
      const merged = mergeSnapshotIntoWorkspace(target, source, toKey, targetSpace, Date.now());
      db.prepare(`
        INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
        VALUES (?, 'session', ?, ?, ?)
      `).run(`session-${toRowKey}`, toRowKey, JSON.stringify(merged), Date.now());
      db.prepare(`DELETE FROM feature_settings WHERE featureId = 'session' AND key = ?`).run(fromRowKey);
      return { success: true, moved: merged.windows.length - before };
    }
    db.prepare(`DELETE FROM feature_settings WHERE featureId = 'session' AND key = ?`).run(fromRowKey);
    return { success: true, moved: 0 };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Replace the default workspace's saved record of the windows pinned across
 * every workspace with the given descriptors, leaving the rest of that row
 * untouched. Called from a save under a NAMED key (see `saveSessionSnapshot`):
 * such a save never writes those pins into its own row, and the default row is
 * the one boot restores, so it is where a pin has to be for it to survive a
 * relaunch that happens while some other workspace is active.
 *
 * With no default row on disk yet, one is created holding only the pins — an
 * empty pin set then writes nothing, so a profile that never pinned anything
 * never gains a default row it did not have.
 */
function refreshGlobalPinsInDefaultSnapshot(
  db: ReturnType<typeof getDb>,
  globalPins: WindowDescriptor[],
  reason: SessionSnapshot['reason'],
  createdAt: number,
): void {
  const rowKey = snapshotRowKey(DEFAULT_WORKSPACE_KEY);
  try {
    let existing: SessionSnapshot | null = null;
    const row = db.prepare(
      `SELECT value FROM feature_settings WHERE featureId = 'session' AND key = ?`
    ).get(rowKey) as { value: string } | undefined;
    if (row?.value) {
      const parsed = JSON.parse(row.value) as SessionSnapshot;
      if (parsed?.version === 1 && Array.isArray(parsed.windows)) existing = parsed;
    }
    if (!existing && globalPins.length === 0) return;

    const kept = (existing?.windows ?? []).filter((d) => d.context?.pinScope !== 'global');
    const merged: SessionSnapshot = {
      version: 1,
      createdAt: existing?.createdAt ?? createdAt,
      reason: existing?.reason ?? reason,
      workspaceKey: DEFAULT_WORKSPACE_KEY,
      windows: [...kept, ...globalPins],
    };
    db.prepare(`
      INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
      VALUES (?, 'session', ?, ?, ?)
    `).run(`session-${rowKey}`, rowKey, JSON.stringify(merged), Date.now());
    DEBUG && console.log(`[session] Refreshed ${globalPins.length} cross-workspace pin(s) in the default workspace's snapshot`);
  } catch (error) {
    console.error('[session] Failed to refresh cross-workspace pins in the default snapshot:', error);
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

/**
 * Put each restored window on the desktop its snapshot recorded and, when the
 * space has no window on the active desktop, make the desktop of its focused
 * window the active one. The decision is `planDesktopRestore`; this only runs
 * it against the kernel's layout and issues the writes.
 *
 * Does nothing unless the backend can place windows (today's macOS and the
 * fallback provider cannot), so a restore on those behaves as it always did.
 * A switch is also skipped when the backend can place but not switch.
 */
async function applyDesktopRestore(
  restored: ReadonlyArray<{ id: number; desktop?: string; focused: boolean }>,
): Promise<void> {
  const executor = getKernelExecutorForApp();
  if (restored.length === 0 || !executor.canPlaceWindows()) {
    console.log(`[session] desktop-restore-skipped n=${restored.length} canPlace=${executor.canPlaceWindows()}`);
    return;
  }
  const state = executor.getState();
  const activeDesktop = state.screens[0]?.current ?? null;
  const plan = planDesktopRestore(restored, state, activeDesktop);
  console.log(
    `[session] desktop-restore-plan active=${activeDesktop} known=${state.desktops.map((d) => d.id).join(',')} ` +
      `saved=${restored.map((r) => r.desktop ?? '-').join(',')} targets=${plan.targets.map((t) => t ?? '-').join(',')} ` +
      `switchTo=${plan.switchTo} canShow=${executor.canShowDesktops()}`,
  );
  for (let i = 0; i < restored.length; i++) {
    const target = plan.targets[i];
    if (target === null || target === activeDesktop) continue;
    const machineId = getWindowIdFor(restored[i].id);
    if (machineId == null) {
      console.log(`[session] desktop-restore-place id=${restored[i].id} target=${target} result=no-machine-id`);
      continue;
    }
    const placed = await executor.placeWindowOnDesktop(machineId, target);
    console.log(`[session] desktop-restore-place id=${restored[i].id} target=${target} result=${placed}`);
  }
  if (plan.switchTo !== null && executor.canShowDesktops()) {
    const switchesBefore = executor.getState().desktopSwitchCount;
    const shown = await executor.showDesktop(plan.switchTo);
    // The OS notice for the switch lands after the switch call resolves, and the kernel treats
    // every window as off-desktop until its layout read covers it, so the focus raise that
    // follows would be dropped. Wait for the read (bounded) before returning.
    if (shown) {
      const outcome = await executor.awaitDesktopSwitchRead(switchesBefore);
      console.log(`[session] desktop-switch-settle outcome=${outcome} desktop=${plan.switchTo}`);
    }
  }
}

export async function restoreSessionSnapshot(
  prefs: Record<string, unknown>,
  crashState?: { cleanShutdown: boolean; crashCount: number },
  // Run under the test profile too. Set by the test bridges (entry.ts
  // `__peek_test.forceRestoreSession` / `forceColdStartRestoreSession`) and by
  // the workspace-switch caller (a real, user-initiated restore the desktop
  // specs drive end to end). This is the ONLY thing it bypasses.
  allowInTestProfile?: boolean,
  // COLD START signal — true ONLY for the app's boot restore (entry.ts). Kept
  // SEPARATE from `allowInTestProfile` (which is true for BOTH in-app
  // forceRestoreSession AND test specs, so it cannot distinguish boot from an
  // in-session restore). At cold start the focused descriptor is activated even
  // if the macOS startup dance transiently flipped appFocused false; in-session
  // restore keeps honoring appFocused so a switched-away user isn't yanked back.
  // See planRestoreFocus() in window-kernel-executor.ts. Crash recovery (the
  // dialog, the crash-loop skip) and the `restoreSession` preference are also
  // cold-start-only concerns — see below.
  isColdStart: boolean = false,
  // Which workspace's saved snapshot to restore — see `SessionSnapshot
  // .workspaceKey`. Boot restore (entry.ts) and a live workspace switch
  // (features/spaces/background.js) are the SAME call with a different key;
  // only the key changes, one code path either way.
  key: string = DEFAULT_WORKSPACE_KEY,
  // WORKSPACE-SWITCH signal — true ONLY for the `tile:session:restore-
  // workspace-snapshot` caller (a live workspace switch, entering or
  // returning to any workspace including the default). Kept SEPARATE from
  // `isColdStart` (which is false for a workspace switch AND for the
  // pre-existing interactive "Restore Previous Session" path,
  // `tile:session:restore-interactive` — so `!isColdStart` alone can't tell
  // them apart). A workspace switch never closes a globally-pinned window
  // (`features/spaces/background.js closeCurrentWorkspaceWindows()`), so it's
  // still open at restore time and reopening it would duplicate it; interactive restore
  // has no such guarantee — the user may have closed that window first and
  // the restore dialog explicitly offers to bring it back.
  isWorkspaceSwitch: boolean = false,
): Promise<{ restored: number; failed: number; total: number; globalPinsRestored: number }> {
  // `globalPinsRestored` counts, out of `restored`, the windows pinned across
  // every workspace. Boot (entry.ts) reads it to tell "the user's session came
  // back" from "only the pins did" — the latter still opens the startup
  // feature, the same as when pins were restored by their own boot call.
  const result = { restored: 0, failed: 0, total: 0, globalPinsRestored: 0 };
  // Cold-start-only: when the user asked NOT to restore the session (the
  // `restoreSession` preference, or declining the crash-recovery dialog), the
  // windows pinned across every workspace still come back — a global HUD
  // window is not "the previous session", it is a standing fixture, and it has
  // always been restored at boot independent of the session snapshot. It
  // lives in the same default-workspace row, so this is the same restore
  // narrowed to those descriptors rather than a second persisted list.
  let globalPinsOnly = false;

  // Reset drift-detection counters for this restore pass. Tests read them
  // afterward to verify the app-active gate held — see counter
  // declaration above.
  resetRestoreFocusCounters();
  // Clear any stale cold-start re-raise latch from a prior restore; this pass
  // re-arms it only if it activates the focused descriptor at cold start.
  // Feed the kernel (window-kernel-dispatch.ts) — this is what drives the
  // window manager.
  kernelArmColdStartFocus(null);

  // Skip restore in test environments unless the caller says otherwise (used
  // by session-restore Playwright specs that drive save+restore directly, and
  // by the workspace-switch caller).
  if (isTestProfile() && !allowInTestProfile) {
    DEBUG && console.log('[session] Skipping session restore in test profile');
    return result;
  }

  // Check restoreSession pref
  if (prefs.restoreSession === false) {
    DEBUG && console.log('[session] Session restore disabled by pref');
    if (!isColdStart) return result;
    globalPinsOnly = true;
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

  // Check crash detection — show dialog or narrow the restore. Crash recovery
  // is a boot-only concept (the dialog asks whether the APP crashed last
  // time), so it runs only at cold start. Neither a live workspace switch
  // (`features/spaces/background.js` — including returning to the default
  // workspace, which restores the same default row boot does) nor the
  // interactive "Restore Previous Session" command is a boot, and neither
  // may raise it.
  if (isColdStart && !globalPinsOnly) {
    // Use the pre-read crashState (captured before markSessionDirty) if
    // provided, otherwise fall back to reading current metadata.
    try {
      let wasCleanShutdown = true;
      let crashCount = 0;

      if (crashState) {
        // Use pre-read state (startup path — read before markSessionDirty contaminated it)
        wasCleanShutdown = crashState.cleanShutdown;
        crashCount = crashState.crashCount;
      } else {
        // Fallback: read current metadata
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
          DEBUG && console.log('[session] User chose to start fresh (or too many crashes) — restoring only cross-workspace pins');
          globalPinsOnly = true;
        }
      }
    } catch {
      // Continue with restore if metadata check fails
    }
  }

  // Boot reopens the workspace that was active at quit. Its own row holds its
  // windows; the windows pinned across every workspace live only in the
  // default row (a named save leaves them out), so that row is read too,
  // narrowed to those pins. The pref-off and declined-crash paths
  // (`globalPinsOnly`) restore the default's pins and stay on the default.
  let restoreKey = key;
  if (isColdStart && !globalPinsOnly && !isWorkspaceSwitch && key === DEFAULT_WORKSPACE_KEY) {
    const saved = restorableSavedWorkspaceKey(db);
    if (saved) {
      restoreKey = saved;
      setActiveWorkspaceKey(saved);
      console.log(`[session] cold-start-workspace key=${saved}`);
    }
  }

  // Read the snapshot
  const snapshotDb = db;
  const readSnapshotRow = (workspaceKey: string): SessionSnapshot | null => {
    const row = snapshotDb.prepare(
      `SELECT value FROM feature_settings WHERE featureId = 'session' AND key = ?`
    ).get(snapshotRowKey(workspaceKey)) as { value: string } | undefined;
    return row?.value ? (JSON.parse(row.value) as SessionSnapshot) : null;
  };
  let snapshot: SessionSnapshot;
  try {
    const row = readSnapshotRow(restoreKey);

    if (!row) {
      DEBUG && console.log(`[session] No snapshot found for workspace "${restoreKey}"`);
      return result;
    }

    snapshot = row;
    if (restoreKey !== key) {
      const defaultRow = readSnapshotRow(key);
      const pins = (defaultRow?.version === 1 && Array.isArray(defaultRow.windows) ? defaultRow.windows : [])
        .filter((d) => d.context?.pinScope === 'global');
      snapshot = { ...row, windows: [...pins, ...(row.windows ?? [])] };
    }
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
    // Defense in depth, same reasoning as the overlay skip above: drop any
    // no-persist descriptor that snuck into an older snapshot saved before
    // the save-side filter (`session-projection.ts serializeSession()`)
    // excluded it — the workspace panel (`role: 'panel'`) and anything else
    // opened with `persist: false` (`features/spaces/background.js`
    // `showPanel()`/`showBorder()`). Restoring one reopens an orphaned copy
    // nothing owns (specs/workspace-panel-orphan.md requirement 4).
    const persistFlag = (descriptor.params as Record<string, unknown> | undefined)?.persist;
    if (role === 'panel' || persistFlag === false) {
      DEBUG && console.log(`[session] Skipping stale no-persist window in snapshot: ${descriptor.url || '(empty)'}`);
      return false;
    }
    // A window pinned across every workspace is never closed by a workspace
    // switch (`features/spaces/background.js closeCurrentWorkspaceWindows()`
    // skips it), so it is still open at this point in a workspace-switch
    // restore — reopening it here
    // would duplicate it. This is narrower than "any non-cold-start restore":
    // the pre-existing interactive "Restore Previous Session" path
    // (`tile:session:restore-interactive`) is ALSO non-cold-start but carries
    // no such guarantee — the user may have closed that pinned window before
    // asking to restore, and the dialog explicitly offers to bring it back.
    // Only `isWorkspaceSwitch` (set solely by the workspace-switch caller)
    // skips it; a plain non-cold-start restore with that flag unset (manual
    // restore, interactive restore) restores it normally, same as cold start.
    if (isWorkspaceSwitch && descriptor.context?.pinScope === 'global') {
      DEBUG && console.log(`[session] Skipping already-open cross-workspace pin: ${descriptor.url || '(empty)'}`);
      return false;
    }
    // The user declined the session itself (see `globalPinsOnly`): only the
    // windows pinned across every workspace come back.
    if (globalPinsOnly && descriptor.context?.pinScope !== 'global') {
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

  // Lazy restore: only the descriptors whose recorded desktop is the current
  // one (or unrecorded, or gone from the layout) open now; the rest are held,
  // grouped by desktop, and open when a desktop read reports arrival there
  // (see the hold section above). With no desktop reads (no provider,
  // headless, tests) the kernel knows no current desktop and everything opens
  // now — the pre-lazy behavior, unchanged. When the focused descriptor is
  // held, `planLazyRestore` hands focus to the top-of-stack openNow window;
  // the held descriptor applies its own focus when its group opens.
  // At launch no desktop read has happened yet, so the current desktop is
  // unknown; read once first (bounded) so windows recorded elsewhere are held.
  const restoreExecutor = getKernelExecutorForApp();
  if (shouldReadDesktopBeforeRestore(restoreExecutor.getState().screens[0]?.current ?? null, restoreExecutor.canReadDesktops())) {
    const readStart = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        restoreExecutor.refreshDesktops('restore'),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, RESTORE_DESKTOP_READ_TIMEOUT_MS);
        }),
      ]);
    } catch {
      /* restore with what the kernel knows */
    } finally {
      if (timer) clearTimeout(timer);
    }
    console.log(
      `[session] restore-desktop-read current=${restoreExecutor.getState().screens[0]?.current ?? null} waited_ms=${Date.now() - readStart}`,
    );
  }
  const kernelStateAtRestore = restoreExecutor.getState();
  const currentDesktopAtRestore = kernelStateAtRestore.screens[0]?.current ?? null;
  const { openNow, held } = planLazyRestore(
    validWindows,
    currentDesktopAtRestore,
    kernelStateAtRestore.desktops.map((d) => d.id),
  );
  installHeldRestore(restoreKey, held);
  if (held.size > 0) {
    console.log(
      `[session] lazy-restore-partition current=${currentDesktopAtRestore} openNow=${openNow.length} held=${validWindows.length - openNow.length}`,
    );
  }

  // `total` counts the whole valid session (held included); `restored`/`failed`
  // count only this pass's open attempts — a held window is neither.
  result.total = validWindows.length;
  DEBUG && console.log(`[session] Restoring ${openNow.length} of ${result.total} window(s) from snapshot`);

  // Wait for background window to be ready (needed for IPC)
  const bgWin = getBackgroundWindow();
  if (!bgWin || bgWin.isDestroyed()) {
    console.error('[session] Background window not available for restore');
    return result;
  }

  // Sort windows by zOrder (higher zOrder = higher in the saved stack — see
  // `SESSION_EAGER_RESTORE_COUNT`'s doc for why stack position, not focus
  // recency, is what this sorts by). Then hoist the focused window (if any)
  // to position 0 so it dispatches first and gets to spawn in low contention
  // — the rest follow after a short head-start window so the user-visible
  // focused window reaches interactive significantly faster than the rest.
  // See FOCUSED_HEAD_START_MS handling further down.
  //
  // This is the LOADING order only. The final on-screen stack is the saved one
  // replayed from `stackIndex` after the loop, so a window that was visually in
  // front but low in the loading order still loads late and still comes back
  // in front.
  const zOrderSorted = [...openNow].sort((a, b) => b.zOrder - a.zOrder);
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
  // Every window we successfully restore + show active, paired with the
  // stacking position its descriptor recorded. Feeds the machine's
  // STACK_ORDER_IMPORTED (the saved stack replayed) in the willActivate block
  // below.
  const restoredWindows: RestoredStackEntry[] = [];
  // The same windows with the desktop each recorded, for `applyDesktopRestore`.
  const restoredDesktops: Array<{ id: number; desktop?: string; focused: boolean }> = [];
  // Subset of restoredWindows that are hybrid page-hosts (BaseWindow +
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
    const original = unmaximizedRestoreDescriptor(orderedWindows[i]);
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
      // the window's position in the zOrder-sorted loading order (`i >=
      // eagerCount` below). A stale restoreBlank baked into an older
      // snapshot's params must not override that — it would pin the window to
      // deferred restore forever.
      for (const [key, value] of Object.entries(descriptor.params)) {
        if (!RESTORE_STRIP_KEYS.has(key)) {
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

      // A pinned window (workspace-scoped or global) restores directly onto
      // the Pinned layer, the same way `features/spaces/background.js
      // enterWorkspace()`'s own reopen loop used to for a workspace-scoped
      // pin — layer is set at open time (window-kernel.ts), so restoring
      // unpinned and pinning after the fact would mean a second close+reopen
      // right after this one. The context row itself is re-applied below
      // alongside `mode`, so the badge/closeSpace()/save-side projections
      // read the SAME pin scope right after restore as before it.
      if (descriptor.context?.pinScope) {
        options.alwaysOnTop = true;
        options.pinScope = descriptor.context.pinScope;
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
      // `source` is the key namespace: `ipc.ts windowOpenHandler` stores it on
      // the window record and `main.ts findWindowsByKey(source, key)` matches on
      // it, so a restored window must carry the source that originally opened
      // it. Restoring everything under `WEB_CORE_ADDRESS` filed keyed windows
      // in the wrong namespace, and the owning feature's next open of the same
      // key missed the restored window and opened a duplicate. Fall back to the
      // core address only for a descriptor saved without one.
      const openResult = await invokeWindowOpen(
        { sender: bgWin.webContents },
        { source: descriptor.source || WEB_CORE_ADDRESS, url: descriptor.url, options },
      ) as { success: boolean; id?: number; error?: string };
      const windowMs = Date.now() - windowStartedAt;
      DEBUG && console.log(`[session] Window open result:`, JSON.stringify(openResult));

      const ok = !!(openResult && openResult.success && openResult.id);
      perWindowTimings.push({ url: descriptor.url, ms: windowMs, ok });
      console.log(`[session:perf] window-open ms=${windowMs} ok=${ok} mode=${i < eagerCount ? 'eager' : 'deferred'} url=${descriptor.url.substring(0, 100)}`);

      if (ok) {
        result.restored++;
        if (descriptor.context?.pinScope === 'global') result.globalPinsRestored++;
        if (openResult.id != null) {
          restoredWindows.push({ id: openResult.id, stackIndex: readStackIndex(descriptor) });
          restoredDesktops.push({
            id: openResult.id,
            ...(descriptor.desktop !== undefined ? { desktop: descriptor.desktop } : {}),
            focused: descriptor.focused === true,
          });
        }

        // Attach did-finish-load / did-fail-load listeners to measure the
        // renderer-boot tail. Listener is attached after invokeWindowOpen
        // returns; loadURL fires async so the events still land here.
        if (openResult.id != null) {
          const restoredId = openResult.id;
          const restoredUrl = descriptor.url;
          const win = getLiveWindow(restoredId);
          if (win && !win.isDestroyed()) {
            // Show now that the window exists — ALWAYS inactive, regardless
            // of app-focus state. The restore loop NEVER activates: an
            // activating .show() here queues an async native macOS focus
            // event per window (ElectronWindowBackend's per-window 'focus'
            // listener → OS_FOCUS_GAINED → applyFocusGained), and the LAST
            // one to land steals the machine's `front` from the focused
            // descriptor the post-loop authority just activated. Activation
            // belongs EXCLUSIVELY to the post-loop willActivate block (the
            // single activation point) — same rule the hybrid path already
            // follows (restored hybrid hosts open inactive; only the focused
            // descriptor is activated after the loop). showWindowHeadlessSafe
            // routes through the machine (WINDOW_SHOW_REQUESTED activate:false
            // → backend showInactive()), so headless runs still don't flash
            // windows onto the real display (setOpacity(0) before the show).
            showWindowHeadlessSafe(win);
            _restoreShowInactiveCount++;

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

  // Windows go to their saved desktops, and the user to the space's desktop,
  // before the focus block below raises the focused window. Best-effort: a
  // failed write leaves the window where it opened.
  try {
    await applyDesktopRestore(restoredDesktops);
  } catch (err) {
    console.warn('[session] desktop restore failed:', err);
  }

  // Focus the window that was focused at save time — but only if Peek is
  // still the OS-frontmost app. If the user switched away mid-restore,
  // activating it would yank them back. Best-effort either way.
  //
  // Restore-time focus authority is the window-state machine (step 8a/8b):
  // enterOverlay seeds preOverlayFocusTarget from the machine's `front`,
  // which restore drives deterministically through its own machine-routed
  // show dispatches (every loop show is a WINDOW_SHOW_REQUESTED whose
  // backend synchronously echoes WINDOW_SHOWN, and the hybrid focused
  // descriptor activates through showHybridHost's dispatch). The old
  // coordinator-side restore focus guard (and its deterministic seed of
  // `session.focusedWindowId`) was deleted in step 8b; that tracker is now
  // fed only by the async OS focus events, and step 8c deletes it.
  if (focusedWindowId) {
    try {
      // Resolve the focused window. A hybrid page-host is a BaseWindow, so
      // getLiveWindow (BrowserWindow.fromId) returns null for it — fall back to
      // the hybrid registry's baseWin. Without this, the web page the user left
      // in front is never raised on restore and Settings (or whatever
      // BrowserWindow restored last) stays frontmost.
      const focusWin = getLiveWindow(focusedWindowId);
      const hybridFocus = focusWin ? null : getHybridWindow(focusedWindowId);

      // Decide whether to RAISE+ACTIVATE the focused descriptor. At cold start
      // Peek is launching and should own the foreground even if the macOS
      // startup dance transiently flipped app-active false (the two converged
      // bugs: z-order peek 7bb74c90 + not-frontmost peek 8f7010a8). In-session
      // restore honors app-active so a switched-away user isn't yanked back.
      // Headless never activates (focus-free). See izui-roles.ts.
      //
      // App-active comes from the window-state machine (`AppWindowState.appActive`,
      // fed by the backend's did-become/resign-active listeners), NOT from
      // `getIzuiCoordinator().isAppFocused()` — that was a third, rival copy of
      // the same OS state (§4.4 dim 6). Both mirrors are driven by the same two
      // app events, so the value is the same; the machine's is the one the rest
      // of the restore path (stacking, front arbitration) already reads.
      // The rule and both of its live inputs belong to the executor now
      // (`window-kernel-executor.ts planRestoreFocus`): app-active is kernel
      // state, and whether this run is focus-free is the executor's own
      // injected fact. This seam supplies the one thing neither of them knows —
      // which restore this is — and reads back the answer.
      const appActive = getAppActive();
      const activeBeforeSwitch = isWorkspaceSwitch && _workspaceSwitchInFlight && _appActiveAtSwitchStart;
      const willActivate = getKernelExecutorForApp().shouldRestoreFocus(isColdStart, activeBeforeSwitch);
      // Always-on (non-DEBUG) decision log: the original diagnosis rested on an
      // ABSENCE of logs (the gated block was silently skipped). Make the
      // decision self-evident in prod main.log for any future occurrence.
      console.log(`[session] restore-focus-decision coldStart=${isColdStart} appActive=${appActive} headless=${isHeadless()} willActivate=${willActivate} focusedId=${focusedWindowId} activeBeforeSwitch=${activeBeforeSwitch} planRestoreActivation=${planRestoreActivation(isColdStart, activeBeforeSwitch) ?? 'none'}`);

      // Arm the one-shot cold-start re-raise latch BEFORE touching windows: a
      // trailing did-resign-active could re-strand Peek after this block runs.
      // Gated cold-start + non-headless + a window actually present to raise.
      // The latch itself lives in the kernel (see the note above the restore
      // section); this is only the decision to arm it.
      if (isColdStart && !isHeadless() && (focusWin || (hybridFocus && !hybridFocus.baseWin.isDestroyed()))) {
        const coldStartMachineId = getWindowIdFor(focusedWindowId);
        if (coldStartMachineId != null) {
          // Feed the kernel (window-kernel-dispatch.ts) — this is what drives
          // the window manager.
          kernelArmColdStartFocus(coldStartMachineId);
        }
      }

      if (willActivate) {
        // Reproduce the FULL saved stacking order — not just the focused window.
        // During the loop, internal-tile BrowserWindows were show()'d active (each
        // orderFront'd over the previous) and hybrid page-hosts were shown INACTIVE,
        // so the post-loop on-screen stack bears no relation to how the user left
        // it: internal tiles float above the web pages the user had in front.
        //
        // §5 step 5 part B: the machine owns ordering now. Import the saved stack
        // BOTTOM→TOP, ordered by the position each descriptor recorded
        // (`stackIndex`, its position in the kernel's single order at save
        // time — see `session-projection.ts`), so the windows come back in
        // the order that was literally on screen. A snapshot written before
        // descriptors carried positions falls back to the old focus-recency
        // rebuild — a fact the kernel no longer tracks at all, which is why
        // this fallback can only replay dispatch order rather than genuinely
        // reconstruct recency — see `orderRestoredWindowsBottomToTop`. The
        // kernel replaces its `order` with this order and emits SetStacking
        // per window bottom→top — relative raises only, no activation, no focus
        // steal; only the focused window (activated LAST, below) becomes
        // key/first-responder. Page-hosts that have not composited yet no-op
        // natively and converge via the `hybrid:first-frame` →
        // WINDOW_CONTENT_ORDERABLE producer as each becomes orderable.
        // Deterministic ordered pass, no timer. Gated by willActivate: skips
        // headless AND the switched-away case, so we never yank the user back.
        const savedOrderBottomToTop: WindowId[] = [];
        for (const id of orderRestoredWindowsBottomToTop(restoredWindows)) {
          const machineId = getWindowIdFor(id);
          if (machineId != null) savedOrderBottomToTop.push(machineId);
        }
        // Feed the kernel (window-kernel-dispatch.ts) — this is what drives
        // the window manager.
        kernelImportStackOrder(savedOrderBottomToTop);
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
        //
        // §5 step 11: the BrowserWindow branch now converges on the SAME route.
        // There is no focus-request event in the machine, and none is needed
        // here — the loop already showed this window (inactive), so an
        // activating show IS the activation: `WINDOW_SHOW_REQUESTED
        // {activate:true}` → SHOW_WINDOW → the backend's `win.show()`
        // (makeKeyAndOrderFront), which is what a bare focus() did plus the
        // order-front the rebuilt stack already wants. It also echoes
        // WINDOW_SHOWN{focused:true}, so the machine's `front` is set
        // synchronously rather than waiting on the async OS focus event —
        // the same contract the hybrid branch below has had since step 6A-2.
        //
        // At cold start the app itself may not be the OS-active app yet (the
        // launch can land before or straddle the startup activation dance),
        // and `win.show()`/`makeKeyAndOrderFront` does not activate an app
        // another app has displaced (docs/design/window-manager.md, "The
        // palette summoned from another app was on screen but dead"). Cold
        // start therefore carries the same `activation: 'user'` intent the
        // palette's own user-summoned show carries, so
        // `electron-window-backend.ts raiseWindow` takes its
        // `app.focus({ steal: true })` branch instead of a bare show. Warm,
        // in-session restore never reaches this branch unless the app is
        // already active (`planRestoreFocus`), so leaving it unstolen there
        // changes nothing.
        const restoreIntent = planRestoreActivation(isColdStart, activeBeforeSwitch);
        const activation = restoreIntent ? ({ activation: restoreIntent }) : undefined;
        if (focusWin) {
          showWindowHeadlessSafe(focusWin, { active: true, ...activation });
          _restoreFocusCount++;
          _restoreFocusedId = focusedWindowId;
          DEBUG && console.log(`[session] Focused restored window: ${focusedWindowId}`);
        } else if (hybridFocus && !hybridFocus.baseWin.isDestroyed()) {
          showHybridHost(hybridFocus.baseWin, activation);
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

  // Update session metadata with restore info and reset crashCount. Not when
  // the user declined the session and only the cross-workspace pins came back
  // (`globalPinsOnly`): that was not a restore of the session, and resetting
  // the crash count there would let a crash loop escape the dialog's
  // escalation.
  if (!globalPinsOnly) try {
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
    // The user may have arrived on a held group's desktop while the loop was
    // still running (releases are refused mid-restore and only re-checked on
    // kernel notifications) — check once against the current state now.
    if (_heldRestore !== null) {
      maybeReleaseHeldGroup(_heldRestore, getKernelExecutorForApp().getState());
    }
  }
}

// ============================================================================
// Phase 3: Autosave Timer
// ============================================================================

// Module state, not window state: the handle of this module's own periodic
// timer plus the interval it was started with (so a prefs change can tell a
// real change from a no-op restart). Nothing about a window; the reducer never
// schedules, so a timer could not live there anyway.
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
    void refreshDesktopsBeforeSave().then(() => saveSessionSnapshot('autosave'));
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

/**
 * Read the bounds/z-order a NAMED workspace's saved snapshot has for each of
 * its windows, without restoring anything — used by `features/groups/home.js
 * openGroup()` to reopen a group's windows in their last-saved layout.
 *
 * Refuses `DEFAULT_WORKSPACE_KEY`: this is a narrow read of one workspace's
 * own row, not a general foreign-settings read. Widening it to the default
 * key would hand a feature tile the app's own last-quit window list — exactly
 * what routing this through the general `tile:settings:get-foreign` surface
 * (gated only per-featureId, not per-key) would have exposed. The rule is
 * ENFORCED in `tile-session-enforcement.ts checkSessionAllowed` (given the
 * key), alongside every other session capability check; the guard here is
 * defense in depth for a direct main-process caller. Returns `null` for the
 * default key, a missing/invalid snapshot, or a read error.
 */
export function getWorkspaceSnapshotWindowInfo(
  key: string,
): { url: string; bounds: { x: number; y: number; width: number; height: number }; zOrder: number }[] | null {
  if (!key || key === DEFAULT_WORKSPACE_KEY) return null;
  try {
    const db = getDb();
    const row = db.prepare(
      `SELECT value FROM feature_settings WHERE featureId = 'session' AND key = ?`
    ).get(snapshotRowKey(key)) as { value: string } | undefined;

    if (!row?.value) return null;

    const snapshot: SessionSnapshot = JSON.parse(row.value);
    if (snapshot.version !== 1 || !Array.isArray(snapshot.windows)) return null;

    return snapshot.windows
      .filter((d) => isValidDescriptor(d) && d.url && d.bounds)
      .map((d) => ({ url: d.url, bounds: d.bounds, zOrder: d.zOrder ?? 0 }));
  } catch {
    return null;
  }
}

/**
 * The desktops a workspace's saved windows were recorded on — one entry per
 * saved window that carries a `desktop` (the kernel's last placement at save
 * time, written by `serializeSession`). Duplicates kept: the desktop-choice
 * rule counts windows per desktop. The default key is allowed — unlike
 * `getWorkspaceSnapshotWindowInfo` this exposes no URLs or bounds, and it is
 * read main-side by the raise gate, never returned to a tile. `null` for a
 * missing/invalid snapshot or a read error.
 */
export function getWorkspaceSnapshotDesktops(key: string): string[] | null {
  if (!key) return null;
  try {
    const db = getDb();
    const row = db.prepare(
      `SELECT value FROM feature_settings WHERE featureId = 'session' AND key = ?`
    ).get(snapshotRowKey(key)) as { value: string } | undefined;
    if (!row?.value) return null;
    const snapshot: SessionSnapshot = JSON.parse(row.value);
    if (snapshot.version !== 1 || !Array.isArray(snapshot.windows)) return null;
    return snapshot.windows
      .filter((d) => isValidDescriptor(d) && typeof (d as { desktop?: unknown }).desktop === 'string')
      .map((d) => (d as unknown as { desktop: string }).desktop);
  } catch {
    return null;
  }
}

/**
 * How many windows a workspace's saved snapshot holds — the default
 * workspace included, since a bare count exposes none of the saved URLs
 * (`getWorkspaceSnapshotWindowInfo` refuses the default key for that reason).
 * Counts the same windows a restore would reopen. Returns `null` for a
 * missing/invalid snapshot or a read error. Descriptors whose url starts with
 * any `excludeUrlPrefixes` entry are skipped.
 */
export function getWorkspaceSnapshotWindowCount(key: string, excludeUrlPrefixes: string[] = []): number | null {
  if (!key) return null;
  try {
    const db = getDb();
    const row = db.prepare(
      `SELECT value FROM feature_settings WHERE featureId = 'session' AND key = ?`
    ).get(snapshotRowKey(key)) as { value: string } | undefined;
    if (!row?.value) return null;
    const snapshot: SessionSnapshot = JSON.parse(row.value);
    if (snapshot.version !== 1 || !Array.isArray(snapshot.windows)) return null;
    return countDescriptorsExcludingPrefixes(snapshot.windows.filter(isValidDescriptor), excludeUrlPrefixes);
  } catch {
    return null;
  }
}
