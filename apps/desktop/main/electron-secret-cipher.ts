/**
 * The desktop `SecretCipher`: Electron's `safeStorage`, which keys its
 * encryption from the OS credential store (the macOS Keychain, DPAPI on
 * Windows, libsecret or kwallet on Linux). On Linux with no credential store
 * it would fall back to a hardcoded key; that is reported as unavailable so
 * secrets are refused rather than stored under a known key.
 */

import { safeStorage } from 'electron';
import type { SecretCipher } from './feature-secrets.js';

export const electronSecretCipher: SecretCipher = {
  available() {
    if (!safeStorage.isEncryptionAvailable()) return false;
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
    return true;
  },
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (cipher) => safeStorage.decryptString(cipher),
};
