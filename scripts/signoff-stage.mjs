#!/usr/bin/env node
/**
 * signoff-stage — produce one known starting state for the macOS window-manager
 * sign-off run (docs/design/window-manager-macos-signoff.md) and print an
 * inventory of it.
 *
 * Usage:
 *   PEEK_PROFILE=<profile> node scripts/signoff-stage.mjs [--port <n>]
 *
 * What it does:
 *   1. Serves two visually distinct pages (ALPHA blue, BRAVO red) over
 *      http://127.0.0.1:<port> — a real http:// origin, since a page window
 *      only gets the `content` izui role for an isWebPage URL
 *      (apps/desktop/main/izui-roles.ts inferIzuiRole); peek:// and data:
 *      URLs can only ever be `workspace`.
 *   2. Waits for the running instance's CLI socket for $PEEK_PROFILE.
 *   3. Closes the startup settings window (opens on every boot from
 *      defaults.prefs.startupFeature — apps/desktop/renderer/config.js /
 *      index.js openStartupFeature()).
 *   4. Opens ALPHA then BRAVO as page windows via the `open-url` CLI verb.
 *   5. Prints the final window inventory.
 *   6. Keeps serving the pages until killed — they must stay reachable for
 *      the duration of the run.
 *
 * No deps — pure node:http + node:net + node:fs + node:path, matching the
 * dependency-free style of peek-cli.mjs. The socket-discovery helpers below
 * are duplicated from that script (it has no exports to import) — keep them
 * in sync by hand if peek-cli.mjs's discovery logic changes.
 */

import * as http from 'node:http';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const PEEK_RUNTIME_BASE = path.join(
  process.env.XDG_RUNTIME_DIR || path.join(process.env.HOME ?? os.tmpdir(), '.cache'),
  'peek'
);

const die = (msg, code = 1) => {
  process.stderr.write(`signoff-stage: ${msg}\n`);
  process.exit(code);
};

// ─── Socket discovery (duplicated from peek-cli.mjs — see file header) ────

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

// ─── Test pages ─────────────────────────────────────────────────────────

const page = (word, color) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${word}</title>
<style>
  html, body { margin: 0; height: 100%; background: ${color}; }
  body { display: flex; align-items: center; justify-content: center; }
  h1 { font: 900 20vw/1 sans-serif; color: #fff; margin: 0; letter-spacing: 0.05em; }
</style></head>
<body><h1>${word}</h1></body></html>
`;

const PAGES = {
  '/alpha.html': page('ALPHA', '#1247e0'),
  '/bravo.html': page('BRAVO', '#c81414'),
};

const startServer = (port) => new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const body = PAGES[req.url];
    if (!body) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => resolve(server));
});

// ─── Main ───────────────────────────────────────────────────────────────

const parseArgs = (argv) => {
  let port = 8777;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') port = Number(argv[++i]);
  }
  if (!Number.isFinite(port) || port <= 0) die(`invalid --port value`);
  return { port };
};

const debugListWindows = async (socketPath) => {
  const result = await send(socketPath, { verb: 'debug-list-windows' });
  if (!result?.ok) throw new Error(`debug-list-windows failed: ${result?.error ?? 'unknown error'}`);
  return result.data ?? [];
};

const waitForUrlSubstring = async (socketPath, substring, { timeoutMs = 5000, intervalMs = 300 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const windows = await debugListWindows(socketPath);
    const hit = windows.find(w => w.url && w.url.includes(substring));
    if (hit) return hit;
    if (Date.now() > deadline) return null;
    await sleep(intervalMs);
  }
};

const main = async () => {
  const { port } = parseArgs(process.argv.slice(2));

  const profile = process.env.PEEK_PROFILE;
  if (!profile) die('set $PEEK_PROFILE to the running instance\'s profile name');

  const alphaUrl = `http://127.0.0.1:${port}/alpha.html`;
  const bravoUrl = `http://127.0.0.1:${port}/bravo.html`;

  const server = await startServer(port).catch(err => die(`could not start test-page server on port ${port}: ${err.message}`));
  process.stdout.write(`Serving:\n  ${alphaUrl}\n  ${bravoUrl}\n\n`);

  // Wait for the instance's socket — a few short retries rather than one
  // shot, since the instance may still be finishing boot.
  let socketPath = null;
  for (let attempt = 0; attempt < 10 && !socketPath; attempt++) {
    socketPath = await findSocket(profile);
    if (!socketPath) await sleep(500);
  }
  if (!socketPath) {
    die(`no running Peek instance found for profile "${profile}" (looked for ${path.join(PEEK_RUNTIME_BASE, profile, 'ipc.sock')}). Start it first with PROFILE=${profile} yarn start.`);
  }
  process.stdout.write(`Found instance socket: ${socketPath}\n\n`);

  // Close the startup settings window, if present.
  const before = await debugListWindows(socketPath);
  const settingsWin = before.find(w => w.url && w.url.includes('settings/settings.html'));
  if (settingsWin) {
    const closeResult = await send(socketPath, { verb: 'debug-eval', args: [settingsWin.webContentsId, 'window.close()'] });
    if (!closeResult?.ok) {
      process.stdout.write(`Warning: could not close settings window: ${closeResult?.error ?? 'unknown error'}\n\n`);
    } else {
      process.stdout.write(`Closed startup settings window (webContents ${settingsWin.webContentsId}).\n\n`);
    }
  } else {
    process.stdout.write('No startup settings window found (already closed, or PEEK_AUTOOPEN_EXT / session restore suppressed it).\n\n');
  }

  // Open ALPHA, then BRAVO, as page windows via the open-url CLI verb.
  const openResult1 = await send(socketPath, { verb: 'open-url', args: [alphaUrl] });
  if (!openResult1?.ok) die(`open-url ALPHA failed: ${openResult1?.error ?? 'unknown error'}`);
  const alphaWin = await waitForUrlSubstring(socketPath, alphaUrl);
  if (!alphaWin) process.stdout.write('Warning: ALPHA did not appear in the window list within the timeout.\n');

  const openResult2 = await send(socketPath, { verb: 'open-url', args: [bravoUrl] });
  if (!openResult2?.ok) die(`open-url BRAVO failed: ${openResult2?.error ?? 'unknown error'}`);
  const bravoWin = await waitForUrlSubstring(socketPath, bravoUrl);
  if (!bravoWin) process.stdout.write('Warning: BRAVO did not appear in the window list within the timeout.\n');

  // Final inventory.
  const windows = await debugListWindows(socketPath);
  process.stdout.write('\n=== Window inventory ===\n');
  for (const w of windows) {
    const bits = [`id=${w.windowId}`, `wc=${w.webContentsId}`, `title=${JSON.stringify(w.title)}`, `url=${w.url}`];
    if (w.hybrid) bits.push('hybrid=true');
    if (w.destroyed) bits.push('destroyed=true');
    if (w.bounds) bits.push(`bounds=${JSON.stringify(w.bounds)}`);
    process.stdout.write(`  ${bits.join(' ')}\n`);
  }
  process.stdout.write(
    '\nfrontmost/topmost: not obtainable via debug-list-windows (the CLI protocol carries no focus/z-order field) — confirm visually.\n'
  );
  process.stdout.write(
    'address bar: hidden — pointer-driven, 400ms hide timer (apps/desktop/renderer/page/overlay.js); shown only while the pointer sits in the top trigger zone.\n'
  );

  process.stdout.write('\nStaging server is up. Ctrl+C to stop.\n');
  // Keep the process alive — the server's open handle already does this.
};

main().catch(err => die(err?.message ?? String(err)));
