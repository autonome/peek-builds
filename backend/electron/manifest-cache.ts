/**
 * manifest_cache — SQLite cache of parsed feature manifests.
 *
 * Writes: only two call-sites.
 *   - `upsertFromManifest(featureId, manifestPath)` invoked by the feature
 *     installer when a feature lands or updates, and by boot-time
 *     builtin discovery when seeding ephemeral/dev profiles.
 *   - `setDisabled(featureId, true|false)` toggled by the Features pane.
 *
 * Reads: consumed by cmd panel (static command surface), shortcut
 * registry, lazyEvents interceptor, Features pane listing.
 *
 * Not yet wired — this module ships as Phase A scaffolding. Phase B
 * routes the installer + boot-discovery through here. Phase C switches
 * the cmd panel / shortcut registrar / lazyEvents to read from here
 * instead of listening for tile publishes.
 *
 * Desktop-only (better-sqlite3 is main-process). Authoritative state
 * lives here; renderer-side consumers get snapshots via strict
 * `tile:features:*` IPC.
 *
 * Distinct from `backend/electron/feature-registry.ts`, which stores
 * install metadata (source, publisher, capability grants, update
 * policy) in `registry.json`. This file is the **manifest declaration
 * cache** — what commands/nouns/shortcuts each feature declares.
 *
 * See docs/tile-lifecycle-fsm.md.
 */

import { getDb } from './datastore.js';
import { parseManifestFile, resolveCapabilities } from './tile-manifest.js';
import type { TileManifest, CapabilityGrant } from './tile-manifest.js';

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export interface ManifestCacheRow {
  featureId: string;
  version: string;
  manifest: TileManifest;
  commands: ManifestCommandDecl[];
  nouns: ManifestNounDecl[];
  shortcuts: ManifestShortcutDecl[];
  capabilities: CapabilityGrant;
  lazyEvents: Array<{ topic: string; command: string }>;
  updatedAt: number;
  disabledAt: number | null;
}

export interface ManifestCommandDecl {
  name: string;
  description?: string;
  action?: unknown;                 // declarative action shape (execute | window | publish)
  scope?: string;
  modes?: string[];
  accepts?: string[];
  produces?: string[];
  params?: unknown[];
}

export interface ManifestNounDecl {
  name: string;                     // plural
  singular: string;
  description?: string;
  hasQuery?: boolean;
  hasBrowse?: boolean;
  hasOpen?: boolean;
  hasCreate?: boolean;
  produces?: string | null;
  params?: unknown[];
  modes?: string[];
  skipBare?: boolean;
}

export interface ManifestShortcutDecl {
  keys: string;
  command: string;
  global?: boolean;
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

/**
 * Parse a manifest file and upsert its cached declarations into the
 * `manifest_cache` table. Idempotent — safe to call on every boot for
 * builtins and on every install/update.
 *
 * The manifest's declared `id` must match the passed `featureId`.
 *
 * Throws on parse error (caller decides whether to skip or surface).
 */
export function upsertFromManifest(featureId: string, manifestPath: string): ManifestCacheRow {
  const parseResult = parseManifestFile(manifestPath);
  if (!parseResult) {
    throw new Error(`[manifest-cache] ${featureId}: manifest missing or invalid at ${manifestPath}`);
  }
  if (parseResult.version !== 'tile' || !parseResult.manifest) {
    throw new Error(`[manifest-cache] ${featureId}: legacy manifests not cached`);
  }
  const manifest = parseResult.manifest;
  if (manifest.id !== featureId) {
    throw new Error(`[manifest-cache] manifest id mismatch: file=${featureId} manifest=${manifest.id}`);
  }

  // Resolve capabilities the same way the tile launcher does so the
  // cached grant matches what the tile would receive at load time.
  const capabilities = resolveCapabilities(manifest.id, manifest.capabilities ?? {}, manifest.builtin === true);

  const commands = extractCommands(manifest);
  const nouns = extractNouns(manifest);
  const shortcuts = extractShortcuts(manifest);
  const lazyEvents = extractLazyEvents(manifest);

  const row: ManifestCacheRow = {
    featureId,
    version: manifest.version ?? '0.0.0',
    manifest,
    commands,
    nouns,
    shortcuts,
    capabilities,
    lazyEvents,
    updatedAt: Date.now(),
    disabledAt: null,
  };

  writeRow(row);
  return row;
}

function writeRow(row: ManifestCacheRow): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO manifest_cache (
      featureId, version, manifest, commands, nouns, shortcuts,
      capabilities, lazyEvents, updatedAt, disabledAt
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(featureId) DO UPDATE SET
      version = excluded.version,
      manifest = excluded.manifest,
      commands = excluded.commands,
      nouns = excluded.nouns,
      shortcuts = excluded.shortcuts,
      capabilities = excluded.capabilities,
      lazyEvents = excluded.lazyEvents,
      updatedAt = excluded.updatedAt,
      disabledAt = COALESCE(manifest_cache.disabledAt, excluded.disabledAt)
  `).run(
    row.featureId,
    row.version,
    JSON.stringify(row.manifest),
    JSON.stringify(row.commands),
    JSON.stringify(row.nouns),
    JSON.stringify(row.shortcuts),
    JSON.stringify(row.capabilities),
    JSON.stringify(row.lazyEvents),
    row.updatedAt,
    row.disabledAt,
  );
}

/**
 * Remove a feature's cached declarations. Call on uninstall.
 */
export function remove(featureId: string): void {
  getDb().prepare('DELETE FROM manifest_cache WHERE featureId = ?').run(featureId);
}

/**
 * Toggle the disabled flag. `true` stamps `disabledAt = now`; `false`
 * clears it.
 */
export function setDisabled(featureId: string, disabled: boolean): void {
  const disabledAt = disabled ? Date.now() : null;
  getDb()
    .prepare('UPDATE manifest_cache SET disabledAt = ? WHERE featureId = ?')
    .run(disabledAt, featureId);
}

/**
 * Clear the entire table. Used when booting an ephemeral profile so
 * fresh manifest discovery repopulates from disk.
 */
export function clearAll(): void {
  getDb().prepare('DELETE FROM manifest_cache').run();
}

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

/**
 * Fetch a single feature's cached row, or null if not present.
 */
export function get(featureId: string): ManifestCacheRow | null {
  const raw = getDb()
    .prepare('SELECT * FROM manifest_cache WHERE featureId = ?')
    .get(featureId) as RawRow | undefined;
  return raw ? parseRow(raw) : null;
}

/**
 * List every cached row, optionally including disabled features.
 * Default returns enabled only — matches what cmd panel / shortcut
 * registry want.
 */
export function list(options: { includeDisabled?: boolean } = {}): ManifestCacheRow[] {
  const where = options.includeDisabled ? '' : 'WHERE disabledAt IS NULL';
  const rows = getDb().prepare(`SELECT * FROM manifest_cache ${where}`).all() as RawRow[];
  return rows.map(parseRow);
}

/**
 * Flat list of every declared command across every enabled feature.
 * Each entry tagged with its source `featureId` so the cmd panel can
 * route execution to the right tile. Used as the cold-start command
 * set for the cmd panel.
 */
export function listAllCommands(): Array<ManifestCommandDecl & { featureId: string }> {
  const rows = list();
  const out: Array<ManifestCommandDecl & { featureId: string }> = [];
  for (const row of rows) {
    for (const cmd of row.commands) {
      out.push({ ...cmd, featureId: row.featureId });
    }
  }
  return out;
}

/**
 * Flat list of every declared noun across every enabled feature.
 */
export function listAllNouns(): Array<ManifestNounDecl & { featureId: string }> {
  const rows = list();
  const out: Array<ManifestNounDecl & { featureId: string }> = [];
  for (const row of rows) {
    for (const noun of row.nouns) {
      out.push({ ...noun, featureId: row.featureId });
    }
  }
  return out;
}

/**
 * Flat list of every declared shortcut across every enabled feature.
 */
export function listAllShortcuts(): Array<ManifestShortcutDecl & { featureId: string }> {
  const rows = list();
  const out: Array<ManifestShortcutDecl & { featureId: string }> = [];
  for (const row of rows) {
    for (const sc of row.shortcuts) {
      out.push({ ...sc, featureId: row.featureId });
    }
  }
  return out;
}

/**
 * Flat list of every declared lazyEvent interceptor across every
 * enabled feature. Used by the lazy-event interceptor registrar at
 * boot to subscribe without loading any tiles.
 */
export function listAllLazyEvents(): Array<{ topic: string; command: string; featureId: string }> {
  const rows = list();
  const out: Array<{ topic: string; command: string; featureId: string }> = [];
  for (const row of rows) {
    for (const le of row.lazyEvents) {
      out.push({ ...le, featureId: row.featureId });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface RawRow {
  featureId: string;
  version: string;
  manifest: string;
  commands: string | null;
  nouns: string | null;
  shortcuts: string | null;
  capabilities: string | null;
  lazyEvents: string | null;
  updatedAt: number;
  disabledAt: number | null;
}

function parseRow(raw: RawRow): ManifestCacheRow {
  return {
    featureId: raw.featureId,
    version: raw.version,
    manifest: safeJson<TileManifest>(raw.manifest, null as unknown as TileManifest),
    commands: safeJson<ManifestCommandDecl[]>(raw.commands ?? '[]', []),
    nouns: safeJson<ManifestNounDecl[]>(raw.nouns ?? '[]', []),
    shortcuts: safeJson<ManifestShortcutDecl[]>(raw.shortcuts ?? '[]', []),
    capabilities: safeJson<CapabilityGrant>(raw.capabilities ?? 'null', null as unknown as CapabilityGrant),
    lazyEvents: safeJson<Array<{ topic: string; command: string }>>(raw.lazyEvents ?? '[]', []),
    updatedAt: raw.updatedAt,
    disabledAt: raw.disabledAt,
  };
}

function safeJson<T>(str: string, fallback: T): T {
  try {
    return JSON.parse(str) as T;
  } catch {
    return fallback;
  }
}

function extractCommands(manifest: TileManifest): ManifestCommandDecl[] {
  if (!Array.isArray(manifest.commands)) return [];
  return manifest.commands.map(cmd => ({
    name: cmd.name,
    description: cmd.description,
    action: (cmd as { action?: unknown }).action,
    scope: (cmd as { scope?: string }).scope,
    modes: (cmd as { modes?: string[] }).modes,
    accepts: (cmd as { accepts?: string[] }).accepts,
    produces: (cmd as { produces?: string[] }).produces,
    params: (cmd as { params?: unknown[] }).params,
  }));
}

function extractNouns(manifest: TileManifest): ManifestNounDecl[] {
  // Manifests don't yet declare nouns statically — nouns come from
  // runtime `registerNoun()` calls. Phase C will extend the manifest
  // schema to allow static noun declarations so browse/list commands
  // can surface without loading the tile; for now this returns [] and
  // nouns still register dynamically.
  const nouns = (manifest as { nouns?: ManifestNounDecl[] }).nouns;
  return Array.isArray(nouns) ? nouns : [];
}

function extractShortcuts(manifest: TileManifest): ManifestShortcutDecl[] {
  if (!Array.isArray(manifest.shortcuts)) return [];
  return manifest.shortcuts.map(sc => ({
    keys: sc.keys,
    command: sc.command,
    global: (sc as { global?: boolean }).global,
  }));
}

function extractLazyEvents(manifest: TileManifest): Array<{ topic: string; command: string }> {
  const out: Array<{ topic: string; command: string }> = [];
  if (!Array.isArray(manifest.tiles)) return out;
  for (const tile of manifest.tiles) {
    const lazyEvents = (tile as { lazyEvents?: Array<{ topic: string; command: string }> }).lazyEvents;
    if (Array.isArray(lazyEvents)) {
      for (const e of lazyEvents) out.push(e);
    }
  }
  return out;
}

// Boot-time discovery lives in `feature-startup.ts` — it subscribes to
// the registry's mutation listener and walks the loaded registry at
// startup, so every install/uninstall/disable path automatically keeps
// the cache in step without this module having to re-scan the disk.
