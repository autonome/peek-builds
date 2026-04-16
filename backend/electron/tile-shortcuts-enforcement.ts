/**
 * Strict Shortcut Capability Enforcement — Pure module (no Electron deps)
 *
 * Used by the `tile:shortcuts:register` / `tile:shortcuts:unregister`
 * IPC handlers in `tile-ipc.ts` to decide whether a capability grant
 * may register a given shortcut. See §HIGH bypass #2 in the security
 * audit — prior to this, tiles could register global hotkeys via the
 * legacy `registershortcut` channel without declaring the `shortcuts`
 * capability.
 *
 * Extracted into its own module (rather than living inside tile-ipc.ts)
 * so it can be unit-tested without importing tile-ipc's Electron
 * dependencies (ipcMain, BrowserWindow, net, dialog, webContents).
 */

import type { CapabilityGrant } from './tile-manifest.js';

/**
 * Result of a strict-shortcut enforcement check.
 *
 * `ok: true` means the shortcut may be registered; on `ok: false`
 * `error` contains a short human-readable reason (safe to surface
 * back to the renderer over IPC).
 */
export type ShortcutCheckResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Validate whether a grant may register the given shortcut string.
 *
 * Order of checks:
 *   1. `grant` must be non-null (caller has resolved the token).
 *   2. `grant.capabilities.shortcuts` must be truthy.
 *   3. If the capability is an object with a `keys` array, the
 *      shortcut must appear in that array.
 *
 * Treats `shortcuts: true` and `shortcuts: {}` (object without
 * `keys`) as unrestricted. Treats `shortcuts: { keys: [] }` as
 * fully locked — no shortcut is allowed. This matches the
 * manifest author's intent: an explicit empty allowlist means
 * "I declared the capability but block all shortcuts".
 */
export function checkShortcutAllowed(
  grant: CapabilityGrant | null,
  shortcut: string,
): ShortcutCheckResult {
  if (!grant) return { ok: false, error: 'Invalid token' };

  const scCap = grant.capabilities.shortcuts;
  if (!scCap) return { ok: false, error: 'shortcuts capability not granted' };

  // `scCap === true` — unrestricted: any shortcut is allowed.
  if (scCap === true) return { ok: true };

  // Object form: if `keys` is present, it's an allowlist.
  if (typeof scCap === 'object') {
    const keys = (scCap as { keys?: unknown }).keys;
    if (Array.isArray(keys)) {
      if (!keys.includes(shortcut)) {
        return { ok: false, error: `shortcut "${shortcut}" not in capability keys allowlist` };
      }
    }
    // No `keys` — object without allowlist behaves like `true`.
    return { ok: true };
  }

  // Anything else (false, null, number, etc.) — not granted.
  return { ok: false, error: 'shortcuts capability not granted' };
}
