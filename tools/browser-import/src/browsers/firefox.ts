/**
 * Firefox profile reader
 *
 * Reads history and bookmarks from Firefox's places.sqlite,
 * and inspects other data files (passwords, cookies, form data, extensions).
 */

import { existsSync, readFileSync, copyFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import type { BrowserReader } from './types.js';
import type { HistoryEntry, BookmarkEntry, DataInspection } from '../types.js';

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

export const firefoxReader: BrowserReader = {
  readHistory(profilePath: string): HistoryEntry[] {
    const dbPath = join(profilePath, 'places.sqlite');
    const db = openSafely(dbPath);
    if (!db) return [];

    try {
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

      return rows.map(row => ({
        url: row.url,
        title: row.title || '',
        visitCount: row.visit_count,
        // Firefox stores timestamps in microseconds since epoch
        lastVisitTime: Math.floor(row.last_visit_date / 1000),
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
