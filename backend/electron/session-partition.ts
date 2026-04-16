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
import fs from 'node:fs';
import path from 'node:path';
import { registerProtocolOnSession } from './protocol.js';

const DEBUG = !!process.env.DEBUG;

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
 */
function registerDownloadHandler(ses: Session): void {
  ses.on('will-download', (_event, item, webContents) => {
    const filename = item.getFilename();
    const desiredPath = path.join(app.getPath('downloads'), filename);
    const savePath = resolveUniqueDownloadPath(desiredPath);
    item.setSavePath(savePath);
    console.log('[download] Saving:', filename, '→', savePath);

    // Detect whether the download originated from a <webview> guest.
    // Use webContents.getType() which reliably returns 'webview' for guest contents.
    // (hostWebContents was deprecated and may be undefined in modern Electron.)
    const isWebviewGuest = webContents.getType() === 'webview';

    if (!isWebviewGuest) {
      // Top-level window opened just for this download — close it.
      const win = BrowserWindow.fromWebContents(webContents);
      if (win && !win.isDestroyed()) {
        DEBUG && console.log('[download] Closing download-trigger window:', win.id);
        win.close();
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
            hostWin = BrowserWindow.fromWebContents(hostWC);
          }
          if (!hostWin) {
            // Fallback: find which BrowserWindow owns this guest webContents
            for (const bw of BrowserWindow.getAllWindows()) {
              if (bw.isDestroyed()) continue;
              // Check if this window's webContents has the guest attached
              // by looking at the page URL pattern (peek://app/page/index.html?url=...)
              const bwUrl = bw.webContents.getURL();
              if (bwUrl.includes('page/index.html') && bwUrl.includes(encodeURIComponent(item.getURL()))) {
                hostWin = bw;
                break;
              }
            }
          }
          if (hostWin && !hostWin.isDestroyed()) {
            console.log('[download] Closing popup window opened for download:', hostWin.id);
            hostWin.close();
          } else {
            DEBUG && console.log('[download] Download from webview guest (no page, no host window found)');
          }
        }
      }, 500);
    }

    item.on('done', (_e, state) => {
      if (state === 'completed') {
        console.log('[download] Completed:', filename);
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
        console.log('[download] Failed/cancelled:', filename, state);
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
