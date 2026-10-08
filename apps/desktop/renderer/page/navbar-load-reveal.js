/**
 * The address bar's reveal on page load, as a pure decision.
 *
 * The bar shows whenever a page window appears or its page navigates — new
 * window, link click, back/forward, reload, undo-close/reopen — and stays up
 * for at least LOAD_REVEAL_DWELL_MS measured from when it was shown, or until
 * the load finishes, whichever is later. Then it hides. A fast or cached load
 * still gets the full dwell, and so does a window whose load finished before
 * the chrome reached it: its appearance is itself a reveal.
 *
 * A bar the user revealed (top-edge hover, pointer over the chrome, Cmd+L,
 * panel hover) is never taken over: their pointer or typing decides when it
 * goes.
 *
 * `shownBy` is who is holding the bar visible: `SHOWN_BY_LOAD`,
 * `SHOWN_BY_USER`, or null when it is hidden. `shownAt` is when a load reveal
 * started (ms, any monotonic clock), null otherwise.
 */

export const SHOWN_BY_LOAD = 'load';
export const SHOWN_BY_USER = 'user';

/** Minimum time a load reveal keeps the bar up, from when it was shown. */
export const LOAD_REVEAL_DWELL_MS = 1500;

/**
 * @typedef {{ shownBy: string|null, shownAt: number|null }} RevealState
 * @typedef {'load-start'|'load-stop'|'window-appeared'|'window-switched'} RevealEvent
 *   load-start: the active page started loading (a navigation of any kind).
 *   load-stop: the active page's load settled.
 *   window-appeared: the chrome reached a page window it has not framed before.
 *   window-switched: the chrome moved to a page window it has framed before.
 */

/**
 * @param {RevealState} state
 * @param {RevealEvent} event
 * @param {number} now
 * @param {boolean} [loading] whether the page is loading (window events only)
 * @returns {{ show: boolean, hideAfterMs: number|null, shownBy: string|null, shownAt: number|null }}
 *   `show`: reveal the bar now. `hideAfterMs`: hide a load-held bar after this
 *   many ms (0 = now); null = no hide scheduled, and any pending one is dropped.
 */
export function navbarLoadReveal(state, event, now, loading = false) {
  const { shownBy, shownAt } = state;
  const unchanged = { show: false, hideAfterMs: null, shownBy, shownAt };
  if (shownBy === SHOWN_BY_USER) return unchanged;
  const reveal = (hideAfterMs) => ({ show: true, hideAfterMs, shownBy: SHOWN_BY_LOAD, shownAt: now });

  switch (event) {
    case 'load-start':
      return reveal(null);
    case 'window-appeared':
      return reveal(loading ? null : LOAD_REVEAL_DWELL_MS);
    case 'window-switched':
      if (loading) return reveal(null);
      // An idle window someone switched to: a bar another window's load was
      // holding does not follow.
      if (shownBy === SHOWN_BY_LOAD) return { show: false, hideAfterMs: 0, shownBy, shownAt };
      return unchanged;
    case 'load-stop':
      if (shownBy !== SHOWN_BY_LOAD) return unchanged;
      return {
        show: false,
        hideAfterMs: Math.max(0, (shownAt ?? now) + LOAD_REVEAL_DWELL_MS - now),
        shownBy,
        shownAt,
      };
    default:
      return unchanged;
  }
}

/**
 * Whether the pointer moving off the chrome (over the page, or out of the top
 * edge) starts the bar's hide. A bar the load is holding stays up while the
 * pointer moves over the page: the pointer is almost always over the page while
 * it loads, and the load settling (plus the dwell) is what takes that bar down.
 *
 * @param {string|null} shownBy who holds the bar visible now
 * @returns {boolean}
 */
export function pointerLeaveHides(shownBy) {
  return shownBy !== SHOWN_BY_LOAD;
}
