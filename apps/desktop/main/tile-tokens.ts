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
  /**
   * Electron `WebContents.id` of the renderer that owns this token.
   *
   * Set post-hoc — tokens are minted BEFORE the BrowserWindow is
   * constructed (the token is injected via `additionalArguments`), so
   * the owning wc id is not known at mint time. Callers that have the
   * window in hand (`createTileBrowserWindow`, `registerTrustedBuiltinWindow`,
   * the `window-open` special-case branches) call `setTokenOwner()`
   * right after `new BrowserWindow()`.
   *
   * For renderers where eager binding isn't possible (e.g. `<webview>`
   * guests — `will-attach-webview` doesn't hand back a guest wc id),
   * the sender-frame cross-check falls back to trust-on-first-use:
   * the first `tile:*` IPC frame seen for a token with no recorded
   * owner binds `event.sender.id` atomically; all subsequent frames
   * must match.
   *
   * `undefined` = not yet bound.
   */
  ownerWebContentsId?: number;
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
 * Bind a token to its owning WebContents id.
 *
 * Should be called once, immediately after the BrowserWindow (or webview
 * guest WebContents) for the token is constructed, by the same code that
 * minted the token. Safe to call a second time with the same id
 * (idempotent). Calling with a different id after the first binding is
 * treated as a drift condition — the caller is re-binding a token that
 * belongs to a different frame; we keep the original owner and log.
 *
 * Returns:
 *   - `'bound'`    — owner was unset; now bound to `webContentsId`.
 *   - `'already'`  — owner was already this id; no change.
 *   - `'conflict'` — owner was a different id; original preserved.
 *   - `'unknown'`  — no token record exists (caller passed a bad token).
 */
export function setTokenOwner(
  token: string,
  webContentsId: number,
): 'bound' | 'already' | 'conflict' | 'unknown' {
  const record = tokenStore.get(token);
  if (!record) return 'unknown';
  if (record.ownerWebContentsId === undefined) {
    record.ownerWebContentsId = webContentsId;
    return 'bound';
  }
  if (record.ownerWebContentsId === webContentsId) return 'already';
  return 'conflict';
}

/**
 * Get the owning WebContents id for a token.
 * Returns `undefined` if the token doesn't exist OR if the owner hasn't
 * been bound yet (trust-on-first-use path — see `setTokenOwner` docs).
 */
export function getTokenOwner(token: string): number | undefined {
  return tokenStore.get(token)?.ownerWebContentsId;
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
