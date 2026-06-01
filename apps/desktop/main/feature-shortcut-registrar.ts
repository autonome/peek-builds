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
import { type TileManifest } from './tile-manifest.js';
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
}

let deps: RegistrarDeps = {
  registerGlobalShortcut: _registerGlobalShortcut,
  unregisterShortcutsForAddress: _unregisterShortcutsForAddress,
  publish: _publish,
  getSystemAddress: _getSystemAddress,
};

export function __setFeatureShortcutRegistrarDepsForTest(override: Partial<RegistrarDeps> | null): void {
  if (override === null) {
    deps = {
      registerGlobalShortcut: _registerGlobalShortcut,
      unregisterShortcutsForAddress: _unregisterShortcutsForAddress,
      publish: _publish,
      getSystemAddress: _getSystemAddress,
    };
    return;
  }
  deps = {
    registerGlobalShortcut: override.registerGlobalShortcut ?? _registerGlobalShortcut,
    unregisterShortcutsForAddress: override.unregisterShortcutsForAddress ?? _unregisterShortcutsForAddress,
    publish: override.publish ?? _publish,
    getSystemAddress: override.getSystemAddress ?? _getSystemAddress,
  };
}

/** The source-address namespace under which this registrar tracks accelerators. */
export function lazyShortcutSource(tileId: string): string {
  return `peek://${tileId}/lazy-shortcut`;
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
  const shortcuts = manifest.shortcuts;
  if (!Array.isArray(shortcuts) || shortcuts.length === 0) return;

  const tileId = manifest.id;
  const source = lazyShortcutSource(tileId);
  const systemAddress = deps.getSystemAddress();

  for (const sc of shortcuts) {
    if (!sc || typeof sc.keys !== 'string' || typeof sc.command !== 'string') continue;
    // A manifest shortcut is global unless it explicitly opts out.
    if (sc.global === false) continue;

    const command = sc.command;
    const err = deps.registerGlobalShortcut(sc.keys, source, () => {
      // The keypress's sole job: kick the existing lazy-wake hook by
      // publishing the command's execute topic. The hook boots the tile
      // (if needed) and delivers to the woken renderer's handler.
      deps.publish(systemAddress, `cmd:execute:${command}`, {});
    });

    if (err) {
      // registerGlobalShortcut already logs the specific failure (or the
      // single Wayland hint). Nothing actionable here; the tile remains
      // reachable via the cmd palette and any renderer-local path.
      DEBUG && console.warn(`[feature-shortcut-registrar] failed to register ${sc.keys} for ${tileId}: ${err.message}`);
      continue;
    }
    DEBUG && console.log(`[feature-shortcut-registrar] ${tileId}: ${sc.keys} → cmd:execute:${command}`);
  }
}

/**
 * Tear down every accelerator this registrar owns for a tile. Safe to
 * call when none were registered (e.g. manifest had no shortcuts).
 */
export function unregisterManifestShortcuts(tileId: string): void {
  deps.unregisterShortcutsForAddress(lazyShortcutSource(tileId));
}
