/**
 * Time on page: the milliseconds a page was actually in front of the user,
 * as opposed to the milliseconds its window was open.
 *
 * Pure bookkeeping, one entry per window that has an open visit: the visit's
 * id, the milliseconds already counted, and the instant counting last started
 * (null while the window is not in front). The clock is always passed in, so
 * every span is arithmetic on the caller's numbers and nothing here reads the
 * time, talks to a window system, or writes to storage.
 *
 * A window with no open visit is unknown and every event for it is ignored.
 * Front-ness survives a visit swap in the same window, so a navigation while
 * the page is in front starts counting the new visit immediately.
 */

/** Whatever the owner uses to name a window. Nothing here interprets it. */
export type DwellWindowKey = string | number;

export interface EndedVisit {
  readonly visitId: string;
  readonly durationMs: number;
}

interface OpenVisit {
  visitId: string;
  countedMs: number;
  countingSince: number | null;
}

export interface VisitDwell {
  /**
   * A page load recorded a new visit in `window`. Any visit still open there
   * ends first and is returned for the owner to write.
   */
  visitStarted(window: DwellWindowKey, visitId: string, now: number): EndedVisit | null;
  /** The window became the one in front of the user. */
  inFront(window: DwellWindowKey, now: number): void;
  /** The window stopped being the one in front of the user. */
  notInFront(window: DwellWindowKey, now: number): void;
  /** The visit is over (navigation elsewhere, window closed, app quitting). */
  visitEnded(window: DwellWindowKey, now: number): EndedVisit | null;
  /** Every window that still has an open visit, for a flush at quit. */
  openWindows(): DwellWindowKey[];
}

export function createVisitDwell(): VisitDwell {
  const open = new Map<DwellWindowKey, OpenVisit>();

  /** Fold any span in progress into the total and stop counting. */
  function settle(entry: OpenVisit, now: number): number {
    if (entry.countingSince !== null) {
      entry.countedMs += Math.max(0, now - entry.countingSince);
      entry.countingSince = null;
    }
    return entry.countedMs;
  }

  return {
    visitStarted(window, visitId, now) {
      const previous = open.get(window);
      let ended: EndedVisit | null = null;
      let wasInFront = false;
      if (previous) {
        wasInFront = previous.countingSince !== null;
        ended = { visitId: previous.visitId, durationMs: settle(previous, now) };
      }
      open.set(window, { visitId, countedMs: 0, countingSince: wasInFront ? now : null });
      return ended;
    },

    inFront(window, now) {
      const entry = open.get(window);
      if (!entry || entry.countingSince !== null) return;
      entry.countingSince = now;
    },

    notInFront(window, now) {
      const entry = open.get(window);
      if (!entry) return;
      settle(entry, now);
    },

    visitEnded(window, now) {
      const entry = open.get(window);
      if (!entry) return null;
      open.delete(window);
      return { visitId: entry.visitId, durationMs: settle(entry, now) };
    },

    openWindows() {
      return [...open.keys()];
    },
  };
}
