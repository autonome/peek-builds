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

/**
 * The partition plus the focus rule: when the focused descriptor is held, the
 * top-of-stack openNow window (highest `zOrder`) takes focus for this launch —
 * a copy with `focused: true` replaces it, so the held descriptor keeps its
 * own focus flag and applies it when its group opens on arrival.
 */
export function planLazyRestore<
  T extends { desktop?: string; focused?: boolean; zOrder?: number },
>(
  descriptors: readonly T[],
  current: string | null,
  desktopOrder: readonly string[],
): RestorePartition<T> {
  const { openNow, held } = partitionRestoreByDesktop(descriptors, current, desktopOrder);
  if (openNow.length === 0 || held.size === 0) return { openNow, held };
  if (openNow.some((w) => w.focused === true)) return { openNow, held };
  let heldHasFocus = false;
  for (const group of held.values()) {
    if (group.some((w) => w.focused === true)) {
      heldHasFocus = true;
      break;
    }
  }
  if (!heldHasFocus) return { openNow, held };
  let topIndex = 0;
  for (let i = 1; i < openNow.length; i++) {
    if ((openNow[i].zOrder ?? 0) > (openNow[topIndex].zOrder ?? 0)) topIndex = i;
  }
  const promoted = openNow.slice();
  promoted[topIndex] = { ...promoted[topIndex], focused: true } as T;
  return { openNow: promoted, held };
}

/**
 * Fold still-held descriptors back into a save: a quit while groups are held
 * must re-save them with their recorded desktops, not drop them. The live
 * set's focus wins — when the save already carries a focused window, a held
 * descriptor's `focused` flag is demoted to false so the snapshot never names
 * two focused windows (restore picks the first it finds).
 */
export function mergeHeldIntoSave<T extends { focused?: boolean }>(
  saved: readonly T[],
  held: readonly T[],
): T[] {
  if (held.length === 0) return [...saved];
  const liveHasFocus = saved.some((w) => w.focused === true);
  const appended = held.map((w) =>
    liveHasFocus && w.focused === true ? ({ ...w, focused: false } as T) : w,
  );
  return [...saved, ...appended];
}
