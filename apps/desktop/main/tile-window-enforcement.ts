// Pure module (no Electron deps) deciding whether a capability grant may perform a window
// operation; used by the `tile:window:*` IPC handlers in tile-ipc.ts. Unit-testable without
// pulling in tile-ipc's Electron dependencies (ipcMain, BrowserWindow, dialog, webContents).
import type { CapabilityGrant, WindowCapability } from './tile-manifest.js';

export type WindowOp =
  | 'open'
  | 'close'
  | 'list'
  | 'info'
  | 'exists'
  | 'show'
  | 'hide'
  | 'focus'
  | 'set-ignore-mouse'
  | 'center'
  | 'center-all'
  | 'maximize'
  | 'fullscreen'
  | 'get-focused-visible-id'
  | 'get-see-through'
  | 'set-see-through'
  | 'set-overlay-focus-target'
  | 'set-visible-on-all-workspaces'
  | 'set-pinned';

export type WindowCheckResult =
  | { ok: true }
  | { ok: false; error: string };

function normaliseGrant(grant: CapabilityGrant | null): WindowCapability | null {
  if (!grant) return null;
  const wc = grant.capabilities.window;
  if (!wc) return null;
  if (wc === true) return { create: true, query: true, manage: true };
  if (typeof wc === 'object') return wc;
  return null;
}

export function checkWindowAllowed(
  grant: CapabilityGrant | null,
  op: WindowOp,
  args?: { url?: string; ownWindow?: boolean },
): WindowCheckResult {
  if (!grant) return { ok: false, error: 'Invalid token' };
  // Trusted-builtin core renderers bypass every window gate.
  if (grant.trustedBuiltin) return { ok: true };

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
      // A tile closing its own window (ownWindow: true) is always allowed; closing another
      // tile's window requires `manage`.
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
    case 'focus':
    case 'set-ignore-mouse':
    case 'center':
    case 'center-all':
    case 'maximize':
    case 'fullscreen':
    case 'set-see-through':
    case 'set-overlay-focus-target':
    case 'set-visible-on-all-workspaces':
    case 'set-pinned': {
      if (cap.manage !== true) {
        return { ok: false, error: `window.manage capability required for ${op}` };
      }
      return { ok: true };
    }

    case 'get-focused-visible-id': {
      if (cap.query !== true) {
        return { ok: false, error: 'window.query capability not granted' };
      }
      return { ok: true };
    }

    case 'get-see-through': {
      // Reading a window's see-through state is a query. A tile reading its
      // OWN state (ownWindow: true) is always allowed, so a card view can
      // apply a session-restored switch without asking for `query`.
      if (args?.ownWindow === true) return { ok: true };
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
