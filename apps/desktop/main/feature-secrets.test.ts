import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EncryptedFileSecretStore, MAX_SECRETS_PER_FEATURE, type SecretCipher } from './feature-secrets.js';
import { compareCapabilities } from './capability-compare.js';
import { resolveCapabilities, validateTileManifest } from './tile-manifest.js';

/** Reversible stand-in for the OS cipher; the marker proves plaintext is not what lands on disk. */
function fakeCipher(available = true): SecretCipher {
  return {
    available: () => available,
    encrypt: (plain) => Buffer.from(`enc:${Buffer.from(plain).toString('hex')}`),
    decrypt: (buf) => {
      const s = buf.toString();
      if (!s.startsWith('enc:')) throw new Error('not ours');
      return Buffer.from(s.slice(4), 'hex').toString();
    },
  };
}

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-secrets-'));
  file = path.join(dir, 'feature-secrets.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('EncryptedFileSecretStore', () => {
  it('round-trips a value and never writes the plaintext', () => {
    const store = new EncryptedFileSecretStore(file, fakeCipher());
    assert.deepStrictEqual(store.set('vat-export', 'fastmail-token', 'fmu1-secret'), { ok: true, value: true });
    assert.deepStrictEqual(store.get('vat-export', 'fastmail-token'), { ok: true, value: 'fmu1-secret' });
    assert.ok(!fs.readFileSync(file, 'utf8').includes('fmu1-secret'));
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  });

  it('survives a new store instance on the same file', () => {
    new EncryptedFileSecretStore(file, fakeCipher()).set('a', 'k', 'v');
    assert.deepStrictEqual(new EncryptedFileSecretStore(file, fakeCipher()).get('a', 'k'), { ok: true, value: 'v' });
  });

  it('keeps features apart', () => {
    const store = new EncryptedFileSecretStore(file, fakeCipher());
    store.set('a', 'token', 'one');
    assert.deepStrictEqual(store.get('b', 'token'), { ok: true, value: null });
    assert.deepStrictEqual(store.list('b'), { ok: true, value: [] });
    assert.deepStrictEqual(store.delete('b', 'token'), { ok: true, value: false });
    assert.deepStrictEqual(store.get('a', 'token'), { ok: true, value: 'one' });
  });

  it('lists names only, and deletes', () => {
    const store = new EncryptedFileSecretStore(file, fakeCipher());
    store.set('a', 'z', '1');
    store.set('a', 'b', '2');
    assert.deepStrictEqual(store.list('a'), { ok: true, value: ['b', 'z'] });
    assert.deepStrictEqual(store.delete('a', 'z'), { ok: true, value: true });
    assert.deepStrictEqual(store.list('a'), { ok: true, value: ['b'] });
  });

  it('refuses reads and writes when the cipher is unavailable, and writes nothing', () => {
    const store = new EncryptedFileSecretStore(file, fakeCipher(false));
    assert.strictEqual(store.set('a', 'k', 'v').ok, false);
    assert.strictEqual(store.get('a', 'k').ok, false);
    assert.ok(!fs.existsSync(file));
  });

  it('rejects bad names and oversized values', () => {
    const store = new EncryptedFileSecretStore(file, fakeCipher());
    assert.strictEqual(store.set('a', '', 'v').ok, false);
    assert.strictEqual(store.set('a', '../x', 'v').ok, false);
    assert.strictEqual(store.set('a', 'k', 'x'.repeat(16 * 1024 + 1)).ok, false);
  });

  it('caps the number of secrets per feature, but allows overwriting', () => {
    const store = new EncryptedFileSecretStore(file, fakeCipher());
    for (let i = 0; i < MAX_SECRETS_PER_FEATURE; i++) assert.ok(store.set('a', `k${i}`, 'v').ok);
    assert.strictEqual(store.set('a', 'one-more', 'v').ok, false);
    assert.ok(store.set('a', 'k0', 'w').ok);
  });

  it('reports a value it cannot decrypt instead of returning garbage', () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, features: { a: { k: Buffer.from('junk').toString('base64') } } }));
    const r = new EncryptedFileSecretStore(file, fakeCipher()).get('a', 'k');
    assert.strictEqual(r.ok, false);
  });
});

describe('secrets capability', () => {
  it('is granted to a non-builtin feature as requested', () => {
    assert.strictEqual(resolveCapabilities('x', { secrets: true }, false).capabilities.secrets, true);
  });

  it('must be a boolean in a manifest', () => {
    const base = { manifestVersion: 3, id: 'x', name: 'X', version: '1.0.0', tiles: [{ id: 't', url: 't.html' }] };
    const bad = validateTileManifest({ ...base, capabilities: { secrets: 'yes' } });
    assert.ok(bad.some((e) => e.path === 'capabilities.secrets'));
  });

  it('counts as a permission expansion when newly requested', () => {
    assert.strictEqual(compareCapabilities({}, { secrets: true }).expanded, true);
  });
});
