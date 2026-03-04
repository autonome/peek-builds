/**
 * Firefox profile reader
 *
 * Reads history and bookmarks from Firefox's places.sqlite,
 * sessions from sessionstore-backups/recovery.jsonlz4,
 * and inspects other data files (passwords, cookies, form data, extensions).
 */

import { existsSync, readFileSync, copyFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import type { BrowserReader } from './types.js';
import type { HistoryEntry, BookmarkEntry, SessionTab, DataInspection, VisitRecord } from '../types.js';
import { decompressJsonlz4 } from '../util/jsonlz4.js';

/**
 * Copy a SQLite DB to a temp location before reading.
 * Browsers hold locks on their DBs; reading in-place can fail or corrupt data.
 */
function copyToTemp(dbPath: string): string {
  const tempDir = mkdtempSync(join(tmpdir(), 'browser-import-'));
  const tempPath = join(tempDir, 'copy.sqlite');
  copyFileSync(dbPath, tempPath);
  // Also copy WAL and SHM files if they exist (needed for consistent reads)
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
 * Find the Firefox session file. Tries multiple locations in priority order:
 * 1. sessionstore-backups/recovery.jsonlz4 (most current, written every ~15s)
 * 2. sessionstore.jsonlz4 (written on clean shutdown)
 */
function findSessionFile(profilePath: string): string | null {
  const candidates = [
    join(profilePath, 'sessionstore-backups', 'recovery.jsonlz4'),
    join(profilePath, 'sessionstore.jsonlz4'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Parse a Firefox session JSON structure into SessionTab entries.
 * Session structure: { windows: [{ tabs: [{ entries: [{ url, title }], index, ... }] }] }
 */
function parseFirefoxSession(sessionData: any): SessionTab[] {
  const tabs: SessionTab[] = [];

  if (!sessionData || !Array.isArray(sessionData.windows)) return tabs;

  for (let windowIndex = 0; windowIndex < sessionData.windows.length; windowIndex++) {
    const window = sessionData.windows[windowIndex];
    if (!window || !Array.isArray(window.tabs)) continue;

    for (const tab of window.tabs) {
      if (!tab || !Array.isArray(tab.entries) || tab.entries.length === 0) continue;

      // Current entry is at index - 1 (1-based)
      const currentIndex = (tab.index || tab.entries.length) - 1;
      const entry = tab.entries[Math.min(currentIndex, tab.entries.length - 1)];

      if (!entry || !entry.url) continue;

      // Skip internal Firefox URLs
      if (entry.url.startsWith('about:') || entry.url.startsWith('resource:') ||
          entry.url.startsWith('chrome:') || entry.url.startsWith('moz-extension:')) {
        continue;
      }

      // Determine tab group name (Firefox 131+ tab groups)
      let tabGroup: string | undefined;
      if (tab.groupId !== undefined && tab.groupId !== -1 && window.tabGroups) {
        const group = window.tabGroups.find?.((g: any) => g.id === tab.groupId);
        if (group && group.name) {
          tabGroup = group.name;
        }
      }

      tabs.push({
        url: entry.url,
        title: entry.title || '',
        tabGroup,
        pinned: !!tab.pinned,
        lastAccessed: tab.lastAccessed || undefined,
        windowIndex,
      });
    }
  }

  return tabs;
}

/**
 * Count tabs in a Firefox session file without fully parsing
 */
function countSessionTabs(profilePath: string): number {
  const sessionFile = findSessionFile(profilePath);
  if (!sessionFile) return 0;

  try {
    const sessionData = decompressJsonlz4(sessionFile);
    const tabs = parseFirefoxSession(sessionData);
    return tabs.length;
  } catch {
    return 0;
  }
}

export const firefoxReader: BrowserReader = {
  readHistory(profilePath: string): HistoryEntry[] {
    const dbPath = join(profilePath, 'places.sqlite');
    const db = openSafely(dbPath);
    if (!db) return [];

    try {
      // Get history entries with aggregated visit data
      const rows = db.prepare(`
        SELECT
          p.url,
          p.title,
          p.visit_count,
          MAX(v.visit_date) as last_visit_date
        FROM moz_places p
        JOIN moz_historyvisits v ON p.id = v.place_id
        WHERE p.url NOT LIKE 'place:%'
          AND p.url NOT LIKE 'about:%'
        GROUP BY p.id
        ORDER BY last_visit_date DESC
      `).all() as Array<{
        url: string;
        title: string | null;
        visit_count: number;
        last_visit_date: number;
      }>;

      // Build a map of place URL -> individual visits for visit timeline
      const visitsByUrl = new Map<string, VisitRecord[]>();
      try {
        const visitRows = db.prepare(`
          SELECT
            p.url,
            v.visit_date,
            v.visit_type
          FROM moz_historyvisits v
          JOIN moz_places p ON v.place_id = p.id
          WHERE p.url NOT LIKE 'place:%'
            AND p.url NOT LIKE 'about:%'
          ORDER BY v.visit_date ASC
        `).all() as Array<{
          url: string;
          visit_date: number;
          visit_type: number;
        }>;

        for (const vr of visitRows) {
          let visits = visitsByUrl.get(vr.url);
          if (!visits) {
            visits = [];
            visitsByUrl.set(vr.url, visits);
          }
          visits.push({
            timestamp: Math.floor(vr.visit_date / 1000), // microseconds to ms
            visitType: vr.visit_type,
          });
        }
      } catch {
        // visits query failed, continue without individual visits
      }

      return rows.map(row => ({
        url: row.url,
        title: row.title || '',
        visitCount: row.visit_count,
        // Firefox stores timestamps in microseconds since epoch
        lastVisitTime: Math.floor(row.last_visit_date / 1000),
        visits: visitsByUrl.get(row.url),
      }));
    } catch {
      return [];
    } finally {
      db.close();
    }
  },

  readBookmarks(profilePath: string): BookmarkEntry[] {
    const dbPath = join(profilePath, 'places.sqlite');
    const db = openSafely(dbPath);
    if (!db) return [];

    try {
      // First build the folder tree for path resolution
      const folders = db.prepare(`
        SELECT id, title, parent
        FROM moz_bookmarks
        WHERE type = 2
      `).all() as Array<{ id: number; title: string | null; parent: number }>;

      const folderMap = new Map<number, { title: string; parent: number }>();
      for (const f of folders) {
        folderMap.set(f.id, { title: f.title || '', parent: f.parent });
      }

      function getFolderPath(parentId: number): string {
        const parts: string[] = [];
        let current = parentId;
        const visited = new Set<number>();
        while (current && folderMap.has(current) && !visited.has(current)) {
          visited.add(current);
          const folder = folderMap.get(current)!;
          if (folder.title) {
            parts.unshift(folder.title);
          }
          current = folder.parent;
        }
        return parts.join('/');
      }

      // Get bookmarks (type=1 is bookmark, not folder or separator)
      const rows = db.prepare(`
        SELECT
          b.title as bookmark_title,
          b.dateAdded,
          b.parent,
          p.url
        FROM moz_bookmarks b
        JOIN moz_places p ON b.fk = p.id
        WHERE b.type = 1
          AND p.url NOT LIKE 'place:%'
          AND p.url NOT LIKE 'about:%'
      `).all() as Array<{
        bookmark_title: string | null;
        dateAdded: number;
        parent: number;
        url: string;
      }>;

      return rows.map(row => ({
        url: row.url,
        title: row.bookmark_title || '',
        folderPath: getFolderPath(row.parent),
        // Firefox stores dateAdded in microseconds
        dateAdded: Math.floor(row.dateAdded / 1000),
      }));
    } catch {
      return [];
    } finally {
      db.close();
    }
  },

  readSessions(profilePath: string): SessionTab[] {
    const sessionFile = findSessionFile(profilePath);
    if (!sessionFile) return [];

    try {
      const sessionData = decompressJsonlz4(sessionFile);
      return parseFirefoxSession(sessionData);
    } catch {
      return [];
    }
  },

  inspect(profilePath: string): DataInspection[] {
    const results: DataInspection[] = [];

    // History
    const placesDb = openSafely(join(profilePath, 'places.sqlite'));
    if (placesDb) {
      try {
        const historyCount = (placesDb.prepare(
          `SELECT COUNT(DISTINCT p.id) as cnt FROM moz_places p
           JOIN moz_historyvisits v ON p.id = v.place_id
           WHERE p.url NOT LIKE 'place:%' AND p.url NOT LIKE 'about:%'`
        ).get() as { cnt: number }).cnt;
        results.push({ type: 'history', count: historyCount, importable: true, label: 'History' });

        const bookmarkCount = (placesDb.prepare(
          `SELECT COUNT(*) as cnt FROM moz_bookmarks b
           JOIN moz_places p ON b.fk = p.id
           WHERE b.type = 1 AND p.url NOT LIKE 'place:%' AND p.url NOT LIKE 'about:%'`
        ).get() as { cnt: number }).cnt;
        results.push({ type: 'bookmarks', count: bookmarkCount, importable: true, label: 'Bookmarks' });
      } catch {
        // tables may not exist
      } finally {
        placesDb.close();
      }
    }

    // Sessions
    const sessionTabCount = countSessionTabs(profilePath);
    results.push({
      type: 'sessions',
      count: sessionTabCount,
      importable: true,
      label: 'Session Tabs',
    });

    // Passwords (logins.json)
    const loginsPath = join(profilePath, 'logins.json');
    if (existsSync(loginsPath)) {
      try {
        const logins = JSON.parse(readFileSync(loginsPath, 'utf-8'));
        const count = Array.isArray(logins.logins) ? logins.logins.length : 0;
        results.push({ type: 'passwords', count, importable: false, label: 'Passwords' });
      } catch {
        results.push({ type: 'passwords', count: 0, importable: false, label: 'Passwords' });
      }
    }

    // Cookies
    const cookiesDb = openSafely(join(profilePath, 'cookies.sqlite'));
    if (cookiesDb) {
      try {
        const count = (cookiesDb.prepare('SELECT COUNT(*) as cnt FROM moz_cookies').get() as { cnt: number }).cnt;
        results.push({ type: 'cookies', count, importable: false, label: 'Cookies' });
      } catch {
        // table may not exist
      } finally {
        cookiesDb.close();
      }
    }

    // Form data
    const formDb = openSafely(join(profilePath, 'formhistory.sqlite'));
    if (formDb) {
      try {
        const count = (formDb.prepare('SELECT COUNT(*) as cnt FROM moz_formhistory').get() as { cnt: number }).cnt;
        results.push({ type: 'formdata', count, importable: false, label: 'Form Data' });
      } catch {
        // table may not exist
      } finally {
        formDb.close();
      }
    }

    // Extensions
    const extensionsPath = join(profilePath, 'extensions.json');
    if (existsSync(extensionsPath)) {
      try {
        const data = JSON.parse(readFileSync(extensionsPath, 'utf-8'));
        const count = Array.isArray(data.addons) ? data.addons.filter((a: { type: string }) => a.type === 'extension').length : 0;
        results.push({ type: 'extensions', count, importable: false, label: 'Extensions' });
      } catch {
        results.push({ type: 'extensions', count: 0, importable: false, label: 'Extensions' });
      }
    }

    return results;
  },
};
