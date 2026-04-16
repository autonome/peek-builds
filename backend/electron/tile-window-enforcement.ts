/**
 * Strict Window Capability Enforcement — Pure module (no Electron deps)
 *
 * Used by the `tile:window:*` IPC handlers in `tile-ipc.ts` to decide
 * whether a capability grant may perform a window operation.
 *
 * Mirrors the extracted pure-module pattern from
 * `tile-shortcuts-enforcement.ts` / `tile-context-enforcement.ts` /
 * `tile-dialogs-enforcement.ts` so these checks can be unit-tested
 * without pulling in `tile-ipc`'s Electron dependencies (ipcMain,
 * BrowserWindow, dialog, webContents).
 *
 * Background: the v1-compat surface exposed window operations via the
 * un-gated `window-open` / `window-close` / `window-list` IPC channels
 * with no capability check. The strict handlers gate the same
 * underlying flow behind a declared `window` capability plus optional
 * per-action flags and a URL-prefix allowlist for `open`.
 */

import type { CapabilityGrant, WindowCapability } from './tile-manifest.js';

/**
 * Which window operation is being checked. Matches the
 * `tile:window:*` IPC channel suffix and the shape of the
 * `api.window.*` surface in tile-preload.
 *
 * - `open` — create a new window; gated by `create` and optional `urls`.
 * - `close` — close an existing window; gated by `manage` when closing a
 *   window the tile does not own.
 * - `list` — enumerate windows; gated by `query`.
 * - `info` — inspect the tile's own window; gated by `query`.
 * - `exists` — check whether a window id is still open; gated by `manage`.
 * - `show` — make a hidden window visible; gated by `manage`.
 * - `hide` — hide a visible window; gated by `manage`.
 * - `set-ignore-mouse` — toggle click-through on a window; gated by `manage`.
 * - `center` — center a window on its display; gated by `manage`.
 * - `center-all` — center every visible window; gated by `manage`.
 * - `maximize` — toggle maximize on a window; gated by `manage`.
 * - `fullscreen` — toggle fullscreen on a window; gated by `manage`.
 * - `get-focused-visible-id` — read lastFocusedVisibleWindowId; gated by `query`.
 * - `set-overlay-focus-target` — set overlay restore target; gated by `manage`.
 * - `set-visible-on-all-workspaces` — pin window across macOS Spaces; gated by `manage`.
 */
export type WindowOp =
  | 'open'
  | 'close'
  | 'list'
  | 'info'
  | 'exists'
  | 'show'
  | 'hide'
  | 'set-ignore-mouse'
  | 'center'
  | 'center-all'
  | 'maximize'
  | 'fullscreen'
  | 'get-focused-visible-id'
  | 'set-overlay-focus-target'
  | 'set-visible-on-all-workspaces';

export type WindowCheckResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Normalise a window-capability grant into a `WindowCapability` object
 * shape. `window: true` becomes `{create, query, manage}` all true
 * (unrestricted). Any falsy/invalid value returns `null` so the caller
 * can short-circuit with "capability not granted".
 */
function normaliseGrant(grant: CapabilityGrant | null): WindowCapability | null {
  if (!grant) return null;
  const wc = grant.capabilities.window;
  if (!wc) return null;
  if (wc === true) return { create: true, query: true, manage: true };
  if (typeof wc === 'object') return wc;
  return null;
}

/**
 * Validate whether a grant may perform a window operation.
 *
 * For `open`, the `url` argument is required and checked against the
 * optional `urls` prefix allowlist. For the other ops `url` is ignored.
 *
 * Order of checks:
 *   1. Grant must be non-null (token resolved).
 *   2. `window` capability must be present.
 *   3. Per-op flag check (`create` / `query` / `manage`).
 *   4. For `open`: URL must be non-empty and, if `urls` is present,
 *      must start with one of the listed prefixes.
 *
 * Note: `close` without per-window identification (the tile closing its
 * own window) is treated as always allowed when the capability itself
 * is granted — callers pass `ownWindow: true` to signal this. Closing
 * another window requires the `manage` flag.
 */
export function checkWindowAllowed(
  grant: CapabilityGrant | null,
  op: WindowOp,
  args?: { url?: string; ownWindow?: boolean },
): WindowCheckResult {
  if (!grant) return { ok: false, error: 'Invalid token' };

  const cap = normaliseGrant(grant);
  if (!cap) return { ok: false, error: 'window capability not granted' };

  switch (op) {
    case 'open': {
      if (cap.create !== true) {
        return { ok: false, error: 'window.create capability not granted' };
      }
      const url = args?.url;
      if (typeof url !== 'string' || url.length === 0) {
        return { ok: false, error: 'url required for open operation' };
      }
      if (cap.urls) {
        const allowed = cap.urls.some(prefix => url.startsWith(prefix));
        if (!allowed) {
          return { ok: false, error: `url "${url}" not in window.urls allowlist` };
        }
      }
      return { ok: true };
    }

    case 'close': {
      // Closing the tile's own window is always allowed with the
      // capability. Closing a different window requires `manage`.
      if (args?.ownWindow === true) return { ok: true };
      if (cap.manage !== true) {
        return { ok: false, error: 'window.manage capability required to close another window' };
      }
      return { ok: true };
    }

    case 'list': {
      if (cap.query !== true) {
        return { ok: false, error: 'window.query capability not granted' };
      }
      return { ok: true };
    }

    case 'info': {
      if (cap.query !== true) {
        return { ok: false, error: 'window.query capability not granted' };
      }
      return { ok: true };
    }

    case 'exists':
    case 'show':
    case 'hide':
    case 'set-ignore-mouse':
    case 'center':
    case 'center-all':
    case 'maximize':
    case 'fullscreen':
    case 'set-overlay-focus-target':
    case 'set-visible-on-all-workspaces': {
      // Mutating / probing an existing window by id is treated as a
      // management operation. Gated by `manage`.
      if (cap.manage !== true) {
        return { ok: false, error: `window.manage capability required for ${op}` };
      }
      return { ok: true };
    }

    case 'get-focused-visible-id': {
      // Read-only — surface the last focused visible window id.
      // Treated as a query, gated by `query`.
      if (cap.query !== true) {
        return { ok: false, error: 'window.query capability not granted' };
      }
      return { ok: true };
    }

    default: {
      const _exhaustive: never = op;
      return { ok: false, error: `unknown window op: ${String(_exhaustive)}` };
    }
  }
}
