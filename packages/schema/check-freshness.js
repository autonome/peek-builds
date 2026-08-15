#!/usr/bin/env node
/**
 * Schema Freshness Check
 *
 * Verifies that generated files are up-to-date with schema/v1.json.
 * Run with: node schema/check-freshness.js
 *           yarn schema:check
 *
 * Exit codes:
 *   0 - Generated files are fresh
 *   1 - Generated files are stale (need regeneration)
 *
 * Usage in CI:
 *   yarn schema:check || (echo "Run 'yarn schema:codegen' and commit" && exit 1)
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  generateSqlite,
  generateTypescript,
  generateRust,
  generateValidator,
} from './codegen.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const GENERATED_DIR = join(__dirname, 'generated');

const schemaPath = join(__dirname, 'v1.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));

// Files this check covers, paired with the same generator functions
// codegen.js uses to produce them. Comparing against the real generator's
// output (instead of a second copy of the generation logic) is what makes
// this check trustworthy — a fork here previously drifted from codegen.js
// and reported every fresh file as stale.
const FILES = [
  { label: 'sqlite-full.sql', path: join(GENERATED_DIR, 'sqlite-full.sql'), generate: () => generateSqlite(schema, false) },
  { label: 'sqlite-sync.sql', path: join(GENERATED_DIR, 'sqlite-sync.sql'), generate: () => generateSqlite(schema, true) },
  { label: 'types.ts', path: join(GENERATED_DIR, 'types.ts'), generate: () => generateTypescript(schema, false) },
  { label: 'types.rs', path: join(GENERATED_DIR, 'types.rs'), generate: () => generateRust(schema, false) },
  { label: 'validate.js', path: join(GENERATED_DIR, 'validate.js'), generate: () => generateValidator(schema) },
];

function main() {
  console.log('[freshness] Checking if generated files are up-to-date...\n');

  let stale = false;

  for (const file of FILES) {
    if (!existsSync(file.path)) {
      console.error(`[freshness] ERROR: Missing generated file: ${file.label}`);
      console.error('[freshness] Run "yarn schema:codegen" to generate files');
      process.exit(1);
    }

    const current = readFileSync(file.path, 'utf-8');
    const fresh = file.generate();

    if (current !== fresh) {
      console.error(`[freshness] STALE: ${file.label}`);
      stale = true;
    } else {
      console.log(`[freshness] OK: ${file.label}`);
    }
  }

  console.log('');

  if (stale) {
    console.error('[freshness] Generated files are STALE');
    console.error('[freshness] Run "yarn schema:codegen" and commit the changes');
    process.exit(1);
  }

  console.log('[freshness] All generated files are up-to-date');
  process.exit(0);
}

main();
