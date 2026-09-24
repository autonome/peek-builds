/**
 * Unit tests for build-info.ts
 *
 * Covers the interpretation of raw git output (dirty flag, detached HEAD,
 * worktree vs primary checkout), the log line, and reading a stamp back out
 * of a resources directory.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  resolveBuildInfo,
  formatBuildInfoLogLine,
  readBuildInfo,
  type BuildInfoInputs,
} from './build-info.js';

const BASE_INPUTS: BuildInfoInputs = {
  commit: '0123456789abcdef0123456789abcdef01234567',
  commitTime: '2026-09-20T10:00:00+00:00',
  porcelain: '',
  branch: 'main',
  toplevel: '/x/peek',
  buildTime: '2026-09-23T12:00:00.000Z',
  version: '0.0.1',
};

function inputs(overrides: Partial<BuildInfoInputs> = {}): BuildInfoInputs {
  return { ...BASE_INPUTS, ...overrides };
}

describe('build-info', () => {
  describe('resolveBuildInfo', () => {
    it('marks a non-empty porcelain as dirty', () => {
      const info = resolveBuildInfo(inputs({ porcelain: ' M apps/desktop/main/entry.ts\n' }));
      assert.strictEqual(info.dirty, true);
    });

    it('marks an empty porcelain as clean', () => {
      assert.strictEqual(resolveBuildInfo(inputs({ porcelain: '' })).dirty, false);
    });

    it('marks a whitespace-only porcelain as clean', () => {
      assert.strictEqual(resolveBuildInfo(inputs({ porcelain: '\n  \n' })).dirty, false);
    });

    it('reports a detached HEAD as no branch', () => {
      assert.strictEqual(resolveBuildInfo(inputs({ branch: 'HEAD' })).branch, null);
    });

    it('keeps a real branch name', () => {
      assert.strictEqual(resolveBuildInfo(inputs({ branch: 'track/foo' })).branch, 'track/foo');
    });

    it('calls a primary checkout main', () => {
      assert.strictEqual(resolveBuildInfo(inputs({ toplevel: '/x/peek' })).checkout, 'main');
    });

    it('names the worktree a build came from', () => {
      const info = resolveBuildInfo(inputs({ toplevel: '/x/peek/.worktrees/foo' }));
      assert.strictEqual(info.checkout, 'worktree:foo');
    });

    it('ignores path segments below the worktree root', () => {
      const info = resolveBuildInfo(inputs({ toplevel: '/x/peek/.worktrees/foo/bar' }));
      assert.strictEqual(info.checkout, 'worktree:foo');
    });

    it('abbreviates the commit to a prefix of the full id', () => {
      const info = resolveBuildInfo(inputs());
      assert.ok(info.commit.startsWith(info.shortCommit));
      assert.ok(info.shortCommit.length > 0 && info.shortCommit.length < info.commit.length);
    });

    it('carries the remaining inputs through unchanged', () => {
      const info = resolveBuildInfo(inputs());
      assert.strictEqual(info.commitTime, BASE_INPUTS.commitTime);
      assert.strictEqual(info.buildTime, BASE_INPUTS.buildTime);
      assert.strictEqual(info.version, BASE_INPUTS.version);
    });
  });

  describe('formatBuildInfoLogLine', () => {
    it('names the short commit and the dirty flag', () => {
      const info = resolveBuildInfo(inputs({ porcelain: ' M x\n' }));
      const line = formatBuildInfoLogLine(info);
      assert.ok(line.startsWith('[build]'));
      assert.ok(line.includes(info.shortCommit));
      assert.ok(line.includes('dirty=true'));
    });

    it('names the checkout and reports a clean tree', () => {
      const info = resolveBuildInfo(inputs({ toplevel: '/x/peek/.worktrees/foo' }));
      const line = formatBuildInfoLogLine(info);
      assert.ok(line.includes('worktree:foo'));
      assert.ok(line.includes('dirty=false'));
    });

    it('is a single line', () => {
      assert.ok(!formatBuildInfoLogLine(resolveBuildInfo(inputs())).includes('\n'));
    });
  });

  describe('readBuildInfo', () => {
    let dir: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-build-info-'));
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('returns the record a stamped resources directory holds', () => {
      const written = resolveBuildInfo(inputs({ toplevel: '/x/peek/.worktrees/foo' }));
      fs.writeFileSync(path.join(dir, 'build-info.json'), JSON.stringify(written, null, 2));
      assert.deepStrictEqual(readBuildInfo(dir), written);
    });

    it('returns null when the file is absent', () => {
      assert.strictEqual(readBuildInfo(dir), null);
    });

    it('returns null when the file holds malformed JSON', () => {
      fs.writeFileSync(path.join(dir, 'build-info.json'), '{ not json');
      assert.strictEqual(readBuildInfo(dir), null);
    });

    it('returns null when the JSON is not a build record', () => {
      fs.writeFileSync(path.join(dir, 'build-info.json'), '"just a string"');
      assert.strictEqual(readBuildInfo(dir), null);
    });
  });
});
