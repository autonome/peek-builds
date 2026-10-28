import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PROBES } from './core/index.js';
import { buildRows, writeSnapshot } from './fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const runScript = join(here, 'run.mjs');

function cli(env) {
  const { ACTIVITY_SNAPSHOT, ACTIVITY_OUT, ...rest } = process.env;
  return spawnSync(process.execPath, [runScript], { env: { ...rest, ...env }, encoding: 'utf8' });
}

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'activity-run-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('with ACTIVITY_OUT unset the CLI exits 2', () => {
  withTmp((dir) => {
    const snap = join(dir, 's.sqlite');
    writeSnapshot(snap, buildRows());
    const r = cli({ ACTIVITY_SNAPSHOT: snap });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /ACTIVITY_OUT/);
  });
});

test('with ACTIVITY_SNAPSHOT unset the CLI exits 2', () => {
  const r = cli({ ACTIVITY_OUT: tmpdir() });
  assert.equal(r.status, 2);
});

test('with ACTIVITY_OUT inside the repo the CLI refuses and writes nothing', () => {
  withTmp((dir) => {
    const snap = join(dir, 's.sqlite');
    writeSnapshot(snap, buildRows());
    const out = join(here, 'refused-output');
    const r = cli({ ACTIVITY_SNAPSHOT: snap, ACTIVITY_OUT: out });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Refusing/);
    assert.equal(existsSync(out), false);
  });
});

test('with a temp out dir the CLI writes tables and a report with one entry per probe', () => {
  withTmp((dir) => {
    const snap = join(dir, 's.sqlite');
    const out = join(dir, 'out', 'nested');
    writeSnapshot(snap, buildRows({ withVisits: true }), { withVisits: true });
    const r = cli({ ACTIVITY_SNAPSHOT: snap, ACTIVITY_OUT: out });
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
    assert.equal(report.length, PROBES.length);
    assert.deepEqual(
      report.map((x) => x.name),
      PROBES.map((p) => p.name),
    );
    assert.match(readFileSync(join(out, 'report.md'), 'utf8'), /entity-groups/);
    for (const t of ['pages', 'entities', 'sightings', 'sessions', 'notes', 'labels']) {
      assert.ok(existsSync(join(out, `${t}.jsonl`)), t);
    }
    const pageLines = readFileSync(join(out, 'pages.jsonl'), 'utf8').trim().split('\n');
    assert.equal(pageLines.length, 60);
  });
});
