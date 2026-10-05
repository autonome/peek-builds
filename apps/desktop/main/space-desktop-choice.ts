/**
 * The desktop opening a space should take the user to, from the space's
 * recorded per-window desktops (docs/design/space-desktop-return-plan.md,
 * section 1.4):
 * - `null` (no switch) when any recorded window is on the current desktop —
 *   the space is at least partly already here;
 * - otherwise the recorded desktop holding the most windows, ties broken to
 *   the desktop nearest the current one in `desktopOrder` (the provider's
 *   layout order, which is the swipe order);
 * - `null` when nothing is recorded, no current desktop is known, or no
 *   recorded desktop still exists in the layout.
 *
 * Electron-free on purpose (the `session-save-filter.ts` pattern), so the
 * main-process unit runner can import the real implementation.
 */
export function chooseSpaceDesktopTarget(
  recorded: readonly string[],
  current: string | null,
  desktopOrder: readonly string[],
): string | null {
  if (current === null || recorded.length === 0) return null;
  const known = recorded.filter((d) => desktopOrder.includes(d));
  if (known.length === 0) return null;
  if (known.includes(current)) return null;
  const counts = new Map<string, number>();
  for (const d of known) counts.set(d, (counts.get(d) ?? 0) + 1);
  const currentIdx = desktopOrder.indexOf(current);
  let best: string | null = null;
  let bestCount = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [desktop, count] of counts) {
    const idx = desktopOrder.indexOf(desktop);
    const distance = currentIdx === -1 ? idx : Math.abs(idx - currentIdx);
    if (count > bestCount || (count === bestCount && distance < bestDistance)) {
      best = desktop;
      bestCount = count;
      bestDistance = distance;
    }
  }
  return best;
}
