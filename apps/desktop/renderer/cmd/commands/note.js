/**
 * Note command - saves items to the datastore with smart type detection
 *
 * If input is a URL → saves as url item
 * If input is hashtags (#foo #bar) → saves as tagset item with those tags
 * If input is text → saves as text item tagged with 'note' and 'from:cmd'
 */
import api from 'peek://app/api.js';
import { splitTrailingTags } from 'peek://app/lib/note-tags.js';

const NOTE_TAGS = ['note', 'from:cmd'];

/**
 * Check if input is a tagset (hashtag syntax like "#foo #bar").
 * Returns the parsed tag names if it is a tagset, or null otherwise.
 */
const parseTagset = (text) => {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  // Split on whitespace and check that every token starts with #
  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 0) return null;
  const allHashtags = tokens.every(t => /^#[^\s#]+$/.test(t));
  if (!allHashtags) return null;
  // Strip the # prefix from each tag name
  return tokens.map(t => t.slice(1));
};

/**
 * Detect item type from input
 */
const detectType = (text) => {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return 'url';
  if (parseTagset(trimmed)) return 'tagset';
  return 'text';
};

/**
 * Save input to the datastore, auto-detecting type
 */
const saveItem = async (input) => {
  const type = detectType(input);
  if (!type) throw new Error('No input provided');

  // For tagsets, store the tag names as comma-separated content
  const tagNames = type === 'tagset' ? parseTagset(input) : null;
  // Text notes keep trailing #tags out of the body and tag the item instead
  const split = type === 'text' ? splitTrailingTags(input) : null;
  const opts = { content: type === 'tagset' ? tagNames.join(', ') : type === 'text' ? split.body : input };
  if (type === 'url') opts.url = input;

  const result = await api.datastore.addItem(type, opts);
  if (!result.success) {
    throw new Error(result.error || 'Failed to save item');
  }

  const itemId = result.data.id;

  // Tag text notes with 'note' and 'from:cmd'
  if (type === 'text') {
    // Trailing hashtags were trimmed from the body; mid-text hashtags are
    // still extracted automatically by the datastore layer
    for (const tagName of [...NOTE_TAGS, ...split.tags]) {
      const tagResult = await api.datastore.getOrCreateTag(tagName);
      if (tagResult.success) {
        await api.datastore.tagItem(itemId, tagResult.data.tag.id);
      }
    }
  }

  // For tagsets, add each parsed tag and the 'from:cmd' origin tag
  if (type === 'tagset' && tagNames) {
    for (const tagName of tagNames) {
      const tagResult = await api.datastore.getOrCreateTag(tagName);
      if (tagResult.success) {
        await api.datastore.tagItem(itemId, tagResult.data.tag.id);
      }
    }
    const fromCmdResult = await api.datastore.getOrCreateTag('from:cmd');
    if (fromCmdResult.success) {
      await api.datastore.tagItem(itemId, fromCmdResult.data.tag.id);
    }
  }

  return { itemId, type, content: opts.content };
};

/**
 * Get all notes from the datastore
 */
const getNotes = async (limit = 20) => {
  // Query items of type 'text' that have the 'note' tag
  const result = await api.datastore.queryItems({
    type: 'text'
  });

  if (!result.success) {
    return [];
  }

  // Filter to only items with 'note' tag and limit
  const notes = [];
  for (const item of result.data) {
    const tagsResult = await api.datastore.getItemTags(item.id);
    if (tagsResult.success) {
      const hasNoteTag = tagsResult.data.some(t => t.name === 'note');
      if (hasNoteTag) {
        notes.push(item);
        if (notes.length >= limit) break;
      }
    }
  }

  return notes;
};

/**
 * Parse tag names from parameter string.
 * Accepts "#todo #today" or "todo today" syntax.
 * @param {string} text - Parameter text
 * @returns {string[]} Array of tag names (without # prefix)
 */
const parseTagParams = (text) => {
  if (!text || !text.trim()) return [];
  return text.trim().split(/\s+/).map(t => t.startsWith('#') ? t.slice(1) : t).filter(t => t.length > 0);
};

/**
 * Get notes filtered by tags (items that have ALL specified tags)
 * @param {string[]} tagNames - Tag names to filter by
 * @param {number} limit - Max results
 * @returns {Promise<{notes: Array, tagNames: string[]}>} Matching notes with their tags attached
 */
const getNotesByTags = async (tagNames, limit = 50) => {
  // Resolve tag names to tag IDs (read-only lookup, no creation)
  const allTagsResult = await api.datastore.getTagsByFrecency();
  if (!allTagsResult.success || !allTagsResult.data) {
    return { notes: [], tagNames };
  }

  const tagIds = [];
  for (const name of tagNames) {
    const tag = allTagsResult.data.find(t => t.name.toLowerCase() === name.toLowerCase());
    if (tag) {
      tagIds.push(tag.id);
    }
  }

  if (tagIds.length === 0) {
    return { notes: [], tagNames };
  }

  // Get items for the first tag, then intersect with other tags
  const firstTagItems = await api.datastore.getItemsByTag(tagIds[0]);
  if (!firstTagItems.success || !firstTagItems.data) {
    return { notes: [], tagNames };
  }

  // Filter to text items only
  let candidates = firstTagItems.data.filter(item => item.type === 'text');

  // Intersect with remaining tags
  for (let i = 1; i < tagIds.length; i++) {
    const tagItems = await api.datastore.getItemsByTag(tagIds[i]);
    if (!tagItems.success || !tagItems.data) {
      return { notes: [], tagNames };
    }
    const tagItemIds = new Set(tagItems.data.map(item => item.id));
    candidates = candidates.filter(item => tagItemIds.has(item.id));
  }

  // Attach tags to each note for downstream use
  const notesWithTags = [];
  for (const item of candidates.slice(0, limit)) {
    const tagsResult = await api.datastore.getItemTags(item.id);
    item._tags = tagsResult.success ? tagsResult.data.map(t => t.name) : [];
    notesWithTags.push(item);
  }

  return { notes: notesWithTags, tagNames };
};

// Commands
const commands = [
  {
    name: 'note',
    description: 'Save a note or URL (auto-detects type)',
    // Produces item when saving content, or signals new-item for empty editor
    produces: ['item'],

    async execute(ctx) {
      if (ctx.search) {
        // Save the provided content
        try {
          const { itemId, type, content } = await saveItem(ctx.search);
          console.log(`Saved ${type} item:`, itemId);

          // Return the saved item through the connector pattern
          // Panel will handle editor:changed notification and routing
          const typeLabel = type === 'url' ? 'URL' : type === 'tagset' ? 'Tagset' : 'Note';

          // Tagsets should not open in the editor — just confirm and close
          if (type === 'tagset') {
            return {
              success: true,
              message: `${typeLabel} saved: ${ctx.search}`
            };
          }

          return {
            success: true,
            message: `${typeLabel} saved`,
            output: {
              data: { id: itemId, type, content },
              mimeType: 'item',
              title: `Saved ${typeLabel.toLowerCase()}`,
              // Flag to indicate this is a newly created item (for editor:changed)
              isNew: true
            }
          };
        } catch (error) {
          console.error('Failed to save:', error);
          return { success: false, message: error.message };
        }
      } else {
        // No content provided - signal to open empty editor
        // Return special output that panel interprets as "open new editor"
        return {
          success: true,
          message: 'Opening editor',
          output: {
            data: { type: 'text' },
            mimeType: 'new-item',
            title: 'New note'
          }
        };
      }
    }
  },
  {
    name: 'notes',
    description: 'List recent notes',
    async execute(ctx) {
      const notes = await getNotes(10);
      if (notes.length === 0) {
        console.log('No notes found');
        return { success: true, message: 'No notes found' };
      } else {
        console.log('Recent notes:');
        notes.forEach((note, i) => {
          const preview = (note.content || '').substring(0, 50) + (note.content?.length > 50 ? '...' : '');
          console.log(`${i + 1}. ${preview}`);
        });
        return {
          success: true,
          message: `${notes.length} note${notes.length !== 1 ? 's' : ''} found`,
          output: {
            data: notes,
            mimeType: 'item',
            title: 'Recent notes'
          }
        };
      }
    }
  },
  {
    name: 'list notes',
    description: 'List notes filtered by tags (e.g. list notes #todo #today)',
    produces: ['application/json'],
    params: [{ type: 'tag', multiple: true, prefix: '#' }],

    async execute(ctx) {
      const tagNames = parseTagParams(ctx.search);

      if (tagNames.length === 0) {
        // No tags specified - return all notes
        const notes = await getNotes(50);
        if (notes.length === 0) {
          return { success: false, message: 'No notes found' };
        }

        // Attach tags to each note
        for (const note of notes) {
          const tagsResult = await api.datastore.getItemTags(note.id);
          note._tags = tagsResult.success ? tagsResult.data.map(t => t.name) : [];
        }

        return {
          success: true,
          output: {
            data: notes,
            mimeType: 'application/json',
            title: `All notes (${notes.length})`
          }
        };
      }

      // Filter by specified tags
      const { notes, tagNames: resolvedTags } = await getNotesByTags(tagNames);

      if (notes.length === 0) {
        const tagStr = resolvedTags.map(t => '#' + t).join(' ');
        return { success: false, message: `No notes found with tags: ${tagStr}` };
      }

      const tagStr = resolvedTags.map(t => '#' + t).join(' ');
      console.log(`[list notes] Found ${notes.length} notes with tags: ${tagStr}`);

      return {
        success: true,
        output: {
          data: notes,
          mimeType: 'application/json',
          title: `Notes: ${tagStr} (${notes.length})`
        }
      };
    }
  }
];

export default {
  commands
};
