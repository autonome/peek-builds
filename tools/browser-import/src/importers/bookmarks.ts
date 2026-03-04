/**
 * Bookmarks importer
 *
 * Reads browser bookmarks and creates url items in the Peek datastore,
 * including tags derived from the bookmark folder hierarchy.
 */

import type { BookmarkEntry, ImportResult, BrowserName } from '../types.js';
import { itemExistsByUrl, createItem, getOrCreateTag, tagItem, runInTransaction } from '../datastore.js';

/**
 * Convert a bookmark folder path into a set of hierarchical tags.
 * e.g., "Toolbar/Work/Research" => ["bookmark:Toolbar", "bookmark:Toolbar/Work", "bookmark:Toolbar/Work/Research"]
 */
function folderPathToTags(folderPath: string): string[] {
  if (!folderPath) return [];

  const parts = folderPath.split('/').filter(p => p.length > 0);
  const tags: string[] = [];
  let accumulated = '';

  for (const part of parts) {
    accumulated = accumulated ? `${accumulated}/${part}` : part;
    tags.push(`bookmark:${accumulated}`);
  }

  return tags;
}

export function importBookmarks(
  entries: BookmarkEntry[],
  browserName: BrowserName,
  profileName: string,
  options?: { tagFolders?: boolean },
): ImportResult {
  const tagFolders = options?.tagFolders !== false; // default true

  const result: ImportResult = {
    itemsImported: 0,
    tagsCreated: 0,
    duplicatesSkipped: 0,
    errors: [],
  };

  if (entries.length === 0) return result;

  const importTimestamp = new Date().toISOString();

  runInTransaction(() => {
    // Create shared tags
    const browserTag = getOrCreateTag('import:browser');
    if (browserTag.created) result.tagsCreated++;

    const browserNameTag = getOrCreateTag(`import:${browserName}`);
    if (browserNameTag.created) result.tagsCreated++;

    const profileTag = getOrCreateTag(`import:${profileName}`);
    if (profileTag.created) result.tagsCreated++;

    const bookmarkTag = getOrCreateTag('browser:bookmark');
    if (bookmarkTag.created) result.tagsCreated++;

    // Cache folder tags to avoid redundant lookups
    const folderTagCache = new Map<string, string>();

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
          metadata: {
            title: entry.title,
            folderPath: entry.folderPath,
            dateAdded: entry.dateAdded,
            source: 'bookmark',
            sourceProfile: profileName,
            sourceBrowser: browserName,
            importedAt: importTimestamp,
          },
        });

        // Apply shared tags
        tagItem(itemId, browserTag.tagId);
        tagItem(itemId, browserNameTag.tagId);
        tagItem(itemId, profileTag.tagId);
        tagItem(itemId, bookmarkTag.tagId);

        // Apply folder hierarchy tags (when enabled)
        if (tagFolders) {
          const folderTags = folderPathToTags(entry.folderPath);
          for (const folderTagName of folderTags) {
            let folderTagId = folderTagCache.get(folderTagName);
            if (!folderTagId) {
              const { tagId, created } = getOrCreateTag(folderTagName);
              folderTagId = tagId;
              folderTagCache.set(folderTagName, tagId);
              if (created) result.tagsCreated++;
            }
            tagItem(itemId, folderTagId);
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
