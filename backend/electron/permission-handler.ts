/**
 * Web Permission Request Handler
 *
 * Centralizes Chromium permission request handling for the profile session.
 * Replaces the previous blanket-allow installed by chrome-extensions.ts so we
 * can apply per-permission policy and (in a future phase) surface a Peek-native
 * approve/reject prompt to the user.
 *
 * Today's policy (Phase 1 — visibility only):
 *   - chrome-extension:// origins → allow (preserves prior behavior; extensions
 *     declare their permissions in manifest.json and Electron honors them).
 *   - All other origins → consult DEFAULT_POLICY map per permission name.
 *     Currently every permission defaults to allow so no real-world site
 *     regresses on this rollout. Each request is logged to stderr with origin
 *     + permission so we can see the live traffic before adding the prompt UI.
 *
 * Phase 2 will: (a) flip risky permissions (geolocation, media, midi,
 * screen-share) to "prompt" — store the callback in `pendingRequests`, publish
 * `page:permission-request` to the page-host renderer, and resolve when the
 * user responds via IPC; (b) persist per-origin decisions in feature_settings.
 *
 * See docs/tasks.md "Web permission requests" for the full plan.
 */

import type { Session } from 'electron';

const DEBUG = !!process.env.DEBUG;

/** Permissions that Electron may request via setPermissionRequestHandler. */
type PermissionName =
  | 'media'
  | 'geolocation'
  | 'notifications'
  | 'midi'
  | 'midiSysex'
  | 'pointerLock'
  | 'fullscreen'
  | 'openExternal'
  | 'window-management'
  | 'unknown'
  | 'clipboard-read'
  | 'clipboard-sanitized-write'
  | 'display-capture'
  | 'hid'
  | 'usb'
  | 'serial'
  | 'storage-access'
  | 'top-level-storage-access'
  | 'idle-detection'
  | 'window-placement'
  | 'speaker-selection'
  | 'background-fetch'
  | 'background-sync'
  | 'periodic-background-sync'
  | 'screen-wake-lock';

type Decision = 'allow' | 'deny' | 'prompt';

/**
 * Per-permission default policy applied to non-extension origins.
 *
 * 'prompt' is a placeholder for Phase 2 — today every entry resolves to
 * 'allow' via the resolveDecision() shim so we don't regress live sites
 * before the UI is shipped. Flipping a row to 'prompt' (once the UI lands)
 * is a one-line change.
 */
const DEFAULT_POLICY: Partial<Record<PermissionName, Decision>> = {
  geolocation: 'allow',
  media: 'allow',
  notifications: 'allow',
  midi: 'allow',
  midiSysex: 'allow',
  'clipboard-read': 'allow',
  'clipboard-sanitized-write': 'allow',
  'display-capture': 'allow',
  pointerLock: 'allow',
  fullscreen: 'allow',
  openExternal: 'allow',
};

/**
 * Pending request map — populated when a request is deferred to the UI.
 * Phase 2 will use this; today it stays empty (no policy entry resolves to
 * 'prompt'). Kept here so the Phase 2 IPC handler has somewhere to live
 * without churning the module shape.
 */
const pendingRequests = new Map<string, (granted: boolean) => void>();

let permissionHandlerInstalled = false;

export function installPermissionHandler(ses: Session): void {
  if (permissionHandlerInstalled) {
    DEBUG && console.log('[permission] Handler already installed, skipping');
    return;
  }
  permissionHandlerInstalled = true;

  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    // Synchronous check: invoked when a page calls e.g. navigator.permissions.query().
    // Mirror the request handler's policy so the answer is consistent.
    const url = webContents?.getURL?.() ?? requestingOrigin ?? '';
    const decision = resolveDecision(url, permission as PermissionName);
    return decision === 'allow';
  });

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingUrl =
      (details && (details as { requestingUrl?: string }).requestingUrl) ||
      webContents?.getURL?.() ||
      '';
    const decision = resolveDecision(requestingUrl, permission as PermissionName);

    console.log(
      `[permission] ${permission} requested by ${requestingUrl || '(unknown)'} → ${decision}`,
    );

    if (decision === 'allow') {
      callback(true);
      return;
    }
    if (decision === 'deny') {
      callback(false);
      return;
    }
    // 'prompt' — Phase 2 stores the callback and surfaces the UI. For now
    // (no policy entry returns 'prompt'), this branch is unreachable; if a
    // future policy entry lands without the UI being wired, fall back to
    // deny so we never leave the page silently waiting forever.
    console.warn(
      `[permission] ${permission} resolved to 'prompt' but no UI installed — denying`,
    );
    callback(false);
  });

  DEBUG && console.log('[permission] Handler installed on profile session');
}

function resolveDecision(url: string, permission: PermissionName): Decision {
  // Chrome extension URLs are always allowed — extensions declare their
  // permissions in manifest.json and Electron honors them.
  if (url.startsWith('chrome-extension://')) return 'allow';

  // peek:// internal pages — allow (we control them).
  if (url.startsWith('peek://')) return 'allow';

  return DEFAULT_POLICY[permission] ?? 'deny';
}

/**
 * Test-only: reset module state so tests can re-install with a fresh session.
 */
export function _resetForTests(): void {
  permissionHandlerInstalled = false;
  pendingRequests.clear();
}

/**
 * Test-only: expose the policy resolver so unit tests can verify decisions
 * without needing a real Electron Session.
 */
export function _resolveDecisionForTests(url: string, permission: string): Decision {
  return resolveDecision(url, permission as PermissionName);
}
