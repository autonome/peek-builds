/**
 * Notes noun — registers queryable "notes" noun commands via initializeSources
 *
 * Commands generated:
 *   - "notes"       (bare noun, lists notes)
 *   - "list notes"  (explicit list, supports tag filtering)
 *   - "new note"    (create a new note)
 *
 * These are direct commands (not pubsub nouns) because cmd/commands/ modules
 * run in the panel window which is transient. The noun pubsub system requires
 * persistent background windows (extensions).
 *
 * Replaces the notes/list notes commands from note.js. The "note" save command
 * in note.js is kept (it doesn't conflict).
 */
import api from 'peek://app/api.js';
import { queryItemsByType, extractTitle } from './item-query.js';

/**
 * Shared execute handler for notes queries
 */
async function executeNotesQuery(ctx) {
  const items = await queryItemsByType('text', { search: ctx.search, limit: 50 });

  return {
    success: true,
    output: {
      data: items.map(i => ({
        id: i.id,
        type: i.type,
        title: extractTitle(i),
        content: (i.content || '').substring(0, 200),
        createdAt: i.createdAt,
        updatedAt: i.updatedAt
      })),
      mimeType: 'application/json',
      title: `Notes (${items.length})`
    }
  };
}

/**
 * Create a new note — opens the editor for a new text item
 */
async function executeNewNote(ctx) {
  if (ctx.search) {
    // Save text content directly
    const result = await api.datastore.addItem('text', {
      content: ctx.search
    });

    if (!result.success) {
      return { success: false, error: result.error || 'Failed to create note' };
    }

    // Tag with 'note' and 'from:cmd'
    const itemId = result.data.id;
    for (const tagName of ['note', 'from:cmd']) {
      const tagResult = await api.datastore.getOrCreateTag(tagName);
      if (tagResult.success) {
        await api.datastore.tagItem(itemId, tagResult.data.tag.id);
      }
    }

    return {
      success: true,
      message: 'Note saved',
      output: {
        data: { id: itemId, type: 'text', content: ctx.search },
        mimeType: 'item',
        title: 'New note',
        isNew: true
      }
    };
  }

  // No content — signal to open empty editor
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

const commands = [
  {
    name: 'notes',
    description: 'Saved notes',
    accepts: [],
    produces: ['application/json'],
    execute: executeNotesQuery
  },
  {
    name: 'list notes',
    description: 'List saved notes',
    accepts: [],
    produces: ['application/json'],
    execute: executeNotesQuery
  },
  {
    name: 'new note',
    description: 'Create a new note',
    accepts: [],
    produces: ['application/json'],
    execute: executeNewNote
  }
];

export const initializeSources = async (addCommand, batchApi = {}) => {
  const addFn = batchApi.addCommandSilent || addCommand;
  for (const cmd of commands) {
    addFn(cmd);
  }
  if (batchApi.flushUpdates) {
    batchApi.flushUpdates();
  }
};

export default {
  commands: [],         // No static commands (registered dynamically via initializeSources)
  initializeSources
};
