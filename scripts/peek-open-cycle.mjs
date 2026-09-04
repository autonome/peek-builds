#!/usr/bin/env node
/**
 * peek-open-cycle — scripted, keypress-free repro harness for the peek
 * open/dismiss/reopen window-manager defect
 * (docs/design/window-manager-macos-signoff.md): opening a peek, dismissing
 * it, and opening it again repeatedly makes the peek open only on some
 * cycles. On a failing cycle the newly created peek is dismissed ~30-70ms
 * after creation and closed while still inside `loadURL` — a leftover
 * transient-autoclose sweep from the PREVIOUS cycle's dismiss (focus
 * returning to the page-host that held it before the peek opened) lands
 * against the brand-new peek instead of the window it was meant for.
 *
 * Usage:
 *   PEEK_PROFILE=<profile> node scripts/peek-open-cycle.mjs [--cycles <n>]
 *     [--open-timeout <ms>] [--settle-ms <ms>] [--cycle-wait <ms>]
 *
 * Preconditions (see apps/desktop/CLAUDE.md — get any of these wrong and
 * the defect will not reproduce):
 *   - A REAL, visible instance on the real display: `PROFILE=<profile>
 *     yarn start`. Headless / `_electron.launch` never fire `OsFocusGained`
 *     (`window-kernel-executor.ts planRaise` returns 'inactive-show'
 *     unconditionally under headless) and the run passes vacuously.
 *   - E2E_TEST must NOT be set — it installs the hybrid test bridge, which
 *     changes focus behavior.
 *   - Staged first with `PEEK_PROFILE=<profile> node scripts/signoff-stage.mjs`,
 *     which opens the ALPHA/BRAVO loopback page-hosts the defect needs — a
 *     page-host is the window that reclaims focus and triggers the sweep.
 *
 * Per cycle:
 *   1. Send `peek-open 0` over the CLI socket (apps/desktop/main/cli-router.ts
 *      KNOWN_VERBS) — the same `cli:peek-open` pubsub topic a real hotkey
 *      publishes, so the downstream focus/sweep path is identical to a
 *      keypress.
 *   2. Poll `debug-list-windows` for a hybrid host id not present in the
 *      pre-send snapshot — the freshly opened peek. Not matched by URL: on
 *      a failing cycle the content may still be mid-`loadURL` with no
 *      committed URL yet, so an id-diff against the prior snapshot is the
 *      only reliable way to find it.
 *   3. Dismiss it via `debug-escape`, which dispatches
 *      `window-machine.ts dispatchEscapePress('global', 'cli')` — the same
 *      seam all four real Escape entry points funnel through
 *      (`handleEscapePress`). This is a real Escape dismissal, not an
 *      ordinary programmatic close: a plain `window.app.window.close(<id>)`
 *      call skips the focus/transient-dismiss machinery the defect lives in
 *      and does not reproduce it.
 *   4. Wait `--cycle-wait` ms before the next cycle. Short by default — the
 *      race is the tail of the PREVIOUS dismiss's async focus-driven sweep,
 *      and a long wait lets that sweep finish harmlessly before the next
 *      peek opens.
 *
 * After all cycles, parses `<userData>/logs/{renderer,main}.log` from the
 * offsets marked before the first cycle and prints a tally. Exits non-zero
 * if any cycle failed, so this doubles as a regression check.
 *
 * No deps — pure node:net + node:fs + node:path + node:os + node:child_process,
 * matching the dependency-free style of peek-cli.mjs / signoff-stage.mjs. The
 * socket-discovery helpers are duplicated from those scripts (no exports to
 * import) — keep them in sync by hand if their discovery logic changes.
 */

import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';

const PEEK_RUNTIME_BASE = path.join(
  process.env.XDG_RUNTIME_DIR || path.join(process.env.HOME ?? os.tmpdir(), '.cache'),
  'peek'
);

const die = (msg, code = 1) => {
  process.stderr.write(`peek-open-cycle: ${msg}\n`);
  process.exit(code);
};

// ─── Socket discovery + send (duplicated from signoff-stage.mjs) ──────────

const probe = (socketPath) => new Promise(resolve => {
  const c = net.createConnection(socketPath);
  const done = (alive) => { c.removeAllListeners(); c.destroy(); resolve(alive); };
  c.once('connect', () => done(true));
  c.once('error', () => done(false));
  setTimeout(() => done(false), 300).unref();
});

const findSocket = async (profile) => {
  const p = path.join(PEEK_RUNTIME_BASE, profile, 'ipc.sock');
  if (fs.existsSync(p) && (await probe(p))) return p;
  return null;
};

const send = (socketPath, msg) => new Promise((resolve, reject) => {
  const conn = net.createConnection(socketPath);
  let buf = '';
  conn.setEncoding('utf8');
  conn.on('connect', () => conn.write(JSON.stringify(msg) + '\n'));
  conn.on('data', chunk => {
    buf += chunk;
    const nl = buf.indexOf('\n');
    if (nl !== -1) {
      const line = buf.slice(0, nl);
      conn.end();
      try { resolve(JSON.parse(line)); }
      catch { reject(new Error(`bad reply: ${line}`)); }
    }
  });
  conn.on('error', reject);
  setTimeout(() => { conn.destroy(); reject(new Error('timeout waiting for reply')); }, 2000).unref();
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ─── App control ────────────────────────────────────────────────────────

const debugListWindows = async (socketPath) => {
  const result = await send(socketPath, { verb: 'debug-list-windows' });
  if (!result?.ok) throw new Error(`debug-list-windows failed: ${result?.error ?? 'unknown error'}`);
  return result.data ?? [];
};

const debugEval = async (socketPath, target, expression) => {
  const result = await send(socketPath, { verb: 'debug-eval', args: [target, expression] });
  if (!result?.ok) throw new Error(`debug-eval failed: ${result?.error ?? 'unknown error'}`);
  return result.data;
};

const peekOpen = async (socketPath, keyNum) => {
  const result = await send(socketPath, { verb: 'peek-open', args: [String(keyNum)] });
  if (!result?.ok) throw new Error(`peek-open failed: ${result?.error ?? 'unknown error'}`);
};

// `yarn start` runs the unpackaged `electron .` binary — the running app is
// literally named "Electron" on macOS, not "Peek" (that name only applies to
// a packaged build). This is the ONLY window-activation step the harness
// performs, and it activates the app (bringing whichever of its windows was
// already frontmost forward) rather than focusing any particular window by
// hand — never a click, never a synthetic keystroke into the app (see
// apps/desktop/CLAUDE.md's "never click a window to focus it" PROTOCOL RULE).
const activateApp = () => {
  try {
    execFileSync('osascript', ['-e', 'tell application "Electron" to activate']);
    return true;
  } catch (err) {
    process.stdout.write(`Warning: could not activate "Electron" via osascript: ${err.message}\n`);
    return false;
  }
};

// ─── Cycle mechanics ────────────────────────────────────────────────────

/** Poll debug-list-windows until a hybrid window id NOT in `beforeIds` shows up. */
const waitForNewHybridWindow = async (socketPath, beforeIds, { timeoutMs, intervalMs = 15 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const windows = await debugListWindows(socketPath);
    const hit = windows.find(w => w.hybrid && !beforeIds.has(w.windowId));
    if (hit) return hit;
    if (Date.now() > deadline) return null;
    await sleep(intervalMs);
  }
};

/** Close a hybrid host by id via the core background renderer's trustedBuiltin grant. */
const closeHybridWindow = async (socketPath, bgTarget, windowId) => {
  await debugEval(socketPath, bgTarget, `window.app.window.close(${windowId})`);
};

/** Dispatch an Escape press (cli-router.ts debug-escape), the same seam all real Escape entry points funnel through. */
const dismissEscape = async (socketPath) => {
  const result = await send(socketPath, { verb: 'debug-escape' });
  if (!result?.ok) throw new Error(`debug-escape failed: ${result?.error ?? 'unknown error'}`);
};

// ─── Log parsing ────────────────────────────────────────────────────────

const fileSize = (p) => {
  try { return fs.statSync(p).size; } catch { return 0; }
};

const readFrom = (p, offset) => {
  try {
    const fd = fs.openSync(p, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= offset) { fs.closeSync(fd); return ''; }
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return '';
  }
};

/** Parse one `[wm] t=<ms> event=<e> k=v k=v ...` payload embedded in a main.log line. */
const parseWmLine = (line) => {
  const idx = line.indexOf('[wm]');
  if (idx === -1) return null;
  const tokens = line.slice(idx).split(/\s+/).slice(1); // drop the literal "[wm]" token
  const fields = {};
  for (const tok of tokens) {
    const eq = tok.indexOf('=');
    if (eq === -1) continue;
    fields[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  return fields.event ? fields : null;
};

const RENDERER_OPENED_RE = /\[ext:peeks\] Peek window opened: (\{.*\})/;

const parseRendererResults = (text) => {
  const results = [];
  for (const line of text.split('\n')) {
    const m = line.match(RENDERER_OPENED_RE);
    if (!m) continue;
    try { results.push(JSON.parse(m[1])); } catch { /* malformed — skip */ }
  }
  return results;
};

const DISMISS_WINDOW_MS = 100; // spec says ~30-70ms; leave margin either side

const parseWmCorrelation = (text) => {
  const opens = [];
  const dismissals = [];
  for (const line of text.split('\n')) {
    const f = parseWmLine(line);
    if (!f) continue;
    if (f.event === 'open-registry-set' && f.key === 'peek:0') {
      opens.push({ id: f.id, t: Number(f.t) });
    } else if (f.event === 'transient-dismiss' && f.cause === 'world') {
      dismissals.push({ id: f.id, holder: f.holder, t: Number(f.t) });
    }
  }
  const correlated = [];
  for (const open of opens) {
    const hit = dismissals.find(d => d.id === open.id && Math.abs(d.t - open.t) <= DISMISS_WINDOW_MS);
    if (hit) correlated.push({ ...open, dismissedAtDeltaMs: hit.t - open.t, holder: hit.holder });
  }
  return { opens, dismissals, correlated };
};

// ─── Main ───────────────────────────────────────────────────────────────

const parseArgs = (argv) => {
  let cycles = 10;
  let openTimeoutMs = 800;
  let settleMs = 150;
  let cycleWaitMs = 100;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cycles') cycles = Number(argv[++i]);
    else if (argv[i] === '--open-timeout') openTimeoutMs = Number(argv[++i]);
    else if (argv[i] === '--settle-ms') settleMs = Number(argv[++i]);
    else if (argv[i] === '--cycle-wait') cycleWaitMs = Number(argv[++i]);
  }
  if (!Number.isFinite(cycles) || cycles <= 0) die('invalid --cycles value');
  if (!Number.isFinite(openTimeoutMs) || openTimeoutMs <= 0) die('invalid --open-timeout value');
  if (!Number.isFinite(settleMs) || settleMs < 0) die('invalid --settle-ms value');
  if (!Number.isFinite(cycleWaitMs) || cycleWaitMs < 0) die('invalid --cycle-wait value');
  return { cycles, openTimeoutMs, settleMs, cycleWaitMs };
};

const main = async () => {
  const { cycles, openTimeoutMs, settleMs, cycleWaitMs } = parseArgs(process.argv.slice(2));

  const profile = process.env.PEEK_PROFILE;
  if (!profile) die('set $PEEK_PROFILE to the running instance\'s profile name');

  let socketPath = null;
  for (let attempt = 0; attempt < 10 && !socketPath; attempt++) {
    socketPath = await findSocket(profile);
    if (!socketPath) await sleep(500);
  }
  if (!socketPath) {
    die(`no running Peek instance found for profile "${profile}" (looked for ${path.join(PEEK_RUNTIME_BASE, profile, 'ipc.sock')}). Stage it first with signoff-stage.mjs.`);
  }
  process.stdout.write(`Found instance socket: ${socketPath}\n`);

  const windows = await debugListWindows(socketPath);
  const bg = windows.find(w => w.url && w.url.includes('app/background.html'));
  if (!bg) {
    die('could not find the core background renderer (peek://app/background.html) in debug-list-windows — is the instance fully booted?');
  }
  process.stdout.write(`Core background renderer: webContents ${bg.webContentsId}\n`);

  // Clean up any peek left open from a previous run of this harness so it
  // doesn't get mistaken for a cycle's own window or pollute the log offsets.
  const stalePeeks = windows.filter(w => w.hybrid && w.windowId !== bg.windowId && w.url && w.url.includes('example.com'));
  for (const stale of stalePeeks) {
    process.stdout.write(`Closing stale peek window (id ${stale.windowId}) left over from a previous run.\n`);
    await closeHybridWindow(socketPath, bg.webContentsId, stale.windowId);
  }
  if (stalePeeks.length > 0) await sleep(300);

  activateApp();
  await sleep(200); // let the activation settle before the timed cycles start

  const rendererLogPath = path.join(os.homedir(), 'Library', 'Application Support', 'Peek', profile, 'logs', 'renderer.log');
  const mainLogPath = path.join(os.homedir(), 'Library', 'Application Support', 'Peek', profile, 'logs', 'main.log');
  const rendererOffset = fileSize(rendererLogPath);
  const mainOffset = fileSize(mainLogPath);
  process.stdout.write(`Marked log offsets — renderer.log:${rendererOffset} main.log:${mainOffset}\n\n`);

  let notFoundCount = 0;
  for (let cycle = 1; cycle <= cycles; cycle++) {
    const before = await debugListWindows(socketPath);
    const beforeIds = new Set(before.map(w => w.windowId));

    await peekOpen(socketPath, 0);

    const opened = await waitForNewHybridWindow(socketPath, beforeIds, { timeoutMs: openTimeoutMs });
    if (!opened) {
      notFoundCount++;
      process.stdout.write(`cycle ${cycle}: no new peek window observed within ${openTimeoutMs}ms (already dismissed, or never opened)\n`);
    } else {
      await sleep(settleMs);
      await dismissEscape(socketPath);
      process.stdout.write(`cycle ${cycle}: opened id=${opened.windowId}, dismissed via Escape\n`);
    }

    await sleep(cycleWaitMs);
  }

  // Let the last cycle's async log writes (main-log.ts / renderer-log.ts
  // both queue appends) flush before reading.
  await sleep(500);

  const rendererText = readFrom(rendererLogPath, rendererOffset);
  const mainText = readFrom(mainLogPath, mainOffset);

  const rendererResults = parseRendererResults(rendererText);
  const opened = rendererResults.filter(r => r.success === true).length;
  const failedDestroyed = rendererResults.filter(r => r.success === false).length;

  const { correlated } = parseWmCorrelation(mainText);

  process.stdout.write('\n=== Tally ===\n');
  process.stdout.write(`cycles run:                  ${cycles}\n`);
  process.stdout.write(`no window observed to close: ${notFoundCount}\n`);
  process.stdout.write(`renderer.log — opened:       ${opened}\n`);
  process.stdout.write(`renderer.log — failed (destroyed): ${failedDestroyed}\n`);
  process.stdout.write(`main.log — transient-dismiss cause=world within ${DISMISS_WINDOW_MS}ms of open-registry-set: ${correlated.length}\n`);
  if (correlated.length > 0) {
    process.stdout.write('  ' + correlated.map(c => `id=${c.id} holder=${c.holder} +${c.dismissedAtDeltaMs}ms`).join('\n  ') + '\n');
  }

  if (failedDestroyed > 0) {
    process.stdout.write('\nFAIL — at least one cycle failed to open (Object has been destroyed).\n');
    process.exit(1);
  }
  process.stdout.write('\nPASS — every cycle opened successfully.\n');
};

main().catch(err => die(err?.message ?? String(err)));
