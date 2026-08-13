#!/usr/bin/env node
/**
 * Platform-leak check — docs/design/window-manager.md §0, "The rules and the
 * machine are platform-neutral; every platform workaround lives behind the
 * port."
 *
 * Electron on macOS is ONE backend. `apps/tauri-desktop/` already exists and
 * more are intended, so nothing above the window port may name a platform's
 * method, carry its argument names, or encode the shape of its workarounds.
 * The machine says WHAT it intends; a backend decides which native calls
 * achieve it there, including how many. A leak is a build failure, not a
 * review comment.
 *
 * WHY MECHANICAL. This boundary is the kind that erodes one convenient
 * argument at a time, and each individual leak looks harmless in review — an
 * option threaded through "just for now", a vendor's word reused because it
 * was the word to hand. The cost only shows up at the second backend, when
 * every borrowed name has to be implemented or ignored. A grep that runs every
 * loop is the only form of this rule that survives.
 *
 * Mechanics, deliberately mechanical:
 *   - Scans the layers ABOVE the port (SCANNED below), not the whole tree.
 *     The backends and the composition root are exempt by construction: that
 *     is where platform detail is SUPPOSED to live.
 *   - Reuses `check-r2-window-ops.mjs`'s `stripNonCode`, so prose in comments
 *     and text in string literals never counts. Explaining a macOS hazard in a
 *     comment is correct and stays legal; typing its argument name in code
 *     does not.
 *   - Matches whole-word identifiers only, so a longer name that merely
 *     contains a banned word is not a hit.
 *
 * The allowlist only ever SHRINKS, same contract as the R2 check:
 *   - a hit not covered by an entry           -> FAIL (new leak)
 *   - an entry whose (file, token) matches 0x -> FAIL (stale — delete it)
 *   - actual count != recorded count          -> FAIL (growth is a leak;
 *     shrinkage must be recorded so the list provably shrinks)
 *
 * Usage: node scripts/check-platform-leak.mjs   (from repo root)
 * Exit 0 = clean, 1 = leaks/stale entries.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripNonCode } from './lib/strip-non-code.mjs';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAIN = 'apps/desktop/main';

/**
 * The layers above the port. Everything here must read the same whichever
 * backend is underneath it.
 *
 * NOT scanned, and deliberately so: `electron-window-backend.ts` (the Electron
 * backend — platform detail is its whole job), `window-os-adapter.ts` (the old
 * executor, which composes the Electron backend by default and is being
 * deleted), and every module that legitimately speaks to Electron directly
 * (`ipc.ts`, `main.ts`, `windows.ts`, the renderer, …). This check is about
 * the machine and its port, not about the app.
 */
const SCANNED = [
  `${MAIN}/window-kernel.ts`,
  `${MAIN}/window-kernel-executor.ts`,
  `${MAIN}/window-kernel-singleton.ts`,
  `${MAIN}/window-kernel-shadow.ts`,
  `${MAIN}/window-backend.ts`,
  `${MAIN}/window-escape.ts`,
  `${MAIN}/izui-roles.ts`,
];

/**
 * Vendor vocabulary that must not appear in code above the port.
 *
 * Each is an Electron API name, an Electron argument name, or Apple's word for
 * a concept the port should describe by intention instead. `Space`/`Spaces` is
 * Apple's name for a virtual desktop; the neutral question is whether a window
 * follows the user across desktops or belongs to the one it was opened on.
 */
const FORBIDDEN = [
  // Electron / AppKit type and API names
  'BrowserWindow',
  'BaseWindow',
  'WebContentsView',
  'webContents',
  'ipcMain',
  'ipcRenderer',
  'nativeTheme',
  'globalShortcut',
  'moveTop',
  'setVisibleOnAllWorkspaces',
  'setAlwaysOnTop',
  'setFullScreen',
  'showInactive',
  'orderFront',
  'NSPanel',
  'NSWorkspace',
  'LSUIElement',
  'performKeyEquivalent',
  // Electron argument names that only mean something to Electron
  'skipTransformProcessType',
  'visibleOnFullScreen',
  'transformProcessType',
  // Apple's word for a virtual desktop
  'Space',
  'Spaces',
];

/**
 * Recorded leaks, with the reason each is still here. Entries are keyed
 * file + token + count — symbol-anchored justifications, never line numbers,
 * which rot. This list only ever shrinks.
 */
const ALLOWLIST = [
  // (empty — every entry added here needs a justification and a plan)
];

function scanFile(rel) {
  const abs = path.join(REPO_ROOT, rel);
  let src;
  try {
    src = fs.readFileSync(abs, 'utf8');
  } catch {
    return { missing: true, hits: [] };
  }
  const code = stripNonCode(src);
  const hits = [];
  for (const token of FORBIDDEN) {
    // Whole-word only: a longer identifier that merely contains the token is
    // not a leak (`spacesPolicyForRole` is not `Spaces`).
    const re = new RegExp(`\\b${token}\\b`, 'g');
    const count = (code.match(re) ?? []).length;
    if (count > 0) hits.push({ token, count });
  }
  return { missing: false, hits };
}

function main() {
  const failures = [];
  const seen = new Map(); // "file\0token" -> count
  let scanned = 0;

  for (const rel of SCANNED) {
    const { missing, hits } = scanFile(rel);
    if (missing) {
      // A scanned file that no longer exists is a rename the list did not
      // follow — silently scanning nothing is exactly how this check would
      // rot into decoration.
      failures.push(`scanned file is missing (renamed or deleted?): ${rel}`);
      continue;
    }
    scanned += 1;
    for (const { token, count } of hits) seen.set(`${rel}\0${token}`, count);
  }

  // Every hit must be covered by an allowlist entry with a matching count.
  for (const [key, count] of seen) {
    const [file, token] = key.split('\0');
    const entry = ALLOWLIST.find((e) => e.file === file && e.token === token);
    if (!entry) {
      failures.push(
        `platform leak: ${file} uses \`${token}\` (${count}x) above the port. ` +
          `Move it into the backend, or describe the intention instead. ` +
          `See apps/desktop/CLAUDE.md -> "Electron is ONE backend, not the design".`,
      );
      continue;
    }
    if (entry.count !== count) {
      failures.push(
        `count changed: ${file} \`${token}\` recorded ${entry.count}x, found ${count}x. ` +
          `Growth is a new leak; a shrink must be recorded so the list provably shrinks.`,
      );
    }
  }

  // Stale entries: recorded but no longer present.
  for (const entry of ALLOWLIST) {
    if (!seen.has(`${entry.file}\0${entry.token}`)) {
      failures.push(`stale allowlist entry (matches nothing — delete it): ${entry.file} \`${entry.token}\``);
    }
  }

  if (failures.length > 0) {
    console.error('✖ platform-leak check failed:\n');
    for (const f of failures) console.error(`   ${f}`);
    console.error(
      `\n   ${SCANNED.length} files above the port scanned. The rule: ` +
        `docs/design/window-manager.md -> "0. The governing rule set".`,
    );
    process.exit(1);
  }

  console.log(`✔ platform-leak: ${scanned} files above the port scanned; no vendor vocabulary`);
  console.log(`   allowlisted leaks: ${ALLOWLIST.length} (should trend to zero)`);
}

main();
