import path from 'node:path';
import { EncryptedFileSecretStore, type SecretCipher } from '../feature-secrets.js';
import type { AccountVault } from './contract.js';

const ACCOUNT = /^[A-Za-z0-9._:-]{1,128}$/;
const fail = (): never => { throw new Error('MODEL_VAULT_UNAVAILABLE'); };

/** Host-only instance. Never register this backend with tile:secrets handlers.
 * clear() drops access on profile lock; it does not erase encrypted credentials.
 * JS strings cannot be reliably zeroized; no decrypted value is cached here.
 */
export class ModelAccountVault implements AccountVault {
  private locked = true;
  private readonly backend: EncryptedFileSecretStore;

  constructor(profilePath: string, cipher: SecretCipher) {
    this.backend = new EncryptedFileSecretStore(
      path.join(profilePath, 'model-broker', 'accounts.enc.json'), cipher,
    );
  }

  /** Called only by the host after profile unlock. */
  unlock(): void { this.locked = false; }
  clear(): void { this.locked = true; }
  available(): boolean {
    try { return !this.locked && this.backend.available(); } catch { return false; }
  }
  get(accountId: string): string | null {
    if (!ACCOUNT.test(accountId) || !this.available()) return fail();
    try {
      const result = this.backend.get(`model-broker/accounts/${accountId}`, 'bearer');
      if (!result.ok || (result.value !== null && !/^[\x21-\x7e]{1,4096}$/.test(result.value))) return fail();
      return result.value;
    } catch { return fail(); }
  }
  set(accountId: string, key: string): void {
    if (!ACCOUNT.test(accountId) || !this.available() || typeof key !== 'string' ||
        !/^[\x21-\x7e]{1,4096}$/.test(key)) return fail();
    try {
      const result = this.backend.set(`model-broker/accounts/${accountId}`, 'bearer', key);
      if (!result.ok) return fail();
    } catch { return fail(); }
  }
}
