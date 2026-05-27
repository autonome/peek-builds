#!/usr/bin/env node

/**
 * Setup script for Peek MCP Server.
 * Writes/updates the `mcpServers.peek` entry in a Claude Code settings
 * file so other agents can call peek tools.
 *
 * Detects whether it's running from inside a packaged Peek.app or a
 * dev checkout and writes the appropriate snippet:
 *   - Bundled: { command: "<Peek.app>/Contents/Resources/peek-mcp" }
 *   - Dev:     { command: "node", args: ["--experimental-sqlite", "<server.js>"] }
 *
 * Scope is mandatory — every scaffolded entry confines its session to
 * items tagged <scope> or <scope>:*. Writes default to OFF; pass
 * --writes to enable mutating tools.
 *
 * Usage:
 *   node setup.js --scope <tag>                       # global (~/.claude/settings.json)
 *   node setup.js --scope <tag> --project             # <cwd>/.claude/settings.json
 *   node setup.js --scope <tag> --mcp-json            # <cwd>/.mcp.json
 *   node setup.js --scope <tag> --writes              # opt into mutating tools
 *   node setup.js --scope <tag> --profile <name>      # non-default Peek profile
 *   node setup.js --scope <tag> --force               # overwrite differing entry
 *   node setup.js --scope <tag> --print               # print snippet, don't write
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Context detection (bundled vs dev) ---

// When packaged, setup.js lives at:
//   <Peek.app>/Contents/Resources/app.asar.unpacked/apps/desktop/features/mcp-server/setup.js
// The launcher is at:
//   <Peek.app>/Contents/Resources/peek-mcp
function detectBundledLauncher() {
  // Walk up looking for `Contents/Resources/peek-mcp` sibling.
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (dir.endsWith('/Contents/Resources/app.asar.unpacked')) {
      const launcher = join(dirname(dir), 'peek-mcp');
      if (existsSync(launcher)) return launcher;
      return null;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// --- DB path detection ---

function findDbPath(profile = 'default') {
  if (process.env.PEEK_DB_PATH && existsSync(process.env.PEEK_DB_PATH)) {
    return process.env.PEEK_DB_PATH;
  }
  const candidates = [
    join(homedir(), 'Library', 'Application Support', 'Peek', profile, 'datastore.sqlite'),
    join(homedir(), '.config', 'Peek', profile, 'datastore.sqlite'),
    join(homedir(), '.local', 'share', 'Peek', profile, 'datastore.sqlite'),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

// --- Snippet builders ---

function buildEnv(dbPath, { scope, readonly }) {
  const env = { PEEK_DB_PATH: dbPath, PEEK_MCP_SCOPE_TAG: scope };
  if (readonly) env.PEEK_MCP_READONLY = '1';
  return env;
}

function bundledSnippet(launcherPath, dbPath, opts) {
  return { command: launcherPath, env: buildEnv(dbPath, opts) };
}

function devSnippet(serverPath, dbPath, opts) {
  return {
    command: 'node',
    args: ['--experimental-sqlite', serverPath],
    env: buildEnv(dbPath, opts),
  };
}

function snippetsEqual(a, b) {
  if (!a || !b) return false;
  if (a.command !== b.command) return false;
  const ag = a.args ?? [], bg = b.args ?? [];
  if (ag.length !== bg.length) return false;
  for (let i = 0; i < ag.length; i++) if (ag[i] !== bg[i]) return false;
  const ae = a.env ?? {}, be = b.env ?? {};
  const ak = Object.keys(ae).sort(), bk = Object.keys(be).sort();
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== bk[i]) return false;
    if (ae[ak[i]] !== be[bk[i]]) return false;
  }
  return true;
}

// --- Settings file I/O ---

function readJsonFile(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

function writeJsonFile(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

// --- Main ---

function parseArgs(argv) {
  const opts = { scope: '', profile: 'default', writes: false, force: false,
                 print: false, project: false, mcpJson: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--scope':   opts.scope = argv[++i] || ''; break;
      case '--profile': opts.profile = argv[++i] || 'default'; break;
      case '--writes':  opts.writes = true; break;
      case '--force':   opts.force = true; break;
      case '--print':   opts.print = true; break;
      case '--project': opts.project = true; break;
      case '--mcp-json': opts.mcpJson = true; break;
      case '--help':
      case '-h':        opts.help = true; break;
      default:
        process.stderr.write(`Unknown argument: ${a}\n`);
        process.exit(2);
    }
  }
  return opts;
}

const HELP = `Peek MCP setup — writes/updates the mcpServers.peek entry.

Usage:
  peek-mcp --install --scope <tag> [options]

Options:
  --scope <tag>     Confine the session to items tagged <tag> or <tag>:* (required)
  --writes          Enable mutating tools (default: read-only)
  --profile <name>  Peek profile to expose (default: "default")
  --mcp-json        Write to <cwd>/.mcp.json (per-project, recommended)
  --project         Write to <cwd>/.claude/settings.json
  (no dest flag)    Write to ~/.claude/settings.json
  --force           Overwrite an existing peek entry that differs
  --print           Print the snippet to stdout, do not write
`;

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  if (!opts.scope) {
    process.stderr.write('Error: --scope <tag> is required.\n\n');
    process.stderr.write(HELP);
    process.exit(2);
  }

  const dbPath = findDbPath(opts.profile);
  if (!dbPath) {
    process.stderr.write(`Could not find Peek database for profile "${opts.profile}".\n`);
    process.stderr.write('Looked in:\n');
    process.stderr.write(`  ~/Library/Application Support/Peek/${opts.profile}/datastore.sqlite\n`);
    process.stderr.write(`  ~/.config/Peek/${opts.profile}/datastore.sqlite\n`);
    process.stderr.write(`  ~/.local/share/Peek/${opts.profile}/datastore.sqlite\n`);
    process.stderr.write('\nSet PEEK_DB_PATH to override.\n');
    process.exit(1);
  }

  const launcher = detectBundledLauncher();
  const snippetOpts = { scope: opts.scope, readonly: !opts.writes };
  const snippet = launcher
    ? bundledSnippet(launcher, dbPath, snippetOpts)
    : devSnippet(resolve(__dirname, 'server.js'), dbPath, snippetOpts);
  const mode = launcher ? 'bundled' : 'dev';

  if (opts.print) {
    process.stdout.write(JSON.stringify({ mcpServers: { peek: snippet } }, null, 2) + '\n');
    return;
  }

  let settingsPath;
  let isMcpJson = false;
  if (opts.mcpJson) {
    settingsPath = join(process.cwd(), '.mcp.json');
    isMcpJson = true;
  } else if (opts.project) {
    settingsPath = join(process.cwd(), '.claude', 'settings.json');
  } else {
    settingsPath = join(homedir(), '.claude', 'settings.json');
  }

  process.stderr.write(`Peek MCP Setup (${mode})\n`);
  process.stderr.write(`  Scope:    ${opts.scope} (and ${opts.scope}:*)\n`);
  process.stderr.write(`  Writes:   ${opts.writes ? 'enabled' : 'OFF (read-only)'}\n`);
  process.stderr.write(`  Profile:  ${opts.profile}\n`);
  process.stderr.write(`  Database: ${dbPath}\n`);
  if (launcher) {
    process.stderr.write(`  Launcher: ${launcher}\n`);
  } else {
    process.stderr.write(`  Server:   ${resolve(__dirname, 'server.js')}\n`);
  }
  process.stderr.write(`  Settings: ${settingsPath}\n\n`);

  const settings = readJsonFile(settingsPath);
  if (!settings.mcpServers) settings.mcpServers = {};

  const prev = settings.mcpServers.peek;
  if (prev && !snippetsEqual(prev, snippet) && !opts.force) {
    process.stderr.write('Refusing to overwrite existing mcpServers.peek entry.\n');
    process.stderr.write(`Existing scope: ${prev.env?.PEEK_MCP_SCOPE_TAG || '(none)'}\n`);
    process.stderr.write(`New scope:      ${opts.scope}\n`);
    process.stderr.write('Pass --force to replace it.\n');
    process.exit(1);
  }

  settings.mcpServers.peek = snippet;
  writeJsonFile(settingsPath, settings);

  if (prev) {
    process.stderr.write('Updated existing mcpServers.peek entry.\n');
  } else {
    process.stderr.write('Added mcpServers.peek entry.\n');
  }
  const isTty = process.stderr.isTTY;
  const bold = isTty ? '\x1b[1m' : '';
  const yellow = isTty ? '\x1b[33m' : '';
  const reset = isTty ? '\x1b[0m' : '';
  process.stderr.write(`\n${yellow}${bold}=> Fully quit and reopen Claude Code in this directory.${reset}\n`);
  process.stderr.write(`   Re-approving the /mcp prompt does NOT respawn the peek-mcp child;\n`);
  process.stderr.write(`   only a full client restart picks up the new env.\n`);
  process.stderr.write(`   (Same applies if you just reinstalled Peek.app — the running child\n`);
  process.stderr.write(`   still has the old launcher binary.)\n`);
  if (isMcpJson) {
    process.stderr.write('\nNote: .mcp.json holds absolute machine-local paths; gitignore unless your team standardizes them.\n');
  }
}

main();
