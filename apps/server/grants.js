const crypto = require("crypto");
const users = require("./users");
const { hashApiKey, generateApiKey } = users;

// ==================== MCP Grant Management ====================
//
// mcp_grants(id, user_id, label, key_hash, scope_tag, readonly, profile_id,
//            created_at, last_seen_at, revoked_at)
//
// Lives in the same system.db as users/devices/profiles (see users.js
// getSystemDb) but is its own table with its own credential namespace: a
// grant key and a device key never resolve against the same table, so one
// credential can never serve both the sync routes and /mcp/*. That is the
// whole point — a device is unscoped by nature, and letting a phone's sync
// key double as an MCP key would make every install a whole-store MCP key.
//
// scope_tag = '' means unscoped (whole-store), matching today's process-local
// SCOPE = '' behavior. readonly is stored as 0/1 and surfaced as a boolean.
// revoked_at NULL = active; non-NULL = revoked (the /mcp/* middleware rejects it).

let grantsTableReady = false;

function getDb() {
  const db = users.getSystemDb();
  if (!grantsTableReady) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_grants (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        label TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        scope_tag TEXT NOT NULL,
        readonly INTEGER NOT NULL,
        profile_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT,
        revoked_at TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_grants_hash ON mcp_grants(key_hash);
      CREATE INDEX IF NOT EXISTS idx_mcp_grants_user ON mcp_grants(user_id);
    `);
    grantsTableReady = true;
  }
  return db;
}

/**
 * Mint a new MCP grant for a user.
 * The raw API key is returned ONCE and never stored (only its hash).
 *
 * scopeTag may be '' (unscoped, whole-store — see design doc §4.4); every
 * other value scopes reads/writes on /mcp/* to that tag, enforced server-side
 * by the middleware and the route handlers, never by the client.
 *
 * @param {string} userId - The owning user
 * @param {string} label - Human-readable grant label (e.g. "nightly triage agent")
 * @param {string} scopeTag - Tag the grant is confined to, or '' for unscoped
 * @param {boolean} readonly - When true, mutating /mcp/* routes are refused
 * @param {string} profileId - Profile the grant reads/writes
 * @returns {{ grantId: string, userId: string, label: string, scopeTag: string, readonly: boolean, profileId: string, apiKey: string }}
 */
function createGrant(userId, label, scopeTag, readonly, profileId) {
  const db = getDb();

  const user = db.get("SELECT id FROM users WHERE id = ?", [userId]);
  if (!user) {
    throw new Error(`User '${userId}' does not exist`);
  }
  if (!label || !String(label).trim()) {
    throw new Error("Grant label is required");
  }
  if (typeof scopeTag !== "string") {
    throw new Error("scopeTag is required (use '' for an unscoped grant)");
  }
  if (!profileId || !String(profileId).trim()) {
    throw new Error("profileId is required");
  }

  const grantId = crypto.randomUUID();
  const apiKey = generateApiKey();
  const keyHash = hashApiKey(apiKey);
  const timestamp = new Date().toISOString();
  const readonlyFlag = readonly ? 1 : 0;

  db.run(
    "INSERT INTO mcp_grants (id, user_id, label, key_hash, scope_tag, readonly, profile_id, created_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)",
    [grantId, userId, String(label).trim(), keyHash, scopeTag, readonlyFlag, String(profileId).trim(), timestamp]
  );

  return {
    grantId,
    userId,
    label: String(label).trim(),
    scopeTag,
    readonly: !!readonlyFlag,
    profileId: String(profileId).trim(),
    apiKey,
  };
}

/**
 * Resolve an api key to its grant + owning user.
 *
 * Returns:
 *   { userId, grantId, label, scopeTag, readonly, profileId } — active grant
 *   { revoked: true }                                         — matches a REVOKED grant (reject)
 *   null                                                      — no match (reject)
 *
 * On a successful active-grant match, last_seen_at is bumped (cheap audit),
 * same as resolveDevice.
 *
 * @param {string} apiKey
 * @returns {object|null}
 */
function resolveMcpGrant(apiKey) {
  if (!apiKey) return null;

  const db = getDb();
  const keyHash = hashApiKey(apiKey);

  const grant = db.get(
    "SELECT id, user_id, label, scope_tag, readonly, profile_id, revoked_at FROM mcp_grants WHERE key_hash = ?",
    [keyHash]
  );
  if (!grant) return null;

  if (grant.revoked_at) {
    return { revoked: true };
  }

  db.run("UPDATE mcp_grants SET last_seen_at = ? WHERE id = ?", [
    new Date().toISOString(),
    grant.id,
  ]);

  return {
    userId: grant.user_id,
    grantId: grant.id,
    label: grant.label,
    scopeTag: grant.scope_tag,
    readonly: !!grant.readonly,
    profileId: grant.profile_id,
  };
}

/**
 * List a user's grants (no key material). Includes revoked grants so an
 * admin can see history.
 *
 * @param {string} userId
 * @returns {Array<{id,label,scopeTag,readonly,profileId,created_at,last_seen_at,revoked_at}>}
 */
function listGrants(userId) {
  const db = getDb();
  const rows = db.all(
    "SELECT id, label, scope_tag, readonly, profile_id, created_at, last_seen_at, revoked_at FROM mcp_grants WHERE user_id = ? ORDER BY created_at",
    [userId]
  );
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    scopeTag: row.scope_tag,
    readonly: !!row.readonly,
    profileId: row.profile_id,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    revoked_at: row.revoked_at,
  }));
}

/**
 * Revoke a grant by id (verifies ownership). Idempotent — re-revoking keeps
 * the original revoked_at. Returns true if a grant was newly revoked.
 *
 * @param {string} userId
 * @param {string} grantId
 * @returns {boolean}
 */
function revokeGrant(userId, grantId) {
  const db = getDb();
  const grant = db.get(
    "SELECT id, revoked_at FROM mcp_grants WHERE id = ? AND user_id = ?",
    [grantId, userId]
  );
  if (!grant) {
    throw new Error(`Grant '${grantId}' not found for user '${userId}'`);
  }
  if (grant.revoked_at) {
    return false;
  }
  db.run("UPDATE mcp_grants SET revoked_at = ? WHERE id = ?", [
    new Date().toISOString(),
    grantId,
  ]);
  return true;
}

module.exports = {
  createGrant,
  resolveMcpGrant,
  listGrants,
  revokeGrant,
};
