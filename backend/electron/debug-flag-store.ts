/**
 * Datastore persistence for the runtime debug flags.
 *
 * Kept separate from `debug-flag.ts` so that module can stay pure (no
 * Electron / datastore imports) and trivially unit-testable. This file
 * is the only place debug-flag state touches SQLite.
 *
 * Storage convention:
 *   feature_settings row with featureId='debug', key='prefs',
 *   value=JSON `{ verbose: boolean, devtools: boolean }`.
 *
 * Single composite row matches the convention used by other features
 * (editor, peeks, etc.) so the Settings UI auto-discovery pattern works:
 * the schema in `features/debug/settings-schema.json` reads/writes the
 * same `prefs` key, and both surfaces stay in sync.
 */

import { getDb } from './datastore.js';
import {
  initDebugFlags,
  getDebugFlags,
  onDebugFlagsChange,
} from './debug-flag.js';

const FEATURE_ID = 'debug';
const PREFS_KEY = 'prefs';

/**
 * Read both flags from the datastore. Returns `undefined` for any flag
 * that the persisted JSON omits or that doesn't parse as a boolean — the
 * caller (`installDebugFlagsPersistence`) decides the fallback (env for
 * verbose, false for devtools).
 */
export function loadDebugFlagsFromDatastore(): {
  verbose?: boolean;
  devtools?: boolean;
} {
  const db = getDb();
  const row = db.prepare(
    `SELECT value FROM feature_settings WHERE featureId = ? AND key = ?`
  ).get(FEATURE_ID, PREFS_KEY) as { value: string } | undefined;

  if (!row?.value) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    // Malformed JSON — drop to defaults rather than crash boot.
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};

  const obj = parsed as Record<string, unknown>;
  const out: { verbose?: boolean; devtools?: boolean } = {};
  if (typeof obj.verbose === 'boolean') out.verbose = obj.verbose;
  if (typeof obj.devtools === 'boolean') out.devtools = obj.devtools;
  return out;
}

/**
 * Write both flags' current state to the datastore as a single composite
 * `prefs` row. Idempotent at the SQL level (INSERT OR REPLACE).
 */
export function persistDebugFlags(): void {
  const state = getDebugFlags();
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    `${FEATURE_ID}-${PREFS_KEY}`,
    FEATURE_ID,
    PREFS_KEY,
    JSON.stringify(state),
    Date.now(),
  );
}

/**
 * Boot-time hydration. Call once after the datastore is open and migrations
 * have run. Seeds debug-flag module state from persisted values, falling
 * back to environment defaults for any unset key. Subsequent mutations via
 * setDebug/setDevTools are persisted automatically via the change listener
 * installed here.
 *
 * Idempotent: safe to call multiple times, though there's no reason to.
 */
let _installed = false;
export function installDebugFlagsPersistence(): void {
  const stored = loadDebugFlagsFromDatastore();
  initDebugFlags({
    verbose: stored.verbose,   // undefined → falls back to process.env.DEBUG
    devtools: stored.devtools, // undefined → defaults to false
  });

  if (_installed) return;
  _installed = true;

  // Persist on every change. `onDebugFlagsChange` fires only on real flips
  // (idempotent setters short-circuit identical values), so this won't spam
  // writes when the IPC handler is called with already-current state.
  onDebugFlagsChange(() => {
    try {
      persistDebugFlags();
    } catch {
      // Persistence failure must never crash the toggle — the in-process
      // state remains correct for the rest of the session; the user's next
      // launch will just re-fall-back to defaults.
    }
  });
}

/**
 * Reset persistence state for unit tests. Drops the installed flag so the
 * listener can be re-registered against a fresh debug-flag module state.
 */
export function __resetDebugFlagsPersistenceForTest(): void {
  _installed = false;
}
