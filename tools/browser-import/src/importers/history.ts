/**
 * History importer
 *
 * Reads browser history entries and creates url items in the Peek datastore.
 */

import type { HistoryEntry, ImportResult, BrowserName } from '../types.js';
import { itemExistsByUrl, createItem, getOrCreateTag, tagItem, runInTransaction } from '../datastore.js';

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
        // Skip if URL already exists
        if (itemExistsByUrl(entry.url)) {
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

        result.itemsImported++;
      } catch (err) {
        result.errors.push(`Failed to import ${entry.url}: ${(err as Error).message}`);
      }
    }
  });

  return result;
}
