/**
 * Tests for setup.js — .gitignore managed-block behavior.
 *
 * Run with: node --test features/mcp-server/setup.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
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

  it('keeps the bare todo/done cross-project warning (separate concern)', () => {
    const { projDir, dbPath } = scaffoldProject(['--scope', 'membertag']);
    tmpDirs.push(projDir);
    const skill = readSkill(projDir);

    assert.ok(
      /bare `?todo`? \/? ?`?done`?/i.test(skill) || /bare `todo`/.test(skill),
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
