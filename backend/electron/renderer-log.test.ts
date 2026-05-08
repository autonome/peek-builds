/**
 * Unit tests for renderer-log.ts
 *
 * Tests the rotation logic and smoke-tests the write path directly without
 * spinning up Electron. Uses a temporary directory created by Node's fs APIs
 * (OS tmp dir is blocked in this project; we use the test runner's process tmpdir
 * but immediately under a subdirectory we clean up).
 *
 * Imports use the `__resetRendererLogForTest` seam so each test gets a clean
 * module state.
 */

import { describe, it, before, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  initRendererLog,
  writeRendererLogEntry,
  flushRendererLog,
  __resetRendererLogForTest,
} from './renderer-log.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = path.join(os.tmpdir(), `renderer-log-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rmDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
}

function readLog(dir: string, name = 'renderer.log'): string {
  const p = path.join(dir, name);
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

function fileExists(dir: string, name: string): boolean {
  try {
    fs.statSync(path.join(dir, name));
    return true;
  } catch {
    return false;
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('renderer-log', () => {
  let tmpDir: string;

  beforeEach(() => {
    __resetRendererLogForTest();
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    __resetRendererLogForTest();
    rmDir(tmpDir);
  });

  it('smoke: writes a single log entry to renderer.log', async () => {
    initRendererLog(tmpDir);
    writeRendererLogEntry('info', 'test:smoke', ['hello world']);
    await flushRendererLog();

    const content = readLog(tmpDir);
    assert.ok(content.includes('[info]'), `expected [info] in log, got: ${content}`);
    assert.ok(content.includes('test:smoke'), `expected source label in log, got: ${content}`);
    assert.ok(content.includes('hello world'), `expected message in log, got: ${content}`);
  });

  it('log line format: ISO timestamp, level, source, message on one line', async () => {
    initRendererLog(tmpDir);
    writeRendererLogEntry('warn', 'page-host:canvas-abc', ['Something happened']);
    await flushRendererLog();

    const lines = readLog(tmpDir).split('\n').filter(l => l.length > 0);
    assert.strictEqual(lines.length, 1, `expected exactly 1 line, got ${lines.length}`);
    const line = lines[0];
    // Should match: <ISO> [warn] page-host:canvas-abc Something happened
    assert.match(line, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z \[warn\] page-host:canvas-abc Something happened$/);
  });

  it('serialises Error args via stack/message', async () => {
    initRendererLog(tmpDir);
    const err = new Error('boom');
    writeRendererLogEntry('error', 'tile:mytile:home', [err]);
    await flushRendererLog();

    const content = readLog(tmpDir);
    assert.ok(content.includes('boom'), `expected error message in log, got: ${content}`);
  });

  it('serialises object args via JSON.stringify', async () => {
    initRendererLog(tmpDir);
    writeRendererLogEntry('log', 'tile:foo:bar', [{ key: 'value' }]);
    await flushRendererLog();

    const content = readLog(tmpDir);
    assert.ok(content.includes('"key"'), `expected JSON in log, got: ${content}`);
    assert.ok(content.includes('"value"'), `expected JSON value in log, got: ${content}`);
  });

  it('truncates args longer than 4 KB', async () => {
    initRendererLog(tmpDir);
    const bigStr = 'x'.repeat(5000);
    writeRendererLogEntry('log', 'tile:big:entry', [bigStr]);
    await flushRendererLog();

    const content = readLog(tmpDir);
    assert.ok(content.includes('[truncated]'), `expected truncation marker in log, got: ${content}`);
    // Line should be significantly shorter than 5000 chars for the arg alone.
    const lines = content.split('\n').filter(l => l.length > 0);
    assert.ok(lines[0].length < 5000, `line too long: ${lines[0].length}`);
  });

  it('multiple entries are appended as separate lines', async () => {
    initRendererLog(tmpDir);
    writeRendererLogEntry('log', 'tile:a:home', ['first']);
    writeRendererLogEntry('info', 'tile:b:home', ['second']);
    writeRendererLogEntry('warn', 'tile:c:home', ['third']);
    await flushRendererLog();

    const lines = readLog(tmpDir).split('\n').filter(l => l.length > 0);
    assert.strictEqual(lines.length, 3, `expected 3 lines, got: ${lines.length}`);
    assert.ok(lines[0].includes('first'));
    assert.ok(lines[1].includes('second'));
    assert.ok(lines[2].includes('third'));
  });

  it('rotation: renames renderer.log to renderer.log.1 when size exceeds 10 MB', async () => {
    initRendererLog(tmpDir);

    // Pre-fill with content just over 10 MB so the next write triggers rotation.
    const tenMbPlus = Buffer.alloc(10 * 1024 * 1024 + 1, 'a');
    fs.writeFileSync(path.join(tmpDir, 'renderer.log'), tenMbPlus);

    writeRendererLogEntry('log', 'tile:rotate:test', ['after rotation']);
    await flushRendererLog();

    // The old content should now be in renderer.log.1.
    assert.ok(fileExists(tmpDir, 'renderer.log.1'), 'renderer.log.1 should exist after rotation');

    // The new renderer.log should contain only the new line, not the 10 MB fill.
    const newLog = readLog(tmpDir, 'renderer.log');
    assert.ok(newLog.includes('after rotation'), `new log should have new entry: ${newLog}`);
    assert.ok(newLog.length < 10 * 1024 * 1024, 'new log should be smaller than 10 MB after rotation');
  });

  it('rotation: overwrites existing renderer.log.1', async () => {
    initRendererLog(tmpDir);

    // Pre-fill old .1 with sentinel.
    fs.writeFileSync(path.join(tmpDir, 'renderer.log.1'), 'old-rotated-content\n');

    // Pre-fill active log over 10 MB.
    const tenMbPlus = Buffer.alloc(10 * 1024 * 1024 + 1, 'b');
    fs.writeFileSync(path.join(tmpDir, 'renderer.log'), tenMbPlus);

    writeRendererLogEntry('log', 'tile:rotate:overwrite', ['new entry']);
    await flushRendererLog();

    // renderer.log.1 should NOT still contain the old sentinel (it was overwritten).
    const rotated = readLog(tmpDir, 'renderer.log.1');
    assert.ok(!rotated.includes('old-rotated-content'), `old .1 should have been overwritten, got: ${rotated}`);

    // New renderer.log has the new entry.
    const newLog = readLog(tmpDir, 'renderer.log');
    assert.ok(newLog.includes('new entry'), `new log should have new entry: ${newLog}`);
  });

  it('no rotation when size is below 10 MB', async () => {
    initRendererLog(tmpDir);

    // Small pre-existing content.
    fs.writeFileSync(path.join(tmpDir, 'renderer.log'), 'existing line\n');

    writeRendererLogEntry('log', 'tile:norotate:home', ['should append']);
    await flushRendererLog();

    // renderer.log.1 should NOT exist.
    assert.ok(!fileExists(tmpDir, 'renderer.log.1'), 'renderer.log.1 should not exist when no rotation needed');

    const content = readLog(tmpDir);
    assert.ok(content.includes('existing line'), 'existing content should still be present');
    assert.ok(content.includes('should append'), 'new entry should be appended');
  });

  it('initRendererLog is idempotent — second call is a no-op', async () => {
    initRendererLog(tmpDir);
    initRendererLog(tmpDir); // second call — should not register another IPC handler or reset state.

    writeRendererLogEntry('log', 'tile:idem:home', ['only once']);
    await flushRendererLog();

    const lines = readLog(tmpDir).split('\n').filter(l => l.length > 0);
    assert.strictEqual(lines.length, 1, `expected exactly 1 line, got: ${lines.length}`);
  });
});
