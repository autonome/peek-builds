const { sqlFactory } = require("./sql");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const DATA_DIR = process.env.DATA_DIR || "./data";
const SYSTEM_DB_PATH = path.join(DATA_DIR, "system.db");

let systemDb = null;

function getSystemDb() {
  if (!systemDb) {
    // Ensure data directory exists
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    systemDb = sqlFactory.open(SYSTEM_DB_PATH);
    sqlFactory.init(systemDb);

    // Initialize users table
    systemDb.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        api_key_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_users_hash ON users(api_key_hash);
    `);

    // Initialize profiles table
    systemDb.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        UNIQUE(user_id, slug),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_profiles_user ON profiles(user_id);
    `);

    // Initialize devices table.
    //
    // Each device/install gets its OWN api key (hashed), bound to a user but
    // individually revocable. This replaces the single shared api_key model
    // (one key baked into every instance, no per-instance identity, no
    // individual revocation) that caused the 2026-06-24 rogue-sync incident.
    // The legacy shared key is migrated in as a device row labeled
    // "legacy-shared" (see migrateLegacyKeysToDevices) so existing installs
    // keep working until each device is re-enrolled with its own minted key.
    //
    // revoked_at NULL = active; non-NULL = revoked (auth rejects it).
    systemDb.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        label TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_seen_at TEXT,
        revoked_at TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_devices_hash ON devices(key_hash);
      CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
    `);

    // Initialize enrolment_codes table.
    //
    // A short-lived, single-use code an account holder mints on a device
    // that is already signed in, which a brand-new device trades for its own
    // device key (see createEnrolmentCode/exchangeEnrolmentCode below). The
    // code is hashed the same way a device key is — only its hash is ever
    // stored, so a leaked database row does not itself grant enrolment.
    //
    // used_at NULL = still redeemable; non-NULL = already spent (reject).
    systemDb.exec(`
      CREATE TABLE IF NOT EXISTS enrolment_codes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        code_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_enrolment_codes_hash ON enrolment_codes(code_hash);
    `);
  }
  return systemDb;
}

function hashApiKey(apiKey) {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

function generateApiKey() {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Create a new user and return their API key.
 * The raw API key is only returned once - it's not stored.
 */
function createUser(userId) {
  const db = getSystemDb();

  // Check if user already exists
  const existing = db.get("SELECT id FROM users WHERE id = ?", [userId]);
  if (existing) {
    throw new Error(`User '${userId}' already exists`);
  }

  const apiKey = generateApiKey();
  const apiKeyHash = hashApiKey(apiKey);
  const timestamp = new Date().toISOString();

  db.run(
    "INSERT INTO users (id, api_key_hash, created_at) VALUES (?, ?, ?)",
    [userId, apiKeyHash, timestamp]
  );

  // Return the raw key - this is the only time it's available
  return { userId, apiKey };
}

/**
 * Create a user with an existing API key (for migration).
 * Use this to migrate existing users without changing their key.
 */
function createUserWithKey(userId, existingKey) {
  const db = getSystemDb();

  const existingUser = db.get("SELECT id FROM users WHERE id = ?", [userId]);
  if (existingUser) {
    throw new Error(`User '${userId}' already exists`);
  }

  const apiKeyHash = hashApiKey(existingKey);
  const timestamp = new Date().toISOString();

  db.run(
    "INSERT INTO users (id, api_key_hash, created_at) VALUES (?, ?, ?)",
    [userId, apiKeyHash, timestamp]
  );

  return { userId };
}

/**
 * Look up user ID from API key.
 * Returns null if not found.
 */
function getUserIdFromApiKey(apiKey) {
  if (!apiKey) return null;

  const db = getSystemDb();
  const apiKeyHash = hashApiKey(apiKey);

  const row = db.get("SELECT id FROM users WHERE api_key_hash = ?", [apiKeyHash]);
  return row ? row.id : null;
}

/**
 * Delete a user by ID.
 */
function deleteUser(userId) {
  const db = getSystemDb();
  db.run("DELETE FROM users WHERE id = ?", [userId]);
}

/**
 * List all user IDs (not their keys).
 */
function listUsers() {
  const db = getSystemDb();
  return db.all("SELECT id, created_at FROM users ORDER BY created_at");
}

/**
 * Whether a user id names a real, registered user. restore.js checks this
 * before joining userId unsanitized into a filesystem path (getUserBackupDir,
 * db.getProfileDir) — the same shape of check createUser()/regenerateApiKey()
 * already do inline, pulled out here so a caller that only needs the
 * yes/no doesn't have to duplicate the query.
 */
function userExists(userId) {
  const db = getSystemDb();
  return !!db.get("SELECT id FROM users WHERE id = ?", [userId]);
}

/**
 * Regenerate API key for existing user.
 * Returns new API key (only time it's available).
 */
function regenerateApiKey(userId) {
  const db = getSystemDb();

  const existing = db.get("SELECT id FROM users WHERE id = ?", [userId]);
  if (!existing) {
    throw new Error(`User '${userId}' does not exist`);
  }

  const apiKey = generateApiKey();
  const apiKeyHash = hashApiKey(apiKey);

  db.run("UPDATE users SET api_key_hash = ? WHERE id = ?", [apiKeyHash, userId]);

  return { userId, apiKey };
}

/**
 * Close system database connection.
 */
function closeSystemDb() {
  if (systemDb) {
    systemDb.close();
    systemDb = null;
  }
}

// ==================== Device Management ====================
//
// Per-device credentials. Each device/install authenticates with its own
// minted key (hashed) bound to a user, and can be revoked individually without
// affecting other devices. Auth resolves through resolveDevice (see auth.js).

/**
 * Mint a new device credential for a user.
 * The raw API key is returned ONCE and never stored (only its hash).
 *
 * @param {string} userId - The owning user
 * @param {string} label - Human-readable device label (e.g. "iPhone 15", "MacBook")
 * @returns {{ deviceId: string, userId: string, label: string, apiKey: string }}
 */
function createDevice(userId, label) {
  const db = getSystemDb();

  const user = db.get("SELECT id FROM users WHERE id = ?", [userId]);
  if (!user) {
    throw new Error(`User '${userId}' does not exist`);
  }
  if (!label || !String(label).trim()) {
    throw new Error("Device label is required");
  }

  const deviceId = crypto.randomUUID();
  const apiKey = generateApiKey();
  const keyHash = hashApiKey(apiKey);
  const timestamp = new Date().toISOString();

  db.run(
    "INSERT INTO devices (id, user_id, label, key_hash, created_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL, NULL)",
    [deviceId, userId, String(label).trim(), keyHash, timestamp]
  );

  return { deviceId, userId, label: String(label).trim(), apiKey };
}

/**
 * Register a device with a caller-supplied existing key (used to migrate the
 * legacy shared api_key into the devices table). Idempotent on key_hash:
 * if a device already owns this hash, it is returned unchanged.
 *
 * @param {string} userId
 * @param {string} label
 * @param {string} existingKey - The raw api key to bind (its hash is stored)
 * @returns {{ deviceId: string, userId: string, label: string }}
 */
function createDeviceWithKey(userId, label, existingKey) {
  const db = getSystemDb();

  const user = db.get("SELECT id FROM users WHERE id = ?", [userId]);
  if (!user) {
    throw new Error(`User '${userId}' does not exist`);
  }

  const keyHash = hashApiKey(existingKey);
  const existing = db.get("SELECT id, user_id, label FROM devices WHERE key_hash = ?", [keyHash]);
  if (existing) {
    return { deviceId: existing.id, userId: existing.user_id, label: existing.label };
  }

  const deviceId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  db.run(
    "INSERT INTO devices (id, user_id, label, key_hash, created_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL, NULL)",
    [deviceId, userId, label, keyHash, timestamp]
  );

  return { deviceId, userId, label };
}

/**
 * Resolve an api key to its device + owning user.
 *
 * Returns:
 *   { userId, deviceId, label }            — active device credential
 *   { revoked: true }                      — key matches a REVOKED device (reject)
 *   { userId, deviceId: null, legacy: true } — key matches only the legacy
 *                                              users.api_key_hash (pre-migration safety net)
 *   null                                   — no match (reject)
 *
 * On a successful active-device match, last_seen_at is bumped (cheap audit).
 *
 * @param {string} apiKey
 * @returns {object|null}
 */
function resolveDevice(apiKey) {
  if (!apiKey) return null;

  const db = getSystemDb();
  const keyHash = hashApiKey(apiKey);

  const device = db.get(
    "SELECT id, user_id, label, revoked_at FROM devices WHERE key_hash = ?",
    [keyHash]
  );
  if (device) {
    if (device.revoked_at) {
      return { revoked: true };
    }
    // Bump last_seen_at for audit/visibility ("which devices are active").
    db.run("UPDATE devices SET last_seen_at = ? WHERE id = ?", [
      new Date().toISOString(),
      device.id,
    ]);
    return { userId: device.user_id, deviceId: device.id, label: device.label };
  }

  // Pre-migration safety net: key may still live only in the users table
  // (migrateLegacyKeysToDevices not yet run, or single-user bootstrap). Accept
  // it but without a device identity.
  const userId = getUserIdFromApiKey(apiKey);
  if (userId) {
    return { userId, deviceId: null, legacy: true };
  }

  return null;
}

/**
 * List a user's devices (no key material). Includes revoked devices so an
 * admin can see history.
 *
 * @param {string} userId
 * @returns {Array<{id,label,created_at,last_seen_at,revoked_at}>}
 */
function listDevices(userId) {
  const db = getSystemDb();
  return db.all(
    "SELECT id, label, created_at, last_seen_at, revoked_at FROM devices WHERE user_id = ? ORDER BY created_at",
    [userId]
  );
}

/**
 * Revoke a device by id (verifies ownership). Idempotent — re-revoking keeps
 * the original revoked_at. Returns true if a device was newly revoked.
 *
 * @param {string} userId
 * @param {string} deviceId
 * @returns {boolean}
 */
function revokeDevice(userId, deviceId) {
  const db = getSystemDb();
  const device = db.get(
    "SELECT id, revoked_at FROM devices WHERE id = ? AND user_id = ?",
    [deviceId, userId]
  );
  if (!device) {
    throw new Error(`Device '${deviceId}' not found for user '${userId}'`);
  }
  if (device.revoked_at) {
    return false;
  }
  db.run("UPDATE devices SET revoked_at = ? WHERE id = ?", [
    new Date().toISOString(),
    deviceId,
  ]);
  return true;
}

/**
 * Rename a device by id (verifies ownership). Returns the updated device row
 * (no key material).
 *
 * @param {string} userId
 * @param {string} deviceId
 * @param {string} label
 * @returns {{id: string, label: string, created_at: string, last_seen_at: string|null, revoked_at: string|null}}
 */
function renameDevice(userId, deviceId, label) {
  const db = getSystemDb();
  if (!label || !String(label).trim()) {
    throw new Error("Device label is required");
  }
  const device = db.get(
    "SELECT id FROM devices WHERE id = ? AND user_id = ?",
    [deviceId, userId]
  );
  if (!device) {
    throw new Error(`Device '${deviceId}' not found for user '${userId}'`);
  }
  db.run("UPDATE devices SET label = ? WHERE id = ?", [String(label).trim(), deviceId]);
  return db.get(
    "SELECT id, label, created_at, last_seen_at, revoked_at FROM devices WHERE id = ?",
    [deviceId]
  );
}

// ==================== Enrolment Codes ====================
//
// How a new device gets its own key without pasting one: an already-signed-in
// device asks for a code (createEnrolmentCode), the account holder hands it to
// the new device, and the new device trades it for its own device key
// (exchangeEnrolmentCode). The code is never itself a key — a new device never
// receives another device's key, only a freshly minted one of its own.

// No ambiguous glyphs (0/O, 1/I/L) — this code gets read off one screen and
// typed into another.
const ENROLMENT_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const ENROLMENT_CODE_LENGTH = 8;
const ENROLMENT_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function generateEnrolmentCode() {
  let code = "";
  for (let i = 0; i < ENROLMENT_CODE_LENGTH; i++) {
    code += ENROLMENT_CODE_ALPHABET[crypto.randomInt(ENROLMENT_CODE_ALPHABET.length)];
  }
  return code;
}

function normalizeEnrolmentCode(code) {
  return String(code).trim().toUpperCase();
}

// In-memory sliding-window attempt counter, one bucket per key. Backs both
// enrolment limiters below. State lives only in this process and resets on
// restart — fine, since an enrolment code only lives for minutes anyway.
//
// Every distinct key gets its own bucket and nothing else ever deletes one,
// so without a sweep the map grows for the life of the process. The sweep
// runs at most once per window (not on every attempt — a full-map walk per
// request is wasted work when nothing has aged out yet) and drops a bucket
// entirely once its window has emptied, rather than leaving a stale empty
// array in the map forever. No timer: this file has no background scheduler.
function createAttemptWindow(windowMs, maxAttempts) {
  const attemptsByKey = new Map();
  let lastPruneAt = 0;

  function prune(now) {
    for (const [key, attempts] of attemptsByKey) {
      const live = attempts.filter((t) => now - t < windowMs);
      if (live.length === 0) {
        attemptsByKey.delete(key);
      } else if (live.length !== attempts.length) {
        attemptsByKey.set(key, live);
      }
    }
    lastPruneAt = now;
  }

  return {
    /** Record one attempt for `key`; true if it exceeded the cap. */
    limited(key) {
      const now = Date.now();
      if (now - lastPruneAt >= windowMs) {
        prune(now);
      }
      const attempts = (attemptsByKey.get(key) || []).filter((t) => now - t < windowMs);
      if (attempts.length >= maxAttempts) {
        attemptsByKey.set(key, attempts);
        return true;
      }
      attempts.push(now);
      attemptsByKey.set(key, attempts);
      return false;
    },
  };
}

// exchangeEnrolmentCode is the one route in this module reachable without a
// key (a brand-new device has none yet to prove it), which makes it the one
// guessable by brute force despite the code's short expiry. This window caps
// how many exchanges can be spent guessing, independent of which code is
// tried. Keyed by requester IP (rather than one shared counter) so a single
// caller flooding the endpoint with garbage codes can only pin their own
// bucket, not 429 every other caller sharing the server.
const ENROLMENT_EXCHANGE_WINDOW_MS = 60 * 1000;
const ENROLMENT_EXCHANGE_MAX_ATTEMPTS = 10;
const enrolmentExchangeAttempts = createAttemptWindow(
  ENROLMENT_EXCHANGE_WINDOW_MS,
  ENROLMENT_EXCHANGE_MAX_ATTEMPTS
);

// Minting is authenticated, so this is not a guessing guard — it stops one
// account (or one stuck client) from turning "Create code" into an unbounded
// write loop. Each mint also replaces the account's previous unused code
// (see createEnrolmentCode), so a legitimate person never needs more than a
// few per minute.
const ENROLMENT_MINT_WINDOW_MS = 60 * 1000;
const ENROLMENT_MINT_MAX_ATTEMPTS = 10;
const enrolmentMintAttempts = createAttemptWindow(
  ENROLMENT_MINT_WINDOW_MS,
  ENROLMENT_MINT_MAX_ATTEMPTS
);

function tooManyAttemptsError(message) {
  const err = new Error(message);
  err.status = 429;
  return err;
}

// Enrolment codes are short-lived and single-use, so a spent or expired row
// has no further purpose — nothing ever reads one again. Rows would
// otherwise accumulate forever since nothing else deletes them. Swept
// opportunistically (on every mint and every exchange — both rare, and the
// table never holds more than a handful of rows) rather than on a timer,
// since there's no background scheduler in this process.
function pruneEnrolmentCodes(db) {
  db.run("DELETE FROM enrolment_codes WHERE used_at IS NOT NULL OR expires_at < ?", [
    new Date().toISOString(),
  ]);
}

/**
 * Create an enrolment code for a user (the account holder, from a device
 * that is already signed in). The raw code is returned ONCE and never
 * stored (only its hash) — matches the device/grant key pattern.
 *
 * An account has at most one redeemable code at a time: minting replaces
 * any unused one, since the person only ever sees the newest code and an
 * older one they can no longer read off a screen should not stay live.
 * Rate-limited per account (throws with `status: 429` over the cap).
 *
 * @param {string} userId
 * @returns {{ code: string, expiresAt: string }}
 */
function createEnrolmentCode(userId) {
  if (enrolmentMintAttempts.limited(userId)) {
    throw tooManyAttemptsError("Too many enrolment codes requested, try again shortly");
  }

  const db = getSystemDb();

  const user = db.get("SELECT id FROM users WHERE id = ?", [userId]);
  if (!user) {
    throw new Error(`User '${userId}' does not exist`);
  }

  pruneEnrolmentCodes(db);
  db.run("DELETE FROM enrolment_codes WHERE user_id = ? AND used_at IS NULL", [userId]);

  const code = generateEnrolmentCode();
  const codeHash = hashApiKey(code);
  const id = crypto.randomUUID();
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + ENROLMENT_CODE_TTL_MS).toISOString();

  db.run(
    "INSERT INTO enrolment_codes (id, user_id, code_hash, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, NULL)",
    [id, userId, codeHash, createdAt, expiresAt]
  );

  return { code, expiresAt };
}

/**
 * Exchange a valid enrolment code for a brand-new device key. Unauthenticated
 * by design — the caller has no key yet, only the code. Refuses an unknown,
 * already-used, or expired code, and is rate-limited against guessing (see
 * enrolmentExchangeRateLimited above).
 *
 * @param {string} code
 * @param {string} [label] - Label for the new device; defaults if omitted
 * @param {string|null} [requesterIp] - Caller's IP, for the per-caller rate
 *   limit. Null when the caller's address cannot be determined (see
 *   index.js requesterIp) — then no limit applies, because the only other
 *   option is one bucket shared by every caller, where a single flood (or
 *   ten honest typos) locks every other device out of enrolling.
 * @returns {{ deviceId: string, userId: string, label: string, apiKey: string }}
 */
function exchangeEnrolmentCode(code, label, requesterIp) {
  if (requesterIp && enrolmentExchangeAttempts.limited(requesterIp)) {
    throw tooManyAttemptsError("Too many enrolment attempts, try again shortly");
  }
  if (!code || !String(code).trim()) {
    throw new Error("Enrolment code is required");
  }

  const db = getSystemDb();
  const codeHash = hashApiKey(normalizeEnrolmentCode(code));
  const row = db.get(
    "SELECT id, user_id, expires_at, used_at FROM enrolment_codes WHERE code_hash = ?",
    [codeHash]
  );
  if (!row) {
    throw new Error("Invalid enrolment code");
  }
  if (row.used_at) {
    throw new Error("Enrolment code already used");
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new Error("Enrolment code expired");
  }

  const deviceLabel = label && String(label).trim() ? String(label).trim() : "New device";
  // Mint the device before burning the code: if createDevice() throws (e.g.
  // the owning user row was deleted), the code must stay usable for a retry
  // rather than being permanently spent with no device to show for it.
  const device = createDevice(row.user_id, deviceLabel);

  db.run("UPDATE enrolment_codes SET used_at = ? WHERE id = ?", [
    new Date().toISOString(),
    row.id,
  ]);
  pruneEnrolmentCodes(db);

  return device;
}

/**
 * Migrate each user's legacy shared api_key (users.api_key_hash) into the
 * devices table as a "legacy-shared" device, so the existing key keeps
 * authenticating AND becomes individually revocable once every real device has
 * been re-enrolled with its own minted key. Idempotent — skips hashes already
 * present in devices. Safe to call on every boot.
 */
function migrateLegacyKeysToDevices() {
  const db = getSystemDb();
  const allUsers = db.all("SELECT id, api_key_hash, created_at FROM users");
  let migrated = 0;

  for (const user of allUsers) {
    const existing = db.get(
      "SELECT id FROM devices WHERE key_hash = ?",
      [user.api_key_hash]
    );
    if (existing) continue;

    const deviceId = crypto.randomUUID();
    db.run(
      "INSERT INTO devices (id, user_id, label, key_hash, created_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL, NULL)",
      [deviceId, user.id, "legacy-shared", user.api_key_hash, user.created_at || new Date().toISOString()]
    );
    migrated++;
    console.log(`[devices] Migrated legacy key for user '${user.id}' into device ${deviceId} (legacy-shared)`);
  }

  if (migrated > 0) {
    console.log(`[devices] Legacy-key migration complete: ${migrated} device(s) created`);
  }
}

// ==================== Profile Management ====================

/**
 * Create a new profile for a user.
 * @param {string} userId - The user ID
 * @param {string} name - User-visible profile name (e.g., "Work", "Personal")
 * @returns {object} Profile object with id, userId, slug, name
 */
function createProfile(userId, name) {
  const db = getSystemDb();

  // Check if user exists
  const user = db.get("SELECT id FROM users WHERE id = ?", [userId]);
  if (!user) {
    throw new Error(`User '${userId}' does not exist`);
  }

  // Derive slug from name for backward compat (stored in DB but not used for folders)
  const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

  // Check if profile already exists
  const existing = db.get(
    "SELECT id FROM profiles WHERE user_id = ? AND slug = ?",
    [userId, slug]
  );
  if (existing) {
    throw new Error(`Profile '${slug}' already exists for user '${userId}'`);
  }

  const profileId = crypto.randomUUID();
  const timestamp = new Date().toISOString();

  db.run(
    "INSERT INTO profiles (id, user_id, slug, name, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)",
    [profileId, userId, slug, name, timestamp, timestamp]
  );

  return { id: profileId, userId, slug, name, created_at: timestamp, last_used_at: timestamp };
}

/**
 * Create a profile using a caller-supplied UUID as the primary key.
 *
 * Unlike createProfile (which mints a fresh crypto.randomUUID()), this inserts
 * the profiles row with the PASSED-IN `id`. Used by resolveProfileId so that an
 * unknown-but-valid profile UUID gets its OWN isolated bucket instead of
 * silently collapsing onto the "default" profile (the cross-profile data-leak
 * bug this replaces).
 *
 * Idempotent: if a profile with `id` already exists for the user, it is
 * returned unchanged. The slug is derived to be unique (suffixed with a short
 * slice of the id) so it never collides with an existing profile's slug and
 * trips the UNIQUE(user_id, slug) constraint.
 *
 * @param {string} userId - The user ID
 * @param {string} id - The profile UUID to use as the primary key
 * @param {string} name - User-visible profile name
 * @returns {object} Profile object with id, userId, slug, name
 */
function createProfileWithId(userId, id, name) {
  const db = getSystemDb();

  // Check if user exists
  const user = db.get("SELECT id FROM users WHERE id = ?", [userId]);
  if (!user) {
    throw new Error(`User '${userId}' does not exist`);
  }

  // Idempotent: if this exact profile id already exists, return it.
  const existingById = getProfileById(userId, id);
  if (existingById) {
    return existingById;
  }

  // Derive a base slug from the name, then guarantee uniqueness by appending a
  // short slice of the id. This avoids tripping UNIQUE(user_id, slug) when an
  // unrelated profile already owns the name-derived slug (e.g. two "Imported"
  // profiles from different unknown UUIDs).
  const baseSlug = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  const idSuffix = id.replace(/-/g, "").slice(0, 8);
  let slug = baseSlug ? `${baseSlug}-${idSuffix}` : idSuffix;

  // Extremely defensive: if even the suffixed slug somehow exists for a
  // different profile id, widen the suffix until unique.
  let attempt = 8;
  while (
    db.get("SELECT id FROM profiles WHERE user_id = ? AND slug = ?", [userId, slug]) &&
    attempt < 32
  ) {
    attempt += 4;
    const wider = id.replace(/-/g, "").slice(0, attempt);
    slug = baseSlug ? `${baseSlug}-${wider}` : wider;
  }

  const timestamp = new Date().toISOString();

  db.run(
    "INSERT INTO profiles (id, user_id, slug, name, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)",
    [id, userId, slug, name, timestamp, timestamp]
  );

  return { id, userId, slug, name, created_at: timestamp, last_used_at: timestamp };
}

/**
 * List all profiles for a user.
 * @param {string} userId - The user ID
 * @returns {Array} Array of profile objects
 */
function listProfiles(userId) {
  const db = getSystemDb();
  return db.all(
    "SELECT id, user_id, slug, name, created_at, last_used_at FROM profiles WHERE user_id = ? ORDER BY last_used_at DESC",
    [userId]
  );
}

/**
 * Get a specific profile by user ID and slug.
 * @param {string} userId - The user ID
 * @param {string} slug - Profile slug
 * @returns {object|null} Profile object or null if not found
 */
function getProfile(userId, slug) {
  const db = getSystemDb();
  return db.get(
    "SELECT id, user_id, slug, name, created_at, last_used_at FROM profiles WHERE user_id = ? AND slug = ?",
    [userId, slug]
  );
}

/**
 * Update last_used_at timestamp for a profile.
 * @param {string} userId - The user ID
 * @param {string} slug - Profile slug
 */
function updateProfileLastUsed(userId, slug) {
  const db = getSystemDb();
  const timestamp = new Date().toISOString();
  db.run(
    "UPDATE profiles SET last_used_at = ? WHERE user_id = ? AND slug = ?",
    [timestamp, userId, slug]
  );
}

/**
 * Get a profile by its UUID.
 * @param {string} userId - The user ID
 * @param {string} profileId - Profile UUID
 * @returns {object|null} Profile object or null if not found
 */
function getProfileById(userId, profileId) {
  const db = getSystemDb();
  return db.get(
    "SELECT id, user_id, slug, name, created_at, last_used_at FROM profiles WHERE user_id = ? AND id = ?",
    [userId, profileId]
  );
}

/**
 * Resolve a profile identifier to a UUID for folder paths.
 * The UUID becomes the folder name on disk.
 *
 * Handles both UUIDs (new clients) and slugs (legacy backwards compatibility).
 *
 * @param {string} userId - The user ID
 * @param {string} profileIdentifier - Either a UUID or a legacy slug
 * @returns {string} The UUID to use for folder paths
 */
function resolveProfileId(userId, profileIdentifier) {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (uuidPattern.test(profileIdentifier)) {
    // Look up by UUID
    const profile = getProfileById(userId, profileIdentifier);
    if (profile) {
      return profile.id;
    }

    // UUID is well-formed but unknown to this server. DO NOT fall back to the
    // "default" profile — that silent fallback collapsed every unseen profile
    // onto a single bucket and caused cross-profile data contamination
    // (read/write leakage between distinct profiles). Instead, give this UUID
    // its OWN isolated bucket so its data stays separate.
    console.warn(
      `[profiles] UUID ${profileIdentifier} not registered for user ${userId}; ` +
        `creating an isolated profile for it. (This replaces the old silent ` +
        `fall-back-to-default behavior, which was a cross-profile data-leak bug.)`
    );
    const created = createProfileWithId(userId, profileIdentifier, "Imported");
    return created.id;
  }

  // Not a UUID - legacy slug (e.g. "default", "work")
  // Look up profile by slug, return its UUID
  const profile = getProfile(userId, profileIdentifier);
  if (profile) {
    return profile.id;
  }

  // Legacy slug "default" — preserve historical behavior: this is THE shared
  // default bucket, and asking for "default" is the only way to land in it.
  if (profileIdentifier === "default") {
    const newDefault = createProfile(userId, "Default");
    return newDefault.id;
  }

  // Unknown non-"default" legacy slug. DO NOT collapse onto default (same
  // data-leak as the UUID path). Create a distinct profile keyed on this slug
  // so the identifier gets its own isolated bucket. createProfile derives the
  // slug from the name; since the name IS the slug here, the resulting profile
  // is stably re-resolvable by the same slug on subsequent requests.
  const existingBySlug = getProfile(userId, profileIdentifier);
  if (existingBySlug) {
    return existingBySlug.id;
  }
  console.warn(
    `[profiles] Legacy slug '${profileIdentifier}' not registered for user ${userId}; ` +
      `creating an isolated profile for it. (This replaces the old silent ` +
      `fall-back-to-default behavior, which was a cross-profile data-leak bug.)`
  );
  const createdFromSlug = createProfile(userId, profileIdentifier);
  return createdFromSlug.id;
}

/**
 * Delete a profile by profile ID.
 * @param {string} userId - The user ID (for verification)
 * @param {string} profileId - The profile ID to delete
 */
function deleteProfile(userId, profileId) {
  const db = getSystemDb();

  // Verify profile belongs to user
  const profile = db.get(
    "SELECT id, slug FROM profiles WHERE id = ? AND user_id = ?",
    [profileId, userId]
  );

  if (!profile) {
    throw new Error(`Profile '${profileId}' not found for user '${userId}'`);
  }

  // Delete profile record
  db.run("DELETE FROM profiles WHERE id = ?", [profileId]);

  // Note: Profile data directory is NOT deleted here - data is preserved
  // Client should handle profile data cleanup if desired
}

/**
 * Migrate profile folders from slug-based to UUID-based naming.
 * For each user's profiles, renames DATA_DIR/{userId}/profiles/{slug} to
 * DATA_DIR/{userId}/profiles/{uuid}.
 *
 * Safe to call multiple times (idempotent).
 */
function migrateProfileFoldersToUuid() {
  if (!fs.existsSync(DATA_DIR)) {
    return;
  }

  const userDirs = fs.readdirSync(DATA_DIR, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory() && dirent.name !== 'system.db')
    .map(dirent => dirent.name);

  for (const userId of userDirs) {
    const profilesDir = path.join(DATA_DIR, userId, "profiles");
    if (!fs.existsSync(profilesDir)) {
      continue;
    }

    const db = getSystemDb();
    const profiles = db.all(
      "SELECT id, slug FROM profiles WHERE user_id = ?",
      [userId]
    );

    // Handle orphan "default" folder (exists but no profile record)
    const defaultFolder = path.join(profilesDir, "default");
    if (fs.existsSync(defaultFolder)) {
      const hasDefaultRecord = profiles.some(p => p.slug === "default");
      if (!hasDefaultRecord) {
        try {
          const newProfile = createProfile(userId, "Default");
          profiles.push({ id: newProfile.id, slug: "default" });
          console.log(`[migration] Created default profile record for user ${userId}`);
        } catch (e) {
          console.log(`[migration] Could not create default profile for ${userId}: ${e.message}`);
        }
      }
    }

    for (const profile of profiles) {
      const oldFolder = path.join(profilesDir, profile.slug);
      const newFolder = path.join(profilesDir, profile.id);

      if (fs.existsSync(oldFolder) && !fs.existsSync(newFolder)) {
        try {
          fs.renameSync(oldFolder, newFolder);
          console.log(`[migration] Renamed ${userId}/profiles/${profile.slug} → ${profile.id}`);
        } catch (e) {
          console.error(`[migration] Failed to rename ${userId}/profiles/${profile.slug}: ${e.message}`);
        }
      }
    }
  }
}

module.exports = {
  createUser,
  createUserWithKey,
  getUserIdFromApiKey,
  deleteUser,
  listUsers,
  userExists,
  regenerateApiKey,
  closeSystemDb,
  // Device management
  createDevice,
  createDeviceWithKey,
  resolveDevice,
  listDevices,
  revokeDevice,
  renameDevice,
  migrateLegacyKeysToDevices,
  createEnrolmentCode,
  exchangeEnrolmentCode,
  // Profile management
  createProfile,
  createProfileWithId,
  listProfiles,
  getProfile,
  getProfileById,
  resolveProfileId,
  updateProfileLastUsed,
  deleteProfile,
  migrateProfileFoldersToUuid,
  // Exposed for testing, and reused by grants.js for a matching key format
  hashApiKey,
  generateApiKey,
  getSystemDb,
};
