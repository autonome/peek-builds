/**
 * The address bar's reveal on page load, as a pure decision.
 *
 * The bar shows only for a page window's first load — when the window first
 * appears, or when its first load starts before the chrome has framed it. It
 * stays up for at least LOAD_REVEAL_DWELL_MS measured from when it was shown,
 * or until the load finishes, whichever is later. Then it hides. A fast or
 * cached load still gets the full dwell, and so does a window whose load
 * finished before the chrome reached it: its appearance is itself a reveal.
 * Later navigations (link click, back/forward, reload) and window switches do
 * not reveal; a switch only takes down a bar another window's load was holding.
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
 * @typedef {{ shownBy: string|null, shownAt: number|null, revealed?: boolean }} RevealState
 *   revealed: the active window has already had its first-load reveal.
 * @typedef {'load-start'|'load-stop'|'window-appeared'|'window-switched'} RevealEvent
 *   load-start: the active page started loading (reveals only if not `revealed`).
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
  const { shownBy, shownAt, revealed = false } = state;
  const unchanged = { show: false, hideAfterMs: null, shownBy, shownAt };
  if (shownBy === SHOWN_BY_USER) return unchanged;
  const reveal = (hideAfterMs) => ({ show: true, hideAfterMs, shownBy: SHOWN_BY_LOAD, shownAt: now });

  switch (event) {
    case 'load-start':
      // Only a window's first load reveals; later navigations leave the bar be.
      return revealed ? unchanged : reveal(null);
    case 'window-appeared':
      return reveal(loading ? null : LOAD_REVEAL_DWELL_MS);
    case 'window-switched':
      // A switch never reveals; a bar another window's load was holding does
      // not follow.
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
 * The reveal event for the chrome reaching a page window. A window opened with
 * `quietOpen` never reveals on appearing; it still counts as framed, so its
 * later load-start does not reveal either.
 *
 * @param {boolean} appeared the chrome has not framed this window before
 * @param {boolean} [quietOpen]
 * @returns {'window-appeared'|'window-switched'}
 */
export function activeWindowRevealEvent(appeared, quietOpen = false) {
  return appeared && quietOpen !== true ? 'window-appeared' : 'window-switched';
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
