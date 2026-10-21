#!/usr/bin/env node
/**
 * Test-honesty lint — catch "lying" unit tests.
 *
 * A lying test passes (and inflates the coverage count) without exercising the
 * real product code, so a regression in the shipping code can't make it fail.
 * Two historical examples (peek task 54aad964) reimplemented the install
 * algorithm inline / asserted on their own mock fetch, importing no product
 * code — and pointed at the obsolete backend/electron/ tree.
 *
 * This catches the cheap-to-detect failure mode: a unit test that does not
 * import any product module. (The other mode — imports the real module then
 * mocks the unit under test — is only reliably caught by demonstrating the test
 * red→green, i.e. failing-first; this lint does not attempt that.)
 *
 * Checks, per unit-test source file:
 *   1. Must import >=1 PRODUCT module — a relative import to a non-test,
 *      non-fixture/mock file, or a `@peek/*` workspace package. Escape hatch:
 *      a `// @no-product-import: <reason>` line (reason required) skips this,
 *      for genuine pure-data tests — the reason is reviewable in the diff.
 *   2. Must NOT import a known-dead path (e.g. backend/electron/).
 *
 * Scope: UNIT suites only — main/<*>.test.ts and tests/unit/<*>.test.js.
 * Playwright specs (tests/desktop, components, editor, ...) drive the running
 * app through a harness and legitimately import no product modules, so they are
 * out of scope by design.
 *
 * Usage: node scripts/lint-test-honesty.mjs [root ...]
 * Exit 0 = clean, 1 = violations (paths + reasons printed), 2 = bad invocation
 * (including a scan root that is missing or holds no test files — scanning
 * nothing must not read as a pass).
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DEFAULT_ROOTS = ['apps/desktop/main', 'apps/desktop/tests/unit'];
const TEST_FILE_RE = /\.test\.(ts|cts|mts|js|cjs|mjs)$/;
const DEAD_PATH_SEGMENTS = ['backend/electron/', 'backend/electron'];

// --changed [baseRef]: lint only test files added/modified vs baseRef (default
// "main"). Lets the check gate NEW/touched tests without a retroactive cleanup
// of pre-existing offenders. Falls back to a full scan if git can't resolve a
// diff (so it never silently passes everything in a non-git context).
const rawArgs = process.argv.slice(2);
let changedBase = null;
const roots = [];
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === '--changed') {
    const next = rawArgs[i + 1];
    if (next && !next.startsWith('--')) { changedBase = next; i++; }
    else { changedBase = 'main'; }
  } else if (!a.startsWith('--')) {
    roots.push(a);
  }
}
const scanRoots = roots.length ? roots : DEFAULT_ROOTS;

/** Test files changed vs baseRef, restricted to scanRoots; null if undecidable. */
function changedTestFiles(baseRef) {
  let base;
  try {
    base = execFileSync('git', ['merge-base', 'HEAD', baseRef], { encoding: 'utf-8' }).trim();
  } catch {
    return null; // base ref not resolvable (e.g. fresh clone) → caller full-scans
  }
  let out;
  try {
    out = execFileSync('git', ['diff', '--name-only', '--diff-filter=AMR', `${base}...HEAD`], { encoding: 'utf-8' });
  } catch {
    return null;
  }
  return out.split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    .filter(f => TEST_FILE_RE.test(f))
    .filter(f => scanRoots.some(r => f.startsWith(r.replace(/\/$/, '') + '/')))
    .filter(f => fs.existsSync(f));
}

/** Recursively collect *.test.* files under a directory. */
function collectTestFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // unreadable subdirectory → nothing from it; roots are checked separately
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      out.push(...collectTestFiles(full));
    } else if (TEST_FILE_RE.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Collect the test files under every scan root, refusing to scan nothing.
 * A root that is missing, or that holds no test file at all, almost always
 * means the lint was invoked from the wrong directory or with a stale path —
 * which used to print the success line having checked zero files.
 */
function collectAllTestFiles(rootList) {
  const missing = [];
  const empty = [];
  const files = [];
  for (const root of rootList) {
    if (!fs.existsSync(root)) { missing.push(root); continue; }
    const found = collectTestFiles(root);
    if (!found.length) { empty.push(root); continue; }
    files.push(...found);
  }
  if (missing.length || empty.length) {
    console.error('\n✖ test-honesty lint could not scan what it was asked to scan:\n');
    for (const root of missing) console.error(`  ${root}\n    → scan root does not exist`);
    for (const root of empty) console.error(`  ${root}\n    → scan root contains no test files`);
    console.error(`\nResolved relative to the current directory: ${process.cwd()}` +
      '\nRun from the repo root, or pass the roots to scan as arguments.\n');
    process.exit(2);
  }
  return files;
}

/** Extract every static import/require/dynamic-import specifier string. */
function extractSpecifiers(src) {
  const specs = [];
  const patterns = [
    /\bimport\s+[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g, // import x from '...'
    /\bexport\s+[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g, // export ... from '...'
    /\bimport\s*['"]([^'"]+)['"]/g,                 // import '...'
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,      // require('...')
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,       // import('...')
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src)) !== null) specs.push(m[1]);
  }
  return specs;
}

/**
 * Does the file reach real product code through a NON-static-import channel?
 * Two legitimate patterns in this codebase's node-unit suites:
 *   - dynamic import / require of a computed path:
 *       `await import(modulePath)`, `require(p)`, `import(`${dir}/x.js`)`
 *     (load a real module via a computed path into features/renderer, or to
 *      dodge Electron-at-module-load)
 *   - source-invariant guard tests that read product SOURCE and assert on it:
 *       `readFileSync(join(MAIN_DIR, 'entry.ts'))`
 * Either counts as exercising product. Both can in principle be gamed by
 * pointing at a fixture, but that is rare and still visible in review.
 */
function hasDynamicProductAccess(src) {
  // import(X) / require(X) where X does not begin with a quote (non-literal).
  if (/\b(?:import|require)\s*\(\s*[^'")\s]/.test(src)) return true;
  // readFile(Sync)(X) where X is a non-literal computed path.
  if (/\bread(?:File|FileSync)\s*\(\s*[^'")\s]/.test(src)) return true;
  return false;
}

/** Is this specifier an import of real product code? */
function isProductSpecifier(spec) {
  // Workspace packages are product code.
  if (spec.startsWith('@peek/')) return true;
  // Only relative imports can be local product modules.
  if (!spec.startsWith('.')) return false;
  const base = path.basename(spec).replace(TEST_FILE_RE, '').toLowerCase();
  // Exclude test helpers / fixtures / mocks — importing only these is suspect.
  if (/\.test$/.test(base)) return false;
  if (/(fixture|fixtures|mock|mocks|stub|stubs)/.test(base)) return false;
  if (/(^|\/)(helpers|test-utils|__mocks__|__fixtures__)(\/|$)/.test(spec)) return false;
  return true;
}

const violations = [];

// Check the roots in either mode: a missing or test-free root means the
// invocation is wrong, not that the tree is clean.
const allFiles = collectAllTestFiles(scanRoots);

// Build the file list: changed-only (when --changed and git can resolve it),
// else a full scan of the roots.
let files = null;
if (changedBase) {
  files = changedTestFiles(changedBase);
  if (files === null) {
    // Undecidable diff (e.g. base ref absent). Skip rather than full-scan —
    // a full scan here would (correctly) fail on pre-existing legacy offenders
    // and break whatever gate invoked --changed, which is not the intent.
    console.warn(`[test-honesty] --changed: could not diff vs "${changedBase}"; skipping (run without --changed for a full report)`);
    process.exit(0);
  }
  if (files.length === 0) {
    console.log(`✔ test-honesty: no added/modified test files vs ${changedBase}`);
    process.exit(0);
  }
} else {
  files = allFiles;
}

{
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf-8');

    // Check 2: dead import paths (applies regardless of escape hatch).
    const specs = extractSpecifiers(src);
    for (const spec of specs) {
      if (DEAD_PATH_SEGMENTS.some(seg => spec.includes(seg))) {
        violations.push({ file, reason: `imports a dead path: "${spec}" (obsolete tree)` });
      }
    }

    // Escape hatch for check 1.
    const hatch = src.match(/\/\/\s*@no-product-import:\s*(\S.*)/);
    if (hatch) continue;

    // Check 1: must exercise >=1 product module — static import, a non-literal
    // dynamic import, or a source-invariant guard reading product source.
    if (!specs.some(isProductSpecifier) && !hasDynamicProductAccess(src)) {
      violations.push({
        file,
        reason: 'imports no product code — a test that exercises no shipping module can\'t catch a regression in it',
      });
    }
  }
}

if (violations.length) {
  console.error('\n✖ test-honesty lint failed — these unit tests do not exercise real product code:\n');
  for (const v of violations) {
    console.error(`  ${v.file}\n    → ${v.reason}`);
  }
  console.error(
    '\nFix by importing and exercising the real module(s) under test (not an inline copy or a self-asserting mock).' +
    '\nIf a test legitimately needs no product import (e.g. pure data), add a line:' +
    '\n    // @no-product-import: <why>\n'
  );
  process.exit(1);
}

console.log(`✔ test-honesty: ${scanRoots.join(', ')} — all unit tests import product code`);
