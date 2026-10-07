/**
 * The address bar's reveal on page load, as a pure decision.
 *
 * A page that starts loading shows the address bar (with its loading state), and
 * the bar hides again once the load settles — but only if the load is what
 * showed it. A bar the user revealed (top-edge hover, Cmd+L, panel hover) stays
 * up when the load settles; their pointer or typing decides when it goes.
 *
 * `shownBy` is who is holding the bar visible: `SHOWN_BY_LOAD`,
 * `SHOWN_BY_USER`, or null when it is hidden. The same decision applies when
 * the chrome moves to another window, with that window's loading state, so a
 * load-time reveal never outlives a switch to a window that is not loading.
 */

export const SHOWN_BY_LOAD = 'load';
export const SHOWN_BY_USER = 'user';

/**
 * @param {string|null} shownBy who holds the bar visible now
 * @param {boolean} loading whether the active page is loading
 * @returns {{ action: 'show'|'hide'|'none', shownBy: string|null }}
 */
export function navbarRevealOnLoad(shownBy, loading) {
  return { action: 'none', shownBy };
}
