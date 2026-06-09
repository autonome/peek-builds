/**
 * feature-shortcut-registrar — generic main-side bridge from a tile's
 * manifest-declared `shortcuts[]` to the OS global accelerator.
 *
 * Purpose: a LAZY tile (no resident BrowserWindow at boot) can still
 * own a global hotkey. Its renderer isn't running, so it can't call
 * `api.shortcuts.register` itself until something wakes it — but waking
 * it is exactly what the hotkey must do. This registrar closes that
 * chicken-and-egg gap:
 *
 *   For each `{ keys, command }` in `manifest.shortcuts`, register an OS
 *   global accelerator whose callback PUBLISHES `cmd:execute:<command>`
 *   on the System address. That publish flows through the existing
 *   load-on-dispatch hook (tile-lazy.ts), which boots the tile, waits
 *   for READY, and then lets the publish reach the tile's freshly-
 *   subscribed real handler. One mechanism, no per-feature glue.
 *
 * Frontend/backend separation: this file registers ONLY infrastructure
 * (an OS accelerator) and routes the keypress to the existing pubsub
 * dispatch seam. It contains NO feature logic — the command body still
 * lives in the feature's renderer (e.g. windows/background.js), which
 * runs once the tile is woken. The registrar is feature-agnostic; it
 * will serve peeks and any future lazy feature with `shortcuts[]`.
 *
 * Source-address convention: every accelerator this registrar owns is
 * tracked under `peek://<tileId>/lazy-shortcut`, so teardown is a single
 * `unregisterShortcutsForAddress(...)` call (mirrors how the renderer-
 * side path used `unregisterShortcutsForAddress(source)`).
 */

import { registerGlobalShortcut as _registerGlobalShortcut, unregisterShortcutsForAddress as _unregisterShortcutsForAddress } from './shortcuts.js';
import { publish as _publish, getSystemAddress as _getSystemAddress } from './pubsub.js';
import { getWakeShortcuts as _getWakeShortcuts, hasDeclaredWakeShortcuts as _hasDeclaredWakeShortcuts, hasFeatureSettings as _hasFeatureSettings, type WakeShortcut } from './datastore.js';
import { type TileManifest, type TileShortcut } from './tile-manifest.js';
import { DEBUG } from './config.js';

// ─── Injection seam (for testability) ──────────────────────────────────
//
// The registrar talks to the global-shortcut + pubsub modules through
// these slots so a unit test can swap in spies, capture the registered
// callback, and assert it publishes `cmd:execute:<command>` — all
// without Electron. Production uses the real imports.

interface RegistrarDeps {
  registerGlobalShortcut: (shortcut: string, source: string, callback: () => void) => Error | undefined;
  unregisterShortcutsForAddress: (address: string) => void;
  publish: (source: string, topic: string, msg: unknown) => void;
  getSystemAddress: () => string;
  getWakeShortcuts: (ownerTileId: string) => WakeShortcut[];
  hasDeclaredWakeShortcuts: (ownerTileId: string) => boolean;
  hasFeatureSettings: (ownerTileId: string) => boolean;
}

function defaultDeps(): RegistrarDeps {
  return {
    registerGlobalShortcut: _registerGlobalShortcut,
    unregisterShortcutsForAddress: _unregisterShortcutsForAddress,
    publish: _publish,
    getSystemAddress: _getSystemAddress,
    getWakeShortcuts: _getWakeShortcuts,
    hasDeclaredWakeShortcuts: _hasDeclaredWakeShortcuts,
    hasFeatureSettings: _hasFeatureSettings,
  };
}

let deps: RegistrarDeps = defaultDeps();

export function __setFeatureShortcutRegistrarDepsForTest(override: Partial<RegistrarDeps> | null): void {
  if (override === null) {
    deps = defaultDeps();
    return;
  }
  const base = defaultDeps();
  deps = {
    registerGlobalShortcut: override.registerGlobalShortcut ?? base.registerGlobalShortcut,
    unregisterShortcutsForAddress: override.unregisterShortcutsForAddress ?? base.unregisterShortcutsForAddress,
    publish: override.publish ?? base.publish,
    getSystemAddress: override.getSystemAddress ?? base.getSystemAddress,
    getWakeShortcuts: override.getWakeShortcuts ?? base.getWakeShortcuts,
    hasDeclaredWakeShortcuts: override.hasDeclaredWakeShortcuts ?? base.hasDeclaredWakeShortcuts,
    hasFeatureSettings: override.hasFeatureSettings ?? base.hasFeatureSettings,
  };
}

/** The source-address namespace under which this registrar tracks accelerators. */
export function lazyShortcutSource(tileId: string): string {
  return `peek://${tileId}/lazy-shortcut`;
}

/**
 * Map a manifest `shortcuts[]` to the generic WakeShortcut wire form,
 * resolving each entry's wake target:
 *   - command form `{ keys, command }` → `wakeTopic = 'cmd:execute:'+command`,
 *     no args (keypress kicks the existing load-on-dispatch hook).
 *   - topic form `{ keys, wakeTopic, wakeArgs? }` → that topic + args.
 * Skips entries that opt out of global (`global: false`) or are malformed.
 */
export function manifestShortcutsToWake(shortcuts: TileShortcut[] | undefined): WakeShortcut[] {
  if (!Array.isArray(shortcuts)) return [];
  const out: WakeShortcut[] = [];
  for (const sc of shortcuts) {
    if (!sc || typeof sc.keys !== 'string') continue;
    if (sc.global === false) continue; // focus-local — renderer's concern
    if (typeof sc.command === 'string') {
      out.push({ accelerator: sc.keys, wakeTopic: `cmd:execute:${sc.command}`, wakeArgs: [] });
    } else if (typeof sc.wakeTopic === 'string') {
      out.push({ accelerator: sc.keys, wakeTopic: sc.wakeTopic, wakeArgs: Array.isArray(sc.wakeArgs) ? sc.wakeArgs : [] });
    }
  }
  return out;
}

/**
 * Register a flat list of wake shortcuts for a tile. Each accelerator's
 * keypress publishes `wakeTopic` with `{ args: wakeArgs }` on the System
 * address — the publish flows through the load-on-dispatch hook to wake
 * the tile. Returns nothing; per-shortcut failures are logged.
 *
 * Idempotent at the OS layer (registerGlobalShortcut unregisters any
 * prior grab of the same accelerator first).
 */
export function registerWakeShortcutList(tileId: string, list: WakeShortcut[]): void {
  if (!Array.isArray(list) || list.length === 0) return;
  const source = lazyShortcutSource(tileId);
  const systemAddress = deps.getSystemAddress();

  for (const sc of list) {
    if (!sc || typeof sc.accelerator !== 'string' || typeof sc.wakeTopic !== 'string') continue;
    const wakeTopic = sc.wakeTopic;
    const wakeArgs = Array.isArray(sc.wakeArgs) ? sc.wakeArgs : [];
    const err = deps.registerGlobalShortcut(sc.accelerator, source, () => {
      deps.publish(systemAddress, wakeTopic, { args: wakeArgs });
    });
    if (err) {
      DEBUG && console.warn(`[feature-shortcut-registrar] failed to register ${sc.accelerator} for ${tileId}: ${err.message}`);
      continue;
    }
    DEBUG && console.log(`[feature-shortcut-registrar] ${tileId}: ${sc.accelerator} → ${wakeTopic}`);
  }
}

/**
 * Boot-replay entry point. Registers a lazy tile's global wake hotkeys,
 * picking the source with PRECEDENCE:
 *   1. if the tile has EVER declared its wake set (`hasDeclaredWakeShortcuts`)
 *      register exactly the persisted `lazy_wake_shortcuts` rows — which may
 *      be EMPTY (the user cleared every hotkey → register NOTHING). The
 *      declared marker is what distinguishes "declared empty" from "never
 *      declared"; a plain empty-rows check could not.
 *   2. otherwise (never declared, e.g. a fresh profile) the manifest's
 *      static default `shortcuts[]` entries (command-style or wakeTopic-
 *      style) — the fresh-profile defaults.
 *
 * This replaces the old `registerManifestShortcuts(manifest)` call in the
 * lazy-load branch, so windows (manifest `{keys, command}`, no persisted
 * rows, never declared) still registers exactly as before via the
 * manifest-defaults path.
 */
export function registerWakeShortcuts(tileId: string, manifest: TileManifest): void {
  if (deps.hasDeclaredWakeShortcuts(tileId)) {
    // Declared at least once → the persisted set is authoritative, even if
    // empty (register nothing). Manifest defaults are NOT consulted.
    registerWakeShortcutList(tileId, deps.getWakeShortcuts(tileId));
    return;
  }
  registerWakeShortcutList(tileId, manifestShortcutsToWake(manifest.shortcuts));
}

/**
 * Decide whether a lazy tile needs a one-time boot-time WAKE so its renderer
 * can declare its settings-derived global hotkeys.
 *
 * The hazard this closes: a feature whose real wake hotkeys are DERIVED FROM
 * USER SETTINGS (peeks/slides: `prefix × enabled items`) computes them in its
 * renderer and persists them via `declareWakeShortcuts` — but only when the
 * lazy tile boots. On a MIGRATED profile (settings saved before the lazy-wake
 * system, so `hasDeclaredWakeShortcuts` is false), boot-replay registers only
 * the manifest's STATIC default (`registerWakeShortcuts`). If the user's saved
 * prefix differs from that default, the user presses keys that aren't
 * registered → the tile is never woken → it never declares → the table stays
 * empty forever (a deadlock). Waking it once breaks the cycle: the renderer
 * declares the real set, which both registers it now and sets the declared
 * marker so this never fires again.
 *
 * True iff ALL hold:
 *   - `manifest.wakeShortcutsFromSettings === true` (hotkeys are settings-
 *     derived AND the renderer is known to declare them — gating on this
 *     avoids re-waking static-shortcut tiles like windows every boot), AND
 *   - the tile has NEVER declared its wake set (`!hasDeclaredWakeShortcuts`),
 *     AND
 *   - the tile has SAVED feature settings (`hasFeatureSettings`) — i.e. a
 *     configured/migrated profile, not a fresh one (a fresh profile keeps the
 *     manifest defaults and boots the tile lazily on the first hotkey press).
 *
 * Pure (no side effects) so it's unit-testable via the injection seam; the
 * actual wake is the caller's job (tile-compat → tile-lazy backfill).
 */
export function wakeDeclarationBackfillNeeded(tileId: string, manifest: TileManifest): boolean {
  if (!manifest || manifest.wakeShortcutsFromSettings !== true) return false;
  if (deps.hasDeclaredWakeShortcuts(tileId)) return false;
  return deps.hasFeatureSettings(tileId);
}

/**
 * Register every manifest-declared global shortcut for a tile, routing
 * each keypress to `cmd:execute:<command>` on the System address.
 *
 * Idempotent at the OS layer: `registerGlobalShortcut` unregisters any
 * prior grab of the same accelerator before re-registering, so calling
 * this twice for the same tile (re-register, reload) won't leak.
 *
 * Only `shortcut.global !== false` shortcuts are taken here — a manifest
 * may declare a non-global (focus-local) shortcut, which is the
 * renderer's concern, not the OS-global registrar's. The windows
 * manifest's `CommandOrControl+Shift+W → windows` is global (default).
 */
export function registerManifestShortcuts(manifest: TileManifest): void {
  // Thin alias over the unified path: register the manifest's static
  // default shortcut entries (command-style → `cmd:execute:<command>`,
  // or wakeTopic-style → that topic). Kept for callers/tests that want
  // the manifest-defaults path explicitly; `registerWakeShortcuts`
  // adds the persisted-rows precedence on top.
  registerWakeShortcutList(manifest.id, manifestShortcutsToWake(manifest.shortcuts));
}

/**
 * Tear down every accelerator this registrar owns for a tile. Safe to
 * call when none were registered (e.g. manifest had no shortcuts).
 */
export function unregisterManifestShortcuts(tileId: string): void {
  deps.unregisterShortcutsForAddress(lazyShortcutSource(tileId));
}
