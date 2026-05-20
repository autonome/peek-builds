/**
 * Tile Datastore Scope — pure enforcement helper (no Electron deps)
 *
 * Every `tile:datastore:*` IPC handler calls `validateTileDatastoreRequest`
 * before touching the real datastore module. The helper enforces:
 *
 *   1. Token must resolve to a grant (via tile-tokens)
 *   2. Grant must include the `datastore` capability
 *   3. Every table in the operation's required list must be in the grant
 *   4. Unknown tables (not in the core allow-list) are rejected
 *
 * Extracted into its own module so it can be unit-tested without loading
 * Electron's ipcMain.
 */

import { getGrantForToken } from './tile-tokens.js';
import { isValidTable } from './datastore.js';
import type { CapabilityGrant, TileCapabilities } from './tile-manifest.js';

/**
 * Check if a capability is granted
 */
export function hasCapability(
  grant: CapabilityGrant,
  capability: keyof TileCapabilities
): boolean {
  return grant.capabilities[capability] !== undefined && grant.capabilities[capability] !== false;
}

/**
 * Check if a datastore table is in the grant
 */
export function hasDatastoreTable(grant: CapabilityGrant, table: string): boolean {
  if (!grant.capabilities.datastore) return false;
  return grant.capabilities.datastore.tables.includes(table);
}

/**
 * Check that every table in the list is granted. Returns the first missing
 * table (for a precise error message), or null if all are granted.
 */
export function missingDatastoreTable(
  grant: CapabilityGrant,
  tables: string[]
): string | null {
  for (const t of tables) {
    if (!hasDatastoreTable(grant, t)) return t;
  }
  return null;
}

/**
 * Validate a datastore request: token valid, capability granted, all required
 * tables in the allowlist. Returns { grant } on success or { error } on failure.
 */
export function validateTileDatastoreRequest(
  token: string | undefined,
  requiredTables: string[]
): { grant: CapabilityGrant } | { error: string } {
  if (!token || typeof token !== 'string') {
    return { error: 'Invalid token' };
  }
  const grant = getGrantForToken(token);
  if (!grant) {
    return { error: 'Invalid token' };
  }
  // Trusted-builtin core renderers bypass the table allowlist AND the
  // datastore capability gate. They still have to pass the core table
  // name validity check below (`isValidTable`) — that guards against
  // SQL-injection-shaped inputs and is not a capability decision.
  if (grant.trustedBuiltin) {
    for (const table of requiredTables) {
      if (!isValidTable(table)) {
        return { error: `Invalid table: ${table}` };
      }
    }
    return { grant };
  }
  if (!hasCapability(grant, 'datastore')) {
    return { error: 'Datastore capability not granted' };
  }
  // Validate each table name against the core allow-list AND against the grant.
  for (const table of requiredTables) {
    if (!isValidTable(table)) {
      return { error: `Invalid table: ${table}` };
    }
  }
  const missing = missingDatastoreTable(grant, requiredTables);
  if (missing !== null) {
    return { error: `Table not allowed: ${missing}` };
  }
  return { grant };
}
