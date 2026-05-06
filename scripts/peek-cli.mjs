#!/usr/bin/env node
/**
 * peek-cli — bind this to a system keyboard shortcut to wake Peek.
 *
 * Usage:
 *   peek-cli <verb> [args...]
 *
 * Verbs (call with --list to see what the daemon has registered):
 *   cmd-open
 *   peek-open <n>
 *   slide-open <edge>
 *
 * Discovers the running Peek's socket at
 * ${XDG_RUNTIME_DIR or ~/.cache}/peek/<profile>/ipc.sock. If $PEEK_PROFILE
 * is set, that profile is used; otherwise the helper scans for a live
 * socket and uses the first one it finds.
 *
 * On no-daemon: prints a hint and exits non-zero. We don't cold-start
 * Peek from here yet (would force the user to wait for full Electron
 * startup on the keypress that triggers it). Start Peek the normal way
 * and then bind this script.
 *
 * No deps — pure node:net + node:fs. Bundled inside the app, not on
 * PATH (yet).
 */

import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const PEEK_RUNTIME_BASE = path.join(
  process.env.XDG_RUNTIME_DIR || path.join(process.env.HOME ?? os.tmpdir(), '.cache'),
  'peek'
);

const die = (msg, code = 1) => {
  process.stderr.write(`peek-cli: ${msg}\n`);
  process.exit(code);
};

const probe = (socketPath) => new Promise(resolve => {
  const c = net.createConnection(socketPath);
  const done = (alive) => { c.removeAllListeners(); c.destroy(); resolve(alive); };
  c.once('connect', () => done(true));
  c.once('error', () => done(false));
  setTimeout(() => done(false), 300).unref();
});

const findSocket = async () => {
  if (process.env.PEEK_PROFILE) {
    const p = path.join(PEEK_RUNTIME_BASE, process.env.PEEK_PROFILE, 'ipc.sock');
    if (fs.existsSync(p) && (await probe(p))) return p;
    return null;
  }
  if (!fs.existsSync(PEEK_RUNTIME_BASE)) return null;
  for (const profile of fs.readdirSync(PEEK_RUNTIME_BASE)) {
    const p = path.join(PEEK_RUNTIME_BASE, profile, 'ipc.sock');
    if (fs.existsSync(p) && (await probe(p))) return p;
  }
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

// Keep in sync with KNOWN_VERBS in backend/electron/cli-router.ts.
// (No --list flag yet that asks the daemon for the live registry.)
const HELP_TEXT = `usage: peek-cli <verb> [args...]

Verbs:
  cmd-open            Open the command panel
  peek-open <n>       Open peek N (0..9)
  slide-open <edge>   Open slide on edge (Up|Down|Left|Right; case-insensitive)

Invocation:
  This is a plain Node script — but Peek users typically don't have
  Node installed, so the bundled invocation uses the Electron binary
  in Node mode:

    ELECTRON_RUN_AS_NODE=1 <electron-binary> <peek-cli.mjs> <verb> [args...]

  Peek's Settings → Keyboard Shortcuts panel renders the full
  sh -c wrapped command per packaging — copy that into your DE's
  custom-shortcut UI and you're done.

Behaviour:
  - Auto-discovers the live socket under \${XDG_RUNTIME_DIR or ~/.cache}/peek/*/ipc.sock.
  - Set \$PEEK_PROFILE to pick a specific profile when multiple Peek instances are running.
  - Exits 0 on success, 2 if no daemon is running, 3 if the daemon rejects the verb.

See docs/global-hotkeys-on-wayland.md for binding to GNOME / KDE / Hyprland shortcuts.
`;

const main = async () => {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP_TEXT);
    process.exit(argv.length === 0 ? 1 : 0);
  }
  const [verb, ...args] = argv;

  const socketPath = await findSocket();
  if (!socketPath) {
    die('no running Peek daemon found (looked in ' + PEEK_RUNTIME_BASE + '). Start Peek first.', 2);
  }

  const result = await send(socketPath, { verb, args });
  if (!result?.ok) {
    die(`daemon rejected verb: ${result?.error ?? 'unknown error'}`, 3);
  }
};

main().catch(err => die(err?.message ?? String(err)));
