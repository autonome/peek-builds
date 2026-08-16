const { describe, it, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const { DatabaseSync } = require("node:sqlite");
const { readZipEntries } = require("./zip-read");

// Use test directory for all databases
const TEST_DATA_DIR = path.join(__dirname, "test-data-restore");
process.env.DATA_DIR = TEST_DATA_DIR;

const TEST_USER_ID = "restoretest";

function cleanTestDir() {
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true });
  }
}

cleanTestDir();

// Hand-builds a backup-shaped zip with caller-chosen entries, for the two
// tests (partial failure, traversal rejection) that need bytes createBackup()
// itself would never produce — a manifest that lies about a profile's health,
// or an entry name that tries to escape the archive. Same archiver call
// createBackup() makes (backup.js), so the resulting zip is read by the same
// code path a real backup would be.
function buildTestZip(destPath, manifest, fileEntries) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);
    for (const entry of fileEntries) {
      archive.append(entry.content, { name: entry.name });
    }
    archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });
    archive.finalize();
  });
}

// archiver normalizes an entry name on the way in before validateEntryName()
// (zip-read.js) ever sees it — "../../evil" becomes "evil", "/etc/evil"
// becomes "etc/evil", a backslash separator becomes a nested path, "C:/evil"
// loses its drive letter — so a zip built with buildTestZip() alone can never
// actually carry one of those names into the archive. This overwrites an
// already-written entry name with a same-length replacement directly in the
// finished file's bytes (both the local file header and the central
// directory copy carry the name in cleartext, with no checksum over it), so
// the specific escape attempt reaches readZipEntries() unnormalized.
function patchEntryName(zipPath, placeholderName, actualName) {
  if (placeholderName.length !== actualName.length) {
    throw new Error(
      `patchEntryName requires equal-length names: '${placeholderName}' (${placeholderName.length}) vs '${actualName}' (${actualName.length})`
    );
  }
  const buf = fs.readFileSync(zipPath);
  const oldBytes = Buffer.from(placeholderName, "utf8");
  const newBytes = Buffer.from(actualName, "utf8");
  let occurrences = 0;
  let idx = buf.indexOf(oldBytes);
  while (idx !== -1) {
    newBytes.copy(buf, idx);
    occurrences++;
    idx = buf.indexOf(oldBytes, idx + oldBytes.length);
  }
  // Every entry name is written twice: once in its local file header, once
  // in the central directory. Fewer than that means the placeholder didn't
  // land where expected and the patch silently did nothing.
  if (occurrences < 2) {
    throw new Error(`Expected to patch at least 2 occurrences of '${placeholderName}', found ${occurrences}`);
  }
  fs.writeFileSync(zipPath, buf);
}

// Flips bits in the first `numBytes` of an entry's compressed data — bit rot
// or a partial write, not a change to the zip container structure itself —
// so extractZipEntry()'s zlib.inflateRawSync() throws on a corrupt deflate
// stream, the failure mode B1 (restore.js restoreProfile()) exists to
// survive without touching the live database.
function corruptZipEntryData(zipPath, entryName, numBytes) {
  const { buf, entries } = readZipEntries(zipPath);
  const entry = entries.find((e) => e.name === entryName);
  if (!entry) {
    throw new Error(`No such entry to corrupt: ${entryName}`);
  }
  const off = entry.localHeaderOffset;
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  for (let i = 0; i < numBytes; i++) {
    buf[dataStart + i] ^= 0xff;
  }
  fs.writeFileSync(zipPath, buf);
}

describe("Restore Module Tests", () => {
  let db;
  let users;
  let backup;
  let restore;

  beforeEach(() => {
    for (const mod of ["./db", "./users", "./backup", "./restore"]) {
      delete require.cache[require.resolve(mod)];
    }
    cleanTestDir();
    db = require("./db");
    users = require("./users");
    backup = require("./backup");
    restore = require("./restore");
    // createProfileWithId (used to re-register a restored profile) requires
    // the owning user to already exist.
    users.createUser(TEST_USER_ID);
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

  // The round trip. Never trust the result object alone — open the restored
  // file directly and count rows, the same failure mode createBackup()'s own
  // round-trip test exists to catch.
  it("restores rows to their pre-mutation state, verified by opening the restored file directly", async () => {
    const PROFILE = "roundtrip-profile";
    db.saveUrl(TEST_USER_ID, "https://example.com/a", ["x"], null, PROFILE);
    db.saveUrl(TEST_USER_ID, "https://example.com/b", ["y"], null, PROFILE);
    const textId = db.saveText(TEST_USER_ID, "keep me", ["note"], null, PROFILE);

    const backupResult = await backup.createBackup(TEST_USER_ID);
    assert.strictEqual(backupResult.success, true);

    // Mutate live data after the backup: delete a row, add a different one.
    db.deleteItem(TEST_USER_ID, textId, PROFILE);
    db.saveUrl(TEST_USER_ID, "https://example.com/c", ["z"], null, PROFILE);

    const restoreResult = await restore.restoreBackup(TEST_USER_ID, backupResult.filename);
    assert.strictEqual(restoreResult.success, true);
    assert.strictEqual(restoreResult.restored[PROFILE].success, true);

    const restoredPath = path.join(db.getProfileDir(TEST_USER_ID, PROFILE), "datastore.sqlite");
    const rawDb = new DatabaseSync(restoredPath);
    const itemCount = rawDb.prepare(
      "SELECT COUNT(*) as count FROM items WHERE CAST(deletedAt AS INTEGER) = 0"
    ).get().count;
    const tagCount = rawDb.prepare("SELECT COUNT(*) as count FROM tags").get().count;
    const itemTagCount = rawDb.prepare("SELECT COUNT(*) as count FROM item_tags").get().count;
    rawDb.close();

    assert.strictEqual(itemCount, 3, "row count must match the pre-mutation state, not the mutated live state");
    assert.strictEqual(tagCount, 3);
    assert.strictEqual(itemTagCount, 3);
  });

  it("restores multiple profiles, each into its own directory", async () => {
    db.saveUrl(TEST_USER_ID, "https://example.com/1", [], null, "profile-a");
    db.saveUrl(TEST_USER_ID, "https://example.com/2", [], null, "profile-b");
    db.saveUrl(TEST_USER_ID, "https://example.com/3", [], null, "profile-b");

    const backupResult = await backup.createBackup(TEST_USER_ID);
    assert.strictEqual(backupResult.success, true);

    db.saveUrl(TEST_USER_ID, "https://example.com/extra", [], null, "profile-a");
    const bItems = db.getItems(TEST_USER_ID, "url", "profile-b");
    db.deleteItem(TEST_USER_ID, bItems[0].id, "profile-b");

    const result = await restore.restoreBackup(TEST_USER_ID, backupResult.filename);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.restored["profile-a"].actualCounts.urls, 1);
    assert.strictEqual(result.restored["profile-b"].actualCounts.urls, 2);
  });

  it("renames a hot WAL/SHM pair alongside the pre-restore copy, rather than deleting it", async () => {
    const PROFILE = "wal-profile";
    db.saveUrl(TEST_USER_ID, "https://example.com/wal-seed", [], null, PROFILE);

    const backupResult = await backup.createBackup(TEST_USER_ID);
    assert.strictEqual(backupResult.success, true);

    // Close db.js's own connection first, so the WAL below can't be an
    // incidental side effect of that close — restoreBackup() calls the exact
    // same closeConnection() as part of step 4, so this WAL has to survive
    // it to prove restore.js's own handling, not just a clean close, is what
    // moves it.
    db.closeConnection(TEST_USER_ID, PROFILE);

    const profileDir = db.getProfileDir(TEST_USER_ID, PROFILE);
    const datastorePath = path.join(profileDir, "datastore.sqlite");
    const rawConn = new DatabaseSync(datastorePath);
    rawConn.exec("PRAGMA journal_mode = WAL");
    const insert = rawConn.prepare(
      "INSERT INTO items (id, type, content, createdAt, updatedAt) VALUES (?, 'text', ?, ?, ?)"
    );
    for (let i = 0; i < 50; i++) {
      const now = Date.now();
      insert.run(`wal-row-${i}`, `content-${i}`, now, now);
    }

    const walPath = `${datastorePath}-wal`;
    const shmPath = `${datastorePath}-shm`;
    assert.ok(
      fs.existsSync(walPath) && fs.statSync(walPath).size > 0,
      "test setup should leave a non-empty WAL, not a clean checkpoint"
    );

    // rawConn is deliberately left open across the restore below — this is
    // what db.closeConnection() being a no-op for an unopened profile
    // connection (a server killed mid-flight, restarted, then restored
    // before the profile was ever reopened) actually looks like: a hot WAL
    // nothing in restoreBackup() owns or knows to checkpoint.
    const result = await restore.restoreBackup(TEST_USER_ID, backupResult.filename);
    assert.strictEqual(result.success, true);

    // Nothing stale sits beside the restored database.
    assert.ok(!fs.existsSync(walPath), "-wal should not sit beside the restored datastore.sqlite");
    assert.ok(!fs.existsSync(shmPath), "-shm should not sit beside the restored datastore.sqlite");

    // It moved, rather than being deleted: the pre-restore copy keeps its
    // own journal, the same suffix, so the three files stay a recoverable
    // set instead of the 50 committed-but-unarchived rows being lost outright.
    const preRestorePath = result.restored[PROFILE].preRestorePath;
    assert.ok(preRestorePath, "should record where the pre-restore copy went");
    assert.ok(fs.existsSync(`${preRestorePath}-wal`), "-wal should have moved with the pre-restore copy");
    assert.ok(fs.existsSync(`${preRestorePath}-shm`), "-shm should have moved with the pre-restore copy");

    rawConn.close();

    const preRestoreConn = new DatabaseSync(preRestorePath, { readOnly: true });
    const walRowCount = preRestoreConn.prepare(
      "SELECT COUNT(*) as count FROM items WHERE id LIKE 'wal-row-%'"
    ).get().count;
    preRestoreConn.close();
    assert.strictEqual(walRowCount, 50, "pre-restore copy, opened with its WAL still beside it, should still see the 50 committed rows");
  });

  it("preserves the previous datastore.sqlite with pre-restore counts, openable independently", async () => {
    const PROFILE = "prerestore-profile";
    db.saveUrl(TEST_USER_ID, "https://example.com/1", [], null, PROFILE);
    db.saveUrl(TEST_USER_ID, "https://example.com/2", [], null, PROFILE);

    const backupResult = await backup.createBackup(TEST_USER_ID);
    assert.strictEqual(backupResult.success, true);

    // Mutate AFTER the backup, so the live file (about to become the
    // pre-restore copy) holds a state the archive does not.
    db.saveUrl(TEST_USER_ID, "https://example.com/3", [], null, PROFILE);
    db.saveUrl(TEST_USER_ID, "https://example.com/4", [], null, PROFILE);

    const result = await restore.restoreBackup(TEST_USER_ID, backupResult.filename);
    assert.strictEqual(result.success, true);

    const preRestorePath = result.restored[PROFILE].preRestorePath;
    assert.ok(preRestorePath, "should record where the pre-restore copy went");
    assert.ok(fs.existsSync(preRestorePath));

    const rawDb = new DatabaseSync(preRestorePath);
    const count = rawDb.prepare(
      "SELECT COUNT(*) as count FROM items WHERE CAST(deletedAt AS INTEGER) = 0"
    ).get().count;
    rawDb.close();
    assert.strictEqual(count, 4, "pre-restore copy must hold the state right before the restore, not the archive's");
  });

  it("keeps only the newest pre-restore copies, deleting the rest", async () => {
    const PROFILE = "retention-profile";
    db.saveUrl(TEST_USER_ID, "https://example.com/retention", [], null, PROFILE);
    const backupResult = await backup.createBackup(TEST_USER_ID);
    assert.strictEqual(backupResult.success, true);

    const targetDir = db.getProfileDir(TEST_USER_ID, PROFILE);
    const runs = restore.PRE_RESTORE_RETENTION + 3;
    for (let i = 0; i < runs; i++) {
      const result = await restore.restoreBackup(TEST_USER_ID, backupResult.filename);
      assert.strictEqual(result.restored[PROFILE].success, true);
      // Pre-restore suffixes are timestamp-derived — force a fresh
      // millisecond between runs so consecutive copies don't collide and
      // silently overwrite each other under the same name.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const copies = fs.readdirSync(targetDir).filter(
      (f) => f.startsWith("datastore.sqlite.pre-restore-") && !f.endsWith("-wal") && !f.endsWith("-shm")
    );
    assert.strictEqual(
      copies.length,
      restore.PRE_RESTORE_RETENTION,
      `${runs} restores should still only keep ${restore.PRE_RESTORE_RETENTION} pre-restore copies on a fixed-size volume`
    );
  });

  it("a corrupt deflate stream leaves the live database exactly where it was", async () => {
    const PROFILE = "corrupt-extract-profile";
    db.saveUrl(TEST_USER_ID, "https://example.com/before-corruption", [], null, PROFILE);

    const backupResult = await backup.createBackup(TEST_USER_ID);
    assert.strictEqual(backupResult.success, true);

    // Flip 64 bytes inside the archived datastore entry's own deflate stream
    // (bit rot, a truncated upload) — this must make zlib.inflateRawSync()
    // throw while extracting to the temp file, before anything about the
    // live database is touched.
    corruptZipEntryData(backupResult.path, `profiles/${PROFILE}/datastore.sqlite`, 64);

    const liveDatastorePath = path.join(db.getProfileDir(TEST_USER_ID, PROFILE), "datastore.sqlite");

    const result = await restore.restoreBackup(TEST_USER_ID, backupResult.filename);
    assert.strictEqual(result.restored[PROFILE].success, false);
    assert.strictEqual(
      result.restored[PROFILE].preRestorePath,
      undefined,
      "extraction failed before any rename-aside happened, so there is nothing to point to"
    );

    // The live database must be exactly where it was — not renamed aside
    // with nothing put back in its place. (Step 4 closes the connection
    // before extraction even starts, which checkpoints the WAL into the main
    // file regardless of outcome, so the check that matters is the row
    // still being there, not the file's bytes staying frozen.)
    assert.ok(fs.existsSync(liveDatastorePath), "live datastore.sqlite must still exist after a failed extraction");

    const rawDb = new DatabaseSync(liveDatastorePath, { readOnly: true });
    const count = rawDb.prepare(
      "SELECT COUNT(*) as count FROM items WHERE CAST(deletedAt AS INTEGER) = 0"
    ).get().count;
    rawDb.close();
    assert.strictEqual(count, 1, "the original row must still be readable — nothing was ever overwritten");
  });

  it("fails loudly when no profile in the archive has a usable snapshot", async () => {
    const filename = `peek-backup-${TEST_USER_ID}-nothing-restorable.zip`;
    const userBackupDir = backup.getUserBackupDir(TEST_USER_ID);
    fs.mkdirSync(userBackupDir, { recursive: true });
    const archivePath = path.join(userBackupDir, filename);

    // The manifest's only profile never got a snapshot written, and the
    // archive holds no datastore.sqlite entries at all — exactly what an
    // archive whose backup step failed for every profile looks like.
    const manifest = {
      version: "2.0",
      timestamp: new Date().toISOString(),
      userId: TEST_USER_ID,
      backupType: "daily-snapshot",
      profiles: { "failed-profile": { success: false, error: "boom" } },
    };
    await buildTestZip(archivePath, manifest, []);

    const result = await restore.restoreBackup(TEST_USER_ID, filename);
    assert.strictEqual(result.success, false, "an archive with nothing restorable must not report success");
    assert.match(result.error, /usable snapshot/i);
    assert.deepStrictEqual(result.restored, {});

    const dryRunResult = await restore.restoreBackup(TEST_USER_ID, filename, { dryRun: true });
    assert.strictEqual(dryRunResult.success, false, "a dry run must fail the same way, not report an empty success");
    assert.match(dryRunResult.error, /usable snapshot/i);
  });

  it("merges images: an archive-only image is restored, an image added after backup survives", async () => {
    const PROFILE = "image-profile";
    const originalBytes = Buffer.from("archived-image-bytes");
    const itemId = db.saveImage(TEST_USER_ID, "photo.png", originalBytes, "image/png", [], PROFILE);
    const imagePath = db.getImagePath(TEST_USER_ID, itemId, PROFILE);

    const backupResult = await backup.createBackup(TEST_USER_ID);
    assert.strictEqual(backupResult.success, true);

    // Simulate the image blob being lost after the backup was taken.
    fs.unlinkSync(imagePath);
    assert.ok(!fs.existsSync(imagePath));

    // Simulate a new image saved after the backup — this must survive a merge.
    const imagesDir = path.join(db.getProfileDir(TEST_USER_ID, PROFILE), "images");
    const newImagePath = path.join(imagesDir, "added-after-backup.png");
    fs.writeFileSync(newImagePath, Buffer.from("added-after-backup-bytes"));

    const result = await restore.restoreBackup(TEST_USER_ID, backupResult.filename);
    assert.strictEqual(result.success, true);

    assert.ok(fs.existsSync(imagePath), "archived image should be restored");
    assert.ok(fs.readFileSync(imagePath).equals(originalBytes), "restored image bytes should round-trip");
    assert.ok(fs.existsSync(newImagePath), "image added after backup should survive the merge, not get wiped");
  });

  it("re-registers a profile the registry never learned about", async () => {
    const PROFILE = "unregistered-profile";
    db.saveUrl(TEST_USER_ID, "https://example.com", [], null, PROFILE);
    assert.strictEqual(
      users.getProfileById(TEST_USER_ID, PROFILE),
      null,
      "no registry row should exist yet — this profile was only ever a directory on disk"
    );

    const backupResult = await backup.createBackup(TEST_USER_ID);
    assert.strictEqual(backupResult.success, true);

    const result = await restore.restoreBackup(TEST_USER_ID, backupResult.filename);
    assert.strictEqual(result.success, true);

    const registered = users.getProfileById(TEST_USER_ID, PROFILE);
    assert.ok(registered, "restore should have re-created the registry row");
    assert.strictEqual(registered.id, PROFILE);
  });

  it("a corrupt snapshot for one profile does not block the other, but flips success to false overall", async () => {
    const filename = `peek-backup-${TEST_USER_ID}-partial-failure.zip`;
    const userBackupDir = backup.getUserBackupDir(TEST_USER_ID);
    fs.mkdirSync(userBackupDir, { recursive: true });
    const archivePath = path.join(userBackupDir, filename);

    // A real, valid snapshot for "good-profile" — same VACUUM INTO
    // createBackup() itself uses.
    const conn = db.getConnection(TEST_USER_ID, "good-profile");
    db.saveUrl(TEST_USER_ID, "https://example.com/good", [], null, "good-profile");
    const tempPath = path.join(TEST_DATA_DIR, "temp-good-profile.sqlite");
    conn.exec(`VACUUM INTO '${tempPath}'`);
    const goodBytes = fs.readFileSync(tempPath);
    fs.unlinkSync(tempPath);
    db.closeConnection(TEST_USER_ID, "good-profile");

    // corrupt-profile already has a live database with real rows — this is
    // what makes "the corrupt snapshot never touches the live database"
    // below a meaningful assertion rather than a check against nothing.
    db.saveUrl(TEST_USER_ID, "https://example.com/pre-existing", [], null, "corrupt-profile");
    db.closeConnection(TEST_USER_ID, "corrupt-profile");
    const corruptLiveDatastorePath = path.join(
      db.getProfileDir(TEST_USER_ID, "corrupt-profile"),
      "datastore.sqlite"
    );
    const corruptLiveBytesBefore = fs.readFileSync(corruptLiveDatastorePath);

    // The manifest says corrupt-profile succeeded — this is corruption the
    // manifest never anticipated (e.g. bit rot, a partial write), not the
    // same thing as a profile createBackup() already marked failed.
    const manifest = {
      version: "2.0",
      timestamp: new Date().toISOString(),
      userId: TEST_USER_ID,
      backupType: "daily-snapshot",
      profiles: {
        "good-profile": { success: true, tableCounts: { urls: 1 } },
        "corrupt-profile": { success: true, tableCounts: { urls: 1 } },
      },
    };

    await buildTestZip(archivePath, manifest, [
      { name: "profiles/good-profile/datastore.sqlite", content: goodBytes },
      { name: "profiles/corrupt-profile/datastore.sqlite", content: Buffer.from("not a real sqlite database") },
    ]);

    const result = await restore.restoreBackup(TEST_USER_ID, filename);

    assert.strictEqual(result.restored["good-profile"].success, true);
    assert.strictEqual(result.restored["corrupt-profile"].success, false);
    assert.ok(result.restored["corrupt-profile"].error);
    assert.strictEqual(result.success, false, "one failing profile must fail the whole restore result");

    // The corrupt profile's live database is untouched: the garbage bytes
    // decompress fine (they are valid deflate output, just not a valid
    // SQLite file), so the probe query in restoreProfile() is what catches
    // this before the live database is overwritten.
    assert.ok(
      fs.readFileSync(corruptLiveDatastorePath).equals(corruptLiveBytesBefore),
      "corrupt-profile's live database must be untouched, not replaced with garbage bytes"
    );
    const corruptRawDb = new DatabaseSync(corruptLiveDatastorePath, { readOnly: true });
    const corruptCount = corruptRawDb.prepare(
      "SELECT COUNT(*) as count FROM items WHERE CAST(deletedAt AS INTEGER) = 0"
    ).get().count;
    corruptRawDb.close();
    assert.strictEqual(corruptCount, 1, "corrupt-profile's original row must still be readable");

    // The good profile's pre-restore copy exists on disk.
    const goodPreRestorePath = result.restored["good-profile"].preRestorePath;
    assert.ok(goodPreRestorePath, "good-profile should have a recorded pre-restore copy");
    assert.ok(fs.existsSync(goodPreRestorePath), "good-profile's pre-restore copy should exist on disk");
  });

  it("rejects a crafted entry that tries a directory-traversal escape, and writes nothing", async () => {
    const filename = `peek-backup-${TEST_USER_ID}-traversal.zip`;
    const userBackupDir = backup.getUserBackupDir(TEST_USER_ID);
    fs.mkdirSync(userBackupDir, { recursive: true });
    const archivePath = path.join(userBackupDir, filename);
    const evilName = "../../../evil";
    const placeholder = "Q".repeat(evilName.length);

    const manifest = {
      version: "2.0",
      timestamp: new Date().toISOString(),
      userId: TEST_USER_ID,
      backupType: "daily-snapshot",
      profiles: { "good-profile": { success: true, tableCounts: {} } },
    };
    await buildTestZip(archivePath, manifest, [
      { name: "profiles/good-profile/datastore.sqlite", content: Buffer.from("irrelevant") },
      { name: placeholder, content: Buffer.from("pwned") },
    ]);
    patchEntryName(archivePath, placeholder, evilName);

    assert.throws(
      () => restore.restoreBackup(TEST_USER_ID, filename),
      /contains a '\.\.' path segment, refusing to extract/
    );

    const escapedPath = path.join(TEST_DATA_DIR, "..", "evil");
    assert.ok(!fs.existsSync(escapedPath), "nothing should be written outside the data dir");
    assert.ok(
      !fs.existsSync(db.getProfileDir(TEST_USER_ID, "good-profile")),
      "no profile directory should be created either — the whole archive is rejected before any extraction"
    );
  });

  it("rejects a crafted entry with an absolute path", async () => {
    const filename = `peek-backup-${TEST_USER_ID}-absolute.zip`;
    const userBackupDir = backup.getUserBackupDir(TEST_USER_ID);
    fs.mkdirSync(userBackupDir, { recursive: true });
    const archivePath = path.join(userBackupDir, filename);
    const evilName = "/etc/evil";
    const placeholder = "Q".repeat(evilName.length);

    const manifest = {
      version: "2.0",
      timestamp: new Date().toISOString(),
      userId: TEST_USER_ID,
      backupType: "daily-snapshot",
      profiles: { "good-profile": { success: true, tableCounts: {} } },
    };
    await buildTestZip(archivePath, manifest, [
      { name: "profiles/good-profile/datastore.sqlite", content: Buffer.from("irrelevant") },
      { name: placeholder, content: Buffer.from("pwned") },
    ]);
    patchEntryName(archivePath, placeholder, evilName);

    assert.throws(
      () => restore.restoreBackup(TEST_USER_ID, filename),
      /has an absolute path, refusing to extract/
    );
  });

  it("rejects a crafted entry with backslash path separators", async () => {
    const filename = `peek-backup-${TEST_USER_ID}-backslash.zip`;
    const userBackupDir = backup.getUserBackupDir(TEST_USER_ID);
    fs.mkdirSync(userBackupDir, { recursive: true });
    const archivePath = path.join(userBackupDir, filename);
    const evilName = "profiles\\good-profile\\evil.sqlite";
    const placeholder = "Q".repeat(evilName.length);

    const manifest = {
      version: "2.0",
      timestamp: new Date().toISOString(),
      userId: TEST_USER_ID,
      backupType: "daily-snapshot",
      profiles: { "good-profile": { success: true, tableCounts: {} } },
    };
    await buildTestZip(archivePath, manifest, [
      { name: "profiles/good-profile/datastore.sqlite", content: Buffer.from("irrelevant") },
      { name: placeholder, content: Buffer.from("pwned") },
    ]);
    patchEntryName(archivePath, placeholder, evilName);

    assert.throws(
      () => restore.restoreBackup(TEST_USER_ID, filename),
      /uses backslash path separators, refusing to extract/
    );
  });

  it("rejects a crafted entry with a Windows drive prefix", async () => {
    const filename = `peek-backup-${TEST_USER_ID}-drive-prefix.zip`;
    const userBackupDir = backup.getUserBackupDir(TEST_USER_ID);
    fs.mkdirSync(userBackupDir, { recursive: true });
    const archivePath = path.join(userBackupDir, filename);
    const evilName = "C:/evil";
    const placeholder = "Q".repeat(evilName.length);

    const manifest = {
      version: "2.0",
      timestamp: new Date().toISOString(),
      userId: TEST_USER_ID,
      backupType: "daily-snapshot",
      profiles: { "good-profile": { success: true, tableCounts: {} } },
    };
    await buildTestZip(archivePath, manifest, [
      { name: "profiles/good-profile/datastore.sqlite", content: Buffer.from("irrelevant") },
      { name: placeholder, content: Buffer.from("pwned") },
    ]);
    patchEntryName(archivePath, placeholder, evilName);

    assert.throws(
      () => restore.restoreBackup(TEST_USER_ID, filename),
      /has a Windows drive prefix, refusing to extract/
    );
  });

  it("rejects a crafted entry with a '.' path segment", async () => {
    const filename = `peek-backup-${TEST_USER_ID}-dot-segment.zip`;
    const userBackupDir = backup.getUserBackupDir(TEST_USER_ID);
    fs.mkdirSync(userBackupDir, { recursive: true });
    const archivePath = path.join(userBackupDir, filename);
    // A '.' segment would otherwise pass every other guard, get matched by
    // SNAPSHOT_PATTERN as profileId ".", and db.getProfileDir() would
    // normalize that segment away — landing the file at the profiles
    // directory itself instead of inside any profile.
    const evilName = "profiles/./datastore.sqlite";
    const placeholder = "Q".repeat(evilName.length);

    const manifest = {
      version: "2.0",
      timestamp: new Date().toISOString(),
      userId: TEST_USER_ID,
      backupType: "daily-snapshot",
      profiles: { ".": { success: true, tableCounts: {} } },
    };
    await buildTestZip(archivePath, manifest, [
      { name: placeholder, content: Buffer.from("pwned") },
    ]);
    patchEntryName(archivePath, placeholder, evilName);

    assert.throws(
      () => restore.restoreBackup(TEST_USER_ID, filename),
      /contains a '\.' path segment, refusing to extract/
    );

    const profilesParentDir = path.dirname(db.getProfileDir(TEST_USER_ID, "__scan__"));
    assert.ok(
      !fs.existsSync(path.join(profilesParentDir, "datastore.sqlite")),
      "nothing should land at the profiles directory itself"
    );
  });

  it("fails before touching anything when userId isn't a real user", async () => {
    // userId flows unsanitized into path.join() (getUserBackupDir,
    // db.getProfileDir) — "../x" would resolve outside the user tree if
    // this check didn't run first.
    const result = await restore.restoreBackup("../x", "peek-backup-x-y.zip");
    assert.strictEqual(result.success, false);
    assert.match(result.error, /unknown user/i);
  });

  it("fails on a manifest/user mismatch without force, and succeeds with it", async () => {
    const OWNER = "restore-owner";
    const OTHER = "restore-other";
    users.createUser(OWNER);
    users.createUser(OTHER);

    db.saveUrl(OWNER, "https://example.com", [], null, "default");
    const backupResult = await backup.createBackup(OWNER);
    assert.strictEqual(backupResult.success, true);

    // Simulate the archive having landed under a different user's backup
    // directory (e.g. manual disaster recovery onto a new account) — the
    // filename alone can't be parsed for the userId it belongs to.
    const otherDir = backup.getUserBackupDir(OTHER);
    fs.mkdirSync(otherDir, { recursive: true });
    fs.copyFileSync(backupResult.path, path.join(otherDir, backupResult.filename));

    const withoutForce = await restore.restoreBackup(OTHER, backupResult.filename);
    assert.strictEqual(withoutForce.success, false);
    assert.ok(/force/i.test(withoutForce.error));

    const withForce = await restore.restoreBackup(OTHER, backupResult.filename, { force: true });
    assert.strictEqual(withForce.success, true);
  });

  it("dry run reports profiles and expected counts, and touches nothing", async () => {
    const PROFILE = "dryrun-profile";
    db.saveUrl(TEST_USER_ID, "https://example.com", [], null, PROFILE);
    const backupResult = await backup.createBackup(TEST_USER_ID);
    assert.strictEqual(backupResult.success, true);

    const datastorePath = path.join(db.getProfileDir(TEST_USER_ID, PROFILE), "datastore.sqlite");
    const beforeBytes = fs.readFileSync(datastorePath);
    const beforeMtime = fs.statSync(datastorePath).mtimeMs;

    const result = await restore.restoreBackup(TEST_USER_ID, backupResult.filename, { dryRun: true });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.dryRun, true);
    assert.strictEqual(result.restored[PROFILE].expectedCounts.urls, 1);
    assert.strictEqual(result.restored[PROFILE].existingDatastore, true);

    const afterBytes = fs.readFileSync(datastorePath);
    const afterMtime = fs.statSync(datastorePath).mtimeMs;
    assert.ok(beforeBytes.equals(afterBytes), "dry run must not touch file contents");
    assert.strictEqual(afterMtime, beforeMtime, "dry run must not touch file mtimes");
  });
});

// Exercises the real production app (require("./index").app), the same
// convention test-backup.js's route suite uses, since a route is exactly the
// kind of thing a hand-rolled mirror could quietly drift away from.
describe("POST /admin/restore & GET /backups/:filename — real routes", () => {
  let app;
  let db;
  let users;
  let backupModule;
  const TEST_USER = "restorerouteuser";
  const ADMIN_TOKEN_VALUE = "test-admin-token-restore";
  let apiKey;

  beforeEach(() => {
    process.env.ADMIN_TOKEN = ADMIN_TOKEN_VALUE;
    for (const mod of ["./db", "./users", "./grants", "./mcp-items", "./backup", "./restore", "./auth", "./index"]) {
      delete require.cache[require.resolve(mod)];
    }
    cleanTestDir();

    db = require("./db");
    users = require("./users");
    backupModule = require("./backup");
    ({ app } = require("./index"));

    const result = users.createUser(TEST_USER);
    apiKey = result.apiKey;
  });

  after(() => {
    delete process.env.ADMIN_TOKEN;
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
  function adminHeaders() {
    return { Authorization: `Bearer ${ADMIN_TOKEN_VALUE}` };
  }

  it("POST /admin/restore works with the admin token", async () => {
    db.saveUrl(TEST_USER, "https://example.com", [], null, "default");
    const backupResult = await backupModule.createBackup(TEST_USER);
    assert.strictEqual(backupResult.success, true);

    const res = await app.request("/admin/restore", {
      method: "POST",
      headers: { ...adminHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ userId: TEST_USER, filename: backupResult.filename }),
    });
    const json = await res.json();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(json.success, true);
  });

  it("POST /admin/restore is unauthorized without the admin token", async () => {
    const res = await app.request("/admin/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: TEST_USER, filename: "peek-backup-x-y.zip" }),
    });
    assert.strictEqual(res.status, 401);
  });

  it("GET /backups/:filename returns the archive bytes for its owner", async () => {
    db.saveUrl(TEST_USER, "https://example.com", [], null, "default");
    const backupResult = await backupModule.createBackup(TEST_USER);
    assert.strictEqual(backupResult.success, true);

    const res = await app.request(`/backups/${backupResult.filename}`, { headers: authHeaders() });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("content-type"), "application/zip");
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.ok(bytes.length > 0);
  });

  it("GET /backups/:filename rejects a bad filename", async () => {
    const res = await app.request("/backups/not-a-real-backup.txt", { headers: authHeaders() });
    assert.strictEqual(res.status, 400);
  });
});

describe("POST /admin/restore — ADMIN_TOKEN unset", () => {
  let app;
  let db;
  let users;
  const TEST_USER = "restoreroutenotoken";

  beforeEach(() => {
    delete process.env.ADMIN_TOKEN;
    for (const mod of ["./db", "./users", "./grants", "./mcp-items", "./backup", "./restore", "./auth", "./index"]) {
      delete require.cache[require.resolve(mod)];
    }
    cleanTestDir();

    db = require("./db");
    users = require("./users");
    ({ app } = require("./index"));
    users.createUser(TEST_USER);
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

  it("returns 503 when ADMIN_TOKEN is not set", async () => {
    const res = await app.request("/admin/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: TEST_USER, filename: "peek-backup-x-y.zip" }),
    });
    assert.strictEqual(res.status, 503);
  });
});
