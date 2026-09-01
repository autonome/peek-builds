#!/usr/bin/env node
/**
 * Capabilities Freshness Check
 *
 * Verifies that apps/server/capabilities.js is up-to-date with
 * packages/capabilities/index.js, and that the generated file actually
 * loads and exposes the expected functions — a syntax error in a
 * hand-edited or stale projection would otherwise only surface the next
 * time apps/server required it.
 *
 * Run with: node packages/capabilities/check-freshness.js
 *           yarn capabilities:check
 *
 * Exit codes:
 *   0 - apps/server/capabilities.js is fresh and loadable
 *   1 - stale, missing, or fails to load
 *
 * Usage in CI:
 *   yarn capabilities:check || (echo "Run 'yarn capabilities:codegen' and commit" && exit 1)
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { generateServerCapabilities } from './codegen.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SERVER_PATH = join(__dirname, '..', '..', 'apps', 'server', 'capabilities.js');

const EXPECTED_EXPORTS = [
  'detectManifestVersion',
  'validateTileManifest',
  'parseManifestJSON',
  'resolveCapabilities',
  'createTrustedBuiltinGrant',
];

function main() {
  console.log('[capabilities-freshness] Checking if apps/server/capabilities.js is up-to-date...\n');

  if (!existsSync(SERVER_PATH)) {
    console.error('[capabilities-freshness] ERROR: Missing generated file: apps/server/capabilities.js');
    console.error('[capabilities-freshness] Run "yarn capabilities:codegen" to generate it');
    process.exit(1);
  }

  const sourceJs = readFileSync(join(__dirname, 'index.js'), 'utf-8');
  const fresh = generateServerCapabilities(sourceJs);
  const current = readFileSync(SERVER_PATH, 'utf-8');

  if (current !== fresh) {
    console.error('[capabilities-freshness] STALE: apps/server/capabilities.js');
    console.error('[capabilities-freshness] Run "yarn capabilities:codegen" and commit the changes');
    process.exit(1);
  }
  console.log('[capabilities-freshness] OK: apps/server/capabilities.js is fresh');

  // Prove the generated CommonJS file actually loads under require() — a
  // stale check above only catches text drift, not a projection that
  // parses but throws when apps/server requires it at startup.
  const require = createRequire(import.meta.url);
  delete require.cache[require.resolve(SERVER_PATH)];
  let loaded;
  try {
    loaded = require(SERVER_PATH);
  } catch (err) {
    console.error('[capabilities-freshness] ERROR: apps/server/capabilities.js failed to load:', err.message);
    process.exit(1);
  }

  const missing = EXPECTED_EXPORTS.filter((name) => typeof loaded[name] !== 'function');
  if (missing.length > 0) {
    console.error(`[capabilities-freshness] ERROR: apps/server/capabilities.js is missing expected export(s): ${missing.join(', ')}`);
    process.exit(1);
  }
  console.log(`[capabilities-freshness] OK: apps/server/capabilities.js loads and exposes ${EXPECTED_EXPORTS.join(', ')}`);

  console.log('\n[capabilities-freshness] All checks passed');
  process.exit(0);
}

main();
