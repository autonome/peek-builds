/**
 * Version constants for sync compatibility checking.
 *
 * DATASTORE_VERSION — schema shape of sync-relevant tables (items, tags, item_tags).
 *   Bump when a schema change would break sync.
 *
 * PROTOCOL_VERSION — wire format of sync JSON payloads and endpoint behavior.
 *   Bump when request/response shape changes.
 *
 * Rules:
 * - Versions are simple integers, only increment
 * - Exact match required — if versions differ, sync is refused (HTTP 409)
 * - Clients sending no version headers are accepted during rollout
 *
 * Raised to 3 to match apps/desktop/version.ts and apps/server/version.js
 * (item and tag columns added there — see those files' history). This
 * extension engine does not send any of those newer columns, and that's
 * safe: apps/server/db.js saveItem() binds every newer column through
 * COALESCE(?, existingColumn), and POST /items defaults absent fields to
 * null, so an item pushed without title/domain/favicon/visitCount/
 * lastVisitAt/frecencyScore/mimeType/starred/archived leaves the stored
 * values untouched rather than nulling them. Declaring a version whose
 * columns it doesn't carry only works because of that COALESCE behavior —
 * see apps/server/test.js "a partial push preserves title/domain/starred it
 * does not send".
 */
export const DATASTORE_VERSION = 3;
export const PROTOCOL_VERSION = 1;
