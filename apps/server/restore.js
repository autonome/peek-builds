const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const db = require("./db");
const users = require("./users");
const backup = require("./backup");
const { readZipEntries, extractZipEntry } = require("./zip-read");

// Matches profiles/{profileId}/datastore.sqlite entries in the archive's
// central directory — the entry that decides which profiles are even
// candidates for restore, same role listProfileDirs() plays for a backup.
const SNAPSHOT_PATTERN = /^profiles\/([^/]+)\/datastore\.sqlite$/;
const IMAGE_PREFIX = (profileId) => `profiles/${profileId}/images/`;

// Each pre-restore copy is a full database, kept on the same fixed-size
// volume as everything else — unbounded, they would eventually fill it.
// Mirrors DEFAULT_RETENTION's role in backup.js: newest few kept, the rest
// deleted by cleanOldPreRestoreCopies() below.
const PRE_RESTORE_RETENTION = 5;

/**
 * Validate a backup filename the same way listBackups()'s directory filter
 * does — that filter is the existing traversal guard (no path separators can
 * reach it and still pass), so restore uses the identical check rather than
 * inventing a second one that could drift.
 */
function isValidBackupFilename(filename) {
  return (
    typeof filename === "string" &&
    filename.startsWith("peek-backup-") &&
    filename.endsWith(".zip") &&
    !filename.includes("/") &&
    !filename.includes("\\")
  );
}

function readManifest(buf, entries) {
  const manifestEntry = entries.find((e) => e.name === "manifest.json");
  if (!manifestEntry) {
    throw new Error("Archive has no manifest.json");
  }
  return JSON.parse(extractZipEntry(buf, manifestEntry).toString("utf-8"));
}

/**
 * Every profile the archive actually holds a snapshot for, keyed by
 * profileId, with the entries needed to extract its database and images.
 * Profiles the manifest marked success:false are skipped up front — their
 * snapshot was never written, so there is nothing to restore.
 */
function collectRestorableProfiles(manifest, entries) {
  const profiles = {};
  for (const entry of entries) {
    const match = entry.name.match(SNAPSHOT_PATTERN);
    if (!match) continue;
    const profileId = match[1];
    const manifestEntry = manifest.profiles && manifest.profiles[profileId];
    if (!manifestEntry || manifestEntry.success === false) continue;
    profiles[profileId] = {
      datastoreEntry: entry,
      imageEntries: entries.filter((e) => e.name.startsWith(IMAGE_PREFIX(profileId)) && !e.name.endsWith("/")),
      expectedCounts: manifestEntry.tableCounts || {},
    };
  }
  return profiles;
}

/**
 * Restore one user's backup archive: every profile snapshot present in the
 * zip is written back to its on-disk directory, the registry is re-created
 * for any profile the `profiles` table never learned about, and every
 * restored profile is reopened and counted so drift from schema migration on
 * reopen is visible rather than silently swallowed.
 *
 * @param {string} userId
 * @param {string} filename - bare filename, e.g. peek-backup-<userId>-<iso>.zip
 * @param {{force?: boolean, dryRun?: boolean}} [options]
 * @returns {object}
 */
function restoreBackup(userId, filename, options = {}) {
  if (!isValidBackupFilename(filename)) {
    throw new Error(`Invalid backup filename: ${filename}`);
  }

  // userId flows unsanitized into path.join() below (getUserBackupDir,
  // db.getProfileDir), so a bad user (e.g. "../x") must fail here rather than
  // being discovered only after files are written outside the user tree.
  if (!users.userExists(userId)) {
    return { success: false, error: `Unknown user: ${userId}` };
  }

  // Step 1: resolve the archive under the same directory backups are written
  // to. A missing archive is a 404-shaped failure, not a thrown error — the
  // caller (the /admin/restore route) reports it the same way as every other
  // per-profile failure below.
  const archivePath = path.join(backup.getUserBackupDir(userId), filename);
  if (!fs.existsSync(archivePath)) {
    return { success: false, error: `Backup not found: ${filename}`, notFound: true };
  }

  const { buf, entries } = readZipEntries(archivePath);
  const manifest = readManifest(buf, entries);

  // Step 2: the filename can't be trusted to carry the userId — it may itself
  // contain dashes — so the manifest is the only place that says whose backup
  // this actually is.
  if (manifest.userId !== userId && !options.force) {
    return {
      success: false,
      error: `Archive belongs to user '${manifest.userId}', not '${userId}' (pass force:true to restore anyway)`,
      filename,
      manifestVersion: manifest.version,
      manifestTimestamp: manifest.timestamp,
    };
  }

  // Step 3: the profile set is whatever snapshots the zip actually contains,
  // not what the manifest merely lists — a manifest entry with success:false
  // never got a datastore.sqlite written.
  const restorableProfiles = collectRestorableProfiles(manifest, entries);
  const profileIds = Object.keys(restorableProfiles);

  console.log(
    `Restoring backup for user ${userId}: ${filename}${options.dryRun ? " (dry run)" : ""} — profiles: ${
      profileIds.join(", ") || "(none)"
    }`
  );

  // An archive whose manifest entries are all missing or success:false has
  // nothing this can write — the loops below would no-op, anyFailed would
  // stay false, and the caller would read a 200 "restored: {}" as a completed
  // restore during disaster recovery, when nothing happened at all.
  if (profileIds.length === 0) {
    const error = "No profile in the manifest has a usable snapshot";
    console.error(`Restore for user ${userId} failed: ${error} (${filename})`);
    return {
      success: false,
      error,
      filename,
      manifestVersion: manifest.version,
      manifestTimestamp: manifest.timestamp,
      ...(options.dryRun ? { dryRun: true } : {}),
      restored: {},
    };
  }

  if (options.dryRun) {
    const dryRunResult = {};
    for (const [profileId, info] of Object.entries(restorableProfiles)) {
      const targetDir = db.getProfileDir(userId, profileId);
      dryRunResult[profileId] = {
        expectedCounts: info.expectedCounts,
        hasImages: info.imageEntries.length > 0,
        existingDatastore: fs.existsSync(path.join(targetDir, "datastore.sqlite")),
      };
    }
    return {
      success: true,
      dryRun: true,
      filename,
      manifestVersion: manifest.version,
      manifestTimestamp: manifest.timestamp,
      restored: dryRunResult,
    };
  }

  // Step 4: close every connection BEFORE touching any file on disk. Every
  // db.* helper reopens a connection on demand (getConnection), so calling
  // any of them for these profiles between here and the extraction below
  // would silently hold (or reopen) a handle over the file this is about to
  // overwrite.
  for (const profileId of profileIds) {
    db.closeConnection(userId, profileId);
  }

  const restored = {};

  // Step 5: write each profile's files back to disk. A failure here is
  // per-profile, not fatal to the rest — the try/catch keeps one corrupt
  // snapshot from blocking every other profile in the same archive.
  for (const profileId of profileIds) {
    const info = restorableProfiles[profileId];
    try {
      restored[profileId] = restoreProfile(userId, profileId, buf, info);
      console.log(`Restored profile ${profileId} for user ${userId}`);
    } catch (error) {
      console.error(`Restore failed for user ${userId} profile ${profileId}: ${error.message}`);
      restored[profileId] = {
        success: false,
        error: error.message,
        // Set only when restoreProfile() got as far as renaming the live
        // database aside before failing — otherwise nothing moved and there
        // is nowhere to point to.
        ...(error.preRestorePath ? { preRestorePath: error.preRestorePath } : {}),
      };
    }
  }

  // Step 6: re-register every restored profile so a fresh volume doesn't end
  // up with a profile directory the `profiles` registry table never learned
  // about — resolveProfileId() would otherwise mint a brand new UUID for it
  // on next use instead of finding this one.
  for (const profileId of profileIds) {
    if (!restored[profileId].success) continue;
    const existing = users.getProfileById(userId, profileId);
    const name = existing ? existing.name : profileId;
    try {
      users.createProfileWithId(userId, profileId, name);
    } catch (error) {
      // Registry re-creation failing doesn't undo the file restore already
      // done — surface it on the profile's result rather than losing it.
      restored[profileId].success = false;
      restored[profileId].error = `Restored files but failed to re-register profile: ${error.message}`;
    }
  }

  // Step 7: verify by reopening. A count mismatch is reported, not thrown —
  // an older archive gets migrated in place on first reopen (initializeSchema
  // + the migrate helpers in db.js), so some drift from the manifest's
  // recorded counts is expected, and the caller needs to see it rather than
  // have it swallowed.
  //
  // The verification connection is closed again once counted, rather than
  // left cached in db.js's pool — the next real request reopens it lazily,
  // same as any other profile, and closing checkpoints WAL mode's own
  // -wal/-shm back out so a restore doesn't trade the OLD stale journal for
  // a freshly-opened one sitting there for no reason.
  for (const profileId of profileIds) {
    if (!restored[profileId].success) continue;
    try {
      const conn = db.getConnection(userId, profileId);
      const actualCounts = backup.getTableCounts(conn);
      const expectedCounts = restorableProfiles[profileId].expectedCounts;
      restored[profileId].expectedCounts = expectedCounts;
      restored[profileId].actualCounts = actualCounts;
      restored[profileId].countsMatch =
        JSON.stringify(sortedEntries(expectedCounts)) === JSON.stringify(sortedEntries(actualCounts));
    } catch (error) {
      restored[profileId].success = false;
      restored[profileId].error = `Restored but failed to reopen for verification: ${error.message}`;
    } finally {
      db.closeConnection(userId, profileId);
    }
  }

  const anyFailed = Object.values(restored).some((r) => !r.success);

  if (anyFailed) {
    const failedProfiles = Object.entries(restored)
      .filter(([, r]) => !r.success)
      .map(([profileId]) => profileId);
    console.error(`Restore for user ${userId} completed with failures — profile(s) failed: ${failedProfiles.join(", ")}`);
  } else {
    console.log(`Restore for user ${userId} completed: ${filename} (${profileIds.join(", ")})`);
  }

  return {
    success: !anyFailed,
    filename,
    manifestVersion: manifest.version,
    manifestTimestamp: manifest.timestamp,
    restored,
  };
}

/**
 * Sorted [key, value] pairs so two count objects with the same content in a
 * different key order still compare equal above.
 */
function sortedEntries(obj) {
  return Object.entries(obj).sort(([a], [b]) => a.localeCompare(b));
}

/**
 * Restore one profile's files: database snapshot, then images merged on top.
 * Runs after connections are already closed (step 4) and returns the
 * per-profile result shape restoreBackup() collects into `restored`.
 */
function restoreProfile(userId, profileId, buf, info) {
  const targetDir = db.getProfileDir(userId, profileId);
  fs.mkdirSync(targetDir, { recursive: true });

  const datastorePath = path.join(targetDir, "datastore.sqlite");
  let preRestorePath;

  // Extract to a temp file FIRST, before anything about the live database is
  // touched. A failed extraction — corrupt deflate stream, truncated
  // archive, unsupported compression method, disk full while writing the
  // temp file — must leave the live database exactly where it was, not
  // renamed aside with nothing to replace it: the next db.getConnection()
  // would otherwise recreate an empty database in its place.
  const tempPath = path.join(targetDir, `.restore-tmp-${profileId}-${Date.now()}.sqlite`);
  try {
    fs.writeFileSync(tempPath, extractZipEntry(buf, info.datastoreEntry));

    // A snapshot that decompresses cleanly but isn't a valid SQLite database
    // (bit rot in the data itself, not the zip container) needs the same
    // protection as a failed decompression — sqlite_master isn't read until
    // the first query, so opening the file alone proves nothing. Caught here,
    // before the live database is touched, instead of at step 7's later
    // reopen, which would only discover it after the bad bytes already
    // replaced what was live.
    try {
      const probe = new DatabaseSync(tempPath, { readOnly: true });
      try {
        probe.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get();
      } finally {
        probe.close();
      }
    } catch (probeError) {
      throw new Error(`Extracted snapshot is not a valid SQLite database: ${probeError.message}`);
    }

    // Only now, with the replacement snapshot fully written to disk, is an
    // existing datastore renamed aside — never deleted. This is
    // deliberately NOT backup.createBackup(), which runs cleanOldBackups()
    // and could purge the very archive being restored (it rotates by mtime,
    // with no notion of "the file currently being read").
    //
    // The WAL journal mode's -wal/-shm sidecars still carry the OLD file's
    // name at this point (a rename doesn't follow them), so they still hold
    // whatever committed transactions never made it into datastore.sqlite
    // itself — real if the profile's connection was never cleanly closed
    // (e.g. the server was killed mid-flight by a redeploy, then restarted
    // and restored before that profile was reopened). Renamed alongside the
    // database with the same suffix, not deleted, so the three files stay a
    // recoverable set instead of losing data that exists nowhere else.
    if (fs.existsSync(datastorePath)) {
      const suffix = new Date().toISOString().replace(/[:.]/g, "-");
      preRestorePath = path.join(targetDir, `datastore.sqlite.pre-restore-${suffix}`);
      fs.renameSync(datastorePath, preRestorePath);
      for (const walSuffix of ["-wal", "-shm"]) {
        const src = datastorePath + walSuffix;
        if (fs.existsSync(src)) {
          fs.renameSync(src, preRestorePath + walSuffix);
        }
      }
    }

    fs.renameSync(tempPath, datastorePath);
  } catch (error) {
    // preRestorePath is set only once the rename-aside above actually ran —
    // a failure before that point never moved the live database, so there is
    // nowhere to report.
    if (preRestorePath) {
      error.preRestorePath = preRestorePath;
    }
    throw error;
  } finally {
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
  }

  cleanOldPreRestoreCopies(targetDir);

  // Images are extracted OVER the existing directory, merging rather than
  // replacing — the archive only ever holds images that existed at backup
  // time, so wiping the directory first would drop every image added since.
  // Orphan blobs (an image deleted after the backup, whose file the merge
  // brings back) are the accepted cost of not doing that.
  const imagesDir = path.join(targetDir, "images");
  if (info.imageEntries.length > 0) {
    fs.mkdirSync(imagesDir, { recursive: true });
    for (const entry of info.imageEntries) {
      const relative = entry.name.slice(IMAGE_PREFIX(profileId).length);
      const outPath = path.join(imagesDir, relative);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, extractZipEntry(buf, entry));
    }
  }

  return { success: true, preRestorePath };
}

/**
 * Delete pre-restore copies of a profile's database beyond the retention
 * limit, the same shape as backup.js's cleanOldBackups(): list, sort by
 * mtime newest-first, slice off everything past the limit. A copy's
 * -wal/-shm sidecars (renamed alongside it in restoreProfile() above) are
 * deleted together with the datastore file they belong to.
 */
function cleanOldPreRestoreCopies(targetDir, retention = PRE_RESTORE_RETENTION) {
  const copies = fs.readdirSync(targetDir)
    .filter((f) => f.startsWith("datastore.sqlite.pre-restore-") && !f.endsWith("-wal") && !f.endsWith("-shm"))
    .map((f) => ({
      name: f,
      path: path.join(targetDir, f),
      mtime: fs.statSync(path.join(targetDir, f)).mtime.getTime(),
    }))
    .sort((a, b) => b.mtime - a.mtime);

  const toDelete = copies.slice(retention);

  for (const copy of toDelete) {
    fs.unlinkSync(copy.path);
    for (const walSuffix of ["-wal", "-shm"]) {
      const sidecar = copy.path + walSuffix;
      if (fs.existsSync(sidecar)) {
        fs.unlinkSync(sidecar);
      }
    }
    console.log(`Deleted old pre-restore copy: ${copy.name}`);
  }

  return { deleted: toDelete.length };
}

module.exports = {
  restoreBackup,
  // Shared with index.js's GET /backups/:filename, so the download route
  // uses the identical traversal guard instead of a second copy of it.
  isValidBackupFilename,
  // Exposed for testing
  PRE_RESTORE_RETENTION,
};
