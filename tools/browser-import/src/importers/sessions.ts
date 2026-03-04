/**
 * Session/tab importer
 *
 * Imports browser session tabs (open tabs across windows) as url items in the Peek datastore.
 * Tags with browser:session, browser:tab, import:browser, import:{browser}.
 * Tab groups become additional tags like tab-group:{name}.
 */

import type { SessionTab, ImportResult, BrowserName } from '../types.js';
import { itemExistsByUrl, createItem, getOrCreateTag, tagItem, runInTransaction } from '../datastore.js';

export function importSessions(
  tabs: SessionTab[],
  browserName: BrowserName,
  profileName: string,
): ImportResult {
  const result: ImportResult = {
    itemsImported: 0,
    tagsCreated: 0,
    duplicatesSkipped: 0,
    errors: [],
  };

  if (tabs.length === 0) return result;

  const importTimestamp = new Date().toISOString();

  runInTransaction(() => {
    // Create shared tags
    const browserTag = getOrCreateTag('import:browser');
    if (browserTag.created) result.tagsCreated++;

    const browserNameTag = getOrCreateTag(`import:${browserName}`);
    if (browserNameTag.created) result.tagsCreated++;

    const profileTag = getOrCreateTag(`import:${profileName}`);
    if (profileTag.created) result.tagsCreated++;

    const sessionTag = getOrCreateTag('browser:session');
    if (sessionTag.created) result.tagsCreated++;

    const tabTag = getOrCreateTag('browser:tab');
    if (tabTag.created) result.tagsCreated++;

    // Cache for tab group tags
    const groupTagCache = new Map<string, string>();

    // Cache for pinned tag
    let pinnedTagId: string | null = null;

    for (const tab of tabs) {
      try {
        // Skip if URL already exists
        if (itemExistsByUrl(tab.url)) {
          result.duplicatesSkipped++;
          continue;
        }

        const metadata: Record<string, unknown> = {
          title: tab.title,
          sourceProfile: profileName,
          sourceBrowser: browserName,
          importedAt: importTimestamp,
          importSource: 'session',
        };

        if (tab.pinned) metadata.pinned = true;
        if (tab.windowIndex !== undefined) metadata.windowIndex = tab.windowIndex;
        if (tab.lastAccessed) metadata.lastAccessed = tab.lastAccessed;
        if (tab.tabGroup) metadata.tabGroup = tab.tabGroup;

        const itemId = createItem({
          type: 'url',
          content: tab.url,
          title: tab.title,
          metadata,
        });

        // Apply shared tags
        tagItem(itemId, browserTag.tagId);
        tagItem(itemId, browserNameTag.tagId);
        tagItem(itemId, profileTag.tagId);
        tagItem(itemId, sessionTag.tagId);
        tagItem(itemId, tabTag.tagId);

        // Apply pinned tag if applicable
        if (tab.pinned) {
          if (!pinnedTagId) {
            const { tagId, created } = getOrCreateTag('browser:pinned');
            pinnedTagId = tagId;
            if (created) result.tagsCreated++;
          }
          tagItem(itemId, pinnedTagId);
        }

        // Apply tab group tag if applicable
        if (tab.tabGroup) {
          const groupTagName = `tab-group:${tab.tabGroup}`;
          let groupTagId = groupTagCache.get(groupTagName);
          if (!groupTagId) {
            const { tagId, created } = getOrCreateTag(groupTagName);
            groupTagId = tagId;
            groupTagCache.set(groupTagName, tagId);
            if (created) result.tagsCreated++;
          }
          tagItem(itemId, groupTagId);
        }

        result.itemsImported++;
      } catch (err) {
        result.errors.push(`Failed to import session tab ${tab.url}: ${(err as Error).message}`);
      }
    }
  });

  return result;
}
