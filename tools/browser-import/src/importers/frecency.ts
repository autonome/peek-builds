/**
 * Firefox Frecency & Adaptive Matching — Research and Planning
 *
 * This module reads Firefox's frecency scores and adaptive matching data
 * from places.sqlite. These provide rich ranking signals that can enhance
 * Peek's own frecency system.
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
 * This is extremely valuable for command palette matching in Peek — it
 * captures the user's actual abbreviation patterns.
 *
 * ============================================================
 * TODO: MAPPING TO PEEK'S SYSTEM
 * ============================================================
 *
 * Peek has its own frecency system (items.frecencyScore column). Potential
 * integration approaches:
 *
 * 1. **Direct import**: Copy Firefox's frecency score into Peek's
 *    frecencyScore column. Simple but scores may not be comparable
 *    with Peek's internally-generated scores.
 *
 * 2. **Normalized import**: Scale Firefox frecency scores to match
 *    Peek's expected range. Need to analyze Peek's frecency calculation
 *    to determine the right normalization.
 *
 * 3. **Seed data**: Import Firefox frecency as metadata, then let Peek
 *    rebuild its own frecency using Firefox's visit data as a starting
 *    point. This is the most correct approach.
 *
 * For adaptive matching:
 *
 * 1. **Metadata storage**: Import input associations into item metadata
 *    as `{ adaptiveMatches: [{ input: "gi", useCount: 5.2 }, ...] }`.
 *    The cmd palette could read these for boosting.
 *
 * 2. **Separate table**: Create a dedicated search_hints table for
 *    input->URL associations. More structured but requires schema change.
 *
 * 3. **item_events**: Record each adaptive match as an item_event with
 *    content = input text. Preserves the timeline.
 *
 * Recommended approach: Option 3 (seed data) for frecency, Option 1
 * (metadata) for adaptive matching. The visit timeline is already being
 * imported into item_events, so Peek can recalculate frecency from that
 * raw data. The adaptive matches are small enough to fit in metadata.
 */

import { existsSync, copyFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';

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
