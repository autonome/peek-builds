/**
 * Build the x/y/w/h options the restore path passes to window-open.
 *
 * A restored window keeps the position it had when the session was saved:
 * `center: true` only decides where a window first opens, so a window the
 * user moved after opening must not snap back to center on restore. When the
 * saved x/y are kept, `center` is overridden to false so window-open does not
 * re-center on top of them.
 *
 * `screenEdge` windows (slides) are anchored to a display edge, so x/y are
 * dropped and window-open re-derives the anchor on the current display layout.
 *
 * The saved x/y are also dropped when the saved center point is on no active
 * display (off-screen safety net for old snapshots).
 *
 * Pure: callers inject `isPointOnScreen` so this can be unit-tested without
 * Electron's `screen` module.
 */
export function buildRestoreBoundsOptions(
  descriptor: { bounds: { x: number; y: number; width: number; height: number }; params: Record<string, unknown> },
  isPointOnScreen: (x: number, y: number) => boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    width: descriptor.bounds.width,
    height: descriptor.bounds.height,
  };
  const hasEdgeIntent = typeof descriptor.params.screenEdge === 'string';
  if (hasEdgeIntent) return out;

  const centerX = descriptor.bounds.x + Math.round(descriptor.bounds.width / 2);
  const centerY = descriptor.bounds.y + Math.round(descriptor.bounds.height / 2);
  if (isPointOnScreen(centerX, centerY)) {
    out.x = descriptor.bounds.x;
    out.y = descriptor.bounds.y;
    if (descriptor.params.center === true) out.center = false;
  }
  return out;
}
