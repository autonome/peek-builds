/**
 * PeekStore Factory
 *
 * Selects the store implementation from the environment, mirroring the
 * `SQL_ADAPTER` switch in `apps/server/sql/index.js`: `sqlite-store.js`
 * against a local `datastore.sqlite` by default, or `remote-store.js` — an
 * HTTP client against `apps/server`'s `/mcp/*` API — when
 * `PEEK_MCP_REMOTE_URL` is set (docs/mcp-remote-backend-design.md §2.1).
 */

import { openSqliteStore } from './sqlite-store.js';
import { openRemoteStore } from './remote-store.js';

/**
 * @param {import('./types').StoreConfig} config
 * @returns {Promise<import('./types').PeekStore>}
 */
export async function openStore(config = {}) {
  const remoteUrl = (config.remoteUrl || '').trim();
  if (remoteUrl) {
    return openRemoteStore(config);
  }
  return openSqliteStore(config);
}
