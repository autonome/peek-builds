/**
 * Capability-comparison + semver helpers for the feature auto-update gate.
 *
 * THIS MODULE IS THE SINGLE SOURCE OF TRUTH for the security boundary that
 * stops a feature publisher from silently broadening permissions via an
 * "auto" update. The `tile:features:update-apply` handler in tile-ipc.ts
 * calls `compareCapabilities`, `compareSemver`, and `evaluateUpdateGate`
 * from here — and `capability-compare.test.ts` tests THOSE SAME functions
 * directly, so the tested code IS the gate's code.
 *
 * Previously two divergent impls existed:
 *   - `compareCapabilitiesSimple` / `compareSemverSimple` (the live gate, in
 *     tile-ipc.ts) — had ZERO tests.
 *   - `compareCapabilities` / `shouldAutoUpdate` (features-manager/updater.js)
 *     — was tested, but was dead renderer code the gate never called.
 * The suite was green while the gate ran unverified. This module collapses
 * them into one tested implementation. (The renderer's dead copy was
 * removed; updater.js retains only its live `compareSemver` for browse.js,
 * which cannot import this dist/main module across the peek:// boundary.)
 *
 * The unified impl is a SUPERSET of both prior versions: it covers every
 * boolean-ish capability the manifest can declare (not just the five the
 * renderer copy checked), and it compares pubsub topics (which the gate
 * copy omitted). A unified gate must never be weaker than either input.
 */

import type { TileCapabilities } from './tile-manifest.js';

// ─── Semver Comparison ──────────────────────────────────────────────

/**
 * Compare two semver strings. Returns -1 if a < b, 0 if equal, 1 if a > b.
 * Missing / malformed segments are treated as 0.
 */
export function compareSemver(a: string | null | undefined, b: string | null | undefined): number {
  const pa = (a || '0.0.0').split('.').map(Number);
  const pb = (b || '0.0.0').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

// ─── Capability Comparison ──────────────────────────────────────────

export interface CapabilityComparison {
  changed: boolean;
  expanded: boolean;
  added: string[];
  removed: string[];
}

/**
 * Every capability that is meaningfully present-or-absent (boolean, or an
 * object form we treat as present/absent for expansion detection — deeper
 * allowlist diffs for the object forms are handled per-field below where
 * they carry arrays). This is the gate's expansion surface for the simple
 * "did they turn on a new permission class" check.
 */
const PRESENCE_CAPS: Array<keyof TileCapabilities> = [
  'commands',
  'shortcuts',
  'sync',
  'theme',
  'settings',
  'context',
  'dialogs',
  'features',
  'oauth',
  'session',
  'rules',
];

/**
 * Compare two TileCapabilities objects to detect changes and expansions.
 *
 * `expanded` is true if `newCaps` requests anything not already granted by
 * `currentCaps`: a new presence capability, a new network domain, a new
 * datastore table, a new pubsub scope or topic, a new window sub-permission,
 * or a new filesystem path. Removals set `changed` but never `expanded`.
 */
export function compareCapabilities(
  currentCaps: TileCapabilities | null | undefined,
  newCaps: TileCapabilities | null | undefined,
): CapabilityComparison {
  const result: CapabilityComparison = { changed: false, expanded: false, added: [], removed: [] };

  if (!currentCaps && !newCaps) return result;
  const cur = (currentCaps || {}) as TileCapabilities;
  const nxt = (newCaps || {}) as TileCapabilities;

  // ── Presence capabilities (boolean or object-treated-as-present) ──
  for (const cap of PRESENCE_CAPS) {
    const had = !!cur[cap];
    const has = !!nxt[cap];
    if (!had && has) { result.changed = true; result.expanded = true; result.added.push(cap); }
    else if (had && !has) { result.changed = true; result.removed.push(cap); }
  }

  // ── Network domains ──
  diffSet(cur.network?.domains, nxt.network?.domains, 'network', result);

  // ── Datastore tables ──
  diffSet(cur.datastore?.tables, nxt.datastore?.tables, 'datastore', result);

  // ── PubSub scopes + topics ──
  comparePubsub(cur.pubsub, nxt.pubsub, result);

  // ── Window ──
  compareWindow(cur.window, nxt.window, result);

  // ── Filesystem ──
  compareFilesystem(cur.filesystem, nxt.filesystem, result);

  return result;
}

/**
 * Diff two string lists as sets. Added entries are expansions; removed
 * entries are reductions. `label` namespaces the emitted change strings
 * (e.g. `network:evil.com`).
 */
function diffSet(
  curArr: string[] | undefined,
  nxtArr: string[] | undefined,
  label: string,
  result: CapabilityComparison,
): void {
  const cur = new Set(curArr || []);
  const nxt = new Set(nxtArr || []);
  for (const item of nxt) {
    if (!cur.has(item)) { result.changed = true; result.expanded = true; result.added.push(`${label}:${item}`); }
  }
  for (const item of cur) {
    if (!nxt.has(item)) { result.changed = true; result.removed.push(`${label}:${item}`); }
  }
}

function comparePubsub(
  cur: TileCapabilities['pubsub'],
  nxt: TileCapabilities['pubsub'],
  result: CapabilityComparison,
): void {
  const had = !!cur;
  const has = !!nxt;
  if (!had && !has) return;
  if (!had && has) { result.changed = true; result.expanded = true; result.added.push('pubsub'); return; }
  if (had && !has) { result.changed = true; result.removed.push('pubsub'); return; }
  diffSet(cur!.scopes, nxt!.scopes, 'pubsub.scope', result);
  diffSet(cur!.topics, nxt!.topics, 'pubsub.topic', result);
}

function compareWindow(
  cur: TileCapabilities['window'],
  nxt: TileCapabilities['window'],
  result: CapabilityComparison,
): void {
  const had = !!cur;
  const has = !!nxt;
  if (!had && !has) return;
  if (!had && has) { result.changed = true; result.expanded = true; result.added.push('window'); return; }
  if (had && !has) { result.changed = true; result.removed.push('window'); return; }
  // Both present. Boolean form has no sub-perms to diff; object form does.
  const curObj = (typeof cur === 'object' ? cur : {}) as Record<string, boolean>;
  const nxtObj = (typeof nxt === 'object' ? nxt : {}) as Record<string, boolean>;
  for (const perm of ['create', 'query', 'manage'] as const) {
    const h = !!curObj[perm];
    const n = !!nxtObj[perm];
    if (!h && n) { result.changed = true; result.expanded = true; result.added.push(`window.${perm}`); }
    else if (h && !n) { result.changed = true; result.removed.push(`window.${perm}`); }
  }
}

function compareFilesystem(
  cur: TileCapabilities['filesystem'],
  nxt: TileCapabilities['filesystem'],
  result: CapabilityComparison,
): void {
  const had = !!cur;
  const has = !!nxt;
  if (!had && !has) return;
  if (!had && has) { result.changed = true; result.expanded = true; result.added.push('filesystem'); return; }
  if (had && !has) { result.changed = true; result.removed.push('filesystem'); return; }
  diffSet(cur!.read, nxt!.read, 'filesystem.read', result);
  diffSet(cur!.write, nxt!.write, 'filesystem.write', result);
}

// ─── Auto-Update Gate Decision ──────────────────────────────────────

export type UpdateGateDecision =
  | { allow: true; comparison: CapabilityComparison }
  | { allow: false; reason: 'not-newer' }
  | { allow: false; reason: 'capabilities-expanded'; comparison: CapabilityComparison };

export interface UpdateGateInput {
  currentVersion: string | null | undefined;
  newVersion: string | null | undefined;
  currentCapabilities: TileCapabilities | null | undefined;
  newCapabilities: TileCapabilities | null | undefined;
  /** True when the user has explicitly approved this update (consent UI). */
  userApproved?: boolean;
}

/**
 * The pure decision the `tile:features:update-apply` handler enforces before
 * installing a new version. Two gates:
 *
 *   1. Version monotonicity — refuse anything not strictly newer (blocks
 *      downgrade / replay of an older, possibly-broader manifest).
 *   2. Capability expansion — if the new manifest requests more than was
 *      granted, refuse UNLESS the user explicitly approved. This is the
 *      privilege-escalation boundary for silent "auto" updates.
 *
 * The handler calls THIS function; the test exercises THIS function — so the
 * gate path is verified without standing up the full IPC handler.
 */
export function evaluateUpdateGate(input: UpdateGateInput): UpdateGateDecision {
  if (compareSemver(input.newVersion || '0.0.0', input.currentVersion || '0.0.0') <= 0) {
    return { allow: false, reason: 'not-newer' };
  }
  const comparison = compareCapabilities(input.currentCapabilities, input.newCapabilities);
  if (comparison.expanded && !input.userApproved) {
    return { allow: false, reason: 'capabilities-expanded', comparison };
  }
  return { allow: true, comparison };
}
