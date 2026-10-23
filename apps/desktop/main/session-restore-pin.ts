/**
 * Open-time options a pinned window gets on session restore.
 *
 * A pinned window restores directly onto the pinned layer (alwaysOnTop +
 * pinScope). A saved `focusable: false` is dropped for it: with
 * alwaysOnTop that pair classes the window as a HUD that can never become
 * key, so Cmd+W (which targets key-capable windows) and the Windows
 * switcher could no longer reach it to close it. An unpinned window keeps
 * its saved `focusable`.
 */
export function applyPinnedRestoreOptions(
  options: Record<string, unknown>,
  pinScope: string | null | undefined,
): void {
  if (!pinScope) return;
  options.alwaysOnTop = true;
  options.pinScope = pinScope;
  delete options.focusable;
}
