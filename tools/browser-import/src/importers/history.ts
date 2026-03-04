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
