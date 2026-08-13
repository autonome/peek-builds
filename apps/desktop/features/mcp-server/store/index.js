/**
 * PeekStore Factory
 *
 * Selects the store implementation from the environment, mirroring the
 * `SQL_ADAPTER` switch in `apps/server/sql/index.js`. Today there is exactly
 * one implementation — `sqlite-store.js` against a local `datastore.sqlite`.
 * An HTTP client against `apps/server` (`remote-store.js`) is a later step
 * (docs/mcp-remote-backend-design.md §2.1); this factory already knows the
 * env var that will select it, so `server.js` never has to change when it
 * lands.
 */

import { openSqliteStore } from './sqlite-store.js';

/**
 * @param {import('./types').StoreConfig} config
 * @returns {Promise<import('./types').PeekStore>}
 */
export async function openStore(config = {}) {
  const remoteUrl = (config.remoteUrl || '').trim();
  if (remoteUrl) {
    // remote-store.js does not exist yet — fail loudly rather than silently
    // falling back to a local file the caller didn't ask for.
    throw new Error(
      `PEEK_MCP_REMOTE_URL is set ("${remoteUrl}") but the remote store is not implemented yet. ` +
      `See docs/mcp-remote-backend-design.md.`
    );
  }
  return openSqliteStore(config);
}
