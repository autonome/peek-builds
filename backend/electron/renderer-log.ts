/**
 * Renderer Log — always-on file writer for renderer console output.
 *
 * Every window Peek manages goes through tile-preload.cts, which monkey-patches
 * console.{log,info,warn,error,debug} to also call
 * `ipcRenderer.send('peek:renderer-log', { level, args, source })`.
 *
 * This module:
 *   - Registers the raw ipcMain listener for 'peek:renderer-log'.
 *   - Resolves the per-profile log file path:
 *       <userData>/logs/renderer.log
 *   - Appends one line per message using async fs.appendFile (fire-and-forget).
 *   - Rotates when the file exceeds 10 MB: renderer.log → renderer.log.1,
 *     then starts a fresh renderer.log.
 *
 * Rotation is handled in a single-process context (one Electron main process
 * per profile), so no cross-process locking is required. Concurrent async
 * appends from the same process are serialised via a per-file write queue
 * (promise chain) so rotate + append ordering is correct without blocking.
 *
 * Failures are swallowed — logging must never throw or crash the app.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// ── Lazy Electron require (ESM module, ELECTRON_RUN_AS_NODE safe) ────────────
// Pattern mirrors tile-ipc-gate.ts: type-only import at top, runtime access via
// createRequire so unit tests running under ELECTRON_RUN_AS_NODE=1 can import
// this module without Electron's named ESM exports blowing up.
import type { App } from 'electron';

const requireElectron = createRequire(import.meta.url);
let _ipcMain: typeof import('electron')['ipcMain'] | null = null;
let _app: App | null = null;

function getIpcMain(): typeof import('electron')['ipcMain'] {
  if (_ipcMain) return _ipcMain;
  const electron = requireElectron('electron') as typeof import('electron');
  _ipcMain = electron.ipcMain;
  return _ipcMain;
}

function getApp(): App {
  if (_app) return _app;
  const electron = requireElectron('electron') as typeof import('electron');
  _app = electron.app as App;
  return _app;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const LOG_FILE_NAME = 'renderer.log';
const LOG_FILE_ROTATED = 'renderer.log.1';
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB rotation threshold
const MAX_ARG_BYTES = 4 * 1024;     // 4 KB per arg truncation

// ── State ─────────────────────────────────────────────────────────────────────

/** Absolute path to the active log file. Resolved on first init. */
let logFilePath: string | null = null;
/** Directory containing the log file. */
let logDir: string | null = null;

/**
 * Monotonic write queue per log-file path. All appends and rotations are
 * chained on this promise so ordering is preserved without blocking the
 * event loop (each step is async I/O, not sync).
 */
let writeQueue: Promise<void> = Promise.resolve();

// ── Arg serialisation ─────────────────────────────────────────────────────────

function serialiseArg(arg: unknown): string {
  let s: string;
  if (typeof arg === 'string') {
    s = arg;
  } else if (arg instanceof Error) {
    s = arg.stack ?? arg.message;
  } else {
    try {
      s = JSON.stringify(arg);
    } catch {
      s = String(arg);
    }
  }
  if (s.length > MAX_ARG_BYTES) {
    s = s.slice(0, MAX_ARG_BYTES) + ' [truncated]';
  }
  return s;
}

// ── Rotation + append ─────────────────────────────────────────────────────────

/** Append one line to the log, rotating if the file exceeds MAX_BYTES. */
function enqueueWrite(line: string): void {
  if (!logFilePath || !logDir) return;

  const filePath = logFilePath;
  const dir = logDir;

  writeQueue = writeQueue.then(async () => {
    try {
      // Check current size.
      let needsRotate = false;
      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.size >= MAX_BYTES) needsRotate = true;
      } catch {
        // File doesn't exist yet — no rotation needed.
      }

      if (needsRotate) {
        // Rename current log to .1 (overwrites any previous .1).
        try {
          await fs.promises.rename(filePath, path.join(dir, LOG_FILE_ROTATED));
        } catch {
          // If rename fails, continue — we still write the new line.
        }
      }

      await fs.promises.appendFile(filePath, line + '\n', 'utf8');
    } catch {
      // Swallow — logging must never throw.
    }
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

/**
 * Payload shape sent by tile-preload.cts via ipcRenderer.send('peek:renderer-log').
 * NOTE: the `token` field is intentionally NOT required here — this channel is
 * internal and the sender is always the preload we injected, not third-party
 * tile code. We skip the tile-ipc gate entirely for this channel.
 */
interface RendererLogPayload {
  level: string;
  args: unknown[];
  source: string;
}

let _initialised = false;

/**
 * Initialise the renderer log writer. Call once from entry.ts after `app` is ready.
 * Safe to call multiple times — subsequent calls are no-ops.
 *
 * @param overrideLogDir  Optional: inject a custom log dir (used by unit tests).
 */
export function initRendererLog(overrideLogDir?: string): void {
  if (_initialised) return;
  _initialised = true;

  // Resolve log directory.
  if (overrideLogDir) {
    logDir = overrideLogDir;
  } else {
    try {
      logDir = path.join(getApp().getPath('userData'), 'logs');
    } catch {
      // If app isn't ready yet, bail — caller should call after app is ready.
      _initialised = false;
      return;
    }
  }
  logFilePath = path.join(logDir, LOG_FILE_NAME);

  // Create the logs directory synchronously on first init (app startup path,
  // not hot). mkdirSync with recursive is idempotent.
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    // Swallow.
  }

  // Register raw ipcMain listener. This channel is NOT routed through the
  // tile-ipc gate: it carries no token, and the sender is always our own
  // preload. The gate is for tile:* capability-scoped IPC.
  try {
    getIpcMain().on('peek:renderer-log', (_event, payload: unknown) => {
      try {
        const p = payload as RendererLogPayload;
        const level = typeof p.level === 'string' ? p.level : 'info';
        const source = typeof p.source === 'string' ? p.source : 'unknown';
        const args: unknown[] = Array.isArray(p.args) ? p.args : [];
        const message = args.map(serialiseArg).join(' ');
        const ts = new Date().toISOString();
        const line = `${ts} [${level}] ${source} ${message}`;
        enqueueWrite(line);
      } catch {
        // Swallow.
      }
    });
  } catch {
    // Swallow — if ipcMain isn't available (unit test context), skip.
  }

  // Separate diagnostic channel: peek:perf-log. The renderer sends a single
  // message string (already formatted); main process writes it via
  // console.log so it lands in main.log synchronously — the renderer.log
  // async queue can drop events on rapid quit, which is bad for perf
  // markers we'd then never see. Used by page.js to emit
  // [page-boot:perf] phase markers correlated with [session:perf].
  try {
    getIpcMain().on('peek:perf-log', (_event, message: unknown) => {
      try {
        if (typeof message === 'string' && message.length > 0) {
          console.log(message);
        }
      } catch {
        // Swallow.
      }
    });
  } catch {
    // Swallow.
  }
}

// ── Exports for unit tests ────────────────────────────────────────────────────

/**
 * Write one log entry directly (unit-test seam — bypasses IPC).
 * Uses the same queue/rotation logic as the IPC path.
 */
export function writeRendererLogEntry(level: string, source: string, args: unknown[]): void {
  if (!logFilePath) return;
  const message = args.map(serialiseArg).join(' ');
  const ts = new Date().toISOString();
  const line = `${ts} [${level}] ${source} ${message}`;
  enqueueWrite(line);
}

/**
 * Flush the write queue (unit-test seam). Returns a promise that resolves
 * after all pending writes complete.
 */
export function flushRendererLog(): Promise<void> {
  return writeQueue;
}

/**
 * Reset state for unit tests. Allows re-initialising with a different dir.
 */
export function __resetRendererLogForTest(): void {
  _initialised = false;
  logFilePath = null;
  logDir = null;
  writeQueue = Promise.resolve();
}
