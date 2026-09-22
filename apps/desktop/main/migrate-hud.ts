/**
 * One-shot profile migration — removes every trace of the deleted HUD
 * feature from a Peek datastore.
 *
 * The old HUD renderer (`apps/desktop/renderer/hud/`), its `peek://hud/*`
 * and `peek://ext/hud/*` protocol routes (`main/protocol.ts`, host==='hud'
 * and extId==='hud' respectively), the `hud-overlay` pseudo-tile and the
 * `hud` core renderer id were deleted in commit `3269f412` ("Delete the old
 * HUD renderer and its dead wiring"). A profile that ran the HUD while it
 * existed can still carry rows that now point at nothing.
 *
 * Inventory of what the deleted HUD tree (`3269f412^:apps/desktop/renderer/hud/`)
 * actually wrote, and where each key ended up:
 *
 *  - `hud.js` (`peek://hud/hud.html`): `api.settings.get/set('hud_sheet', ...)`.
 *    The old pseudo-tile table (`3269f412^:apps/desktop/main/pseudo-tiles.ts`)
 *    mapped `'peek://hud/hud.html'` to `{ tileId: 'hud-overlay', entryId: 'main' }`.
 *    Verified: `tile:settings:set` (`main/tile-ipc.ts`) writes
 *    `featureId = grant.tileId`, and a pseudo-tile's grant is minted by
 *    `createTrustedBuiltinGrant(tileId)`, which carries `grant.tileId` through
 *    unchanged — so this settings row is `feature_settings` with
 *    `featureId = 'hud-overlay'`, `key = 'hud_sheet'`.
 *  - `background.js`: HUD-enabled state (`hud_enabled`) lived in the
 *    renderer's `localStorage`, not the datastore — nothing to migrate here.
 *  - `widgets/mode.js`: only *reads* context (`api.context.get('mode',
 *    focusedWindowId)`, `api.context.watchMode(...)`) — keyed by whichever
 *    window is currently focused, not the HUD window itself — and never
 *    calls `context.set`. `widgets/window.js`, `widgets/izui.js`: window
 *    list / IZUI state reads only, no persistence. `widgets/timers.js`,
 *    `widgets/stats.js`: pubsub only, ephemeral. Re-checked the full widget
 *    set (including a `pin`-context sweep, since `session.ts` has a
 *    generic `'pin'` context key) — the `'pin'` key belongs to the current,
 *    unrelated window-pinning feature (`docs/design/window-rules.md`
 *    "workspace-pinned and global HUD"), keyed by native window id, not by
 *    any HUD tile id, and no widget file ever writes it. So no context
 *    entry was ever actually attached to a HUD window or keyed by a HUD
 *    tile id in the surviving data; the deletion below is defensive only.
 *  - `entry.ts` (pre-deletion) granted HUD widget webviews
 *    (`peek://hud/widgets/*.html`) a `trustedBuiltin` grant under the
 *    unified tile id `HUD_WIDGET_ID = 'hud-widget'` — covered below in case
 *    a widget ever wrote a settings row under that id.
 *  - `main.ts`'s `CORE_RENDERER_IDS` included `'hud'` as a core renderer —
 *    not itself a toggle row. The actual builtin-feature enabled/disabled
 *    state lives in the `manifest_cache` table's `disabledAt` column
 *    (`main/manifest-cache.ts` `setDisabled()`, wired from
 *    `feature-registry.ts`'s `onDisableChange` listener in
 *    `feature-startup.ts`) — a `featureId = 'hud'` row there is the "hud"
 *    toggle this migration removes.
 *
 * Removes:
 *  - every window entry whose URL starts with `peek://hud/` or
 *    `peek://ext/hud/` from the session snapshot (`feature_settings`
 *    featureId='session', key='snapshot'), every per-workspace snapshot row
 *    (`feature_settings` featureId='space-workspaces'), and the closed-window
 *    stack (`feature_settings` featureId='session', key='closed-window-stack');
 *  - every `feature_settings` row with featureId in ('hud', 'hud-widget',
 *    'hud-overlay');
 *  - the `manifest_cache` row for featureId='hud';
 *  - any `context_history` row keyed literally by one of those same ids
 *    (defensive — see inventory above).
 *
 * Temporary: delete this file, its registration in `datastore.ts`, and its
 * test once a release has shipped it. Peek item `a9970bfb`.
 */

import type { Db } from './datastore.js';
import { getDb, now } from './datastore.js';

const MIGRATION_ID = 'hud_profile_cleanup_v1';

const HUD_URL_PREFIXES = ['peek://hud/', 'peek://ext/hud/'];
const HUD_FEATURE_IDS = ['hud', 'hud-widget', 'hud-overlay'];

function isHudUrl(url: unknown): boolean {
  return typeof url === 'string' && HUD_URL_PREFIXES.some(prefix => url.startsWith(prefix));
}

/**
 * Drop any HUD window entry out of a `windows[]`-shaped array (the session
 * snapshot, a per-workspace snapshot, or the closed-window stack all use
 * the same `{ url: string, ... }` entry shape). Returns the original
 * reference untouched (and `changed: false`) when there's nothing to do,
 * so callers can skip the write.
 */
function withoutHudWindows<T extends { url?: unknown }>(
  windows: unknown
): { windows: T[]; changed: boolean } {
  if (!Array.isArray(windows)) return { windows: windows as T[], changed: false };
  const filtered = (windows as T[]).filter(w => !isHudUrl(w?.url));
  return { windows: filtered, changed: filtered.length !== windows.length };
}

export function migrateHud(database: Db = getDb()): void {
  const migrationRecord = database.prepare('SELECT status FROM migrations WHERE id = ?').get(MIGRATION_ID) as
    | { status: string }
    | undefined;
  if (migrationRecord?.status === 'complete') return;

  // Session snapshot — feature_settings featureId='session', key='snapshot'
  // (main/session.ts saveSessionSnapshot()).
  const snapshotRow = database
    .prepare(`SELECT value FROM feature_settings WHERE featureId = 'session' AND key = 'snapshot'`)
    .get() as { value: string } | undefined;
  if (snapshotRow?.value) {
    try {
      const snapshot = JSON.parse(snapshotRow.value);
      const { windows, changed } = withoutHudWindows(snapshot.windows);
      if (changed) {
        snapshot.windows = windows;
        database
          .prepare(`UPDATE feature_settings SET value = ?, updatedAt = ? WHERE featureId = 'session' AND key = 'snapshot'`)
          .run(JSON.stringify(snapshot), now());
      }
    } catch {
      // Malformed snapshot JSON — leave it for session.ts's own guards.
    }
  }

  // Closed-window stack — feature_settings featureId='session',
  // key='closed-window-stack' (main/main.ts saveClosedWindowStack()).
  const closedRow = database
    .prepare(`SELECT value FROM feature_settings WHERE featureId = 'session' AND key = 'closed-window-stack'`)
    .get() as { value: string } | undefined;
  if (closedRow?.value) {
    try {
      const entries = JSON.parse(closedRow.value);
      const { windows: filtered, changed } = withoutHudWindows(entries);
      if (changed) {
        database
          .prepare(`UPDATE feature_settings SET value = ?, updatedAt = ? WHERE featureId = 'session' AND key = 'closed-window-stack'`)
          .run(JSON.stringify(filtered), now());
      }
    } catch {
      // Malformed stack JSON — leave it.
    }
  }

  // Per-workspace snapshot rows — feature_settings featureId='space-workspaces',
  // one row per space (main/session.ts saveSpaceWorkspaces()).
  const workspaceRows = database
    .prepare(`SELECT id, value FROM feature_settings WHERE featureId = 'space-workspaces'`)
    .all() as { id: string; value: string }[];
  for (const row of workspaceRows) {
    try {
      const snapshot = JSON.parse(row.value);
      const { windows, changed } = withoutHudWindows(snapshot.windows);
      if (changed) {
        snapshot.windows = windows;
        database
          .prepare(`UPDATE feature_settings SET value = ?, updatedAt = ? WHERE id = ?`)
          .run(JSON.stringify(snapshot), now(), row.id);
      }
    } catch {
      // Malformed workspace snapshot JSON — leave it.
    }
  }

  // Stale HUD feature_settings rows: hud_sheet (featureId='hud-overlay'),
  // any hud-widget rows, and any bare 'hud' rows.
  for (const featureId of HUD_FEATURE_IDS) {
    database.prepare(`DELETE FROM feature_settings WHERE featureId = ?`).run(featureId);
  }

  // Builtin-feature enabled/disabled entry for 'hud'.
  database.prepare(`DELETE FROM manifest_cache WHERE featureId = ?`).run('hud');

  // Context entries keyed by a HUD tile id — defensive, see header comment.
  for (const key of HUD_FEATURE_IDS) {
    database.prepare(`DELETE FROM context_history WHERE key = ?`).run(key);
  }

  database
    .prepare('INSERT OR REPLACE INTO migrations (id, status, completedAt) VALUES (?, ?, ?)')
    .run(MIGRATION_ID, 'complete', now());
}
