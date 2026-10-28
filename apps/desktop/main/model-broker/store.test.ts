import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ModelStore, ModelStoreError, type ModelReservation } from './store.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = 100 * DAY;
const owner = JSON.stringify({ profileId: 'p', installId: 'i', installRevision: '1', grantRevision: '1', sender: 7 });
function record(id: string, extra: Partial<ModelReservation> = {}): ModelReservation {
  return { callId: id, owner, clientRequestId: `key-${id}`, requestHash: 'sha256-approved',
    inputBytes: 1, outputBytes: 1, maxOutputTokens: 128, maxDurationMs: 30_000,
    accountRevision: 'account-1', ...extra };
}
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'peek-model-store-'));
  let time = START;
  const stores: ModelStore[] = [];
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, setTime: (value: number) => { time = value; },
    open: () => { const store = new ModelStore(dir, () => time); stores.push(store); return store; } };
}
function code(expected: string) {
  return (error: unknown) => error instanceof ModelStoreError && error.code === expected
    && error.message === expected && !('cause' in error);
}
function finish(store: ModelStore, id: string) {
  store.dispatch(id);
  store.terminal(id, { localState: 'completed', remoteState: 'finished', usage: null, errorCode: null });
}
function raw(dir: string) { return new DatabaseSync(join(dir, 'model-broker.sqlite')); }
function child(dir: string, body: string) {
  return spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { ModelStore } from ${JSON.stringify(new URL('./store.js', import.meta.url).href)};
     const store = new ModelStore(${JSON.stringify(dir)}, () => ${START}); ${body}`],
  { encoding: 'utf8' });
}

test('durable metadata, owner-scoped dedupe, conflicts and one active call', t => {
  const f = fixture(t);
  let store = f.open();
  const request = record('one');
  assert.deepEqual(store.prepare(request), { callId: 'one', fresh: true });
  assert.deepEqual(store.prepare({ ...request, callId: 'ignored' }), { callId: 'one', fresh: false });
  assert.throws(() => store.prepare({ ...request, requestHash: 'changed' }), code('DEDUPE_CONFLICT'));
  assert.equal(store.prepare({ ...request, callId: 'different-proposed-id' }).callId, 'one');
  assert.throws(() => store.prepare(record('two')), code('CALL_ACTIVE'));
  finish(store, 'one');
  assert.throws(() => store.dispatch('one'), code('INVALID_TRANSITION'));
  store.terminal('one', { localState: 'aborted', remoteState: 'unknown', usage: null, errorCode: 'CANCELLED' });
  assert.equal(store.status('one')?.localState, 'completed');
  assert.equal(store.status('absent'), undefined);
  const snapshot = store.status('one')!;
  snapshot.owner = 'mutated';
  assert.equal(store.status('one')?.owner, owner);
  store.close(); store = f.open();
  assert.deepEqual(store.prepare(request), { callId: 'one', fresh: false });
  assert.equal(store.status('one')?.remoteState, 'finished');
  assert.equal(store.prepare(record('two', { owner: `${owner}-other`, clientRequestId: request.clientRequestId })).fresh, true);
});

test('exclusive lifetime sidecar denies same process and second process; close releases it', t => {
  const f = fixture(t);
  const store = f.open();
  assert.throws(() => new ModelStore(f.dir), code('STORE_OWNED'));
  const denied = child(f.dir, 'store.close();');
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /STORE_OWNED/);
  store.close();
  const accepted = child(f.dir, 'store.close();');
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.ok(readdirSync(f.dir).includes('model-broker-owner.sqlite'));
  assert.throws(() => store.prepare(record('closed')), code('STORE_UNAVAILABLE'));
});

for (const phase of ['prepared', 'dispatching', 'terminal'] as const) {
  test(`process death at ${phase} recovers without replay`, t => {
    const f = fixture(t);
    const request = record('crash');
    const result = child(f.dir, `store.prepare(${JSON.stringify(request)});
      ${phase !== 'prepared' ? "store.dispatch('crash');" : ''}
      ${phase === 'terminal' ? "store.terminal('crash', {localState:'completed',remoteState:'finished',usage:{inputTokens:2,outputTokens:3},errorCode:null});" : ''}
      process.exit(0);`);
    assert.equal(result.status, 0, result.stderr);
    const store = f.open();
    const status = store.status('crash')!;
    assert.equal(status.state, 'terminal');
    assert.equal(status.localState, phase === 'terminal' ? 'completed' : 'aborted');
    assert.equal(status.remoteState, phase === 'prepared' ? 'not-sent' : phase === 'terminal' ? 'finished' : 'unknown');
    assert.deepEqual(store.prepare(request), { callId: 'crash', fresh: false });
    if (phase === 'dispatching') {
      assert.throws(() => store.prepare(record('new')), code('UNKNOWN_REMOTE'));
    } else {
      assert.equal(store.prepare(record('new')).fresh, true);
    }
  });
}

test('unknown latch survives rollover, pruning and restart; only explicit acknowledgment clears it', t => {
  const f = fixture(t);
  let store = f.open();
  const request = record('unknown');
  store.prepare(request); store.dispatch('unknown');
  store.terminal('unknown', { localState: 'aborted', remoteState: 'unknown', usage: null, errorCode: 'TIMEOUT' });
  assert.equal(store.prepare(request).fresh, false);
  store.close();
  f.setTime(START + 31 * DAY);
  store = f.open();
  assert.throws(() => store.prepare(record('new')), code('UNKNOWN_REMOTE'));
  store.close(); store = f.open();
  assert.throws(() => store.prepare(record('new')), code('UNKNOWN_REMOTE'));
  store.acknowledgeUnknown();
  assert.equal(store.prepare(record('new')).fresh, true);
  assert.throws(() => store.acknowledgeUnknown(), code('CALL_ACTIVE'));
  assert.equal(store.status('unknown'), undefined);
});

test('full hourly reservations survive abort, dedupe, restart and clock rollback', t => {
  const f = fixture(t);
  let store = f.open();
  for (let i = 0; i < 10; i++) {
    const id = `call-${i}`;
    store.prepare(record(id));
    store.terminal(id, { localState: 'failed', remoteState: 'not-sent', usage: null, errorCode: 'INTERNAL' });
    assert.equal(store.prepare(record(id)).fresh, false);
  }
  assert.throws(() => store.prepare(record('excess')), code('QUOTA_EXCEEDED'));
  store.close(); f.setTime(START - 10 * DAY); store = f.open();
  assert.throws(() => store.prepare(record('rollback')), code('QUOTA_EXCEEDED'));
  f.setTime(START + HOUR);
  assert.equal(store.prepare(record('next-hour')).fresh, true);
});

test('daily 100-call cap is transactional across windows of hourly quota', t => {
  const f = fixture(t); const store = f.open();
  for (let i = 0; i < 100; i++) {
    f.setTime(START + Math.floor(i / 10) * HOUR);
    const id = `daily-${i}`; store.prepare(record(id)); finish(store, id);
  }
  f.setTime(START + 11 * HOUR);
  assert.throws(() => store.prepare(record('excess')), code('QUOTA_EXCEEDED'));
  const db = raw(f.dir);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM model_quota WHERE period='hour' AND bucket=?")
      .get(Math.floor((START + 11 * HOUR) / HOUR))?.n, 0);
  } finally { db.close(); }
  f.setTime(START + DAY);
  assert.equal(store.prepare(record('tomorrow')).fresh, true);
});

for (const resource of ['input', 'output'] as const) {
  test(`daily ${resource} byte quota reserves requested maximum, never actual usage`, t => {
    const f = fixture(t); const store = f.open();
    const extra = resource === 'input' ? { inputBytes: 16 * 1024 } : { outputBytes: 32 * 1024 };
    for (let i = 0; i < 64; i++) {
      f.setTime(START + Math.floor(i / 10) * HOUR);
      const id = `bytes-${i}`; store.prepare(record(id, extra)); finish(store, id);
    }
    f.setTime(START + 8 * HOUR);
    assert.throws(() => store.prepare(record('excess', extra)), code('QUOTA_EXCEEDED'));
  });
}

test('3000-record cap refuses rather than evicting identity; 30-day retention permits expiry', t => {
  const f = fixture(t); const store = f.open();
  store.prepare(record('seed')); finish(store, 'seed');
  const metadata = store.status('seed')!;
  const db = raw(f.dir);
  try {
    const insert = db.prepare('INSERT INTO model_calls VALUES(?,?,?,?,?,?,?,?)');
    db.exec('BEGIN');
    for (let i = 1; i < 3000; i++) {
      const id = `seed-${i}`;
      insert.run(id, owner, id, 'hash', START, START, 'terminal',
        JSON.stringify({ ...metadata, callId: id, clientRequestId: id }));
    }
    db.exec('COMMIT');
  } finally { db.close(); }
  assert.equal(store.prepare(record('seed')).fresh, false);
  assert.throws(() => store.prepare(record('full')), code('STORE_FULL'));
  f.setTime(START + 30 * DAY - 1);
  assert.throws(() => store.prepare(record('full')), code('STORE_FULL'));
  f.setTime(START + 30 * DAY);
  assert.equal(store.prepare(record('seed')).fresh, true);
});

for (const phase of ['prepare', 'dispatch', 'terminal'] as const) {
  test(`SQLite ${phase} fault rolls back atomically, redacts and poisons instance`, t => {
    const f = fixture(t); let store = f.open();
    if (phase !== 'prepare') store.prepare(record('fault'));
    if (phase === 'terminal') store.dispatch('fault');
    const db = raw(f.dir);
    try {
      db.exec(`CREATE TRIGGER injected BEFORE ${phase === 'prepare' ? 'INSERT' : 'UPDATE'} ON model_calls
        BEGIN SELECT RAISE(ABORT, 'private prompt key /secret/path'); END;`);
      assert.throws(() => {
        if (phase === 'prepare') store.prepare(record('fault'));
        else if (phase === 'dispatch') store.dispatch('fault');
        else store.terminal('fault', {localState:'completed',remoteState:'finished',usage:null,errorCode:null});
      }, code('STORE_UNAVAILABLE'));
      assert.throws(() => store.status('fault'), code('STORE_UNAVAILABLE'));
      if (phase === 'prepare') {
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM model_calls').get()?.n, 0);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM model_quota').get()?.n, 0);
      }
      db.exec('DROP TRIGGER injected');
    } finally { db.close(); }
    store.close(); store = f.open();
    if (phase === 'prepare') assert.equal(store.prepare(record('fault')).fresh, true);
    else {
      assert.equal(store.status('fault')?.remoteState, phase === 'dispatch' ? 'not-sent' : 'unknown');
      if (phase === 'terminal') assert.throws(() => store.prepare(record('next')), code('UNKNOWN_REMOTE'));
    }
  });
}

test('quota write fault rolls back both buckets and call intent', t => {
  const f = fixture(t); const store = f.open(); const db = raw(f.dir);
  try {
    db.exec(`CREATE TRIGGER injected BEFORE INSERT ON model_quota WHEN NEW.period='day'
      BEGIN SELECT RAISE(ABORT,'private quota error'); END;`);
    assert.throws(() => store.prepare(record('fault')), code('STORE_UNAVAILABLE'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM model_quota').get()?.n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM model_calls').get()?.n, 0);
    db.exec('DROP TRIGGER injected');
  } finally { db.close(); }
});

test('terminal and unknown latch are atomic, including latch write failure', t => {
  const f = fixture(t); let store = f.open();
  store.prepare(record('fault')); store.dispatch('fault');
  const db = raw(f.dir);
  try {
    db.exec(`CREATE TRIGGER injected BEFORE UPDATE ON model_meta WHEN NEW.unknown_latch=1
      BEGIN SELECT RAISE(ABORT,'private latch error'); END;`);
    assert.throws(() => store.terminal('fault', { localState: 'aborted', remoteState: 'unknown',
      usage: null, errorCode: 'CANCELLED' }), code('STORE_UNAVAILABLE'));
    assert.equal(db.prepare("SELECT state FROM model_calls WHERE call_id='fault'").get()?.state, 'dispatching');
    db.exec('DROP TRIGGER injected');
  } finally { db.close(); }
  store.close(); store = f.open();
  assert.equal(store.status('fault')?.remoteState, 'unknown');
  assert.throws(() => store.prepare(record('next')), code('UNKNOWN_REMOTE'));
});

test('persisted highwater prevents resetting daily quota by alternating dates', t => {
  const f = fixture(t); let store = f.open();
  f.setTime(START + DAY);
  for (let i = 0; i < 64; i++) {
    f.setTime(START + DAY + Math.floor(i / 10) * HOUR);
    const id = `forward-${i}`;
    store.prepare(record(id, { outputBytes: 32 * 1024 })); finish(store, id);
  }
  store.close(); f.setTime(START); store = f.open();
  assert.throws(() => store.prepare(record('back', { outputBytes: 32 * 1024 })), code('QUOTA_EXCEEDED'));
  f.setTime(START + 2 * DAY);
  store.prepare(record('next', { outputBytes: 32 * 1024 }));
  assert.equal(store.status('next')?.createdAt, START + 2 * DAY);
});

test('recovery failure refuses construction and releases ownership for repair', t => {
  const f = fixture(t); const store = f.open();
  store.prepare(record('recover')); store.dispatch('recover'); store.close();
  const db = raw(f.dir);
  try {
    db.exec("CREATE TRIGGER injected BEFORE UPDATE ON model_calls BEGIN SELECT RAISE(ABORT,'secret'); END;");
    assert.throws(() => f.open(), code('STORE_UNAVAILABLE'));
    db.exec('DROP TRIGGER injected');
  } finally { db.close(); }
  assert.equal(f.open().status('recover')?.remoteState, 'unknown');
});

test('strict bounds, metadata-only usage and fixed errors prevent content persistence', t => {
  const f = fixture(t); const store = f.open();
  for (const extra of [{ inputBytes: 16 * 1024 + 1 }, { outputBytes: -1 },
    { maxOutputTokens: 513 }, { maxDurationMs: Infinity }, { inputBytes: NaN }]) {
    assert.throws(() => store.prepare(record('invalid', extra)), code('INVALID_RECORD'));
  }
  const request = { ...record('privacy'), prompt: 'PRIVATE_PROMPT', credential: 'PRIVATE_KEY' };
  store.prepare(request); store.dispatch('privacy');
  assert.throws(() => store.terminal('privacy', { localState: 'completed', remoteState: 'finished',
    usage: { message: 'PRIVATE_PROVIDER_MESSAGE' }, errorCode: null }), code('INVALID_RECORD'));
  store.terminal('privacy', { localState: 'completed', remoteState: 'finished',
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }, errorCode: 'PRIVATE_ERROR' });
  assert.equal(store.status('privacy')?.errorCode, 'INTERNAL');
  store.close();
  for (const filename of readdirSync(f.dir)) {
    const data = readFileSync(join(f.dir, filename)).toString('utf8');
    for (const secret of ['PRIVATE_PROMPT', 'PRIVATE_KEY', 'PRIVATE_PROVIDER_MESSAGE', 'PRIVATE_ERROR']) {
      assert.ok(!data.includes(secret), `${secret} persisted in ${filename}`);
    }
  }
});
