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
 * Remote mode (--remote <url>) targets a Peek sync server instead of a local
 * datastore — no PEEK_DB_PATH, no local database lookup. Neither the host
 * nor the credential is ever written into the project: the entry's
 * PEEK_MCP_REMOTE_URL is a $PEEK_SYNC_URL reference the caller's shell must
 * export to the actual value; by default the credential is likewise a
 * $PEEK_MCP_TOKEN reference, and --store-token reads a minted grant token
 * from stdin instead and stores it in a 0600 file outside the repo,
 * referenced from the entry by lookup key.
 *
 * Usage:
 *   node setup.js --scope <tag>                       # user scope (~/.claude.json)
 *   node setup.js --scope <tag> --mcp-json            # <cwd>/.mcp.json (project scope)
 *   node setup.js --scope <tag> --writes              # opt into mutating tools
 *   node setup.js --scope <tag> --profile <name>      # non-default Peek profile
 *   node setup.js --scope <tag> --print               # print snippet, don't write
 *   node setup.js --scope <tag> --remote <url>        # remote server, no local datastore
 *   node setup.js --scope <tag> --remote <url> --store-token   # token piped on stdin
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TEMPLATE_BODY, BODY_BEGIN, BODY_END, REMOTE_PARAGRAPH } from './peek-skill-template.js';

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

// --- Remote credential file ---
// Never in the project: the minted grant token lives here, mode 0600,
// outside the repo. .mcp.json carries only a lookup key into this file
// (or a ${VAR} reference), never the token itself.

function credentialFilePath() {
  return join(homedir(), '.config', 'peek', 'mcp-credentials.json');
}

// Store a minted grant token under the `<url>#<scope>` key. Returns the key
// so the caller can put it in PEEK_MCP_CREDENTIAL without the token ever
// touching a project file.
function writeCredentialFile(url, scope, token, label) {
  const path = credentialFilePath();
  const data = readJsonFile(path);
  if (!data.credentials) data.credentials = {};
  const key = `${url}#${scope}`;
  data.credentials[key] = { token, label };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.peek-tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return { path, key };
}

// Read a minted token piped on stdin for --store-token. Stdin only — never
// an argv value, never echoed to stdout or stderr, never logged.
function readTokenFromStdin() {
  return readFileSync(0, 'utf-8').trim();
}

// --- Tool sets (must mirror server.js TOOLS array) ---

// Read-only tools: safe to always allow.
const READ_TOOLS = ['list_items', 'search_items', 'get_item', 'list_tags', 'list_tasks', 'get_task_context'];
// Mutating tools: only allowed when --writes is set.
const WRITE_TOOLS = ['create_item', 'update_item', 'delete_item', 'tag_item', 'untag_item', 'record_event', 'complete_task'];

function allowList({ writes }) {
  const tools = writes ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS;
  return tools.map((t) => `mcp__peek__${t}`);
}

// --- Snippet builders ---

// Unresolved on purpose, both of these: Claude Code expands "${VAR}" entries
// from the launching shell's environment. A server URL carries a hostname,
// so it gets the same treatment as the token — never the literal value the
// caller passed to --remote, only a reference to a shell variable. If either
// is unset, the literal "${...}" text passes through instead of a resolved
// value, which is what lets a startup guard downstream fail loudly rather
// than dial an empty host or send an unexpanded string as a bearer token.
const REMOTE_URL_REF = '${PEEK_SYNC_URL}';
const TOKEN_REF = '${PEEK_MCP_TOKEN}';

function buildEnv(dbPath, { scope, readonly, remote, credential }) {
  if (remote) {
    // No datastore in remote mode — PEEK_DB_PATH is omitted entirely.
    // PEEK_MCP_SCOPE_TAG is still written: not the enforcement mechanism
    // (the grant is), but it lets the child fail fast and gives
    // checkConfigDrift() something to compare.
    const env = { PEEK_MCP_REMOTE_URL: REMOTE_URL_REF, PEEK_MCP_SCOPE_TAG: scope };
    if (credential) {
      // A lookup key into the 0600 credential file — not a secret — but it's
      // still built from the reference form so the host never lands here
      // literally either. It expands to the same "<url>#<scope>" key the
      // credential file was written under, once Claude Code resolves
      // PEEK_SYNC_URL from the shell.
      env.PEEK_MCP_CREDENTIAL = `${REMOTE_URL_REF}#${scope}`;
    } else {
      env.PEEK_MCP_TOKEN = TOKEN_REF;
    }
    if (readonly) env.PEEK_MCP_READONLY = '1';
    return env;
  }
  const env = { PEEK_DB_PATH: dbPath, PEEK_MCP_SCOPE_TAG: scope };
  if (readonly) env.PEEK_MCP_READONLY = '1';
  return env;
}

function bundledSnippet(launcherPath, dbPath, opts) {
  return { command: launcherPath, env: buildEnv(dbPath, opts) };
}

function devSnippet(serverPath, dbPath, opts) {
  // Remote mode never touches node:sqlite, so the flag that enables it drops.
  const args = opts.remote ? [serverPath] : ['--experimental-sqlite', serverPath];
  return {
    command: 'node',
    args,
    env: buildEnv(dbPath, opts),
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

// Atomic write via temp + rename. The default destination is ~/.claude.json,
// Claude Code's live state file (auth/projects/history) — a torn write would
// corrupt it. Callers always read-merge before writing, so other keys survive.
function writeJsonFile(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.peek-tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path);
}

// settings.local.json sibling of the chosen main settings file.
function allowSettingsPath(mainPath, isMcpJson) {
  // .mcp.json sits at <cwd>/.mcp.json — local settings goes in <cwd>/.claude/.
  if (isMcpJson) return join(dirname(mainPath), '.claude', 'settings.local.json');
  // Default dest is ~/.claude.json (user scope) — sibling settings.local.json.
  return join(dirname(mainPath), 'settings.local.json');
}

// Render the skill body with scope substitution. In remote mode, splices
// REMOTE_PARAGRAPH in ahead of the Tag model section (still inside the
// BODY_BEGIN/END managed span, so it's refreshed on every re-run).
function renderSkillBody(scope, { remote } = {}) {
  const body = TEMPLATE_BODY.replace(/\{SCOPE\}/g, scope);
  if (!remote) return body;
  const anchor = '\n## Tag model';
  const idx = body.indexOf(anchor);
  if (idx === -1) return body;
  return body.slice(0, idx) + '\n' + REMOTE_PARAGRAPH.trim() + '\n' + body.slice(idx);
}

// Scaffold or refresh <cwd>/.claude/skills/peek.md. Returns { path, action }
// where action is 'created' | 'refreshed' | 'unchanged'. The auto-managed
// section is bracketed by BODY_BEGIN/END markers; anything after BODY_END is
// preserved across re-runs so per-project conventions survive.
function writeSkillFile(cwd, scope, { remote } = {}) {
  const path = join(cwd, '.claude', 'skills', 'peek.md');
  const rendered = renderSkillBody(scope, { remote });

  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, rendered, 'utf-8');
    return { path, action: 'created' };
  }

  const existing = readFileSync(path, 'utf-8');
  const endIdx = existing.indexOf(BODY_END);
  if (endIdx === -1) {
    // No marker found — file exists but isn't from this template. Don't
    // clobber; the user owns it.
    return { path, action: 'unchanged' };
  }

  // Preserve everything from BODY_END's line onward in the existing file.
  // We splice in the freshly-rendered prefix (up through BODY_END) and keep
  // the existing tail (project-specific section).
  const renderedEnd = rendered.indexOf(BODY_END);
  const newPrefix = rendered.slice(0, renderedEnd + BODY_END.length);
  const existingTail = existing.slice(endIdx + BODY_END.length);
  const merged = newPrefix + existingTail;

  if (merged === existing) {
    return { path, action: 'unchanged' };
  }
  writeFileSync(path, merged, 'utf-8');
  return { path, action: 'refreshed' };
}

// Managed-block sentinels for the .gitignore entries we own.
const GITIGNORE_BEGIN = '# >>> peek-mcp-init (auto-managed) >>>';
const GITIGNORE_END = '# <<< peek-mcp-init (auto-managed) <<<';

// Write/refresh an idempotent managed block in <cwd>/.gitignore listing the
// per-developer Peek MCP wiring files (machine/scope-specific — must not be
// committed). Returns { path, action } with action 'created'|'updated'|'unchanged'.
function writeGitignoreBlock(cwd) {
  const path = join(cwd, '.gitignore');
  const block = [
    GITIGNORE_BEGIN,
    '# Per-developer Peek MCP wiring — machine/scope-specific, do not commit.',
    '# Remote-mode credentials live outside the project, in ~/.config/peek/mcp-credentials.json.',
    '.mcp.json',
    '.claude/settings.local.json',
    '.claude/skills/peek.md',
    GITIGNORE_END,
  ].join('\n');

  if (!existsSync(path)) {
    writeFileSync(path, block + '\n', 'utf-8');
    return { path, action: 'created' };
  }
  const existing = readFileSync(path, 'utf-8');
  const beginIdx = existing.indexOf(GITIGNORE_BEGIN);
  if (beginIdx === -1) {
    // Append our block, preserving existing content.
    const sep = existing.endsWith('\n') ? '' : '\n';
    const merged = existing + sep + '\n' + block + '\n';
    writeFileSync(path, merged, 'utf-8');
    return { path, action: 'updated' };
  }
  // Replace the existing managed block in place.
  const endIdx = existing.indexOf(GITIGNORE_END, beginIdx);
  if (endIdx === -1) {
    // Malformed (begin without end) — leave the file alone rather than corrupt it.
    return { path, action: 'unchanged' };
  }
  const before = existing.slice(0, beginIdx);
  const after = existing.slice(endIdx + GITIGNORE_END.length);
  const merged = before + block + after;
  if (merged === existing) return { path, action: 'unchanged' };
  writeFileSync(path, merged, 'utf-8');
  return { path, action: 'updated' };
}

// Recover scope, writes, profile, and destination from an existing Peek MCP
// install, so a no-scope re-run just "refreshes" it without the caller
// re-specifying params. Checks project .mcp.json first (the recommended
// layout), then the user-scope ~/.claude.json (the default/global refresh
// case). Returns { found, scope, writes, profile, dest } where dest is
// 'mcp-json' | 'global' — or, for a remote install, { found, scope, writes,
// remote, dest } with no profile (there's no local datastore to attribute
// one to).
function detectExistingInstall(cwd) {
  const candidates = [
    { path: join(cwd, '.mcp.json'), dest: 'mcp-json' },
    { path: join(homedir(), '.claude.json'), dest: 'global' },
  ];
  for (const { path, dest } of candidates) {
    if (!existsSync(path)) continue;
    const json = readJsonFile(path);
    const peek = json && json.mcpServers && json.mcpServers.peek;
    if (!peek || !peek.env) continue;
    const env = peek.env;
    const scope = (env.PEEK_MCP_SCOPE_TAG || '').trim();
    if (!scope) continue;
    const writes = env.PEEK_MCP_READONLY !== '1';
    if (env.PEEK_MCP_REMOTE_URL) {
      return { found: true, scope, writes, remote: env.PEEK_MCP_REMOTE_URL, dest };
    }
    let profile = 'default';
    const dbPath = env.PEEK_DB_PATH || '';
    const m = dbPath.match(/\/Peek\/([^/]+)\/datastore\.sqlite$/);
    if (m) profile = m[1];
    return { found: true, scope, writes, profile, dest };
  }
  return { found: false };
}

// Merge entries into permissions.allow, preserving existing entries and order.
// Returns { added: string[], skipped: boolean } — skipped=true means nothing
// new to write so the file was left alone.
function mergeAllowEntries(path, entries) {
  const settings = readJsonFile(path);
  if (!settings.permissions) settings.permissions = {};
  if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];
  const existing = new Set(settings.permissions.allow);
  const added = [];
  for (const entry of entries) {
    if (!existing.has(entry)) {
      settings.permissions.allow.push(entry);
      added.push(entry);
    }
  }
  if (added.length === 0) return { added, skipped: true };
  writeJsonFile(path, settings);
  return { added, skipped: false };
}

// --- Main ---

function parseArgs(argv) {
  const opts = { scope: '', profile: 'default', writes: false,
                 print: false, mcpJson: false, allow: true,
                 skill: true, gitignore: true, help: false,
                 remote: '', storeToken: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--scope':   opts.scope = argv[++i] || ''; break;
      case '--profile': opts.profile = argv[++i] || 'default'; break;
      case '--writes':  opts.writes = true; break;
      case '--print':   opts.print = true; break;
      case '--mcp-json': opts.mcpJson = true; break;
      case '--no-allow': opts.allow = false; break;
      case '--no-skill': opts.skill = false; break;
      case '--no-gitignore': opts.gitignore = false; break;
      case '--remote':  opts.remote = argv[++i] || ''; break;
      case '--store-token': opts.storeToken = true; break;
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
  peek-mcp --install --scope <tag> [options]    # scaffold / override
  peek-mcp --install                            # refresh existing install in cwd

Options:
  --scope <tag>     Confine the session to items tagged <tag> or <tag>:* (required). Omit --scope to refresh an existing install (recovers scope, writes, and profile from .mcp.json, .claude/settings.json, or ~/.claude.json).
  --writes          Enable mutating tools (default: read-only)
  --profile <name>  Peek profile to expose (default: "default")
  --mcp-json        Write to <cwd>/.mcp.json (per-project, recommended)
  (no dest flag)    Write to ~/.claude.json (user scope)
  --no-allow        Skip adding mcp__peek__* entries to permissions.allow
  --no-skill        Skip scaffolding the per-project peek skill
  --no-gitignore    Skip adding the scaffolded files to .gitignore
  --print           Print the snippet to stdout, do not write
  --remote <url>    Target a remote Peek server instead of a local datastore.
                     No PEEK_DB_PATH. The url you pass here is used only to
                     derive the credential-file key and print guidance — the
                     entry itself carries a $PEEK_SYNC_URL reference (export
                     it to this value), never the literal host, and by
                     default a $PEEK_MCP_TOKEN reference for the credential.
  --store-token     With --remote: read a minted grant token from stdin and
                     store it in ~/.config/peek/mcp-credentials.json (mode
                     0600, outside the repo) instead of an env reference.

By default also:
  - appends mcp__peek__* tool names to permissions.allow in settings.local.json
    (sibling of the chosen settings file — gitignored / user-specific), so
    Claude Code stops prompting for each Peek tool. --no-allow opts out.
  - scaffolds <cwd>/.claude/skills/peek.md from the bundled template with
    {SCOPE} substituted, so Claude Code sessions in this project know the
    Peek conventions (status vocabulary, bare-tag trap, hashtag opt-in,
    untag orphan rule, restart UX). Re-running refreshes the auto-managed
    section while preserving the trailing "Project-specific" section.
    Only runs when --mcp-json is set. --no-skill opts out.
  - adds .mcp.json, .claude/settings.local.json, and .claude/skills/peek.md
    to <cwd>/.gitignore in a managed block (these are per-developer wiring
    files that are machine/scope-specific and should not be committed).
    Only runs when --mcp-json is set. --no-gitignore opts out.
`;

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }

  // No --scope: refresh an existing install in this directory, recovering its
  // scope/writes/profile/destination so a bare `peek-mcp-init` re-run picks up
  // template + launcher-path updates without re-specifying anything.
  let refreshing = false;
  if (!opts.scope) {
    const existing = detectExistingInstall(process.cwd());
    if (existing.found) {
      opts.scope = existing.scope;
      opts.writes = existing.writes;
      if (existing.remote) {
        opts.remote = existing.remote;
      } else {
        opts.profile = existing.profile;
      }
      if (existing.dest === 'mcp-json') opts.mcpJson = true;
      refreshing = true;
    }
  }

  if (!opts.scope) {
    process.stderr.write('Error: no --scope given and no existing Peek MCP install found in this directory.\n');
    process.stderr.write('Pass a <tag> to scaffold a new one, or run from a directory that already has .mcp.json or .claude/settings.json.\n\n');
    process.stderr.write(HELP);
    process.exit(2);
  }

  // Remote mode has no local datastore to look for; skip the lookup and its
  // fatal-exit branch entirely.
  let dbPath = null;
  if (!opts.remote) {
    dbPath = findDbPath(opts.profile);
    if (!dbPath) {
      process.stderr.write(`Could not find Peek database for profile "${opts.profile}".\n`);
      process.stderr.write('Looked in:\n');
      process.stderr.write(`  ~/Library/Application Support/Peek/${opts.profile}/datastore.sqlite\n`);
      process.stderr.write(`  ~/.config/Peek/${opts.profile}/datastore.sqlite\n`);
      process.stderr.write(`  ~/.local/share/Peek/${opts.profile}/datastore.sqlite\n`);
      process.stderr.write('\nSet PEEK_DB_PATH to override.\n');
      process.exit(1);
    }
  }

  const launcher = detectBundledLauncher();
  const mode = launcher ? 'bundled' : 'dev';
  function buildSnippet(credential) {
    const snippetOpts = { scope: opts.scope, readonly: !opts.writes, remote: opts.remote, credential };
    return launcher
      ? bundledSnippet(launcher, dbPath, snippetOpts)
      : devSnippet(resolve(__dirname, 'server.js'), dbPath, snippetOpts);
  }

  if (opts.print) {
    // Dry run: never touches stdin or the credential file, and always shows
    // the env-reference form — --store-token is a real-install-only step.
    const snippet = buildSnippet(null);
    process.stdout.write(JSON.stringify({ mcpServers: { peek: snippet } }, null, 2) + '\n');
    return;
  }

  let credential = null;
  if (opts.remote && opts.storeToken) {
    // A refreshed install only recovers the $PEEK_SYNC_URL reference (the
    // real host is deliberately not in the project to recover it from) —
    // --store-token needs the concrete url to key the credential file.
    if (opts.remote.startsWith('${')) {
      process.stderr.write('Error: --store-token needs the concrete server URL — pass --remote <url> explicitly.\n');
      process.exit(2);
    }
    const token = readTokenFromStdin();
    if (!token) {
      process.stderr.write('Error: --store-token requires a minted grant token on stdin (none received).\n');
      process.exit(2);
    }
    const { key } = writeCredentialFile(opts.remote, opts.scope, token, `peek-mcp-init: ${opts.scope}`);
    credential = key;
  }
  const snippet = buildSnippet(credential);

  let settingsPath;
  let isMcpJson = false;
  if (opts.mcpJson) {
    settingsPath = join(process.cwd(), '.mcp.json');
    isMcpJson = true;
  } else {
    // Default (no dest flag): user scope. Claude Code reads user-scope
    // `mcpServers` from ~/.claude.json (top-level), NOT from
    // ~/.claude/settings.json. readJsonFile above read-merges so other keys
    // in this live state file (auth/projects/history) are preserved.
    settingsPath = join(homedir(), '.claude.json');
  }

  if (refreshing) {
    process.stderr.write(opts.remote
      ? 'Refreshing existing install — recovered scope, writes, and remote URL from this directory.\n'
      : 'Refreshing existing install — recovered scope, writes, and profile from this directory.\n');
  }
  process.stderr.write(`Peek MCP Setup (${mode})\n`);
  process.stderr.write(`  Scope:    ${opts.scope} (and ${opts.scope}:*)\n`);
  process.stderr.write(`  Writes:   ${opts.writes ? 'enabled' : 'OFF (read-only)'}\n`);
  if (opts.remote) {
    process.stderr.write(`  Remote:   ${opts.remote} — export PEEK_SYNC_URL to this value in the launching shell; the entry only ever carries a $PEEK_SYNC_URL reference.\n`);
    process.stderr.write(`  Credential: ${credential
      ? `stored in ${credentialFilePath()} (0600)`
      : 'via $PEEK_MCP_TOKEN in the launching shell\'s environment'}\n`);
  } else {
    process.stderr.write(`  Profile:  ${opts.profile}\n`);
    process.stderr.write(`  Database: ${dbPath}\n`);
  }
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

  if (opts.allow) {
    const allowPath = allowSettingsPath(settingsPath, isMcpJson);
    const result = mergeAllowEntries(allowPath, allowList({ writes: opts.writes }));
    if (result.skipped) {
      process.stderr.write(`Allowlist entries already present in ${allowPath}.\n`);
    } else {
      process.stderr.write(`Added ${result.added.length} mcp__peek__* entries to ${allowPath}.\n`);
    }
  }

  // Skill scaffolding only applies to per-project setups (--mcp-json).
  // Global (user-scope) mode has no project context to scaffold into.
  const projectMode = opts.mcpJson;
  if (opts.skill && projectMode) {
    const result = writeSkillFile(process.cwd(), opts.scope, { remote: opts.remote });
    if (result.action === 'created') {
      process.stderr.write(`Scaffolded skill at ${result.path}.\n`);
    } else if (result.action === 'refreshed') {
      process.stderr.write(`Refreshed auto-managed section of ${result.path}.\n`);
    } else {
      process.stderr.write(`Skill at ${result.path} left untouched (no markers / no changes).\n`);
    }
  }
  if (opts.gitignore && projectMode) {
    const result = writeGitignoreBlock(process.cwd());
    if (result.action === 'created') {
      process.stderr.write(`Created .gitignore with Peek MCP entries at ${result.path}.\n`);
    } else if (result.action === 'updated') {
      process.stderr.write(`Updated Peek MCP block in ${result.path}.\n`);
    } else {
      process.stderr.write(`.gitignore at ${result.path} already current.\n`);
    }
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
