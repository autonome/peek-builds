/**
 * Electron-Specific Runtime Configuration
 *
 * Runtime configuration and state for the Electron main process.
 * For shared constants, see backend/config.ts
 */

// Re-export shared constants for convenience
export {
  APP_DEF_WIDTH,
  APP_DEF_HEIGHT,
  WEB_CORE_ADDRESS,
  SETTINGS_ADDRESS,
  IPC_CHANNELS,
  TOPICS,
} from '../config.js';

// Debug mode - set DEBUG=1 to enable logging
export const DEBUG = !!process.env.DEBUG;

// Strict mode — set TILE_STRICT=true to throw instead of warn on capability violations.
// Enable in CI and strict-mode development to catch regressions as hard failures.
export const TILE_STRICT = process.env.TILE_STRICT === 'true';

// Runtime configuration (set during app initialization)
let _tilePreloadPath: string = '';
let _profile: string = '';

/**
 * Check if running in headless mode (no visible windows)
 * Set PEEK_HEADLESS=1 to enable
 */
export function isHeadless(): boolean {
  return !!process.env.PEEK_HEADLESS;
}

/**
 * Set profile (called during app initialization)
 */
export function setProfile(profile: string): void {
  _profile = profile;
}

/**
 * Set the v2 tile preload script path (called during app initialization)
 */
export function setTilePreloadPath(tilePreloadPath: string): void {
  _tilePreloadPath = tilePreloadPath;
}

/**
 * Get the v2 tile preload script path
 */
export function getTilePreloadPath(): string {
  return _tilePreloadPath;
}

/**
 * Get the current profile name
 */
export function getProfile(): string {
  return _profile;
}

/**
 * Check if running in test profile
 */
export function isTestProfile(): boolean {
  return _profile.startsWith('test');
}

/**
 * Check if running in dev profile
 */
export function isDevProfile(): boolean {
  return _profile === 'dev';
}

/**
 * True for any non-production ephemeral profile — dev, test-*, or
 * tmp-* manual-smoke profiles. Used only by the single-instance lock
 * check: these profiles always skip the lock so multiple instances
 * (prod + manual + parallel tests) can coexist. Does NOT gate any
 * test-only behaviors — those still use `isTestProfile()` or the
 * `E2E_TEST` env var as appropriate.
 */
export function isEphemeralProfile(): boolean {
  return isDevProfile() || isTestProfile() || _profile.startsWith('tmp-');
}
