/**
 * Which window's widget the shared page chrome shows. No `window.app` here, so
 * `tests/unit/translate-tile.test.js` runs it under Node.
 *
 * Every page window shares one chrome, and the chrome draws one translate widget. The tile
 * keeps the view each window should show (an offer, a status, a download prompt) and draws only
 * the one for the window in front; when another window comes forward its own view replaces the
 * widget, or the widget closes when it has none, and the first window's view comes back with it.
 *
 * Every method answers what to do with the widget: `{draw: view}`, `{close: true}`, or null to
 * leave it as it is.
 */

export function createWindowViews() {
  /** @type {Map<number, object>} the view each window shows when it is in front */
  const views = new Map();
  /** The window in front, or null when none is known or no page window is in front. */
  let front = null;

  function frontStep() {
    const view = front === null ? undefined : views.get(front);
    return view ? { draw: view } : { close: true };
  }

  return {
    /** The view `windowId` shows from now on; null or undefined clears it. */
    setView(windowId, view) {
      if (!Number.isInteger(windowId)) return null;
      if (view) views.set(windowId, view);
      else views.delete(windowId);
      if (windowId !== front) return null;
      return view ? { draw: view } : { close: true };
    },

    /** The view `windowId` shows, or null. */
    viewOf(windowId) {
      return views.get(windowId) || null;
    },

    /**
     * Another window came in front (`windowId`, or null for none). Repeating the window already
     * in front changes nothing, so a repeated report does not redraw the widget.
     */
    setFront(windowId) {
      const next = Number.isInteger(windowId) ? windowId : null;
      if (next === front) return null;
      front = next;
      return frontStep();
    },

    front() {
      return front;
    },
  };
}
