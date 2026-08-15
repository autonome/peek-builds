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
 * DATASTORE_VERSION 2 (2026-08): items gained title/domain/favicon/visitCount/
 * lastVisitAt/frecencyScore/mimeType as synced columns (packages/schema/v1.json,
 * docs/sync-coverage-gaps.md §1). sync.ts resetSyncStateIfDatastoreVersionChanged()
 * uses this same number as a purely local marker — independent of the server
 * round-trip below — to force a one-time full re-push so items synced before this
 * version don't get stuck never resending the new columns (the "re-push problem":
 * pushToServer() only selects rows where syncedAt = 0 or updatedAt > syncedAt).
 */
export const DATASTORE_VERSION = 2;
export const PROTOCOL_VERSION = 1;
