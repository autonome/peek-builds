#!/usr/bin/env node
/**
 * live-check — launch one worktree's own Electron build for a live check, and
 * watch it from its first second through one event log.
 *
 * Usage:
 *   node scripts/live-check.mjs start <worktree> [--visible] [--profile <name>]
 *                                     [--watch '<cmd>']... [--all]
 *   node scripts/live-check.mjs status [<worktree>]
 *   node scripts/live-check.mjs stop <worktree>
 *   node scripts/live-check.mjs log-path <worktree>
 *
 * `start` checks the worktree can be launched, then hands off to a detached
 * supervisor and returns once Electron has been spawned. The supervisor:
 *   - launches <worktree>/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
 *     (Linux: <worktree>/node_modules/electron/dist/electron) with the worktree
 *     root as the app path, PROFILE=PEEK_PROFILE=<profile> (default: the
 *     worktree directory's basename), TMPDIR=<worktree>/.tmp, and
 *     PEEK_HEADLESS=1 unless --visible;
 *   - writes one event stream to <worktree>/.tmp/live-check/events.log:
 *     lifecycle events (launched, ready, exited, relaunched, stopped), the
 *     launch's stdout/stderr and the profile's main.log filtered to lines that
 *     look like errors (--all passes everything), and every line any --watch
 *     command prints;
 *   - with --visible --relaunch, relaunches the app whenever it quits, until
 *     `stop`; otherwise an exit ends the check.
 *   Unfiltered stdout/stderr go to electron.out.log beside the event log.
 *
 * Startup risk notice: the app shows it until the installation has an
 * acknowledgment recorded. This script never records one. A headless `start`
 * with no record is refused; a `--visible` start lets the person at the machine
 * accept it, and the supervisor then follows the copy the app restarts itself
 * as, rather than ending the check at the first copy's exit.
 *
 * `stop` kills only processes whose command line contains this worktree's
 * absolute Electron.app path — never /Applications/Peek.app or another
 * checkout — and confirms none are left.
 *
 * The event log is meant for `tail -F` (e.g. a Claude Code Monitor), so each
 * error shows up as it happens.
 *
 * Refusals, all before anything is launched: the app path's package.json has
 * no "main", or the file it names is not built (Electron's default app would
 * show a focus-taking "Error launching app" dialog that PEEK_HEADLESS cannot
 * suppress); the worktree has no Electron binary; a check is already running
 * for the worktree; that worktree's Electron is already running.
 *
 * No dependencies beyond node: and the repo's own scripts/peek-cli.mjs, which
 * the supervisor polls (debug-list-windows) to report readiness.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, execFileSync, execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_SCRIPTS = path.dirname(SCRIPT_PATH);

// Entries (a line plus its indented continuation lines) from stdout/stderr and
// main.log that make it into the event stream.
const ERROR_PATTERN =
  /\[error\]|\berror\b|exception|uncaught|unhandled|fatal|crash|\bfailed\b|ENOENT|EACCES|TypeError|ReferenceError|SyntaxError|RangeError/i;

// Known noise: matches ERROR_PATTERN on every launch and means nothing for a
// check. Tested against a whole entry, continuation lines included.
const NOISE_PATTERNS = [
  // Electron lacks Chrome's webRequest extension bindings; every extension
  // that asks for them logs this, as a native multi-line "Extension Error".
  /No source for require\(webRequest/,
  /NOTREACHED.*"webRequest(Event)?" not found/,
  /exception_ports/,
  // The chrome-extension bridge reports routine startup at error level.
  /\[peek:bridge:(preload|page)\] (loaded for |on\w+ listener registered|bridge initialized|\[relay\] peek-relay initialized|chrome\.runtime\.connect\(\) opened port)/,
  // It also traces every message it relays, and each clean port reconnect,
  // at error level.
  /\[peek:bridge:(preload|page)\] (forward received reqId=|onForward reqId=|port\.postMessage dispatched reqId=|port\.onMessage reqId=|port\.onMessage: no pending reqId= undefined|port disconnected \(clean, will reconnect\)|scheduling reconnect attempt \d+|reconnect attempt \d+(?![^\n]*(fail|error|gave up)))/i,
  /\[DEP0040\] DeprecationWarning: The `punycode` module/,
  // Proton Pass's manifest asks for permissions Electron doesn't know.
  /^[^\n]*ExtensionLoadWarning: Warnings loading extension at [^\n]*(\n\s+Permission '[^']+' is unknown\.)+\s*$/,
  /\[feature-startup\] Loaded \d+ features, 0 skipped\/failed/,
  // Session timing lines carry "failed=<n>"; only a non-zero count matters.
  /\[session:perf\] (?![^\n]*failed=[1-9])/,
];

// A stdout/stderr entry is held this long before it is judged, so that the
// copy main-log.ts mirrors into main.log can be seen first and the entry
// dropped as a duplicate.
const DEDUPE_DELAY_MS = 1_500;
// An entry ends when no continuation line has arrived for this long.
const ENTRY_IDLE_MS = 200;

const READY_POLL_MS = 500;
const READY_TIMEOUT_MS = 60_000;
const LOG_POLL_MS = 250;
const KILL_GRACE_MS = 5_000;

// ── Paths ────────────────────────────────────────────────────────────────────

function resolveWorktree(arg) {
  const p = path.resolve(arg ?? process.cwd());
  if (!fs.existsSync(p)) die(`no such directory: ${p}`);
  return fs.realpathSync(p);
}

function stateDir(worktree) {
  return path.join(worktree, '.tmp', 'live-check');
}

function eventLogPath(worktree) {
  return path.join(stateDir(worktree), 'events.log');
}

function electronAppDir(worktree) {
  return process.platform === 'darwin'
    ? path.join(worktree, 'node_modules', 'electron', 'dist', 'Electron.app')
    : path.join(worktree, 'node_modules', 'electron', 'dist');
}

function electronBinary(worktree) {
  return process.platform === 'darwin'
    ? path.join(electronAppDir(worktree), 'Contents', 'MacOS', 'Electron')
    : path.join(electronAppDir(worktree), 'electron');
}

function userDataBase() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Peek');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Peek');
}

/**
 * Whether the installation's startup risk acknowledgment is recorded, judged by
 * the worktree's own built validation rules. This only ever READS the record:
 * a check never writes consent on anyone's behalf.
 */
async function acknowledgmentRecorded(worktree) {
  const moduleFile = path.join(worktree, 'apps', 'desktop', 'dist', 'main', 'startup-consent.js');
  if (!fs.existsSync(moduleFile)) return false;
  const consent = await import(pathToFileURL(moduleFile).href);
  return consent.readAcceptanceRecordSync(userDataBase()) !== null;
}

function mainLogPath(profile) {
  return path.join(userDataBase(), profile, 'logs', 'main.log');
}

// ── Small helpers ────────────────────────────────────────────────────────────

function die(msg, code = 1) {
  process.stderr.write(`live-check: ${msg}\n`);
  process.exit(code);
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function readPid(file) {
  try {
    const n = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * PIDs of every process whose command line contains this worktree's absolute
 * Electron path. The Electron.app directory (macOS) also covers its helper
 * processes, which live inside it. The path is absolute, so the primary
 * checkout, other worktrees and /Applications/Peek.app never match.
 */
function worktreeElectronPids(worktree) {
  const pattern = escapeRegex(electronAppDir(worktree) + path.sep);
  try {
    const out = execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
    return out
      .split('\n')
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n) && n !== process.pid);
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

async function killWorktreeElectron(worktree) {
  let pids = worktreeElectronPids(worktree);
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  const deadline = Date.now() + KILL_GRACE_MS;
  while (Date.now() < deadline) {
    pids = worktreeElectronPids(worktree);
    if (pids.length === 0) return [];
    await sleep(200);
  }
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  await sleep(500);
  return worktreeElectronPids(worktree);
}

// ── Pre-launch checks ────────────────────────────────────────────────────────

/** Returns null when the worktree can be launched, else the reason it can't. */
function launchRefusal(worktree) {
  const pkgPath = path.join(worktree, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return `${worktree} has no package.json — Electron's default app would show an "Error launching app" dialog. Pass the worktree root, not apps/desktop.`;
  }
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (err) {
    return `${pkgPath} is not valid JSON: ${err.message}`;
  }
  if (!pkg.main) {
    return `${pkgPath} has no "main" — Electron's default app would show an "Error launching app" dialog. Pass the worktree root, not apps/desktop.`;
  }
  const mainFile = path.join(worktree, pkg.main);
  if (!fs.existsSync(mainFile)) {
    return `${pkg.main} is not built in ${worktree} — run \`yarn --cwd ${worktree} workspace @peek/desktop build\` first.`;
  }
  if (!fs.existsSync(electronBinary(worktree))) {
    return `no Electron binary at ${electronBinary(worktree)} — run \`node node_modules/electron/install.js\` in the worktree.`;
  }
  return null;
}

// ── Commands ─────────────────────────────────────────────────────────────────

function parseStartArgs(argv) {
  const opts = { worktree: null, visible: false, relaunch: false, profile: null, watches: [], all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--visible') opts.visible = true;
    else if (a === '--relaunch') opts.relaunch = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--profile') opts.profile = argv[++i];
    else if (a === '--watch') opts.watches.push(argv[++i]);
    else if (a.startsWith('--')) die(`unknown option ${a}`, 2);
    else if (!opts.worktree) opts.worktree = a;
    else die(`unexpected argument ${a}`, 2);
  }
  if (!opts.worktree) die('start needs a worktree path', 2);
  opts.worktree = resolveWorktree(opts.worktree);
  opts.profile ||= path.basename(opts.worktree);
  return opts;
}

async function cmdStart(argv) {
  const opts = parseStartArgs(argv);
  const { worktree } = opts;

  const refusal = launchRefusal(worktree);
  if (refusal) die(`refused: ${refusal}`);

  // The app shows a startup risk notice until the installation has recorded an
  // acknowledgment. A headless launch has nobody to read it, and this script
  // never records consent for anyone, so that launch is blocked.
  const acknowledged = await acknowledgmentRecorded(worktree);
  if (!acknowledged && !opts.visible) {
    die(
      `refused: headless launch is blocked: no startup risk acknowledgment is recorded in ${userDataBase()}. ` +
        'Run once with --visible and have the person at the machine accept the notice.'
    );
  }

  const dir = stateDir(worktree);
  const supPid = readPid(path.join(dir, 'supervisor.pid'));
  if (isAlive(supPid)) die(`refused: a check is already running for ${worktree} (supervisor pid ${supPid}); stop it first.`);
  const running = worktreeElectronPids(worktree);
  if (running.length) die(`refused: this worktree's Electron is already running (pids ${running.join(' ')}); stop it first.`);

  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(worktree, '.tmp'), { recursive: true });
  fs.writeFileSync(eventLogPath(worktree), '');
  fs.writeFileSync(path.join(dir, 'options.json'), JSON.stringify(opts, null, 2));

  const child = spawn(process.execPath, [SCRIPT_PATH, 'supervise', worktree], {
    detached: true,
    stdio: 'ignore',
    cwd: worktree,
  });
  child.unref();

  // Wait for the supervisor to report the launch (or an early failure).
  const log = eventLogPath(worktree);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const text = fs.readFileSync(log, 'utf8');
    if (/\[lifecycle\] (launched|launch-failed)/.test(text)) {
      process.stdout.write(text);
      process.stdout.write(`event log: ${log}\n`);
      if (/launch-failed/.test(text)) process.exit(1);
      return;
    }
    await sleep(100);
  }
  die(`supervisor did not report a launch within 15s; see ${log}`);
}

async function cmdStatus(argv) {
  const worktree = resolveWorktree(argv[0]);
  const dir = stateDir(worktree);
  const supPid = readPid(path.join(dir, 'supervisor.pid'));
  const elPid = readPid(path.join(dir, 'electron.pid'));
  const pids = worktreeElectronPids(worktree);
  let opts = {};
  try { opts = JSON.parse(fs.readFileSync(path.join(dir, 'options.json'), 'utf8')); } catch { /* none */ }
  process.stdout.write(
    [
      `worktree:    ${worktree}`,
      `supervisor:  ${isAlive(supPid) ? `running (pid ${supPid})` : 'not running'}`,
      `app:         ${isAlive(elPid) ? `running (pid ${elPid})` : 'not running'}`,
      `mode:        ${opts.visible ? 'visible' : 'headless'}${opts.profile ? `, profile ${opts.profile}` : ''}`,
      `processes:   ${pids.length ? pids.join(' ') : 'none'} (anything under this worktree's Electron)`,
      `event log:   ${eventLogPath(worktree)}`,
    ].join('\n') + '\n'
  );
}

async function cmdStop(argv) {
  const worktree = resolveWorktree(argv[0]);
  const dir = stateDir(worktree);
  const supPid = readPid(path.join(dir, 'supervisor.pid'));
  if (isAlive(supPid)) {
    process.kill(supPid, 'SIGTERM');
    const deadline = Date.now() + KILL_GRACE_MS + DEDUPE_DELAY_MS + 8_000;
    while (isAlive(supPid) && Date.now() < deadline) await sleep(200);
    if (isAlive(supPid)) process.kill(supPid, 'SIGKILL');
  }
  // Belt and braces: the supervisor already does this, but it may have died.
  const left = await killWorktreeElectron(worktree);
  if (left.length) die(`processes still running after SIGKILL: ${left.join(' ')}`);
  process.stdout.write(`stopped: no process of ${electronAppDir(worktree)} is left\n`);
}

// ── Supervisor ───────────────────────────────────────────────────────────────

async function supervise(worktree) {
  const dir = stateDir(worktree);
  const opts = JSON.parse(fs.readFileSync(path.join(dir, 'options.json'), 'utf8'));
  const eventLog = fs.openSync(eventLogPath(worktree), 'a');
  const rawLog = fs.openSync(path.join(dir, 'electron.out.log'), 'a');
  fs.writeFileSync(path.join(dir, 'supervisor.pid'), String(process.pid));

  const emit = (source, msg) => {
    for (const line of String(msg).split('\n')) {
      fs.writeSync(eventLog, `${new Date().toISOString()} [${source}] ${line}\n`);
    }
  };
  const matters = (text) =>
    opts.all || (ERROR_PATTERN.test(text) && !NOISE_PATTERNS.some((re) => re.test(text)));

  // Message bodies main.log has carried recently (body -> time seen), so a
  // stdout/stderr entry that main-log.ts also mirrored is reported once.
  const recentMainLogBodies = new Map();
  const rememberMainLogBody = (body) => {
    const now = Date.now();
    recentMainLogBodies.set(body, now);
    for (const [b, t] of recentMainLogBodies) {
      if (now - t > 10 * DEDUPE_DELAY_MS) recentMainLogBodies.delete(b);
      else break; // Map keeps insertion order; the rest are newer
    }
  };

  let stopping = false;
  let electron = null;
  let generation = 0;
  const watchers = [];

  // Line splitter for a stream; calls onLine for each complete line.
  const lines = (stream, onLine) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    stream.on('end', () => { if (buf) onLine(buf); });
  };

  // ── main.log tail ──
  const mainLog = mainLogPath(opts.profile);
  let mainLogOffset = 0;
  try { mainLogOffset = fs.statSync(mainLog).size; } catch { /* not created yet */ }
  let mainLogPartial = '';
  let mainLogEntry = [];
  const MAIN_LOG_HEADER = /^\d{4}-\d\d-\d\dT[\d:.]+Z \[\w+\] main (.*)$/;
  const flushMainLogEntry = () => {
    if (!mainLogEntry.length) return;
    const entry = mainLogEntry;
    mainLogEntry = [];
    const m = MAIN_LOG_HEADER.exec(entry[0]);
    if (m) rememberMainLogBody(m[1]);
    const text = entry.join('\n');
    if (matters(text)) emit('main.log', text.trimEnd());
  };
  const handleMainLogLine = (line) => {
    // main-log.ts writes "<ISO ts> [level] main <message>"; a multi-line
    // message (a stack, a warning's detail) continues on lines without a
    // timestamp, and is judged together with its first line.
    if (MAIN_LOG_HEADER.test(line)) flushMainLogEntry();
    mainLogEntry.push(line);
  };
  const tailTimer = setInterval(() => {
    let size;
    try { size = fs.statSync(mainLog).size; } catch { return; }
    if (size < mainLogOffset) { mainLogOffset = 0; mainLogPartial = ''; } // rotated
    if (size === mainLogOffset) return;
    const fd = fs.openSync(mainLog, 'r');
    const buf = Buffer.alloc(size - mainLogOffset);
    fs.readSync(fd, buf, 0, buf.length, mainLogOffset);
    fs.closeSync(fd);
    mainLogOffset = size;
    const text = mainLogPartial + buf.toString('utf8');
    const parts = text.split('\n');
    mainLogPartial = parts.pop();
    for (const l of parts) handleMainLogLine(l);
    // main-log.ts appends each message whole, so a read that ends on a line
    // boundary ends an entry.
    if (!mainLogPartial) flushMainLogEntry();
  }, LOG_POLL_MS);

  // ── watchers ──
  opts.watches.forEach((cmd, i) => {
    const name = `watch:${i + 1}`;
    const w = spawn('/bin/sh', ['-c', cmd], {
      cwd: worktree,
      detached: true, // own process group, so stop can kill the whole pipeline
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PEEK_PROFILE: opts.profile },
    });
    watchers.push(w);
    emit('lifecycle', `${name} started pid=${w.pid}: ${cmd}`);
    lines(w.stdout, (l) => emit(name, l));
    lines(w.stderr, (l) => emit(name, l));
    w.on('exit', (code, signal) => {
      if (!stopping) emit('lifecycle', `${name} exited code=${code} signal=${signal}`);
    });
  });

  // ── readiness ──
  const pollReady = async (gen) => {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (!stopping && gen === generation && Date.now() < deadline) {
      const out = await new Promise((resolve) => {
        execFile(
          process.execPath,
          [path.join(REPO_SCRIPTS, 'peek-cli.mjs'), 'debug-list-windows'],
          { env: { ...process.env, PEEK_PROFILE: opts.profile }, timeout: 5_000 },
          (_err, stdout) => resolve(stdout || '')
        );
      });
      if (out.includes('webContentsId')) {
        const count = (out.match(/webContentsId/g) || []).length;
        emit('lifecycle', `ready (${count} webContents listed by peek-cli debug-list-windows)`);
        return;
      }
      await sleep(READY_POLL_MS);
    }
    if (!stopping && gen === generation) {
      emit('lifecycle', `not ready after ${READY_TIMEOUT_MS / 1000}s (peek-cli debug-list-windows listed nothing)`);
    }
  };

  // ── launch / relaunch ──
  const env = {
    ...process.env,
    PROFILE: opts.profile,
    PEEK_PROFILE: opts.profile,
    TMPDIR: path.join(worktree, '.tmp'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  if (opts.visible) delete env.PEEK_HEADLESS;
  else env.PEEK_HEADLESS = '1';

  let acknowledgedAtLaunch = await acknowledgmentRecorded(worktree);

  // The restarted copy appears within moments of the first copy exiting.
  const waitForRestartedCopy = async () => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const pids = worktreeElectronPids(worktree);
      if (pids.length) return Math.min(...pids);
      await sleep(200);
    }
    return null;
  };

  const launch = () => {
    generation += 1;
    const gen = generation;
    try {
      electron = spawn(electronBinary(worktree), [worktree], {
        cwd: worktree,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      emit('lifecycle', `launch-failed: ${err.message}`);
      shutdown(1);
      return;
    }
    electron.on('error', (err) => {
      emit('lifecycle', `launch-failed: ${err.message}`);
      shutdown(1);
    });
    if (!electron.pid) return;
    fs.writeFileSync(path.join(dir, 'electron.pid'), String(electron.pid));
    emit(
      'lifecycle',
      `${gen === 1 ? 'launched' : 'relaunched'} pid=${electron.pid} mode=${opts.visible ? 'visible' : 'headless'} profile=${opts.profile} main.log=${mainLog}`
    );
    // Group a stream's lines into entries (Chromium's native log entries and
    // Node's stack traces continue on indented lines), hold each entry long
    // enough for main.log's mirrored copy to arrive, then judge it.
    const onLine = (source) => {
      let entry = [];
      let idle = null;
      const judge = (lines) => {
        if (recentMainLogBodies.has(lines[0])) return; // main.log reported it
        const text = lines.join('\n');
        if (matters(text)) emit(source, text.trimEnd());
      };
      const flush = () => {
        clearTimeout(idle);
        if (!entry.length) return;
        const done = entry;
        entry = [];
        setTimeout(() => judge(done), DEDUPE_DELAY_MS);
      };
      return (l) => {
        fs.writeSync(rawLog, `${source}: ${l}\n`);
        if (!/^\s/.test(l) || !entry.length) flush();
        entry.push(l);
        clearTimeout(idle);
        idle = setTimeout(flush, ENTRY_IDLE_MS);
      };
    };
    lines(electron.stdout, onLine('stdout'));
    lines(electron.stderr, onLine('stderr'));
    electron.on('exit', async (code, signal) => {
      electron = null;
      if (stopping) return;
      emit('lifecycle', `exited code=${code} signal=${signal}`);
      // First acceptance of the startup notice: the app records it and starts
      // itself again. Keep supervising that copy instead of ending the check.
      if (opts.visible && code === 0 && !acknowledgedAtLaunch && (await acknowledgmentRecorded(worktree))) {
        const adopted = await waitForRestartedCopy();
        if (adopted) {
          emit('lifecycle', `relaunched after the startup acknowledgment pid=${adopted} profile=${opts.profile}`);
          fs.writeFileSync(path.join(dir, 'electron.pid'), String(adopted));
          acknowledgedAtLaunch = true;
          generation += 1;
          pollReady(generation);
          const watchTimer = setInterval(() => {
            if (stopping) return clearInterval(watchTimer);
            if (!isAlive(adopted)) {
              clearInterval(watchTimer);
              emit('lifecycle', 'exited (restarted copy)');
              shutdown(0);
            }
          }, 500);
          return;
        }
      }
      if (opts.visible && opts.relaunch) {
        // Asked for when a restart is part of the check (a setting persisting):
        // bring the app back until told to stop. Without it a quit ends the check.
        setTimeout(() => { if (!stopping) launch(); }, 1_000);
      } else {
        shutdown(code ?? 1);
      }
    });
    pollReady(gen);
  };

  const shutdown = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    emit('lifecycle', 'stopping (output after this line is from the shutdown itself)');
    for (const w of watchers) {
      try { process.kill(-w.pid, 'SIGTERM'); } catch { /* gone */ }
    }
    const left = await killWorktreeElectron(worktree);
    // Let held stdout/stderr entries and the last main.log lines through.
    await sleep(ENTRY_IDLE_MS + DEDUPE_DELAY_MS + 2 * LOG_POLL_MS);
    clearInterval(tailTimer);
    emit(
      'lifecycle',
      left.length
        ? `stopped, but processes are still running: ${left.join(' ')}`
        : 'stopped; no process of this worktree\'s Electron is left'
    );
    try { fs.unlinkSync(path.join(dir, 'supervisor.pid')); } catch { /* gone */ }
    try { fs.unlinkSync(path.join(dir, 'electron.pid')); } catch { /* gone */ }
    process.exit(code);
  };

  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGHUP', () => shutdown(0));

  launch();
}

// ── Entry ────────────────────────────────────────────────────────────────────

const USAGE = `usage:
  live-check start <worktree> [--visible [--relaunch]] [--profile <name>] [--watch '<cmd>']... [--all]
  live-check status [<worktree>]
  live-check stop <worktree>
  live-check log-path <worktree>
`;

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'start': await cmdStart(rest); break;
  case 'status': await cmdStatus(rest); break;
  case 'stop': await cmdStop(rest); break;
  case 'log-path': process.stdout.write(eventLogPath(resolveWorktree(rest[0])) + '\n'); break;
  case 'supervise': await supervise(resolveWorktree(rest[0])); break;
  default:
    process.stdout.write(USAGE);
    process.exit(cmd === '-h' || cmd === '--help' ? 0 : 2);
}
