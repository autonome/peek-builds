/**
 * Shared browser reader types
 */

import type { HistoryEntry, BookmarkEntry, SessionTab, DataInspection } from '../types.js';

export interface BrowserReader {
  /** Read history entries from the profile */
  readHistory(profilePath: string): HistoryEntry[];

  /** Read bookmark entries from the profile */
  readBookmarks(profilePath: string): BookmarkEntry[];

  /** Read session/tab entries from the profile */
  readSessions(profilePath: string): SessionTab[];

  /** Inspect what data is available in the profile */
  inspect(profilePath: string): DataInspection[];
}
