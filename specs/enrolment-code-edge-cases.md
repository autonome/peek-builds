---
enabled: true
touches: [apps/server/users.js, apps/server/test.js, apps/desktop/main/tile-ipc.ts, apps/desktop/renderer/settings/settings.js, apps/desktop/tests/desktop/*.spec.ts]
depends-on: []
---

# Three edge-case gaps left from the device-keys review

Left unfixed as edge cases when device-keys/enrolment-code work landed (`c7e58a7a` and earlier
review rounds). Three independent, unrelated fixes; do all three.

## 1. Enrolment code redemption isn't atomic

`apps/server/users.js` `exchangeEnrolmentCode()` does, as three separate statements with nothing
wrapping them:

```js
const row = db.get(
  "SELECT id, user_id, expires_at, used_at FROM enrolment_codes WHERE code_hash = ?",
  [codeHash]
);
if (!row) { throw new Error("Invalid enrolment code"); }
if (row.used_at) { throw new Error("Enrolment code already used"); }
if (new Date(row.expires_at).getTime() < Date.now()) { throw new Error("Enrolment code expired"); }

const device = createDevice(row.user_id, deviceLabel);

db.run("UPDATE enrolment_codes SET used_at = ? WHERE id = ?", [
  new Date().toISOString(),
  row.id,
]);
```

Two concurrent redemptions of the same code can both pass the `used_at` check before either
reaches the `UPDATE`, minting two devices from one single-use code. Only a real risk if the
server ever runs as more than one process sharing the SQLite file — currently single-process, so
latent, not exploitable today.

**Fix:** wrap the check, mint, and mark-used in a single transaction (better-sqlite3's
`db.transaction(fn)`, matching however `getSystemDb()` already exposes the underlying connection
elsewhere in this file — check for a precedent before introducing a new pattern). The check must
re-run inside the transaction, not just before it, or the race isn't actually closed.

**Test:** add a case to `apps/server/test.js` that redeems the same code twice back-to-back and
asserts the second redemption throws "already used" — this doesn't reproduce the concurrent race
directly (single-process test), but proves the sequential path still works correctly and gives
the transaction wrapper a test to break if it's wired wrong.

## 2. Revoking your own device can leave a dead local key

`apps/desktop/main/tile-ipc.ts`, the `tile:sync:revoke-device` handler:

```js
async (args, config) => {
  const result = await revokeDevice(config.serverUrl, config.apiKey, args.deviceId);
  if (result.revoked && result.current) {
    clearSyncCredentials();
  }
  return result;
},
```

`clearSyncCredentials()` (drops the locally stored key) only runs when the server reports a fresh
`revoked: true` transition for the current device. Retry a self-revoke on a device that's already
revoked server-side (e.g. the first call succeeded server-side but the response was lost, or two
tabs both fired the revoke), and the local key is never cleared — it sits on disk indefinitely,
even though the account holder's intent (get this device logged out) was already satisfied
server-side.

Before fixing the client, read the server-side revoke route (`apps/server/index.js`, the
`/devices/:deviceId` `DELETE` handler and/or `/admin/devices/:deviceId`) to see what it actually
returns for a device that's already revoked — same `{ revoked: true }` shape, a different shape,
or an error. Fix `tile-ipc.ts`'s handler so that revoking your *own current* device clears the
local key whenever the device ends up revoked, whether this call performed the transition or it
was already revoked — the intent (log this device out locally) is the same either way.

## 3. A failed key-persist after enrolment still shows success

`apps/desktop/renderer/settings/settings.js`, the enrol-success path:

```js
const newKey = result.data?.apiKey || '';
config.apiKey = newKey;
apiKeyInput.value = newKey;
await api.sync.setConfig({ apiKey: newKey });
enrolInput.value = '';
enrolLabelInput.value = '';
enrolStatus.textContent = 'Enrolled — this device now has its own key.';
enrolStatus.style.color = '';
updateStatus();
```

`api.sync.setConfig(...)` is awaited but its result is never checked. If the persist fails, the
UI still clears the enrolment-code input and reports success, while the new key never actually
made it to disk.

**Fix:** check `setConfig`'s result. On failure, leave the enrolment-code input intact (so the
user can retry) and show an error in `enrolStatus` instead of the success message — follow
whatever result/error shape `api.sync.setConfig` already uses elsewhere in this file.

## Verify

Fix 1 is server-only; the repo gate doesn't cover `apps/server`. Run and record counts:

```
yarn server:test
```

Fixes 2 and 3 are desktop UI. Run the full gate (build + unit suites) plus any existing desktop
spec covering the devices panel or settings enrolment flow — grep for one with
`yarn workspace @peek/desktop test:grep <name>` and record what you find and its pass/fail count.
If nothing covers the retry-after-self-revoke or failed-persist paths, a new assertion in an
existing spec file is preferable to a whole new spec file; use judgment on whether either is
practical to drive through the real UI versus documenting the gap in the handoff's Result.

## Working rules

`apps/desktop/CLAUDE.md` governs the desktop app. Read it before editing. Run one command per
Bash call; use the `yarn` scripts, never `npx playwright` directly.
