import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BrokerPorts, ModelAccount, ModelOwner, ModelRequest, ModelState } from './contract.js';
import { ownerKey } from './contract.js';
import { admitModels, exact, hashText, identifier, validOwner, validateCall, validateStart } from './policy.js';

const owner: ModelOwner = { profileId: 'profile', installId: 'install', installRevision: 'i1', grantRevision: 'g1', senderId: 7 };
const request = (): ModelRequest => ({ model: 'local:text', task: 'text.generate', input: { text: 'approved selection' },
  maxOutputTokens: 128, exportApprovalId: 'approval', clientRequestId: 'request-1' });
function fixture() {
  const state: ModelState = { owner: { ...owner }, state: 'ready', startupAcknowledged: true,
    profileSelected: true, profileUnlocked: true, registryReady: true,
    grant: { allow: [{ model: 'local:text', task: 'text.generate' }], maxInputBytes: 16384,
      maxOutputBytes: 32768, maxOutputTokens: 512, maxDurationMs: 30000, maxConcurrent: 1 } };
  const account: ModelAccount = { accountId: 'account', revision: 'a1', url: 'https://fixture.invalid/v1/chat/completions',
    adapter: 'openai-text-v1', models: { 'local:text': 'wire-text' }, allocation: 'unpriced-owned',
    contactApproved: true, acceptsUnverifiedRemoteBounds: true };
  const ports: BrokerPorts = { now: () => 100, probe: () => state, account: () => account, offline: true,
    vault: { available: () => true, get: () => 'fake-key', set() {}, clear() {} },
    adapter: { async run() { assert.fail('policy must never dispatch'); } } };
  return { ports, state, account };
}
const denied = (fn: () => unknown) => assert.throws(fn, { message: 'DENIED' });
const invalid = (fn: () => unknown) => assert.throws(fn, { message: 'INVALID_REQUEST' });

test('start returns a detached exact schema, including null-prototype plain input', () => {
  const input = request();
  const result = validateStart(input);
  assert.deepEqual(result, input);
  input.input.text = 'changed';
  assert.equal(result.input.text, 'approved selection');
  assert.deepEqual(validateStart(Object.assign(Object.create(null), request())), request());
});

const badStarts: Array<[string, (r: ModelRequest) => unknown]> = [
  ['null', () => null], ['array', () => []], ['class instance', r => Object.assign(new Date(), r)],
  ['extra URL', r => ({ ...r, url: 'https://attacker.invalid' })],
  ['extra headers', r => ({ ...r, headers: {} })], ['extra key', r => ({ ...r, key: 'stolen' })],
  ['extra tools', r => ({ ...r, tools: [] })], ['missing field', r => { const { task: _, ...rest } = r; return rest; }],
  ['wrong task', r => ({ ...r, task: 'image.generate' })], ['nested extra', r => ({ ...r, input: { ...r.input, hidden: 'secret' } })],
  ['nested array', r => ({ ...r, input: [] })], ['nonstring text', r => ({ ...r, input: { text: 1 } })],
  ['empty text', r => ({ ...r, input: { text: '' } })], ['broken UTF-16', r => ({ ...r, input: { text: '\ud800' } })],
  ['input bytes', r => ({ ...r, input: { text: 'é'.repeat(8193) } })],
  ['serialized request bytes', r => ({ ...r, input: { text: '\u0000'.repeat(4096) } })],
  ['empty model', r => ({ ...r, model: '' })], ['wildcard model', r => ({ ...r, model: '*' })],
  ['unicode model', r => ({ ...r, model: '模型' })], ['long model', r => ({ ...r, model: 'x'.repeat(129) })],
  ['empty approval', r => ({ ...r, exportApprovalId: '' })], ['long approval', r => ({ ...r, exportApprovalId: 'a'.repeat(129) })],
  ['long client key', r => ({ ...r, clientRequestId: 'x'.repeat(65) })], ['nonstring key', r => ({ ...r, clientRequestId: 7 })],
  ...[0, -1, 513, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '128', null].map(value =>
    [`tokens ${String(value)}`, (r: ModelRequest) => ({ ...r, maxOutputTokens: value })] as [string, (r: ModelRequest) => unknown]),
];
for (const [name, change] of badStarts) test(`start schema rejects ${name}`, () => invalid(() => validateStart(change(request()))));

test('exact rejects symbols, accessors, inherited fields and exotic prototypes without reading getters', () => {
  let reads = 0;
  const r = request();
  Object.defineProperty(r, 'model', { get() { reads++; return 'local:text'; }, enumerable: true });
  invalid(() => validateStart(r));
  assert.equal(reads, 0);
  invalid(() => validateStart({ ...request(), [Symbol('hidden')]: true }));
  invalid(() => validateStart(Object.create(request())));
  assert.equal(exact({ a: 1 }, ['a']), true);
  assert.equal(identifier('a._:-9'), true);
  assert.equal(identifier('a/b'), false);
});

test('UTF-8 and integer inclusive boundaries', () => {
  assert.equal(validateStart({ ...request(), input: { text: 'é'.repeat(8192) }, maxOutputTokens: 512 }).maxOutputTokens, 512);
  assert.equal(validateStart({ ...request(), maxOutputTokens: 1 }).maxOutputTokens, 1);
  assert.equal(validateStart({ ...request(), clientRequestId: 'k'.repeat(64), model: 'm'.repeat(128) }).model.length, 128);
});

for (const poll of [false, true]) {
  test(`call schema is exact (poll=${poll})`, () => {
    const good = poll ? { callId: 'opaque-1', afterSeq: 0 } : { callId: 'opaque-1' };
    assert.deepEqual(validateCall(good, poll), { callId: 'opaque-1', afterSeq: 0 });
    for (const bad of [null, [], {}, { ...good, extra: true }, { ...good, callId: '' }, { ...good, callId: 'x'.repeat(129) }]) {
      invalid(() => validateCall(bad, poll));
    }
    if (poll) for (const afterSeq of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', undefined]) {
      invalid(() => validateCall({ callId: 'opaque-1', afterSeq }, true));
    }
    else invalid(() => validateCall({ ...good, afterSeq: 0 }));
  });
}

test('owner identity includes profile/install/revisions/sender, not property order', () => {
  assert.equal(validOwner(owner), true);
  assert.equal(ownerKey({ senderId: 7, grantRevision: 'g1', installRevision: 'i1', installId: 'install', profileId: 'profile' }), ownerKey(owner));
  for (const field of ['profileId', 'installId', 'installRevision', 'grantRevision'] as const) {
    assert.notEqual(ownerKey({ ...owner, [field]: 'other' }), ownerKey(owner));
    for (const value of ['', 'é'.repeat(257), null]) assert.equal(validOwner({ ...owner, [field]: value } as ModelOwner), false);
  }
  for (const senderId of [0, -1, NaN, Infinity, 1.5]) assert.equal(validOwner({ ...owner, senderId }), false);
  assert.notEqual(ownerKey({ ...owner, senderId: 8 }), ownerKey(owner));
  assert.equal(hashText('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.notEqual(hashText('é'), hashText('e\u0301'));
});

test('ready and visible admit only attested offline account; returned account is detached', () => {
  const f = fixture();
  for (const state of ['ready', 'visible']) { f.state.state = state; assert.equal(admitModels(f.ports, owner).state, f.state); }
  const admitted = admitModels(f.ports, owner);
  admitted.account.models['local:text'] = 'mutated';
  assert.equal(f.account.models['local:text'], 'wire-text');
});

const admissionFailures: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
  ['missing probe', f => { f.ports.probe = () => null; }], ['missing account', f => { f.ports.account = () => null; }],
  ['production mode', f => { Object.assign(f.ports, { offline: false }); }],
  ...['startupAcknowledged', 'profileSelected', 'profileUnlocked', 'registryReady'].map(key =>
    [key, (f: ReturnType<typeof fixture>) => { Object.assign(f.state, { [key]: false }); }] as [string, (f: ReturnType<typeof fixture>) => void]),
  ...[null, 'loading', 'LOADING', 'suspended', 'unloaded', 'crashed', 'disabled'].map(state =>
    [`state ${state}`, (f: ReturnType<typeof fixture>) => { f.state.state = state; }] as [string, (f: ReturnType<typeof fixture>) => void]),
  ...['profileId', 'installId', 'installRevision', 'grantRevision', 'senderId'].map(key =>
    [`stale ${key}`, (f: ReturnType<typeof fixture>) => { Object.assign(f.state.owner, { [key]: key === 'senderId' ? 8 : 'other' }); }] as [string, (f: ReturnType<typeof fixture>) => void]),
  ['missing grant', f => { f.state.grant = undefined; }],
  ['invalid grant', f => { f.state.grant!.maxConcurrent = 2; }], ['grant extra key', f => { Object.assign(f.state.grant!, { network: true }); }],
  ['secure storage unavailable', f => { f.ports.vault.available = () => false; }],
  ['metered', f => { Object.assign(f.account, { allocation: 'metered' }); }], ['unknown allocation', f => { Object.assign(f.account, { allocation: 'unknown' }); }],
  ['no contact consent', f => { f.account.contactApproved = false; }],
  ['no remote bounds attestation', f => { f.account.acceptsUnverifiedRemoteBounds = false; }],
  ['wrong adapter', f => { Object.assign(f.account, { adapter: 'other' }); }],
  ['invalid account id', f => { f.account.accountId = '*'; }], ['invalid revision', f => { f.account.revision = ''; }],
  ...['http://fixture.invalid/path', 'https://user:pass@fixture.invalid/path', 'https://fixture.invalid/path?q=1',
    'https://fixture.invalid/path#fragment', 'https://fixture.invalid/has space', 'https://fixture.invalid\\path', 'not a URL'].map(url =>
    [`URL ${url}`, (f: ReturnType<typeof fixture>) => { f.account.url = url; }] as [string, (f: ReturnType<typeof fixture>) => void]),
];
for (const [name, change] of admissionFailures) for (const builtin of [false, true]) {
  test(`admission denies ${name}; builtin=${builtin} has no bypass`, () => {
    const f = fixture(); change(f);
    denied(() => admitModels(f.ports, Object.assign({ ...owner }, { trustedBuiltin: builtin })));
  });
}
