/**
 * Focus-recency ledger — a pure, Electron-free monotonic counter keyed by
 * window id. Higher = more recently focused. Session save uses this to rank
 * windows for eager/deferred restore, replacing the old BrowserWindow-
 * enumeration-index zOrder, which excluded hybrid BaseWindow page-hosts and
 * left every real web page tied at 0.
 */

let focusCounter = 0;
const focusOrderMap = new Map<number, number>();

export function noteWindowFocus(windowId: number): void {
  focusOrderMap.set(windowId, ++focusCounter);
}

export function getFocusOrder(windowId: number): number {
  return focusOrderMap.get(windowId) ?? 0;
}

export function clearFocusOrder(windowId: number): void {
  focusOrderMap.delete(windowId);
}
