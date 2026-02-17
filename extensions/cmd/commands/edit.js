/**
 * Edit command - opens notes in the editor
 *
 * Uses the connector pattern:
 * - Returns { output: { data, mimeType: 'item' } } for selected notes
 * - Panel layer handles routing to editor based on mimeType
 *
 * Usage:
 *   cmd:edit {search} - search for notes and open in editor
 *   - Shows matching notes in dropdown (via output selection mode)
 *   - On selection: panel auto-opens editor for 'item' mimeType
 */
import api from 'peek://app/api.js';

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
    params: [{ type: 'item', itemType: 'text' }],

    async execute(ctx) {
      const query = ctx.search || '';

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
