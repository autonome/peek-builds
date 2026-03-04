/**
 * History importer
 *
 * Reads browser history entries and creates url items in the Peek datastore.
 * Also records individual visits as item_events for full visit timeline.
 */

import type { HistoryEntry, ImportResult, BrowserName } from '../types.js';
import {
  itemExistsByUrl, createItem, getOrCreateTag, tagItem,
  getItemIdByUrl, updateItemVisitData, recordVisit,
  runInTransaction,
} from '../datastore.js';

/**
 * Map browser-specific visit type codes to the normalized source enum.
 *
 * Firefox visit types: 1=LINK, 2=TYPED, 3=BOOKMARK, 4=EMBED, 5=REDIRECT_PERMANENT,
 *   6=REDIRECT_TEMPORARY, 7=DOWNLOAD, 8=FRAMED_LINK
 *
 * Chrome core transition types (transition & 0xFF):
 *   0=LINK, 1=TYPED, 2=AUTO_BOOKMARK, 3=AUTO_SUBFRAME, 4=MANUAL_SUBFRAME,
 *   5=GENERATED, 6=AUTO_TOPLEVEL, 7=FORM_SUBMIT, 8=RELOAD, 9=KEYWORD
 */
function mapVisitTypeToSource(
  visitType: number | undefined,
  browser: BrowserName,
): 'typed' | 'bookmark' | 'link' | 'direct' {
  if (visitType === undefined) return 'direct';

  if (browser === 'firefox') {
    switch (visitType) {
      case 2: return 'typed';
      case 3: return 'bookmark';
      case 1: return 'link';
      default: return 'direct';
    }
  }

  // Chrome / Brave (Chromium-based)
  switch (visitType) {
    case 1: return 'typed';
    case 2: // AUTO_BOOKMARK
    case 9: return 'bookmark'; // KEYWORD
    case 0: return 'link';
    default: return 'direct';
  }
}

export function importHistory(
  entries: HistoryEntry[],
  browserName: BrowserName,
  profileName: string,
): ImportResult {
  const result: ImportResult = {
    itemsImported: 0,
    tagsCreated: 0,
    duplicatesSkipped: 0,
    errors: [],
  };

  if (entries.length === 0) return result;

  // Pre-create tags outside the per-item loop
  const importTimestamp = new Date().toISOString();

  runInTransaction(() => {
    // Create shared tags
    const browserTag = getOrCreateTag('import:browser');
    if (browserTag.created) result.tagsCreated++;

    const browserNameTag = getOrCreateTag(`import:${browserName}`);
    if (browserNameTag.created) result.tagsCreated++;

    const profileTag = getOrCreateTag(`import:${profileName}`);
    if (profileTag.created) result.tagsCreated++;

    const historyTag = getOrCreateTag('browser:history');
    if (historyTag.created) result.tagsCreated++;

    for (const entry of entries) {
      try {
        // Check if URL already exists
        const existingId = getItemIdByUrl(entry.url);

        if (existingId) {
          // Update visit data on existing item if our data is newer/more complete
          updateItemVisitData(existingId, entry.visitCount, entry.lastVisitTime);

          // Still record individual visits even for existing items
          if (entry.visits && entry.visits.length > 0) {
            for (const visit of entry.visits) {
              recordVisit(existingId, visit.timestamp, {
                eventType: 'visit',
                visitType: visit.visitType,
                source: mapVisitTypeToSource(visit.visitType, browserName),
                sourceBrowser: browserName,
              });
            }
          }

          result.duplicatesSkipped++;
          continue;
        }

        const itemId = createItem({
          type: 'url',
          content: entry.url,
          title: entry.title,
          visitCount: entry.visitCount,
          lastVisitAt: entry.lastVisitTime,
          metadata: {
            title: entry.title,
            visitCount: entry.visitCount,
            lastVisit: entry.lastVisitTime,
            sourceProfile: profileName,
            sourceBrowser: browserName,
            importedAt: importTimestamp,
          },
        });

        // Apply tags
        tagItem(itemId, browserTag.tagId);
        tagItem(itemId, browserNameTag.tagId);
        tagItem(itemId, profileTag.tagId);
        tagItem(itemId, historyTag.tagId);

        // Record individual visits as item_events
        if (entry.visits && entry.visits.length > 0) {
          for (const visit of entry.visits) {
            recordVisit(itemId, visit.timestamp, {
              eventType: 'visit',
              visitType: visit.visitType,
              source: mapVisitTypeToSource(visit.visitType, browserName),
              sourceBrowser: browserName,
            });
          }
        }

        result.itemsImported++;
      } catch (err) {
        result.errors.push(`Failed to import ${entry.url}: ${(err as Error).message}`);
      }
    }
  });

  return result;
}
