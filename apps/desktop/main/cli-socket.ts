/**
 * Unix-domain socket server for CLI verb dispatch.
 *
 * Listens on `${XDG_RUNTIME_DIR or ~/.cache}/peek/<profile>/ipc.sock`
 * for line-delimited JSON `{verb, args}` messages and routes them
 * through `cli-router.dispatch`.
 *
 * Why not Electron's requestSingleInstanceLock? Because that requires
 * spinning up a whole second Electron process just to forward an argv
 * (~300–800ms on Linux) — defeats the point of "Peek is already
 * running, wake it up cheaply." A bundled non-Electron CLI helper
 * connects to this socket and exits in milliseconds. See
 * docs/global-hotkeys-on-wayland.md.
 *
 * Socket permissions are 0600 (user-only). Per-profile socket so
 * multiple Peek profiles can run in parallel without collision.
 *
 * Linux + macOS only — Windows would need named pipes; not wired.
 */

import * as net from 'node:net';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { app } from 'electron';
import { dispatch, type CliMessage } from './cli-router.js';

let server: net.Server | null = null;
let activeSocketPath: string | null = null;

export function getCliSocketPath(profile: string): string {
  const runtimeDir = process.env.XDG_RUNTIME_DIR
    || path.join(process.env.HOME ?? os.tmpdir(), '.cache');
  return path.join(runtimeDir, 'peek', profile, 'ipc.sock');
}

const isProbablyAlive = (socketPath: string): Promise<boolean> => new Promise(resolve => {
  const probe = net.createConnection(socketPath);
  const done = (alive: boolean) => {
    probe.removeAllListeners();
    probe.destroy();
    resolve(alive);
  };
  probe.once('connect', () => done(true));
  probe.once('error', () => done(false));
  // Belt and suspenders: probes shouldn't take long
  setTimeout(() => done(false), 500).unref();
});

export async function startCliSocketServer(profile: string): Promise<void> {
  if (process.platform === 'win32') {
    // Unix sockets only for now. Windows global-hotkey path uses
    // Electron's globalShortcut which actually works there.
    return;
  }

  const socketPath = getCliSocketPath(profile);
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });

  if (fs.existsSync(socketPath)) {
    if (await isProbablyAlive(socketPath)) {
      console.warn(`[cli-socket] another peek is listening on ${socketPath} — skipping`);
      return;
    }
    // Stale leftover from a previous crash; safe to remove.
    try {
      fs.unlinkSync(socketPath);
    } catch (err) {
      console.warn(`[cli-socket] could not unlink stale socket ${socketPath}:`, err);
      return;
    }
  }

  server = net.createServer(conn => {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('data', chunk => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;

        let msg: CliMessage;
        try {
          msg = JSON.parse(line) as CliMessage;
        } catch {
          conn.write(JSON.stringify({ ok: false, error: 'bad json' }) + '\n');
          continue;
        }
        // dispatch is async (some verbs evaluate JS in a webContents).
        // Per-line response order is preserved because the connection is a
        // single client and we await before reading the next message... but
        // here we read the buffer in a loop. For now, dispatches from the
        // same connection fire in parallel — fine for `peek-cli` which
        // sends one request per connection.
        Promise.resolve(dispatch(msg)).then(result => {
          conn.write(JSON.stringify(result) + '\n');
        }).catch(err => {
          conn.write(JSON.stringify({ ok: false, error: `dispatch threw: ${(err as Error)?.message ?? String(err)}` }) + '\n');
        });
      }
    });
    conn.on('error', () => {
      // Peer hung up mid-write or sent rubbish. Nothing to do; per-conn
      // error doesn't kill the server.
    });
  });

  server.on('error', err => {
    console.error('[cli-socket] server error:', err);
  });

  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(socketPath, () => {
      server!.removeListener('error', reject);
      resolve();
    });
  });

  try {
    fs.chmodSync(socketPath, 0o600);
  } catch (err) {
    console.warn('[cli-socket] chmod 0600 failed:', err);
  }

  activeSocketPath = socketPath;
  console.log(`[cli-socket] listening on ${socketPath}`);

  app.on('before-quit', () => {
    server?.close();
    if (activeSocketPath && fs.existsSync(activeSocketPath)) {
      try {
        fs.unlinkSync(activeSocketPath);
      } catch {
        // Race with another cleanup or the OS already nuked it; harmless.
      }
    }
  });
}

export function getActiveSocketPath(): string | null {
  return activeSocketPath;
}

/**
 * Stop the socket server and unlink the socket file. Safe to call when
 * not running. Used when the user disables the cliSocketEnabled pref.
 */
export async function stopCliSocketServer(): Promise<void> {
  if (server) {
    await new Promise<void>(resolve => {
      server!.close(() => resolve());
    });
    server = null;
  }
  if (activeSocketPath && fs.existsSync(activeSocketPath)) {
    try {
      fs.unlinkSync(activeSocketPath);
    } catch {
      // Race with another cleanup or the OS already nuked it; harmless.
    }
  }
  if (activeSocketPath) {
    console.log(`[cli-socket] stopped, unlinked ${activeSocketPath}`);
  }
  activeSocketPath = null;
}

export function isCliSocketRunning(): boolean {
  return server !== null;
}
