/**
 * Partition a session snapshot's window descriptors for lazy restore: which
 * open immediately on the launch desktop, and which are held until the user
 * arrives on their recorded desktop. Under public APIs a window's desktop is
 * decided by where the user is when it opens, so being present at open time
 * is the only placement mechanism — held groups open when a desktop-change
 * read reports arrival on their desktop.
 *
 * Rules (docs/design/space-desktop-return-plan.md):
 * - no recorded desktop → open now (nothing to hold for);
 * - recorded desktop absent from the layout → open now (desktops can be
 *   deleted or rearranged while the app is down);
 * - recorded desktop is the current one → open now;
 * - otherwise hold, grouped by recorded desktop;
 * - no current desktop known → open everything now (with no desktop reads
 *   there is no arrival signal to release a held group).
 *
 * Order is preserved: `openNow` keeps snapshot order, and so does each held
 * group internally.
 *
 * Electron-free on purpose (the `space-desktop-choice.ts` pattern), so the
 * main-process unit runner can import the real implementation.
 */
export interface RestorePartition<T> {
  openNow: T[];
  held: Map<string, T[]>;
}

export function partitionRestoreByDesktop<T extends { desktop?: string }>(
  descriptors: readonly T[],
  current: string | null,
  desktopOrder: readonly string[],
): RestorePartition<T> {
  const openNow: T[] = [];
  const held = new Map<string, T[]>();
  for (const descriptor of descriptors) {
    const recorded = descriptor.desktop;
    if (
      current === null ||
      recorded === undefined ||
      recorded === current ||
      !desktopOrder.includes(recorded)
    ) {
      openNow.push(descriptor);
      continue;
    }
    const group = held.get(recorded);
    if (group) group.push(descriptor);
    else held.set(recorded, [descriptor]);
  }
  return { openNow, held };
}
