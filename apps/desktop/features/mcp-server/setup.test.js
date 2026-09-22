/**
 * Tests for setup.js — .gitignore managed-block behavior.
 *
 * Run with: node --test features/mcp-server/setup.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SETUP_JS = join(__dirname, 'setup.js');

const GITIGNORE_BEGIN = '# >>> peek-mcp-init (auto-managed) >>>';
const GITIGNORE_END = '# <<< peek-mcp-init (auto-managed) <<<';

// Create a temp dir with a stub db file that findDbPath() will accept.
function makeTmpProject() {
  const projDir = mkdtempSync(join(tmpdir(), 'peek-setup-'));
  const dbPath = join(projDir, 'db.sqlite');
  writeFileSync(dbPath, '');
  return { projDir, dbPath };
}

function runSetup(projDir, dbPath, extraArgs) {
  const args = [SETUP_JS, '--scope', 'testscope', '--mcp-json'];
  if (extraArgs) args.push(...extraArgs);
  try {
    execFileSync(process.execPath, args, {
      cwd: projDir,
      env: { ...process.env, PEEK_DB_PATH: dbPath },
    });
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString() : String(err);
    throw new Error('setup.js exited non-zero. stderr: ' + msg);
  }
}

// Helper: scaffold a fresh project with given extra args, returns { projDir, dbPath }
function scaffoldProject(extraArgs) {
  const { projDir, dbPath } = makeTmpProject();
  const args = [SETUP_JS, '--mcp-json', ...extraArgs];
  try {
    execFileSync(process.execPath, args, {
      cwd: projDir,
      env: { ...process.env, PEEK_DB_PATH: dbPath },
    });
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString() : String(err);
    throw new Error('setup.js exited non-zero during scaffold. stderr: ' + msg);
  }
  return { projDir, dbPath };
}

// Helper: run setup.js with no scope (refresh mode)
function runRefresh(projDir, dbPath) {
  execFileSync(process.execPath, [SETUP_JS], {
    cwd: projDir,
    env: { ...process.env, PEEK_DB_PATH: dbPath },
  });
}

describe('setup.js refresh mode', () => {
  let tmpDirs = [];

  after(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refresh: no-arg re-run recovers scope from existing .mcp.json', () => {
    const { projDir, dbPath } = scaffoldProject(['--scope', 'refreshme', '--writes']);
    tmpDirs.push(projDir);

    runRefresh(projDir, dbPath);

    const mcpJsonPath = join(projDir, '.mcp.json');
    const parsed = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
    assert.strictEqual(parsed.mcpServers.peek.env.PEEK_MCP_SCOPE_TAG, 'refreshme');
  });

  it('refresh: preserves writes - read-only flag unset after writes scaffold', () => {
    const { projDir, dbPath } = scaffoldProject(['--scope', 'writetag', '--writes']);
    tmpDirs.push(projDir);

    runRefresh(projDir, dbPath);

    const mcpJsonPath = join(projDir, '.mcp.json');
    const parsed = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
    assert.strictEqual(parsed.mcpServers.peek.env.PEEK_MCP_READONLY, undefined);
  });

  it('refresh: preserves read-only state', () => {
    const { projDir, dbPath } = scaffoldProject(['--scope', 'roproj']);
    tmpDirs.push(projDir);

    runRefresh(projDir, dbPath);

    const mcpJsonPath = join(projDir, '.mcp.json');
    const parsed = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
    assert.strictEqual(parsed.mcpServers.peek.env.PEEK_MCP_READONLY, '1');
  });

  it('refresh: errors when no existing install', () => {
    const { projDir, dbPath } = makeTmpProject();
    tmpDirs.push(projDir);

    let threw = false;
    try {
      runRefresh(projDir, dbPath);
    } catch {
      threw = true;
    }
    assert.ok(threw, 'setup.js should exit non-zero when no existing install found');
  });
});

describe('setup.js default destination (user scope)', () => {
  let tmpDirs = [];

  after(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Run setup.js with NO dest flag in an isolated HOME so it writes to
  // <HOME>/.claude.json (Claude Code's user-scope file) instead of the real
  // one. Returns the parsed ~/.claude.json.
  function runGlobal(homeDir, dbPath, extraArgs = []) {
    const args = [SETUP_JS, '--scope', 'globaltag', ...extraArgs];
    execFileSync(process.execPath, args, {
      cwd: homeDir,
      env: { ...process.env, HOME: homeDir, PEEK_DB_PATH: dbPath },
    });
  }

  it('writes mcpServers.peek to ~/.claude.json (not ~/.claude/settings.json)', () => {
    const home = mkdtempSync(join(tmpdir(), 'peek-setup-home-'));
    tmpDirs.push(home);
    const dbPath = join(home, 'db.sqlite');
    writeFileSync(dbPath, '');

    runGlobal(home, dbPath);

    const claudeJson = join(home, '.claude.json');
    assert.ok(existsSync(claudeJson), '~/.claude.json should be written');
    const parsed = JSON.parse(readFileSync(claudeJson, 'utf-8'));
    assert.ok(parsed.mcpServers && parsed.mcpServers.peek, 'top-level mcpServers.peek should exist');
    assert.strictEqual(parsed.mcpServers.peek.env.PEEK_MCP_SCOPE_TAG, 'globaltag');

    // The dead location must NOT be written.
    assert.ok(!existsSync(join(home, '.claude', 'settings.json')),
      '~/.claude/settings.json must not be created');
  });

  it('read-merges — preserves existing ~/.claude.json keys (Claude Code state)', () => {
    const home = mkdtempSync(join(tmpdir(), 'peek-setup-home-'));
    tmpDirs.push(home);
    const dbPath = join(home, 'db.sqlite');
    writeFileSync(dbPath, '');

    // Simulate Claude Code's live state file with auth/projects + an existing
    // non-peek server. A naive overwrite would destroy these.
    const claudeJson = join(home, '.claude.json');
    writeFileSync(claudeJson, JSON.stringify({
      oauthAccount: { id: 'keep-me' },
      projects: { '/some/proj': { mcpServers: {} } },
      mcpServers: { other: { command: 'x' } },
    }, null, 2) + '\n');

    runGlobal(home, dbPath, ['--no-allow']);

    const parsed = JSON.parse(readFileSync(claudeJson, 'utf-8'));
    assert.deepStrictEqual(parsed.oauthAccount, { id: 'keep-me' }, 'auth key preserved');
    assert.ok(parsed.projects && parsed.projects['/some/proj'], 'projects preserved');
    assert.ok(parsed.mcpServers.other, 'existing non-peek server preserved');
    assert.ok(parsed.mcpServers.peek, 'peek entry added');
  });
});

describe('setup.js allow-list destination (settings.local.json)', () => {
  let tmpDirs = [];

  after(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('project scope (--mcp-json): allow entries land in <cwd>/.claude/settings.local.json', () => {
    const { projDir, dbPath } = makeTmpProject();
    tmpDirs.push(projDir);

    runSetup(projDir, dbPath);

    const allowPath = join(projDir, '.claude', 'settings.local.json');
    assert.ok(existsSync(allowPath), '.claude/settings.local.json should be written');
    const parsed = JSON.parse(readFileSync(allowPath, 'utf-8'));
    assert.ok(Array.isArray(parsed.permissions.allow), 'permissions.allow should be an array');
    assert.ok(parsed.permissions.allow.some((e) => e.startsWith('mcp__peek__')),
      'should contain mcp__peek__* allow entries');
  });

  it('user scope (default dest): allow entries land in $HOME/.claude/settings.local.json, not the flat $HOME/settings.local.json', () => {
    const home = mkdtempSync(join(tmpdir(), 'peek-setup-home-'));
    tmpDirs.push(home);
    const dbPath = join(home, 'db.sqlite');
    writeFileSync(dbPath, '');

    execFileSync(process.execPath, [SETUP_JS, '--scope', 'globaltag'], {
      cwd: home,
      env: { ...process.env, HOME: home, PEEK_DB_PATH: dbPath },
    });

    // This is the real Claude Code user-scope settings.local.json path —
    // the flat ~/settings.local.json sibling the old code computed is a file
    // the client never reads, so entries written there had no effect.
    const allowPath = join(home, '.claude', 'settings.local.json');
    assert.ok(existsSync(allowPath), '~/.claude/settings.local.json should be written');
    const parsed = JSON.parse(readFileSync(allowPath, 'utf-8'));
    assert.ok(parsed.permissions.allow.some((e) => e.startsWith('mcp__peek__')),
      'should contain mcp__peek__* allow entries');

    // The dead location must NOT be written.
    assert.ok(!existsSync(join(home, 'settings.local.json')),
      'the flat ~/settings.local.json (never read by Claude Code) must not be created');
  });
});

describe('scaffolded skill — tag model', () => {
  let tmpDirs = [];

  after(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function readSkill(projDir) {
    return readFileSync(join(projDir, '.claude', 'skills', 'peek.md'), 'utf-8');
  }

  it('does NOT instruct untagging the bare scope tag', () => {
    const { projDir, dbPath } = scaffoldProject(['--scope', 'membertag']);
    tmpDirs.push(projDir);
    const skill = readSkill(projDir);

    // The old model told agents to untag_item the auto-added bare scope tag.
    assert.ok(
      !/untag_item\([^)]*tagName:\s*'membertag'\s*[}),]/.test(skill),
      'skill must not tell agents to untag the bare scope tag',
    );
    assert.ok(
      !/redundant|pollutes the reserved/i.test(skill),
      'skill must not frame the bare scope tag as redundant/pollution',
    );
    // No "this used to be X" / reversal framing.
    assert.ok(
      !/used to|previously|no longer|formerly|reversal/i.test(skill),
      'skill must state the model as a present-tense spec, not a changelog',
    );
  });

  it('states the bare scope tag is the membership tag, always present', () => {
    const { projDir, dbPath } = scaffoldProject(['--scope', 'membertag']);
    tmpDirs.push(projDir);
    const skill = readSkill(projDir);

    assert.ok(/membership tag/i.test(skill), 'skill should name the membership tag');
    assert.ok(
      /[Ee]very item.*membertag/.test(skill) || /membertag.*every item/i.test(skill),
      'skill should state every item carries the scope tag',
    );
    assert.ok(
      /triage|untriaged|intake/i.test(skill),
      'skill should describe the scope-tag-only triage inbox',
    );
  });

  it('describes the list_tasks/complete_task scope defaults and keeps the bare todo/done warning', () => {
    const { projDir, dbPath } = scaffoldProject(['--scope', 'membertag']);
    tmpDirs.push(projDir);
    const skill = readSkill(projDir);

    assert.ok(
      skill.includes("`mcp__peek__list_tasks()` in a scoped session defaults to `tags: ['membertag:todo']`"),
      'skill should state list_tasks defaults to the scope todo tag in a scoped session',
    );
    assert.ok(
      skill.includes('`mcp__peek__complete_task({ itemId })` moves the task to `membertag:needs-review`'),
      'skill should state complete_task moves the task to the scope needs-review tag',
    );
    assert.ok(
      skill.includes('clearing `membertag:todo` / `membertag:wip` / the readiness markers (`membertag:ready` / `membertag:triage`)'),
      'skill should state complete_task clears the todo/wip/readiness tags',
    );
    assert.ok(
      skill.includes('`mcp__peek__complete_task({ itemId, accepted: true })` moves it to `membertag:done` instead'),
      'skill should state accepted: true moves the task to the scope done tag',
    );
    assert.ok(
      /only for when the task's owner has approved the work in the current conversation/i.test(skill),
      'skill should state accepted: true is only for owner-approved work',
    );
    assert.ok(
      /bare `?todo`? \/? ?`?done`?/i.test(skill),
      'skill should still warn about bare todo/done',
    );
    assert.ok(
      /cross-project|shared across every project|unnamespaced/i.test(skill),
      'skill should explain bare todo/done are cross-project',
    );
  });

  it('substitutes a non-peek scope tag with no stray literal "peek" in the rule', () => {
    const { projDir, dbPath } = scaffoldProject(['--scope', 'hezo']);
    tmpDirs.push(projDir);
    const skill = readSkill(projDir);

    // Isolate the auto-managed body.
    const begin = skill.indexOf('<!-- PEEK_SKILL_BODY_BEGIN -->');
    const end = skill.indexOf('<!-- PEEK_SKILL_BODY_END -->');
    const body = skill.slice(begin, end);

    assert.ok(/hezo:todo/.test(body), 'scope tag should be substituted in');

    // No leaked literal "peek" standing in for the scope tag: backtick-quoted
    // tag references should use the substituted scope, never `peek` / `peek:*`.
    assert.ok(
      !/`peek(:[\w-]+)?`/.test(body),
      'no backtick-quoted literal `peek` tag should leak into a non-peek scope',
    );

    // The Tag model section in particular must be fully substituted.
    const tagModel = body.slice(
      body.indexOf('## Tag model'),
      body.indexOf('## Status lives'),
    );
    assert.ok(tagModel.length > 0, 'Tag model section should exist');
    assert.ok(/membership tag/i.test(tagModel), 'Tag model names the membership tag');
    assert.ok(/hezo/.test(tagModel), 'Tag model uses the substituted scope tag');
    assert.ok(
      !/\bpeek\b/i.test(tagModel.replace(/mcp__peek__/g, '')),
      'no stray literal "peek" in the Tag model rule text for a non-peek scope',
    );
  });
});

describe('setup.js .gitignore managed block', () => {
  let tmpDirs = [];

  after(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes managed .gitignore block with all three files', () => {
    const { projDir, dbPath } = makeTmpProject();
    tmpDirs.push(projDir);

    runSetup(projDir, dbPath);

    const gitignorePath = join(projDir, '.gitignore');
    assert.ok(existsSync(gitignorePath), '.gitignore should be created');
    const content = readFileSync(gitignorePath, 'utf-8');
    assert.ok(content.includes(GITIGNORE_BEGIN), 'should contain BEGIN sentinel');
    assert.ok(content.includes(GITIGNORE_END), 'should contain END sentinel');
    assert.ok(content.includes('.mcp.json'), 'should list .mcp.json');
    assert.ok(content.includes('.claude/settings.local.json'), 'should list .claude/settings.local.json');
    assert.ok(content.includes('.claude/skills/peek.md'), 'should list .claude/skills/peek.md');
  });

  it('is idempotent — running twice does not duplicate the block', () => {
    const { projDir, dbPath } = makeTmpProject();
    tmpDirs.push(projDir);

    runSetup(projDir, dbPath);
    runSetup(projDir, dbPath);

    const content = readFileSync(join(projDir, '.gitignore'), 'utf-8');
    const occurrences = content.split(GITIGNORE_BEGIN).length - 1;
    assert.strictEqual(occurrences, 1, 'BEGIN sentinel should appear exactly once');
  });

  it('preserves pre-existing .gitignore content', () => {
    const { projDir, dbPath } = makeTmpProject();
    tmpDirs.push(projDir);

    writeFileSync(join(projDir, '.gitignore'), 'node_modules\n');
    runSetup(projDir, dbPath);

    const content = readFileSync(join(projDir, '.gitignore'), 'utf-8');
    assert.ok(content.includes('node_modules'), 'should preserve pre-existing content');
    assert.ok(content.includes(GITIGNORE_BEGIN), 'should also contain the managed block');
  });

  it('--no-gitignore skips creating .gitignore', () => {
    const { projDir, dbPath } = makeTmpProject();
    tmpDirs.push(projDir);

    runSetup(projDir, dbPath, ['--no-gitignore']);

    const gitignorePath = join(projDir, '.gitignore');
    if (existsSync(gitignorePath)) {
      const content = readFileSync(gitignorePath, 'utf-8');
      assert.ok(
        !content.includes(GITIGNORE_BEGIN),
        '.gitignore should not contain the managed block when --no-gitignore is passed',
      );
    }
    // If the file doesn't exist at all, that's also fine — the test passes.
  });
});

describe('setup.js --remote', () => {
  let tmpDirs = [];

  after(() => {
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const FAKE_URL = 'https://sync.example.invalid';

  // Remote runs never need a datastore — no PEEK_DB_PATH, no db file at all,
  // and a fresh, isolated HOME so a real ~/.config/peek/mcp-credentials.json
  // is never touched.
  function makeRemoteProject() {
    const projDir = mkdtempSync(join(tmpdir(), 'peek-setup-remote-'));
    const home = mkdtempSync(join(tmpdir(), 'peek-setup-remote-home-'));
    return { projDir, home };
  }

  function runRemoteSetup(projDir, home, extraArgs, input) {
    const args = [SETUP_JS, '--scope', 'remotescope', '--mcp-json', '--remote', FAKE_URL, ...extraArgs];
    const opts = { cwd: projDir, env: { ...process.env, HOME: home } };
    delete opts.env.PEEK_DB_PATH;
    if (input !== undefined) opts.input = input;
    try {
      return execFileSync(process.execPath, args, opts);
    } catch (err) {
      const msg = err.stderr ? err.stderr.toString() : String(err);
      throw new Error('setup.js exited non-zero. stderr: ' + msg);
    }
  }

  function readMcpJson(projDir) {
    return JSON.parse(readFileSync(join(projDir, '.mcp.json'), 'utf-8'));
  }

  // All regular files under dir, recursively — used to sweep an entire
  // scaffolded project for a value that must never land in it.
  function walkFiles(dir) {
    let out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) out = out.concat(walkFiles(p));
      else out.push(p);
    }
    return out;
  }

  it('omits PEEK_DB_PATH and never looks for a local datastore', () => {
    const { projDir, home } = makeRemoteProject();
    tmpDirs.push(projDir, home);

    // No PEEK_DB_PATH, no datastore.sqlite anywhere under this isolated HOME —
    // the local-mode fatal exit would trigger here if remote mode still ran
    // findDbPath().
    runRemoteSetup(projDir, home, []);

    const parsed = readMcpJson(projDir);
    const env = parsed.mcpServers.peek.env;
    assert.strictEqual(env.PEEK_DB_PATH, undefined, 'PEEK_DB_PATH must be omitted in remote mode');
    // The url passed to --remote is never written literally — a server URL
    // carries a hostname, so the entry only ever carries an unresolved
    // $PEEK_SYNC_URL reference the caller's shell must export.
    assert.strictEqual(env.PEEK_MCP_REMOTE_URL, '${PEEK_SYNC_URL}');
    assert.strictEqual(env.PEEK_MCP_SCOPE_TAG, 'remotescope');
  });

  it('drops --experimental-sqlite from the dev launcher fallback', () => {
    const { projDir, home } = makeRemoteProject();
    tmpDirs.push(projDir, home);

    runRemoteSetup(projDir, home, []);

    const parsed = readMcpJson(projDir);
    const peek = parsed.mcpServers.peek;
    assert.strictEqual(peek.command, 'node');
    assert.ok(!peek.args.includes('--experimental-sqlite'),
      'remote mode must not pass --experimental-sqlite (nothing loads node:sqlite)');
  });

  it('without --store-token, references $PEEK_MCP_TOKEN unexpanded rather than a literal secret', () => {
    const { projDir, home } = makeRemoteProject();
    tmpDirs.push(projDir, home);

    runRemoteSetup(projDir, home, []);

    const parsed = readMcpJson(projDir);
    const env = parsed.mcpServers.peek.env;
    // The literal, unresolved reference is the point: Claude Code expands it
    // from the launching shell. If the shell never set it, Claude Code passes
    // the literal "${...}" text through unexpanded — which is what lets a
    // startup guard downstream detect the leading "${" and fail loudly
    // instead of sending it as a bearer token.
    assert.strictEqual(env.PEEK_MCP_TOKEN, '${PEEK_MCP_TOKEN}');
    assert.strictEqual(env.PEEK_MCP_CREDENTIAL, undefined);
  });

  it('--store-token reads the token from stdin only, never argv, stdout, or stderr', () => {
    const { projDir, home } = makeRemoteProject();
    tmpDirs.push(projDir, home);

    const fakeToken = 'fake-minted-token-do-not-use-1234567890';
    const stderr = runRemoteSetup(projDir, home, ['--store-token'], fakeToken + '\n');

    assert.ok(!stderr.toString().includes(fakeToken), 'token must never be echoed to stderr');

    const parsed = readMcpJson(projDir);
    const env = parsed.mcpServers.peek.env;
    assert.strictEqual(env.PEEK_MCP_TOKEN, undefined, '--store-token must not also emit the env reference');
    // The lookup key is itself a $PEEK_SYNC_URL reference — the host never
    // lands in the project, only in the 0600 credential file it points into.
    assert.strictEqual(env.PEEK_MCP_CREDENTIAL, '${PEEK_SYNC_URL}#remotescope');

    // The token — and the concrete host — live only in the 0600 credential
    // file outside the project, keyed by the real url#scope pair.
    const credPath = join(home, '.config', 'peek', 'mcp-credentials.json');
    assert.ok(existsSync(credPath), 'credential file should be written');
    const mode = statSync(credPath).mode & 0o777;
    assert.strictEqual(mode, 0o600, 'credential file must be mode 0600');

    const credData = JSON.parse(readFileSync(credPath, 'utf-8'));
    const entry = credData.credentials[`${FAKE_URL}#remotescope`];
    assert.ok(entry, 'credential file should have an entry keyed by the real url#scope pair');
    assert.strictEqual(entry.token, fakeToken);

    // And the token must never appear anywhere in the project.
    const mcpJsonRaw = readFileSync(join(projDir, '.mcp.json'), 'utf-8');
    assert.ok(!mcpJsonRaw.includes(fakeToken), 'token must never be written into a project file');
  });

  it('--print with --store-token never touches stdin or writes the credential file', () => {
    const { projDir, home } = makeRemoteProject();
    tmpDirs.push(projDir, home);

    // No `input` supplied — if setup.js tried to read stdin here it would
    // either hang or read EOF; either way the credential file must not appear.
    const args = [SETUP_JS, '--scope', 'remotescope', '--remote', FAKE_URL, '--store-token', '--print'];
    const stdout = execFileSync(process.execPath, args, {
      cwd: projDir,
      env: { ...process.env, HOME: home },
      input: '',
    });

    const printed = JSON.parse(stdout.toString());
    assert.strictEqual(printed.mcpServers.peek.env.PEEK_MCP_REMOTE_URL, '${PEEK_SYNC_URL}');
    assert.strictEqual(printed.mcpServers.peek.env.PEEK_MCP_TOKEN, '${PEEK_MCP_TOKEN}');
    assert.strictEqual(printed.mcpServers.peek.env.PEEK_MCP_CREDENTIAL, undefined);

    const credPath = join(home, '.config', 'peek', 'mcp-credentials.json');
    assert.ok(!existsSync(credPath), '--print must not write the credential file');
  });

  it('replaces a pre-existing raw-keyed entry for the same target, leaving exactly one entry', () => {
    const { projDir, home } = makeRemoteProject();
    tmpDirs.push(projDir, home);

    // Simulates a file written before key normalization existed: the raw
    // url (trailing slash and all) baked straight into the stored key.
    const slashedUrl = `${FAKE_URL}/`;
    const credDir = join(home, '.config', 'peek');
    mkdirSync(credDir, { recursive: true });
    const credPath = join(credDir, 'mcp-credentials.json');
    writeFileSync(credPath, JSON.stringify({
      credentials: { [`${slashedUrl}#remotescope`]: { token: 'stale-token', label: 'old' } },
    }, null, 2) + '\n');

    const fakeToken = 'fake-minted-token-replace-raw-entry';
    // Re-run with the same (slashed) url — the exact scenario a re-typed
    // --remote invocation produces. runRemoteSetup() always passes the
    // unslashed FAKE_URL, so this drives setup.js directly instead.
    const args = [SETUP_JS, '--scope', 'remotescope', '--mcp-json', '--remote', slashedUrl, '--store-token'];
    execFileSync(process.execPath, args, {
      cwd: projDir,
      env: { ...process.env, HOME: home },
      input: fakeToken + '\n',
    });

    const credData = JSON.parse(readFileSync(credPath, 'utf-8'));
    const keys = Object.keys(credData.credentials);
    assert.strictEqual(keys.length, 1, `expected exactly one entry, got: ${keys.join(', ')}`);
    assert.strictEqual(keys[0], `${FAKE_URL}#remotescope`, 'surviving entry should be under the normalized key');
    assert.strictEqual(credData.credentials[keys[0]].token, fakeToken);
  });

  it('credential file mode stays 0600 after a second write', () => {
    const { projDir, home } = makeRemoteProject();
    tmpDirs.push(projDir, home);

    runRemoteSetup(projDir, home, ['--store-token'], 'first-token\n');
    runRemoteSetup(projDir, home, ['--store-token'], 'second-token\n');

    const credPath = join(home, '.config', 'peek', 'mcp-credentials.json');
    const mode = statSync(credPath).mode & 0o777;
    assert.strictEqual(mode, 0o600, 'credential file must stay mode 0600 after a second write');
  });

  it('detectExistingInstall recognises a remote entry on refresh', () => {
    const { projDir, home } = makeRemoteProject();
    tmpDirs.push(projDir, home);

    runRemoteSetup(projDir, home, ['--writes']);

    // Bare re-run: no --scope, no --remote.
    execFileSync(process.execPath, [SETUP_JS], {
      cwd: projDir,
      env: { ...process.env, HOME: home },
    });

    const parsed = readMcpJson(projDir);
    const env = parsed.mcpServers.peek.env;
    assert.strictEqual(env.PEEK_MCP_REMOTE_URL, '${PEEK_SYNC_URL}', 'remote mode should be recovered on refresh');
    assert.strictEqual(env.PEEK_MCP_SCOPE_TAG, 'remotescope');
    assert.strictEqual(env.PEEK_MCP_READONLY, undefined, 'writes should be preserved on refresh');
    assert.strictEqual(env.PEEK_DB_PATH, undefined, 'refresh of a remote install must not reintroduce PEEK_DB_PATH');
  });

  it('the host passed to --remote never appears anywhere inside the scaffolded project', () => {
    const { projDir, home } = makeRemoteProject();
    tmpDirs.push(projDir, home);

    // Exercise every file the scaffolder writes under the project — .mcp.json,
    // settings.local.json, the skill, .gitignore — with --store-token too, so
    // the credential-file key path is covered as well as the plain entry.
    const fakeToken = 'fake-minted-token-do-not-use-project-scan';
    runRemoteSetup(projDir, home, ['--store-token'], fakeToken + '\n');

    const host = new URL(FAKE_URL).host;
    const files = walkFiles(projDir);
    assert.ok(files.length > 0, 'sanity: the project should have scaffolded files');
    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      assert.ok(!content.includes(host), `${file} must not contain the remote host ${host}`);
      assert.ok(!content.includes(FAKE_URL), `${file} must not contain the full remote URL`);
    }
  });

  it('scaffolds the skill with a remote paragraph inside the managed section', () => {
    const { projDir, home } = makeRemoteProject();
    tmpDirs.push(projDir, home);

    runRemoteSetup(projDir, home, []);

    const skill = readFileSync(join(projDir, '.claude', 'skills', 'peek.md'), 'utf-8');
    const begin = skill.indexOf('<!-- PEEK_SKILL_BODY_BEGIN -->');
    const end = skill.indexOf('<!-- PEEK_SKILL_BODY_END -->');
    const body = skill.slice(begin, end);

    assert.ok(/localId/.test(body), 'remote paragraph should mention localId');
    assert.ok(/no\s+offline\s+mode/i.test(body), 'remote paragraph should state there is no offline mode');
  });

  it('local (non-remote) scaffold has no remote paragraph — unaffected by this feature', () => {
    const { projDir, dbPath } = scaffoldProject(['--scope', 'localonly']);
    tmpDirs.push(projDir);

    const skill = readFileSync(join(projDir, '.claude', 'skills', 'peek.md'), 'utf-8');
    assert.ok(!/localId/.test(skill), 'local scaffold must not carry the remote paragraph');
  });
});
