#!/usr/bin/env node
/**
 * Window-lookup check — specs/kernel-desktops.md section 4 "Queries" and
 * "Enforcement": code outside the kernel never chooses among windows itself.
 * It finds candidates by its own criterion (URL, key, extension page) and the
 * kernel answers which one serves the request here (`reusableHere`, through
 * `window-machine.ts pickReusableHere`) or which window the user is looking at
 * (`frontWindowHere`). A choice made outside the kernel is how an action lands
 * on a window on a desktop the user is not on.
 *
 * Mechanics:
 *   - Scans every non-test module in `apps/desktop/main` except the kernel
 *     itself and the files that define the finders.
 *   - Counts calls to the listed lookups (LOOKUPS below) in code, with
 *     comments and strings stripped (`lib/strip-non-code.mjs`).
 *   - A call whose statement hands the result to `pickReusableHere(` on the
 *     same line, or whose result variable is handed to it on one of the next
 *     three lines, is a routed lookup and does not count.
 *
 * The allowlist only ever SHRINKS, same contract as the platform-leak check:
 *   - a call not covered by an entry            -> FAIL (a new choice)
 *   - an entry whose (file, name) matches 0x    -> FAIL (stale — delete it)
 *   - actual count != recorded count            -> FAIL (a shrink must be recorded)
 *
 * Usage: node scripts/check-window-lookups.mjs   (from repo root)
 * Exit 0 = clean, 1 = unrouted lookups or stale entries.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripNonCode } from './lib/strip-non-code.mjs';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAIN = 'apps/desktop/main';

// The registry finders and the kernel's raw order scan.
const LOOKUPS = ['topmost', 'findHybridWindowsByUrl', 'findHybridWindowsByKey', 'findWindowsByKey', 'findWindowsByUrl'];

// The kernel, and the modules that define a finder (its definition is not a call).
const EXEMPT = new Set([`${MAIN}/window-kernel.ts`, `${MAIN}/hybrid-page-host-registry.ts`]);

/**
 * Recorded lookups that identify a window rather than choose one to act on,
 * with the reason each stays. Keyed file + name + count, never line numbers.
 */
const ALLOWLIST = [
  {
    file: `${MAIN}/window-escape.ts`,
    name: 'topmost',
    count: 3,
    reason:
      'switcherWindow finds the switcher, the no-key-holder branch of resolveEscapeTarget finds the ' +
      'Escape-closable transient (transients end on a desktop switch), and interpretEscape asks ' +
      'whether any window is fullscreen; none chooses a window to raise.',
  },
  {
    file: `${MAIN}/session.ts`,
    name: 'topmost',
    count: 1,
    reason: 'readKernelOrderFacts records which content window was frontmost for a session save; it acts on nothing.',
  },
];

function isTestFile(rel) {
  return rel.endsWith('.test.ts');
}

function scanFile(rel) {
  const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
  const lines = stripNonCode(src).split('\n');
  const counts = new Map();
  lines.forEach((line, i) => {
    for (const name of LOOKUPS) {
      const re = new RegExp(`(?<![\\w.])${name}\\(`, 'g');
      const hits = line.match(re)?.length ?? 0;
      if (hits === 0) continue;
      if (/\bfunction\s/.test(line)) continue; // a definition, not a call
      if (line.includes('pickReusableHere(')) continue;
      const assigned = line.match(/\b(?:const|let|var)\s+(\w+)\s*=/)?.[1];
      const routedLater =
        assigned !== undefined &&
        lines.slice(i + 1, i + 4).some((next) => next.includes(`pickReusableHere(${assigned}`));
      if (routedLater) continue;
      counts.set(name, (counts.get(name) ?? 0) + hits);
    }
  });
  return counts;
}

function main() {
  const failures = [];
  const seen = new Map(); // "file\0name" -> count
  const files = fs
    .readdirSync(path.join(REPO_ROOT, MAIN))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `${MAIN}/${f}`)
    .filter((rel) => !isTestFile(rel) && !EXEMPT.has(rel));

  for (const rel of files) {
    for (const [name, count] of scanFile(rel)) seen.set(`${rel}\0${name}`, count);
  }

  for (const [key, count] of seen) {
    const [file, name] = key.split('\0');
    const entry = ALLOWLIST.find((e) => e.file === file && e.name === name);
    if (!entry) {
      failures.push(
        `unrouted window lookup: ${file} calls \`${name}\` (${count}x) outside the kernel. ` +
          `Hand the candidates to pickReusableHere, or ask frontWindowHere for the window the user is looking at.`,
      );
      continue;
    }
    if (entry.count !== count) {
      failures.push(
        `count changed: ${file} \`${name}\` recorded ${entry.count}x, found ${count}x. ` +
          `Growth is a new choice outside the kernel; a shrink must be recorded so the list provably shrinks.`,
      );
    }
  }

  for (const entry of ALLOWLIST) {
    if (!seen.has(`${entry.file}\0${entry.name}`)) {
      failures.push(`stale allowlist entry (matches nothing — delete it): ${entry.file} \`${entry.name}\``);
    }
  }

  if (failures.length > 0) {
    console.error('✖ window-lookup check failed:\n');
    for (const f of failures) console.error(`   ${f}`);
    console.error(`\n   ${files.length} main-process files scanned. The rule: specs/kernel-desktops.md section 4 "Queries".`);
    process.exit(1);
  }
  const allowed = ALLOWLIST.reduce((n, e) => n + e.count, 0);
  console.log(`✔ window-lookups: ${files.length} main-process files scanned; every lookup routed through the kernel`);
  console.log(`   allowlisted lookups: ${ALLOWLIST.length} entries / ${allowed} calls (should trend to zero)`);
}

main();
