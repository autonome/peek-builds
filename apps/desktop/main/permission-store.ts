/**
 * Persistent per-origin permission decisions.
 *
 * Backed by the `feature_settings` table:
 *   featureId = 'page-permissions'
 *   key       = `{permission}:{origin}`   e.g. `geolocation:https://example.com`
 *   value     = JSON `{ allowed: boolean, timestamp: number }`
 *
 * Phase 3 of the web-permissions feature. When the user clicks Allow/Deny
 * with the "Remember this decision" checkbox set, the renderer includes
 * `remember: true` in `page:permission-response`; permission-handler.ts
 * routes that to `setDecision()` here. On subsequent permission requests
 * with the same `(permission, origin)` pair, `getDecision()` returns the
 * stored choice and the handler skips the prompt.
 *
 * No electron imports — pure SQL wrapper, unit-testable under plain node
 * via an in-memory node:sqlite database.
 */

const FEATURE_ID = 'page-permissions';

export interface StoredDecision {
  allowed: boolean;
  timestamp: number;
}

export interface DecisionRow {
  permission: string;
  origin: string;
  allowed: boolean;
  timestamp: number;
}

/** Subset of node:sqlite's DatabaseSync surface this module needs — keeps
 * the type local so tests can pass an in-memory db without importing the
 * full type. */
export interface PermissionDb {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

function makeKey(permission: string, origin: string): string {
  return `${permission}:${origin}`;
}

function makeId(permission: string, origin: string): string {
  return `${FEATURE_ID}-${permission}-${origin}`;
}

export function getDecision(
  db: PermissionDb,
  origin: string,
  permission: string,
): StoredDecision | null {
  const row = db
    .prepare(
      `SELECT value FROM feature_settings WHERE featureId = ? AND key = ?`,
    )
    .get(FEATURE_ID, makeKey(permission, origin)) as { value: string } | undefined;
  if (!row || !row.value) return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<StoredDecision>;
    if (typeof parsed.allowed !== 'boolean') return null;
    return {
      allowed: parsed.allowed,
      timestamp: typeof parsed.timestamp === 'number' ? parsed.timestamp : 0,
    };
  } catch {
    return null;
  }
}

export function setDecision(
  db: PermissionDb,
  origin: string,
  permission: string,
  allowed: boolean,
  now: number = Date.now(),
): void {
  const value = JSON.stringify({ allowed, timestamp: now });
  db.prepare(
    `INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(makeId(permission, origin), FEATURE_ID, makeKey(permission, origin), value, now);
}

export function forgetDecision(
  db: PermissionDb,
  origin: string,
  permission: string,
): void {
  db.prepare(
    `DELETE FROM feature_settings WHERE featureId = ? AND key = ?`,
  ).run(FEATURE_ID, makeKey(permission, origin));
}

export function forgetAllDecisions(db: PermissionDb): void {
  db.prepare(`DELETE FROM feature_settings WHERE featureId = ?`).run(FEATURE_ID);
}

export function listDecisions(db: PermissionDb): DecisionRow[] {
  const rows = db
    .prepare(
      `SELECT key, value FROM feature_settings WHERE featureId = ? ORDER BY key`,
    )
    .all(FEATURE_ID) as Array<{ key: string; value: string }>;
  const out: DecisionRow[] = [];
  for (const row of rows) {
    const sep = row.key.indexOf(':');
    if (sep < 0) continue;
    const permission = row.key.slice(0, sep);
    const origin = row.key.slice(sep + 1);
    let parsed: StoredDecision | null = null;
    try {
      const obj = JSON.parse(row.value) as Partial<StoredDecision>;
      if (typeof obj.allowed === 'boolean') {
        parsed = {
          allowed: obj.allowed,
          timestamp: typeof obj.timestamp === 'number' ? obj.timestamp : 0,
        };
      }
    } catch {
      // skip malformed
    }
    if (!parsed) continue;
    out.push({
      permission,
      origin,
      allowed: parsed.allowed,
      timestamp: parsed.timestamp,
    });
  }
  return out;
}
