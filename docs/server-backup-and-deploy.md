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
  with a 7-deep retention purge per user. `GET /backups/:filename` (below) is what gets a copy off
  that volume; the archive still has to reach it in the first place.
- **`POST /backups` still covers only the calling user**, so it is not a whole-server backup on a
  multi-user deployment.

## Restoring an archive

`POST /admin/restore` (`apps/server/restore.js` `restoreBackup()`) writes a backup archive's
profile snapshots back onto the live volume, overwriting whatever is there. It sits under
`/admin`, gated by `ADMIN_TOKEN` rather than a user's own device key, because it can discard live
data a user-scoped credential should never be able to trigger by itself. Body:

```
{ "userId": "...", "filename": "peek-backup-<userId>-<iso>.zip", "force"?: false, "dryRun"?: false }
```

`filename` is whatever `POST /backups` or `GET /backups` returned; the archive is resolved under
that user's own backup directory, never trusted to carry the userId itself (a userId can contain
dashes, so it can't be parsed back out of the filename). The manifest inside the archive is what's
compared against `userId` instead — a mismatch fails the request unless `force: true` is passed,
for the disaster-recovery case of restoring someone's backup onto a freshly created account.

**`dryRun: true` touches nothing.** It reports, per profile, the manifest's expected row counts,
whether the archive holds any images for it, and whether a live datastore already exists at the
target path — enough to decide whether to proceed without writing a single byte.

**A real restore never deletes the previous database.** Before a profile's snapshot is extracted,
the extraction is written to a temp file and opened read-only to confirm it's actually a readable
SQLite database — a corrupt archive (bit rot in the zip's deflate stream, a truncated upload, an
extracted file that isn't a database at all) is caught there, before the live `datastore.sqlite` is
touched at all. Only once that check passes is the existing datastore renamed aside to
`datastore.sqlite.pre-restore-<timestamp>`, and its `-wal`/`-shm` sidecars, if present, are renamed
alongside it with the same suffix rather than deleted — a profile connection this server doesn't
currently hold open (the process was killed mid-redeploy and restarted before that profile was ever
reopened) can leave committed transactions sitting only in that WAL, and deleting it would be
destroying data that exists nowhere else. Pre-restore copies are themselves retention-bounded
(`PRE_RESTORE_RETENTION`, next to `DEFAULT_RETENTION` in shape): each is a full database copy on a
fixed-size volume, so only the newest few per profile are kept and older ones are deleted the same
way `cleanOldBackups()` rotates archives.

**An archive with nothing restorable in it fails loudly.** If every profile the manifest lists is
missing or was already marked `success: false` at backup time, the request returns
`success: false` with an error naming the reason, for both a real restore and a dry run — not a
200 with an empty `restored: {}`, which during disaster recovery reads as "restore completed."

**A restored profile is always a post-migration artifact.** Every restored profile is reopened and
its table counts compared against the manifest's recorded counts as the last step; a mismatch is
reported, not thrown, because `getConnection()` runs schema migration on first open the same as it
would for any other database — an archive taken before a schema change comes back on the *current*
schema, not frozen at the version it was backed up under.

`GET /backups/:filename` downloads one of the calling user's own archives — user-authed, not
`/admin`, since it only ever reads that user's own backup directory. The response is streamed from
disk rather than read into heap first, the same way the 10 MB cap on `/images/:id` is what makes
reading that route's file whole acceptable and not reading this one's.

## Taking a backup by hand

Restoring through the server (above) is the primary path once an archive already exists. Getting
one off the box in the first place, or reconstructing one when the automated backup itself is
suspect, is still a manual procedure independent of any server code path, and safe against the live
WAL.

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

`apps/server/test-backup.js` is 29 tests. The additions include a round trip that unzips a
produced archive and compares row counts against the source database, and a test that writes rows
without checkpointing the WAL and verifies they still reach the archive. The original 21 tests
never opened an archive at all — they only checked the return value of `createBackup()` — which is
exactly why a backup containing nothing could report success in production. Any future test that
only inspects the result object and never unzips the file it points to is repeating that gap.

`apps/server/test-restore.js` is 23 tests, backing the restore path described above, including a
round trip through the real `POST /admin/restore` route. Several exist specifically to reproduce a
fault before proving the fix: a corrupted deflate stream that used to be able to leave the live
database missing entirely (extraction now happens to a temp file, verified openable, before the
existing database is touched at all); a hot, un-checkpointed WAL that used to be deleted outright
instead of renamed alongside its pre-restore copy; and an archive with nothing restorable in it
that used to report success. The traversal-guard tests build their crafted entry names by patching
the central directory bytes of an otherwise-valid archive directly, rather than asking `archiver` to
write the escape attempt — `archiver` normalizes `../../evil` to `evil` and similar on the way in,
so a zip built through it can never actually carry the name the guard is checking for.

## The production restore rehearsal, 2026-09-01

The restore path had never been run against production. It has now, and it works: a rehearsal
restored a freshly taken archive back onto the live volume and left the data byte-identical.

The method is worth repeating whenever the restore path changes, because it is safe by
construction: take a backup, then restore *that same archive*. What gets written back is what is
already there, so a successful restore is a no-op on content while still exercising every step.
The only exposure is writes landing between the backup and the restore, which that ordering keeps
to a couple of minutes.

What the rehearsal established, in order:

- The archive was downloaded through `GET /backups/:filename`, unzipped off-box, and its largest
  profile snapshot opened read-only with row counts read out of it — `items` 12452, `tags` 518,
  `item_tags` 17752, `item_events` 24142, matching the live server. Until this, backups were proven
  readable only by the test suite, never as production bytes on another machine.
- `dryRun: true` reported all eight profile snapshots resolvable with an existing datastore at each
  target, and wrote nothing.
- The real restore completed in 1.4 s with `countsMatch: true` on every profile, leaving a
  `datastore.sqlite.pre-restore-<timestamp>` beside each replaced database.
- Independent verification, not the server's own report: per-profile item and tag counts plus a
  sha256 over sorted item ids and over `id:updatedAt` pairs, captured before and after. All three
  registered profiles hashed identically, so the restore changed no content.

**A restore onto a live volume registers every profile directory in the archive.** `restore.js`
step 6 calls `users.createProfileWithId()` for each restored profile, deliberately — the comment
there is correct that a fresh volume would otherwise have `resolveProfileId()` mint a new UUID for
a directory the registry never learned about. The consequence on a volume that already has data is
that stray directories which were never registered profiles become visible ones, named after their
own UUID (`existing ? existing.name : profileId`) with a doubled slug such as `default-default`.
The rehearsal promoted five such directories — test residue including `deadbeef-0000-4000-8000-000000000001`
and a literal `default` — from invisible to first-class, and they were unregistered afterwards with
`DELETE /profiles/:profileId`, which drops the registry row and preserves the data directory.

Anyone rehearsing again should expect this and check `GET /profiles` before and after. The cleaner
fix is to get the stray directories off the volume, since they are the input that makes step 6 look
wrong when it is doing what disaster recovery needs.

Four of the five were deleted from the volume on 2026-09-01, leaving four profile directories where
there had been eight. What made them disposable, established by opening each live `datastore.sqlite`
*with its `-wal` sidecar present* rather than trusting the archive — an un-checkpointed WAL can hold
rows the archive predates:

- `092cc9e1-…`, `deadbeef-0000-4000-8000-000000000001` and a literal `default` held one or two
  `settings` rows and nothing else.
- `7ba1e42b-…` held two urls, both already in the main profile, one of them `https://example.com/`.

`8ccb036b-…` held two notes that existed nowhere else. They were re-posted into the main profile
through `POST /items` with their original `createdAt` — `saveItem()` honours a client-supplied
`createdAt` on INSERT, so both kept their January dates rather than surfacing as new — and the
directory was then deleted. The volume now holds three profile directories matching the three
registered profiles exactly.

That move was re-checked immediately before it ran, because a mobile sync had landed in between and
made the earlier evidence stale: the main profile had grown from 12452 to 12507 items. Re-running
the comparison against the current profile is what confirmed the two notes were still absent from
it. The general point outlives this instance — the overlap check is only valid against the profile
as it stands at the moment of deletion, so it is re-run rather than reused.

The general rule this leaves: a profile directory is disposable when every row it holds is either
`settings` or content that already exists in the registered profile, judged against the live file
plus its WAL. Take a backup and copy it off the volume first — the 2026-09-01 archive in
`$HOME/peek-backups/` contains all eight directories as they stood before the deletion.

Retention is 7 deep and a backup taken by hand counts against it: taking two during the rehearsal
purged the two oldest daily archives about two days earlier than they would have rotated out.

## What settles this

A backup is proven as an archive (round-trip test, production verification above), as bytes
readable off-box, and as a recovery mechanism — both by the restore round-trip test and by the
2026-09-01 rehearsal against the live server described above. What remains manual is getting the
very first copy off a volume that has none yet, or reconstructing one by hand when the automated
path itself is suspect — see "Taking a backup by hand".

Backups still live on the same Railway volume as the live database, so they remain no protection
against volume loss. `GET /backups/:filename` is the first half of fixing that; nothing pulls them
off-box on a schedule yet.
