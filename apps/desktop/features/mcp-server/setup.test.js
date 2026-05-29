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
