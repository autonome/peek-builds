/**
 * Firefox Frecency & Adaptive Matching — Import Module
 *
 * Reads Firefox's frecency scores and adaptive matching data from places.sqlite,
 * normalizes scores to Peek's scale, and updates imported items.
 *
 * For Chrome/Brave, calculates a frecency proxy from visit count + recency.
 *
 * ============================================================
 * FIREFOX FRECENCY ALGORITHM
 * ============================================================
 *
 * The `frecency` column in `moz_places` is an integer score that combines
 * frequency (how often) and recency (how recently) a page was visited.
 *
 * How Firefox calculates frecency:
 *
 * 1. Take the last 10 visits for a place
 * 2. For each visit, assign a "bonus" based on visit type:
 *    - TRANSITION_EMBED (0):        0 points (framed content)
 *    - TRANSITION_LINK (1):         100 points (clicked a link)
 *    - TRANSITION_TYPED (2):        2000 points (typed in URL bar)
 *    - TRANSITION_BOOKMARK (3):     75 points (opened from bookmark)
 *    - TRANSITION_DOWNLOAD (7):     0 points
 *    - TRANSITION_REDIRECT_PERMANENT (5): 0 points
 *    - TRANSITION_REDIRECT_TEMPORARY (6): 0 points
 *    - Default:                     0 points
 *
 * 3. Apply a recency "bucket weight" based on how long ago the visit was:
 *    - Within 4 days:     100% weight
 *    - Within 14 days:    70% weight
 *    - Within 31 days:    50% weight
 *    - Within 90 days:    30% weight
 *    - Older than 90 days: 10% weight
 *
 * 4. For each visit: points = ceil(bonus * bucketWeight / 100)
 * 5. Final frecency = ceil(total_points * visit_count / sample_size)
 *    where sample_size = min(visit_count, 10)
 *
 * A page that was typed (2000 bonus) within 4 days (100% weight)
 * scores 2000 per visit. A link-clicked page (100 bonus) from 2 months ago
 * (30% weight) scores 30 per visit.
 *
 * Special cases:
 * - Unvisited bookmarks get frecency = 140
 * - Pages with only embed/redirect visits get frecency = 0
 * - Pages with frecency = -1 are explicitly excluded from autocomplete
 *
 * ============================================================
 * ADAPTIVE MATCHING (moz_inputhistory)
 * ============================================================
 *
 * Firefox's `moz_inputhistory` table maps typed text to selected URLs.
 * When a user types "gi" in the URL bar and selects github.com, Firefox
 * records this association with a use count.
 *
 * Table structure:
 *   place_id  INTEGER — references moz_places.id
 *   input     TEXT    — the text the user typed
 *   use_count INTEGER — how many times this text->URL association was used
 *
 * The adaptive matching data is decay-weighted: each time the entry is used,
 * use_count = (use_count * 0.9) + 1. Old associations decay toward 0.
 *
 * This is valuable for command palette matching in Peek — it captures the
 * user's actual abbreviation patterns.
 *
 * ============================================================
 * NORMALIZATION APPROACH
 * ============================================================
 *
 * Peek's calculateItemFrecency produces scores by summing per-visit
 * contributions: weight * decay * 10, where decay = 1/(1 + sqrt(ageDays/7)).
 * For a heavily used site with 10 recent visits, scores reach ~200.
 * Realistic range: 0-2000 for very active users.
 *
 * Firefox scores range from 0 to 100,000+. We normalize by mapping
 * Firefox's observed min/max range onto 0-2000 (Peek's practical max),
 * using a logarithmic scale since Firefox scores are heavily skewed.
 */

import { existsSync, copyFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import type { BrowserName, FrecencyImportResult } from '../types.js';
import {
  getItemIdByUrl, updateFrecencyScore, updateItemMetadata, runInTransaction,
} from '../datastore.js';

export interface FrecencyData {
  url: string;
  frecency: number;
  title: string;
}

export interface AdaptiveMatch {
  url: string;
  input: string;
  useCount: number;
}

/**
 * Stats returned by inspect for frecency data
 */
export interface FrecencyInspection {
  frecencyCount: number;
  adaptiveCount: number;
}

/**
 * Copy a SQLite DB to a temp location before reading.
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

/**
 * Read frecency scores from Firefox's places.sqlite.
 *
 * Returns all places with non-zero frecency, sorted by score descending.
 */
export function readFrecencyData(profilePath: string): FrecencyData[] {
  const dbPath = join(profilePath, 'places.sqlite');
  if (!existsSync(dbPath)) return [];

  let db: Database.Database | null = null;
  try {
    const tempPath = copyToTemp(dbPath);
    db = new Database(tempPath, { readonly: true });

    const rows = db.prepare(`
      SELECT url, title, frecency
      FROM moz_places
      WHERE frecency > 0
        AND url NOT LIKE 'place:%'
        AND url NOT LIKE 'about:%'
      ORDER BY frecency DESC
    `).all() as Array<{
      url: string;
      title: string | null;
      frecency: number;
    }>;

    return rows.map(row => ({
      url: row.url,
      title: row.title || '',
      frecency: row.frecency,
    }));
  } catch {
    return [];
  } finally {
    if (db) db.close();
  }
}

/**
 * Read adaptive matching data from Firefox's places.sqlite.
 *
 * Returns all input->URL associations with their (decayed) use counts.
 * This data captures the user's typing patterns for URL bar autocomplete.
 */
export function readAdaptiveMatchingData(profilePath: string): AdaptiveMatch[] {
  const dbPath = join(profilePath, 'places.sqlite');
  if (!existsSync(dbPath)) return [];

  let db: Database.Database | null = null;
  try {
    const tempPath = copyToTemp(dbPath);
    db = new Database(tempPath, { readonly: true });

    const rows = db.prepare(`
      SELECT
        p.url,
        h.input,
        h.use_count
      FROM moz_inputhistory h
      JOIN moz_places p ON h.place_id = p.id
      WHERE p.url NOT LIKE 'place:%'
        AND p.url NOT LIKE 'about:%'
      ORDER BY h.use_count DESC
    `).all() as Array<{
      url: string;
      input: string;
      use_count: number;
    }>;

    return rows.map(row => ({
      url: row.url,
      input: row.input,
      useCount: row.use_count,
    }));
  } catch {
    return [];
  } finally {
    if (db) db.close();
  }
}

/**
 * Read Chrome/Brave history with visit count and last visit time for frecency proxy.
 * Returns URL -> { visitCount, lastVisitTime } map.
 */
export function readChromeFrecencyData(profilePath: string): FrecencyData[] {
  const dbPath = join(profilePath, 'History');
  if (!existsSync(dbPath)) return [];

  let db: Database.Database | null = null;
  try {
    const tempPath = copyToTemp(dbPath);
    db = new Database(tempPath, { readonly: true });

    const rows = db.prepare(`
      SELECT url, title, visit_count,
             (last_visit_time / 1000 - 11644473600000) as last_visit_ms
      FROM urls
      WHERE visit_count > 0
        AND url NOT LIKE 'chrome://%'
        AND url NOT LIKE 'chrome-extension://%'
        AND url NOT LIKE 'brave://%'
      ORDER BY visit_count DESC
    `).all() as Array<{
      url: string;
      title: string | null;
      visit_count: number;
      last_visit_ms: number;
    }>;

    // Calculate a frecency proxy using Peek's own algorithm approach:
    // score = visitCount * decay, where decay is based on recency
    return rows.map(row => {
      const ageDays = Math.max(0, (Date.now() - row.last_visit_ms) / (1000 * 60 * 60 * 24));
      const decay = 1 / (1 + Math.pow(ageDays / 7, 0.5));
      // Scale similar to Peek: each visit contributes decay * 10
      const score = Math.round(row.visit_count * decay * 10);
      return {
        url: row.url,
        title: row.title || '',
        frecency: score,
      };
    });
  } catch {
    return [];
  } finally {
    if (db) db.close();
  }
}

// Peek's practical frecency max — heavily used sites with many recent visits
const PEEK_FRECENCY_MAX = 2000;

/**
 * Normalize Firefox frecency scores to Peek's range (0 to PEEK_FRECENCY_MAX).
 *
 * Uses log scale because Firefox scores are heavily skewed:
 * most pages score < 100, while typed URLs can score > 20,000.
 */
function normalizeFirefoxScores(data: FrecencyData[]): Map<string, number> {
  const result = new Map<string, number>();
  if (data.length === 0) return result;

  // Use log scale for normalization
  const logScores = data.map(d => Math.log1p(d.frecency));
  const logMin = Math.min(...logScores);
  const logMax = Math.max(...logScores);
  const logRange = logMax - logMin;

  for (let i = 0; i < data.length; i++) {
    const logScore = logScores[i];
    // Map log(score) from [logMin, logMax] to [0, PEEK_FRECENCY_MAX]
    const normalized = logRange > 0
      ? Math.round(((logScore - logMin) / logRange) * PEEK_FRECENCY_MAX)
      : Math.round(PEEK_FRECENCY_MAX / 2);
    result.set(data[i].url, normalized);
  }

  return result;
}

/**
 * Group adaptive matches by URL for efficient metadata storage.
 */
function groupAdaptiveByUrl(matches: AdaptiveMatch[]): Map<string, Array<{ input: string; useCount: number }>> {
  const grouped = new Map<string, Array<{ input: string; useCount: number }>>();
  for (const match of matches) {
    const existing = grouped.get(match.url);
    if (existing) {
      existing.push({ input: match.input, useCount: match.useCount });
    } else {
      grouped.set(match.url, [{ input: match.input, useCount: match.useCount }]);
    }
  }
  return grouped;
}

/**
 * Inspect frecency data available in a profile without importing.
 */
export function inspectFrecency(profilePath: string, browser: BrowserName): FrecencyInspection {
  if (browser === 'firefox') {
    const frecencyData = readFrecencyData(profilePath);
    const adaptiveData = readAdaptiveMatchingData(profilePath);
    return {
      frecencyCount: frecencyData.length,
      adaptiveCount: adaptiveData.length,
    };
  } else {
    // Chrome/Brave — frecency proxy from visit data, no adaptive matching
    const frecencyData = readChromeFrecencyData(profilePath);
    return {
      frecencyCount: frecencyData.length,
      adaptiveCount: 0,
    };
  }
}

/**
 * Import frecency scores and adaptive matching data into Peek's datastore.
 *
 * For Firefox: normalizes frecency scores from Firefox's scale to Peek's range,
 * and imports adaptive matching data as item metadata.
 *
 * For Chrome/Brave: calculates a frecency proxy from visit count + recency.
 *
 * Only updates items that already exist in the database (matched by URL).
 */
export function importFrecency(
  profilePath: string,
  browser: BrowserName,
): FrecencyImportResult {
  const result: FrecencyImportResult = {
    frecencyUpdated: 0,
    adaptiveImported: 0,
    notFound: 0,
    errors: [],
  };

  // Step 1: Read and normalize frecency data
  let normalizedScores: Map<string, number>;

  if (browser === 'firefox') {
    const frecencyData = readFrecencyData(profilePath);
    if (frecencyData.length === 0) {
      result.errors.push('No frecency data found in Firefox profile');
      return result;
    }
    normalizedScores = normalizeFirefoxScores(frecencyData);
  } else {
    // Chrome/Brave — scores are already in Peek-compatible range
    const frecencyData = readChromeFrecencyData(profilePath);
    if (frecencyData.length === 0) {
      result.errors.push(`No frecency data found in ${browser} profile`);
      return result;
    }
    normalizedScores = new Map(frecencyData.map(d => [d.url, d.frecency]));
  }

  // Step 2: Update frecency scores for matching items
  runInTransaction(() => {
    for (const [url, score] of normalizedScores) {
      try {
        const itemId = getItemIdByUrl(url);
        if (itemId) {
          updateFrecencyScore(itemId, score);
          result.frecencyUpdated++;
        } else {
          result.notFound++;
        }
      } catch (err) {
        result.errors.push(`Frecency update failed for ${url}: ${(err as Error).message}`);
      }
    }
  });

  // Step 3: Import adaptive matching data (Firefox only)
  if (browser === 'firefox') {
    const adaptiveData = readAdaptiveMatchingData(profilePath);
    if (adaptiveData.length > 0) {
      const grouped = groupAdaptiveByUrl(adaptiveData);

      runInTransaction(() => {
        for (const [url, matches] of grouped) {
          try {
            const itemId = getItemIdByUrl(url);
            if (itemId) {
              // Sort matches by useCount descending for readability
              matches.sort((a, b) => b.useCount - a.useCount);
              updateItemMetadata(itemId, 'adaptiveMatches', matches);
              result.adaptiveImported++;
            }
            // Don't increment notFound again — already counted in frecency pass
          } catch (err) {
            result.errors.push(`Adaptive match import failed for ${url}: ${(err as Error).message}`);
          }
        }
      });
    }
  }

  return result;
}
