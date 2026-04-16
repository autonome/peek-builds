/**
 * Strict Settings-Foreign Capability Enforcement — Pure module (no Electron deps)
 *
 * Used by the `tile:settings:get-foreign` IPC handler in `tile-ipc.ts`
 * to decide whether a capability grant may read a setting from ANOTHER
 * tile's `feature_settings` namespace.
 *
 * Mirrors the extracted pure-module pattern from
 * `tile-shortcuts-enforcement.ts` / `tile-dialogs-enforcement.ts` /
 * `tile-features-enforcement.ts` so these checks can be unit-tested
 * without pulling in `tile-ipc`'s Electron dependencies.
 *
 * Background: the v1-compat surface exposes `api.settings.getExtKey(extId, key)`
 * via the `feature-settings-get-key` IPC channel with NO capability check —
 * any tile could read any other tile's stored settings. A handful of features
 * depend on this (features-manager reads `lex.session`, groups reads
 * `spaces.workspace:*`, tags reads `editor.prefs`, peeks similar). Rather
 * than keep the un-gated surface open, the strict handler requires the
 * reading tile to declare a per-tile allowlist via `settings.readForeign`
 * (when `settings` is the existing object form) or the convenience flat
 * `settingsForeign` array. Either way the list is consulted at IPC time.
 *
 * Capability shape chosen:
 *   "settings": true | { readForeign: string[] }
 * with a fallback top-level `settingsForeign: string[]` allowed when the
 * existing `settings` cap is the plain boolean form.
 *
 * Strict write-foreign is NOT provided — cross-tile writes remain denied
 * universally (the v1 `feature-settings-set-key` channel writes in the
 * caller's scope only via `api.settings.set*`).
 */

import type { CapabilityGrant, TileCapabilities } from './tile-manifest.js';

export type SettingsForeignCheckResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Resolve the effective foreign-read allowlist from the grant.
 *
 * Two manifest shapes are accepted (see tile-manifest.ts):
 *   - `settings: { readForeign: ['lex', 'editor'] }` — the preferred form,
 *     co-locating the allowlist with the existing `settings` capability.
 *   - `settings: true, settingsForeign: ['lex']` — fallback for manifests
 *     that still use the boolean `settings: true` form.
 *
 * Returns `null` when no foreign-read list is declared on the grant. An
 * empty array means "declared but empty" — the caller should treat that
 * as an explicit lock ("I want foreign-read but name no one").
 */
function resolveForeignList(grant: CapabilityGrant): string[] | null {
  const caps = grant.capabilities as TileCapabilities & {
    settingsForeign?: string[];
  };

  // Preferred form: settings object with readForeign list.
  if (caps.settings && typeof caps.settings === 'object') {
    const s = caps.settings as { readForeign?: unknown };
    if (Array.isArray(s.readForeign)) return s.readForeign as string[];
  }

  // Fallback form: top-level `settingsForeign` array (usable alongside
  // `settings: true`).
  if (Array.isArray(caps.settingsForeign)) return caps.settingsForeign;

  return null;
}

/**
 * Validate whether a grant may read the setting `key` from tile
 * `foreignExtId`'s `feature_settings` namespace.
 *
 * Order of checks:
 *   1. Grant must be non-null (token resolved).
 *   2. `settings` capability must be present — you can't foreign-read
 *      without the baseline settings capability.
 *   3. A foreign-read list must be declared (either `settings.readForeign`
 *      or top-level `settingsForeign`). Missing = capability not granted.
 *   4. `foreignExtId` must appear in that allowlist. A `'*'` entry grants
 *      blanket access (builtins only — external tiles SHOULD enumerate).
 *   5. Self-reads (`foreignExtId === grant.tileId`) always allowed — the
 *      tile can already read its own settings via `tile:settings:get`, so
 *      we don't surprise callers who pass their own id here.
 */
export function checkSettingsForeignAllowed(
  grant: CapabilityGrant | null,
  foreignExtId: string,
): SettingsForeignCheckResult {
  if (!grant) return { ok: false, error: 'Invalid token' };

  // Reject empty / non-string ext ids early.
  if (typeof foreignExtId !== 'string' || foreignExtId.length === 0) {
    return { ok: false, error: 'foreignExtId is required' };
  }

  // Self-read always permitted — equivalent to `tile:settings:get`.
  if (foreignExtId === grant.tileId) return { ok: true };

  // Baseline `settings` capability required.
  const caps = grant.capabilities;
  if (!caps.settings) {
    return { ok: false, error: 'settings capability not granted' };
  }

  const allowlist = resolveForeignList(grant);
  if (!allowlist) {
    return {
      ok: false,
      error: 'settings.readForeign capability not granted',
    };
  }

  if (allowlist.includes('*')) return { ok: true };

  if (!allowlist.includes(foreignExtId)) {
    return {
      ok: false,
      error: `foreign tile "${foreignExtId}" not in settings.readForeign allowlist`,
    };
  }

  return { ok: true };
}
