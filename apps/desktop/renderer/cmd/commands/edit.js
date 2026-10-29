/**
 * Edit command - opens notes in the editor
 *
 * Uses the connector pattern:
 * - Returns { output: { data, mimeType: 'item' } } for selected notes
 * - Panel layer handles routing to editor based on mimeType
 *
 * Usage:
 *   cmd:edit - list recent notes (output selection mode), picking one opens it
 *   cmd:edit {text} - open the editor with text as its starting content
 *   cmd:edit #tag ... - open the tag query view
 *   - A note picked from the autocomplete dropdown opens directly
 */
import api from 'peek://app/api.js';
import { findTagByName } from '../item-suggestions.js';
import { parseTagQuery, intersectItems } from '../tag-query.js';
import { tagQueryRow } from '../tag-query-row.js';

/**
 * Search notes by content
 * @param {string} query - Search query
 * @param {number} limit - Max results
 * @returns {Promise<Array>} Matching notes
 */
const searchNotes = async (query, limit = 20) => {
  // Query all text items
  const result = await api.datastore.queryItems({ type: 'text' });

  if (!result.success) {
    console.error('[edit] Failed to query items:', result.error);
    return [];
  }

  const items = result.data || [];

  // If no query, return most recent items
  if (!query || !query.trim()) {
    return items.slice(0, limit);
  }

  // Filter by content match (case-insensitive)
  const queryLower = query.toLowerCase();
  const matches = items.filter(item => {
    const content = (item.content || '').toLowerCase();
    return content.includes(queryLower);
  });

  return matches.slice(0, limit);
};

/**
 * Get title from note content
 * @param {Object} note - Note item
 * @returns {string} Title extracted from first line
 */
const getNoteTitle = (note) => {
  const content = note.content || '';
  const lines = content.split('\n');
  const title = lines[0].replace(/^#+ /, '').trim() || 'Untitled';
  return title.substring(0, 50) + (title.length > 50 ? '...' : '');
};

// Commands
const commands = [
  {
    name: 'edit',
    description: 'Edit a note',
    // Accept search text, produce item (note object)
    accepts: ['text'],
    produces: ['item'],
    params: [{
      type: 'item',
      itemType: 'text',
      // `edit #todo`: a first row that runs the command with the typed text (the tag query view)
      extraRows: async (typedText, ctx) => {
        const row = await tagQueryRow({ type: 'item' }, typedText, ctx.datastore);
        return row ? [row] : [];
      },
    }],

    async execute(ctx) {
      // `edit #todo #today`: every argument is a #tag, so open the tag query view
      const queryTags = parseTagQuery(ctx.search || '');
      if (queryTags) {
        const tagsResult = await api.datastore.getTagsByFrecency();
        const allTags = tagsResult?.success ? (tagsResult.data || []) : [];
        const unknownTags = [];
        const itemLists = [];
        for (const name of queryTags) {
          const tag = findTagByName(allTags, name);
          if (!tag) {
            unknownTags.push(name);
            continue;
          }
          const itemsResult = await api.datastore.getItemsByTag(tag.id);
          itemLists.push(itemsResult?.success ? (itemsResult.data || []) : []);
        }
        // An unknown tag matches nothing, so the AND of the query is empty
        const items = unknownTags.length > 0 ? [] : intersectItems(itemLists);
        return {
          success: true,
          output: {
            data: { tags: queryTags, itemIds: items.map(item => item.id), unknownTags },
            mimeType: 'tag-query',
            title: `${items.length} items tagged ${queryTags.map(t => '#' + t).join(' ')}`
          }
        };
      }

      // If a specific item was selected from autocomplete, use it directly
      // (avoids re-searching by text which could match the wrong item)
      if (ctx.selectedItem) {
        const note = ctx.selectedItem;
        return {
          success: true,
          output: {
            data: note,
            mimeType: 'item',
            title: getNoteTitle(note)
          }
        };
      }

      const query = ctx.search || '';

      // `edit some text`: open the editor with the text as its starting content
      if (query.trim()) {
        return {
          success: true,
          message: 'Opening editor',
          output: {
            data: { type: 'text', content: query },
            mimeType: 'new-item',
            title: 'New note'
          }
        };
      }

      // Search for matching notes
      const notes = await searchNotes(query, 20);

      if (notes.length === 0) {
        return {
          success: false,
          message: query ? `No notes found matching "${query}"` : 'No notes found'
        };
      }

      // If exactly one match and query is specific, return it directly
      if (notes.length === 1 && query.trim()) {
        const note = notes[0];
        return {
          success: true,
          output: {
            data: note,
            mimeType: 'item',
            title: getNoteTitle(note)
          }
        };
      }

      // Return array of notes - panel will enter output selection mode
      // User picks one, then panel handles the 'item' mimeType routing
      return {
        success: true,
        output: {
          data: notes,
          mimeType: 'item',
          title: `${notes.length} notes found`
        }
      };
    }
  }
];

export default {
  commands
};
