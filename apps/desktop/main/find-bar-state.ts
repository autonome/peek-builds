/**
 * Which page windows currently show the find bar.
 *
 * The bar lives in the shared chrome overlay, but Escape can land on the page's
 * content WebContents instead (the page kept keyboard focus, or the overlay lost
 * it after a click). While the bar is open that Escape closes the bar and
 * nothing else; with it closed Escape keeps its usual meaning (close the
 * window, open the switcher).
 */
export interface FindBarState {
  markOpen(windowId: number): void;
  markClosed(windowId: number): void;
  isOpen(windowId: number): boolean;
}

export function createFindBarState(): FindBarState {
  const open = new Set<number>();
  return {
    markOpen: (id) => { open.add(id); },
    markClosed: (id) => { open.delete(id); },
    isOpen: (id) => open.has(id),
  };
}

/** The one find-bar state main shares between the Cmd+F routing and the Escape path. */
export const findBarState: FindBarState = createFindBarState();
