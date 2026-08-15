const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const db = require("./db");
const users = require("./users");

// Configuration
const DATA_DIR = process.env.DATA_DIR || "./data";
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const DEFAULT_RETENTION = 7;
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Get the backup directory for a user
 */
function getUserBackupDir(userId) {
  return path.join(BACKUP_DIR, userId);
}

/**
 * Get the last backup timestamp for a user
 */
function getLastBackupTime(userId) {
  const value = db.getSetting(userId, "lastBackupTime");
  return value ? parseInt(value, 10) : null;
}

/**
 * Set the last backup timestamp for a user
 */
function setLastBackupTime(userId, timestamp) {
  db.setSetting(userId, "lastBackupTime", timestamp.toString());
}

/**
 * Generate a backup filename
 */
function generateBackupFilename(userId) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `peek-backup-${userId}-${timestamp}.zip`;
}

/**
 * Get table counts for manifest metadata
 */
function getTableCounts(conn) {
  const counts = {};

  const itemTypes = conn.all(`
    SELECT type, COUNT(*) as count
    FROM items
    WHERE CAST(deletedAt AS INTEGER) = 0
    GROUP BY type
  `);

  for (const row of itemTypes) {
    counts[row.type + "s"] = row.count;
  }

  const tagCount = conn.get("SELECT COUNT(*) as count FROM tags");
  counts.tags = tagCount.count;

  return counts;
}

/**
 * The directory that holds every profile folder for a user, derived from
 * db.getProfileDir() rather than rebuilt by hand — a second copy of that path
 * convention drifting from the original is what caused createBackup() to check
 * a stale path in the first place (see docs/server-backup-and-deploy.md).
 * The profileId argument is discarded by path.dirname(), so any placeholder
 * value works; it exists only because getProfileDir() requires one.
 */
function getProfilesParentDir(userId) {
  return path.dirname(db.getProfileDir(userId, "__scan__"));
}

/**
 * List every profile directory that exists on disk for a user, straight from
 * the filesystem rather than the profiles registry table — this is what lets
 * a backup capture a profile the registry never learned about. Returns [] if
 * the user has no profiles directory at all.
 */
function listProfileDirs(userId) {
  const profilesParentDir = getProfilesParentDir(userId);
  if (!fs.existsSync(profilesParentDir)) {
    return [];
  }
  return fs.readdirSync(profilesParentDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/**
 * Create a backup for a single user
 *
 * Backs up every profile directory found on disk under the user, not just
 * "default" — the live volume holds real content in UUID-named profiles that
 * a single hardcoded "default" backup silently skipped (see
 * docs/server-backup-and-deploy.md, "Only one profile is ever backed up").
 * One archive per user (not one per profile) so retention
 * (cleanOldBackups(userId, DEFAULT_RETENTION)) keeps whole snapshots.
 *
 * TODO: DO SQLite backup - VACUUM INTO is not available in Cloudflare Durable Objects SQLite.
 * When deploying to DO, implement an alternative backup strategy:
 * - Export data as JSON to R2
 * - Or use DO's built-in point-in-time recovery features
 */
async function createBackup(userId) {
  console.log(`Creating backup for user: ${userId}`);

  const profileIds = listProfileDirs(userId);

  // A profile directory with no datastore.sqlite is skipped, not an error —
  // it may hold only stray files, or be mid-creation. Filtered up front so an
  // empty-but-real database (a genuine stub, like the "default" profile on
  // the live volume) still gets backed up and shows up in the manifest.
  const candidateProfiles = profileIds.filter((profileId) =>
    fs.existsSync(path.join(db.getProfileDir(userId, profileId), "datastore.sqlite"))
  );

  if (candidateProfiles.length === 0) {
    console.log(`No database found for user ${userId}, skipping backup`);
    return { success: false, error: "No database found" };
  }

  // Ensure backup directory exists
  const userBackupDir = getUserBackupDir(userId);
  if (!fs.existsSync(userBackupDir)) {
    fs.mkdirSync(userBackupDir, { recursive: true });
  }

  const backupFilename = generateBackupFilename(userId);
  const backupPath = path.join(userBackupDir, backupFilename);

  // Snapshot every profile's database with VACUUM INTO before touching the
  // archive. VACUUM INTO is what folds an un-checkpointed WAL into a
  // consistent single-file snapshot — most profile databases on the live
  // volume are small stubs whose real content sits in the WAL, so a plain
  // file copy of datastore.sqlite alone loses data. A profile that fails is
  // recorded but does not stop the rest of the user's profiles from backing up.
  const profileResults = {};
  const snapshots = [];
  let anyFailed = false;

  for (const profileId of candidateProfiles) {
    const profileDir = db.getProfileDir(userId, profileId);
    const tempDbPath = path.join(userBackupDir, `temp-${userId}-${profileId}.db`);

    try {
      const conn = db.getConnection(userId, profileId);
      // Note: plain SQL — works with any adapter backed by real SQLite (node:sqlite today).
      // TODO: For DO SQLite, implement JSON export to R2 instead.
      conn.exec(`VACUUM INTO '${tempDbPath}'`);

      const tableCounts = getTableCounts(conn);
      profileResults[profileId] = { success: true, tableCounts };
      snapshots.push({
        profileId,
        tempDbPath,
        imagesDir: path.join(profileDir, "images"),
      });
    } catch (error) {
      console.error(`Backup failed for user ${userId} profile ${profileId}:`, error.message);
      profileResults[profileId] = { success: false, error: error.message };
      anyFailed = true;
      if (fs.existsSync(tempDbPath)) {
        fs.unlinkSync(tempDbPath);
      }
    }
  }

  // Manifest lists every profile with its own row counts — a backup that
  // captured nothing (the production bug: a 4 KB "default" stub reported as
  // a healthy backup) is visible here without unzipping and opening a database.
  const manifest = {
    version: "2.0",
    timestamp: new Date().toISOString(),
    userId: userId,
    backupType: "daily-snapshot",
    profiles: profileResults,
  };

  try {
    // Create ZIP archive — one directory per profile id, so a profile stays
    // identifiable on restore. Images are archived alongside each profile's
    // database: blobs are part of the data, and a backup that restores rows
    // but loses images is still a partial backup.
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(backupPath);
      const archive = archiver("zip", { zlib: { level: 9 } });

      output.on("close", resolve);
      archive.on("error", reject);

      archive.pipe(output);
      for (const snapshot of snapshots) {
        archive.file(snapshot.tempDbPath, { name: `profiles/${snapshot.profileId}/datastore.sqlite` });
        if (fs.existsSync(snapshot.imagesDir)) {
          archive.directory(snapshot.imagesDir, `profiles/${snapshot.profileId}/images`);
        }
      }
      archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });
      archive.finalize();
    });
  } finally {
    // Clean up temp files regardless of archive outcome
    for (const snapshot of snapshots) {
      if (fs.existsSync(snapshot.tempDbPath)) {
        fs.unlinkSync(snapshot.tempDbPath);
      }
    }
  }

  // Only advance lastBackupTime on a fully clean run — a partial failure
  // should keep tripping needsBackup() so the next scheduled check retries,
  // rather than going quiet for 24h with a broken profile inside.
  if (!anyFailed) {
    setLastBackupTime(userId, Date.now());
  }

  // The archive was still written (it documents which profiles failed), so
  // still rotate old backups.
  await cleanOldBackups(userId);

  const stats = fs.statSync(backupPath);

  if (anyFailed) {
    const failedProfiles = Object.entries(profileResults)
      .filter(([, result]) => !result.success)
      .map(([profileId]) => profileId);
    console.error(
      `Backup for user ${userId} partially failed — profile(s) failed: ${failedProfiles.join(", ")}`
    );
  } else {
    console.log(`Backup created: ${backupFilename} (${(stats.size / 1024).toFixed(1)} KB)`);
  }

  return {
    success: !anyFailed,
    ...(anyFailed ? { error: "One or more profiles failed to back up" } : {}),
    filename: backupFilename,
    path: backupPath,
    size: stats.size,
    timestamp: new Date().toISOString(),
    profiles: profileResults,
  };
}

/**
 * Create backups for all users.
 *
 * Returns the per-user results array (unchanged shape, so existing callers
 * keep working), with a `hasFailures` property attached to the array itself
 * (arrays are objects, so this doesn't show up in `.map`/`for...of`, only in
 * `results.hasFailures`) so a caller can tell at a glance that some user's
 * backup failed without scanning every entry itself.
 */
async function createAllBackups() {
  const allUsers = users.listUsers();
  const results = [];

  for (const user of allUsers) {
    const result = await createBackup(user.id);
    results.push({ userId: user.id, ...result });
  }

  const failed = results.filter((r) => !r.success);
  if (failed.length > 0) {
    console.error(
      `Backup run completed with ${failed.length} failure(s): ${failed.map((r) => r.userId).join(", ")}`
    );
  }
  console.log(`Backup run completed: ${results.length - failed.length}/${results.length} user(s) succeeded`);

  results.hasFailures = failed.length > 0;
  return results;
}

/**
 * Clean old backups beyond retention limit
 */
async function cleanOldBackups(userId, retention = DEFAULT_RETENTION) {
  const userBackupDir = getUserBackupDir(userId);

  if (!fs.existsSync(userBackupDir)) {
    return { deleted: 0 };
  }

  // List backup files sorted by modification time (newest first)
  const files = fs.readdirSync(userBackupDir)
    .filter(f => f.startsWith("peek-backup-") && f.endsWith(".zip"))
    .map(f => ({
      name: f,
      path: path.join(userBackupDir, f),
      mtime: fs.statSync(path.join(userBackupDir, f)).mtime.getTime()
    }))
    .sort((a, b) => b.mtime - a.mtime);

  // Delete files beyond retention
  const toDelete = files.slice(retention);

  for (const file of toDelete) {
    fs.unlinkSync(file.path);
    console.log(`Deleted old backup: ${file.name}`);
  }

  return { deleted: toDelete.length };
}

/**
 * List backups for a user
 */
function listBackups(userId) {
  const userBackupDir = getUserBackupDir(userId);

  if (!fs.existsSync(userBackupDir)) {
    return [];
  }

  const files = fs.readdirSync(userBackupDir)
    .filter(f => f.startsWith("peek-backup-") && f.endsWith(".zip"))
    .map(f => {
      const filePath = path.join(userBackupDir, f);
      const stats = fs.statSync(filePath);
      return {
        filename: f,
        size: stats.size,
        createdAt: stats.mtime.toISOString()
      };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return files;
}

/**
 * Check if a user needs a backup (>24h since last backup)
 */
function needsBackup(userId) {
  const lastBackup = getLastBackupTime(userId);
  if (!lastBackup) return true;

  const elapsed = Date.now() - lastBackup;
  return elapsed >= BACKUP_INTERVAL_MS;
}

/**
 * Run daily backups for all users who need them
 */
async function checkAndRunDailyBackups() {
  console.log("Checking for users needing backup...");

  const allUsers = users.listUsers();
  let backupCount = 0;

  for (const user of allUsers) {
    if (needsBackup(user.id)) {
      console.log(`User ${user.id} needs backup (>24h since last backup)`);
      await createBackup(user.id);
      backupCount++;
    }
  }

  if (backupCount === 0) {
    console.log("No users need backup at this time");
  } else {
    console.log(`Completed ${backupCount} backup(s)`);
  }

  return { backupCount };
}

module.exports = {
  createBackup,
  createAllBackups,
  cleanOldBackups,
  listBackups,
  needsBackup,
  checkAndRunDailyBackups,
  getLastBackupTime,
  setLastBackupTime,
  // Exposed for testing
  BACKUP_DIR,
  DEFAULT_RETENTION,
  BACKUP_INTERVAL_MS
};
