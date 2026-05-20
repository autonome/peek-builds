#!/usr/bin/env node

/**
 * Setup script for Peek MCP Server.
 * Detects the Peek database and configures Claude Code's MCP settings.
 *
 * Usage: node features/mcp-server/setup.js [--project]
 *   --project  Write to .claude/settings.json (project-level) instead of ~/.claude/settings.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- DB path detection ---

function findDbPath() {
  const candidates = [
    join(homedir(), 'Library', 'Application Support', 'Peek', 'default', 'datastore.sqlite'),
    join(homedir(), '.config', 'Peek', 'default', 'datastore.sqlite'),
    join(homedir(), '.local', 'share', 'Peek', 'default', 'datastore.sqlite'),
  ];

  // Also check PEEK_DB_PATH env var
  if (process.env.PEEK_DB_PATH && existsSync(process.env.PEEK_DB_PATH)) {
    return process.env.PEEK_DB_PATH;
  }

  for (const path of candidates) {
    if (existsSync(path)) return path;
  }

  return null;
}

// --- Settings file handling ---

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
  const isProject = process.argv.includes('--project');

  // Find database
  const dbPath = findDbPath();
  if (!dbPath) {
    console.error('Could not find Peek database.');
    console.error('Looked in:');
    console.error('  ~/Library/Application Support/Peek/default/datastore.sqlite');
    console.error('  ~/.config/Peek/default/datastore.sqlite');
    console.error('  ~/.local/share/Peek/default/datastore.sqlite');
    console.error('');
    console.error('Set PEEK_DB_PATH environment variable to specify the path manually.');
    process.exit(1);
  }

  // Find server.js
  const serverPath = resolve(__dirname, 'server.js');
  if (!existsSync(serverPath)) {
    console.error(`Server not found at: ${serverPath}`);
    process.exit(1);
  }

  // Determine settings file
  const settingsPath = isProject
    ? join(process.cwd(), '.claude', 'settings.json')
    : join(homedir(), '.claude', 'settings.json');

  console.log(`Peek MCP Server Setup`);
  console.log(`=====================`);
  console.log(`Database:  ${dbPath}`);
  console.log(`Server:    ${serverPath}`);
  console.log(`Settings:  ${settingsPath}`);
  console.log('');

  // Read existing settings
  const settings = readJsonFile(settingsPath);

  // Add/update MCP server config
  if (!settings.mcpServers) {
    settings.mcpServers = {};
  }

  settings.mcpServers.peek = {
    command: 'node',
    args: [serverPath],
    env: {
      PEEK_DB_PATH: dbPath,
    },
  };

  // Write back
  writeJsonFile(settingsPath, settings);

  console.log('MCP server configured successfully.');
  console.log('');
  console.log('Claude Code will now have access to Peek tools:');
  console.log('  list_items, get_item, create_item, update_item, delete_item');
  console.log('  list_tags, tag_item, untag_item');
  console.log('  record_event, list_tasks, complete_task, get_task_context');
  console.log('');
  console.log('Restart Claude Code to pick up the new MCP server.');
}

main();
