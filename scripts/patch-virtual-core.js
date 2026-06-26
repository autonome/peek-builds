#!/usr/bin/env node
/**
 * Patch @tanstack/virtual-core for the peek:// renderer environment.
 *
 * The virtual-core ESM bundle references process.env.NODE_ENV, but peek://
 * renderer processes have no `process` global. This script copies the three
 * ESM source files into apps/desktop/renderer/lib/virtual-core/ with every
 * process.env.NODE_ENV occurrence replaced by the string "production".
 *
 * Idempotent — safe to re-run on every build. Run after tsc and
 * patch-chrome-extensions in the desktop build script.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC  = path.join(ROOT, 'node_modules', '@tanstack', 'virtual-core', 'dist', 'esm');
const OUT  = path.join(ROOT, 'apps', 'desktop', 'renderer', 'lib', 'virtual-core');

const PATTERN     = /process\.env\.NODE_ENV/g;
const REPLACEMENT = '"production"';
const MARKER      = '/* peek:patched-process-env */\n';

// Only the three files the virtual-core ESM entry-point depends on.
const FILES = ['index.js', 'utils.js', 'lazy-measurements.js'];

fs.mkdirSync(OUT, { recursive: true });

let totalReplacements = 0;

for (const file of FILES) {
  const src = path.join(SRC, file);
  const dst = path.join(OUT, file);

  let content = fs.readFileSync(src, 'utf8');

  // Strip idempotency marker so multiple runs don't double-prepend it.
  content = content.replace(MARKER, '');

  const hits = (content.match(PATTERN) ?? []).length;
  content    = content.replace(PATTERN, REPLACEMENT);

  fs.writeFileSync(dst, MARKER + content, 'utf8');

  if (hits > 0) {
    console.log(`[patch-virtual-core] ${file}: replaced ${hits} occurrence(s) of process.env.NODE_ENV`);
  } else {
    console.log(`[patch-virtual-core] ${file}: no process.env.NODE_ENV references (copied as-is)`);
  }
  totalReplacements += hits;
}

console.log(`[patch-virtual-core] done — ${totalReplacements} replacement(s) across ${FILES.length} files`);
