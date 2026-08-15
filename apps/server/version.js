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
 * docs/sync-coverage-gaps.md §1). Must stay in lockstep with
 * apps/desktop/version.ts DATASTORE_VERSION — see that file for how the desktop
 * client also uses this number to force a one-time full re-push.
 */
const DATASTORE_VERSION = 2;
const PROTOCOL_VERSION = 1;

module.exports = { DATASTORE_VERSION, PROTOCOL_VERSION };
