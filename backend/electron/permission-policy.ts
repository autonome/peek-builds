/**
 * Pure policy module for the web permission handler.
 *
 * Lives in its own file (no `electron` imports) so unit tests can run under
 * plain node without going through Electron-as-node. The orchestration
 * (deferred callbacks, IPC, BrowserWindow lookup) lives in permission-handler.ts.
 *
 * See backend/electron/permission-handler.ts for the full Phase 2 plan.
 */

/** Permissions that Electron may request via setPermissionRequestHandler. */
export type PermissionName =
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

export type Decision = 'allow' | 'deny' | 'prompt';

/**
 * Per-permission default policy applied to non-extension origins.
 *
 * Risky permissions (anything that exposes sensors, captures media, or grants
 * device access) resolve to `'prompt'` so the user sees an explicit
 * approve/reject UI. Less-risky permissions (notifications, fullscreen,
 * pointer-lock, openExternal) keep `'allow'` so common web flows aren't
 * interrupted on every visit.
 */
export const DEFAULT_POLICY: Partial<Record<PermissionName, Decision>> = {
  geolocation: 'prompt',
  media: 'prompt',
  midi: 'prompt',
  midiSysex: 'prompt',
  'display-capture': 'prompt',
  notifications: 'allow',
  'clipboard-read': 'allow',
  'clipboard-sanitized-write': 'allow',
  pointerLock: 'allow',
  fullscreen: 'allow',
  openExternal: 'allow',
};

/** Friendly labels rendered in the prompt UI. */
export const PERMISSION_LABELS: Partial<Record<PermissionName, string>> = {
  geolocation: 'know your location',
  media: 'use your camera and microphone',
  midi: 'access MIDI devices',
  midiSysex: 'send and receive MIDI System Exclusive messages',
  'display-capture': 'capture your screen',
  notifications: 'show notifications',
  'clipboard-read': 'read from your clipboard',
  'clipboard-sanitized-write': 'write to your clipboard',
  pointerLock: 'capture your pointer',
  fullscreen: 'enter fullscreen mode',
  openExternal: 'open external apps',
};

export function resolveDecision(url: string, permission: PermissionName): Decision {
  // Chrome extension URLs are always allowed — extensions declare their
  // permissions in manifest.json and Electron honors them.
  if (url.startsWith('chrome-extension://')) return 'allow';

  // peek:// internal pages — allow (we control them).
  if (url.startsWith('peek://')) return 'allow';

  return DEFAULT_POLICY[permission] ?? 'deny';
}

export function originFromUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url || '(unknown)';
  }
}

export function labelFor(permission: PermissionName): string {
  return PERMISSION_LABELS[permission] ?? permission;
}
