/**
 * MCP config writer — manages the `mcpServers.peek` entry in
 * ~/.claude/settings.json from the Settings UI toggle.
 *
 * Off by default: the entry is only present after the user opts in via
 * Settings → Core → "Expose Peek to Claude Code (MCP)".
 */

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

// Profile directory base. macOS-only for now; mirrors entry.ts profile layout.
const PROFILES_BASE = path.join(os.homedir(), 'Library', 'Application Support', 'Peek');

interface McpSnippet {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpConfig {
  enabled: boolean;
  profile: string;
  readonly: boolean;
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

function buildSnippet(opts: { profile: string; readonly: boolean }): McpSnippet {
  const env: Record<string, string> = { PEEK_DB_PATH: dbPathForProfile(opts.profile) };
  if (opts.readonly) env.PEEK_MCP_READONLY = '1';
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

function inferFromConfigured(configured: McpSnippet | null): { profile: string; readonly: boolean } {
  // Fresh state defaults to read-only — writes are off by default so an
  // agent can never destroy items without an explicit opt-in.
  if (!configured) return { profile: defaultProfile(), readonly: true };
  const dbPath = configured.env?.PEEK_DB_PATH || '';
  let profile = defaultProfile();
  const prefix = PROFILES_BASE + path.sep;
  if (dbPath.startsWith(prefix)) {
    profile = dbPath.slice(prefix.length).split(path.sep)[0] || profile;
  }
  const readonly = configured.env?.PEEK_MCP_READONLY === '1';
  return { profile, readonly };
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
    if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) return {};
    return JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function writeSettings(data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(
    CLAUDE_SETTINGS_PATH,
    JSON.stringify(data, null, 2) + '\n',
    'utf-8',
  );
}

export interface McpStatus extends McpConfig {
  expectedCommand: string;
  configuredCommand: string | null;
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
    try { configuredAt = fs.statSync(CLAUDE_SETTINGS_PATH).mtimeMs; } catch {}
  }
  return {
    enabled: !!configured && snippetsMatch(configured, expected),
    profile: inferred.profile,
    readonly: inferred.readonly,
    expectedCommand: expected.command,
    configuredCommand: configured?.command ?? null,
    settingsPath: CLAUDE_SETTINGS_PATH,
    profiles: listProfiles(),
    configuredAt,
  };
}

export function setMcpConfig(opts: Partial<McpConfig>): McpStatus {
  const current = getMcpStatus();
  const enabled = opts.enabled ?? current.enabled;
  const profile = opts.profile ?? current.profile;
  const readonly = opts.readonly ?? current.readonly;
  const settings = readSettings() as { mcpServers?: Record<string, McpSnippet> };
  if (enabled) {
    if (!settings.mcpServers) settings.mcpServers = {};
    (settings.mcpServers as Record<string, McpSnippet>).peek = buildSnippet({ profile, readonly });
  } else if (settings.mcpServers && (settings.mcpServers as Record<string, McpSnippet>).peek) {
    delete (settings.mcpServers as Record<string, McpSnippet>).peek;
    if (Object.keys(settings.mcpServers as object).length === 0) {
      delete settings.mcpServers;
    }
  }
  writeSettings(settings);
  return getMcpStatus();
}
