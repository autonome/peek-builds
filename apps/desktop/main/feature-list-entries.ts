/**
 * Pure helpers for the `tile:features:list` response shape.
 *
 * Two stores describe a feature and neither is sufficient alone:
 *   - `feature-registry.ts` persists INSTALL metadata (source, path,
 *     publisher, capability grants, update policy) to registry.json.
 *   - `manifest-cache.ts` holds the PARSED MANIFEST declarations
 *     (description, commands, settingsSchema path) in SQLite.
 *
 * The Features Manager needs both — a description to render, and the
 * declared commands to know whether a feature has a window to open.
 * This module joins them at the IPC boundary.
 *
 * Deliberately NOT by widening `FeatureRegistryEntry`: that type is
 * serialized verbatim into registry.json, so manifest data hung off it
 * would be duplicated to disk and drift from the manifest — exactly
 * what manifest_cache exists to prevent. The join produces a distinct
 * `FeatureListEntry` that lives only in the IPC response.
 *
 * Electron-free and side-effect-free (no session, no SQLite handle) so
 * the join and the open-command rule are directly unit-testable —
 * same reasoning as `chrome-extensions-helpers.ts`.
 */

import type { FeatureRegistryEntry } from './feature-registry.js';

// ─── Types ──────────────────────────────────────────────────────────

/**
 * Declarative command action, narrowed from the manifest cache's
 * `unknown`. Mirrors `TileCommand['action']` in tile-manifest.ts.
 */
export interface FeatureCommandAction {
  type?: string;
  url?: string;
  topic?: string;
  options?: Record<string, unknown>;
}

/** A command as surfaced to the Features Manager. */
export interface FeatureCommandSummary {
  name: string;
  description?: string;
  action?: FeatureCommandAction;
}

/**
 * The one command that opens a feature's primary window, resolved by
 * `pickOpenCommand`. Carries everything the renderer needs to call
 * `api.window.open(url, options)` — it never re-derives the rule.
 */
export interface FeatureOpenCommand {
  /** Declaring command's name (e.g. "open tags"). */
  name: string;
  /** `action.url` — guaranteed non-empty. */
  url: string;
  /** `action.options` from the manifest (key/width/height/title/role). */
  options?: Record<string, unknown>;
}

/**
 * A registry entry enriched with manifest-cache facts. Purely additive
 * over `FeatureRegistryEntry` — every existing consumer reads named
 * fields, so the extra ones break nothing.
 */
export interface FeatureListEntry extends FeatureRegistryEntry {
  /** Manifest `description`. Absent when uncached or undeclared. */
  description?: string;
  /** Declared commands (name + action), for command-aware UI. */
  commands?: FeatureCommandSummary[];
  /**
   * The manifest's declared `settingsSchema` RELATIVE PATH — not the
   * schema contents. Lets the Features Manager decide whether to render
   * an Options toggle without a disk read; the contents are fetched
   * lazily via `tile:features:settings-schema` only when expanded.
   */
  settingsSchema?: string;
  /** Resolved primary window command, when the feature declares one. */
  openCommand?: FeatureOpenCommand;
  /**
   * Per-session load failure from `tile-loader.ts`, joined in from
   * `feature-startup.ts`'s in-memory map — NEVER persisted to
   * registry.json (see module header). Absent when the feature loaded
   * cleanly, or hasn't been attempted yet.
   */
  loadError?: string;
}

/**
 * Structural minimum of a `manifest-cache` row. Declared structurally
 * (rather than importing ManifestCacheRow) to keep this module free of
 * the SQLite-backed module — a real `ManifestCacheRow[]` satisfies it,
 * and tests can pass plain literals.
 */
export interface ManifestCacheRowLike {
  featureId: string;
  manifest?: {
    description?: string;
    shortname?: string;
    settingsSchema?: string;
  } | null;
  commands?: Array<{ name: string; description?: string; action?: unknown }>;
}

/**
 * Structural minimum of `tile-loader.ts`'s `FeatureLoadResult`. Declared
 * structurally (rather than imported) to keep this module Electron-free
 * and free of tile-loader/feature-startup — see module header.
 */
export interface FeatureLoadOutcome {
  id: string;
  loaded: boolean;
  error?: string;
  skipped?: boolean;
}

// ─── Open-command rule ──────────────────────────────────────────────

/** Narrow the cache's `action: unknown` to the declarative shape. */
export function normalizeCommandAction(action: unknown): FeatureCommandAction | undefined {
  if (!action || typeof action !== 'object') return undefined;
  const a = action as Record<string, unknown>;
  return {
    type: typeof a.type === 'string' ? a.type : undefined,
    url: typeof a.url === 'string' ? a.url : undefined,
    topic: typeof a.topic === 'string' ? a.topic : undefined,
    options: (a.options && typeof a.options === 'object')
      ? a.options as Record<string, unknown>
      : undefined,
  };
}

function isWindowCommand(cmd: FeatureCommandSummary): boolean {
  return cmd.action?.type === 'window' && !!cmd.action.url;
}

/**
 * Resolve the single command that should back a feature's "Open"
 * button, or null when the feature has no window to open.
 *
 * A feature is OPENABLE iff it declares at least one command with
 * `action.type === 'window'` AND a non-empty `action.url`. A window
 * action without a url is not openable — `tile-lazy`'s declarative
 * dispatch requires the url too, so a urlless one opens nothing there
 * either.
 *
 * Exactly one button per feature, so when several window commands are
 * declared (e.g. features-manager declares manage / browse / publish)
 * we pick the feature's PRIMARY launcher, in order:
 *   1. a command named exactly for the feature (id or manifest
 *      shortname) — e.g. `dropzone` for the dropzone feature;
 *   2. a command named `open <id>` / `open <shortname>` — the dominant
 *      convention (open tags, open feeds, open spaces, …);
 *   3. failing both, the first window command in manifest order —
 *      manifests list their primary entry point first (features-manager
 *      → "features" → manage.html; wonderwall → "accounts").
 * Name matching is case-insensitive and whitespace-trimmed.
 */
export function pickOpenCommand(
  featureId: string,
  shortname: string | undefined,
  commands: FeatureCommandSummary[] | undefined,
): FeatureOpenCommand | null {
  if (!Array.isArray(commands)) return null;
  const candidates = commands.filter(isWindowCommand);
  if (candidates.length === 0) return null;

  const aliases = [featureId, shortname]
    .filter((a): a is string => !!a)
    .map(a => a.trim().toLowerCase());

  const nameOf = (cmd: FeatureCommandSummary) => cmd.name.trim().toLowerCase();

  const chosen =
    candidates.find(c => aliases.includes(nameOf(c))) ??
    candidates.find(c => aliases.some(a => nameOf(c) === `open ${a}`)) ??
    candidates[0];

  return {
    name: chosen.name,
    url: chosen.action!.url!,
    options: chosen.action!.options,
  };
}

/**
 * Extract per-feature load failures from a `loadFeaturesFromRegistry()`
 * result set, keyed by feature id.
 *
 * `skipped` results are dropped: a feature that is disabled or awaiting
 * approval reports `loaded: false` with a message, but it is a state, not
 * a fault, and flagging it would mark every disabled feature as broken.
 *
 * If two results share an id, the last one wins.
 */
export function collectLoadErrors(results: FeatureLoadOutcome[]): Map<string, string> {
  const errors = new Map<string, string>();
  for (const result of results) {
    if (result.loaded || result.skipped || !result.error) continue;
    errors.set(result.id, result.error);
  }
  return errors;
}

// ─── Join ───────────────────────────────────────────────────────────

/**
 * Join manifest-cache rows onto registry entries by featureId.
 *
 * Entries with no cached row pass through unenriched — a feature whose
 * manifest failed to parse still lists (with its registry metadata),
 * it just gets no description / commands / Open button. Cache rows with
 * no registry entry are ignored: the registry decides what exists.
 *
 * `loadErrors`, when given, joins per-session load failures onto the
 * result — including entries with no cache row, since a manifest-parse
 * failure (the most common load error) is exactly what leaves a feature
 * without one.
 */
export function enrichFeatureEntries(
  entries: FeatureRegistryEntry[],
  rows: ManifestCacheRowLike[],
  loadErrors?: Map<string, string>,
): FeatureListEntry[] {
  const byId = new Map<string, ManifestCacheRowLike>();
  for (const row of rows) byId.set(row.featureId, row);

  return entries.map(entry => {
    const loadError = loadErrors?.get(entry.id);

    const row = byId.get(entry.id);
    if (!row) return loadError ? { ...entry, loadError } : { ...entry };

    const commands: FeatureCommandSummary[] = (row.commands ?? []).map(cmd => ({
      name: cmd.name,
      description: cmd.description,
      action: normalizeCommandAction(cmd.action),
    }));

    const enriched: FeatureListEntry = {
      ...entry,
      description: row.manifest?.description,
      commands,
      settingsSchema: row.manifest?.settingsSchema,
    };

    const openCommand = pickOpenCommand(entry.id, row.manifest?.shortname, commands);
    if (openCommand) enriched.openCommand = openCommand;
    if (loadError) enriched.loadError = loadError;

    return enriched;
  });
}
