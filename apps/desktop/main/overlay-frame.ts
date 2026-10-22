/**
 * Overlay chrome frame geometry — the pure math half of the hybrid page-host
 * shared chrome overlay (`hybrid-overlay.ts`).
 *
 * The overlay's outer bounds are the content `BaseWindow`'s bounds EXPANDED by
 * a margin on each side: the content window is the opaque "hole" in the
 * middle, and the chrome (navbar at top, trigger zone, resize handles at the
 * edges, side panels + widgets in the left/right gutters) renders in the
 * transparent margin around it, so the content shows through the center.
 *
 *   MARGIN          = 8px   resize-handle margin on every edge
 *   TRIGGER_ZONE     = 8px   hover strip above the navbar
 *   NAVBAR_HEIGHT    = 36px  reserved navbar band
 *   PANEL_WIDTH      = 280px side-panel width
 *   PANEL_OVERLAP    = 70px  (25% of PANEL_WIDTH) the panel overlaps the content
 *   PANEL_OVERHANG   = 210px (75% of PANEL_WIDTH) the panel extends into the gutter
 *
 * The left/right gutter is `MARGIN + PANEL_OVERHANG` (218px) wide, so a 280px
 * panel that overlaps the content edge by 70px fits the gutter without
 * clipping. These values match the retired canvas page-host's values (see git
 * history) — do NOT invent new ones.
 *
 * PURE module (mirrors the `display-projection.ts` seam): no Electron
 * imports, no `screen`, no `BrowserWindow`, no module state. The caller reads
 * the OS (`screen.getDisplayNearestPoint(...).workArea`) and passes the
 * result in — see `hybrid-overlay.ts` for the current call site.
 */

import type { Rectangle } from './window-kernel.js';

const MARGIN = 8;
const TRIGGER_ZONE = 8;
const NAVBAR_HEIGHT = 36;
const PANEL_WIDTH = 280;
const PANEL_OVERLAP = PANEL_WIDTH * 0.25; // 70
const PANEL_OVERHANG = PANEL_WIDTH - PANEL_OVERLAP; // 210

/** Per-side insets from the overlay frame to the inner content rect. */
const GUTTER_LEFT = MARGIN + PANEL_OVERHANG; // 218
const GUTTER_RIGHT = MARGIN + PANEL_OVERHANG; // 218
const GUTTER_TOP = TRIGGER_ZONE + NAVBAR_HEIGHT; // 44
const GUTTER_BOTTOM = MARGIN; // 8

/** The gutter insets — published to the overlay renderer so it can place the
 * transparent content hole + chrome relative to the inner content rect, and read
 * by tests to assert the expanded frame. */
export const OVERLAY_GUTTERS = {
  left: GUTTER_LEFT,
  right: GUTTER_RIGHT,
  top: GUTTER_TOP,
  bottom: GUTTER_BOTTOM,
} as const;

/**
 * How long the top-border hover gesture waits before the navbar covers the page,
 * for a window with no room above it. A page flush with the top of the screen
 * draws its own account menu, home link and site nav exactly where the navbar
 * lands, so an instant reveal steals those targets from a cursor merely crossing
 * the top edge. The dwell is long enough that only a deliberate hover reveals.
 * Not a setting — the gesture's own timing, like the 400ms hide dwell.
 */
export const REVEAL_DELAY_MS = 2000;

/**
 * The delay before the top-border hover gesture reveals the navbar, in ms:
 * `REVEAL_DELAY_MS` when the host has less than a top gutter's worth of room
 * above it (maximized, or flush or nearly flush with the top of the work area),
 * so the navbar would land on the page's own top elements; `0` when the host sits
 * far enough down that the navbar reveals into the gutter above the page instead.
 *
 * The comparison is signed, not absolute: a host whose top edge is ABOVE the work
 * area's top (fullscreen, or a display whose work area excludes a menu bar the
 * window covers anyway) has no room above it either, and delays.
 *
 * `workArea` is the display work area nearest the host, or `null` when
 * unavailable (some test envs) — with no work area there is nothing to measure
 * room against, so the gesture keeps its immediate reveal.
 */
export function revealDelayMs(host: Rectangle, workArea: Rectangle | null): number {
  if (!workArea) return 0;
  const roomAbove = host.y - workArea.y;
  return roomAbove <= GUTTER_TOP ? REVEAL_DELAY_MS : 0;
}

/**
 * Expand an inner content rect (the content `BaseWindow`'s outer bounds) into
 * the overlay's frame: the content rect grown by the canvas gutters so the
 * chrome has margin to render in AROUND the content. The inner content rect is
 * recovered by the renderer (and tests) by subtracting `GUTTER_LEFT`/`GUTTER_TOP`
 * back off — the renderer is told the gutters via the active handoff so its
 * layout stays a pure function of the content rect.
 *
 * `workArea` is the display work area nearest `content` (the caller reads it
 * via `screen.getDisplayNearestPoint`), or `null` when unavailable (some test
 * envs) — skips the maximized parity branch + clamp below.
 */
export function expandToOverlayFrame(content: Rectangle, workArea: Rectangle | null): Rectangle {
  // Maximized parity (mirrors the canvas): a window snapped to its display work
  // area gets NO gutter — the chrome renders edge-to-edge over the content, and
  // expanding by gutters would push the overlay off-screen.
  if (
    workArea &&
    content.x === workArea.x &&
    content.y === workArea.y &&
    content.width === workArea.width &&
    content.height === workArea.height
  ) {
    return { x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height };
  }

  const frame = {
    x: Math.round(content.x - GUTTER_LEFT),
    y: Math.round(content.y - GUTTER_TOP),
    width: Math.round(content.width + GUTTER_LEFT + GUTTER_RIGHT),
    height: Math.round(content.height + GUTTER_TOP + GUTTER_BOTTOM),
  };

  // Electron 43 / macOS keeps a SHOWN window fully on-screen: an origin that
  // would push the window past the work-area edge is clamped inward, preserving
  // width/height (verified: x/y = clamp(origin, waMin, waMax − size)). Mirror
  // that exact clamp here so the overlay's computed frame equals its post-show
  // getBounds() — otherwise, for a content window near a screen edge, the frame
  // math (off-screen) would diverge from the OS-clamped reality. peek 06d363fc.
  if (workArea) {
    const maxX = workArea.x + workArea.width - frame.width;
    const maxY = workArea.y + workArea.height - frame.height;
    frame.x = Math.min(Math.max(frame.x, workArea.x), Math.max(workArea.x, maxX));
    frame.y = Math.min(Math.max(frame.y, workArea.y), Math.max(workArea.y, maxY));
  }
  return frame;
}

/**
 * Where the content rect actually sits inside its overlay frame, as left/top
 * insets in overlay-local pixels. Normally the gutters, but `expandToOverlayFrame`
 * clamps the frame onto the work area, so a host flush with the top (or left) of
 * the screen has a smaller inset on that side — down to 0. The renderer lays the
 * chrome out from these, so its hover strip and navbar land on the host's real
 * top edge instead of a gutter's height below it.
 */
export function contentInsetInFrame(
  content: Rectangle,
  workArea: Rectangle | null,
): { left: number; top: number } {
  const frame = expandToOverlayFrame(content, workArea);
  return { left: Math.round(content.x - frame.x), top: Math.round(content.y - frame.y) };
}
