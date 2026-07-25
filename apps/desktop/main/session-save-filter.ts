/**
 * Electron-free pure logic for the session-save window filter.
 *
 * Lives in its own module (no `electron` import) so it can be unit-tested
 * directly under `node:test` — `session.ts` imports Electron at module load,
 * which a plain node test process can't satisfy. Both `saveSessionSnapshot`
 * (the real loop) and `session.test.ts` import THIS function, so the test and
 * the shipped code can't drift (the prior "replicate the logic in the test"
 * pattern gave false confidence twice for the hybrid page-host case).
 */

/**
 * Decide whether the session-save loop should skip a window at the EARLY
 * (window-type-dependent) stage — i.e. before the common modal/utility/overlay
 * checks. Pure on its resolved inputs (no Electron objects).
 *
 * Canvas/BrowserWindow path: visibility + URL come from the BrowserWindow.
 * Hybrid page-host path: the BrowserWindow is absent (`getLiveWindow` → null);
 * visibility comes from the hybrid registry's BaseWindow and the URL from the
 * hybrid entry. A hybrid window is never the background page, so the
 * background-URL skip never fires for it.
 *
 * There is deliberately NO overlay carve-out on the visibility rule. One used to
 * exist (`hiddenByActiveOverlay`, fed by the `params.overlayHiddenWindows` side
 * channel) because opening the switcher hid every other window, and quitting
 * with it open then saved an empty session. The switcher stopped hiding windows
 * in 9904f113 — it renders over them against a blurred backdrop — so no window
 * is ever "invisible only because an overlay is up", and the exemption had
 * nothing left to exempt. See §5 step 11 task 6.
 *
 * @param destroyed  true if the underlying window object is gone / unknown
 * @param visible    isVisible() of the relevant window (BrowserWindow or hybrid BaseWindow)
 * @param url        the window's URL (webContents.getURL() or hybrid entry url())
 * @param forceForTest  the `_forceForTest` opt (bypasses the visibility skip)
 */
export function shouldSkipWindowForSaveEarly(args: {
  destroyed: boolean;
  visible: boolean;
  url: string;
  forceForTest?: boolean;
}): boolean {
  if (args.destroyed) return true;
  if (!args.visible && !args.forceForTest) {
    return true;
  }
  // Skip the background window (hybrid windows never load background.html, so
  // the caller passes the hybrid url here and this never trips for them).
  if (args.url.includes('peek://app/background.html')) return true;
  return false;
}
