import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseHTML } from 'linkedom';
import { ModelBroker } from './broker.js';
import { ModelStore } from './store.js';
import type { BrokerPorts, ModelAccount, ModelAdapter, ModelOwner, ModelState, Usage } from './contract.js';
import { SelectionHarness } from './selection-harness.js';

function fixture(t: TestContext, usage: Usage | null = null, pending = false) {
  const dir = mkdtempSync(join(tmpdir(), 'peek-selection-harness-'));
  const owner: ModelOwner = { profileId: 'profile', installId: 'test-selection', installRevision: 'i1', grantRevision: 'g1', senderId: 7 };
  const sender = { mainFrame: {}, isDestroyed: () => false };
  const event = { sender, senderFrame: sender.mainFrame };
  let account: ModelAccount = { accountId: 'owned', revision: 'a1', url: 'https://fake.invalid/exact/v1/chat/completions',
    adapter: 'openai-text-v1', models: { demo: 'operator-model-r1' }, allocation: 'unpriced-owned',
    contactApproved: true, acceptsUnverifiedRemoteBounds: true };
  let state: ModelState = { owner, state: 'visible', startupAcknowledged: true, profileSelected: true,
    profileUnlocked: true, registryReady: true, grant: { allow: [{ model: 'demo', task: 'text.generate' }],
      maxInputBytes: 16384, maxOutputBytes: 32768, maxOutputTokens: 512, maxDurationMs: 30000, maxConcurrent: 1 } };
  const sends: Parameters<ModelAdapter['run']>[0][] = [];
  let emit: (text: string) => void = () => {};
  let finish: () => void = () => {};
  let signal: AbortSignal | undefined;
  const ports: BrokerPorts = { now: () => 100 * 86400000, offline: true, probe: () => state,
    account: () => account, vault: { available: () => true, get: () => 'FAKE-HOST-KEY', set: () => {}, clear: () => {} },
    adapter: { run: async (config, abort, delta) => {
      sends.push(config); emit = delta; signal = abort;
      if (pending) await new Promise<void>(resolve => { finish = resolve; });
      else delta('Fake selected-text answer');
      return { outcome: 'completed', usage };
    } } };
  let broker = new ModelBroker(ports, new ModelStore(dir, ports.now));
  const make = () => new SelectionHarness({ broker, trustedSender: sender, owner,
    account: ports.account, model: 'demo', maxOutputTokens: 128 });
  t.after(() => { broker.close(); finish(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, owner, sender, event, sends, make, get broker() { return broker; },
    emit: (text: string) => emit(text), finish: () => finish(), aborted: () => signal?.aborted,
    account: () => account, setAccount: (value: ModelAccount) => { account = value; },
    setState: (value: Partial<ModelState>) => { state = { ...state, ...value }; },
    state: () => state,
    restart: () => { broker.close(); broker = new ModelBroker(ports, new ModelStore(dir, ports.now)); } };
}
async function start(f: ReturnType<typeof fixture>, text = 'Explicit selected snapshot') {
  const harness = f.make();
  const view = harness.present(f.event, text);
  harness.approve(f.event, view.presentationId!);
  const { callId } = await harness.start(f.event, view.presentationId!);
  return { harness, callId };
}

for (const usage of [null, { promptTokens: 3, completionTokens: 5, totalTokens: 8 }]) {
  test(`explicit snapshot/destination approval, fake output, usage ${usage ? 'reported' : 'unknown'}`, async t => {
    const f = fixture(t, usage);
    const harness = f.make();
    const view = harness.present(f.event, 'Only this selection — not the whole page');
    assert.equal(view.selectedText, 'Only this selection — not the whole page');
    assert.equal(view.destination, f.account().url);
    assert.equal(view.wireModel, 'operator-model-r1');
    assert.equal(view.allocation, 'unpriced-owned');
    assert.equal(view.acceptsUnverifiedRemoteBounds, true);
    assert.match(view.disclosure, /does not prove remote work stopped/);
    assert.equal(view.productionNetworkEnabled, false);
    assert.equal(f.sends.length, 0);
    await assert.rejects(harness.start(f.event, view.presentationId!), /SELECTION_DENIED/);
    harness.approve(f.event, view.presentationId!);
    assert.equal(f.sends.length, 0, 'approval alone never sends');
    assert.throws(() => harness.approve(f.event, view.presentationId!), /SELECTION_DENIED/);
    await harness.start(f.event, view.presentationId!);
    await harness.poll(f.event);
    const result = harness.view(f.event);
    assert.equal(result.output, 'Fake selected-text answer');
    assert.deepEqual(result.status?.usage, usage);
    assert.equal(result.status?.remoteState, 'finished');
    assert.equal(f.sends.length, 1);
    assert.equal(f.sends[0].text, view.selectedText);
    assert.equal(f.sends[0].url, view.destination);
    assert.equal(f.sends[0].maxOutputTokens, 128);
    assert.doesNotMatch(JSON.stringify(result), /FAKE-HOST-KEY|exportApprovalId/);
    await harness.poll(f.event);
    assert.equal(harness.view(f.event).output, result.output, 'ack/delivery does not duplicate output');
  });
}

test('exact trusted sender and current mainFrame, not builtin or numeric sender identity', async t => {
  const f = fixture(t);
  const harness = f.make();
  const id = harness.present(f.event, 'selection').presentationId!;
  for (const event of [
    { sender: { id: 7, trustedBuiltin: true }, senderFrame: f.sender.mainFrame },
    { sender: { ...f.sender }, senderFrame: f.sender.mainFrame },
    { sender: f.sender, senderFrame: {} },
  ]) {
    assert.throws(() => harness.present(event, 'selection'), /SELECTION_DENIED/);
    assert.throws(() => harness.approve(event, id), /SELECTION_DENIED/);
    await assert.rejects(harness.start(event, id), /SELECTION_DENIED/);
    await assert.rejects(harness.poll(event), /SELECTION_DENIED/);
    assert.throws(() => harness.cancel(event), /SELECTION_DENIED/);
    assert.throws(() => harness.status(event, 'stolen'), /SELECTION_DENIED/);
    assert.throws(() => harness.view(event), /SELECTION_DENIED/);
  }
  f.sender.mainFrame = {};
  assert.throws(() => harness.approve(f.event, id), /SELECTION_DENIED/);
  f.sender.isDestroyed = () => true;
  assert.throws(() => harness.present({ sender: f.sender, senderFrame: f.sender.mainFrame }, 'x'), /SELECTION_DENIED/);
  assert.equal(f.sends.length, 0);
});

test('changed destination/revision or selected snapshot requires new explicit presentation/approval', async t => {
  const f = fixture(t);
  const h = f.make();
  const first = h.present(f.event, 'first');
  h.approve(f.event, first.presentationId!);
  const second = h.present(f.event, 'second');
  await assert.rejects(h.start(f.event, first.presentationId!), /SELECTION_DENIED/);
  await assert.rejects(h.start(f.event, second.presentationId!), /SELECTION_DENIED/);
  h.approve(f.event, second.presentationId!);
  f.setAccount({ ...f.account(), url: 'https://changed.invalid/endpoint', revision: 'a2' });
  await assert.rejects(h.start(f.event, second.presentationId!), /SELECTION_DENIED/);
  assert.equal(f.sends.length, 0);
});

test('broker remains the authority: missing explicit grant, stale owner, locked profile deny even trusted harness', t => {
  const f = fixture(t);
  const initial = f.state();
  for (const state of [{ grant: undefined }, { profileUnlocked: false }, { owner: { ...f.owner, grantRevision: 'stale' } }]) {
    const h = f.make();
    const id = h.present(f.event, 'selected').presentationId!;
    f.setState(state);
    assert.throws(() => h.approve(f.event, id), /DENIED/);
    f.setState(initial);
  }
  assert.equal(f.sends.length, 0);
});

test('selection input is bounded valid UTF-8, no whole-page reader or configuration/key methods', t => {
  const f = fixture(t);
  const h = f.make();
  for (const text of ['', 'x'.repeat(16385), '🙂'.repeat(4097), '\ud800']) {
    assert.throws(() => h.present(f.event, text), /SELECTION_DENIED/);
  }
  assert.equal(h.present(f.event, '🙂'.repeat(4096)).selectedText.length, 8192);
  for (const method of ['configure', 'setKey', 'account', 'readPage', 'approveExport']) assert.equal(method in h, false);
  assert.equal(f.sends.length, 0);
});

test('cancel, late output, reopen status and restart never replay or reconstruct content', async t => {
  const f = fixture(t, null, true);
  const { harness, callId } = await start(f);
  f.emit('partial');
  await harness.poll(f.event);
  assert.equal(harness.view(f.event).output, 'partial');
  assert.equal(harness.cancel(f.event).remoteState, 'unknown');
  assert.equal(f.aborted(), true);
  f.emit('late'); f.finish();
  await harness.poll(f.event);
  assert.equal(harness.view(f.event).output, 'partial');
  const reopened = f.make();
  assert.equal(reopened.status(f.event, callId).localState, 'aborted');
  assert.equal(reopened.status(f.event, callId).usage, null);
  assert.equal(reopened.view(f.event).output, '');
  f.restart();
  const afterRestart = f.make();
  assert.equal(afterRestart.status(f.event, callId).remoteState, 'unknown');
  assert.equal(afterRestart.status(f.event, callId).errorCode, 'CANCELLED');
  assert.equal(afterRestart.view(f.event).selectedText, '');
  assert.equal(f.sends.length, 1);
  assert.doesNotMatch(readFileSync(join(f.dir, 'model-broker.sqlite')).toString(), /Explicit selected snapshot|FAKE-HOST-KEY|partial/);
});

test('malicious selection/output are escaped inert text, never active elements or datastore commands', async t => {
  const f = fixture(t, null, true);
  const payload = '<script>globalThis.selectionExecuted=true</script><img src=x onerror="globalThis.selectionExecuted=true"><a href="javascript:alert(1)">click</a>& tools.deleteDatastore()';
  const { harness } = await start(f, payload);
  f.emit(payload); f.finish();
  await harness.poll(f.event);
  const view = harness.view(f.event);
  const { document } = parseHTML(view.html);
  assert.equal(document.querySelectorAll('script,img,a,[onerror]').length, 0);
  assert.equal(document.querySelectorAll('pre')[1].textContent, payload);
  assert.equal(document.querySelectorAll('pre')[2].textContent, payload);
  assert.equal(view.output, payload);
  assert.match(view.html, /&lt;script&gt;/);
  assert.equal(Reflect.get(globalThis, 'selectionExecuted'), undefined);
});

test('output bounded to 32 KiB with broker enforcing excess; escaped view remains bounded', async t => {
  const f = fixture(t, null, true);
  const { harness } = await start(f);
  for (let i = 0; i < 8; i++) {
    f.emit('<'.repeat(4096));
    await harness.poll(f.event);
  }
  assert.equal(Buffer.byteLength(harness.view(f.event).output), 32768);
  f.emit('overflow');
  await harness.poll(f.event);
  const view = harness.view(f.event);
  assert.equal(Buffer.byteLength(view.output), 32768);
  assert.equal(view.status?.errorCode, 'OUTPUT_LIMIT');
  assert.ok(Buffer.byteLength(view.html) < 210000);
});
