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
 *   entry, unlike the per-space signal windows they replace
 *   (features/spaces/background.js).
 *
 * Markers load `peek://spaces/signal.html` with the same window options as
 * the per-space lifecycle used (role `signal` keeps them out of session
 * saves — session-projection.ts serializeSession; signal.html, never the
 * home UI's URL, which collided with URL-keyed selectors, see `3818282e`).
 *
 * Same executor-subscription pattern as `session.ts installHeldRestore()`.
 * Under test runs with no desktop provider the kernel state carries no
 * desktops, so nothing is ever minted.
 */
import { shouldMintMarker, markersToSweep } from './desktop-markers.js';
import { getKernelExecutorForApp } from './window-machine.js';
import type { State } from './window-kernel.js';
import { invokeWindowOpen } from './ipc.js';
import { getBackgroundWindow } from './main.js';
import { getLiveWindow } from './window-registry.js';
import { closeOrHideWindow } from './windows.js';
import { WEB_CORE_ADDRESS } from './config.js';

const MARKER_URL = 'peek://spaces/signal.html';

/** Desktop id → Electron window id of its marker. */
const _markers = new Map<string, number>();
/** Desktops whose marker open is still in flight — counts as marked. */
const _mintInFlight = new Set<string>();
let _installed = false;

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
          focusable: true,
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
