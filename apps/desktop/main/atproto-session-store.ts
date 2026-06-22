/**
 * Main-process accessor for the persisted AT Protocol OAuth/DPoP session.
 *
 * The Lex renderer persists the active session — including the private
 * DPoP JWK (`dpopKeyPairJwk.privateKey.d`) — through `api.settings.set`,
 * which lands in main's SQLite `feature_settings` table scoped to the
 * `lex` feature (see features/lex/home.js `saveSession`, key `'session'`,
 * and the `tile:settings:set` handler in tile-ipc.ts).
 *
 * That means main can read the session it needs to DPoP-sign requests
 * WITHOUT any change to Lex's OAuth login/callback flow — the proxy reads
 * the session by reference here rather than receiving the private key
 * over IPC from a SOP-disabled renderer.
 *
 * This module is intentionally tiny and side-effect-free beyond the DB
 * read/write so it can be reasoned about (and the key access audited) in
 * isolation. It does NOT log token or key material.
 */

import { getDb } from './datastore.js';
import type { AtprotoSession } from './atproto-proxy.js';

/**
 * The feature id under which the Lex session is stored. Matches
 * `features/lex/manifest.json` `"id": "lex"` and the `grant.tileId`
 * used by the `tile:settings:*` handlers.
 */
export const LEX_FEATURE_ID = 'lex';

/** The `feature_settings` key Lex writes the session under. */
export const SESSION_SETTINGS_KEY = 'session';

/**
 * Read the persisted Lex session from `feature_settings`. Returns `null`
 * when no session is stored (logged out / never signed in) or the row is
 * malformed.
 *
 * @param featureId  feature whose session to read (default: `lex`). Kept
 *                   parameterised so a future non-Lex atproto consumer can
 *                   reuse the same store without a code change.
 */
export function readAtprotoSession(featureId: string = LEX_FEATURE_ID): AtprotoSession | null {
  try {
    const db = getDb();
    const row = db.prepare(
      'SELECT value FROM feature_settings WHERE featureId = ? AND key = ?'
    ).get(featureId, SESSION_SETTINGS_KEY) as { value: string } | undefined;
    if (!row) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      return null;
    }
    if (!isUsableSession(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Persist an updated session back to `feature_settings` (used after a
 * mid-request token refresh so the renderer's next call and the proxy
 * stay in sync). Mirrors the `tile:settings:set` write shape exactly:
 * id = `${featureId}_${key}`.
 */
export function writeAtprotoSession(session: AtprotoSession, featureId: string = LEX_FEATURE_ID): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    `${featureId}_${SESSION_SETTINGS_KEY}`,
    featureId,
    SESSION_SETTINGS_KEY,
    JSON.stringify(session),
    Date.now(),
  );
}

/**
 * Minimal structural validation — the proxy needs these fields to sign.
 * Exported for unit testing the gate without a DB.
 */
export function isUsableSession(value: unknown): value is AtprotoSession {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  if (typeof s.accessToken !== 'string' || s.accessToken.length === 0) return false;
  if (typeof s.pdsUrl !== 'string' || s.pdsUrl.length === 0) return false;
  if (typeof s.tokenEndpoint !== 'string' || s.tokenEndpoint.length === 0) return false;
  const kp = s.dpopKeyPairJwk as Record<string, unknown> | undefined;
  if (!kp || typeof kp !== 'object') return false;
  if (typeof kp.privateKey !== 'object' || kp.privateKey === null) return false;
  if (typeof kp.publicKey !== 'object' || kp.publicKey === null) return false;
  return true;
}
