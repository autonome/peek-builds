---
enabled: true
touches: [apps/server/users.js, apps/server/auth.js, apps/server/index.js, apps/server/test.js, apps/desktop/main/sync.test.ts]
depends-on: []
---

# Retire the shared-profile-key fallback now that device keys are live

Peek item `8415f3de`. Most of that item is already landed: the `devices` table, account-holder
self-service routes (`/devices`, `/devices/:deviceId`, `/devices/enrolment-codes`), the
unauthenticated `/enrol` exchange, and `/admin/devices`. This spec is only the item's step 3,
"the cutover" — the one piece still open.

## What's still live and needs to go

`apps/server/users.js` `resolveDevice()` has a fallback branch after the `devices` lookup:

```js
// Pre-migration safety net: key may still live only in the users table
// (migrateLegacyKeysToDevices not yet run, or single-user bootstrap). Accept
// it but without a device identity.
const userId = getUserIdFromApiKey(apiKey);
if (userId) {
  return { userId, deviceId: null, legacy: true };
}
```

A key present only in `users.api_key_hash` (never enrolled as a device) is still accepted. This
is the "shared key" the item wants gone: it never expires, isn't listed anywhere on the devices
panel, and can't be individually revoked.

`apps/server/auth.js` `multiUserMiddleware()` doesn't branch on `legacy` explicitly — it just
coerces `cred.deviceId` to `""` when null — but that's exactly how the legacy path currently
authenticates a request today. Its comment ("deviceId is null only for a pre-migration
legacy-key match") goes stale once the branch above is removed and should be updated or dropped.

## What stays

- `migrateLegacyKeysToDevices()` (`users.js`) and its call from `index.js`'s startup block.
  This is what turns an *existing* shared key into a `legacy-shared` device row — the item's
  "Done looks like: existing installs keep working through their legacy-shared device row." It
  doesn't authenticate anything itself; it just seeds `devices` so the normal `devices.key_hash`
  lookup in `resolveDevice()` finds a row. Keep it running at every startup, unchanged.
- `migrateFromLegacyApiKey()` (`index.js`) and `createUserWithKey()` (`users.js`), which it
  calls. This is how a brand-new deploy bootstraps its first user from the `API_KEY` env var.
  `migrateLegacyKeysToDevices()` runs right after it in the same startup block and converts that
  fresh row into a device immediately, so a new deploy still ends up with a working device key.
  Keep both; don't touch the startup ordering.
- The `users.api_key_hash` column, and `createUser()`'s/`createUserWithKey()`'s writes to it.
  `migrateLegacyKeysToDevices()` reads this column to seed the device row, so it has to keep
  being written for every user, cutover or not.

## What goes

- The `legacy` fallback branch in `resolveDevice()` quoted above, including its call to
  `getUserIdFromApiKey()`.
- `getUserIdFromApiKey()` itself, once nothing calls it — check for other call sites first
  (`apps/server/test.js` and `apps/server/test-backup.js` currently call it directly in ways
  unrelated to `resolveDevice()`; leave those test-only call sites if removing them would require
  restructuring tests that aren't about this cutover, but do remove the definition's use inside
  `resolveDevice()`).
- `regenerateApiKey()` (`users.js`) — no route calls it; device-level rotation is revoke + enrol
  instead. Delete it and its dedicated test `describe` block in `test.js`.

If a function above turns out to still be needed by something not mentioned here, leave it in
place with a comment saying why, rather than deleting something load-bearing to satisfy this
list.

## Tests to change

`apps/server/test.js`:

- The `resolveDevice` test `"should fall back to a legacy users-table key (pre-migration)"`
  currently asserts the legacy match returns `{ userId, deviceId: null, legacy: true }`. Once the
  branch is removed, a users-table-only key must resolve to `null` (unauthenticated) instead —
  invert this test's assertion rather than deleting it, so the rejection stays covered.
- The `migrateLegacyKeysToDevices` describe block (`"should migrate a user's legacy key into a
  device and keep it working"`, `"should be idempotent"`) asserts pre-migration behavior that
  depended on the fallback working. Re-read both after removing the fallback and adjust whatever
  "pre-migration the key works" assertion no longer holds — the migration itself is unchanged, so
  most of the block should survive.
- Remove or adjust the `regenerateApiKey` describe block once that function is deleted.
- No test currently asserts that a legacy-only key is *rejected* after cutover — the inverted
  test above is what closes that gap; make sure it actually exercises `multiUserMiddleware()` or
  `resolveDevice()` post-cutover, not just the deleted code path's absence.

`apps/desktop/main/sync.test.ts` — the desktop sync suites boot the real server app in-process
and authenticate through it. Their shared `setup()` helper builds the credential with
`users.createUser(userId)` and hands that `apiKey` to `profiles.enableSync(...)`: a users-table
key, which only ever authenticated through the fallback this spec removes. With the fallback gone
every request in those suites answers `401 Unauthorized` (35 failures across the event-watermark,
progress-log, tag-metadata, IPC entry-point, bulk-pull-timeout, version-bump and batch-push
describes). Change `setup()` to keep the `createUser(userId)` call (the user row must exist) and
then mint the credential with `users.createDevice(userId, 'sync-test').apiKey`, the same way
`apps/server/test.js`'s route tests do post-cutover. Extend the `let users: {...}` type
declaration near the top of the file to include `createDevice(userId: string, label: string):
{ apiKey: string }`. No assertion changes; the suites are about sync, not auth.

## Verify

Both suites must be green. The repo gate covers the desktop side (`sync.test.ts` compiles into
`dist/main/` and runs under the electron runner); the server side is not in the gate, so run it
directly too. Record all counts in the handoff's `**Result**` section:

```
yarn workspace @peek/desktop build && NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js && NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
yarn server:test
```

Done when the electron runner reports `fail 0` (3311 tests as of `af107d97`; before the
`sync.test.ts` change it reports 35 failures, all `Server error 401`), and the server suite passes
with: the inverted legacy-key-rejected test, `migrateLegacyKeysToDevices`'s tests adjusted and
passing, `regenerateApiKey`'s tests removed, and no other server test newly failing.

## Working rules

Run one command per Bash call.
