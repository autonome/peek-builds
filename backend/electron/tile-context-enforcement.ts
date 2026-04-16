/**
 * Strict Context Capability Enforcement — Pure module (no Electron deps)
 *
 * Used by the `tile:context:*` IPC handlers in `tile-ipc.ts` to decide
 * whether a capability grant may perform a context-store operation.
 *
 * Mirrors the extracted pure-module pattern from
 * `tile-shortcuts-enforcement.ts` so these checks can be unit-tested
 * without pulling in `tile-ipc`'s Electron dependencies (ipcMain,
 * BrowserWindow, dialog, webContents, nativeTheme, etc.).
 *
 * See `docs/tile-preload-trimming-plan.md` §2.5 for the capability
 * shape and §6 for the test strategy.
 */

import type { CapabilityGrant, ContextCapability } from './tile-manifest.js';

/**
 * Which context operation is being checked. Matches the
 * `tile:context:*` IPC channel suffix and the shape of the
 * v1-compat `api.context.*` surface in tile-preload.
 *
 * - `get` / `history` — read a key; gated by `read` allowlist.
 * - `set` — write a key; gated by `write` allowlist. Writes to the
 *   well-known `mode` key additionally require `modes: true`.
 * - `snapshot` — requires only that the capability is granted.
 * - `windowsWithValue` / `windowsInSpace` — require `queryWindows`.
 */
export type ContextOp =
  | 'get'
  | 'set'
  | 'history'
  | 'snapshot'
  | 'windowsWithValue'
  | 'windowsInSpace';

export type ContextCheckResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Normalise a context-capability grant into a `ContextCapability`
 * object shape. `context: true` becomes `{}` (unrestricted). Any
 * falsy/invalid value returns `null` so the caller can short-circuit
 * with "capability not granted".
 */
function normaliseGrant(grant: CapabilityGrant | null): ContextCapability | null {
  if (!grant) return null;
  const cc = grant.capabilities.context;
  if (!cc) return null;
  if (cc === true) return {};
  if (typeof cc === 'object') return cc;
  return null;
}

/**
 * Validate whether a grant may perform a context operation.
 *
 * For key-scoped ops (`get`, `set`, `history`), the `key` argument is
 * required and checked against the relevant allowlist. For the other
 * ops the `key` is ignored.
 *
 * Order of checks:
 *   1. Grant must be non-null (token resolved).
 *   2. `context` capability must be present.
 *   3. Per-op checks:
 *      - `get` / `history`: key must be in `read` allowlist when set.
 *      - `set`: key must be in `write` allowlist when set. If key is
 *        the well-known `mode` string, `modes: true` is additionally
 *        required.
 *      - `snapshot`: no additional check.
 *      - `windowsWithValue` / `windowsInSpace`: require `queryWindows: true`.
 *
 * Rationale for the `mode`-key special case: the `mode` key drives
 * window/space/group routing across Peek and is power-user territory.
 * Tiles that declare `context: { write: ['mode'] }` without
 * `modes: true` are almost certainly doing something unintended; the
 * explicit flag is a belt-and-braces guard.
 */
export function checkContextAllowed(
  grant: CapabilityGrant | null,
  op: ContextOp,
  key?: string,
): ContextCheckResult {
  if (!grant) return { ok: false, error: 'Invalid token' };

  const cap = normaliseGrant(grant);
  if (!cap) return { ok: false, error: 'context capability not granted' };

  switch (op) {
    case 'get':
    case 'history': {
      if (cap.read) {
        if (typeof key !== 'string' || key.length === 0) {
          return { ok: false, error: 'context key required for read operations' };
        }
        if (!cap.read.includes(key)) {
          return { ok: false, error: `context key "${key}" not in read allowlist` };
        }
      }
      return { ok: true };
    }

    case 'set': {
      if (typeof key !== 'string' || key.length === 0) {
        return { ok: false, error: 'context key required for set operations' };
      }
      if (cap.write && !cap.write.includes(key)) {
        return { ok: false, error: `context key "${key}" not in write allowlist` };
      }
      // Belt-and-braces: writing the `mode` key requires the modes flag.
      if (key === 'mode' && cap.modes !== true) {
        return { ok: false, error: 'context.modes capability required to write "mode" key' };
      }
      return { ok: true };
    }

    case 'snapshot': {
      return { ok: true };
    }

    case 'windowsWithValue':
    case 'windowsInSpace': {
      if (cap.queryWindows !== true) {
        return { ok: false, error: 'context.queryWindows capability required' };
      }
      return { ok: true };
    }

    default: {
      // Exhaustiveness guard.
      const _exhaustive: never = op;
      return { ok: false, error: `unknown context op: ${String(_exhaustive)}` };
    }
  }
}
