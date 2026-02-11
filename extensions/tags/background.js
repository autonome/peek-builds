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

// Feature detection - check if Peek API is available
const hasPeekAPI = typeof window.app !== 'undefined';
const api = hasPeekAPI ? window.app : null;

/**
 * Open the tags home window
 */
function openTags() {
  if (hasPeekAPI) {
    api.window.open('peek://ext/tags/home.html', {
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
  if (!hasPeekAPI) {
    console.log('Peek API not available');
    return;
  }

  const result = await api.datastore.getTagsByFrecency();
  if (!result.success) {
    console.log('Failed to get tags');
    return { success: false };
  }

  if (result.data.length === 0) {
    console.log('No tags yet');
  } else {
    console.log('All tags (by frecency):');
    result.data.slice(0, 20).forEach(t => {
      console.log('  -', t.name, `(used ${t.frequency}x, frecency: ${t.frecencyScore?.toFixed(1) || 0})`);
    });
  }
  return { success: true, tags: result.data };
}

// ============================================================================
// Tag command helpers
// ============================================================================

/**
 * Get the most recently focused non-internal window
 */
const getActiveWindow = async () => {
  const result = await api.window.list({ includeInternal: false });
  if (!result.success || !result.windows.length) {
    return null;
  }
  // Return the first non-internal window
  return result.windows[0];
};

/**
 * Find item record by URL content
 */
const findItemByUrl = async (url) => {
  const result = await api.datastore.queryItems({ type: 'url' });
  if (!result.success) return null;

  return result.data.find(item => item.content === url) || null;
};

/**
 * Add tags to an item using the join table
 */
const addTagsToItem = async (itemId, tagNames) => {
  const results = [];

  for (const tagName of tagNames) {
    // Get or create the tag
    api.log('[tag] Getting/creating tag:', tagName);
    const tagResult = await api.datastore.getOrCreateTag(tagName);
    api.log('[tag] getOrCreateTag result:', JSON.stringify(tagResult));
    if (!tagResult.success) {
      console.error('Failed to get/create tag:', tagName, tagResult.error);
      continue;
    }

    const tag = tagResult.data.tag;
    api.log('[tag] Tag id:', tag.id, 'name:', tag.name);

    // Link tag to item
    api.log('[tag] Linking tag', tag.id, 'to item', itemId);
    const linkResult = await api.datastore.tagItem(itemId, tag.id);
    api.log('[tag] tagItem result:', JSON.stringify(linkResult));
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

  for (const tagName of tagNames) {
    // Find the tag by name
    const tag = tagsResult.data.find(t => t.name.toLowerCase() === tagName.toLowerCase());
    if (!tag) {
      console.log('Tag not found on item:', tagName);
      continue;
    }

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
  api.log('tag command execute, ctx:', ctx);
  const activeWindow = await getActiveWindow();
  api.log('tag command: activeWindow =', activeWindow);
  if (!activeWindow) {
    api.log('No active window found');
    return { success: false, error: 'No active window' };
  }

  const url = activeWindow.url;
  api.log('Tagging URL:', url);

  // Find item in datastore
  let item = await findItemByUrl(url);

  // If no item exists, create one
  if (!item) {
    api.log('[tag] Creating new item for URL:', url);
    const addResult = await api.datastore.addItem('url', {
      content: url,
      metadata: JSON.stringify({ title: activeWindow.title || '' })
    });
    api.log('[tag] addItem result:', JSON.stringify(addResult));
    if (!addResult.success) {
      console.error('Failed to create item:', addResult.error);
      return { success: false, error: 'Failed to create item' };
    }
    item = { id: addResult.data.id };
    api.log('[tag] Created item with id:', item.id);
  } else {
    api.log('[tag] Found existing item:', item.id, 'for URL:', url);
  }

  // No args - show current tags
  if (!ctx.search) {
    const tags = await getTagsForItem(item.id);
    if (tags.length === 0) {
      console.log('No tags for:', url);
    } else {
      console.log('Tags for', url + ':');
      tags.forEach(t => console.log('  -', t.name, `(frecency: ${t.frecencyScore?.toFixed(1) || 0})`));
    }
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
    console.log('No tags specified');
    return { success: false, error: 'No tags specified' };
  }

  // Add or remove tags
  if (removeMode) {
    const results = await removeTagsFromItem(item.id, tagsToProcess);
    const removed = results.filter(r => r.removed).map(r => r.tag.name);
    if (removed.length > 0) {
      console.log('Removed tags:', removed.join(', '), 'from', url);
    }
    return { success: true, removed };
  } else {
    api.log('Adding tags to item:', item.id, 'tags:', tagsToProcess);
    const results = await addTagsToItem(item.id, tagsToProcess);
    api.log('addTagsToItem results:', results);
    const added = results.filter(r => !r.alreadyExists).map(r => r.tag.name);
    const existing = results.filter(r => r.alreadyExists).map(r => r.tag.name);
    if (added.length > 0) {
      console.log('Added tags:', added.join(', '), 'to', url);
    }
    if (existing.length > 0) {
      console.log('Already tagged:', existing.join(', '));
    }
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
    if (!result.success) {
      console.log('Failed to get tags');
      return { success: false };
    }

    const filter = ctx.search.toLowerCase();
    const filtered = result.data.filter(t => t.name.toLowerCase().includes(filter));

    if (filtered.length === 0) {
      console.log('No tags matching:', ctx.search);
    } else {
      console.log('Tags matching "' + ctx.search + '":');
      filtered.forEach(t => {
        console.log('  -', t.name, `(used ${t.frequency}x, frecency: ${t.frecencyScore?.toFixed(1) || 0})`);
      });
    }
    return { success: true, tags: filtered };
  }

  // No args - show tags for active window
  const activeWindow = await getActiveWindow();
  if (!activeWindow) {
    // No active window - show all tags by frecency
    const result = await api.datastore.getTagsByFrecency();
    if (!result.success) {
      console.log('Failed to get tags');
      return { success: false };
    }

    if (result.data.length === 0) {
      console.log('No tags yet');
    } else {
      console.log('All tags (by frecency):');
      result.data.slice(0, 20).forEach(t => {
        console.log('  -', t.name, `(used ${t.frequency}x, frecency: ${t.frecencyScore?.toFixed(1) || 0})`);
      });
    }
    return { success: true, tags: result.data };
  }

  const item = await findItemByUrl(activeWindow.url);
  if (!item) {
    console.log('No tags for:', activeWindow.url);
    return { success: true, tags: [] };
  }

  const tags = await getTagsForItem(item.id);

  if (tags.length === 0) {
    console.log('No tags for:', activeWindow.url);
  } else {
    console.log('Tags for', activeWindow.url + ':');
    tags.forEach(t => console.log('  -', t.name));
  }

  return { success: true, tags };
}

/**
 * Untag command - remove tags from the active window URL
 */
async function executeUntag(ctx) {
  if (!ctx.search) {
    console.log('Usage: untag <tag1> [tag2] ...');
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
  for (const tagName of tagNames) {
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
      console.log(`Tagset created with ID: ${id}`);
      console.log(`Tags: ${tags.join(', ')}`);
      api.publish('editor:changed', { action: 'add', itemId: id }, api.scopes.GLOBAL);
      return { success: true, message: `Tagset created with tags: ${tags.join(', ')}` };
    } catch (error) {
      console.error('Failed to create tagset:', error);
      return { success: false, message: error.message };
    }
  } else {
    api.publish('editor:add', { type: 'tagset' }, api.scopes.GLOBAL);
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
    // Command to open tags view
    api.commands.register({
      name: 'open tags',
      description: 'Open the tags browser',
      execute: openTags
    });

    // Command to list tags
    api.commands.register({
      name: 'list tags',
      description: 'List all tags by frecency',
      execute: listTags
    });

    // Tag command - add tags to the active window URL
    api.commands.register({
      name: 'tag',
      description: 'Add tags to the active window URL',
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
      execute: executeUntag
    });

    // Tagset command - create tagset items
    api.commands.register({
      name: 'tagset',
      description: 'Create a tagset with specified tags',
      execute: executeTagset
    });

    console.log('[tags] Commands registered');
  },

  init() {
    console.log('[tags] init - Peek API available:', hasPeekAPI);

    if (!hasPeekAPI) {
      console.log('[tags] Running without Peek API - limited functionality');
      return;
    }

    // Wait for cmd:ready before registering commands
    api.subscribe('cmd:ready', () => {
      this.registerCommands();
    }, api.scopes.GLOBAL);

    // Query in case cmd is already ready
    api.publish('cmd:query', {}, api.scopes.GLOBAL);

    // Register global shortcut Option+T (works when Peek is not focused)
    api.shortcuts.register('Option+t', openTags, { global: true });

    // Register local shortcut Cmd+T (works when a Peek window is focused)
    api.shortcuts.register('CommandOrControl+T', openTags);

    console.log('[tags] Extension loaded');
  },

  uninit() {
    console.log('[tags] Cleaning up...');

    if (hasPeekAPI) {
      api.commands.unregister('open tags');
      api.commands.unregister('list tags');
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
