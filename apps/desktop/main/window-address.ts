/**
 * Pure helper for resolving a window's user-facing address.
 *
 * Lives separately from window-presenter.ts because the presenter imports
 * Electron's BrowserWindow at top level, which fails under
 * ELECTRON_RUN_AS_NODE — so unit tests need a pure-JS module to import.
 *
 * The resolution rules encoded here are the contract every consumer of
 * `tile:window:list`, `session.save`, and undo-close depends on. The
 * page-host's two-layer URL shape lives here and nowhere else.
 */

/**
 * For page-host windows the BrowserWindow's URL is `peek://app/page/...`
 * (the shell). The user-facing URL is the inner navigated address.
 *
 * Priority:
 *   1. info.params.currentUrl (kept in sync by ipc.ts's
 *      did-attach-webview listener — tracks every guest did-navigate).
 *   2. The bootstrap `?url=` search param on the host URL (what was
 *      passed at window-open).
 *   3. The host URL itself (last-resort fallback).
 *
 * For all other windows, returns the host URL unchanged.
 */
export function resolveWindowAddress(
  hostUrl: string,
  params: Record<string, unknown> | undefined,
): string {
  if (!hostUrl.startsWith('peek://app/page')) return hostUrl;
  const liveUrl = typeof params?.currentUrl === 'string'
    ? (params.currentUrl as string)
    : '';
  if (liveUrl) return liveUrl;
  try {
    const bootstrap = new URL(hostUrl).searchParams.get('url');
    if (bootstrap) return bootstrap;
  } catch {
    // hostUrl unparseable — fall through to hostUrl itself
  }
  return hostUrl;
}
