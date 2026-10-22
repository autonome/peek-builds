/**
 * Wires the pure dwell bookkeeping in `visit-dwell.ts` to the three things it
 * cannot know by itself: which page load recorded which visit, which window is
 * in front of the user, and where the result is stored.
 *
 * The window signal is the window machine's own state, observed after every
 * dispatch — there are no new focus or blur listeners. A page counts as in
 * front when it is the key window, the app is active, the window is visible
 * with no hide in flight, and it is on the desktop the user is on. The chrome
 * overlay holding the key (the address bar is open) counts for its host.
 *
 * `PEEK_VISIT_DWELL=off` skips all of it: no observer, no visits recorded, and
 * every duration stays 0.
 */
import { DEBUG } from './config.js';
import { setItemVisitDuration } from './datastore.js';
import { createVisitDwell, type EndedVisit } from './visit-dwell.js';
import { getKernelExecutor } from './window-kernel-dispatch.js';
import { hostForOverlay, keyWindow, onCurrentDesktop, type State, type WindowId } from './window-kernel.js';
import { getNativeWindowFor, getWindowIdFor } from './window-machine.js';

function enabled(): boolean {
  return process.env.PEEK_VISIT_DWELL !== 'off';
}

const dwell = createVisitDwell();

/** The window id of each open visit's window, as the machine names it. */
const machineIdByWindow = new Map<number, WindowId>();

/** The window counted as in front, or null while no page is. */
let inFrontWindow: number | null = null;

let unobserve: (() => void) | null = null;

/** The window in front of the user right now, or null if no page is. */
function frontWindow(state: State): number | null {
  if (!state.appActive) return null;
  const held = keyWindow(state);
  if (!held) return null;
  const page = held.overlayFor ? (hostForOverlay(state, held.id) ?? held) : held;
  if (!page.visible || page.pendingHidden) return null;
  if (!onCurrentDesktop(state, page)) return null;
  const native = getNativeWindowFor(page.id);
  return native ? native.id : null;
}

function writeDuration(ended: EndedVisit | null): void {
  if (!ended || ended.durationMs <= 0) return;
  try {
    setItemVisitDuration(ended.visitId, ended.durationMs);
  } catch (e) {
    DEBUG && console.log('[visit-dwell] duration write failed:', e);
  }
}

/** Move the counted window to whatever is in front now. */
function syncFront(state: State, at: number): void {
  const next = frontWindow(state);
  if (next === inFrontWindow) return;
  if (inFrontWindow !== null) dwell.notInFront(inFrontWindow, at);
  inFrontWindow = next;
  if (next !== null) dwell.inFront(next, at);
}

/** End the visits of windows the machine no longer has. */
function endVisitsOfGoneWindows(state: State, at: number): void {
  for (const key of dwell.openWindows()) {
    const windowId = key as number;
    const known = machineIdByWindow.get(windowId);
    if (known === undefined) {
      // Not registered yet when its visit started; remember it once it is.
      const id = getWindowIdFor(windowId);
      if (id !== null) machineIdByWindow.set(windowId, id);
      continue;
    }
    if (state.order.some((w) => w.id === known)) continue;
    machineIdByWindow.delete(windowId);
    writeDuration(dwell.visitEnded(key, at));
  }
}

/**
 * A page load recorded a visit for this window. Any visit still open there
 * ends and gets its duration written first.
 */
export function noteVisitStarted(windowId: number, visitId: string): void {
  if (!enabled()) return;
  const at = Date.now();
  const state = getKernelExecutor().getState();
  syncFront(state, at);
  writeDuration(dwell.visitStarted(windowId, visitId, at));
  if (inFrontWindow === windowId) dwell.inFront(windowId, at);
  if (!machineIdByWindow.has(windowId)) {
    const id = getWindowIdFor(windowId);
    if (id !== null) machineIdByWindow.set(windowId, id);
  }
}

/**
 * Start observing. Call after the window machine is initialised; calling it
 * again replaces the observer rather than adding a second one.
 */
export function initVisitDwell(): void {
  if (!enabled()) return;
  unobserve?.();
  unobserve = getKernelExecutor().subscribe((state) => {
    const at = Date.now();
    endVisitsOfGoneWindows(state, at);
    syncFront(state, at);
  });
}

/** End every open visit and write its duration. For shutdown. */
export function flushOpenVisitDwell(): void {
  const at = Date.now();
  for (const key of dwell.openWindows()) {
    machineIdByWindow.delete(key as number);
    writeDuration(dwell.visitEnded(key, at));
  }
  inFrontWindow = null;
  unobserve?.();
  unobserve = null;
}
