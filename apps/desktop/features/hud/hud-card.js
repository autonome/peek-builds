/**
 * Card-mode detection for the HUD page.
 *
 * The same page runs as its own pinned window and as a card on a widget sheet
 * (a <webview> inside the sheet's window). Nothing in the address tells them
 * apart, so compare the page with the window that holds it. In its own window
 * the page fills the window, apart from a title bar at most. In a card the
 * holding window is the sheet's, which is larger than the page, or it is not
 * reported at all.
 */

/** Slack for a title bar or window border between window and page size. */
export const CARD_SIZE_SLACK = { width: 24, height: 80 };

/**
 * @param {{width:number,height:number}|null|undefined} windowBounds size of the holding window, if reported
 * @param {{width:number,height:number}} viewport the page's own inner size
 * @returns {boolean} true when the page is a card inside a larger window
 */
export function isCardMode(windowBounds, viewport) {
  if (!windowBounds || !viewport) return true;
  const { width: ww, height: wh } = windowBounds;
  if (!Number.isFinite(ww) || !Number.isFinite(wh)) return true;
  return (
    ww - viewport.width > CARD_SIZE_SLACK.width ||
    wh - viewport.height > CARD_SIZE_SLACK.height
  );
}
