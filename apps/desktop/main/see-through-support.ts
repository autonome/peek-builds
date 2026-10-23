// Pure module (no Electron deps) deciding whether the window behind a
// `peek://` URL supports the see-through switch.
//
// The single source of truth is the feature's own manifest: a tile entry
// declares `seeThrough: true` on the window it describes. Main never holds
// a list of card-grid URLs — a feature that grows a card grid declares it
// and the switch starts working, and a window whose entry says nothing is
// refused by `tile:window:set-see-through` with `{ success: false, error }`.
//
// Kept separate from tile-launcher.ts so it is unit-testable without
// pulling in Electron (see see-through-support.test.ts).

/** The part of a manifest tile entry this decision reads. */
export interface SeeThroughTileEntry {
  url?: string;
  seeThrough?: boolean;
}

/** The part of a tile manifest this decision reads. */
export interface SeeThroughManifestLike {
  tiles?: readonly SeeThroughTileEntry[];
}

/**
 * Split a `peek://` tile URL into the tile id and the entry path.
 *
 * Handles the `peek://ext/<tileId>/<path>` legacy spelling the protocol
 * shim still accepts, the same way `tile-launcher.ts` does. Returns null
 * for anything that is not a `peek://` URL — a web page, `about:blank`,
 * a file — which is exactly the "view does not support the switch" case.
 */
export function parsePeekTileUrl(url: string): { tileId: string; path: string } | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'peek:') return null;
  const cleanPath = parsed.pathname.replace(/^\//, '');
  if (parsed.host === 'ext') {
    const segments = cleanPath.split('/');
    if (segments.length < 2) return null;
    return { tileId: segments[0], path: segments.slice(1).join('/') };
  }
  if (!parsed.host) return null;
  return { tileId: parsed.host, path: cleanPath };
}

/**
 * Whether the manifest's entry for `path` declares the see-through switch.
 *
 * Exact path match only: the declaration belongs to one window, not to a
 * whole feature, so a feature's background page does not inherit its card
 * view's switch.
 */
export function entryDeclaresSeeThrough(
  manifest: SeeThroughManifestLike | null | undefined,
  path: string,
): boolean {
  if (!manifest || !Array.isArray(manifest.tiles)) return false;
  const entry = manifest.tiles.find(t => t.url === path);
  return entry?.seeThrough === true;
}

/**
 * Whether the window at `url` supports the see-through switch, resolving
 * the manifest through the caller's lookup (so this module stays free of
 * tile-launcher's Electron dependencies).
 */
export function urlSupportsSeeThrough(
  url: string,
  lookupManifest: (tileId: string) => SeeThroughManifestLike | null,
): boolean {
  const parsed = parsePeekTileUrl(url);
  if (!parsed) return false;
  return entryDeclaresSeeThrough(lookupManifest(parsed.tileId), parsed.path);
}

/** The window params the app-wide switch writes on a window being created. */
export interface NewWindowSeeThrough {
  seeThrough: boolean;
  /** Whether the switch is what maximized it, so turning it off restores. */
  seeThroughMaximized: boolean;
}

/**
 * What the app-wide switch makes of a window being created: the params to
 * write, or null to leave the window exactly as its opener asked for it.
 *
 * Three things have to be true before the switch decides anything. The
 * opener must not have asked for a state of its own — a session restore
 * replays the saved `seeThrough`, including a saved `false`, and that
 * answer outranks the app-wide default, which is what makes the per-window
 * override survive a restart. The app-wide switch must be on. And the
 * window's view must declare the switch in its manifest, so the app-wide
 * state reaches the same windows the per-window command does and no list
 * of views exists anywhere.
 *
 * `seeThroughMaximized` comes back true because the switch is what asks
 * for the maximize here, so turning it off later puts the window back at
 * the size its opener asked for (docs/design/window-rules.md G15).
 */
export function seeThroughForNewWindow(input: {
  url: string;
  appWideOn: boolean;
  requestedSeeThrough?: unknown;
  lookupManifest: (tileId: string) => SeeThroughManifestLike | null;
}): NewWindowSeeThrough | null {
  if (typeof input.requestedSeeThrough === 'boolean') return null;
  if (input.appWideOn !== true) return null;
  if (!urlSupportsSeeThrough(input.url, input.lookupManifest)) return null;
  return { seeThrough: true, seeThroughMaximized: true };
}
