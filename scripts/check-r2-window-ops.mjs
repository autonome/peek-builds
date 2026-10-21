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
 * Two op families, two allowlists, DIFFERENT semantics — see FORBIDDEN_WRITE /
 * WRITE_ALLOWLIST vs FORBIDDEN_READ / READ_ALLOWLIST. Write debt should trend
 * to zero; some read debt is permanent by design (a presenter at the registry
 * boundary must ask the OS what a window looks like). A non-empty allowlist is
 * therefore NOT by itself evidence of an unfinished migration — read the kinds.
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
// The comment/string stripper lives in its own side-effect-free module so
// `check-platform-leak.mjs` can share it. Importing it from THIS file would
// run this whole check as an invisible side effect of that import.
import { stripNonCode } from './lib/strip-non-code.mjs';

// Anchor to the repo root this script lives in (scripts/..), not the cwd —
// the check must scan the checkout it is part of no matter where it's run from.
const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCAN_ROOT = path.join(REPO_ROOT, 'apps/desktop/main');
const EXEMPT_FILE = 'apps/desktop/main/electron-window-backend.ts'; // the backend (R2 via the R3 port)

// The forbidden window-API call names that MUTATE a window, verbatim from
// window-manager.md §1 R2. `webContents.focus()` is covered by `focus`.
const FORBIDDEN_WRITE = [
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
  'setIgnoreMouseEvents',
  'setOpacity',
];

/**
 * Forbidden READ ops — deliberately a THREE-name shortlist, not full coverage.
 *
 * Reads matter to R2 because the machine is supposed to be the source of truth
 * for window facts: a module that asks the OS "is this focused / always-on-top
 * / focusable?" and BRANCHES on the answer has re-derived state the reducer
 * already owns, and will disagree with it. That blind spot (the write list had
 * no read ops at all) hid a real bug for the whole migration.
 *
 * Full read coverage measured out at ~360 calls across 32 files, overwhelmingly
 * `isDestroyed()` liveness guards with near-zero signal — a list that size
 * stops being read. These three are the highest-signal, lowest-noise subset:
 * each mirrors a fact the reducer tracks (front/focus, always-on-top, window
 * class), so a hit is worth a human look.
 *
 * DEFERRED ON PURPOSE — do not add without a reason that beats the noise:
 *   isDestroyed  — pure liveness guard; required at every port boundary and
 *                  in every setTimeout body (desktop CLAUDE.md rule). ~300 of
 *                  the ~360.
 *   isVisible, getBounds, getTitle, getURL — presentation snapshots read at
 *                  the registry/IPC boundary to ANSWER a query, not to decide
 *                  window behaviour; mostly co-located with the reads already
 *                  listed here, so those entries flag the same call sites.
 *   getFocusedWindow, fromId, fromWebContents — handle RESOLUTION, not state.
 *                  Legitimately permanent at the boundary where an OS object
 *                  must be turned into a machine id.
 */
const FORBIDDEN_READ = [
  'isFocused',
  'isAlwaysOnTop',
  'isFocusable',
];

const FORBIDDEN = [...FORBIDDEN_WRITE, ...FORBIDDEN_READ];
const READ_OPS = new Set(FORBIDDEN_READ);

/**
 * WRITE debt. Every entry is a CURRENT violation (or a non-window false
 * positive the mechanical pattern can't distinguish), individually justified.
 * DO NOT add entries to unblock new code — dispatch an event to the reducer
 * instead (window-manager.md §1 R2). When you remove a call site, update or
 * delete its entry in the same commit.
 *
 * This list SHOULD trend to zero (modulo the non-window false positives): a
 * module that mutates a window is by definition doing the executor's job. Read
 * debt is different — see READ_ALLOWLIST.
 *
 * { file, call, count, why }
 */
const WRITE_ALLOWLIST = [
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
  { file: 'apps/desktop/main/local-feature-watch.ts', call: 'close', count: 2,
    why: 'folder-watch handle close in LocalFeatureWatcher and fs.FSWatcher close in nodeFolderWatchPort — not a window' },
  { file: 'apps/desktop/main/hotreload.ts', call: 'close', count: 1,
    why: 'fs.FSWatcher close on hot-reload teardown — not a window' },
  { file: 'apps/desktop/main/oauth-loopback.ts', call: 'close', count: 1,
    why: 'http.Server close for the OAuth loopback listener — not a window' },
  { file: 'apps/desktop/main/session-partition.ts', call: 'show', count: 2,
    why: 'Notification.show for download complete/failed — OS notification, not a window' },
  { file: 'apps/desktop/main/tray.ts', call: 'destroy', count: 1,
    why: 'Tray.destroy on tray teardown — not a window' },
  { file: 'apps/desktop/main/nav-history.ts', call: 'restore', count: 1,
    why: 'webContents.navigationHistory.restore in the page-history restore path — loads saved back/forward entries into a page, not a window' },
  { file: 'apps/desktop/main/ipc.ts', call: 'setBounds', count: 1,
    why: 'WebContentsView content fill (assembleHybridPageHost fillView) — a child-view op inside the host, not a window op; every WINDOW setBounds in this file died in §5 step 7E (SET_BOUNDS_REQUESTED → reducer → port)' },
  { file: 'apps/desktop/main/hybrid-overlay.ts', call: 'setBounds', count: 5,
    why: 'NOT window ops (re-classified in the §5 step 9 cutover): 4× view.setBounds filling a WebContentsView inside a fake host + 1× the test-bridge setHostBounds, all inside installTestBridge (E2E_TEST only). The one production WINDOW setBounds died with frameBounds() — the overlay frame now rides OVERLAY_ATTACH_REQUESTED.frame / BOUNDS_CHANGED.overlayFrame into the reducer' },

  // ── Real, permanent exception: can't be a dispatch by construction ────────
  { file: 'apps/desktop/main/hybrid-overlay.ts', call: 'setIgnoreMouseEvents', count: 1,
    why: 'ensureOverlay sets the overlay click-through BEFORE registerTrustedBuiltinWindow — the window has no machine id yet, so a kernelSetAcceptsInput dispatch naming it would be rejected as unknown-window. Not scheduled to migrate: this ordering is deliberate, not pre-R2 debt' },

  // ── App/Dock-level surface, not per-window, but same API family ──────────
  { file: 'apps/desktop/main/headless-policy.ts', call: 'hide', count: 1,
    why: 'app.dock.hide under headless activation policy — Dock tile, not a window' },
  { file: 'apps/desktop/main/entry.ts', call: 'hide', count: 2,
    why: 'app.dock.hide (headless boot + LSUIElement path) — Dock tile, not a window' },
  { file: 'apps/desktop/main/windows.ts', call: 'show', count: 1,
    why: 'app.dock.show in applyDockPreference — Dock tile, not a window (the per-window show/showInactive seams route through the machine since §5 step 6A-2)' },
  { file: 'apps/desktop/main/windows.ts', call: 'hide', count: 1,
    why: 'app.dock.hide in applyDockPreference — Dock tile, not a window. app.hide (maybeHideApp) is GONE: stepping the app aside when nothing is left on screen is a react rule diffing holdsAppOnScreen, and app.hide() now sits behind the port as hideApp' },

  // ── Real pre-R2 violations: direct window ops awaiting migration ─────────
  // Each is scheduled by a window-manager.md §5 step; delete or decrement the
  // entry in the same commit that routes the call through the executor.
  // `apps/desktop/main/ipc.ts` `focus` is GONE (§5 step 9): the modal
  // blur-settle re-focus (win.on('blur') 200ms settle branch) now dispatches
  // RAISE_WINDOW_REQUESTED. Both reducer gates (appActive, satellite) may drop
  // it — a knowingly best-effort raise, documented at the dispatch site.
  // `apps/desktop/main/main.ts` `close` is GONE (§5 step 9): the
  // did-resign-active overlay-switcher close — the LAST direct window call in
  // step 9 — now rides APP_RESIGNED → CLOSE_SWITCHER_WINDOW(restoreFocus:false)
  // → the executor, which keeps the izui cooldown guards, the
  // exitOverlayForAppBlur() restore and the `__closedDueToAppBlur` stamp in
  // their original order on the resign EDGE.
  // `apps/desktop/main/windows.ts` `focus` is GONE (§5 step 8): showHybridHost's
  // contentWC.focus() — the content-focus half of the show invariant — now rides
  // the reducer's WINDOW_SHOW_REQUESTED arm as a FOCUS_CONTENT effect, so
  // windows.ts makes no direct window/WC call at all.
];

/**
 * READ debt — different semantics from WRITE_ALLOWLIST, so do NOT read a
 * non-empty list here as "the migration is unfinished."
 *
 * A read is only an R2 violation when its value feeds a BRANCH that decides
 * window behaviour: that duplicates the reducer's state and will drift from it.
 * A read whose value is merely REPORTED — a presentation snapshot, an IPC
 * response field, a metrics row, a test bridge — asks the OS a question and
 * hands the answer straight back out. Several of those are legitimately
 * PERMANENT: at the registry/IPC boundary the OS object IS the source of
 * truth for what it currently looks like.
 *
 * So each entry carries a `kind`:
 *   'reported'  — value flows out as data, no window decision. Accepted; may
 *                 stay forever. Listed so the check stays explicit and so a
 *                 new read in these files still trips NEW VIOLATION.
 *   'decision'  — value feeds a branch deciding window behaviour. A REAL R2
 *                 violation, tracked here until fixed. These reached ZERO on
 *                 2026-07-29 and must stay there: adding one back means a
 *                 module started re-deriving a fact the reducer owns.
 *
 * { file, call, count, kind, why }
 */
const READ_ALLOWLIST = [
  // ── Known R2 violations: OS read feeding a window decision ───────────────
  // EMPTY — decision-kind read debt is ZERO. Every remaining entry below is
  // kind:'reported'. A NEW decision-kind entry is a regression, not a TODO:
  // the fact belongs to the reducer, so plumb it from the request instead.
  //
  // (RETIRED 2026-07-29) apps/desktop/main/main.ts isAlwaysOnTop ×1 +
  // isFocusable ×2 — the inline registerWindow callback passed to
  // configureTileLauncher sniffed the live handle to feed
  // classifyWindowRegistration() and isSatelliteRegistration(). The
  // tile-launcher hook now carries the creation intent (TileWindowRegistration
  // { alwaysOnTop, focusable } — the resolved windowOptions the window was
  // constructed from, headless gate included), so the class and satellite-ness
  // come from the request that made the window.
  // (RETIRED 2026-07-29) apps/desktop/main/ipc.ts isFocused ×1 — the hybrid
  // content pointer-move handler in wireHybridContentEvents gated the
  // resize-hover cursor on contentWC.isFocused(). It now reads the machine's
  // WindowRecord.contentFocused (strict === true; absent = nothing reported
  // yet = no cursor), which mirrors that same webContents' native focus/blur.

  // ── Reported, not decided: value flows out as data ───────────────────────
  { file: 'apps/desktop/main/window-presenter.ts', call: 'isFocused', count: 2, kind: 'reported',
    why: 'the `focused` field of a WindowPresentation snapshot — getHybridPresentation (BaseWindow branch) + getLivePresentation (BrowserWindow branch). This module IS the registry-boundary presenter: its whole job is to answer "what does this window look like right now" for the windows feature/IPC. Nothing branches on the value. Permanent by design' },
  { file: 'apps/desktop/main/process-metrics.ts', call: 'isFocused', count: 2, kind: 'reported',
    why: 'the `focused` column of a per-webContents metrics row — the BrowserWindow.fromWebContents branch and the hybrid BaseWindow branch, both wrapped in safe(). Diagnostics output only; no window behaviour depends on it. Permanent by design' },
  { file: 'apps/desktop/main/tile-ipc.ts', call: 'isFocused', count: 1, kind: 'reported',
    why: 'the `focused` field of the tile:window:info response — reporting a window\'s current state back to a tile that asked. No branch' },
  { file: 'apps/desktop/main/tile-ipc.ts', call: 'isFocusable', count: 1, kind: 'reported',
    why: 'the last-resort candidate filter in tile:theme:setWindowColorScheme, reached only when neither an explicit windowId nor the machine front resolves (headless). It picks a THEME target, not window behaviour — nothing about show/focus/stacking changes. Weakest "reported" claim on this list: if the decision class ever widens, this is the first entry to re-examine (the machine already knows which windows are satellites)' },
  { file: 'apps/desktop/main/windows.ts', call: 'isFocused', count: 1, kind: 'reported',
    why: 'the `focused` field of the wmLog esc-input line in the before-input-event Escape handler — diagnostic output only (destroyed-guarded); the escape decision itself is taken downstream by the machine. No branch' },
  { file: 'apps/desktop/main/entry.ts', call: 'isFocused', count: 1, kind: 'reported',
    why: 'the Cmd+W ("Close Window") menu handler\'s DEVTOOLS guard: wc.isDevToolsOpened() && (wc.isDevToolsFocused() || !wc.isFocused()). A detached devtools window is not a machine window, so the machine cannot know it holds OS focus — this read exists precisely because the fact is outside the machine\'s model (isDevToolsFocused() alone returns false in Electron 40 when devtools is OS-focused, hence the !isFocused() half). Accepted: the target of the close is still resolved by the machine front, this only detects "the keystroke went to devtools"' },

  // ── Test-only observability (E2E bridge / _forTests exports) ─────────────
  { file: 'apps/desktop/main/hybrid-overlay.ts', call: 'isAlwaysOnTop', count: 1, kind: 'reported',
    why: '_getOverlayStateForTests() — reads the singleton overlay\'s alwaysOnTop for focus-free spec assertions. Test observability, not production behaviour' },
  { file: 'apps/desktop/main/hybrid-overlay.ts', call: 'isFocused', count: 2, kind: 'reported',
    why: 'installTestBridge (E2E_TEST only): hostVisibility() reports a hybrid host BaseWindow\'s focus (a BaseWindow is invisible to BrowserWindow.fromId, so the headless-no-focus-theft spec cannot read it any other way) and overlayFocus() reports the overlay\'s. Both are assertions ABOUT focus — reading the OS is the point' },
  { file: 'apps/desktop/main/hybrid-overlay.ts', call: 'isFocusable', count: 1, kind: 'reported',
    why: 'installTestBridge overlayFocus() — asserts the overlay stays focusable:true (click into the URL field can make it key) while never being focused on appearance. Test observability' },
];

const ALLOWLIST = [...WRITE_ALLOWLIST, ...READ_ALLOWLIST];

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

// Every read-debt entry must declare which kind it is — the whole point of the
// split is that a reader can tell accepted reporting from an unfixed violation.
for (const e of READ_ALLOWLIST) {
  if (e.kind !== 'decision' && e.kind !== 'reported') {
    console.error(`[r2-check] READ_ALLOWLIST entry needs kind:'decision'|'reported': ${allowKey(e.file, e.call)}`);
    process.exit(2);
  }
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
        (READ_OPS.has(call)
          ? `    This is a READ. If the value feeds a branch deciding window behaviour,\n` +
            `    read machine state instead — the reducer owns this fact and yours will drift.\n` +
            `    If it is only reported outward, add a READ_ALLOWLIST entry (kind:'reported').`
          : `    Dispatch an event to the reducer instead.`) +
        `\n    (docs/design/window-manager.md §1 R2)`
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

const sum = (list) => list.reduce((s, e) => s + e.count, 0);
const readDecision = READ_ALLOWLIST.filter((e) => e.kind === 'decision');
const readReported = READ_ALLOWLIST.filter((e) => e.kind === 'reported');
console.log(
  `✔ r2-window-ops: ${files.length} main-process files scanned; 1 exempt executor\n` +
  `   write debt: ${WRITE_ALLOWLIST.length} entries / ${sum(WRITE_ALLOWLIST)} calls (should trend to zero)\n` +
  `   read debt:  ${READ_ALLOWLIST.length} entries / ${sum(READ_ALLOWLIST)} calls — ` +
  `${readDecision.length}/${sum(readDecision)} decision (real violations — must stay zero), ` +
  `${readReported.length}/${sum(readReported)} reported (accepted, may be permanent)`
);
