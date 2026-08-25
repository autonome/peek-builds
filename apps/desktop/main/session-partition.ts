/**
 * Session Partition Module
 *
 * Provides Chromium session isolation per profile using Electron's partition system.
 * Each profile gets its own session with isolated:
 * - Cookies
 * - Cache
 * - Storage (localStorage, IndexedDB)
 * - Passwords/autofill
 *
 * Data is stored at: {userData}/Partitions/{profileId}/
 *
 * Migration:
 * - Detects if old session data exists at userData root (defaultSession location)
 * - Copies data to new partition location on first run
 * - Migration is safe: copy first, mark complete only on success
 */

import { app, session, Session, BrowserWindow, Notification, shell } from 'electron';
import { getAllLiveWindows, windowFromWebContents } from './window-registry.js';
import { getHybridWindowByContentWC, hasHybridPainted } from './hybrid-page-host-registry.js';
import { downloadCloseTarget } from './izui-roles.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { registerProtocolOnSession } from './protocol.js';
import { installPermissionHandler } from './permission-handler.js';
import { getWindowIdFor } from './window-machine.js';
import { kernelCloseWindowDirect } from './window-kernel-dispatch.js';
import { toChromeUserAgent } from './user-agent.js';
import { DEBUG, isTestProfile } from './config.js';

// Module state
let currentProfileId: string | null = null;
let userDataPath: string | null = null;
let profileSession: Session | null = null;

/**
 * Get the partition string for a profile
 * Uses 'persist:' prefix to ensure data persists to disk
 */
export function getPartitionString(profileId: string): string {
  return `persist:${profileId}`;
}

/**
 * Get the session for the current profile
 * Creates the session if it doesn't exist
 */
export function getProfileSession(): Session {
  if (!currentProfileId) {
    DEBUG && console.log('[session] No profile set, using defaultSession');
    return session.defaultSession;
  }

  if (!profileSession) {
    const partitionString = getPartitionString(currentProfileId);
    profileSession = session.fromPartition(partitionString);
    DEBUG && console.log('[session] Created profile session:', partitionString);

    // Register the peek:// protocol handler on the profile session
    registerProtocolOnSession(profileSession);

    // Handle file downloads — without this, download URLs leave windows stuck in loading state
    registerDownloadHandler(profileSession);

    // Install the web permission request handler. Replaces the blanket-allow
    // formerly installed by chrome-extensions.ts so we can apply per-permission
    // policy and (in a future phase) surface a Peek-native prompt to the user.
    installPermissionHandler(profileSession);
  }

  return profileSession;
}

/**
 * Initialize session partitioning for a profile
 * Should be called after app is ready and profile is determined
 *
 * @param profileId - The profile folder name (e.g., 'default', 'work')
 * @param dataPath - The base userData path
 */
export function initSessionPartition(profileId: string, dataPath: string): void {
  currentProfileId = profileId;
  userDataPath = dataPath;

  DEBUG && console.log('[session] Initializing partition for profile:', profileId);

  // Present a clean stock-Chrome User-Agent to every web surface. Electron's
  // default fallback carries a leading `Peek/<ver>` app token (and a trailing
  // `Electron/<ver>`); UA-sniffing sites read the leading product as the browser
  // and gate Peek out with an "unsupported browser" page (WhatsApp Web — peek
  // 080fd433). Setting the app-global fallback (rather than
  // per-session/per-webContents) means the profile session, the default session,
  // and every tile/hybrid-host webContents inherit the cleaned UA automatically.
  // Must run before any webContents is created; this is the early boot seam. See
  // toChromeUserAgent().
  app.userAgentFallback = toChromeUserAgent(app.userAgentFallback);
  DEBUG && console.log('[session] User-Agent override:', app.userAgentFallback);

  // Run migration check
  runMigrationIfNeeded();

  // Pre-create the session to ensure it's ready
  getProfileSession();
}

/**
 * Check if migration is needed and run it
 *
 * Migration is needed when:
 * 1. Old session data exists at the userData root (Chromium's defaultSession location)
 * 2. New partition location doesn't exist or is empty
 * 3. Migration hasn't been marked complete
 */
function runMigrationIfNeeded(): void {
  if (!userDataPath || !currentProfileId) {
    return;
  }

  const migrationFlagFile = path.join(userDataPath, currentProfileId, '.session-migration-complete');

  // Check if migration already completed
  if (fs.existsSync(migrationFlagFile)) {
    DEBUG && console.log('[session] Migration already complete for profile:', currentProfileId);
    return;
  }

  // Check for old session data locations
  // defaultSession stores data in various places under userData
  const oldLocations = [
    // Chromium stores session data in these directories
    path.join(userDataPath, 'Local Storage'),
    path.join(userDataPath, 'Session Storage'),
    path.join(userDataPath, 'IndexedDB'),
    path.join(userDataPath, 'Cache'),
    path.join(userDataPath, 'Code Cache'),
    path.join(userDataPath, 'GPUCache'),
    path.join(userDataPath, 'Cookies'),
    path.join(userDataPath, 'Network'),
    // Profile-specific old location (from previous setup)
    path.join(userDataPath, currentProfileId, 'chromium'),
  ];

  // Check if any old data exists
  const existingOldLocations = oldLocations.filter(loc => {
    try {
      return fs.existsSync(loc) && (fs.statSync(loc).isDirectory() ?
        fs.readdirSync(loc).length > 0 : true);
    } catch {
      return false;
    }
  });

  if (existingOldLocations.length === 0) {
    DEBUG && console.log('[session] No old session data to migrate');
    // Mark migration as complete (nothing to migrate)
    markMigrationComplete(migrationFlagFile);
    return;
  }

  DEBUG && console.log('[session] Found old session data at:', existingOldLocations);

  // New partition data location
  // Electron stores partition data at: {userData}/Partitions/{partitionName}/
  const newPartitionDir = path.join(userDataPath, 'Partitions', currentProfileId);

  // Check if new location already has data
  if (fs.existsSync(newPartitionDir) && fs.readdirSync(newPartitionDir).length > 0) {
    DEBUG && console.log('[session] New partition already has data, skipping migration');
    markMigrationComplete(migrationFlagFile);
    return;
  }

  // Perform migration
  DEBUG && console.log('[session] Starting session data migration...');

  try {
    // Create the partition directory
    fs.mkdirSync(newPartitionDir, { recursive: true });

    // Copy relevant data to new partition location
    // Note: Electron manages the partition directory structure, so we need to be careful
    // Only migrate data that makes sense to move

    // For now, we'll migrate the profile's chromium subdirectory if it exists
    const oldChromiumDir = path.join(userDataPath, currentProfileId, 'chromium');
    if (fs.existsSync(oldChromiumDir)) {
      DEBUG && console.log('[session] Migrating from old chromium directory...');
      copyDirectoryRecursive(oldChromiumDir, newPartitionDir);
    }

    // Mark migration complete
    markMigrationComplete(migrationFlagFile);
    DEBUG && console.log('[session] Migration completed successfully');

  } catch (error) {
    console.error('[session] Migration failed:', error);
    // Don't mark complete on failure - will retry next startup
  }
}

/**
 * Mark migration as complete by creating a flag file
 */
function markMigrationComplete(flagFile: string): void {
  try {
    const dir = path.dirname(flagFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(flagFile, JSON.stringify({
      migratedAt: Date.now(),
      version: 1,
    }));
  } catch (error) {
    console.error('[session] Failed to write migration flag:', error);
  }
}

/**
 * Recursively copy a directory
 */
function copyDirectoryRecursive(src: string, dest: string): void {
  if (!fs.existsSync(src)) {
    return;
  }

  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath);
    } else {
      try {
        fs.copyFileSync(srcPath, destPath);
      } catch (error) {
        DEBUG && console.log('[session] Failed to copy file:', srcPath, error);
      }
    }
  }
}

/**
 * Given a desired save path, return a path that does not already exist on disk.
 * If the desired path is free, returns it unchanged.
 * Otherwise appends an incrementing counter before the extension:
 *   download.jpg → download-1.jpg → download-2.jpg → …
 */
export function resolveUniqueDownloadPath(desiredPath: string): string {
  if (!fs.existsSync(desiredPath)) {
    return desiredPath;
  }
  const ext = path.extname(desiredPath);
  const base = desiredPath.slice(0, desiredPath.length - ext.length);
  let counter = 1;
  while (true) {
    const candidate = `${base}-${counter}${ext}`;
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
    counter++;
  }
}

/**
 * Register a will-download handler on a session.
 * Saves downloads to the user's Downloads folder.
 * If a file with the same name already exists, appends an incrementing
 * counter before the extension (e.g. download-1.jpg, download-2.jpg).
 *
 * Three cases:
 * 1. Top-level BrowserWindow (not webview): close it — no page to show.
 * 2. Webview guest with a real page loaded: keep open — user is browsing,
 *    Chromium aborts the download navigation and the webview stays put.
 * 3. Webview guest in a popup window opened for a download URL: close
 *    the host window — the webview has no real content (blank page).
 *
 * Idempotent: tracks which sessions already have the handler so we can
 * safely call it from multiple places (profileSession init + webview
 * `did-attach-webview`) without double-registering.
 */
const sessionsWithDownloadHandler = new WeakSet<Session>();

export function registerDownloadHandler(ses: Session): void {
  if (sessionsWithDownloadHandler.has(ses)) {
    DEBUG && console.log('[download] Handler already registered on this session, skipping');
    return;
  }
  sessionsWithDownloadHandler.add(ses);
  _registerDownloadHandlerImpl(ses);
}

/**
 * Strip path separators and other filesystem-hostile characters from a
 * download filename. Chromium already drops `/` and `\` from suggested
 * names, but we belt-and-suspender against null bytes, control chars,
 * and absurdly long names that would error on `setSavePath`.
 */
export function sanitizeDownloadFilename(raw: string): string {
  // eslint-disable-next-line no-control-regex
  let cleaned = (raw || '').replace(/[\x00-\x1f/\\:*?"<>|]/g, '_').trim();
  if (cleaned === '' || cleaned === '.' || cleaned === '..') {
    cleaned = `download-${Date.now()}`;
  }
  // 200 chars leaves headroom for collision suffixes + path components.
  if (cleaned.length > 200) {
    const ext = path.extname(cleaned);
    cleaned = cleaned.slice(0, 200 - ext.length) + ext;
  }
  return cleaned;
}

/**
 * Pick the directory downloads should land in. In production this is
 * the OS Downloads folder. Under E2E (`isTestProfile()`), redirect to
 * a per-process subdirectory of os.tmpdir() so playwright runs never
 * leave files in the developer's ~/Downloads. The test directory is
 * created lazily and reused across downloads in the same process.
 */
let _testDownloadsDir: string | null = null;
function getDownloadsDir(): string {
  if (isTestProfile()) {
    if (!_testDownloadsDir) {
      _testDownloadsDir = path.join(os.tmpdir(), `peek-e2e-downloads-${process.pid}`);
      try { fs.mkdirSync(_testDownloadsDir, { recursive: true }); }
      catch { /* best-effort; setSavePath will surface a real error */ }
    }
    return _testDownloadsDir;
  }
  return app.getPath('downloads');
}

/**
 * Close a download-trigger window through the kernel (CloseWindowDirect →
 * the backend's guest-safe close). Every window is machine-registered
 * (design §7); an unresolved id means it is already gone.
 */
function closeWindowViaMachine(win: { id: number }): void {
  const id = getWindowIdFor(win.id);
  if (id == null) {
    DEBUG && console.log('[download] close target', win.id, 'is not machine-registered — skipping');
    return;
  }
  kernelCloseWindowDirect(id);
}

function _registerDownloadHandlerImpl(ses: Session): void {
  ses.on('will-download', (_event, item, webContents) => {
    const rawFilename = item.getFilename();
    const filename = sanitizeDownloadFilename(rawFilename);
    const desiredPath = path.join(getDownloadsDir(), filename);
    const savePath = resolveUniqueDownloadPath(desiredPath);
    item.setSavePath(savePath);
    console.log('[download] Saving:', filename, '→', savePath);

    // Detect whether the download originated from a <webview> guest.
    // Use webContents.getType() which reliably returns 'webview' for guest contents.
    // (hostWebContents was deprecated and may be undefined in modern Electron.)
    const isWebviewGuest = webContents.getType() === 'webview';

    if (!isWebviewGuest) {
      // Which window (if any) to close. HYBRID IS CHECKED FIRST, and that order is
      // load-bearing: `windowFromWebContents` does NOT return null for a hybrid
      // page-host's content WC — at runtime it hands back the owning BaseWindow
      // (see the warning on that function in window-registry.ts). So a
      // BrowserWindow-first cascade matched every hybrid download and closed the
      // page the user was reading (alt+click, peek 02e0a4fa), while the hybrid
      // branch behind it never ran. Precedence + the paint guard are a pure,
      // unit-tested truth table; this call site only gathers the signals and acts.
      const hybrid = getHybridWindowByContentWC(webContents);
      const win = windowFromWebContents(webContents);
      const target = downloadCloseTarget({
        isHybridContent: hybrid !== null,
        hybridPainted: hybrid !== null && hasHybridPainted(hybrid.windowId),
        hasBrowserWindow: win !== null,
      });
      if (target === 'hybrid-host' && hybrid) {
        DEBUG && console.log('[download] Closing hybrid download-trigger host:', hybrid.windowId);
        closeWindowViaMachine(hybrid.baseWin);
      } else if (target === 'browser-window' && win) {
        // Top-level window opened just for this download — close it.
        DEBUG && console.log('[download] Closing download-trigger window:', win.id);
        closeWindowViaMachine(win);
      }
    } else {
      // Download from a webview guest. Two cases:
      //
      // 1. User clicked a download link on a page they're browsing.
      //    Chromium aborts the download navigation (error -3) and the webview
      //    stays on (or reverts to) its previous URL — a real http(s) page.
      //    → Keep the host window open.
      //
      // 2. A popup window (target="_blank") was opened for a download URL.
      //    The download URL was the first URL loaded in the webview. After
      //    Chromium aborts the navigation, the webview has no URL or a blank URL.
      //    → Close the host window (it has no content to show).
      //
      // We distinguish these by checking the webview's current URL after
      // the download navigation was aborted. If it's a real page, keep open.
      // Use a short delay to let Chromium finish aborting the navigation.
      setTimeout(() => {
        if (webContents.isDestroyed()) return;
        const currentUrl = webContents.getURL();
        const hasRealPage = currentUrl && currentUrl.startsWith('http') && currentUrl !== item.getURL();
        if (hasRealPage) {
          DEBUG && console.log('[download] Webview guest has loaded page, keeping window open:', currentUrl);
        } else {
          // No real page loaded — close the host BrowserWindow.
          // Find the host window: try hostWebContents first, fall back to
          // scanning all windows (hostWebContents is deprecated in newer Electron).
          let hostWin: BrowserWindow | null = null;
          const hostWC = (webContents as any).hostWebContents;
          if (hostWC) {
            hostWin = windowFromWebContents(hostWC);
          }
          if (!hostWin) {
            // Fallback: find which BrowserWindow owns this guest webContents
            for (const bw of getAllLiveWindows()) {
              // Check if this window's webContents has the guest attached
              // by looking at the page URL pattern (peek://app/page/index.html?url=...)
              const bwUrl = bw.webContents.getURL();
              if (bwUrl.includes('page/index.html') && bwUrl.includes(encodeURIComponent(item.getURL()))) {
                hostWin = bw;
                break;
              }
            }
          }
          if (hostWin) {
            console.log('[download] Closing popup window opened for download:', hostWin.id);
            closeWindowViaMachine(hostWin);
          } else {
            DEBUG && console.log('[download] Download from webview guest (no page, no host window found)');
          }
        }
      }, 500);
    }

    item.on('done', (_e, state) => {
      if (state === 'completed') {
        console.log('[download] Completed:', filename);
        // Under E2E, delete the file immediately — tests only care
        // that the download happened, not that the bytes persist.
        if (isTestProfile()) {
          try { fs.unlinkSync(savePath); }
          catch { /* best-effort cleanup */ }
          return;
        }
        const notification = new Notification({
          title: 'Download Complete',
          body: filename,
          silent: true,
        });
        notification.on('click', () => {
          shell.showItemInFolder(savePath);
        });
        notification.show();
      } else {
        // Surface failure so the user knows the download didn't silently
        // succeed. State is 'cancelled' or 'interrupted' here.
        console.log('[download] Failed/cancelled:', filename, state);
        // Never surface a native OS notification under test profiles — it pops
        // (audibly, silent:false) on the user's real desktop. Mirror the
        // success-branch isTestProfile() guard above.
        if (!isTestProfile()) {
          try {
            const reason = state === 'cancelled' ? 'cancelled' : 'interrupted';
            new Notification({
              title: 'Download Failed',
              body: `${filename} (${reason})`,
              silent: false,
            }).show();
          } catch (err) {
            console.error('[download] Failed to surface failure notification:', err);
          }
        }
      }
    });
  });
}

/**
 * Get the current profile ID
 */
export function getCurrentProfileId(): string | null {
  return currentProfileId;
}

/**
 * Check if session partitioning is initialized
 */
export function isPartitionInitialized(): boolean {
  return currentProfileId !== null && profileSession !== null;
}

/**
 * Get partition info for debugging/status
 */
export function getPartitionInfo(): {
  profileId: string | null;
  partitionString: string | null;
  initialized: boolean;
} {
  return {
    profileId: currentProfileId,
    partitionString: currentProfileId ? getPartitionString(currentProfileId) : null,
    initialized: isPartitionInitialized(),
  };
}
