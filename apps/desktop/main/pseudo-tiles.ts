/**
 * Pseudo-tile registry — central table of URL → trustedBuiltin tile binding.
 *
 * Pseudo-tiles are URLs that need tile-preload + a trustedBuiltin grant but
 * don't ship a manifest.json (settings, cmd panel, HUD overlay, etc.).
 * Historically each entry was a copy-pasted `if (url === '…') { … }` block
 * in `ipc.ts` — this module replaces that ladder with a single lookup.
 *
 * Adding a new pseudo-tile: append an entry here. Every entry gets a
 * dedicated tileId + entryId so capability grants and IPC sender-frame
 * bindings stay distinct.
 *
 * Long-term: fold these into the manifest registry (one manifest.json
 * per pseudo-tile under `app/`) so discovery is fully uniform. This table
 * is the intermediate step from "hardcoded if ladder" to that.
 */

import { createTrustedBuiltinGrant } from './tile-manifest.js';
import { generateToken } from './tile-tokens.js';
import { getTilePreloadPath } from './config.js';

interface PseudoTileWebPrefs {
  preload: string;
  additionalArguments: string[];
  tileId: string;
  entryId: string;
}

/**
 * URL-to-pseudo-tile mapping. Match is against `url` with hash + query
 * stripped (so `peek://app/settings/settings.html#extensions` matches
 * the settings entry). Some entries — notably cmd panel vs chain editor —
 * share a tileId but distinguish by entryId based on the exact path.
 */
interface PseudoTileEntry {
  tileId: string;
  /** Entry id string, OR a function that derives it from the full URL. */
  entryId: string | ((url: string) => string);
}

const PSEUDO_TILES: Record<string, PseudoTileEntry> = {
  'peek://app/settings/settings.html':   { tileId: 'settings',         entryId: 'main' },
  'peek://app/diagnostic.html':          { tileId: 'diagnostic',       entryId: 'main' },
  'peek://app/datastore/viewer.html':    { tileId: 'datastore-viewer', entryId: 'main' },
  'peek://app/hud/hud.html':             { tileId: 'hud-stats',        entryId: 'main' },
  'peek://cmd/panel.html':               { tileId: 'cmd-ui',           entryId: 'panel' },
  'peek://cmd/chain-editor.html':        { tileId: 'cmd-ui',           entryId: 'chain-editor' },
  'about:blank':                         { tileId: 'about-blank',      entryId: 'main' },
};

/**
 * Look up the pseudo-tile registration for a URL. Returns the web prefs
 * to apply (preload + additionalArguments) plus the minted token so the
 * caller can register the resulting BrowserWindow with the tile
 * broadcaster via `registerTrustedBuiltinWindow`.
 *
 * Returns null when the URL isn't a registered pseudo-tile — callers
 * fall through to their normal tile-preload lookup or the no-preload
 * default.
 */
export function lookupPseudoTile(url: string): {
  webPrefs: PseudoTileWebPrefs;
  token: string;
} | null {
  // about:blank is a literal string, not a URL that can carry fragments.
  // For everything else, strip hash + query so URLs restored from session
  // snapshots (which include `#section` fragments persisted by settings'
  // showSection, for example) still match.
  const key = url === 'about:blank'
    ? url
    : url.split('#')[0].split('?')[0];

  const entry = PSEUDO_TILES[key];
  if (!entry) return null;

  const entryId = typeof entry.entryId === 'function'
    ? entry.entryId(url)
    : entry.entryId;

  const grant = createTrustedBuiltinGrant(entry.tileId);
  const token = generateToken(entry.tileId, entryId, grant);

  return {
    webPrefs: {
      preload: getTilePreloadPath(),
      additionalArguments: [
        `--tile-id=${entry.tileId}`,
        `--tile-entry=${entryId}`,
        `--tile-token=${token}`,
      ],
      tileId: entry.tileId,
      entryId,
    },
    token,
  };
}
