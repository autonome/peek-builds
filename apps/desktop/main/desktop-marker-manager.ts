/**
 * Per-desktop marker windows — the wiring for the decisions in
 * `desktop-markers.ts`. One persistent 2x2 signal window per visited desktop,
 * owned by the desktop rather than by a space
 * (docs/design/space-desktop-return-plan.md):
 *
 * - minted on arrival: every kernel notification whose current desktop is in
 *   the layout and unmarked opens one there (`shouldMintMarker`) — being
 *   present at open time is the only placement mechanism public APIs allow.
 *   The same sync runs once at install, which covers the launch desktop.
 * - swept on layout change: a marker whose desktop left the layout closes
 *   (`markersToSweep`).
 * - raised on space entry: the `tile:window:focus` named branch
 *   (tile-ipc.ts) resolves the TARGET desktop's marker via
 *   `planSpaceMarkerRaise` and raises it — markers are never closed on space
 *   entry; they replaced the per-space signal windows the spaces feature
 *   used to open and close around each switch (removed from
 *   features/spaces/background.js, which now only issues the keyed raise —
 *   `switchToSpaceDesktop()`).
 *
 * Markers load `peek://spaces/signal.html` (role `signal` keeps them out of
 * session saves — session-projection.ts serializeSession; signal.html, never
 * the home UI's URL, which collided with URL-keyed selectors, see
 * `3818282e`). Unlike the retired per-space signal windows they are
 * non-focusable — see the mint options below for why.
 *
 * Same executor-subscription pattern as `session.ts installHeldRestore()`.
 * Headless runs (Playwright, CI) mint nothing — see the guard in
 * `installDesktopMarkerManager()`. (On macOS the real desktop helper runs
 * even under the test harness, so "no desktop provider in tests" is NOT a
 * safety net; the headless gate is.)
 */
import { shouldMintMarker, markersToSweep } from './desktop-markers.js';
import { getKernelExecutorForApp } from './window-machine.js';
import type { State } from './window-kernel.js';
import { invokeWindowOpen } from './ipc.js';
import { getBackgroundWindow } from './main.js';
import { getLiveWindow } from './window-registry.js';
import { closeOrHideWindow } from './windows.js';
import { WEB_CORE_ADDRESS, isHeadless } from './config.js';

const MARKER_URL = 'peek://spaces/signal.html';

/** Desktop id → Electron window id of its marker. */
const _markers = new Map<string, number>();
/** Desktops whose marker open is still in flight — counts as marked. */
const _mintInFlight = new Set<string>();
let _installed = false;
let _stopped = false;

/**
 * Stop minting for the rest of the process. Called at the start of quit: the
 * quit closes every window, a marker-less current desktop then reads as
 * "mint", and a marker opened mid-quit keeps the app alive.
 */
export function stopDesktopMarkerManager(): void {
  _stopped = true;
}

/**
 * The live marker map for raise planning (`planSpaceMarkerRaise`). Pruned on
 * read: a marker window closed out from under the manager (quit sweep, test
 * teardown) must read as "no marker", never as a raise target.
 */
export function getDesktopMarkers(): ReadonlyMap<string, number> {
  pruneDeadMarkers();
  return _markers;
}

function pruneDeadMarkers(): void {
  for (const [desktop, id] of _markers) {
    const win = getLiveWindow(id);
    if (!win || win.isDestroyed()) _markers.delete(desktop);
  }
}

/**
 * Subscribe to kernel notifications and run one sync against the current
 * state (the launch desktop's mint — the kernel's first layout read may
 * already have landed, in which case no further notification is coming).
 * Idempotent; the subscription lives for the process.
 */
export function installDesktopMarkerManager(): void {
  if (_installed) return;
  // Headless runs mint nothing: a marker exists solely to be raised so macOS
  // pulls the user to its desktop, and a headless (CI/agent) run has no user
  // to pull and suppresses every other OS-focus surface by the same contract
  // (headless-policy.ts). Minting there only perturbed the suite — the boot
  // inventory counted the marker as a new resident window, and marker churn
  // interleaved with transient sweeps in focus-sensitive specs.
  if (isHeadless()) return;
  _installed = true;
  const executor = getKernelExecutorForApp();
  executor.subscribe((state) => {
    void syncMarkers(state);
  });
  void syncMarkers(executor.getState());
}

/**
 * One cheap, idempotent pass: sweep markers whose desktop left the layout,
 * then mint on the current desktop if it is unmarked. Runs on every kernel
 * notification, so a non-matching state is a no-op.
 */
async function syncMarkers(state: State): Promise<void> {
  if (_stopped) return;
  const desktopOrder = state.desktops.map((d) => d.id);
  const current = state.screens[0]?.current ?? null;
  pruneDeadMarkers();
  for (const { desktop, marker } of markersToSweep(_markers, desktopOrder)) {
    _markers.delete(desktop);
    console.log(`[desktop-markers] marker-swept desktop=${desktop} window=${marker}`);
    void closeOrHideWindow(marker, 'desktop-marker-sweep').catch(() => {});
  }
  const marked = new Set([..._markers.keys(), ..._mintInFlight]);
  if (current === null || !shouldMintMarker(current, desktopOrder, marked)) return;
  if (!invokeWindowOpen) return; // window handlers not registered yet; a later notification retries
  const bgWin = getBackgroundWindow();
  if (!bgWin || bgWin.isDestroyed()) return;
  _mintInFlight.add(current);
  try {
    const result = (await invokeWindowOpen(
      { sender: bgWin.webContents },
      {
        source: WEB_CORE_ADDRESS,
        url: MARKER_URL,
        options: {
          role: 'signal',
          width: 2,
          height: 2,
          x: 0,
          y: 0,
          transparent: true,
          // Non-focusable, deliberately: a marker takes no input, and the
          // kernel's accounting follows from that declaration. A focusable
          // marker's open hands it kernel key (the fresh-open shown/focused
          // report), so with another app frontmost every later page open read
          // as "key held while app inactive" and opened TRANSIENT — then the
          // next marker mint's show swept it mid-load (destroying a user's
          // window; caught by session-restore-focus.spec cold-start). A
          // non-focusable window is never transient, never holds key, and its
          // show sweeps nothing. OPEN QUESTION for live verification: whether
          // the space-entry raise of a non-focusable window still pulls a
          // macOS desktop switch — if the switch needs the marker to take
          // focus, this needs a different inertness mechanism, not focusable.
          focusable: false,
          skipTaskbar: true,
          show: true,
        },
      },
    )) as { success: boolean; id?: number; error?: string };
    if (result?.success && result.id != null) {
      _markers.set(current, result.id);
      console.log(`[desktop-markers] marker-minted desktop=${current} window=${result.id}`);
    } else {
      console.warn(`[desktop-markers] marker open failed desktop=${current}:`, result?.error);
    }
  } catch (err) {
    console.error(`[desktop-markers] marker open error desktop=${current}:`, err);
  } finally {
    _mintInFlight.delete(current);
  }
}
