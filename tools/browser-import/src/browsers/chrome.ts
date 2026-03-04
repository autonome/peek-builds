/**
 * Chrome/Brave profile reader
 *
 * Both Chrome and Brave use the same Chromium profile format.
 * History is in a SQLite DB, bookmarks in a JSON file.
 * Sessions use SNSS binary format (complex to parse).
 */

import { existsSync, readFileSync, copyFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import type { BrowserReader } from './types.js';
import type { HistoryEntry, BookmarkEntry, SessionTab, DataInspection, VisitRecord } from '../types.js';

/**
 * Copy a SQLite DB to a temp location before reading.
 * Browsers hold locks on their DBs; reading in-place can fail or corrupt data.
 */
function copyToTemp(dbPath: string): string {
  const tempDir = mkdtempSync(join(tmpdir(), 'browser-import-'));
  const tempPath = join(tempDir, 'copy.sqlite');
  copyFileSync(dbPath, tempPath);
  const walPath = dbPath + '-wal';
  const shmPath = dbPath + '-shm';
  if (existsSync(walPath)) {
    copyFileSync(walPath, tempPath + '-wal');
  }
  if (existsSync(shmPath)) {
    copyFileSync(shmPath, tempPath + '-shm');
  }
  return tempPath;
}

function openSafely(dbPath: string): Database.Database | null {
  if (!existsSync(dbPath)) return null;
  try {
    const tempPath = copyToTemp(dbPath);
    return new Database(tempPath, { readonly: true });
  } catch {
    return null;
  }
}

/**
 * Chrome epoch: microseconds since 1601-01-01.
 * Convert to Unix milliseconds.
 */
function chromeTimeToUnixMs(chromeTime: number): number {
  // Chrome time is microseconds since 1601-01-01
  // Unix epoch is 1970-01-01
  // Difference: 11644473600 seconds
  const unixMicroseconds = chromeTime - 11644473600000000;
  return Math.floor(unixMicroseconds / 1000);
}

/**
 * WebKit time (used in Bookmarks JSON): microseconds since 1601-01-01
 * Same conversion as Chrome time.
 */
function webkitTimeToUnixMs(webkitTime: string | number): number {
  const t = typeof webkitTime === 'string' ? parseInt(webkitTime, 10) : webkitTime;
  if (isNaN(t) || t === 0) return Date.now();
  return chromeTimeToUnixMs(t);
}

interface ChromeBookmarkNode {
  type: 'url' | 'folder';
  name: string;
  url?: string;
  date_added?: string;
  children?: ChromeBookmarkNode[];
}

function flattenBookmarks(node: ChromeBookmarkNode, folderPath: string): BookmarkEntry[] {
  const entries: BookmarkEntry[] = [];

  if (node.type === 'url' && node.url) {
    // Skip internal chrome:// and edge:// URLs
    if (!node.url.startsWith('chrome://') && !node.url.startsWith('edge://') && !node.url.startsWith('brave://')) {
      entries.push({
        url: node.url,
        title: node.name || '',
        folderPath,
        dateAdded: webkitTimeToUnixMs(node.date_added || '0'),
      });
    }
  }

  if (node.children) {
    const childPath = folderPath ? `${folderPath}/${node.name}` : node.name;
    for (const child of node.children) {
      entries.push(...flattenBookmarks(child, childPath));
    }
  }

  return entries;
}

/**
 * Try to read session tabs from Chrome's Preferences JSON.
 *
 * Chrome's full session data is in SNSS binary format (Current Session, Current Tabs,
 * Sessions/Session_*, Sessions/Tabs_*), which is complex to parse without a dedicated
 * library. For now, we extract what we can from the Preferences JSON:
 * - Pinned tabs (session.startup_urls when restore_on_startup = 4)
 * - Tab groups metadata
 *
 * TODO: Full SNSS parsing. The SNSS format uses Pickle serialization with command types
 * for UpdateTabNavigation, SetSelectedTabInWindow, SetTabGroup, etc. No reliable npm
 * package exists for this format. Consider writing a custom parser or using the
 * chrome-session-parser approach (reverse-engineered format).
 */
function readChromeSessionTabs(profilePath: string): SessionTab[] {
  const tabs: SessionTab[] = [];

  // Try reading Preferences for startup/pinned tabs
  const prefsPath = join(profilePath, 'Preferences');
  if (!existsSync(prefsPath)) return tabs;

  try {
    const prefs = JSON.parse(readFileSync(prefsPath, 'utf-8'));

    // Check for startup URLs (when user has "Open a specific page or set of pages")
    const startupUrls = prefs?.session?.startup_urls;
    if (Array.isArray(startupUrls)) {
      for (const url of startupUrls) {
        if (typeof url === 'string' && !url.startsWith('chrome://') &&
            !url.startsWith('chrome-extension://') && !url.startsWith('brave://')) {
          tabs.push({
            url,
            title: '', // Preferences doesn't store titles for startup URLs
            pinned: false,
          });
        }
      }
    }

    // Check for pinned tabs
    const pinnedTabs = prefs?.pinned_tabs;
    if (Array.isArray(pinnedTabs)) {
      for (const tab of pinnedTabs) {
        if (tab && tab.url && typeof tab.url === 'string' &&
            !tab.url.startsWith('chrome://') && !tab.url.startsWith('brave://')) {
          tabs.push({
            url: tab.url,
            title: tab.title || '',
            pinned: true,
          });
        }
      }
    }

    // Extract tab group names if available (for tagging reference)
    // Chrome stores tab_groups in Preferences with group IDs mapping to titles
    const tabGroups = prefs?.tab_groups;
    if (tabGroups && typeof tabGroups === 'object') {
      // Tab group data is stored but can't be fully linked without SNSS session data
      // We store the group names for reference
    }
  } catch {
    // Can't parse preferences
  }

  return tabs;
}

/**
 * Count session tabs from Chrome Preferences
 */
function countChromeSessionTabs(profilePath: string): number {
  try {
    return readChromeSessionTabs(profilePath).length;
  } catch {
    return 0;
  }
}

export const chromeReader: BrowserReader = {
  readHistory(profilePath: string): HistoryEntry[] {
    const dbPath = join(profilePath, 'History');
    const db = openSafely(dbPath);
    if (!db) return [];

    try {
      const rows = db.prepare(`
        SELECT
          u.url,
          u.title,
          u.visit_count,
          MAX(v.visit_time) as last_visit_time
        FROM urls u
        JOIN visits v ON u.id = v.url
        WHERE u.url NOT LIKE 'chrome://%'
          AND u.url NOT LIKE 'chrome-extension://%'
          AND u.url NOT LIKE 'brave://%'
          AND u.url NOT LIKE 'edge://%'
        GROUP BY u.id
        ORDER BY last_visit_time DESC
      `).all() as Array<{
        url: string;
        title: string | null;
        visit_count: number;
        last_visit_time: number;
      }>;

      // Build visit timeline from visits table
      const visitsByUrl = new Map<string, VisitRecord[]>();
      try {
        const visitRows = db.prepare(`
          SELECT
            u.url,
            v.visit_time,
            v.transition
          FROM visits v
          JOIN urls u ON v.url = u.id
          WHERE u.url NOT LIKE 'chrome://%'
            AND u.url NOT LIKE 'chrome-extension://%'
            AND u.url NOT LIKE 'brave://%'
            AND u.url NOT LIKE 'edge://%'
          ORDER BY v.visit_time ASC
        `).all() as Array<{
          url: string;
          visit_time: number;
          transition: number;
        }>;

        for (const vr of visitRows) {
          let visits = visitsByUrl.get(vr.url);
          if (!visits) {
            visits = [];
            visitsByUrl.set(vr.url, visits);
          }
          visits.push({
            timestamp: chromeTimeToUnixMs(vr.visit_time),
            visitType: vr.transition & 0xFF, // Core transition type is in lower bits
          });
        }
      } catch {
        // visits query failed, continue without individual visits
      }

      return rows.map(row => ({
        url: row.url,
        title: row.title || '',
        visitCount: row.visit_count,
        lastVisitTime: chromeTimeToUnixMs(row.last_visit_time),
        visits: visitsByUrl.get(row.url),
      }));
    } catch {
      return [];
    } finally {
      db.close();
    }
  },

  readBookmarks(profilePath: string): BookmarkEntry[] {
    const bookmarksPath = join(profilePath, 'Bookmarks');
    if (!existsSync(bookmarksPath)) return [];

    try {
      const data = JSON.parse(readFileSync(bookmarksPath, 'utf-8'));
      const roots = data.roots;
      if (!roots) return [];

      const entries: BookmarkEntry[] = [];
      // Chrome has bookmark_bar, other, synced as root folders
      for (const rootKey of Object.keys(roots)) {
        const rootNode = roots[rootKey] as ChromeBookmarkNode;
        if (rootNode && typeof rootNode === 'object' && 'children' in rootNode) {
          entries.push(...flattenBookmarks(rootNode, ''));
        }
      }
      return entries;
    } catch {
      return [];
    }
  },

  readSessions(profilePath: string): SessionTab[] {
    return readChromeSessionTabs(profilePath);
  },

  inspect(profilePath: string): DataInspection[] {
    const results: DataInspection[] = [];

    // History
    const historyDb = openSafely(join(profilePath, 'History'));
    if (historyDb) {
      try {
        const count = (historyDb.prepare(
          `SELECT COUNT(DISTINCT u.id) as cnt FROM urls u
           JOIN visits v ON u.id = v.url
           WHERE u.url NOT LIKE 'chrome://%'
             AND u.url NOT LIKE 'chrome-extension://%'
             AND u.url NOT LIKE 'brave://%'
             AND u.url NOT LIKE 'edge://%'`
        ).get() as { cnt: number }).cnt;
        results.push({ type: 'history', count, importable: true, label: 'History' });
      } catch {
        // table may not exist
      } finally {
        historyDb.close();
      }
    }

    // Bookmarks
    const bookmarksPath = join(profilePath, 'Bookmarks');
    if (existsSync(bookmarksPath)) {
      try {
        const entries = this.readBookmarks(profilePath);
        results.push({ type: 'bookmarks', count: entries.length, importable: true, label: 'Bookmarks' });
      } catch {
        results.push({ type: 'bookmarks', count: 0, importable: true, label: 'Bookmarks' });
      }
    }

    // Sessions (from Preferences, partial)
    const sessionCount = countChromeSessionTabs(profilePath);
    const sessionLabel = sessionCount > 0
      ? 'Session Tabs (from Preferences, partial)'
      : 'Session Tabs (SNSS format, not yet supported)';
    results.push({
      type: 'sessions',
      count: sessionCount,
      importable: sessionCount > 0,
      label: sessionLabel,
    });

    // Passwords (Login Data SQLite)
    const loginDb = openSafely(join(profilePath, 'Login Data'));
    if (loginDb) {
      try {
        const count = (loginDb.prepare('SELECT COUNT(*) as cnt FROM logins').get() as { cnt: number }).cnt;
        results.push({ type: 'passwords', count, importable: false, label: 'Passwords' });
      } catch {
        // table may not exist
      } finally {
        loginDb.close();
      }
    }

    // Cookies
    const cookieDb = openSafely(join(profilePath, 'Cookies'));
    if (cookieDb) {
      try {
        const count = (cookieDb.prepare('SELECT COUNT(*) as cnt FROM cookies').get() as { cnt: number }).cnt;
        results.push({ type: 'cookies', count, importable: false, label: 'Cookies' });
      } catch {
        // table may not exist
      } finally {
        cookieDb.close();
      }
    }

    // Form/Autofill data
    const webDataDb = openSafely(join(profilePath, 'Web Data'));
    if (webDataDb) {
      try {
        const count = (webDataDb.prepare('SELECT COUNT(*) as cnt FROM autofill').get() as { cnt: number }).cnt;
        results.push({ type: 'formdata', count, importable: false, label: 'Form Data' });
      } catch {
        // table may not exist
      } finally {
        webDataDb.close();
      }
    }

    // Extensions
    const prefsPath = join(profilePath, 'Preferences');
    if (existsSync(prefsPath)) {
      try {
        const prefs = JSON.parse(readFileSync(prefsPath, 'utf-8'));
        const extensions = prefs.extensions?.settings;
        if (extensions && typeof extensions === 'object') {
          const extCount = Object.values(extensions).filter(
            (ext: any) => ext.manifest && ext.manifest.manifest_version
          ).length;
          results.push({ type: 'extensions', count: extCount, importable: false, label: 'Extensions' });
        }
      } catch {
        // can't parse prefs
      }
    }

    return results;
  },
};
