import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import type { ModelIpcHost } from './ipc.js';
const { registerModelIpc, setModelIpcHost } = await import(new URL(
  import.meta.url.endsWith('.ts') ? './ipc.ts' : './ipc.js', import.meta.url,
).href) as typeof import('./ipc.js');
import type { ModelOwner, ModelState } from './contract.js';
import type { CapabilityGrant, ModelsGrant } from '../tile-manifest.js';
import type { registerTileIpc } from '../tile-ipc-gate.js';
import type { IpcMainInvokeEvent } from 'electron';

const cap: ModelsGrant = { allow: [{ model: 'fake:text', task: 'text.generate' }], maxInputBytes: 16384,
  maxOutputBytes: 32768, maxOutputTokens: 512, maxDurationMs: 30000, maxConcurrent: 1 };
const owner: ModelOwner = { profileId: 'p', installId: 'i', installRevision: 'r', grantRevision: 'g', senderId: 7 };
const start = { token: 'secret-token', model: 'fake:text', task: 'text.generate', input: { text: 'approved' },
  maxOutputTokens: 128, exportApprovalId: 'approval-1', clientRequestId: 'key-1' };
const grant = { tileId: 'feature', capabilities: { models: cap }, trustedBuiltin: false } as CapabilityGrant;
const event = { sender: { id: 7, isDestroyed: () => false } } as IpcMainInvokeEvent;
type Handler = (event: IpcMainInvokeEvent, args: unknown, grant: CapabilityGrant) => Promise<unknown>;
function fixture() {
  const handlers = new Map<string, Handler>();
  const descriptors: unknown[] = [];
  registerModelIpc(((channel: string, descriptor: unknown, handler: Handler) => {
    handlers.set(channel, handler); descriptors.push(descriptor);
  }) as unknown as typeof registerTileIpc);
  const calls: unknown[][] = [];
  let state: ModelState | null = { owner: { ...owner }, state: 'ready', startupAcknowledged: true,
    profileSelected: true, profileUnlocked: true, registryReady: true, grant: structuredClone(cap) };
  const host: ModelIpcHost = {
    resolveOwner: (_event, token, currentGrant) => {
      assert.equal(token, 'secret-token'); assert.equal(currentGrant.tileId, 'feature'); return { ...owner };
    },
    probe: () => state,
    broker: Object.fromEntries(['start', 'poll', 'cancel', 'status'].map(op => [op, async (...args: unknown[]) => {
      calls.push([op, ...args]); return { callId: 'opaque-id' };
    }])) as unknown as ModelIpcHost['broker'],
  };
  setModelIpcHost(host);
  return { host, calls, descriptors, setState: (value: ModelState | null) => { state = value; },
    state: () => state!, invoke: (op = 'start', args: unknown = start, g = grant, e = event) => handlers.get(`tile:models:${op}`)!(e, args, g) };
}
afterEach(() => setModelIpcHost(null));

test('exact four explicit READY/VISIBLE models descriptors; token removed, sender owner passed', async () => {
  const f = fixture();
  assert.equal(f.descriptors.length, 4);
  for (const d of f.descriptors) assert.deepEqual(d, { mode: 'handle', requiredCapabilities: ['models'], stateWindow: ['ready', 'visible'] });
  for (const op of ['start', 'poll', 'cancel', 'status']) {
    const request = op === 'start' ? start : { token: start.token, callId: 'opaque-id', ...(op === 'poll' ? { afterSeq: 0 } : {}) };
    assert.deepEqual(await f.invoke(op, request), { callId: 'opaque-id' });
    assert.deepEqual(f.calls.at(-1)?.[1], owner);
    assert.equal(Object.hasOwn(f.calls.at(-1)?.[2] as object, 'token'), false);
  }
});

test('null host denies all four operations including builtins', async () => {
  const f = fixture(); setModelIpcHost(null);
  for (const op of ['start', 'poll', 'cancel', 'status']) await assert.rejects(f.invoke(op,
    op === 'start' ? start : { token: start.token, callId: 'opaque-id', ...(op === 'poll' ? { afterSeq: 0 } : {}) },
    { ...grant, trustedBuiltin: true }), /MODEL_IPC_DENIED/);
  assert.equal(f.calls.length, 0);
});

for (const state of [null, 'loading', 'suspended', 'unloaded', 'closing', 'READY']) test(`real state ${state} denies even builtin`, async () => {
  const f = fixture(); f.state().state = state;
  await assert.rejects(f.invoke('start', start, { ...grant, trustedBuiltin: true }), /DENIED/);
  assert.equal(f.calls.length, 0);
});
for (const flag of ['startupAcknowledged', 'profileSelected', 'profileUnlocked', 'registryReady'] as const) test(`${flag} required`, async () => {
  const f = fixture(); f.state()[flag] = false;
  await assert.rejects(f.invoke(), /DENIED/); assert.equal(f.calls.length, 0);
});
test('missing probe, missing explicit grants and malformed grant deny', async () => {
  const f = fixture(); f.setState(null);
  await assert.rejects(f.invoke(), /DENIED/);
  for (const models of [undefined, true, {}, { ...cap, maxOutputBytes: Infinity }, { ...cap, extra: true }]) {
    await assert.rejects(f.invoke('start', start, { ...grant, trustedBuiltin: true, capabilities: { models } } as CapabilityGrant), /DENIED/);
  }
  assert.equal(f.calls.length, 0);
});
for (const key of ['profileId', 'installId', 'installRevision', 'grantRevision', 'senderId'] as const) test(`stale ${key} probe denies stolen IDs on every op`, async () => {
  const f = fixture(); Object.assign(f.state().owner, { [key]: key === 'senderId' ? 8 : 'other' });
  for (const op of ['start', 'poll', 'cancel', 'status']) await assert.rejects(f.invoke(op,
    op === 'start' ? start : { token: start.token, callId: 'stolen-id', ...(op === 'poll' ? { afterSeq: 0 } : {}) }), /DENIED/);
  assert.equal(f.calls.length, 0);
});
test('fresh owner resolution and fail-closed absent revision/sender', async () => {
  const f = fixture(); await f.invoke();
  f.host.resolveOwner = () => ({ ...owner, grantRevision: '' });
  await assert.rejects(f.invoke(), /DENIED/);
  f.host.resolveOwner = () => null; await assert.rejects(f.invoke(), /DENIED/);
  f.host.resolveOwner = () => ({ ...owner, senderId: 8 }); await assert.rejects(f.invoke(), /DENIED/);
  assert.equal(f.calls.length, 1);
});
test('destroyed sender, replacement host during probe deny', async () => {
  const f = fixture();
  await assert.rejects(f.invoke('start', start, grant, { sender: { id: 7, isDestroyed: () => true } } as IpcMainInvokeEvent), /DENIED/);
  f.host.probe = () => { setModelIpcHost(null); return f.state(); };
  await assert.rejects(f.invoke(), /DENIED/); assert.equal(f.calls.length, 0);
});

const badStarts: unknown[] = [null, [], {}, { ...start, url: 'https://not-allowed.invalid' },
  { ...start, input: { text: 'x', tools: [] } }, { ...start, input: [] }, { ...start, input: { text: '\ud800' } },
  { ...start, input: { text: 'é'.repeat(8193) } }, { ...start, input: { text: '\u0001'.repeat(5000) } },
  ...[NaN, Infinity, -1, 0, 1.1, 513, Number.MAX_SAFE_INTEGER + 1, '1'].map(maxOutputTokens => ({ ...start, maxOutputTokens })),
  { ...start, model: '*' }, { ...start, task: 'image.generate' }, { ...start, clientRequestId: 'x'.repeat(65) },
  { ...start, exportApprovalId: '' }, { ...start, headers: {} }, Object.assign(Object.create({ evil: true }), start)];
for (const [index, args] of badStarts.entries()) test(`strict deep start schema ${index}`, async () => {
  const f = fixture(); await assert.rejects(f.invoke('start', args), /INVALID/); assert.equal(f.calls.length, 0);
});
for (const afterSeq of [-1, NaN, Infinity, 1.1, Number.MAX_SAFE_INTEGER + 1, '0']) test(`strict cursor ${afterSeq}`, async () => {
  const f = fixture(); await assert.rejects(f.invoke('poll', { token: start.token, callId: 'id', afterSeq }), /INVALID/);
  assert.equal(f.calls.length, 0);
});
test('poll/status/cancel unknown keys and invalid IDs reject', async () => {
  const f = fixture();
  for (const op of ['poll', 'cancel', 'status']) for (const patch of [{ callId: '' }, { callId: 'x'.repeat(129) }, { extra: {} }]) {
    await assert.rejects(f.invoke(op, { token: start.token, callId: 'id', ...(op === 'poll' ? { afterSeq: 0 } : {}), ...patch }), /INVALID/);
  }
  assert.equal(f.calls.length, 0);
});
test('both received grant and fresh probe limits apply', async () => {
  const f = fixture(); f.state().grant = { ...cap, maxInputBytes: 1 };
  await assert.rejects(f.invoke(), /DENIED/);
  f.state().grant = { ...cap, maxOutputTokens: 1 }; await assert.rejects(f.invoke(), /DENIED/);
  f.state().grant = { ...cap, allow: [{ model: 'other', task: 'text.generate' }] }; await assert.rejects(f.invoke(), /DENIED/);
  assert.equal(f.calls.length, 0);
});

test('broker remains independent policy boundary; fixed errors only, no raw host leaks', async () => {
  const f = fixture();
  f.host.broker.start = async () => { throw new Error('fake-private-key/prompt/provider-body'); };
  await assert.rejects(f.invoke(), /^Error: MODEL_IPC_DENIED$/);
  f.host.broker.poll = async () => { throw new Error('CURSOR_EXPIRED'); };
  await assert.rejects(f.invoke('poll', { token: start.token, callId: 'id', afterSeq: 0 }), /^Error: CURSOR_EXPIRED$/);
  f.host.probe = () => { throw new Error('private-path'); };
  await assert.rejects(f.invoke(), /^Error: MODEL_IPC_DENIED$/);
});

test('production preload preserves synchronous app bootstrap and leaves models disabled pending secure grant bootstrap', async () => {
  const source = readFileSync(new URL(import.meta.url.endsWith('.ts')
    ? '../tile-preload.cts' : '../../../main/tile-preload.cts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  for (const [caps, builtin, expected] of [[{}, false, false], [{}, true, false], [{ models: true }, true, false], [{ models: cap }, false, false]] as const) {
    const exposed = new Map<string, Record<string, unknown>>();
    const calls: unknown[][] = [];
    const ipcRenderer = { invoke: async (...args: unknown[]) => {
      calls.push(args); return args[0] === 'tile:validate-token' ? { valid: true, capabilities: caps, trustedBuiltin: builtin } : { callId: 'id' };
    }, send() {}, on() {}, removeListener() {} };
    const document = { addEventListener() {}, head: null };
    const context = vm.createContext({ require: () => ({ ipcRenderer,
      contextBridge: { exposeInMainWorld: (name: string, value: Record<string, unknown>) => exposed.set(name, structuredCloneSafe(value)) },
      webFrame: { executeJavaScript: async () => {} }, installDeadSpaceGesture() {} }),
      process: { argv: ['--tile-id=feature', '--tile-entry=main', '--tile-token=secret-token'], env: {}, platform: 'linux' },
      console: { log() {}, warn() {}, error() {}, debug() {}, info() {} }, performance: { now: () => 0 },
      setTimeout: () => 0, clearTimeout() {}, window: { addEventListener() {} }, document, URL, exports: {} });
    vm.runInContext(js, context);
    // Existing renderer imports capture window.app immediately, before validation.
    assert.ok(exposed.get('app'), 'base bridge must exist synchronously');
    await new Promise(resolve => setImmediate(resolve));
    const api = exposed.get('app')!;
    assert.ok(api); assert.equal(Object.hasOwn(api, 'models'), expected);
    assert.equal(calls.some(call => String(call[0]).startsWith('tile:models:')), false);
  }
});
// Simulate contextBridge's object snapshot without cloning function proxies.
function structuredCloneSafe(value: Record<string, unknown>): Record<string, unknown> {
  return { ...value };
}
