/**
 * Strict Dialogs Capability Enforcement — Pure module (no Electron deps)
 *
 * Used by the `tile:dialogs:*` IPC handlers in `tile-ipc.ts` to decide
 * whether a capability grant may invoke a native file dialog (save/open).
 *
 * Mirrors the extracted pure-module pattern from
 * `tile-shortcuts-enforcement.ts` so these checks can be unit-tested
 * without pulling in `tile-ipc`'s Electron dependencies.
 *
 * Background: the v1-compat surface exposed file dialogs via the
 * `file-save-dialog` / `file-open-dialog` IPC channels and the
 * `api.files.save` / `api.files.open` preload wrappers, with NO
 * capability check. The strict handlers gate the same underlying
 * Electron `dialog.show{Save,Open}Dialog` calls behind a declared
 * `dialogs` capability plus an optional per-type allowlist.
 */

import type { CapabilityGrant, DialogType, DialogsCapability } from './tile-manifest.js';

export type DialogsCheckResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Normalise a dialogs-capability grant into a `DialogsCapability`
 * object shape. `dialogs: true` becomes `{}` (unrestricted). Any
 * falsy/invalid value returns `null` so the caller can short-circuit
 * with "capability not granted".
 */
function normaliseGrant(grant: CapabilityGrant | null): DialogsCapability | null {
  if (!grant) return null;
  const dc = grant.capabilities.dialogs;
  if (!dc) return null;
  if (dc === true) return {};
  if (typeof dc === 'object') return dc;
  return null;
}

/**
 * Validate whether a grant may show the given dialog type.
 *
 * Order of checks:
 *   1. Grant must be non-null (token resolved).
 *   2. `dialogs` capability must be present.
 *   3. If the capability is `{ types: [...] }`, the requested type
 *      must appear in the list.
 *
 * Treats `dialogs: true` and `dialogs: {}` (object without `types`)
 * as unrestricted. Treats `dialogs: { types: [] }` as fully locked —
 * no dialog type is allowed. This matches the manifest author's
 * intent: an explicit empty allowlist means "I declared the
 * capability but block everything".
 */
export function checkDialogAllowed(
  grant: CapabilityGrant | null,
  type: DialogType,
): DialogsCheckResult {
  if (!grant) return { ok: false, error: 'Invalid token' };
  // Trusted-builtin core renderers bypass every dialog gate.
  if (grant.trustedBuiltin) return { ok: true };

  const cap = normaliseGrant(grant);
  if (!cap) return { ok: false, error: 'dialogs capability not granted' };

  if (cap.types) {
    if (!cap.types.includes(type)) {
      return { ok: false, error: `dialog type "${type}" not in capability types allowlist` };
    }
  }

  return { ok: true };
}
