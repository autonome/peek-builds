#!/usr/bin/env node
/**
 * Ensure native modules (better-sqlite3) are compiled for Electron's Node ABI.
 *
 * Fast path: tries to require() better-sqlite3 under Electron's Node runtime.
 * Only runs electron-rebuild if the module fails to load (ABI mismatch).
 */

import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const MODULE_PATH = join(ROOT, 'node_modules/better-sqlite3');

function canLoad() {
  try {
    const result = execSync(
      `ELECTRON_RUN_AS_NODE=1 npx electron -e "try { require('${MODULE_PATH}'); process.stdout.write('ok') } catch(e) { process.stdout.write('fail') }"`,
      { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return result.trim() === 'ok';
  } catch {
    return false;
  }
}

if (canLoad()) {
  console.log('[check-native-modules] better-sqlite3 loads in Electron — skip rebuild');
  process.exit(0);
}

console.log('[check-native-modules] better-sqlite3 ABI mismatch — rebuilding...');

try {
  execSync('npx electron-rebuild -f -w better-sqlite3', {
    cwd: ROOT,
    stdio: 'inherit'
  });
} catch (e) {
  console.error('[check-native-modules] Failed to rebuild:', e.message);
  process.exit(1);
}
