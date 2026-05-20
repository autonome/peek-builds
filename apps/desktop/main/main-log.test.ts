/**
 * Unit tests for main-log.ts
 *
 * Tests rotation, serialisation, the writeMainLogEntry seam, and console
 * patching. Uses a temporary directory and the `__resetMainLogForTest` seam
 * to keep tests isolated.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  initMainLog,
  writeMainLogEntry,
  flushMainLog,
  __resetMainLogForTest,
} from './main-log.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = path.join(os.tmpdir(), `main-log-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
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

function readLog(dir: string, name = 'main.log'): string {
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

describe('main-log', () => {
  let tmpDir: string;

  beforeEach(() => {
    __resetMainLogForTest();
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    __resetMainLogForTest();
    rmDir(tmpDir);
  });

  it('smoke: writes a single log entry to main.log', async () => {
    initMainLog(tmpDir);
    writeMainLogEntry('info', ['hello main']);
    await flushMainLog();

    const content = readLog(tmpDir);
    assert.ok(content.includes('[info]'), `expected [info] in log, got: ${content}`);
    assert.ok(content.includes('main hello main'), `expected message line, got: ${content}`);
  });

  it('log line format: ISO timestamp, level, "main", message', async () => {
    initMainLog(tmpDir);
    writeMainLogEntry('warn', ['Something happened']);
    await flushMainLog();

    const lines = readLog(tmpDir).split('\n').filter(l => l.length > 0);
    assert.strictEqual(lines.length, 1, `expected exactly 1 line, got ${lines.length}`);
    assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z \[warn\] main Something happened$/);
  });

  it('console.log is mirrored to the file', async () => {
    initMainLog(tmpDir);
    console.log('from-console', { id: 42 });
    await flushMainLog();

    const content = readLog(tmpDir);
    assert.ok(content.includes('from-console'), `expected console.log message in log, got: ${content}`);
    assert.ok(content.includes('"id":42'), `expected JSON-serialised object arg, got: ${content}`);
    assert.ok(content.includes('[log]'), `expected level label, got: ${content}`);
  });

  it('console.warn / error / info / debug all mirror through', async () => {
    initMainLog(tmpDir);
    console.info('hello-info');
    console.warn('hello-warn');
    console.error('hello-error');
    console.debug('hello-debug');
    await flushMainLog();

    const content = readLog(tmpDir);
    assert.ok(content.includes('[info] main hello-info'));
    assert.ok(content.includes('[warn] main hello-warn'));
    assert.ok(content.includes('[error] main hello-error'));
    assert.ok(content.includes('[debug] main hello-debug'));
  });

  it('serialises Error args via stack/message', async () => {
    initMainLog(tmpDir);
    writeMainLogEntry('error', [new Error('boom')]);
    await flushMainLog();

    assert.ok(readLog(tmpDir).includes('boom'));
  });

  it('truncates args longer than 4 KB', async () => {
    initMainLog(tmpDir);
    writeMainLogEntry('log', ['x'.repeat(5000)]);
    await flushMainLog();

    const content = readLog(tmpDir);
    assert.ok(content.includes('[truncated]'), `expected truncation marker, got: ${content}`);
    const lines = content.split('\n').filter(l => l.length > 0);
    assert.ok(lines[0].length < 5000, `line too long: ${lines[0].length}`);
  });

  it('rotation: renames main.log to main.log.1 when size exceeds 10 MB', async () => {
    initMainLog(tmpDir);

    const tenMbPlus = Buffer.alloc(10 * 1024 * 1024 + 1, 'a');
    fs.writeFileSync(path.join(tmpDir, 'main.log'), tenMbPlus);

    writeMainLogEntry('log', ['after rotation']);
    await flushMainLog();

    assert.ok(fileExists(tmpDir, 'main.log.1'), 'main.log.1 should exist after rotation');
    const newLog = readLog(tmpDir, 'main.log');
    assert.ok(newLog.includes('after rotation'), `new log should have new entry: ${newLog}`);
    assert.ok(newLog.length < 10 * 1024 * 1024, 'new log should be smaller than 10 MB after rotation');
  });

  it('no rotation when size is below 10 MB', async () => {
    initMainLog(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'main.log'), 'existing line\n');

    writeMainLogEntry('log', ['should append']);
    await flushMainLog();

    assert.ok(!fileExists(tmpDir, 'main.log.1'), 'main.log.1 should not exist when no rotation needed');
    const content = readLog(tmpDir);
    assert.ok(content.includes('existing line'));
    assert.ok(content.includes('should append'));
  });

  it('initMainLog is idempotent — second call does not double-wrap console', async () => {
    initMainLog(tmpDir);
    initMainLog(tmpDir); // second call should be a no-op

    console.log('only-once');
    await flushMainLog();

    const lines = readLog(tmpDir).split('\n').filter(l => l.includes('only-once'));
    assert.strictEqual(lines.length, 1, `expected exactly 1 line containing 'only-once', got ${lines.length}`);
  });

  it('__resetMainLogForTest restores original console behavior', async () => {
    initMainLog(tmpDir);
    console.log('captured');
    await flushMainLog();
    assert.ok(readLog(tmpDir).includes('captured'));

    __resetMainLogForTest();

    // After reset, console.log should NOT write to the (now-cleared) state.
    console.log('after-reset');
    await flushMainLog();
    // The log file was created inside tmpDir, but after reset writeQueue is
    // empty and logFilePath is null — no writes should land. Re-read the file
    // to confirm 'after-reset' did not get appended.
    const content = readLog(tmpDir);
    assert.ok(!content.includes('after-reset'), `after reset, console.log should not write: ${content}`);
  });
});
