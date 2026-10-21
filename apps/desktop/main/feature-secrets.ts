/**
 * Secrets a feature keeps for itself (an API token, a password), behind the
 * `secrets` capability.
 *
 * `SecretStore` is the platform-neutral port the tile API talks to: values
 * are strings, scoped by feature id, never listed with their values. How a
 * value is protected at rest is the backend's business. This file provides
 * one backend, `EncryptedFileSecretStore`: a JSON file of ciphertexts whose
 * encryption is supplied as a `SecretCipher`, so the file format does not
 * depend on who encrypts. `electron-secret-cipher.ts` supplies the desktop
 * cipher (OS keychain-backed); another platform can supply its own cipher or
 * implement `SecretStore` directly (a native keyring, for example).
 *
 * Plaintext never touches disk: a store with no available cipher refuses
 * every write and read rather than falling back to storing plaintext.
 */

import fs from 'node:fs';
import path from 'node:path';

export type SecretResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface SecretStore {
  /** Whether values can be protected on this machine right now. */
  available(): boolean;
  get(featureId: string, name: string): SecretResult<string | null>;
  set(featureId: string, name: string, value: string): SecretResult<true>;
  delete(featureId: string, name: string): SecretResult<boolean>;
  /** Names the feature has stored; values are not returned. */
  list(featureId: string): SecretResult<string[]>;
}

/** Turns a string into opaque bytes and back. */
export interface SecretCipher {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(cipher: Buffer): string;
}

/** Longest name and value accepted, in characters. */
export const MAX_SECRET_NAME = 128;
export const MAX_SECRET_VALUE = 16 * 1024;
/** Most secrets one feature may hold. */
export const MAX_SECRETS_PER_FEATURE = 32;

const NAME_RE = /^[A-Za-z0-9._:-]+$/;

/** File shape: featureId → name → base64 ciphertext. */
type SecretFile = { version: 1; features: Record<string, Record<string, string>> };

function checkName(name: unknown): string | null {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_SECRET_NAME || !NAME_RE.test(name)) {
    return `secret name must be 1-${MAX_SECRET_NAME} characters of letters, digits, '.', '_', ':' or '-'`;
  }
  return null;
}

export class EncryptedFileSecretStore implements SecretStore {
  constructor(private readonly filePath: string, private readonly cipher: SecretCipher) {}

  available(): boolean {
    return this.cipher.available();
  }

  get(featureId: string, name: string): SecretResult<string | null> {
    const bad = checkName(name) ?? this.unavailable();
    if (bad) return { ok: false, error: bad };
    const stored = this.read().features[featureId]?.[name];
    if (stored === undefined) return { ok: true, value: null };
    try {
      return { ok: true, value: this.cipher.decrypt(Buffer.from(stored, 'base64')) };
    } catch (err) {
      return { ok: false, error: `secret could not be decrypted: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  set(featureId: string, name: string, value: string): SecretResult<true> {
    const bad = checkName(name) ?? this.unavailable();
    if (bad) return { ok: false, error: bad };
    if (typeof value !== 'string' || value.length > MAX_SECRET_VALUE) {
      return { ok: false, error: `secret value must be a string of at most ${MAX_SECRET_VALUE} characters` };
    }
    const file = this.read();
    const own = file.features[featureId] ?? {};
    if (!(name in own) && Object.keys(own).length >= MAX_SECRETS_PER_FEATURE) {
      return { ok: false, error: `a feature may hold at most ${MAX_SECRETS_PER_FEATURE} secrets` };
    }
    own[name] = this.cipher.encrypt(value).toString('base64');
    file.features[featureId] = own;
    this.write(file);
    return { ok: true, value: true };
  }

  delete(featureId: string, name: string): SecretResult<boolean> {
    const bad = checkName(name);
    if (bad) return { ok: false, error: bad };
    const file = this.read();
    const own = file.features[featureId];
    if (!own || !(name in own)) return { ok: true, value: false };
    delete own[name];
    if (Object.keys(own).length === 0) delete file.features[featureId];
    this.write(file);
    return { ok: true, value: true };
  }

  list(featureId: string): SecretResult<string[]> {
    return { ok: true, value: Object.keys(this.read().features[featureId] ?? {}).sort() };
  }

  /** Drop every secret a feature holds, e.g. when the feature is uninstalled. */
  clearFeature(featureId: string): void {
    const file = this.read();
    if (!(featureId in file.features)) return;
    delete file.features[featureId];
    this.write(file);
  }

  private unavailable(): string | null {
    return this.cipher.available() ? null : 'secure storage is not available on this machine';
  }

  private read(): SecretFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as SecretFile;
      if (parsed && parsed.version === 1 && parsed.features && typeof parsed.features === 'object') return parsed;
    } catch {
      // Missing or unreadable: start empty. A corrupt file is replaced on the next write.
    }
    return { version: 1, features: {} };
  }

  private write(file: SecretFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }
}
