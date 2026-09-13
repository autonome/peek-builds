// Resolves a window's user-facing address from its host URL and IPC-tracked params.
// Kept separate from window-presenter.ts: that file imports BrowserWindow at top level,
// which fails to load under ELECTRON_RUN_AS_NODE, and this module must import cleanly in tests.
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
