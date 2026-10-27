import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  NOTICE, NOTICE_HASH, NOTICE_VERSION, consentRecordPath, createAcceptanceRecord,
  isValidAcceptanceRecord, allAcknowledged, readAcceptanceRecord,
  persistAcceptanceRecord, createStartupConsentGate, readAcceptanceRecordSync,
  validatePendingUrl, createPendingWork, interactiveDisplayAvailable,
  type ConsentDependencies,
} from './startup-consent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const acknowledgments = [true, true, true];
const record = () => createAcceptanceRecord('test-build', new Date('2026-01-02T03:04:05.000Z'));

describe('startup risk acknowledgment: neutral rules', () => {
  it('hashes all exact displayed wording, including the actions', () => {
    assert.equal(NOTICE_HASH, createHash('sha256').update(JSON.stringify(NOTICE), 'utf8').digest('hex'));
    assert.equal(NOTICE_VERSION, 1);
    assert.equal(NOTICE.title, 'Before you use Peek');
    assert.equal(NOTICE.acknowledgments.length, 3);
  });
  it('requires exactly three explicit boolean acknowledgments', () => {
    for (let bits = 0; bits < 8; bits++) {
      assert.equal(allAcknowledged([!!(bits & 1), !!(bits & 2), !!(bits & 4)]), bits === 7);
    }
    for (const invalid of [null, true, [], [true, true], [true, true, true, true], [1, 1, 1], ['true', true, true], {}]) {
      assert.equal(allAcknowledged(invalid), false);
    }
  });
  it('accepts current records regardless of the current build', () => {
    assert.equal(isValidAcceptanceRecord(record()), true);
    assert.equal(isValidAcceptanceRecord(createAcceptanceRecord()), true);
  });
  it('rejects absent, malformed, unsupported and outdated records', () => {
    for (const invalid of [null, undefined, [], {}, 'accepted',
      { ...record(), noticeVersion: 0 }, { ...record(), noticeVersion: 2 },
      { ...record(), noticeHash: 'old-text' }, { ...record(), schemaVersion: 2 },
      { ...record(), acceptedAt: 'yesterday' }, { ...record(), acceptedAt: '2026-02-30T00:00:00.000Z' },
      { ...record(), buildIdentity: {} }, { ...record(), acceptedAt: null }]) {
      assert.equal(isValidAcceptanceRecord(invalid), false, JSON.stringify(invalid));
    }
  });
});

describe('startup risk acknowledgment: local atomic persistence', () => {
  it('shares one location across profiles without selecting or creating a profile', () => {
    assert.equal(consentRecordPath('/isolated/root'), path.join('/isolated/root', 'startup-risk-acknowledgment.json'));
  });
  it('treats missing, truncated, corrupt and stale files as unaccepted', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'peek-consent-'));
    try {
      assert.equal(await readAcceptanceRecord(root), null);
      for (const content of ['{', '', 'null', JSON.stringify({ ...record(), noticeVersion: 0 })]) {
        await writeFile(consentRecordPath(root), content);
        assert.equal(await readAcceptanceRecord(root), null);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('atomically replaces an old record and leaves no temporary files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'peek-consent-'));
    try {
      await writeFile(consentRecordPath(root), 'truncated');
      await persistAcceptanceRecord(root, record());
      assert.deepEqual(await readAcceptanceRecord(root), record());
      assert.deepEqual(JSON.parse(await readFile(consentRecordPath(root), 'utf8')), record());
      assert.deepEqual(await readdir(root), ['startup-risk-acknowledgment.json']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('supports concurrent writers without truncation or temporary leftovers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'peek-consent-'));
    try {
      await Promise.all(Array.from({ length: 8 }, (_, i) => persistAcceptanceRecord(root, createAcceptanceRecord(`build-${i}`))));
      assert.ok(await readAcceptanceRecord(root));
      assert.deepEqual(await readdir(root), ['startup-risk-acknowledgment.json']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('propagates persistence failure and removes its temporary file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'peek-consent-'));
    try {
      // A directory at the destination makes rename fail even when run as root.
      await mkdir(consentRecordPath(root));
      await assert.rejects(persistAcceptanceRecord(root, record()));
      assert.deepEqual(await readdir(root), ['startup-risk-acknowledgment.json']);
      assert.equal(await readAcceptanceRecord(root), null);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('refuses to persist invalid records', async () => {
    await assert.rejects(persistAcceptanceRecord('/unused', { ...record(), noticeVersion: 0 }));
  });
});

describe('startup risk acknowledgment: bootstrap orchestration', () => {
  function setup(overrides: Partial<ConsentDependencies> = {}) {
    const effects: string[] = [];
    const dependencies: ConsentDependencies = {
      readRecord: async () => null,
      present: async () => ({ action: 'accept', acknowledgments }),
      persist: async () => { effects.push('persist'); },
      loadRuntime: async () => { effects.push('runtime'); },
      ...overrides,
    };
    return { effects, start: createStartupConsentGate(dependencies) };
  }
  it('never imports the runtime while presentation is pending', async () => {
    let decline!: (value: { action: 'decline' }) => void;
    const { start, effects } = setup({ present: () => new Promise(resolve => { decline = resolve; }) });
    const result = start();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(effects, []);
    decline({ action: 'decline' });
    assert.equal((await result).status, 'declined');
    assert.deepEqual(effects, []);
  });
  for (const action of ['decline', 'close'] as const) {
    it(`never persists or imports after ${action}`, async () => {
      const { start, effects } = setup({ present: async () => ({ action }) });
      assert.equal((await start()).status, 'declined');
      assert.deepEqual(effects, []);
    });
  }
  it('fails closed on a presentation error', async () => {
    const { start, effects } = setup({ present: async () => { throw new Error('render failed'); } });
    assert.equal((await start()).status, 'failed');
    assert.deepEqual(effects, []);
  });
  it('fails closed on an invalid acceptance message', async () => {
    const { start, effects } = setup({ present: async () => ({ action: 'accept', acknowledgments: [true, false, true] }) });
    assert.equal((await start()).status, 'failed');
    assert.deepEqual(effects, []);
  });
  it('persists before import and starts exactly once, including concurrent calls', async () => {
    const { start, effects } = setup();
    const first = start();
    assert.equal(start(), first);
    assert.equal((await first).status, 'accepted');
    await start();
    assert.deepEqual(effects, ['persist', 'runtime']);
  });
  it('skips presentation and persistence only for a valid matching record', async () => {
    const { start, effects } = setup({ readRecord: async () => record(), present: async () => { throw new Error('unexpected notice'); } });
    assert.equal((await start()).status, 'accepted');
    assert.deepEqual(effects, ['runtime']);
  });
  it('presents again for an invalid record or a read failure', async () => {
    for (const readRecord of [async () => ({ ...record(), noticeVersion: 0 }), async () => { throw new Error('read failed'); }]) {
      const { start, effects } = setup({ readRecord });
      assert.equal((await start()).status, 'accepted');
      assert.deepEqual(effects, ['persist', 'runtime']);
    }
  });
  it('explains a write failure and allows Quit without importing', async () => {
    let presentations = 0;
    const failure = new Error('disk full');
    const { start, effects } = setup({
      persist: async () => { throw failure; },
      present: async context => {
        if (++presentations === 1) return { action: 'accept', acknowledgments };
        assert.equal(context.persistenceError, failure);
        return { action: 'decline' };
      },
    });
    assert.equal((await start()).status, 'declined');
    assert.equal(presentations, 2);
    assert.deepEqual(effects, []);
  });
  it('does not import while persistence is pending', async () => {
    let finish!: () => void;
    const { start, effects } = setup({ persist: () => new Promise<void>(resolve => { finish = resolve; }) });
    const result = start();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(effects, []);
    finish();
    assert.equal((await result).status, 'accepted');
    assert.deepEqual(effects, ['runtime']);
  });
  it('imports only after persistence retry succeeds', async () => {
    let attempts = 0;
    const { start, effects } = setup({ persist: async () => {
      effects.push('persist');
      assert.ok(!effects.includes('runtime'));
      if (++attempts === 1) throw new Error('retry');
    } });
    assert.equal((await start()).status, 'accepted');
    assert.deepEqual(effects, ['persist', 'persist', 'runtime']);
  });
  it('fails closed and never retries the runtime loader after a loader error', async () => {
    const { start, effects } = setup({ loadRuntime: async () => { effects.push('runtime'); throw new Error('startup failed'); } });
    assert.equal((await start()).status, 'failed');
    assert.equal((await start()).status, 'failed');
    assert.deepEqual(effects, ['persist', 'runtime']);
  });
});

describe('startup risk acknowledgment: pending work and environment', () => {
  it('reads records synchronously with the same validity rules', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'peek-consent-sync-'));
    try {
      assert.equal(readAcceptanceRecordSync(root), null);
      await persistAcceptanceRecord(root, record());
      assert.deepEqual(readAcceptanceRecordSync(root), record());
      await writeFile(consentRecordPath(root), '{"schemaVersion":1');
      assert.equal(readAcceptanceRecordSync(root), null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('keeps only bounded http(s) URLs', () => {
    assert.equal(validatePendingUrl('https://example.com/a'), 'https://example.com/a');
    assert.equal(validatePendingUrl('http://example.com'), 'http://example.com/');
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'peek://x', '/tmp/a.html', '', null, 5, 'https://' + 'a'.repeat(9000)]) {
      assert.equal(validatePendingUrl(bad), null);
    }
  });
  it('releases the first valid pending URL and clears the rest', () => {
    const pending = createPendingWork();
    pending.capture('/tmp/file.html');
    pending.capture('https://example.com/');
    pending.capture('https://other.example/');
    assert.equal(pending.release(), 'https://example.com/');
    assert.equal(pending.size, 0);
    assert.equal(pending.release(), null);
  });
  it('discards pending work and caps how much is held', () => {
    const pending = createPendingWork(2);
    for (let i = 0; i < 10; i++) pending.capture(`https://example.com/${i}`);
    assert.equal(pending.size, 2);
    pending.discard();
    assert.equal(pending.size, 0);
    assert.equal(pending.release(), null);
  });
  it('requires a display session on Linux only', () => {
    assert.equal(interactiveDisplayAvailable('linux', {}), false);
    assert.equal(interactiveDisplayAvailable('linux', { DISPLAY: ':0' }), true);
    assert.equal(interactiveDisplayAvailable('linux', { WAYLAND_DISPLAY: 'wayland-0' }), true);
    assert.equal(interactiveDisplayAvailable('darwin', {}), true);
  });
});

describe('startup risk acknowledgment: bootstrap source guard', () => {
  const mainDir = path.resolve(__dirname, '../../main');
  const read = (name: string) => readFileSync(path.join(mainDir, name), 'utf8');
  const staticImports = (source: string) =>
    [...source.matchAll(/^\s*import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)].map(match => match[1]);

  // Everything the bootstrap may import before acceptance is recorded.
  const allowed: Record<string, string[]> = {
    'entry.ts': ['./headless-policy.js', 'electron', './build-info.js', './startup-consent.js'],
    'startup-consent.ts': ['node:crypto', 'node:fs', 'node:fs/promises', 'node:path'],
    'startup-consent-electron.ts': ['electron', 'node:path', 'node:url', './startup-consent.js'],
  };

  for (const [file, imports] of Object.entries(allowed)) {
    it(`${file} statically imports only the pre-acceptance allowlist`, () => {
      assert.deepEqual(staticImports(read(file)).sort(), [...imports].sort());
    });
  }
  it('entry.ts keeps the headless policy first and imports the runtime only dynamically', () => {
    const source = read('entry.ts');
    assert.equal(staticImports(source)[0], './headless-policy.js');
    const runtimeImports = source.match(/import\(\s*['"]\.\/runtime-entry\.js['"]\s*\)/g) ?? [];
    assert.equal(runtimeImports.length, 1);
    assert.ok(source.indexOf("import('./runtime-entry.js')") > source.indexOf('loadRuntime'));
    assert.doesNotMatch(source, /from\s+['"]\.\/runtime-entry/);
  });
  it('the runtime entry no longer carries the side-effect policy import', () => {
    assert.doesNotMatch(read('runtime-entry.ts'), /^import '\.\/headless-policy\.js';/m);
  });
  it('contains no bypass of the acknowledgment', () => {
    for (const file of ['entry.ts', 'startup-consent.ts', 'startup-consent-electron.ts']) {
      const source = read(file);
      assert.doesNotMatch(source, /--accept|ACCEPT_|SKIP_CONSENT|NO_CONSENT|setTimeout/i, file);
    }
  });
  it('the notice window is sandboxed and isolated', () => {
    const source = read('startup-consent-electron.ts');
    assert.match(source, /sandbox:\s*true/);
    assert.match(source, /contextIsolation:\s*true/);
    assert.match(source, /nodeIntegration:\s*false/);
  });
});
