const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// Use test directory for all databases
const TEST_DATA_DIR = path.join(__dirname, "test-data-backup");
process.env.DATA_DIR = TEST_DATA_DIR;

const TEST_USER_ID = "backuptest";

// Clean up test directory
function cleanTestDir() {
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true });
  }
}

cleanTestDir();

// --- Minimal ZIP reader, used only by these tests ---
//
// apps/server's own dependencies are just hono/archiver/@hono/node-server
// (see apps/server/CLAUDE.md — a fresh `npm install --prefix apps/server`
// pulls nothing else). Reaching for an unzip package would only resolve here
// because the workspace root happens to hoist one; a plain `npm install` in
// apps/server alone would not have it. Reading back the archiver-produced
// zip (store or deflate entries, no zip64) with only `fs`/`zlib` avoids that
// trap — and this is the test that must actually open what createBackup()
// wrote, per the production bug this whole suite exists to catch.
function readZipEntries(zipPath) {
  const buf = fs.readFileSync(zipPath);
  const EOCD_SIG = 0x06054b50;
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error(`Not a valid zip (no end-of-central-directory record): ${zipPath}`);
  }

  const entryCount = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  const entries = [];
  let offset = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`Bad central directory entry at offset ${offset} in ${zipPath}`);
    }
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString("utf8", offset + 46, offset + 46 + nameLen);
    entries.push({ name, method, compSize, localHeaderOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return { buf, entries };
}

function extractZipEntry(buf, entry) {
  const LOCAL_SIG = 0x04034b50;
  const off = entry.localHeaderOffset;
  if (buf.readUInt32LE(off) !== LOCAL_SIG) {
    throw new Error(`Bad local file header for ${entry.name}`);
  }
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  const compData = buf.subarray(dataStart, dataStart + entry.compSize);

  if (entry.method === 0) return Buffer.from(compData);
  if (entry.method === 8) return zlib.inflateRawSync(compData);
  throw new Error(`Unsupported zip compression method ${entry.method} for ${entry.name}`);
}

// Unzips an archiver-produced zip onto disk, mirroring what an operator doing
// a real restore would do (see docs/server-backup-and-deploy.md's by-hand
// procedure).
function unzipToDir(zipPath, destDir) {
  const { buf, entries } = readZipEntries(zipPath);
  for (const entry of entries) {
    if (entry.name.endsWith("/")) continue; // directory entry, nothing to write
    const outPath = path.join(destDir, entry.name);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, extractZipEntry(buf, entry));
  }
}

describe("Backup Module Tests", () => {
  let db;
  let users;
  let backup;

  beforeEach(() => {
    // Fresh modules for each test
    delete require.cache[require.resolve("./db")];
    delete require.cache[require.resolve("./users")];
    delete require.cache[require.resolve("./backup")];
    cleanTestDir();
    db = require("./db");
    users = require("./users");
    backup = require("./backup");
  });

  after(() => {
    if (db && db.closeAllConnections) {
      db.closeAllConnections();
    }
    if (users && users.closeSystemDb) {
      users.closeSystemDb();
    }
    cleanTestDir();
  });

  describe("createBackup", () => {
    it("should create a backup zip file for a user", async () => {
      // Create some test data
      db.saveUrl(TEST_USER_ID, "https://example.com", ["test"]);
      db.saveText(TEST_USER_ID, "Test note", ["note"]);

      const result = await backup.createBackup(TEST_USER_ID);

      assert.strictEqual(result.success, true);
      assert.ok(result.filename, "should have filename");
      assert.ok(result.path, "should have path");
      assert.ok(result.size > 0, "should have size");
      assert.ok(result.timestamp, "should have timestamp");
      // One archive per user, holding every profile's own counts — not a
      // single flat tableCounts (see manifest tests below for the full shape).
      assert.ok(result.profiles, "should have per-profile results");
      assert.ok(result.profiles.default, "the default profile should be backed up");

      // Verify file exists
      assert.ok(fs.existsSync(result.path), "backup file should exist");
    });

    it("should include table counts in result", async () => {
      db.saveUrl(TEST_USER_ID, "https://example1.com");
      db.saveUrl(TEST_USER_ID, "https://example2.com");
      db.saveText(TEST_USER_ID, "Note");

      const result = await backup.createBackup(TEST_USER_ID);

      assert.strictEqual(result.profiles.default.tableCounts.urls, 2);
      assert.strictEqual(result.profiles.default.tableCounts.texts, 1);
    });

    it("should return error for non-existent user database", async () => {
      const result = await backup.createBackup("nonexistent");

      assert.strictEqual(result.success, false);
      assert.ok(result.error, "should have error message");
    });

    it("should update lastBackupTime setting", async () => {
      db.saveUrl(TEST_USER_ID, "https://example.com");
      const beforeBackup = Date.now();

      await backup.createBackup(TEST_USER_ID);

      const lastBackupTime = backup.getLastBackupTime(TEST_USER_ID);
      assert.ok(lastBackupTime >= beforeBackup, "lastBackupTime should be set");
    });

    // The round trip. This is the test that would have caught the production
    // bug: a backup that "succeeds" while the archive it wrote holds nothing.
    it("round-trips row counts through the archive for a user with a populated profile and an empty one", async () => {
      const PROFILE_WITH_DATA = "profile-with-data";
      const PROFILE_EMPTY = "profile-empty";

      db.saveUrl(TEST_USER_ID, "https://example.com/a", ["x"], null, PROFILE_WITH_DATA);
      db.saveUrl(TEST_USER_ID, "https://example.com/b", ["y"], null, PROFILE_WITH_DATA);
      db.saveText(TEST_USER_ID, "hello", [], null, PROFILE_WITH_DATA);

      // Touch the empty profile so its directory + datastore.sqlite exist,
      // holding zero rows — this is the shape of the "default" stub on the
      // live volume.
      db.getConnection(TEST_USER_ID, PROFILE_EMPTY);

      const result = await backup.createBackup(TEST_USER_ID);
      assert.strictEqual(result.success, true);

      const extractDir = path.join(TEST_DATA_DIR, "extract-roundtrip");
      unzipToDir(result.path, extractDir);

      const manifest = JSON.parse(fs.readFileSync(path.join(extractDir, "manifest.json"), "utf-8"));
      assert.strictEqual(manifest.profiles[PROFILE_WITH_DATA].tableCounts.urls, 2);
      assert.strictEqual(manifest.profiles[PROFILE_WITH_DATA].tableCounts.texts, 1);
      assert.deepStrictEqual(manifest.profiles[PROFILE_EMPTY].tableCounts, { tags: 0 });

      const { DatabaseSync } = require("node:sqlite");

      const populatedDb = new DatabaseSync(
        path.join(extractDir, "profiles", PROFILE_WITH_DATA, "datastore.sqlite")
      );
      const populatedCount = populatedDb
        .prepare("SELECT COUNT(*) as count FROM items WHERE CAST(deletedAt AS INTEGER) = 0")
        .get().count;
      populatedDb.close();
      assert.strictEqual(populatedCount, 3, "row count in the snapshot must match the source");

      const emptyDb = new DatabaseSync(
        path.join(extractDir, "profiles", PROFILE_EMPTY, "datastore.sqlite")
      );
      const emptyCount = emptyDb.prepare("SELECT COUNT(*) as count FROM items").get().count;
      emptyDb.close();
      assert.strictEqual(emptyCount, 0);
    });

    // Pins VACUUM INTO in place against a later "simplification" to a plain
    // file copy, which would silently drop everything still sitting in the WAL.
    it("captures rows that are only in an un-checkpointed WAL", async () => {
      const PROFILE = "wal-profile";
      for (let i = 0; i < 5; i++) {
        db.saveUrl(TEST_USER_ID, `https://example.com/wal-${i}`, [], null, PROFILE);
      }

      const profileDir = db.getProfileDir(TEST_USER_ID, PROFILE);
      const walPath = path.join(profileDir, "datastore.sqlite-wal");
      assert.ok(
        fs.existsSync(walPath) && fs.statSync(walPath).size > 0,
        "test setup should leave writes sitting in the WAL, not checkpointed"
      );

      const result = await backup.createBackup(TEST_USER_ID);
      assert.strictEqual(result.success, true);

      const extractDir = path.join(TEST_DATA_DIR, "extract-wal");
      unzipToDir(result.path, extractDir);

      const { DatabaseSync } = require("node:sqlite");
      const snapshotDb = new DatabaseSync(path.join(extractDir, "profiles", PROFILE, "datastore.sqlite"));
      const count = snapshotDb.prepare("SELECT COUNT(*) as count FROM items").get().count;
      snapshotDb.close();
      assert.strictEqual(count, 5, "VACUUM INTO must fold the WAL in, or these rows are lost");
    });

    it("lists every profile in the manifest with its own row counts", async () => {
      db.saveUrl(TEST_USER_ID, "https://example.com/one", [], null, "profile-a");
      db.saveUrl(TEST_USER_ID, "https://example.com/two", [], null, "profile-b");
      db.saveUrl(TEST_USER_ID, "https://example.com/three", [], null, "profile-b");

      const result = await backup.createBackup(TEST_USER_ID);

      assert.strictEqual(result.profiles["profile-a"].tableCounts.urls, 1);
      assert.strictEqual(result.profiles["profile-b"].tableCounts.urls, 2);

      const extractDir = path.join(TEST_DATA_DIR, "extract-manifest");
      unzipToDir(result.path, extractDir);
      const manifest = JSON.parse(fs.readFileSync(path.join(extractDir, "manifest.json"), "utf-8"));
      assert.strictEqual(manifest.profiles["profile-a"].tableCounts.urls, 1);
      assert.strictEqual(manifest.profiles["profile-b"].tableCounts.urls, 2);
    });

    it("skips a profile directory with no database, without failing the run", async () => {
      db.saveUrl(TEST_USER_ID, "https://example.com", [], null, "real-profile");

      // A profile directory that exists but never got a datastore.sqlite
      // (e.g. mid-creation, or holding only stray files).
      const emptyDirProfile = db.getProfileDir(TEST_USER_ID, "no-database-here");
      fs.mkdirSync(emptyDirProfile, { recursive: true });

      const result = await backup.createBackup(TEST_USER_ID);

      assert.strictEqual(result.success, true);
      assert.ok(result.profiles["real-profile"]);
      assert.strictEqual(result.profiles["no-database-here"], undefined);
    });

    it("includes a profile's images/ directory in the archive", async () => {
      const PROFILE = "image-profile";
      const imageBuffer = Buffer.from("fake-png-bytes");
      const itemId = db.saveImage(TEST_USER_ID, "photo.png", imageBuffer, "image/png", [], PROFILE);
      const originalImagePath = db.getImagePath(TEST_USER_ID, itemId, PROFILE);

      const result = await backup.createBackup(TEST_USER_ID);
      assert.strictEqual(result.success, true);

      const extractDir = path.join(TEST_DATA_DIR, "extract-images");
      unzipToDir(result.path, extractDir);

      const archivedImagePath = path.join(
        extractDir, "profiles", PROFILE, "images", path.basename(originalImagePath)
      );
      assert.ok(fs.existsSync(archivedImagePath), "image should be present in the archive");
      assert.ok(fs.readFileSync(archivedImagePath).equals(imageBuffer), "image bytes should round-trip");
    });

    it("reports failure when a profile's database is not a valid sqlite file, without losing the profiles that succeeded", async () => {
      db.saveUrl(TEST_USER_ID, "https://example.com", [], null, "good-profile");

      const corruptProfileDir = db.getProfileDir(TEST_USER_ID, "corrupt-profile");
      fs.mkdirSync(corruptProfileDir, { recursive: true });
      fs.writeFileSync(path.join(corruptProfileDir, "datastore.sqlite"), "not a real sqlite database");

      const result = await backup.createBackup(TEST_USER_ID);

      assert.strictEqual(result.success, false, "one failing profile must fail the whole backup result");
      assert.strictEqual(result.profiles["good-profile"].success, true);
      assert.strictEqual(result.profiles["corrupt-profile"].success, false);
      assert.ok(result.profiles["corrupt-profile"].error, "should carry the failure reason");
    });
  });

  describe("listBackups", () => {
    it("should return empty array when no backups", () => {
      const backups = backup.listBackups(TEST_USER_ID);
      assert.deepStrictEqual(backups, []);
    });

    it("should list backups for a user", async () => {
      db.saveUrl(TEST_USER_ID, "https://example.com");
      await backup.createBackup(TEST_USER_ID);
      await backup.createBackup(TEST_USER_ID);

      const backups = backup.listBackups(TEST_USER_ID);

      assert.strictEqual(backups.length, 2);
      assert.ok(backups[0].filename, "should have filename");
      assert.ok(backups[0].size, "should have size");
      assert.ok(backups[0].createdAt, "should have createdAt");
    });

    it("should return backups sorted by date descending", async () => {
      db.saveUrl(TEST_USER_ID, "https://example.com");
      await backup.createBackup(TEST_USER_ID);
      // Small delay to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 10));
      await backup.createBackup(TEST_USER_ID);

      const backups = backup.listBackups(TEST_USER_ID);

      // First backup should be more recent
      const date1 = new Date(backups[0].createdAt);
      const date2 = new Date(backups[1].createdAt);
      assert.ok(date1 >= date2, "backups should be sorted newest first");
    });
  });

  describe("cleanOldBackups", () => {
    it("should keep only retention count of backups", async () => {
      db.saveUrl(TEST_USER_ID, "https://example.com");

      // Create more backups than retention
      for (let i = 0; i < 5; i++) {
        await backup.createBackup(TEST_USER_ID);
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      // Clean with retention of 2
      const result = await backup.cleanOldBackups(TEST_USER_ID, 2);

      assert.strictEqual(result.deleted, 3);

      const remaining = backup.listBackups(TEST_USER_ID);
      assert.strictEqual(remaining.length, 2);
    });

    it("should not delete anything when under retention", async () => {
      db.saveUrl(TEST_USER_ID, "https://example.com");
      await backup.createBackup(TEST_USER_ID);

      const result = await backup.cleanOldBackups(TEST_USER_ID, 7);

      assert.strictEqual(result.deleted, 0);
    });
  });

  describe("needsBackup", () => {
    it("should return true when no backup exists", () => {
      db.saveUrl(TEST_USER_ID, "https://example.com");
      assert.strictEqual(backup.needsBackup(TEST_USER_ID), true);
    });

    it("should return false immediately after backup", async () => {
      db.saveUrl(TEST_USER_ID, "https://example.com");
      await backup.createBackup(TEST_USER_ID);

      assert.strictEqual(backup.needsBackup(TEST_USER_ID), false);
    });
  });

  describe("getLastBackupTime / setLastBackupTime", () => {
    it("should return null when no backup time set", () => {
      db.saveUrl(TEST_USER_ID, "https://example.com");
      const time = backup.getLastBackupTime(TEST_USER_ID);
      assert.strictEqual(time, null);
    });

    it("should store and retrieve backup time", () => {
      db.saveUrl(TEST_USER_ID, "https://example.com");
      const now = Date.now();
      backup.setLastBackupTime(TEST_USER_ID, now);

      const retrieved = backup.getLastBackupTime(TEST_USER_ID);
      assert.strictEqual(retrieved, now);
    });
  });

  describe("createAllBackups", () => {
    it("should create backups for all users", async () => {
      // Create two users with data
      users.createUser("user1");
      users.createUser("user2");
      db.saveUrl("user1", "https://user1.com");
      db.saveUrl("user2", "https://user2.com");

      const results = await backup.createAllBackups();

      assert.strictEqual(results.length, 2);
      assert.ok(results.every(r => r.success), "all backups should succeed");
    });
  });

  describe("checkAndRunDailyBackups", () => {
    it("should run backups for users needing them", async () => {
      users.createUser("needsbackup");
      db.saveUrl("needsbackup", "https://example.com");

      const result = await backup.checkAndRunDailyBackups();

      assert.strictEqual(result.backupCount, 1);

      // Should have created a backup
      const backups = backup.listBackups("needsbackup");
      assert.strictEqual(backups.length, 1);
    });

    it("should skip users who do not need backup", async () => {
      users.createUser("recentbackup");
      db.saveUrl("recentbackup", "https://example.com");
      await backup.createBackup("recentbackup");

      const result = await backup.checkAndRunDailyBackups();

      assert.strictEqual(result.backupCount, 0);
    });
  });
});

describe("Backup API Tests", () => {
  let app;
  let db;
  let users;
  let backup;
  let TEST_API_KEY;
  const TEST_USER = "backupapitest";

  beforeEach(() => {
    delete require.cache[require.resolve("./db")];
    delete require.cache[require.resolve("./users")];
    delete require.cache[require.resolve("./backup")];
    cleanTestDir();

    db = require("./db");
    users = require("./users");
    backup = require("./backup");

    const result = users.createUser(TEST_USER);
    TEST_API_KEY = result.apiKey;

    const { Hono } = require("hono");
    app = new Hono();

    // Auth middleware
    app.use("*", async (c, next) => {
      if (c.req.path === "/") return next();
      const auth = c.req.header("Authorization");
      if (!auth || !auth.startsWith("Bearer ")) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      const apiKey = auth.slice(7);
      const userId = users.getUserIdFromApiKey(apiKey);
      if (!userId) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      c.set("userId", userId);
      return next();
    });

    // Backup endpoints
    app.get("/backups", (c) => {
      const userId = c.get("userId");
      const backups = backup.listBackups(userId);
      return c.json({ backups });
    });

    app.post("/backups", async (c) => {
      const userId = c.get("userId");
      const result = await backup.createBackup(userId);
      return c.json(result);
    });
  });

  after(() => {
    if (db && db.closeAllConnections) {
      db.closeAllConnections();
    }
    if (users && users.closeSystemDb) {
      users.closeSystemDb();
    }
    cleanTestDir();
  });

  function authHeaders() {
    return { Authorization: `Bearer ${TEST_API_KEY}` };
  }

  describe("GET /backups", () => {
    it("should return empty array when no backups", async () => {
      const res = await app.request("/backups", { headers: authHeaders() });
      const json = await res.json();

      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(json.backups, []);
    });

    it("should return list of backups", async () => {
      db.saveUrl(TEST_USER, "https://example.com");
      await backup.createBackup(TEST_USER);

      const res = await app.request("/backups", { headers: authHeaders() });
      const json = await res.json();

      assert.strictEqual(res.status, 200);
      assert.strictEqual(json.backups.length, 1);
      assert.ok(json.backups[0].filename);
    });

    it("should require auth", async () => {
      const res = await app.request("/backups");
      assert.strictEqual(res.status, 401);
    });
  });

  describe("POST /backups", () => {
    it("should create a backup", async () => {
      db.saveUrl(TEST_USER, "https://example.com");

      const res = await app.request("/backups", {
        method: "POST",
        headers: authHeaders(),
      });
      const json = await res.json();

      assert.strictEqual(res.status, 200);
      assert.strictEqual(json.success, true);
      assert.ok(json.filename);
      assert.ok(json.size);
    });

    it("should require auth", async () => {
      const res = await app.request("/backups", { method: "POST" });
      assert.strictEqual(res.status, 401);
    });
  });
});

// Exercises the real production app (`require("./index").app`, not the
// hand-rolled mirror above) — same convention as test.js's real-route suites
// — because a failure response is exactly the kind of behavior a copy of the
// route could quietly drift away from.
describe("POST /backups — real route (failure status)", () => {
  let app;
  let db;
  let users;
  const TEST_USER = "backuprealroute";
  let apiKey;

  beforeEach(() => {
    for (const mod of ["./db", "./users", "./grants", "./mcp-items", "./backup", "./auth", "./index"]) {
      delete require.cache[require.resolve(mod)];
    }
    cleanTestDir();

    db = require("./db");
    users = require("./users");
    ({ app } = require("./index"));

    const result = users.createUser(TEST_USER);
    apiKey = result.apiKey;
  });

  after(() => {
    if (db && db.closeAllConnections) {
      db.closeAllConnections();
    }
    if (users && users.closeSystemDb) {
      users.closeSystemDb();
    }
    cleanTestDir();
  });

  function authHeaders() {
    return { Authorization: `Bearer ${apiKey}` };
  }

  it("returns a non-2xx status when the backup result is a failure", async () => {
    // No profile directory exists at all for this user yet, so createBackup()
    // reports { success: false }.
    const res = await app.request("/backups", { method: "POST", headers: authHeaders() });
    const json = await res.json();

    assert.strictEqual(json.success, false);
    assert.ok(res.status < 200 || res.status >= 300, `expected a non-2xx status, got ${res.status}`);
  });

  it("returns a non-2xx status when a profile fails while others succeed", async () => {
    db.saveUrl(TEST_USER, "https://example.com", [], null, "good-profile");
    const corruptProfileDir = db.getProfileDir(TEST_USER, "corrupt-profile");
    fs.mkdirSync(corruptProfileDir, { recursive: true });
    fs.writeFileSync(path.join(corruptProfileDir, "datastore.sqlite"), "not a real sqlite database");

    const res = await app.request("/backups", { method: "POST", headers: authHeaders() });
    const json = await res.json();

    assert.strictEqual(json.success, false);
    assert.strictEqual(json.profiles["good-profile"].success, true);
    assert.ok(res.status < 200 || res.status >= 300, `expected a non-2xx status, got ${res.status}`);
  });
});
