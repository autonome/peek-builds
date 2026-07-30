/**
 * Bounded "destroy these guest WebContents and wait until they are actually
 * gone" — the ONE implementation of that wait, shared by the interactive close
 * path and the quit teardown.
 *
 * WHY A WAIT EXISTS AT ALL: `webContents.destroy()` is not synchronously
 * observable. It returns without throwing and `isDestroyed()` still reads
 * `false` on the very next line; the teardown lands on a later turn of the loop,
 * when the wc emits `'destroyed'` (measured at ~7ms in a live quit). Any caller
 * whose next step must not run over a live guest — closing the host window,
 * letting Electron's quit close it — has to wait for that event, not for
 * `destroy()` to return.
 *
 * WHY IT IS BOUNDED, TWICE: a wedged renderer must never strand the user. Each
 * guest gets its own cap, and the caller may add a cap on the WHOLE batch, so a
 * quit is delayed by a fixed budget no matter how many guests are registered or
 * how badly one of them misbehaves. Every path resolves; none rejects.
 *
 * Platform-free by construction: the caller supplies `requestDestroy`, so the
 * actual `destroy()` call stays in the window backend (rule R2) and this module
 * is unit-testable against fake WebContents.
 */

/** The slice of `WebContents` this wait needs — enough to fake in a unit test. */
export interface TeardownGuest {
  isDestroyed(): boolean;
  once(event: 'destroyed', listener: () => void): void;
}

/**
 * Per-guest cap. A guest normally emits `'destroyed'` within a frame; this is
 * the "it never will" escape so one stuck renderer cannot hold a close open.
 */
export const GUEST_DESTROY_TIMEOUT_MS = 2000;

/**
 * Whole-batch cap for the quit teardown. Deliberately far tighter than the
 * per-guest cap: quit is user-initiated and the app is already visually going
 * away, so a multi-second stall reads as a hang, while the measured teardown is
 * ~7ms — this budget is two orders of magnitude above the real cost and still
 * imperceptible when it is spent in full.
 */
export const QUIT_GUEST_TEARDOWN_BUDGET_MS = 1000;

export interface GuestTeardownBounds {
  /** Cap per guest (default `GUEST_DESTROY_TIMEOUT_MS`). */
  perGuestMs?: number;
  /** Cap on the whole batch. Omitted = bounded only per guest. */
  overallMs?: number;
}

/**
 * Ask every guest to destroy itself, then resolve once they have all reported
 * `'destroyed'` — or once the bounds expire, whichever comes first. Never
 * rejects: a guest that throws on any step is treated as already gone.
 */
export function destroyGuestsAndWait(
  guests: readonly TeardownGuest[],
  requestDestroy: (guest: TeardownGuest) => void,
  bounds: GuestTeardownBounds = {},
): Promise<void> {
  const perGuestMs = bounds.perGuestMs ?? GUEST_DESTROY_TIMEOUT_MS;
  const all = Promise.all(
    guests.map((guest) => waitForOneGuest(guest, requestDestroy, perGuestMs)),
  ).then(() => undefined);
  if (bounds.overallMs === undefined) return all;
  return withOverallCap(all, bounds.overallMs);
}

function waitForOneGuest(
  guest: TeardownGuest,
  requestDestroy: (guest: TeardownGuest) => void,
  perGuestMs: number,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve();
    };
    try {
      if (guest.isDestroyed()) {
        finish();
        return;
      }
    } catch {
      // A wc whose liveness can't even be read is not something to wait on.
      finish();
      return;
    }
    timer = setTimeout(finish, perGuestMs);
    try {
      guest.once('destroyed', finish);
    } catch {
      finish();
      return;
    }
    try {
      requestDestroy(guest);
    } catch {
      // Nothing was asked to go away, so nothing will emit — don't hold the
      // caller for the full cap on a guest we failed to address.
      finish();
    }
  });
}

/** Resolve on `inner`, or on the batch deadline — whichever lands first. */
function withOverallCap(inner: Promise<void>, overallMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const cap = setTimeout(resolve, overallMs);
    void inner.then(
      () => {
        clearTimeout(cap);
        resolve();
      },
      () => {
        clearTimeout(cap);
        resolve();
      },
    );
  });
}
