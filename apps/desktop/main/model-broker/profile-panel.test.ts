import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModelProfilePanel, type ModelProfilePanelPorts } from './profile-panel.js';
import { ModelAccountVault } from './account-vault.js';
import type { SecretCipher } from '../feature-secrets.js';

const config = () => ({ accountId: 'fake-owned', label: 'Fake owner', revisionLabel: 'fixture-r1',
  url: 'https://fixture.invalid/exact/chat/completions', adapter: 'openai-text-v1',
  models: { 'operator:text-v1': 'fake-text-v1' }, allocation: 'unpriced-owned',
  contactApproved: true, acceptsUnverifiedRemoteBounds: true });
const keyInput = () => ({ key: 'FAKE-KEY-NOT-A-CREDENTIAL', allocation: 'unpriced-owned',
  contactApproved: true, acceptsUnverifiedRemoteBounds: true });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-model-panel-'));
  let available = true;
  let key: string | null = null;
  let reads = 0;
  let invalidations = 0;
  let unknown = true;
  let destroyed = false;
  const sender = { mainFrame: {}, isDestroyed: () => destroyed };
  const event = { sender, senderFrame: sender.mainFrame };
  const ports: ModelProfilePanelPorts = {
    profilePath: dir, trustedSender: sender,
    vault: { available: () => available, get: () => { reads++; return key; },
      set: (_id, value) => { key = value; }, clear: () => { key = null; } },
    store: { hasUnknown: () => unknown, acknowledgeUnknown: () => { unknown = false; } },
    invalidateApprovals: () => { invalidations++; },
  };
  const panel = new ModelProfilePanel(ports);
  panel.unlock();
  return { dir, panel, ports, event, destroy: () => { destroyed = true; },
    unavailable: () => { available = false; }, reads: () => reads, key: () => key,
    invalidations: () => invalidations, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('exact trusted sender AND current main frame required, including builtin-like objects', () => {
  const f = fixture();
  try {
    for (const event of [{ sender: { ...f.event.sender }, senderFrame: f.event.senderFrame },
      { sender: { trustedBuiltin: true }, senderFrame: f.event.senderFrame },
      { sender: f.event.sender, senderFrame: {} }]) {
      assert.throws(() => f.panel.view(event), /MODEL_PANEL_DENIED/);
      assert.throws(() => f.panel.configure(event, config()), /MODEL_PANEL_DENIED/);
      assert.throws(() => f.panel.setKey(event, keyInput()), /MODEL_PANEL_DENIED/);
      assert.throws(() => f.panel.acknowledgeUnknown(event, { acceptUnresolvedRemoteWork: true }), /MODEL_PANEL_DENIED/);
    }
    assert.equal(f.invalidations(), 0);
    f.destroy();
    assert.throws(() => f.panel.view(f.event), /MODEL_PANEL_DENIED/);
  } finally { f.cleanup(); }
});

test('full offline view and metadata survive restart; keys never read back', () => {
  const f = fixture();
  try {
    f.panel.configure(f.event, config());
    const first = f.panel.account()!;
    f.panel.setKey(f.event, keyInput());
    const second = f.panel.account()!;
    assert.notEqual(first.revision, second.revision);
    assert.equal(f.invalidations(), 2);
    const view = f.panel.view(f.event);
    assert.equal(view.configuration?.url, config().url);
    assert.deepEqual({ ...view.configuration?.models }, config().models);
    assert.equal(view.configuration?.allocation, 'unpriced-owned');
    assert.equal(view.configuration?.acceptsUnverifiedRemoteBounds, true);
    assert.equal(view.remoteUnknown, true);
    assert.equal(view.productionNetworkEnabled, false);
    assert.match(view.disclosure, /does not prove remote work stopped/);
    assert.equal(JSON.stringify(view).includes(keyInput().key), false);
    assert.equal(f.reads(), 0);
    const persisted = fs.readFileSync(path.join(f.dir, 'model-broker/profile.json'), 'utf8');
    assert.equal(persisted.includes(keyInput().key), false);
    const reopened = new ModelProfilePanel(f.ports);
    assert.equal(reopened.account(), null);
    reopened.unlock();
    assert.deepEqual(reopened.account(), second);
    second.models['operator:text-v1'] = 'mutated';
    assert.equal(f.panel.account()!.models['operator:text-v1'], 'fake-text-v1');
    f.panel.configure(f.event, { ...config(), url: 'https://other.invalid/full/path' });
    assert.notEqual(f.panel.account()!.revision, second.revision);
    assert.equal(f.invalidations(), 3);
  } finally { f.cleanup(); }
});

for (const url of ['http://127.0.0.1/chat', 'https://u:p@fixture.invalid/chat',
  'https://fixture.invalid/chat?q=1', 'https://fixture.invalid/chat#x',
  'https://fixture.invalid/chat?', 'https://fixture.invalid/chat#',
  'https://@fixture.invalid/chat', 'https:///fixture.invalid/chat',
  'https:\\fixture.invalid/chat', ' https://fixture.invalid/chat', 'file:///tmp/chat']) {
  test(`reject unsafe URL ${JSON.stringify(url)}`, () => {
    const f = fixture();
    try { assert.throws(() => f.panel.configure(f.event, { ...config(), url }), /MODEL_PANEL_INVALID/); }
    finally { f.cleanup(); }
  });
}

for (const bad of [ { ...config(), allocation: 'metered' }, { ...config(), allocation: 'unknown' },
  { ...config(), contactApproved: false }, { ...config(), acceptsUnverifiedRemoteBounds: false },
  { ...config(), extra: true }, { ...config(), headers: {} }, { ...config(), adapter: 'other' },
  { ...config(), models: {} }, { ...config(), models: { '*': 'wildcard' } },
  { ...config(), models: { 'local/path': 'wire' } }, { ...config(), models: { '-local': 'wire' } },
  { ...config(), models: { local: { key: 'hidden' } } },
  { ...config(), models: { local: 'line\nbreak' } }, { ...config(), accountId: '../escape' } ]) {
  test(`strict configuration rejects ${JSON.stringify(bad)}`, () => {
    const f = fixture();
    try {
      assert.throws(() => f.panel.configure(f.event, bad), /MODEL_PANEL_INVALID/);
      assert.equal(f.panel.account(), null);
      assert.equal(f.invalidations(), 0);
    } finally { f.cleanup(); }
  });
}

test('missing secure storage, lock, and explicit durable unknown acknowledgment fail closed', () => {
  const f = fixture();
  try {
    f.panel.configure(f.event, config());
    f.panel.setKey(f.event, keyInput());
    for (const input of [{}, { acceptUnresolvedRemoteWork: false },
      { acceptUnresolvedRemoteWork: true, extra: true }]) {
      assert.throws(() => f.panel.acknowledgeUnknown(f.event, input), /MODEL_PANEL_INVALID/);
    }
    assert.equal(f.panel.view(f.event).remoteUnknown, true);
    f.panel.acknowledgeUnknown(f.event, { acceptUnresolvedRemoteWork: true });
    assert.equal(f.panel.view(f.event).remoteUnknown, false);
    const restarted = new ModelProfilePanel(f.ports);
    restarted.unlock();
    assert.equal(restarted.view(f.event).remoteUnknown, false);
    f.panel.lock();
    assert.equal(f.key(), null);
    assert.equal(f.panel.account(), null);
    assert.throws(() => f.panel.view(f.event), /MODEL_PANEL_DENIED/);
    f.panel.unlock();
    f.unavailable();
    assert.equal(f.panel.account(), null);
    assert.throws(() => f.panel.configure(f.event, config()), /MODEL_PANEL_SECURE_STORAGE/);
    assert.throws(() => f.panel.setKey(f.event, keyInput()), /MODEL_PANEL_SECURE_STORAGE/);
  } finally { f.cleanup(); }
});

test('key changes require fresh explicit owned/contact/remote-bounds attestation', () => {
  const f = fixture();
  try {
    f.panel.configure(f.event, config());
    for (const bad of [{ key: 'fake' }, { ...keyInput(), allocation: 'metered' },
      { ...keyInput(), contactApproved: false }, { ...keyInput(), acceptsUnverifiedRemoteBounds: false },
      { ...keyInput(), key: 'header\r\ninjection' }, { ...keyInput(), extra: 'hidden' }]) {
      assert.throws(() => f.panel.setKey(f.event, bad), /MODEL_PANEL_INVALID/);
    }
    assert.equal(f.key(), null);
    assert.equal(f.invalidations(), 1);
  } finally { f.cleanup(); }
});

test('metadata corruption and write failure fail closed without raw diagnostics', () => {
  const f = fixture();
  try {
    f.panel.configure(f.event, config());
    const file = path.join(f.dir, 'model-broker/profile.json');
    fs.writeFileSync(file, 'PRIVATE-RAW-ERROR');
    assert.throws(() => new ModelProfilePanel(f.ports), /^Error: MODEL_PANEL_STORAGE$/);
    fs.rmSync(file);
    fs.mkdirSync(file);
    assert.throws(() => f.panel.configure(f.event, config()), /^Error: MODEL_PANEL_STORAGE$/);
    assert.equal(f.panel.account(), null);
    assert.equal(f.key(), null);
  } finally { f.cleanup(); }
});

test('dedicated encrypted backend, locked custody, no feature registration or plaintext file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-model-vault-'));
  let available = true;
  // Reversible fixture cipher, not an OS security/conformance test.
  const cipher: SecretCipher = { available: () => available,
    encrypt: plain => Buffer.from([...Buffer.from(plain)].map(n => n ^ 0xa5)),
    decrypt: encrypted => Buffer.from([...encrypted].map(n => n ^ 0xa5)).toString() };
  try {
    const vault = new ModelAccountVault(dir, cipher);
    assert.equal(vault.available(), false);
    assert.throws(() => vault.get('fake-owned'), /MODEL_VAULT_UNAVAILABLE/);
    vault.unlock();
    assert.equal(vault.get('fake-owned'), null);
    vault.set('fake-owned', keyInput().key);
    assert.equal(vault.get('fake-owned'), keyInput().key);
    const file = fs.readFileSync(path.join(dir, 'model-broker/accounts.enc.json'), 'utf8');
    assert.equal(file.includes(keyInput().key), false);
    assert.match(file, /model-broker\/accounts\/fake-owned/);
    assert.equal(fs.existsSync(path.join(dir, 'feature-secrets.json')), false);
    vault.clear();
    assert.equal(vault.available(), false);
    assert.throws(() => vault.get('fake-owned'), /MODEL_VAULT_UNAVAILABLE/);
    const restarted = new ModelAccountVault(dir, cipher);
    restarted.unlock();
    assert.equal(restarted.get('fake-owned'), keyInput().key);
    available = false;
    assert.equal(restarted.available(), false);
    assert.throws(() => restarted.get('fake-owned'), /MODEL_VAULT_UNAVAILABLE/);
    assert.throws(() => restarted.set('fake-owned', 'fake'), /MODEL_VAULT_UNAVAILABLE/);
    available = true;
    assert.throws(() => restarted.set('../bad', 'fake'), /MODEL_VAULT_UNAVAILABLE/);
    assert.throws(() => restarted.set('fake-owned', 'bad\nkey'), /MODEL_VAULT_UNAVAILABLE/);
    const broken = new ModelAccountVault(dir, { available: () => true,
      encrypt: () => { throw new Error('PRIVATE'); }, decrypt: () => { throw new Error('PRIVATE'); } });
    broken.unlock();
    assert.throws(() => broken.get('fake-owned'), /^Error: MODEL_VAULT_UNAVAILABLE$/);
    assert.throws(() => broken.set('fake-owned', 'fake'), /^Error: MODEL_VAULT_UNAVAILABLE$/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
