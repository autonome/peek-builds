/**
 * Tags Extension - Tag visualization and management
 *
 * Provides:
 * - View all saved items filtered by type
 * - Tag-based filtering via clickable tag buttons
 * - Tag editing on items
 * - Search across items and tags
 * - Commands: tag, tags, untag, tagset
 */

import { registerNoun, unregisterNoun } from 'peek://cmd/nouns.js';

// Feature detection - check if Peek API is available
const hasPeekAPI = typeof window.app !== 'undefined';
const api = hasPeekAPI ? window.app : null;

/**
 * Open the tags home window
 */
function openTags() {
  if (hasPeekAPI) {
    api.window.open('peek://tags/home.html', {
      role: 'workspace',
      key: 'tags-home',
      width: 900,
      height: 700,
      title: 'Tags'
    });
  } else {
    window.open('./home.html', '_blank');
  }
}

/**
 * List all tags (console output)
 */
async function listTags() {
  if (!hasPeekAPI) return;

  const result = await api.datastore.getTagsByFrecency();
  if (!result.success) return { success: false };
  return { success: true, tags: result.data };
}

// ============================================================================
// Tag command helpers
// ============================================================================

/**
 * Get the most recently focused non-internal window.
 *
 * Primary: the tracker (`getFocusedVisibleWindowId()`) — survives cmd panel
 * focus changes and matches OS-level user intent.
 *
 * Fallback (tracker is null, common under headless where focus events may
 * not reliably fire): prefer a canvas page window
 * (`peek://app/page/index.html?url=...`) because that's the content surface
 * tagging typically targets, and take the newest by id. This keeps the
 * heuristic deterministic: if the user just opened a page, that's the one
 * we tag. Falls back to the last listed window only if no page window
 * exists at all.
 */
const isPageCanvasUrl = (url) =>
  typeof url === 'string' && url.startsWith('peek://app/page/index.html');

const getActiveWindow = async () => {
  const result = await api.window.list({ includeInternal: false });
  if (!result.success || !result.windows.length) {
    return null;
  }
  // Use the last focused visible window (survives cmd palette focus changes)
  const focusedId = await api.window.getFocusedVisibleWindowId();
  if (focusedId) {
    const focused = result.windows.find(w => w.id === focusedId);
    if (focused) return focused;
  }
  // Fallback: newest page-canvas window, deterministic and user-intent
  // aligned. See smoke.spec.ts:2015 flake analysis.
  const pageWindows = result.windows.filter(w => isPageCanvasUrl(w.url));
  if (pageWindows.length) {
    return pageWindows.reduce((a, b) => (a.id > b.id ? a : b));
  }
  // No page windows at all — fall back to the newest window by id.
  return result.windows.reduce((a, b) => (a.id > b.id ? a : b));
};

/**
 * Find item record by URL content
 */
const findItemByUrl = async (url) => {
  const result = await api.datastore.queryItems({ type: 'url', search: url, limit: 5 });
  if (!result.success) return null;

  return result.data.find(item => item.content === url) || null;
};

/**
 * Strip # prefix from tag name (users type "#foo" but tags are stored as "foo")
 */
const normalizeTagName = (name) => name.startsWith('#') ? name.slice(1) : name;

/**
 * Add tags to an item using the join table
 */
const addTagsToItem = async (itemId, tagNames) => {
  const results = [];

  for (const rawName of tagNames) {
    const tagName = normalizeTagName(rawName);
    // Get or create the tag
    const tagResult = await api.datastore.getOrCreateTag(tagName);
    if (!tagResult.success) {
      console.error('Failed to get/create tag:', tagName, tagResult.error);
      continue;
    }

    const tag = tagResult.data.tag;

    // Link tag to item
    const linkResult = await api.datastore.tagItem(itemId, tag.id);
    if (!linkResult.success) {
      console.error('Failed to link tag:', tagName, linkResult.error);
      continue;
    }

    results.push({
      tag,
      alreadyExists: linkResult.alreadyExists
    });
  }

  return results;
};

/**
 * Remove tags from an item
 */
const removeTagsFromItem = async (itemId, tagNames) => {
  const results = [];

  // Get current tags for item
  const tagsResult = await api.datastore.getItemTags(itemId);
  if (!tagsResult.success) {
    return results;
  }

  for (const rawName of tagNames) {
    const tagName = normalizeTagName(rawName);
    // Find the tag by name
    const tag = tagsResult.data.find(t => t.name.toLowerCase() === tagName.toLowerCase());
    if (!tag) continue;

    // Unlink tag from item
    const unlinkResult = await api.datastore.untagItem(itemId, tag.id);
    results.push({
      tag,
      removed: unlinkResult.success
    });
  }

  return results;
};

/**
 * Get tags for an item
 */
const getTagsForItem = async (itemId) => {
  const result = await api.datastore.getItemTags(itemId);
  if (!result.success) return [];
  return result.data;
};

// ============================================================================
// Tag command execute functions
// ============================================================================

/**
 * Tag command - add tags to the URL of the active window
 * Usage:
 *   tag foo          - add tag "foo" to active window's URL
 *   tag foo bar      - add multiple tags
 *   tag -r foo       - remove tag "foo" from active window
 *   tag              - show tags for active window
 */
async function executeTag(ctx) {
  // Get active window
  const activeWindow = await getActiveWindow();
  if (!activeWindow) {
    return { success: false, error: 'No active window' };
  }

  const url = activeWindow.url;

  // Find item in datastore
  let item = await findItemByUrl(url);

  // If no item exists, create one
  if (!item) {
    const addResult = await api.datastore.addItem('url', {
      content: url,
      metadata: JSON.stringify({ title: activeWindow.title || '' })
    });
    if (!addResult.success) {
      console.error('Failed to create item:', addResult.error);
      return { success: false, error: 'Failed to create item' };
    }
    item = { id: addResult.data.id };
  }

  // No args - show current tags
  if (!ctx.search) {
    const tags = await getTagsForItem(item.id);
    return { success: true, tags };
  }

  // Parse args
  // If comma present, split on comma; otherwise split on spaces
  const input = ctx.search.trim();
  const hasComma = input.includes(',');
  let args;
  if (hasComma) {
    args = input.split(',').map(s => s.trim()).filter(s => s.length > 0);
  } else {
    args = input.split(/\s+/);
  }
  const removeMode = args[0] === '-r';
  const tagsToProcess = removeMode ? args.slice(1) : args;

  if (tagsToProcess.length === 0) {
    return { success: false, error: 'No tags specified' };
  }

  // Add or remove tags
  if (removeMode) {
    const results = await removeTagsFromItem(item.id, tagsToProcess);
    const removed = results.filter(r => r.removed).map(r => r.tag.name);
    return { success: true, removed };
  } else {
    const results = await addTagsToItem(item.id, tagsToProcess);
    const added = results.filter(r => !r.alreadyExists).map(r => r.tag.name);
    const existing = results.filter(r => r.alreadyExists).map(r => r.tag.name);
    return { success: true, added, existing };
  }
}

/**
 * Tags command - show tags for the active window URL (or all tags by frecency)
 */
async function executeTags(ctx) {
  // If search term provided, show all tags matching
  if (ctx.search) {
    const result = await api.datastore.getTagsByFrecency();
    if (!result.success) return { success: false };

    const filter = ctx.search.toLowerCase();
    const filtered = result.data.filter(t => t.name.toLowerCase().includes(filter));
    return { success: true, tags: filtered };
  }

  // No args - show tags for active window
  const activeWindow = await getActiveWindow();
  if (!activeWindow) {
    // No active window - show all tags by frecency
    const result = await api.datastore.getTagsByFrecency();
    if (!result.success) return { success: false };
    return { success: true, tags: result.data };
  }

  const item = await findItemByUrl(activeWindow.url);
  if (!item) return { success: true, tags: [] };

  const tags = await getTagsForItem(item.id);
  return { success: true, tags };
}

/**
 * Untag command - remove tags from the active window URL
 */
async function executeUntag(ctx) {
  if (!ctx.search) {
    return { success: false, error: 'No tags specified' };
  }

  // Delegate to tag -r
  return executeTag({ search: '-r ' + ctx.search });
}

// ============================================================================
// Tagset command
// ============================================================================

/**
 * Create a new tagset with the specified tags
 * @param {string} tagsString - Comma-separated list of tag names
 * @returns {Promise<Object>} The ID and tags of the created tagset
 */
const createTagset = async (tagsString) => {
  // Parse tags from comma-separated string
  const tagNames = tagsString
    .split(',')
    .map(t => t.trim())
    .filter(t => t.length > 0);

  if (tagNames.length === 0) {
    throw new Error('No valid tags provided');
  }

  // Create the tagset item
  const result = await api.datastore.addItem('tagset', {
    content: tagNames.join(', ')
  });

  if (!result.success) {
    throw new Error(result.error || 'Failed to create tagset');
  }

  const itemId = result.data.id;

  // Add each tag to the tagset
  for (const rawName of tagNames) {
    const tagName = normalizeTagName(rawName);
    const tagResult = await api.datastore.getOrCreateTag(tagName);
    if (tagResult.success) {
      await api.datastore.tagItem(itemId, tagResult.data.tag.id);
    }
  }

  // Also add the 'from:cmd' tag to track origin
  const fromCmdResult = await api.datastore.getOrCreateTag('from:cmd');
  if (fromCmdResult.success) {
    await api.datastore.tagItem(itemId, fromCmdResult.data.tag.id);
  }

  return { id: itemId, tags: tagNames };
};

/**
 * Tagset command - creates tagset items in the datastore
 * Tagsets are items of type='tagset' that exist solely to hold a combination of tags
 */
async function executeTagset(ctx) {
  if (ctx.search) {
    try {
      const { id, tags } = await createTagset(ctx.search);
      api.pubsub.publish('editor:changed', { action: 'add', itemId: id }, api.scopes.GLOBAL);
      return { success: true, message: `Tagset created with tags: ${tags.join(', ')}` };
    } catch (error) {
      console.error('Failed to create tagset:', error);
      return { success: false, message: error.message };
    }
  } else {
    api.pubsub.publish('editor:add', { type: 'tagset' }, api.scopes.GLOBAL);
    return { success: true, message: 'Opening editor' };
  }
}

const extension = {
  id: 'tags',
  labels: {
    name: 'Tags'
  },

  /**
   * Register commands - called when cmd extension is ready
   */
  registerCommands() {
    // Register noun for auto-generated open/list commands
    registerNoun({
      name: 'tags',
      singular: 'tag',
      description: 'Tags for organizing items',
      skipBare: true, // Keep specialized 'tags' command below

      query: async ({ search }) => {
        const result = await api.datastore.getTagsByFrecency();
        if (!result.success) return { success: false };
        let tags = result.data;
        if (search) {
          const q = search.toLowerCase();
          tags = tags.filter(t => t.name.toLowerCase().includes(q));
        }
        return {
          success: true,
          output: {
            data: tags.slice(0, 20).map(t => ({
              name: t.name,
              frequency: t.frequency,
              frecency: t.frecencyScore
            })),
            mimeType: 'application/json',
            title: `Tags (${tags.length})`
          }
        };
      },

      browse: async () => { openTags(); },
      produces: 'application/json'
    });

    // Tag command - add tags to the active window URL
    api.commands.register({
      name: 'tag',
      description: 'Add tags to the active window URL',
      params: [{ type: 'tag', multiple: true }],
      execute: executeTag
    });

    // Tags command - show tags for active window or all tags
    api.commands.register({
      name: 'tags',
      description: 'Show tags for the active window URL (or all tags by frecency)',
      execute: executeTags
    });

    // Untag command - remove tags from active window
    api.commands.register({
      name: 'untag',
      description: 'Remove tags from the active window URL',
      params: [{ type: 'tag', multiple: true }],
      execute: executeUntag
    });

    // Tagset command - create tagset items
    api.commands.register({
      name: 'tagset',
      description: 'Create a tagset with specified tags',
      params: [{ type: 'tag', multiple: true, prefix: '#' }],
      execute: executeTagset
    });

  },

  init() {
    if (!hasPeekAPI) return;

    // Register commands (cmd loads first with its subscribers ready via 100ms head start)
    this.registerCommands();

    // Register global shortcut Option+T (works when Peek is not focused)
    api.shortcuts.register('Option+t', openTags, { global: true });

    // Register local shortcut Cmd+T (works when a Peek window is focused)
    api.shortcuts.register('CommandOrControl+T', openTags);
  },

  uninit() {

    if (hasPeekAPI) {
      unregisterNoun('tags');
      api.commands.unregister('tag');
      api.commands.unregister('tags');
      api.commands.unregister('untag');
      api.commands.unregister('tagset');
      api.shortcuts.unregister('Option+t', { global: true });
      api.shortcuts.unregister('CommandOrControl+T');
    }
  }
};

// Export for ES module usage (Peek extension)
export default extension;
