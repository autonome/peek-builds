#!/usr/bin/env node
/**
 * R2 enforcement check — docs/design/window-manager.md §1 R2, §5 step 3.
 *
 * "ONE executor performs OS window operations." Exactly one module may call
 * a window API: since the port landed (§5 step 2) that is the backend
 * implementation, apps/desktop/main/electron-window-backend.ts — the executor
 * (window-os-adapter.ts) now issues platform-free port commands and is
 * scanned like everything else. Everything else dispatches an event and lets
 * the reducer decide. A violation is a build failure, not a review comment.
 *
 * Mechanics (deliberately mechanical, not a type checker):
 *   - Scans main-process source: apps/desktop/main/**\/*.ts, *.cts, *.js and
 *     *.mjs — the desktop tsconfig's compile scope plus plain-JS modules
 *     shipped alongside it (e.g. chrome-api-polyfills/*.js). Skips *.test.*
 *     (test stubs are not shipping window ops) and *.d.ts (declarations,
 *     not calls).
 *   - Strips comments, string/template-literal contents (code inside `${...}`
 *     interpolations is kept), and regex-literal contents first, so prose and
 *     HTML payloads don't count as calls. Regex literals are recognized by the
 *     standard prev-significant-char heuristic (a `/` after an operator or
 *     opening bracket starts a regex; after an identifier/`)`/`]` it is
 *     division) — good enough mechanically, not a full JS lexer.
 *   - Matches method-call syntax `.<name>(` (incl. `?.` / `!.`) for the
 *     forbidden names below. Receiver type is NOT checked — a hit that is
 *     genuinely not a window op (a db `.close()`, a socket `.destroy()`)
 *     goes on the allowlist with a justification, same as a real violation.
 *
 * The allowlist below only ever SHRINKS:
 *   - a hit not covered by an entry           → FAIL (new violation)
 *   - an entry whose (file, call) matches 0×  → FAIL (stale — delete it)
 *   - actual count != recorded count          → FAIL (growth is a violation;
 *     shrinkage must be recorded so the list provably shrinks)
 *
 * Entries are keyed file + call name + count (symbol-anchored justifications,
 * no line numbers — they rot).
 *
 * Usage: node scripts/check-r2-window-ops.mjs   (from repo root)
 * Exit 0 = clean, 1 = violations/stale entries, 2 = bad invocation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Anchor to the repo root this script lives in (scripts/..), not the cwd —
// the check must scan the checkout it is part of no matter where it's run from.
const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCAN_ROOT = path.join(REPO_ROOT, 'apps/desktop/main');
const EXEMPT_FILE = 'apps/desktop/main/electron-window-backend.ts'; // the backend (R2 via the R3 port)

// The forbidden window-API call names, verbatim from window-manager.md §1 R2.
// `webContents.focus()` is covered by `focus`.
const FORBIDDEN = [
  'focus',
  'show',
  'showInactive',
  'hide',
  'close',
  'destroy',
  'setBounds',
  'moveTop',
  'setAlwaysOnTop',
  'setFullScreen',
  'setVisibleOnAllWorkspaces',
  'maximize',
  'unmaximize',
  'minimize',
  'restore',
  'blur',
  'setSkipTaskbar',
];

/**
 * The shrinking allowlist. Every entry is a CURRENT violation (or a
 * non-window false positive the mechanical pattern can't distinguish),
 * individually justified. DO NOT add entries to unblock new code — dispatch
 * an event to the reducer instead (window-manager.md §1 R2). When you remove
 * a call site, update or delete its entry in the same commit.
 *
 * { file, call, count, why }
 */
const ALLOWLIST = [
  // ── Not window ops: same method NAME on a non-window receiver ────────────
  // The mechanical pattern cannot see receiver types; these are listed so the
  // check stays explicit instead of the pattern getting clever.
  { file: 'apps/desktop/main/cli-socket.ts', call: 'destroy', count: 1,
    why: 'net.Socket probe teardown in the stale-socket check — not a window' },
  { file: 'apps/desktop/main/cli-socket.ts', call: 'close', count: 2,
    why: 'net.Server close in stopCliServer — not a window' },
  { file: 'apps/desktop/main/datastore.ts', call: 'close', count: 1,
    why: 'better-sqlite3 Database close in closeDatastore — not a window' },
  { file: 'apps/desktop/main/profiles.ts', call: 'close', count: 1,
    why: 'better-sqlite3 profiles DB close — not a window' },
  { file: 'apps/desktop/main/entry.ts', call: 'close', count: 1,
    why: 'early-boot sqlite handle close (earlyDb) — not a window' },
  { file: 'apps/desktop/main/hotreload.ts', call: 'close', count: 1,
    why: 'fs.FSWatcher close on hot-reload teardown — not a window' },
  { file: 'apps/desktop/main/oauth-loopback.ts', call: 'close', count: 1,
    why: 'http.Server close for the OAuth loopback listener — not a window' },
  { file: 'apps/desktop/main/session-partition.ts', call: 'show', count: 2,
    why: 'Notification.show for download complete/failed — OS notification, not a window' },
  { file: 'apps/desktop/main/tray.ts', call: 'destroy', count: 1,
    why: 'Tray.destroy on tray teardown — not a window' },
  { file: 'apps/desktop/main/ipc.ts', call: 'setBounds', count: 1,
    why: 'WebContentsView content fill (assembleHybridPageHost fillView) — a child-view op inside the host, not a window op; every WINDOW setBounds in this file died in §5 step 7E (SET_BOUNDS_REQUESTED → reducer → port)' },
  { file: 'apps/desktop/main/hybrid-overlay.ts', call: 'setBounds', count: 5,
    why: 'NOT window ops (re-classified in the §5 step 9 cutover): 4× view.setBounds filling a WebContentsView inside a fake host + 1× the test-bridge setHostBounds, all inside installTestBridge (E2E_TEST only). The one production WINDOW setBounds died with frameBounds() — the overlay frame now rides OVERLAY_ATTACH_REQUESTED.frame / BOUNDS_CHANGED.overlayFrame into the reducer' },

  // ── App/Dock-level surface, not per-window, but same API family ──────────
  { file: 'apps/desktop/main/headless-policy.ts', call: 'hide', count: 1,
    why: 'app.dock.hide under headless activation policy — Dock tile, not a window' },
  { file: 'apps/desktop/main/entry.ts', call: 'hide', count: 2,
    why: 'app.dock.hide (headless boot + LSUIElement path) — Dock tile, not a window' },
  { file: 'apps/desktop/main/windows.ts', call: 'show', count: 1,
    why: 'app.dock.show in applyDockPreference — Dock tile, not a window (the per-window show/showInactive seams route through the machine since §5 step 6A-2)' },
  { file: 'apps/desktop/main/windows.ts', call: 'hide', count: 2,
    why: 'app-level ONLY: app.hide (maybeHideApp) + app.dock.hide (applyDockPreference) — APP-level operations outside the window-backend port scope by design (§5 step 6B); the decision input (visible-window count) is machine state, no isVisible() polling' },

  // ── Real pre-R2 violations: direct window ops awaiting migration ─────────
  // Each is scheduled by a window-manager.md §5 step; delete or decrement the
  // entry in the same commit that routes the call through the executor.
  { file: 'apps/desktop/main/ipc.ts', call: 'focus', count: 1,
    why: 'modal blur-settle re-focus (win.on(\'blur\') 200ms settle branch) — focus rivals, §5 step 8; the devtools-opened first-responder restore that used to share this entry is gone (§5 step 9 — DEVTOOLS_OPENED now owns it)' },
  { file: 'apps/desktop/main/main.ts', call: 'close', count: 1,
    why: 'close overlay switcher when app loses OS focus (did-resign-active) — §5 step 9' },
  { file: 'apps/desktop/main/windows.ts', call: 'focus', count: 1,
    why: 'showHybridHost\'s contentWC.focus() (content-focus half of the show invariant) — focus rivals, §5 step 8; the winDevtoolsConfig bw/webContents re-focus pair that used to share this entry is gone (§5 step 9 — DEVTOOLS_OPENED now owns it)' },
];

// ---------------------------------------------------------------------------

/** Recursively collect scan files under a directory. */
function collectFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      out.push(...collectFiles(full));
    } else if (/\.(ts|cts|js|mjs)$/.test(e.name)) {
      if (/\.test\.(ts|cts|js|mjs)$/.test(e.name)) continue;
      if (/\.d\.(ts|cts)$/.test(e.name)) continue;
      out.push(full);
    }
  }
  return out;
}

/**
 * Can a `/` at this point start a regex literal (vs. be a division operator)?
 * Heuristic: after an operator / opening bracket / separator (or at file
 * start) a regex can start; after an identifier char, `)` or `]` it is
 * division. Known residual blind spot: `return /re/` (prev char is a letter)
 * reads as division, leaving the regex body unstripped.
 */
function regexCanStart(prevSig) {
  if (prevSig === '') return true;
  return '([{=,:;!&|?+-*%^~<>'.includes(prevSig);
}

/**
 * Blank out comments, string/template contents and regex-literal contents,
 * preserving offsets (replaced chars become spaces) and code inside `${...}`
 * interpolations.
 */
function stripNonCode(src) {
  const n = src.length;
  const out = src.split('');
  let state = 'code';
  const braceDepths = []; // one depth counter per nested template interpolation
  let prevSig = ''; // last significant (non-whitespace) code char, for the regex-vs-division call
  let inClass = false; // inside a regex [...] character class
  for (let i = 0; i < n; i++) {
    const c = src[i];
    const d = i + 1 < n ? src[i + 1] : '';
    switch (state) {
      case 'code':
        if (c === '/' && d === '/') { state = 'line'; out[i] = ' '; }
        else if (c === '/' && d === '*') { state = 'block'; out[i] = ' '; }
        else if (c === '/' && regexCanStart(prevSig)) { state = 'regex'; inClass = false; out[i] = ' '; }
        else if (c === "'") { state = 'single'; out[i] = ' '; }
        else if (c === '"') { state = 'double'; out[i] = ' '; }
        else if (c === '`') { state = 'template'; out[i] = ' '; }
        else if (c === '{' && braceDepths.length) { braceDepths[braceDepths.length - 1]++; }
        else if (c === '}' && braceDepths.length) {
          if (braceDepths[braceDepths.length - 1] === 0) {
            braceDepths.pop();
            state = 'template';
            out[i] = ' ';
          } else {
            braceDepths[braceDepths.length - 1]--;
          }
        }
        if (state === 'code' && !/\s/.test(c)) prevSig = c;
        break;
      case 'regex':
        if (c === '\\') { out[i] = ' '; if (d) { out[i + 1] = ' '; i++; } }
        else if (c === '[') { inClass = true; out[i] = ' '; }
        else if (c === ']') { inClass = false; out[i] = ' '; }
        else if (c === '/' && !inClass) { state = 'code'; out[i] = ' '; prevSig = ')'; /* regex value ~ operand */ }
        else if (c === '\n') { state = 'code'; /* not a regex after all (unterminated) — resync */ }
        else out[i] = ' ';
        break;
      case 'line':
        if (c === '\n') state = 'code';
        else out[i] = ' ';
        break;
      case 'block':
        if (c === '*' && d === '/') { state = 'code'; out[i] = ' '; out[i + 1] = ' '; i++; }
        else if (c !== '\n') out[i] = ' ';
        break;
      case 'single':
        if (c === '\\') { out[i] = ' '; if (d) { out[i + 1] = ' '; i++; } }
        else if (c === "'") { state = 'code'; out[i] = ' '; }
        else if (c !== '\n') out[i] = ' ';
        break;
      case 'double':
        if (c === '\\') { out[i] = ' '; if (d) { out[i + 1] = ' '; i++; } }
        else if (c === '"') { state = 'code'; out[i] = ' '; }
        else if (c !== '\n') out[i] = ' ';
        break;
      case 'template':
        if (c === '\\') { out[i] = ' '; if (d) { out[i + 1] = ' '; i++; } }
        else if (c === '$' && d === '{') {
          braceDepths.push(0);
          state = 'code';
          out[i] = ' ';
          out[i + 1] = ' ';
          i++;
        }
        else if (c === '`') { state = 'code'; out[i] = ' '; }
        else if (c !== '\n') out[i] = ' ';
        break;
    }
  }
  return out.join('');
}

// Longest-first so `showInactive` never half-matches as `show`.
const namesAlt = [...FORBIDDEN].sort((a, b) => b.length - a.length).join('|');
const CALL_RE = new RegExp(`\\.\\s*(${namesAlt})\\s*\\(`, 'g');

/** Count forbidden calls in one file. Returns Map<callName, count>. */
function scanFile(file) {
  const stripped = stripNonCode(fs.readFileSync(file, 'utf-8'));
  const counts = new Map();
  let m;
  CALL_RE.lastIndex = 0;
  while ((m = CALL_RE.exec(stripped)) !== null) {
    counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  return counts;
}

// ---------------------------------------------------------------------------

if (!fs.existsSync(SCAN_ROOT)) {
  console.error(`[r2-check] scan root not found: ${SCAN_ROOT}`);
  process.exit(2);
}

const files = collectFiles(SCAN_ROOT).sort();

// actual[file -> Map<call, count>], keyed by repo-root-relative posix path
const actual = new Map();
for (const file of files) {
  const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
  if (rel === EXEMPT_FILE) continue;
  const counts = scanFile(file);
  if (counts.size) actual.set(rel, counts);
}

const allowKey = (file, call) => `${file} :: ${call}`;
const allowed = new Map();
for (const e of ALLOWLIST) {
  const key = allowKey(e.file, e.call);
  if (allowed.has(key)) {
    console.error(`[r2-check] duplicate allowlist entry: ${key}`);
    process.exit(2);
  }
  allowed.set(key, e);
}

const failures = [];

// 1. Every actual hit must be covered by an entry with the exact count.
for (const [file, counts] of actual) {
  for (const [call, count] of counts) {
    const entry = allowed.get(allowKey(file, call));
    if (!entry) {
      failures.push(
        `NEW VIOLATION  ${file} — .${call}( ×${count}\n` +
        `    R2: only the executor (${EXEMPT_FILE}) may call window APIs.\n` +
        `    Dispatch an event to the reducer instead (docs/design/window-manager.md §1 R2).`
      );
    } else if (entry.count !== count) {
      const direction = count > entry.count ? 'GREW' : 'SHRANK';
      failures.push(
        `COUNT ${direction}  ${file} — .${call}( allowlisted ×${entry.count}, found ×${count}\n` +
        (count > entry.count
          ? `    Growth is a new violation — remove the new call site (dispatch an event instead).`
          : `    Good — now record it: update the entry's count to ${count} (or delete the entry at 0) so the list provably shrinks.`)
      );
    }
  }
}

// 2. Every allowlist entry must still match something (stale entries must go).
for (const e of ALLOWLIST) {
  const counts = actual.get(e.file);
  if (!counts || !counts.has(e.call)) {
    failures.push(
      `STALE ENTRY  ${e.file} — .${e.call}( matches nothing\n` +
      `    The call site is gone. Delete this allowlist entry — the list only shrinks.`
    );
  }
}

if (failures.length) {
  console.error('\n✖ R2 window-op check failed (docs/design/window-manager.md §1 R2):\n');
  for (const f of failures) console.error(`  ${f}\n`);
  console.error(
    `Rule: exactly ONE file may perform OS window operations — ${EXEMPT_FILE}.\n` +
    `Everything else dispatches an event; the reducer decides. The allowlist in\n` +
    `scripts/check-r2-window-ops.mjs only ever shrinks.\n`
  );
  process.exit(1);
}

const totalAllowed = ALLOWLIST.reduce((s, e) => s + e.count, 0);
console.log(
  `✔ r2-window-ops: ${files.length} main-process files scanned; ` +
  `1 exempt executor; ${ALLOWLIST.length} allowlisted legacy entries (${totalAllowed} calls, shrinking)`
);
