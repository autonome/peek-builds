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
