/**
 * Edit command - opens notes in the editor
 *
 * Usage:
 *   cmd:edit {search} - search for notes and open in editor
 *   - Shows matching notes in dropdown
 *   - On selection: opens editor with note content
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
 * Format note for dropdown display
 * @param {Object} note - Note item
 * @returns {Object} Formatted for dropdown
 */
const formatNoteForDropdown = (note) => {
  const content = note.content || '';
  // First line as title, rest as preview
  const lines = content.split('\n');
  const title = lines[0].replace(/^#+ /, '').trim() || 'Untitled';
  const preview = lines.slice(1).join(' ').trim().substring(0, 100);

  return {
    id: note.id,
    title: title.substring(0, 50) + (title.length > 50 ? '...' : ''),
    description: preview + (preview.length === 100 ? '...' : ''),
    content: content
  };
};

// Commands
const commands = [
  {
    name: 'edit',
    description: 'Edit a note',
    // Accept search text, produce selection
    accepts: ['text'],
    produces: ['item'],

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

      // If exactly one match and query is specific, open directly
      if (notes.length === 1 && query.trim()) {
        const note = notes[0];
        api.publish('editor:open', { itemId: note.id }, api.scopes.GLOBAL);
        return {
          success: true,
          message: 'Opening note',
          data: note
        };
      }

      // Return dropdown items for selection
      const dropdownItems = notes.map(formatNoteForDropdown);

      return {
        success: true,
        dropdown: {
          items: dropdownItems,
          placeholder: 'Select a note to edit',
          onSelect: (selected) => {
            // This is called when user selects from dropdown
            api.publish('editor:open', { itemId: selected.id }, api.scopes.GLOBAL);
            return { success: true, message: 'Opening note' };
          }
        }
      };
    }
  }
];

export default {
  commands
};
