# Server backup and deploy — what actually works

Operational note for the hosted sync server. Records findings from inspecting the live
Railway volume directly, because several documented mechanisms do not do what they claim.

## Deploying

Deploys are manual, uploaded straight to Railway from a local checkout. There is no GitHub-based
path: this repository's remote is tangled, not GitHub, and a push to `github.com/autonome/peek`
is rejected with 403 even from an account the API reports as having push rights.

The manual path uploads a directory and builds it. Run from the repository root:

```
railway up ./apps/server --path-as-root --service peek-node --detach -m "<what changed>"
```

**`--path-as-root` is required.** Without it the CLI fails with `prefix not found`, because it
treats the path argument as a subdirectory of the project rather than as the archive root, and
Nixpacks needs `package.json` at the top level. Passing an absolute path to a directory outside
the repository fails the same way even with explicit `--project` and `--environment` ids.

`railway.json` in `apps/server/` supplies the builder and start command. Deployment metadata
records the CLI message, so `railway status --json` shows what a running deployment was.

Two constraints on the upload:

- **No `yarn.lock` may reach the uploaded directory.** Nixpacks detects it, switches to yarn, and
  the build fails. `apps/server/` has `package-lock.json` only.
- `apps/server/.yarn/install-state.gz` is a committed stray with no runtime purpose. It does not
  trigger yarn detection, which keys on `yarn.lock`, but it does not belong in the image.

`--detach` returns immediately. Poll with `railway deployment list --json`, and confirm the result
against `GET /` on the public host, which reports `datastore_version` without auth.

## Backups run in production

`createBackup(userId)` enumerates every profile directory found on disk for a user, deriving the
location from `db.getProfileDir()` rather than rebuilding the path convention by hand — a second
copy of that convention drifting from the original is what caused the first of the three faults
below. It writes one archive per user, laid out as `profiles/{profileId}/datastore.sqlite`
alongside that profile's `images/` directory when one exists. Each database is snapshotted with
`VACUUM INTO`, folding in whatever is still sitting in the WAL. `manifest.json` is version 2.0 and
carries per-profile row counts, so an archive that captured nothing is visible without unzipping
it. A profile with no database is skipped as routine (mid-creation, or holding only stray files);
a profile whose snapshot fails is recorded in the manifest without blocking the rest, and marks
the overall run as failed. `POST /backups` returns 500 rather than 200 when the backup failed, and
`lastBackupTime` only advances on a fully clean run, so a partial failure keeps tripping the
24-hour check instead of going quiet.

Verified directly against the live volume, not just by test: the archive went from 1.6 KB covering
one empty profile to 4.0 MB covering all eight, and downloading it, unzipping it and opening the
largest snapshot returns the same row counts as the live database — 11,121 items, 480 tags, 14,617
item-tag links.

Getting there took three independent faults, fixed in the order they were found. The history is
worth keeping because it is why the manifest carries row counts and why the tests below open the
archive instead of trusting the return value:

1. **Fixed — the path check looked where the database no longer was.** `backup.js createBackup()`
   used to test `DATA_DIR/{userId}/peek.db`. `index.js migrateUserDataToProfiles()` runs at every
   startup, *before* `backup.createAllBackups()`, and renames that file to
   `DATA_DIR/{userId}/profiles/{profileId}/datastore.sqlite` — so the checked path was guaranteed
   absent by the time it was checked, and every hourly attempt logged `No database found for user
   default, skipping backup` without ever producing a file. `createBackup()` now derives the path
   from `db.getProfileDir()` instead of hand-rebuilding it.
2. **Fixed — only one profile was ever backed up.** `createBackup()` used to hardcode profile
   `default`. The live volume holds eight profiles under a single user, and the `default` one is an
   empty stub — all real content (over 11,000 items) lives in a UUID-named profile. Fixing fault 1
   alone produced a valid backup of an empty database: the first deploy carrying the path fix
   logged `Backup created: peek-backup-default-….zip (1.6 KB)` against a profile holding 13 MB.
   `createBackup()` now enumerates every profile directory on disk (`listProfileDirs()`) instead of
   assuming one name.
3. **Fixed — a failed backup reported success.** `createBackup()` returned `{success: false,
   error}` on failure, but `POST /backups` returned that object as HTTP 200 regardless, and
   `createAllBackups()` logged a completion count without inspecting per-user results — nothing
   surfaced the failure. `POST /backups` now returns 500 on failure, and `createAllBackups()` logs
   which users failed and attaches a `hasFailures` flag to its result.

### Related limits

- **The startup backup is still not a rollback point.** `deduplicateAllUsers()` opens a connection
  for every user before `createAllBackups()` runs, and `getConnection()` calls
  `initializeSchema()`. Migration has therefore already happened by the time anything is archived.
- **Backups still land on the same volume as the live database** (`DATA_DIR/backups/{userId}/`),
  with no download route and a 7-deep retention purge per user. They do not protect against volume
  loss.
- **There is still no restore code.** `ARCHITECTURE.md` labels the area "Backup/restore
  functionality", but only backup exists — no route, no script. Restoring means placing
  `datastore.sqlite` back on the volume by hand.
- **`POST /backups` still covers only the calling user**, so it is not a whole-server backup on a
  multi-user deployment.

## Taking a backup by hand

The server's own backup writes archives to the same volume as the live database and has no
download route (see "Related limits" above), so getting a copy off the box, or taking one that
survives losing that volume, is still a manual procedure. It does not depend on any server code
path, and it is safe against the live WAL.

Most profile databases on the volume are 4 KB stubs whose real content sits in an
un-checkpointed WAL of several hundred KB. **Copying the `.sqlite` files alone loses that data.**
`VACUUM INTO` folds the WAL in and yields a consistent single-file snapshot while the server keeps
running.

The server runs Node 24, so `node:sqlite` is available without installing anything:

1. Walk `DATA_DIR` for every `*.sqlite` and `*.db`, skipping `lost+found` and `backups`.
2. For each, open it and run `VACUUM INTO '<dest>'` into a scratch directory outside the volume,
   naming the output after the source path so profiles stay distinguishable.
3. Archive the scratch directory together with each profile's `images/` directory.
4. Stream the archive off the host and **compare checksums on both ends** before trusting it.
5. Verify the archive by opening the largest snapshot and counting rows in `items`, `tags` and
   `item_tags` — a present-but-empty backup is the failure mode this whole file exists to prevent.
6. Delete the scratch copies from the host afterwards.

Note that `railway ssh` prints its key banner to stderr, so a raw binary stream on stdout is safe.

## Test coverage worth naming

`apps/server/test-backup.js` is 29 tests, up from 21. The additions include a round trip that
unzips a produced archive and compares row counts against the source database, and a test that
writes rows without checkpointing the WAL and verifies they still reach the archive. The original
21 tests never opened an archive at all — they only checked the return value of `createBackup()` —
which is exactly why a backup containing nothing could report success in production. Any future
test that only inspects the result object and never unzips the file it points to is repeating that
gap.

## What settles this

What remains is the restore path: nothing puts an archive back on the volume, and no test
exercises backup-then-restore-then-verify. A backup is now proven as an archive — the round-trip
test and the production verification above both open one and check its contents — but unproven as
a recovery mechanism. Getting a copy off the volume is still manual (see "Taking a backup by
hand").
