/**
 * Tile Token Management — Pure module (no Electron dependencies)
 *
 * Handles:
 * - Generating opaque capability tokens
 * - Validating tokens
 * - Revoking tokens
 * - Querying grants for tokens
 *
 * Extracted from tile-launcher.ts so it can be tested without Electron.
 */

import crypto from 'node:crypto';
import type { CapabilityGrant } from './tile-manifest.js';

// ─── Token Record ────────────────────────────────────────────────────

/**
 * Internal token data — stored in main process, never sent to renderer
 */
export interface TokenRecord {
  token: string;
  tileId: string;
  tileEntryId: string;
  grant: CapabilityGrant;
  createdAt: number;
}

/** Token store: token string -> record */
const tokenStore = new Map<string, TokenRecord>();

// ─── Token Generation ────────────────────────────────────────────────

/**
 * Generate an opaque capability token for a tile
 *
 * The token is a random string that maps to the grant record
 * stored in the main process. Tiles never see the grant directly.
 */
export function generateToken(
  tileId: string,
  tileEntryId: string,
  grant: CapabilityGrant
): string {
  const token = `tile-${crypto.randomBytes(24).toString('hex')}`;

  tokenStore.set(token, {
    token,
    tileId,
    tileEntryId,
    grant,
    createdAt: Date.now(),
  });

  return token;
}

/**
 * Validate a capability token and return the record
 * Returns null if token is invalid
 */
export function validateToken(token: string): TokenRecord | null {
  return tokenStore.get(token) || null;
}

/**
 * Revoke a token (e.g., when tile is unloaded)
 */
export function revokeToken(token: string): boolean {
  return tokenStore.delete(token);
}

/**
 * Get grant for a token (used by IPC enforcement)
 */
export function getGrantForToken(token: string): CapabilityGrant | null {
  const record = tokenStore.get(token);
  return record ? record.grant : null;
}

/**
 * Revoke all tokens for a tile
 */
export function revokeTokensForTile(tileId: string, tileEntryId?: string): void {
  for (const [token, record] of tokenStore) {
    if (record.tileId === tileId && (!tileEntryId || record.tileEntryId === tileEntryId)) {
      tokenStore.delete(token);
    }
  }
}

/**
 * Clear all tokens (for shutdown)
 */
export function clearAllTokens(): void {
  tokenStore.clear();
}
