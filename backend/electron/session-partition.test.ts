/**
 * Unit tests for session-partition download helpers
 *
 * Pure Node tests — no Electron dependency.
 * Tests the resolveUniqueDownloadPath logic that prevents download failures
 * when the target filename already exists on disk.
 *
 * The function is copied here (from session-partition.ts) to avoid pulling
 * in Electron imports. The implementation in session-partition.ts is the
 * authoritative copy — keep in sync if changed.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ─── Logic under test (mirrored from session-partition.ts) ──────────
// Must stay in sync with resolveUniqueDownloadPath in session-partition.ts.

function resolveUniqueDownloadPath(desiredPath: string): string {
  if (!fs.existsSync(desiredPath)) {
    return desiredPath;
  }
  const ext = path.extname(desiredPath);
  const base = desiredPath.slice(0, desiredPath.length - ext.length);
  let counter = 1;
  while (true) {
    const candidate = `${base}-${counter}${ext}`;
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
    counter++;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

let tmpDir: string;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'session-partition-test-'));
}

function touch(filePath: string): void {
  fs.writeFileSync(filePath, '');
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('resolveUniqueDownloadPath', () => {
  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns the desired path unchanged when it does not exist', () => {
    const desired = path.join(tmpDir, 'download.jpg');
    const result = resolveUniqueDownloadPath(desired);
    assert.strictEqual(result, desired);
  });

  it('appends -1 before extension when file already exists', () => {
    const desired = path.join(tmpDir, 'download.jpg');
    touch(desired);
    const result = resolveUniqueDownloadPath(desired);
    assert.strictEqual(result, path.join(tmpDir, 'download-1.jpg'));
  });

  it('appends -2 when both original and -1 already exist', () => {
    const desired = path.join(tmpDir, 'download.jpg');
    touch(desired);
    touch(path.join(tmpDir, 'download-1.jpg'));
    const result = resolveUniqueDownloadPath(desired);
    assert.strictEqual(result, path.join(tmpDir, 'download-2.jpg'));
  });

  it('increments until a free slot is found', () => {
    const desired = path.join(tmpDir, 'report.pdf');
    touch(desired);
    touch(path.join(tmpDir, 'report-1.pdf'));
    touch(path.join(tmpDir, 'report-2.pdf'));
    touch(path.join(tmpDir, 'report-3.pdf'));
    const result = resolveUniqueDownloadPath(desired);
    assert.strictEqual(result, path.join(tmpDir, 'report-4.pdf'));
  });

  it('handles files without an extension', () => {
    const desired = path.join(tmpDir, 'Makefile');
    touch(desired);
    const result = resolveUniqueDownloadPath(desired);
    assert.strictEqual(result, path.join(tmpDir, 'Makefile-1'));
  });

  it('handles files with a dotfile-style name (leading dot, no other extension)', () => {
    // path.extname('.bashrc') returns '' in Node.js — no extension
    const desired = path.join(tmpDir, '.bashrc');
    touch(desired);
    const result = resolveUniqueDownloadPath(desired);
    assert.strictEqual(result, path.join(tmpDir, '.bashrc-1'));
  });

  it('handles files with multiple dots, preserving the last extension', () => {
    const desired = path.join(tmpDir, 'archive.tar.gz');
    touch(desired);
    const result = resolveUniqueDownloadPath(desired);
    assert.strictEqual(result, path.join(tmpDir, 'archive.tar-1.gz'));
  });
});

// ─── sanitizeDownloadFilename (mirrored from session-partition.ts) ──
// Must stay in sync with the implementation in session-partition.ts.

function sanitizeDownloadFilename(raw: string): string {
  // eslint-disable-next-line no-control-regex
  let cleaned = (raw || '').replace(/[\x00-\x1f/\\:*?"<>|]/g, '_').trim();
  if (cleaned === '' || cleaned === '.' || cleaned === '..') {
    cleaned = `download-${Date.now()}`;
  }
  if (cleaned.length > 200) {
    const ext = path.extname(cleaned);
    cleaned = cleaned.slice(0, 200 - ext.length) + ext;
  }
  return cleaned;
}

describe('sanitizeDownloadFilename', () => {
  it('preserves a normal filename', () => {
    assert.strictEqual(sanitizeDownloadFilename('photo.jpg'), 'photo.jpg');
  });

  it('preserves multi-dot extensions', () => {
    assert.strictEqual(sanitizeDownloadFilename('archive.tar.gz'), 'archive.tar.gz');
  });

  it('replaces filesystem-hostile chars with underscore', () => {
    assert.strictEqual(
      sanitizeDownloadFilename('a/b\\c:d*e?f"g<h>i|j.txt'),
      'a_b_c_d_e_f_g_h_i_j.txt',
    );
  });

  it('replaces control characters with underscore', () => {
    assert.strictEqual(sanitizeDownloadFilename('hello\x00world\x1f.bin'), 'hello_world_.bin');
  });

  it('replaces empty input with timestamped fallback', () => {
    assert.match(sanitizeDownloadFilename(''), /^download-\d+$/);
  });

  it('replaces "." and ".." with timestamped fallback', () => {
    assert.match(sanitizeDownloadFilename('.'), /^download-\d+$/);
    assert.match(sanitizeDownloadFilename('..'), /^download-\d+$/);
  });

  it('truncates absurdly long names while preserving the extension', () => {
    const long = 'a'.repeat(500) + '.zip';
    const out = sanitizeDownloadFilename(long);
    assert.ok(out.length <= 200, `expected <=200 got ${out.length}`);
    assert.ok(out.endsWith('.zip'), `expected .zip extension got ${out}`);
  });

  it('trims surrounding whitespace', () => {
    assert.strictEqual(sanitizeDownloadFilename('  hello.txt  '), 'hello.txt');
  });
});
