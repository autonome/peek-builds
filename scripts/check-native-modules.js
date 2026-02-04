#!/usr/bin/env node
/**
 * Ensure native modules (better-sqlite3) are compiled for Electron's Node ABI.
 *
 * This runs electron-rebuild which is idempotent - it only rebuilds if needed.
 * This prevents the recurring "NODE_MODULE_VERSION mismatch" error that occurs
 * when Electron's embedded Node version differs from the system Node version.
 */

import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

try {
  // electron-rebuild is idempotent - only rebuilds if the ABI doesn't match
  execSync('npx electron-rebuild -f -w better-sqlite3', {
    cwd: ROOT,
    stdio: 'inherit'
  });
} catch (e) {
  console.error('[check-native-modules] Failed to rebuild:', e.message);
  process.exit(1);
}
