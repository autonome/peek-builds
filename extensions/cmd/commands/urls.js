/**
 * URLs noun — registers queryable "urls" noun commands via initializeSources
 *
 * Commands generated:
 *   - "urls"       (bare noun, lists URLs)
 *   - "list urls"  (explicit list)
 *
 * These are direct commands (not pubsub nouns) because cmd/commands/ modules
 * run in the panel window which is transient. The noun pubsub system requires
 * persistent background windows (extensions).
 */
import { queryItemsByType, extractTitle } from './item-query.js';

/**
 * Shared execute handler for URL queries
 */
async function executeUrlQuery(ctx) {
  const items = await queryItemsByType('url', { search: ctx.search, limit: 50 });

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
      title: `URLs (${items.length})`
    }
  };
}

const commands = [
  {
    name: 'urls',
    description: 'Saved URLs',
    accepts: [],
    produces: ['application/json'],
    execute: executeUrlQuery
  },
  {
    name: 'list urls',
    description: 'List saved URLs',
    accepts: [],
    produces: ['application/json'],
    execute: executeUrlQuery
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
