/**
 * Per-desktop marker decisions: one persistent marker window per visited
 * desktop, owned by the desktop rather than by a space
 * (docs/design/space-desktop-return-plan.md). A marker is minted when the
 * user arrives on a desktop that has none (desktop-change read, and startup
 * on the launch desktop), swept when its desktop leaves the layout, and
 * raised on space entry to switch macOS to the space's recorded desktop —
 * the only app-triggered desktop switch public APIs allow.
 *
 * Because the raised marker belongs to the TARGET desktop by construction,
 * the old per-space gate's `skip-mismatch` case (named window sitting on the
 * wrong desktop) cannot occur; its place is taken by `skip-no-marker` — the
 * target desktop has not been visited since launch, so no marker exists
 * there and no switch is possible (being present once is what mints one).
 *
 * Pure bookkeeping over a caller-owned map of desktop id → marker window;
 * nothing here opens, closes, or raises a window. Electron-free on purpose
 * (the `space-desktop-choice.ts` pattern), so the main-process unit runner
 * can import the real implementation.
 */
import { chooseSpaceDesktopTarget } from './space-desktop-choice.js';
import type { State } from './window-kernel.js';

/** The slice of the window kernel executor the marker sync listens to. */
export interface MarkerSyncSource {
  subscribe(listener: (state: State) => void): unknown;
  getState(): State;
}

/**
 * Wire a marker sync pass to the kernel: once on every notification, and
 * once now against the current state (the launch desktop — the kernel's
 * first layout read may already have landed, so no notification is coming).
 *
 * A notification-driven pass starts only after the notification returns,
 * for the reason `session.ts maybeReleaseHeldGroup()` defers its open: a
 * notification runs inside the executor's event pump, which queues any
 * command issued from it, so a marker opened synchronously there would have
 * its registration queued and its show rejected (`no-such-window`). The
 * deferred pass reads the kernel's state when it runs, not the state of the
 * notification that scheduled it. The install-time pass runs outside any
 * notification, so it runs at once.
 */
export function subscribeMarkerSync(source: MarkerSyncSource, sync: (state: State) => void): void {
  source.subscribe(() => {
    void Promise.resolve()
      .then(() => sync(source.getState()))
      .catch((err) => console.error('[desktop-markers] marker sync failed:', err));
  });
  sync(source.getState());
}

/**
 * Whether arriving on `current` should mint a marker there: a current
 * desktop is known, it is in the layout (a desktop outside the layout would
 * be swept straight back out), and no marker exists for it yet.
 */
export function shouldMintMarker(
  current: string | null,
  desktopOrder: readonly string[],
  marked: ReadonlySet<string>,
): boolean {
  if (current === null) return false;
  if (!desktopOrder.includes(current)) return false;
  return !marked.has(current);
}

/**
 * Whether the current desktop is one a window made by going fullscreen.
 * Such a desktop holds that one window and nothing else, and a marker shown
 * there would be given a desktop of its own by the platform; that desktop
 * is unmarked too, so every mint would start another (an endless loop).
 *
 * A window mid-entry counts wherever its recorded desktop says it is, since
 * the report of its new desktop has not landed yet. A settled fullscreen
 * window counts when its recorded desktop is the current one (or unknown).
 */
export function currentDesktopIsFullscreen(state: State): boolean {
  const current = state.screens[0]?.current ?? null;
  if (current === null) return false;
  return state.order.some((w) => {
    if (w.fsMode.name === 'entering') return true;
    if (w.fsMode.name !== 'fullscreen') return false;
    return w.desktop === undefined || w.desktop === current;
  });
}

/**
 * Whether a sync pass over `state` should mint a marker: the plain arrival
 * rule (`shouldMintMarker`), except never on a fullscreen desktop.
 */
export function shouldMintMarkerForState(state: State, marked: ReadonlySet<string>): boolean {
  const current = state.screens[0]?.current ?? null;
  const desktopOrder = state.desktops.map((d) => d.id);
  if (!shouldMintMarker(current, desktopOrder, marked)) return false;
  return !currentDesktopIsFullscreen(state);
}

/**
 * Markers whose desktop no longer exists in the layout — desktops can be
 * deleted or rearranged at any time, and a marker with no desktop has
 * nothing left to anchor. Returns them in map order for the caller to close
 * and forget. An empty layout is treated as "no layout read yet", not "every
 * desktop deleted": nothing is swept.
 */
export function markersToSweep<T>(
  markers: ReadonlyMap<string, T>,
  desktopOrder: readonly string[],
): Array<{ desktop: string; marker: T }> {
  if (desktopOrder.length === 0) return [];
  const swept: Array<{ desktop: string; marker: T }> = [];
  for (const [desktop, marker] of markers) {
    if (!desktopOrder.includes(desktop)) swept.push({ desktop, marker });
  }
  return swept;
}

/** The page every marker loads (never the home UI's URL — see `3818282e`). */
export const MARKER_URL = 'peek://spaces/signal.html';

/**
 * The window-open options a marker mints with. A marker never brings the app
 * to the front, so it is opened HIDDEN and put on screen afterwards by a
 * non-activating show request (`MARKER_SHOW`):
 *
 * - `show: false`: a window opened shown is put on screen by the platform's
 *   own construct-time show, which on macOS activates the app
 *   (`activateIgnoringOtherApps` + make-key-and-order-front) before the
 *   window kernel has any say. A mint fires on bare arrival at a desktop,
 *   usually while another app is frontmost, so that show stole the front on
 *   every first visit to a desktop.
 * - `focusable: false`: a marker takes no input. A focusable marker's open
 *   handed it kernel key, so with another app frontmost every later page open
 *   read as "key held while app inactive" and opened transient
 *   (`izui-roles.ts pageOpensTransient`), and the next mint's show swept that
 *   transient mid-load — a user window destroyed. A non-focusable window is
 *   never transient, never holds key, and its show sweeps nothing.
 *
 * - `fullscreenable: false`: a marker shown on a fullscreen desktop would
 *   otherwise be given a fullscreen desktop of its own, which is unmarked and
 *   so mints another marker, without end.
 *
 * Role `signal` keeps markers out of session saves
 * (`session-projection.ts serializeSession`).
 */
export function markerOpenOptions(): {
  role: 'signal';
  width: number;
  height: number;
  x: number;
  y: number;
  transparent: true;
  focusable: false;
  fullscreenable: false;
  skipTaskbar: true;
  show: false;
} {
  return {
    role: 'signal',
    width: 2,
    height: 2,
    x: 0,
    y: 0,
    transparent: true,
    focusable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
  };
}

/**
 * The show request that puts a minted marker on screen: through the window
 * kernel, never activating and never carrying a user-gesture intent, so the
 * kernel shows it without raising it and the app stays wherever it was.
 */
export const MARKER_SHOW: Readonly<{ active: false }> = Object.freeze({ active: false });

export type MarkerRaisePlan<T> =
  | { verdict: 'raise'; target: string; marker: T }
  | { verdict: 'skip-no-target'; target: null }
  | { verdict: 'skip-no-marker'; target: string };

/**
 * The marker a space entry should raise, from the space's recorded
 * per-window desktops. The target desktop comes from
 * `chooseSpaceDesktopTarget` (no switch when the space is at least partly on
 * the current desktop, else the recorded desktop holding the most windows);
 * the raised window is that DESKTOP's marker, so a mismatch between target
 * and marker desktop cannot arise. No target → `skip-no-target` (nothing
 * recorded, already here, or no recorded desktop survives in the layout); a
 * target without a marker → `skip-no-marker` (that desktop has not been
 * visited since launch, so nothing exists there to raise).
 */
export function planSpaceMarkerRaise<T>(
  recorded: readonly string[],
  current: string | null,
  desktopOrder: readonly string[],
  markers: ReadonlyMap<string, T>,
): MarkerRaisePlan<T> {
  const target = chooseSpaceDesktopTarget(recorded, current, desktopOrder);
  if (target === null) return { verdict: 'skip-no-target', target: null };
  const marker = markers.get(target);
  if (marker === undefined) return { verdict: 'skip-no-marker', target };
  return { verdict: 'raise', target, marker };
}
