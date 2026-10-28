import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { BrokerPorts, ModelAdapter, ModelAccount, ModelEvent, ModelOwner, ModelRequest, ModelState } from './contract.js';
import { ownerKey } from './contract.js';
import { ModelBroker } from './broker.js';
import { ModelStore } from './store.js';

const OWNER: ModelOwner = { profileId: 'profile', installId: 'install', installRevision: 'i1', grantRevision: 'g1', senderId: 7 };
const PROMPT = 'SELECTED-PROMPT-private-fixture-9f3e';
const KEY = 'FAKE-SECRET-private-fixture-c82a';
const OUTPUT = '<script>globalThis.untrustedExecuted = true</script>OUTPUT-private-3fa2';
type Run = { config: Parameters<ModelAdapter['run']>[0]; signal: AbortSignal; delta: (text: string) => void;
  resolve: (result: Awaited<ReturnType<ModelAdapter['run']>>) => void; reject: (error: Error) => void };
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'peek-model-broker-test-'));
  let time = 100 * 86400000;
  let cleared = 0;
  const state: ModelState = { owner: { ...OWNER }, state: 'ready', startupAcknowledged: true,
    profileSelected: true, profileUnlocked: true, registryReady: true,
    grant: { allow: [{ model: 'local:text', task: 'text.generate' }], maxInputBytes: 16384,
      maxOutputBytes: 32768, maxOutputTokens: 512, maxDurationMs: 30000, maxConcurrent: 1 } };
  const account: ModelAccount = { accountId: 'account', revision: 'a1', url: 'https://fixture.invalid/v1/chat/completions',
    adapter: 'openai-text-v1', models: { 'local:text': 'wire-text' }, allocation: 'unpriced-owned',
    contactApproved: true, acceptsUnverifiedRemoteBounds: true };
  const runs: Run[] = [];
  const ports: BrokerPorts = { now: () => time, probe: () => state, account: () => account, offline: true,
    vault: { available: () => true, get: () => KEY, set() {}, clear() { cleared++; } },
    adapter: { run(config, signal, delta) { return new Promise((resolve, reject) => { runs.push({ config, signal, delta, resolve, reject }); }); } } };
  const brokers: ModelBroker[] = [];
  let store: ModelStore;
  let broker: ModelBroker;
  function open() { store = new ModelStore(dir, ports.now); broker = new ModelBroker(ports, store); brokers.push(broker); }
  open();
  t.after(() => { for (const b of brokers) b.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, ports, state, account, runs, get store() { return store; }, get broker() { return broker; },
    get cleared() { return cleared; }, advance(ms: number) { time += ms; },
    restart() { broker.close(); open(); },
    // Simulate lost volatile broker state while leaving durable dispatching for recovery.
    crash() { store.close(); broker.close(); open(); },
    request(id = 'request-1', text = PROMPT): ModelRequest {
      return { model: 'local:text', task: 'text.generate', input: { text }, maxOutputTokens: 128,
        exportApprovalId: broker.approve(OWNER, text), clientRequestId: id };
    } };
}
const settled = async () => { await Promise.resolve(); await Promise.resolve(); };
const completed = (run: Run) => run.resolve({ outcome: 'completed', usage: null });
const terminal = (events: ModelEvent[]) => {
  const terminals = events.filter(e => e.kind === 'terminal');
  assert.equal(terminals.length, 1);
  return terminals[0] as Extract<ModelEvent, { kind: 'terminal' }>;
};

test('sole dispatch receives only approved snapshot/config after durable dispatch marker', async t => {
  const f = fixture(t);
  const request = f.request();
  const originalRun = f.ports.adapter.run;
  f.ports.adapter.run = (config, signal, delta) => {
    const row = f.store.find(ownerKey(OWNER), request.clientRequestId)!;
    assert.equal(row.localState, 'dispatching');
    return originalRun(config, signal, delta);
  };
  const { callId } = await f.broker.start(OWNER, request);
  request.input.text = 'mutated caller';
  assert.equal(f.runs.length, 1);
  assert.deepEqual(f.runs[0].config, { url: f.account.url, wireModel: 'wire-text', key: KEY, text: PROMPT, maxOutputTokens: 128 });
  assert.equal(f.broker.status(OWNER, { callId }).localState, 'dispatching');
  f.runs[0].delta(OUTPUT);
  const usage = { promptTokens: 5, completionTokens: 7, totalTokens: 12 };
  f.runs[0].resolve({ outcome: 'completed', usage });
  await settled();
  const batch = await f.broker.poll(OWNER, { callId, afterSeq: 0 });
  assert.deepEqual(batch.events.map(e => e.seq), [1, 2]);
  assert.deepEqual(batch.events[0], { callId, seq: 1, kind: 'delta', text: OUTPUT });
  assert.deepEqual(terminal(batch.events), { callId, seq: 2, kind: 'terminal', outcome: 'completed', remoteState: 'finished', usage, errorCode: null });
  assert.equal(f.store.status(callId)?.localState, 'completed');
  assert.equal((globalThis as Record<string, unknown>).untrustedExecuted, undefined);
  assert.equal(f.broker.cancel(OWNER, { callId }).localState, 'completed');
});

const admissionCases: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
  ['missing probe', f => { f.ports.probe = () => null; }], ['loading', f => { f.state.state = 'loading'; }],
  ['locked', f => { f.state.profileUnlocked = false; }], ['unselected', f => { f.state.profileSelected = false; }],
  ['pre-startup', f => { f.state.startupAcknowledged = false; }], ['registry not ready', f => { f.state.registryReady = false; }],
  ['no models grant', f => { f.state.grant = undefined; }], ['missing account', f => { f.ports.account = () => null; }],
  ['no contact', f => { f.account.contactApproved = false; }], ['metered', f => { Object.assign(f.account, { allocation: 'metered' }); }],
  ['unknown allocation', f => { Object.assign(f.account, { allocation: 'unknown' }); }],
  ['no attestation', f => { f.account.acceptsUnverifiedRemoteBounds = false; }],
  ['no secure vault', f => { f.ports.vault.available = () => false; }], ['no key', f => { f.ports.vault.get = () => null; }],
  ['grant model exclusion', f => { f.state.grant!.allow[0].model = 'other'; }],
  ['account model exclusion', f => { f.account.models = {}; }],
  ['input grant bound', f => { f.state.grant!.maxInputBytes = 1; }],
  ['token grant bound', f => { f.state.grant!.maxOutputTokens = 127; }],
  ...['profileId', 'installId', 'installRevision', 'grantRevision', 'senderId'].map(key =>
    [`stale ${key}`, (f: ReturnType<typeof fixture>) => { Object.assign(f.state.owner, { [key]: key === 'senderId' ? 8 : 'stale' }); }] as [string, (f: ReturnType<typeof fixture>) => void]),
];
for (const [name, change] of admissionCases) for (const builtin of [false, true]) {
  test(`zero sends for ${name}; builtin=${builtin}`, async t => {
    const f = fixture(t); const r = f.request(); change(f);
    await assert.rejects(f.broker.start(Object.assign({ ...OWNER }, { trustedBuiltin: builtin }), r), { message: 'DENIED' });
    assert.equal(f.runs.length, 0);
    assert.equal(f.store.find(ownerKey(OWNER), r.clientRequestId), undefined);
  });
}

test('broker independently validates all four method schemas before dispatch', async t => {
  const f = fixture(t); const r = f.request();
  for (const bad of [null, { ...r, url: 'https://evil.invalid' }, { ...r, input: { text: '\ud800' } }, { ...r, maxOutputTokens: Infinity }]) {
    await assert.rejects(f.broker.start(OWNER, bad), { message: 'INVALID_REQUEST' });
  }
  await assert.rejects(f.broker.poll(OWNER, { callId: 'id', afterSeq: -1 }), { message: 'INVALID_REQUEST' });
  assert.throws(() => f.broker.status(OWNER, { callId: 'id', extra: true }), { message: 'INVALID_REQUEST' });
  assert.throws(() => f.broker.cancel(OWNER, { callId: 'id', afterSeq: 0 }), { message: 'INVALID_REQUEST' });
  assert.equal(f.runs.length, 0);
});

for (const change of ['missing', 'expired', 'text', 'account revision', 'owner', 'consumed'] as const) {
  test(`approval rejects ${change} without another send`, async t => {
    const f = fixture(t); const r = f.request();
    switch (change) {
      case 'missing': r.exportApprovalId = 'unknown'; break;
      case 'expired': f.advance(60000); break;
      case 'text': r.input.text += '!'; break;
      case 'account revision': f.account.revision = 'a2'; break;
      case 'owner': {
        f.state.owner = { ...OWNER, senderId: 8 };
        r.exportApprovalId = f.broker.approve(f.state.owner, PROMPT);
        f.state.owner = { ...OWNER }; break;
      }
      case 'consumed': {
        await f.broker.start(OWNER, r); completed(f.runs[0]); await settled(); r.clientRequestId = 'second'; break;
      }
    }
    await assert.rejects(f.broker.start(OWNER, r), { message: 'DENIED' });
    assert.equal(f.runs.length, change === 'consumed' ? 1 : 0);
  });
}

test('approval validates UTF-8/bytes, expires, and caps outstanding snapshots', t => {
  const f = fixture(t);
  for (const text of ['', '\ud800', 'x'.repeat(16385)]) assert.throws(() => f.broker.approve(OWNER, text), { message: 'INVALID_REQUEST' });
  for (let i = 0; i < 100; i++) f.broker.approve(OWNER, PROMPT);
  assert.throws(() => f.broker.approve(OWNER, PROMPT), { message: 'QUOTA_EXCEEDED' });
  f.advance(60000);
  assert.equal(typeof f.broker.approve(OWNER, PROMPT), 'string');
});

test('same owner/key/hash dedupes active and terminal calls; conflicts and queue refuse', async t => {
  const f = fixture(t); const r = f.request();
  const first = await f.broker.start(OWNER, r);
  assert.deepEqual(await f.broker.start(OWNER, structuredClone(r)), first);
  await assert.rejects(f.broker.start(OWNER, { ...r, maxOutputTokens: 129 }), { message: 'DEDUPE_CONFLICT' });
  const second = f.request('second');
  await assert.rejects(f.broker.start(OWNER, second), { message: 'CALL_ACTIVE' });
  completed(f.runs[0]); await settled();
  f.advance(60001);
  assert.deepEqual(await f.broker.start(OWNER, r), first); // consumed/expired approval does not resend
  assert.equal(f.runs.length, 1);
  const fresh = f.request('third');
  assert.notEqual((await f.broker.start(OWNER, fresh)).callId, first.callId);
  assert.equal(f.runs.length, 2);
});

for (const mutation of ['probe', 'grant', 'revision', 'destination', 'vault'] as const) {
  test(`immediate pre-send recheck catches ${mutation}`, async t => {
    const f = fixture(t); const r = f.request();
    const prepare = f.store.prepare.bind(f.store);
    f.store.prepare = record => {
      const result = prepare(record);
      if (mutation === 'probe') f.ports.probe = () => null;
      if (mutation === 'grant') f.state.grant = { ...f.state.grant!, maxOutputTokens: 100 };
      if (mutation === 'revision') f.account.revision = 'a2';
      if (mutation === 'destination') f.account.url = 'https://other.invalid/chat';
      if (mutation === 'vault') f.ports.vault.available = () => false;
      return result;
    };
    const { callId } = await f.broker.start(OWNER, r);
    assert.equal(f.runs.length, 0);
    assert.equal(f.store.status(callId)?.localState, 'aborted');
    assert.equal(f.store.status(callId)?.remoteState, 'not-sent');
    assert.equal(f.store.status(callId)?.errorCode, 'REVOKED');
  });
}

for (const field of ['profileId', 'installId', 'installRevision', 'grantRevision', 'senderId'] as const) {
  test(`stolen call ID is denied across ${field} for poll/status/cancel`, async t => {
    const f = fixture(t); const { callId } = await f.broker.start(OWNER, f.request());
    const thief = { ...OWNER, [field]: field === 'senderId' ? 8 : 'different' };
    f.state.owner = thief; // even an independently valid current caller cannot use another owner's ID
    assert.throws(() => f.broker.status(thief, { callId }), { message: 'CALL_NOT_FOUND' });
    assert.throws(() => f.broker.cancel(thief, { callId }), { message: 'CALL_NOT_FOUND' });
    await assert.rejects(f.broker.poll(thief, { callId, afterSeq: 0 }), { message: 'CALL_NOT_FOUND' });
    assert.equal(f.runs[0].signal.aborted, false);
    f.state.owner = { ...OWNER };
  });
}

test('all call methods recheck current state and unknown IDs never authorize work', async t => {
  const f = fixture(t); const { callId } = await f.broker.start(OWNER, f.request());
  for (const id of ['unknown', callId]) {
    f.state.profileUnlocked = false;
    assert.throws(() => f.broker.status(OWNER, { callId: id }), { message: 'DENIED' });
    assert.throws(() => f.broker.cancel(OWNER, { callId: id }), { message: 'DENIED' });
    await assert.rejects(f.broker.poll(OWNER, { callId: id, afterSeq: 0 }), { message: 'DENIED' });
  }
  f.state.profileUnlocked = true;
  assert.throws(() => f.broker.status(OWNER, { callId: 'unknown' }), { message: 'CALL_NOT_FOUND' });
  assert.equal(f.runs.length, 1);
});

test('pull/ack caps batches, redelivers until ack, and rejects invalid/stale/concurrent cursors', async t => {
  const f = fixture(t); const { callId } = await f.broker.start(OWNER, f.request());
  assert.deepEqual(await f.broker.poll(OWNER, { callId, afterSeq: 0 }), { events: [], lastSeq: 0 });
  for (let i = 0; i < 12; i++) f.runs[0].delta(`delta-${i}`);
  await assert.rejects(f.broker.poll(OWNER, { callId, afterSeq: 1 }), { message: 'INVALID_CURSOR' });
  const pending = f.broker.poll(OWNER, { callId, afterSeq: 0 });
  await assert.rejects(f.broker.poll(OWNER, { callId, afterSeq: 0 }), { message: 'POLL_PENDING' });
  const first = await pending;
  assert.equal(first.events.length, 8); assert.equal(first.lastSeq, 8);
  const redelivery = await f.broker.poll(OWNER, { callId, afterSeq: 0 });
  assert.deepEqual(redelivery, first);
  if (redelivery.events[0].kind === 'delta') redelivery.events[0].text = 'caller mutation';
  assert.deepEqual(await f.broker.poll(OWNER, { callId, afterSeq: 0 }), first);
  const rest = await f.broker.poll(OWNER, { callId, afterSeq: 8 });
  assert.deepEqual(rest.events.map(e => e.seq), [9, 10, 11, 12]);
  await assert.rejects(f.broker.poll(OWNER, { callId, afterSeq: 7 }), { message: 'CURSOR_EXPIRED' });
  completed(f.runs[0]); await settled();
  const end = await f.broker.poll(OWNER, { callId, afterSeq: 12 });
  assert.equal(terminal(end.events).seq, 13);
  assert.deepEqual(await f.broker.poll(OWNER, { callId, afterSeq: 12 }), end);
  assert.deepEqual(await f.broker.poll(OWNER, { callId, afterSeq: 13 }), { events: [], lastSeq: 13 });
});

test('32 KiB response bound includes envelope; UTF-8 output obeys bytes, not characters', async t => {
  const f = fixture(t); const { callId } = await f.broker.start(OWNER, f.request());
  for (let i = 0; i < 8; i++) f.runs[0].delta('é'.repeat(2048));
  completed(f.runs[0]); await settled();
  const first = await f.broker.poll(OWNER, { callId, afterSeq: 0 });
  assert.equal(first.events.length, 7);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 32768);
  const second = await f.broker.poll(OWNER, { callId, afterSeq: first.lastSeq });
  assert.equal(second.events.length, 2); assert.equal(terminal(second.events).outcome, 'completed');
});

for (const kind of ['event count', 'encoded bytes'] as const) {
  test(`ring overflow (${kind}) reserves one terminal and ignores late chunks`, async t => {
    const f = fixture(t); const { callId } = await f.broker.start(OWNER, f.request());
    const text = kind === 'event count' ? 'x' : '\u0000'.repeat(4096);
    for (let i = 0; i < 30; i++) f.runs[0].delta(text);
    completed(f.runs[0]); await settled();
    assert.equal(f.runs[0].signal.aborted, true);
    let afterSeq = 0; const events: ModelEvent[] = [];
    while (true) {
      const batch = await f.broker.poll(OWNER, { callId, afterSeq });
      if (!batch.events.length) break;
      events.push(...batch.events); afterSeq = batch.lastSeq;
    }
    assert.ok(events.length <= 16);
    assert.ok(events.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)), 0) <= 65536);
    assert.equal(terminal(events).errorCode, 'SLOW_CONSUMER');
    assert.equal(terminal(events).remoteState, 'unknown');
  });
}

for (const kind of ['delta', 'aggregate', 'UTF-8'] as const) {
  test(`output bound rejects ${kind}`, async t => {
    const f = fixture(t); if (kind === 'aggregate') f.state.grant!.maxOutputBytes = 4;
    const { callId } = await f.broker.start(OWNER, f.request());
    if (kind === 'aggregate') { f.runs[0].delta('1234'); f.runs[0].delta('5'); }
    else f.runs[0].delta(kind === 'delta' ? 'é'.repeat(2049) : '\ud800');
    assert.equal(f.broker.status(OWNER, { callId }).errorCode, 'OUTPUT_LIMIT');
    assert.equal(f.runs[0].signal.aborted, true);
  });
}

test('zero/stalled polling aborts at 5 seconds even when repeatedly redelivered; terminal expires but status remains', async t => {
  const f = fixture(t); const { callId } = await f.broker.start(OWNER, f.request());
  f.runs[0].delta('unacked');
  f.advance(4999); await delay(65);
  assert.equal(f.runs[0].signal.aborted, false);
  await f.broker.poll(OWNER, { callId, afterSeq: 0 });
  f.advance(1); await delay(65);
  assert.equal(f.broker.status(OWNER, { callId }).errorCode, 'SLOW_CONSUMER');
  const end = await f.broker.poll(OWNER, { callId, afterSeq: 0 });
  assert.equal(terminal(end.events).outcome, 'aborted');
  f.advance(5000); await delay(65);
  await assert.rejects(f.broker.poll(OWNER, { callId, afterSeq: 0 }), { message: 'CURSOR_EXPIRED' });
  assert.equal(f.broker.status(OWNER, { callId }).remoteState, 'unknown');
});

test('acknowledgment frees ring capacity; polling does not extend total deadline', async t => {
  const f = fixture(t); f.state.grant!.maxDurationMs = 100;
  const { callId } = await f.broker.start(OWNER, f.request());
  let seq = 0;
  for (let i = 0; i < 20; i++) {
    f.runs[0].delta('x');
    const batch = await f.broker.poll(OWNER, { callId, afterSeq: seq }); seq = batch.lastSeq;
  }
  assert.equal(f.runs[0].signal.aborted, false);
  f.advance(100); f.runs[0].delta('late-wake-data');
  assert.equal(f.broker.status(OWNER, { callId }).errorCode, 'TIMEOUT');
  const end = await f.broker.poll(OWNER, { callId, afterSeq: seq });
  assert.equal(end.events.some(e => e.kind === 'delta'), false);
});

test('silent adapter is deadline-aborted by timer without any polling', async t => {
  const f = fixture(t); const { callId } = await f.broker.start(OWNER, f.request());
  f.advance(30000); await delay(65);
  assert.equal(f.runs[0].signal.aborted, true);
  assert.equal(f.broker.status(OWNER, { callId }).errorCode, 'TIMEOUT');
});

for (const outcome of ['completed', 'truncated', 'refused'] as const) {
  test(`adapter ${outcome} persists exactly one terminal`, async t => {
    const f = fixture(t); const { callId } = await f.broker.start(OWNER, f.request());
    f.runs[0].resolve({ outcome, usage: null }); await settled();
    f.broker.cancel(OWNER, { callId }); f.runs[0].delta('late');
    const batch = await f.broker.poll(OWNER, { callId, afterSeq: 0 });
    assert.equal(batch.events.length, 1); assert.equal(terminal(batch.events).outcome, outcome);
    assert.equal(terminal(batch.events).usage, null);
  });
}

for (const code of ['AUTH', 'RATE_LIMIT', 'REQUEST_REJECTED', 'PROVIDER', 'TRANSPORT', 'PROTOCOL', 'TIMEOUT', 'ABORTED', 'LIMIT', 'RAW-provider-private-error']) {
  test(`adapter error ${code} is fixed, durable, and never retried`, async t => {
    const f = fixture(t); const { callId } = await f.broker.start(OWNER, f.request());
    f.runs[0].reject(new Error(code)); await settled();
    const status = f.broker.status(OWNER, { callId });
    assert.equal(status.localState, 'failed'); assert.equal(status.remoteState, 'unknown');
    assert.equal(status.errorCode, code === 'LIMIT' ? 'OUTPUT_LIMIT' : code.startsWith('RAW-') ? 'TRANSPORT' : code);
    assert.equal(f.runs.length, 1);
    assert.equal(terminal((await f.broker.poll(OWNER, { callId, afterSeq: 0 })).events).errorCode, status.errorCode);
  });
}

test('cancel is idempotent, wins resolve/reject races, and redelivers one terminal', async t => {
  const f = fixture(t); const { callId } = await f.broker.start(OWNER, f.request());
  const cancelled = f.broker.cancel(OWNER, { callId });
  assert.deepEqual(f.broker.cancel(OWNER, { callId }), cancelled);
  completed(f.runs[0]); f.runs[0].delta('late'); await settled();
  const batch = await f.broker.poll(OWNER, { callId, afterSeq: 0 });
  assert.equal(batch.events.length, 1); assert.equal(terminal(batch.events).errorCode, 'CANCELLED');
  assert.deepEqual(await f.broker.poll(OWNER, { callId, afterSeq: 0 }), batch);
});

test('poll reauthorizes after promise turn and does not deliver to a revoked owner', async t => {
  const f = fixture(t); const { callId } = await f.broker.start(OWNER, f.request()); f.runs[0].delta(OUTPUT);
  const pending = f.broker.poll(OWNER, { callId, afterSeq: 0 });
  f.state.grant = undefined;
  await assert.rejects(pending, { message: 'DENIED' });
  f.runs[0].delta('late');
  assert.equal(f.runs[0].signal.aborted, true);
  assert.equal(f.store.status(callId)?.errorCode, 'REVOKED');
});

for (const action of ['unload', 'crash', 'suspension', 'revoke', 'uninstall', 'detached sender', 'sleep', 'profile lock', 'profile switch'] as const) {
  test(`host lifecycle ${action} aborts and clears output/approvals without authorizing new work`, async t => {
    const f = fixture(t); const r = f.request(); const unused = f.request('unused');
    const { callId } = await f.broker.start(OWNER, r); f.runs[0].delta(OUTPUT);
    if (action === 'sleep') f.broker.sleep();
    else if (action === 'profile lock' || action === 'profile switch') f.broker.close();
    else f.broker.cancelOwner(OWNER);
    f.runs[0].delta('late'); completed(f.runs[0]); await settled();
    assert.equal(f.runs[0].signal.aborted, true);
    if (action === 'profile lock' || action === 'profile switch') {
      assert.equal(f.cleared, 1);
      assert.throws(() => f.broker.status(OWNER, { callId }), { message: 'STORE_UNAVAILABLE' });
      f.restart();
    }
    assert.equal(f.broker.status(OWNER, { callId }).localState, 'aborted');
    assert.deepEqual((await f.broker.poll(OWNER, { callId, afterSeq: 0 })).events, []);
    await assert.rejects(f.broker.start(OWNER, unused), { message: 'DENIED' });
    assert.equal(f.runs.length, 1);
  });
}

test('hide (visible to ready) continues bounded work; unrelated lifecycle owner cannot cancel', async t => {
  const f = fixture(t); f.state.state = 'visible';
  const { callId } = await f.broker.start(OWNER, f.request());
  f.state.state = 'ready'; f.broker.cancelOwner({ ...OWNER, senderId: 8 });
  f.runs[0].delta('hidden output'); completed(f.runs[0]); await settled();
  assert.equal(f.broker.status(OWNER, { callId }).localState, 'completed');
});

test('account revision changes revoke active work and approval invalidation clears output', async t => {
  const f = fixture(t); const { callId } = await f.broker.start(OWNER, f.request());
  f.account.revision = 'a2'; f.runs[0].delta('must not deliver');
  assert.equal(f.store.status(callId)?.errorCode, 'REVOKED');
  f.broker.invalidateApprovals();
  assert.deepEqual((await f.broker.poll(OWNER, { callId, afterSeq: 0 })).events, []);
});

test('unknown latch survives day rollover/restart; only explicit acknowledgment plus new approval/key allows new work', async t => {
  const f = fixture(t); const r = f.request(); const { callId } = await f.broker.start(OWNER, r);
  f.broker.cancel(OWNER, { callId });
  assert.equal(f.store.hasUnknown(), true);
  f.advance(2 * 86400000); f.restart();
  assert.equal(f.store.hasUnknown(), true);
  assert.deepEqual(await f.broker.start(OWNER, r), { callId });
  await assert.rejects(f.broker.start(OWNER, f.request('second')), { message: 'UNKNOWN_REMOTE' });
  f.store.acknowledgeUnknown();
  assert.equal(f.store.hasUnknown(), false);
  const next = await f.broker.start(OWNER, f.request('third'));
  assert.notEqual(next.callId, callId); assert.equal(f.runs.length, 2);
});

test('dispatching crash recovery is status-only unknown, never a replay or content archive', async t => {
  const f = fixture(t); const r = f.request(); const { callId } = await f.broker.start(OWNER, r);
  f.runs[0].delta(OUTPUT); f.crash();
  assert.equal(f.broker.status(OWNER, { callId }).localState, 'aborted');
  assert.equal(f.broker.status(OWNER, { callId }).remoteState, 'unknown');
  assert.equal(f.store.hasUnknown(), true);
  assert.deepEqual(await f.broker.start(OWNER, r), { callId });
  assert.deepEqual(await f.broker.poll(OWNER, { callId, afterSeq: 0 }), { events: [], lastSeq: 0 });
  await assert.rejects(f.broker.poll(OWNER, { callId, afterSeq: 1 }), { message: 'CURSOR_EXPIRED' });
  completed(f.runs[0]); await settled(); assert.equal(f.runs.length, 1);
});

test('completed restart preserves metadata/dedupe, never text/key/raw provider errors in SQLite files', async t => {
  const f = fixture(t); const r = f.request(); const { callId } = await f.broker.start(OWNER, r);
  f.runs[0].delta(OUTPUT); completed(f.runs[0]); await settled();
  const failed = await f.broker.start(OWNER, f.request('error'));
  f.runs[1].reject(new Error('RAW-private-provider-error-27e1')); await settled();
  f.restart();
  assert.equal(f.broker.status(OWNER, { callId }).localState, 'completed');
  assert.equal(f.broker.status(OWNER, failed).errorCode, 'TRANSPORT');
  assert.deepEqual(await f.broker.start(OWNER, r), { callId });
  assert.deepEqual((await f.broker.poll(OWNER, { callId, afterSeq: 0 })).events, []);
  f.broker.close();
  for (const file of readdirSync(f.dir)) {
    const bytes = readFileSync(join(f.dir, file));
    for (const secret of [PROMPT, KEY, OUTPUT, 'RAW-private-provider-error-27e1']) {
      assert.equal(bytes.includes(Buffer.from(secret)), false, `content leaked into ${file}`);
    }
  }
});

for (const lifecycle of ['sleep', 'cancelOwner', 'invalidateApprovals'] as const) {
  test(`pending poll cannot deliver a cloned snapshot after host ${lifecycle} clears output`, async t => {
    const f = fixture(t); const { callId } = await f.broker.start(OWNER, f.request());
    f.runs[0].delta(OUTPUT);
    const pending = f.broker.poll(OWNER, { callId, afterSeq: 0 });
    if (lifecycle === 'cancelOwner') f.broker.cancelOwner(OWNER);
    else f.broker[lifecycle]();
    // Rejecting delivery is also safe; it must not return the pre-cleanup snapshot.
    const batch = await pending.catch(() => ({ events: [] as ModelEvent[], lastSeq: 0 }));
    assert.equal(batch.events.some(event => event.kind === 'delta'), false,
      'host cleanup must invalidate already-cloned pending poll output');
    assert.equal(f.runs[0].signal.aborted, true);
  });
}

test('grant revocation timer cancels a silent adapter without requiring another delta', async t => {
  const f = fixture(t); const { callId } = await f.broker.start(OWNER, f.request());
  f.state.grant = undefined; await delay(65);
  assert.equal(f.runs[0].signal.aborted, true);
  assert.equal(f.store.status(callId)?.errorCode, 'REVOKED');
});

test('broker reserves profile-wide hourly admissions; no queue or implicit retry on quota failure', async t => {
  const f = fixture(t);
  for (let i = 0; i < 10; i++) {
    await f.broker.start(OWNER, f.request(`quota-${i}`)); completed(f.runs[i]); await settled();
  }
  await assert.rejects(f.broker.start(OWNER, f.request('quota-overflow')), { message: 'QUOTA_EXCEEDED' });
  assert.equal(f.runs.length, 10);
  f.advance(3600000);
  await f.broker.start(OWNER, f.request('quota-next-hour'));
  assert.equal(f.runs.length, 11);
});

test('prepared restart is not-sent and status-only; no adapter replay', async t => {
  const f = fixture(t);
  f.store.prepare({ callId: 'prepared-only', owner: ownerKey(OWNER), clientRequestId: 'prepared-key',
    requestHash: 'prepared-hash', inputBytes: 1, outputBytes: 32768, maxOutputTokens: 128,
    maxDurationMs: 30000, accountRevision: 'a1' });
  f.restart();
  assert.equal(f.broker.status(OWNER, { callId: 'prepared-only' }).remoteState, 'not-sent');
  assert.equal(f.broker.status(OWNER, { callId: 'prepared-only' }).localState, 'aborted');
  assert.deepEqual(await f.broker.poll(OWNER, { callId: 'prepared-only', afterSeq: 0 }), { events: [], lastSeq: 0 });
  assert.equal(f.store.hasUnknown(), false);
  assert.equal(f.runs.length, 0);
});

for (const field of ['url', 'accountId', 'models'] as const) {
  test(`approval binds exact ${field} even if a host mistakenly reuses a revision`, async t => {
    const f = fixture(t); const request = f.request();
    if (field === 'models') f.account.models['local:text'] = 'changed-wire';
    else f.account[field] = field === 'url' ? 'https://other.invalid/exact' : 'other-account';
    await assert.rejects(f.broker.start(OWNER, request), { message: 'DENIED' });
    assert.equal(f.runs.length, 0);
  });
}

test('detected lock clears buffered output and approvals, even if the host cleanup hook was missed', async t => {
  const f = fixture(t); const request = f.request();
  const extra = f.request('next');
  const {callId} = await f.broker.start(OWNER, request);
  f.runs[0].delta(OUTPUT);
  f.state.profileUnlocked = false;
  await delay(65);
  f.state.profileUnlocked = true;
  assert.deepEqual((await f.broker.poll(OWNER, {callId, afterSeq: 0})).events, []);
  f.store.acknowledgeUnknown();
  await assert.rejects(f.broker.start(OWNER, extra), {message: 'DENIED'});
});

test('dispatch storage failure never invokes adapter; terminal records not-sent', async t => {
  const f = fixture(t); const request = f.request();
  f.store.dispatch = () => { throw new Error('injected dispatch failure'); };
  const { callId } = await f.broker.start(OWNER, request);
  assert.equal(f.runs.length, 0);
  assert.equal(f.store.status(callId)?.localState, 'aborted');
  assert.equal(f.store.status(callId)?.remoteState, 'not-sent');
});

test('terminal storage failure aborts/poisons broker before any output delivery, restart recovers unknown', async t => {
  const f = fixture(t); const { callId } = await f.broker.start(OWNER, f.request());
  f.runs[0].delta(OUTPUT);
  f.store.terminal = () => { throw new Error('injected disk error'); };
  completed(f.runs[0]); await settled();
  assert.equal(f.runs[0].signal.aborted, true);
  await assert.rejects(f.broker.poll(OWNER, { callId, afterSeq: 0 }), { message: 'STORE_UNAVAILABLE' });
  assert.throws(() => f.broker.approve(OWNER, PROMPT), { message: 'STORE_UNAVAILABLE' });
  f.restart();
  assert.equal(f.broker.status(OWNER, { callId }).remoteState, 'unknown');
  assert.deepEqual((await f.broker.poll(OWNER, { callId, afterSeq: 0 })).events, []);
});
