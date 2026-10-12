/**
 * One `destroyed` listener per WebContents, however many teardown steps hang off it.
 *
 * A hybrid page-host's content WebContents collects `destroyed` listeners from
 * several modules: Electron's own, the hybrid registry, the close-capture in
 * `ipc.ts assembleHybridPageHost`, the webNavigation polyfill, and each per-host
 * map that `ipc.ts wireHybridContentEvents` fills. Registering each of those as
 * its own listener put a single content WebContents at 11 — over Node's default
 * limit of 10 — so every page-host open logged a MaxListenersExceededWarning
 * that reads like a leak but was a fixed count. Collecting a caller's teardown
 * steps behind one listener keeps the count flat as steps are added, without
 * raising the limit and hiding a real leak.
 */

export interface DestroyedEmitter {
  once(event: 'destroyed', listener: () => void): unknown;
}

/**
 * Returns `add(step)`. The first `add` registers a single `once('destroyed')`
 * listener on `wc`; every step added runs in order when it fires. A step that
 * throws is logged and the rest still run, so one failing cleanup cannot leave
 * the others' state behind.
 */
export function destroyedCleanups(wc: DestroyedEmitter, label = 'webContents'): (step: () => void) => void {
  const steps: Array<() => void> = [];
  let registered = false;
  return (step) => {
    steps.push(step);
    if (registered) return;
    registered = true;
    wc.once('destroyed', () => {
      for (const run of steps) {
        try {
          run();
        } catch (err) {
          console.error(`[destroyed-cleanups] ${label} teardown step failed:`, err);
        }
      }
    });
  };
}
