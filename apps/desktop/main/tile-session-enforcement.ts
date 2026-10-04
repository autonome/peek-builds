/**
 * Strict Session Capability Enforcement — Pure module (no Electron deps)
 *
 * Used by the `tile:session:*` IPC handlers in `tile-ipc.ts` to decide
 * whether a capability grant may perform a session operation.
 *
 * Mirrors the extracted pure-module pattern from
 * `tile-shortcuts-enforcement.ts` / `tile-window-enforcement.ts` so
 * these checks can be unit-tested without pulling in `tile-ipc`'s
 * Electron dependencies.
 *
 * Current surface: `save-workspace-snapshot`, `restore-workspace-snapshot`,
 * and `get-workspace-snapshot-info`, used by features/spaces and
 * features/groups to persist/reopen/inspect a named workspace's window
 * layout through the general session-snapshot pipeline (`main/session.ts
 * saveSessionSnapshot` / `restoreSessionSnapshot` /
 * `getWorkspaceSnapshotWindowInfo`, keyed by workspace id). The capability is
 * declared as `session: true` in the manifest (boolean only; no sub-flags
 * yet).
 */

import type { CapabilityGrant } from './tile-manifest.js';
import { DEFAULT_WORKSPACE_KEY } from './session-projection.js';

/**
 * Which session operation is being checked. Matches the
 * `tile:session:*` IPC channel suffix.
 *
 * - `save-workspace-snapshot` — persist the current window layout under a
 *   named workspace key. Used when features/groups or features/spaces
 *   modifies the layout and wants it saved before the next space switch.
 * - `restore-workspace-snapshot` — reopen a named workspace's saved layout
 *   through the same session-restore pipeline the app's own boot/quit
 *   snapshot uses. Used by features/spaces when entering a workspace.
 * - `get-workspace-snapshot-info` — read a named workspace's saved
 *   bounds/z-order without restoring anything. Used by features/groups
 *   `openGroup()` to reopen a group's windows in their last-saved layout —
 *   a narrow, workspace-scoped substitute for the foreign-settings read it
 *   used to make (`tile:settings:get-foreign` has no per-key scoping, so a
 *   `readForeign: ["session"]` grant would also expose the app's own
 *   default-workspace snapshot and crash-recovery metadata). The default
 *   workspace's own key is refused for this op — see `checkSessionAllowed`.
 * - `get-workspace-snapshot-window-count` — read only the NUMBER of windows a
 *   workspace's snapshot holds. Unlike the layout read it is allowed for the
 *   default workspace's key, since a count exposes none of the saved URLs.
 *   Used by features/spaces to label an inactive space card.
 * - `begin-workspace-switch` / `set-active-workspace` — the spaces feature
 *   reports which workspace is active (and brackets a switch) so the app's
 *   own ambient saves write the active workspace's row. See
 *   `main/session.ts` "Active workspace".
 */
export type SessionOp =
  | 'save-workspace-snapshot'
  | 'restore-workspace-snapshot'
  | 'get-workspace-snapshot-info'
  | 'get-workspace-snapshot-window-count'
  | 'begin-workspace-switch'
  | 'set-active-workspace';

export type SessionCheckResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Validate whether a grant may perform a session operation.
 *
 * Order of checks:
 *   1. Per-op argument rules that hold for EVERY caller, trusted or not:
 *      `get-workspace-snapshot-info` never answers for the default
 *      workspace's own key — that row is the app's whole last-quit window
 *      list, and this op exists precisely so a feature can read a NAMED
 *      workspace's layout without a foreign-settings grant that would expose
 *      it (`tile:settings:get-foreign` allowlists per-featureId, not per-key).
 *      Any future session read that takes a key belongs under the same rule
 *      here, not as a check inside its own handler.
 *   2. Grant must be non-null (token resolved).
 *   3. `session` capability must be truthy. Currently boolean-only.
 *
 * Reserved for future expansion (e.g. `session: { saveLayouts: true }`
 * with per-op flags, analogous to `window: { create, query, manage }`).
 */
export function checkSessionAllowed(
  grant: CapabilityGrant | null,
  op: SessionOp,
  args?: { key?: string },
): SessionCheckResult {
  if (op === 'get-workspace-snapshot-info' && args?.key === DEFAULT_WORKSPACE_KEY) {
    return { ok: false, error: 'the default workspace\'s own snapshot is not readable through get-workspace-snapshot-info' };
  }

  if (!grant) return { ok: false, error: 'Invalid token' };
  // Trusted-builtin core renderers bypass the session gate.
  if (grant.trustedBuiltin) return { ok: true };

  const sc = grant.capabilities.session;
  if (!sc) return { ok: false, error: 'session capability not granted' };

  switch (op) {
    case 'save-workspace-snapshot':
    case 'restore-workspace-snapshot':
    case 'get-workspace-snapshot-info':
    case 'get-workspace-snapshot-window-count':
    case 'begin-workspace-switch':
    case 'set-active-workspace': {
      return { ok: true };
    }

    default: {
      const _exhaustive: never = op;
      return { ok: false, error: `unknown session op: ${String(_exhaustive)}` };
    }
  }
}
