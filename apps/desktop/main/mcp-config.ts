/**
 * MCP config writer — manages the `mcpServers.peek` entry in
 * ~/.claude.json (Claude Code's user-scope config) from the Settings UI
 * toggle.
 *
 * Config-location facts (Claude Code 2.1.204): user scope lives in
 * ~/.claude.json as top-level `mcpServers`; project scope lives in
 * <project>/.mcp.json. Claude Code does NOT read `mcpServers` from
 * ~/.claude/settings.json — that location is silently ignored, which is
 * why Peek writes ~/.claude.json instead. `migrateMcpConfigLocation()`
 * moves any pre-existing entry off the dead settings.json path.
 *
 * Off by default: the entry is only present after the user opts in via
 * Settings → Core → "Expose Peek to Claude Code (MCP)".
 */

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { planMcpConfigMigration } from './mcp-config-migration.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Profile directory base. macOS-only for now; mirrors entry.ts profile layout.
const PROFILES_BASE = path.join(os.homedir(), 'Library', 'Application Support', 'Peek');

// Only packaged + default profile writes to the real Claude config
// (~/.claude.json, Claude Code's user-scope file). Dev builds and
// non-default profiles get a sandbox path inside their own userData dir so
// they can't trample a user's real ~/.claude.json.
function settingsPath(): string {
  const activeProfile = path.basename(app.getPath('userData'));
  if (app.isPackaged && activeProfile === 'default') {
    return path.join(os.homedir(), '.claude.json');
  }
  return path.join(app.getPath('userData'), 'mcp-sandbox', 'claude.json');
}

interface McpSnippet {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpConfig {
  enabled: boolean;
  profile: string;
  readonly: boolean;
  scopeTag: string;
}

function listProfiles(): string[] {
  try {
    return fs.readdirSync(PROFILES_BASE)
      .filter((name) => {
        try {
          return fs.existsSync(path.join(PROFILES_BASE, name, 'datastore.sqlite'));
        } catch { return false; }
      })
      .sort();
  } catch {
    return [];
  }
}

function dbPathForProfile(profile: string): string {
  return path.join(PROFILES_BASE, profile, 'datastore.sqlite');
}

function defaultProfile(): string {
  const profiles = listProfiles();
  if (profiles.includes('default')) return 'default';
  // Fall back to the running profile, then any profile, then literal 'default'.
  const active = path.basename(app.getPath('userData'));
  if (active && profiles.includes(active)) return active;
  return profiles[0] ?? 'default';
}

function buildSnippet(opts: { profile: string; readonly: boolean; scopeTag: string }): McpSnippet {
  const env: Record<string, string> = { PEEK_DB_PATH: dbPathForProfile(opts.profile) };
  if (opts.readonly) env.PEEK_MCP_READONLY = '1';
  if (opts.scopeTag) env.PEEK_MCP_SCOPE_TAG = opts.scopeTag;
  if (app.isPackaged) {
    // Launcher at <Peek.app>/Contents/Resources/peek-mcp. Bundles its
    // own Electron-as-Node runtime, so users need no system Node.
    return { command: path.join(process.resourcesPath, 'peek-mcp'), env };
  }
  // Dev: invoke server.js directly via system node.
  // __dirname at runtime is apps/desktop/dist/main, server.js lives at
  // apps/desktop/features/mcp-server/server.js.
  const serverJs = path.resolve(
    __dirname, '..', '..', 'features', 'mcp-server', 'server.js',
  );
  return {
    command: 'node',
    args: ['--experimental-sqlite', serverJs],
    env,
  };
}

function inferFromConfigured(configured: McpSnippet | null): { profile: string; readonly: boolean; scopeTag: string } {
  // Fresh state defaults to read-only — writes are off by default so an
  // agent can never destroy items without an explicit opt-in.
  if (!configured) return { profile: defaultProfile(), readonly: true, scopeTag: '' };
  const dbPath = configured.env?.PEEK_DB_PATH || '';
  let profile = defaultProfile();
  const prefix = PROFILES_BASE + path.sep;
  if (dbPath.startsWith(prefix)) {
    profile = dbPath.slice(prefix.length).split(path.sep)[0] || profile;
  }
  const readonly = configured.env?.PEEK_MCP_READONLY === '1';
  const scopeTag = (configured.env?.PEEK_MCP_SCOPE_TAG || '').trim();
  return { profile, readonly, scopeTag };
}

function snippetsMatch(a: McpSnippet, b: McpSnippet): boolean {
  if (a.command !== b.command) return false;
  const aArgs = a.args ?? [];
  const bArgs = b.args ?? [];
  if (aArgs.length !== bArgs.length) return false;
  for (let i = 0; i < aArgs.length; i++) {
    if (aArgs[i] !== bArgs[i]) return false;
  }
  const aEnv = a.env ?? {};
  const bEnv = b.env ?? {};
  const aKeys = Object.keys(aEnv).sort();
  const bKeys = Object.keys(bEnv).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false;
    if (aEnv[aKeys[i]] !== bEnv[bKeys[i]]) return false;
  }
  return true;
}

function readSettings(): Record<string, unknown> {
  try {
    if (!fs.existsSync(settingsPath())) return {};
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'));
  } catch {
    return {};
  }
}

// Atomic write: ~/.claude.json is Claude Code's live state file (auth,
// projects, history), so a torn write would corrupt it. Write to a temp
// sibling then rename onto the target — rename is atomic on the same fs.
function atomicWriteJson(target: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.peek-tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, target);
}

function writeSettings(data: Record<string, unknown>): void {
  atomicWriteJson(settingsPath(), data);
}

export interface McpStatus extends McpConfig {
  expectedCommand: string;
  configuredCommand: string | null;
  // True when a peek entry is present but its command/env no longer matches
  // what this build generates (e.g. left over from a prior install). The
  // entry is still "enabled" — this just flags that it should be re-saved to
  // point at the current launcher.
  stale: boolean;
  settingsPath: string;
  profiles: string[];
  configuredAt: number | null;
}

export function getMcpStatus(): McpStatus {
  const settings = readSettings() as { mcpServers?: Record<string, McpSnippet> };
  const configured = settings.mcpServers?.peek ?? null;
  const inferred = inferFromConfigured(configured);
  const expected = buildSnippet(inferred);
  let configuredAt: number | null = null;
  if (configured) {
    try { configuredAt = fs.statSync(settingsPath()).mtimeMs; } catch {}
  }
  return {
    // A present peek entry means enabled — do NOT gate this on a byte-exact
    // snippet match. A reinstall that changes the generated command path or
    // env shape would otherwise flip a working, present config to "not
    // configured" (blank Settings), tricking the user into re-enabling with
    // defaults and silently dropping their scope tag. Staleness is surfaced
    // separately via `stale` so the UI can nudge a re-save without hiding the
    // config.
    enabled: !!configured,
    stale: !!configured && !snippetsMatch(configured, expected),
    profile: inferred.profile,
    readonly: inferred.readonly,
    scopeTag: inferred.scopeTag,
    expectedCommand: expected.command,
    configuredCommand: configured?.command ?? null,
    settingsPath: settingsPath(),
    profiles: listProfiles(),
    configuredAt,
  };
}

// ── Per-project scope scaffolding ────────────────────────────────────
//
// Backs the Settings UI's "Project scopes" affordance. Writes
// individual project .mcp.json files (same shape peek-mcp-init writes)
// and keeps a registry inside the active profile's userData dir so the
// UI can re-list, edit, and remove them later.

interface ScopedProjectEntry {
  path: string;
  addedAt: number;
}

export interface ScopedProject {
  path: string;
  exists: boolean;
  scopeTag: string;
  profile: string;
  readonly: boolean;
  configuredAt: number | null;
}

function registryPath(): string {
  return path.join(app.getPath('userData'), 'mcp-scoped-projects.json');
}

function readRegistry(): ScopedProjectEntry[] {
  try {
    const data = JSON.parse(fs.readFileSync(registryPath(), 'utf-8'));
    if (!Array.isArray(data)) return [];
    return data.filter((e) => e && typeof e.path === 'string');
  } catch {
    return [];
  }
}

function writeRegistry(entries: ScopedProjectEntry[]): void {
  fs.mkdirSync(path.dirname(registryPath()), { recursive: true });
  fs.writeFileSync(registryPath(), JSON.stringify(entries, null, 2) + '\n', 'utf-8');
}

export function listScopedProjects(): ScopedProject[] {
  return readRegistry().map((entry) => {
    const mcpJsonPath = path.join(entry.path, '.mcp.json');
    if (!fs.existsSync(mcpJsonPath)) {
      return { path: entry.path, exists: false, scopeTag: '', profile: '', readonly: true, configuredAt: null };
    }
    try {
      const data = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8')) as { mcpServers?: Record<string, McpSnippet> };
      const snippet = data.mcpServers?.peek;
      if (!snippet) {
        return { path: entry.path, exists: false, scopeTag: '', profile: '', readonly: true, configuredAt: null };
      }
      const inferred = inferFromConfigured(snippet);
      let configuredAt: number | null = null;
      try { configuredAt = fs.statSync(mcpJsonPath).mtimeMs; } catch {}
      return { path: entry.path, exists: true, scopeTag: inferred.scopeTag, profile: inferred.profile, readonly: inferred.readonly, configuredAt };
    } catch {
      return { path: entry.path, exists: false, scopeTag: '', profile: '', readonly: true, configuredAt: null };
    }
  });
}

export function scaffoldProject(opts: { dirPath: string; scopeTag: string; profile?: string; readonly?: boolean }): { success: boolean; error?: string; path?: string } {
  const dirPath = opts.dirPath;
  if (!dirPath || !path.isAbsolute(dirPath)) {
    return { success: false, error: 'Absolute directory path required.' };
  }
  try {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      return { success: false, error: 'Directory does not exist.' };
    }
  } catch (err) {
    return { success: false, error: (err as Error)?.message ?? 'Cannot access directory.' };
  }
  const scopeTag = (opts.scopeTag || '').trim();
  if (!scopeTag) {
    return { success: false, error: 'Scope tag is required (no unscoped projects).' };
  }
  const profile = opts.profile || defaultProfile();
  const readonly = opts.readonly ?? true;
  const mcpJsonPath = path.join(dirPath, '.mcp.json');
  // Preserve any non-peek mcpServers entries the user already has.
  let existing: { mcpServers?: Record<string, McpSnippet> } = {};
  if (fs.existsSync(mcpJsonPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
    } catch {
      existing = {};
    }
  }
  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers.peek = buildSnippet({ profile, readonly, scopeTag });
  fs.writeFileSync(mcpJsonPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
  const registry = readRegistry();
  if (!registry.some((e) => e.path === dirPath)) {
    registry.push({ path: dirPath, addedAt: Date.now() });
    writeRegistry(registry);
  }
  return { success: true, path: mcpJsonPath };
}

export function removeScopedProject(dirPath: string): { success: boolean; error?: string } {
  if (!dirPath || !path.isAbsolute(dirPath)) {
    return { success: false, error: 'Absolute directory path required.' };
  }
  const mcpJsonPath = path.join(dirPath, '.mcp.json');
  if (fs.existsSync(mcpJsonPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8')) as { mcpServers?: Record<string, McpSnippet> };
      if (data.mcpServers?.peek) {
        delete data.mcpServers.peek;
        if (Object.keys(data.mcpServers).length === 0) {
          delete data.mcpServers;
        }
        if (Object.keys(data).length === 0) {
          fs.unlinkSync(mcpJsonPath);
        } else {
          fs.writeFileSync(mcpJsonPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
        }
      }
    } catch {
      // Best-effort: still drop from registry below.
    }
  }
  const registry = readRegistry().filter((e) => e.path !== dirPath);
  writeRegistry(registry);
  return { success: true };
}

export function setMcpConfig(opts: Partial<McpConfig>): McpStatus {
  const current = getMcpStatus();
  const enabled = opts.enabled ?? current.enabled;
  const profile = opts.profile ?? current.profile;
  const readonly = opts.readonly ?? current.readonly;
  const scopeTag = (opts.scopeTag ?? current.scopeTag ?? '').trim();
  const settings = readSettings() as { mcpServers?: Record<string, McpSnippet> };
  if (enabled) {
    if (!settings.mcpServers) settings.mcpServers = {};
    (settings.mcpServers as Record<string, McpSnippet>).peek = buildSnippet({ profile, readonly, scopeTag });
  } else if (settings.mcpServers && (settings.mcpServers as Record<string, McpSnippet>).peek) {
    delete (settings.mcpServers as Record<string, McpSnippet>).peek;
    if (Object.keys(settings.mcpServers as object).length === 0) {
      delete settings.mcpServers;
    }
  }
  writeSettings(settings);
  return getMcpStatus();
}

// ── One-time config-location migration ───────────────────────────────
//
// Peek historically wrote its user-scope registration to
// ~/.claude/settings.json — a location Claude Code silently ignores (it
// reads user-scope `mcpServers` only from ~/.claude.json). This moves any
// stale entry to ~/.claude.json and prunes the dead one so agents in other
// projects can finally see peek. The pure move/prune logic lives in
// ./mcp-config-migration.ts (electron-free, so tests can import it).

function readJsonOrNull(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

export function migrateMcpConfigLocation(): void {
  // Only the real packaged default profile manages the real ~/.claude.json.
  if (!app.isPackaged) return;
  if (path.basename(app.getPath('userData')) !== 'default') return;

  // Never let a config migration crash app boot: a bad ~/.claude.json, an
  // EACCES/ENOSPC on write, etc. must degrade to "peek not auto-registered",
  // not a failed launch.
  try {
    const legacyPath = path.join(os.homedir(), '.claude', 'settings.json');
    const currentPath = settingsPath(); // ~/.claude.json

    // The abort-on-unparseable-current safety decision lives in the pure,
    // unit-tested planner; here we only do the filesystem IO around it.
    const plan = planMcpConfigMigration({
      legacyObj: readJsonOrNull(legacyPath),
      currentObj: readJsonOrNull(currentPath),
      currentExists: fs.existsSync(currentPath),
    });
    if (plan.action !== 'write') return;

    // Write current first (so we never drop the entry from both files if the
    // second write fails), then prune legacy. Both writes are atomic.
    atomicWriteJson(currentPath, plan.currentOut);
    atomicWriteJson(legacyPath, plan.legacyOut);
  } catch (err) {
    console.error('[mcp-config] migrateMcpConfigLocation failed:', err);
  }
}
