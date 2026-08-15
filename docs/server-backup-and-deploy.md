# Server backup and deploy — what actually works

Operational note for the hosted sync server. Records findings from inspecting the live
Railway volume directly, because several documented mechanisms do not do what they claim.

## Deploying

`yarn server:deploy` (`scripts/deploy-server.sh`) subtree-splits `apps/server/` and force-pushes
it to a `deploy/server` branch on GitHub, expecting Railway to auto-build from there.

**That path does not work.** The repository's remote is tangled, not GitHub, and a push to
`github.com/autonome/peek` is rejected with 403 even from an account the API reports as having
push rights. Deploys are performed manually against Railway instead.

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

`scripts/deploy-server.sh` and the deploy section of `apps/server/CLAUDE.md` still describe the
GitHub route. Both are stale; this file is the accurate one.

## Backups do not run in production

The server logs a backup attempt every hour and it has never produced a file:

```
Creating backup for user: default
No database found for user default, skipping backup
Completed 1 backup(s)
```

Three independent faults, in the order they bite:

1. **The path check looks where the database no longer is.** `backup.js createBackup()` in the
   deployed build tests `DATA_DIR/{userId}/peek.db`. `index.js migrateUserDataToProfiles()` runs
   at every startup, *before* `backup.createAllBackups()`, and renames that file to
   `DATA_DIR/{userId}/profiles/{profileId}/datastore.sqlite`. The checked path is therefore
   guaranteed absent by the time it is checked. Current `apps/server/backup.js` derives the path
   from `db.getProfileDir()` and is correct — it has simply never been deployed.

2. **Only one profile is ever backed up.** `createBackup()` hardcodes profile `default`. The live
   volume holds eight profiles under a single user, and the `default` one is an empty stub — all
   real content (over 11,000 items) lives in a UUID-named profile. Fixing fault 1 alone produces a
   valid backup of an empty database: the first deploy carrying the path fix logged
   `Backup created: peek-backup-default-….zip (1.6 KB)` against a profile holding 13 MB.

3. **A failed backup reports success.** `createBackup()` returns `{success: false, error}` on
   failure, but `POST /backups` returns that object as HTTP 200 regardless, and
   `createAllBackups()` logs a completion count without inspecting per-user results. Nothing
   surfaces the failure.

### Related limits

- **The startup backup is not a rollback point.** `deduplicateAllUsers()` opens a connection for
  every user before `createAllBackups()` runs, and `getConnection()` calls `initializeSchema()`.
  Migration has therefore already happened by the time anything is archived.
- **Backups land on the same volume as the live database** (`DATA_DIR/backups/{userId}/`), with no
  download route and a 7-deep retention purge per user. They do not protect against volume loss.
- **There is no restore code.** `ARCHITECTURE.md` labels the area "Backup/restore functionality",
  but only backup exists — no route, no script, no test. `test-backup.js` never unzips an archive
  or verifies a round trip. Restoring means placing `datastore.sqlite` back on the volume by hand.
- **`POST /backups` covers only the calling user**, so it is not a whole-server backup on a
  multi-user deployment.

## Taking a backup by hand

Until the above is fixed, this is the reliable procedure. It does not depend on any server code
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

## What settles this

Deploying current `main` fixes fault 1. Faults 2 and 3 are open: `createBackup()` needs to iterate
profiles rather than assume `default`, and a failed backup needs a non-200 response and a louder
log. Until a restore path exists and a test exercises backup-then-restore-then-verify, treat every
backup as unproven regardless of which mechanism produced it.
