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
 * Usage:
 *   node setup.js                          # global (~/.claude/settings.json)
 *   node setup.js --project                # <cwd>/.claude/settings.json
 *   node setup.js --mcp-json               # <cwd>/.mcp.json
 *   node setup.js --print                  # print snippet, don't write
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

function findDbPath() {
  if (process.env.PEEK_DB_PATH && existsSync(process.env.PEEK_DB_PATH)) {
    return process.env.PEEK_DB_PATH;
  }
  const candidates = [
    join(homedir(), 'Library', 'Application Support', 'Peek', 'default', 'datastore.sqlite'),
    join(homedir(), '.config', 'Peek', 'default', 'datastore.sqlite'),
    join(homedir(), '.local', 'share', 'Peek', 'default', 'datastore.sqlite'),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

// --- Snippet builders ---

function bundledSnippet(launcherPath, dbPath) {
  return {
    command: launcherPath,
    env: { PEEK_DB_PATH: dbPath },
  };
}

function devSnippet(serverPath, dbPath) {
  return {
    command: 'node',
    args: ['--experimental-sqlite', serverPath],
    env: { PEEK_DB_PATH: dbPath },
  };
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

function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => argv.includes(name);

  const dbPath = findDbPath();
  if (!dbPath) {
    process.stderr.write('Could not find Peek database.\n');
    process.stderr.write('Looked in:\n');
    process.stderr.write('  ~/Library/Application Support/Peek/default/datastore.sqlite\n');
    process.stderr.write('  ~/.config/Peek/default/datastore.sqlite\n');
    process.stderr.write('  ~/.local/share/Peek/default/datastore.sqlite\n');
    process.stderr.write('\nSet PEEK_DB_PATH to override.\n');
    process.exit(1);
  }

  const launcher = detectBundledLauncher();
  const snippet = launcher
    ? bundledSnippet(launcher, dbPath)
    : devSnippet(resolve(__dirname, 'server.js'), dbPath);
  const mode = launcher ? 'bundled' : 'dev';

  if (flag('--print')) {
    process.stdout.write(JSON.stringify({ mcpServers: { peek: snippet } }, null, 2) + '\n');
    return;
  }

  // Pick destination.
  let settingsPath;
  let isMcpJson = false;
  if (flag('--mcp-json')) {
    settingsPath = join(process.cwd(), '.mcp.json');
    isMcpJson = true;
  } else if (flag('--project')) {
    settingsPath = join(process.cwd(), '.claude', 'settings.json');
  } else {
    settingsPath = join(homedir(), '.claude', 'settings.json');
  }

  process.stderr.write(`Peek MCP Setup (${mode})\n`);
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
  settings.mcpServers.peek = snippet;
  writeJsonFile(settingsPath, settings);

  if (prev) {
    process.stderr.write('Updated existing mcpServers.peek entry.\n');
  } else {
    process.stderr.write('Added mcpServers.peek entry.\n');
  }
  process.stderr.write(`\nRestart your MCP client (Claude Code: /mcp list) to pick up the new server.\n`);
  if (isMcpJson) {
    process.stderr.write('Note: .mcp.json should be committed only if everyone on the project has Peek installed at the same path.\n');
  }
}

main();
