/**
 * Event-dispatch rule registry.
 *
 * Rules tie an event topic + JSON match predicate to a script. Stage 1
 * (peek MCP plan 3d7d9239) lands the storage layer + CRUD + manifest
 * contribution; Stage 2 introduces the dispatcher and predicate
 * language. All Stage 1 rows are local-only (`sync: false` in
 * packages/schema/v1.json).
 *
 * Pure SQL wrapper — no Electron imports — so the module is
 * unit-testable under plain node via an in-memory node:sqlite database, the
 * same shape as permission-store.ts.
 */

import { createHash } from 'node:crypto';

export type RuleSource = 'manifest' | 'user' | 'runtime';

/** In-memory shape. JSON columns (`match`, `config`, `display`) are
 *  parsed; the SQL row keeps them as TEXT. */
export interface Rule {
  id: string;
  featureId: string;
  topic: string;
  match: Record<string, unknown>;
  scriptId: string;
  config: Record<string, unknown>;
  display: Record<string, unknown> | null;
  enabled: boolean;
  source: RuleSource;
  ordering: number;
  createdAt: number;
  updatedAt: number;
}

/** What a manifest may declare under top-level `rules: [...]`. The id
 *  is computed from a content hash; createdAt/updatedAt are assigned
 *  on insert. */
export interface ManifestRule {
  topic: string;
  scriptId: string;
  match?: Record<string, unknown>;
  config?: Record<string, unknown>;
  display?: Record<string, unknown> | null;
  enabled?: boolean;
  ordering?: number;
}

/** Subset of node:sqlite's DatabaseSync used here — keeps the type local
 *  so tests can pass an in-memory db without importing the full type. */
export interface RulesDb {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

interface RuleRow {
  id: string;
  featureId: string;
  topic: string;
  match: string;
  scriptId: string;
  config: string;
  display: string;
  enabled: number;
  source: string;
  ordering: number;
  createdAt: number;
  updatedAt: number;
}

// ─── (de)serialization ──────────────────────────────────────────────

function parseJsonObject(s: string, fallback: Record<string, unknown>): Record<string, unknown> {
  if (!s) return fallback;
  try {
    const v = JSON.parse(s);
    return (v && typeof v === 'object' && !Array.isArray(v)) ? (v as Record<string, unknown>) : fallback;
  } catch {
    return fallback;
  }
}

export function parseRule(row: RuleRow): Rule {
  return {
    id: row.id,
    featureId: row.featureId,
    topic: row.topic,
    match: parseJsonObject(row.match, {}),
    scriptId: row.scriptId,
    config: parseJsonObject(row.config, {}),
    display: row.display ? parseJsonObject(row.display, {}) : null,
    enabled: row.enabled !== 0,
    source: row.source as RuleSource,
    ordering: row.ordering,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function serializeRule(rule: Rule): RuleRow {
  return {
    id: rule.id,
    featureId: rule.featureId,
    topic: rule.topic,
    match: JSON.stringify(rule.match ?? {}),
    scriptId: rule.scriptId,
    config: JSON.stringify(rule.config ?? {}),
    display: rule.display ? JSON.stringify(rule.display) : '',
    enabled: rule.enabled ? 1 : 0,
    source: rule.source,
    ordering: rule.ordering,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

// ─── id derivation ──────────────────────────────────────────────────

/**
 * Stable id for a manifest-declared rule. SHA-256 over the
 * (featureId, topic, scriptId, normalized match, normalized config,
 * normalized display, ordering) tuple — so identical reboots don't
 * churn the table, but any meaningful edit produces a new id.
 *
 * `enabled` is intentionally NOT in the hash: a user toggling a
 * manifest rule off shouldn't fight the manifest re-syncing it back on
 * with a new id.
 */
export function computeManifestRuleId(featureId: string, rule: ManifestRule): string {
  const canonical = JSON.stringify({
    f: featureId,
    t: rule.topic,
    s: rule.scriptId,
    m: rule.match ?? {},
    c: rule.config ?? {},
    d: rule.display ?? null,
    o: rule.ordering ?? 0,
  });
  return 'rule_' + createHash('sha256').update(canonical, 'utf-8').digest('hex').slice(0, 32);
}

// ─── CRUD ───────────────────────────────────────────────────────────

export interface ListRulesFilter {
  topic?: string;       // exact topic match (no wildcard expansion at this layer)
  featureId?: string;
  enabled?: boolean;
  source?: RuleSource;
}

export function listRules(db: RulesDb, filter: ListRulesFilter = {}): Rule[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.topic !== undefined) { where.push('topic = ?'); params.push(filter.topic); }
  if (filter.featureId !== undefined) { where.push('featureId = ?'); params.push(filter.featureId); }
  if (filter.enabled !== undefined) { where.push('enabled = ?'); params.push(filter.enabled ? 1 : 0); }
  if (filter.source !== undefined) { where.push('source = ?'); params.push(filter.source); }
  const sql =
    'SELECT id, featureId, topic, match, scriptId, config, display, enabled, source, ordering, createdAt, updatedAt ' +
    'FROM rules' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY ordering ASC, createdAt ASC';
  const rows = db.prepare(sql).all(...params) as RuleRow[];
  return rows.map(parseRule);
}

export function getRule(db: RulesDb, id: string): Rule | null {
  const row = db
    .prepare(
      'SELECT id, featureId, topic, match, scriptId, config, display, enabled, source, ordering, createdAt, updatedAt FROM rules WHERE id = ?',
    )
    .get(id) as RuleRow | undefined;
  return row ? parseRule(row) : null;
}

/**
 * Insert-or-replace a rule. Caller supplies the full Rule including
 * id; createdAt is preserved on update.
 */
export function upsertRule(db: RulesDb, rule: Rule): Rule {
  const existing = getRule(db, rule.id);
  const createdAt = existing ? existing.createdAt : rule.createdAt;
  const final: Rule = { ...rule, createdAt };
  const row = serializeRule(final);
  db.prepare(
    'INSERT OR REPLACE INTO rules (id, featureId, topic, match, scriptId, config, display, enabled, source, ordering, createdAt, updatedAt) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    row.id, row.featureId, row.topic, row.match, row.scriptId, row.config, row.display,
    row.enabled, row.source, row.ordering, row.createdAt, row.updatedAt,
  );
  return final;
}

/** Returns true if a row was deleted. */
export function deleteRule(db: RulesDb, id: string): boolean {
  const res = db.prepare('DELETE FROM rules WHERE id = ?').run(id) as { changes?: number };
  return (res.changes ?? 0) > 0;
}

/** Used on feature uninstall. Returns the number of rows deleted. */
export function deleteRulesByFeature(db: RulesDb, featureId: string): number {
  const res = db.prepare('DELETE FROM rules WHERE featureId = ?').run(featureId) as { changes?: number };
  return res.changes ?? 0;
}

/**
 * Reconcile the set of manifest-declared rules for a feature.
 *
 * - Computes content-hash ids for each declared rule.
 * - Inserts new rows, updates rows whose id already matches (no-op if
 *   nothing changed), and deletes manifest rows for this feature whose
 *   id is no longer in the declared set.
 * - Leaves user/runtime rules for the same feature alone.
 *
 * Returns the persisted rules (in declaration order).
 */
export function syncManifestRules(
  db: RulesDb,
  featureId: string,
  declared: ManifestRule[],
  nowMs: number,
): Rule[] {
  const wantIds = new Set<string>();
  const persisted: Rule[] = [];

  for (const m of declared) {
    const id = computeManifestRuleId(featureId, m);
    wantIds.add(id);
    const rule: Rule = {
      id,
      featureId,
      topic: m.topic,
      match: m.match ?? {},
      scriptId: m.scriptId,
      config: m.config ?? {},
      display: m.display ?? null,
      enabled: m.enabled !== false,
      source: 'manifest',
      ordering: m.ordering ?? 0,
      createdAt: nowMs,
      updatedAt: nowMs,
    };
    persisted.push(upsertRule(db, rule));
  }

  // Drop manifest rows for this feature that the manifest no longer declares.
  const stale = db
    .prepare("SELECT id FROM rules WHERE featureId = ? AND source = 'manifest'")
    .all(featureId) as Array<{ id: string }>;
  for (const row of stale) {
    if (!wantIds.has(row.id)) {
      deleteRule(db, row.id);
    }
  }

  return persisted;
}
