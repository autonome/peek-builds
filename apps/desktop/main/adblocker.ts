/**
 * Ad Blocker Module for Electron
 *
 * Provides native ad blocking using @ghostery/adblocker-electron.
 * This approach avoids webRequest API conflicts with browser extensions.
 *
 * Features:
 * - Pre-built filter lists for ads and trackers (EasyList, EasyPrivacy)
 * - Disk cache under userData — startup never blocks on network
 * - Periodic background refresh (~daily) with exponential-backoff retry
 * - Bundled fallback filter list for first-run without network access
 * - Runtime enable/disable support
 * - Configurable via settings
 * - Attaches to Electron sessions
 *
 * Resilience model:
 *   1. Startup reads from disk cache (userData/adblocker-cache.dat).
 *      Cache is written after the first successful fetch.
 *   2. If cache is absent AND the fetch fails (e.g. ENOTFOUND at cold boot),
 *      we fall back to a small bundled filter list so the blocker is always
 *      initialised with at least minimal protection.
 *   3. A background refresh runs ~24h after startup (and ~24h after each
 *      subsequent success).  On failure it retries with exponential backoff
 *      (1h → 4h → 8h → 24h cap) and leaves the cached copy intact.
 *   4. Successful refreshes replace the cache file atomically via rename.
 */

import fs from 'node:fs';
import path from 'node:path';
import { app, session, Session } from 'electron';
import { ElectronBlocker, Request } from '@ghostery/adblocker-electron';
import fetch from 'cross-fetch';

import { getProfileSession } from './session-partition.js';
import { DEBUG } from './config.js';

// Module state
let blocker: ElectronBlocker | null = null;
let isEnabled = false;
const attachedSessions: Set<Session> = new Set();

// Stats tracking
let blockedCount = 0;

// Background refresh timer handle — kept so it can be cleared on cleanup
let _refreshTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Refresh schedule ────────────────────────────────────────────────────────
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 h
const REFRESH_RETRY_BASE_MS = 60 * 60 * 1000;     //  1 h (doubles each failure)
const REFRESH_RETRY_CAP_MS = 8 * 60 * 60 * 1000;  //  8 h cap

// ─── Bundled fallback ────────────────────────────────────────────────────────
// A minimal filter list shipped inside the app binary.  Privacy posture >
// correctness: it is better to block a handful of well-known domains than to
// run with no adblocker on first boot when the network is unavailable.
// Rules are uBlock Origin / EasyList syntax.
const BUNDLED_FALLBACK_FILTERS = `
! Peek bundled adblocker fallback (used only when cache absent and network down)
! Generated from a small subset of EasyList + EasyPrivacy core rules.
||doubleclick.net^
||googlesyndication.com^
||googleadservices.com^
||adnxs.com^
||advertising.com^
||ads.yahoo.com^
||pubmatic.com^
||rubiconproject.com^
||openx.net^
||quantserve.com^
||scorecardresearch.com^
||omtrdc.net^
||2mdn.net^
||adform.net^
||criteo.com^
||tapad.com^
||liveramp.net^
||liveramp.com^
||adsrvr.org^
||adtech.de^
||smartadserver.com^
||yieldmo.com^
||google-analytics.com^$third-party
||googletagmanager.com^$third-party
||googletagservices.com^
||moatads.com^
||adroll.com^
||facebook.com/tr/*^
||connect.facebook.net^$third-party
`.trim();

// ─── Cache helpers ────────────────────────────────────────────────────────────

function getCachePath(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'adblocker-cache.dat');
}

function getTempCachePath(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'adblocker-cache.dat.tmp');
}

async function readCache(filePath: string): Promise<Uint8Array> {
  const buf = await fs.promises.readFile(filePath);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

async function writeCache(filePath: string, data: Uint8Array): Promise<void> {
  await fs.promises.writeFile(filePath, data);
}

/**
 * Write to a .tmp file then atomically rename over the real cache path.
 * Prevents a corrupt half-written file if the process is killed during write.
 */
async function writeCacheAtomic(data: Uint8Array): Promise<void> {
  const cachePath = getCachePath();
  const tempPath = getTempCachePath();
  await fs.promises.writeFile(tempPath, data);
  await fs.promises.rename(tempPath, cachePath);
}

// ─── Filter-list fetch helpers ────────────────────────────────────────────────

/**
 * Fetch and compile a fresh engine from the upstream filter lists.
 * Does NOT touch the on-disk cache (caller is responsible).
 */
async function fetchFreshEngine(): Promise<ElectronBlocker> {
  return ElectronBlocker.fromPrebuiltAdsAndTracking(fetch);
}

/**
 * Build a minimal engine from the bundled fallback list.
 * Never throws.
 */
function buildFallbackEngine(): ElectronBlocker {
  return ElectronBlocker.parse(BUNDLED_FALLBACK_FILTERS);
}

// ─── Background refresh ───────────────────────────────────────────────────────

function scheduleRefresh(delayMs: number): void {
  if (_refreshTimer !== null) {
    clearTimeout(_refreshTimer);
    _refreshTimer = null;
  }

  _refreshTimer = setTimeout(async () => {
    _refreshTimer = null;
    await runBackgroundRefresh(0);
  }, delayMs);

  // Allow the process to exit even if the timer is still pending.
  if (_refreshTimer && typeof (_refreshTimer as NodeJS.Timeout).unref === 'function') {
    (_refreshTimer as NodeJS.Timeout).unref();
  }
}

/**
 * Attempt to refresh the filter lists in the background.
 * On success: replaces disk cache and updates the live blocker instance.
 * On failure: logs a warning, keeps the existing cache, schedules a retry.
 *
 * @param failureCount - number of consecutive prior failures (drives backoff)
 */
async function runBackgroundRefresh(failureCount: number): Promise<void> {
  DEBUG && console.log('[adblocker] Background refresh starting...');

  try {
    const freshEngine = await fetchFreshEngine();

    // Persist atomically before swapping the live instance.
    try {
      await writeCacheAtomic(freshEngine.serialize());
      DEBUG && console.log('[adblocker] Cache updated after refresh');
    } catch (writeErr) {
      // Non-fatal: the live engine is still updated even if we can't persist.
      console.warn('[adblocker] Background refresh: cache write failed:', writeErr);
    }

    // Re-attach fresh engine to all active sessions.
    const previousBlocker = blocker;
    blocker = freshEngine;
    blocker.on('request-blocked', (_request: Request) => {
      blockedCount++;
    });

    if (previousBlocker !== null) {
      for (const sess of attachedSessions) {
        previousBlocker.disableBlockingInSession(sess);
        blocker.enableBlockingInSession(sess);
      }
    }

    DEBUG && console.log('[adblocker] Background refresh complete — engine replaced');
    scheduleRefresh(REFRESH_INTERVAL_MS);
  } catch (err) {
    const nextFailureCount = failureCount + 1;
    // Exponential backoff: 1h, 2h, 4h, 8h cap.
    const backoffMs = Math.min(
      REFRESH_RETRY_BASE_MS * Math.pow(2, failureCount),
      REFRESH_RETRY_CAP_MS,
    );
    console.warn(
      `[adblocker] Background refresh failed (attempt ${nextFailureCount}), retry in ${Math.round(backoffMs / 60000)}min:`,
      err,
    );
    // Schedule retry using a closure that carries the failure count.
    if (_refreshTimer !== null) {
      clearTimeout(_refreshTimer);
      _refreshTimer = null;
    }
    _refreshTimer = setTimeout(async () => {
      _refreshTimer = null;
      await runBackgroundRefresh(nextFailureCount);
    }, backoffMs);
    if (_refreshTimer && typeof (_refreshTimer as NodeJS.Timeout).unref === 'function') {
      (_refreshTimer as NodeJS.Timeout).unref();
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Adblocker configuration options
 */
export interface AdblockerConfig {
  /** Whether ad blocking is enabled */
  enabled: boolean;
}

/**
 * Initialize the adblocker engine.
 *
 * Resilience strategy (never hard-fails):
 *   1. Try to load from the on-disk cache (userData/adblocker-cache.dat).
 *      The library's Caching interface handles this: if the cache file exists
 *      it is deserialized directly (no network), otherwise it fetches and
 *      writes the result to disk.
 *   2. If both cache and network fail (e.g. cold boot with no DNS), fall back
 *      to a small set of bundled filter rules so the user always has some
 *      baseline protection.
 *   3. After a successful init, schedule a background refresh in ~24h.
 */
export async function initAdblocker(): Promise<void> {
  if (blocker) {
    DEBUG && console.log('[adblocker] Already initialized');
    return;
  }

  DEBUG && console.log('[adblocker] Initializing...');
  const startTime = Date.now();

  const cachePath = getCachePath();
  let usedFallback = false;

  try {
    // Pass the library's Caching interface.  If cachePath exists it is read
    // directly (binary deserialize, no network).  If absent, filter lists are
    // fetched from upstream and the compiled binary is written to cachePath.
    blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: cachePath,
      read: readCache,
      write: writeCache,
    });
  } catch (primaryErr) {
    // Both the on-disk cache read AND the remote fetch failed.
    // This is the "offline at first boot" case.
    console.warn(
      '[adblocker] Primary init failed (cache absent + network error), falling back to bundled list:',
      primaryErr,
    );
    blocker = buildFallbackEngine();
    usedFallback = true;
  }

  blocker.on('request-blocked', (_request: Request) => {
    blockedCount++;
    DEBUG && console.log('[adblocker] Blocked:', _request.url);
  });

  const elapsedMs = Date.now() - startTime;
  DEBUG && console.log(
    `[adblocker] Initialized in ${elapsedMs}ms` +
      (usedFallback ? ' (bundled fallback — no cache or network)' : ''),
  );

  // Schedule a background refresh.  If we used the fallback, try sooner (1h)
  // so a quick network-up event refreshes to a full list without waiting a day.
  scheduleRefresh(usedFallback ? REFRESH_RETRY_BASE_MS : REFRESH_INTERVAL_MS);
}

/**
 * Enable ad blocking on a specific session
 */
export function enableBlockingInSession(sess: Session): void {
  if (!blocker) {
    console.error('[adblocker] Cannot enable blocking: not initialized');
    return;
  }
  if (attachedSessions.has(sess)) {
    DEBUG && console.log('[adblocker] Session already has blocking enabled');
    return;
  }

  blocker.enableBlockingInSession(sess);
  attachedSessions.add(sess);
  isEnabled = true;
  DEBUG && console.log('[adblocker] Enabled blocking in session');
}

/**
 * Disable ad blocking on a specific session
 */
export function disableBlockingInSession(sess: Session): void {
  if (!blocker || !attachedSessions.has(sess)) {
    return;
  }

  blocker.disableBlockingInSession(sess);
  attachedSessions.delete(sess);
  isEnabled = attachedSessions.size > 0;
  DEBUG && console.log('[adblocker] Disabled blocking in session');
}

/**
 * Enable ad blocking on the profile session
 * Uses profile-specific session for isolation
 */
export function enableBlocking(): void {
  const profileSession = getProfileSession();
  enableBlockingInSession(profileSession);
}

/**
 * Disable ad blocking on the profile session
 * Uses profile-specific session for isolation
 */
export function disableBlocking(): void {
  const profileSession = getProfileSession();
  disableBlockingInSession(profileSession);
}

/**
 * Toggle ad blocking on the default session
 * @returns New enabled state
 */
export function toggleBlocking(): boolean {
  if (isEnabled) {
    disableBlocking();
  } else {
    enableBlocking();
  }
  return isEnabled;
}

/**
 * Check if ad blocking is currently enabled
 */
export function isBlockingEnabled(): boolean {
  return isEnabled;
}

/**
 * Get the count of blocked requests since startup
 */
export function getBlockedCount(): number {
  return blockedCount;
}

/**
 * Reset the blocked request counter
 */
export function resetBlockedCount(): void {
  blockedCount = 0;
}

/**
 * Get current adblocker status
 */
export function getAdblockerStatus(): {
  initialized: boolean;
  enabled: boolean;
  blockedCount: number;
  attachedSessionCount: number;
} {
  return {
    initialized: blocker !== null,
    enabled: isEnabled,
    blockedCount,
    attachedSessionCount: attachedSessions.size,
  };
}

/**
 * Apply adblocker configuration
 * Initializes if needed and enables/disables based on config
 */
export async function applyAdblockerConfig(config: AdblockerConfig): Promise<void> {
  DEBUG && console.log('[adblocker] Applying config:', config);

  if (config.enabled) {
    if (!blocker) {
      await initAdblocker();
    }
    enableBlocking();
  } else {
    disableBlocking();
  }
}

/**
 * Clean up adblocker resources
 * Should be called before app quit
 */
export function cleanupAdblocker(): void {
  DEBUG && console.log('[adblocker] Cleaning up...');

  if (_refreshTimer !== null) {
    clearTimeout(_refreshTimer);
    _refreshTimer = null;
  }

  for (const sess of attachedSessions) {
    if (blocker) {
      try {
        blocker.disableBlockingInSession(sess);
      } catch (error) {
        DEBUG && console.log('[adblocker] Error disabling session:', error);
      }
    }
  }

  attachedSessions.clear();
  blocker = null;
  isEnabled = false;
  blockedCount = 0;
}
