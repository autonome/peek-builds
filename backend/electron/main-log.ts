/**
 * Main Log — always-on file writer for main-process console output.
 *
 * Mirrors the renderer-log architecture (`renderer-log.ts`) but for the
 * Electron main process: there's no IPC hop, the main process patches its
 * own `console.{log,info,warn,error,debug}` so every existing and future
 * call site lands in the file for free.
 *
 * This module:
 *   - Resolves the per-profile log file path:
 *       <userData>/logs/main.log
 *   - Patches `console.*` to mirror each call to the log file. The original
 *     method is still invoked, so stdout/stderr (visible when launching from
 *     a terminal) and Electron's piped output continue working unchanged.
 *   - Appends one line per message using async fs.appendFile (fire-and-forget).
 *   - Rotates when the file exceeds 10 MB: main.log → main.log.1, then
 *     starts a fresh main.log.
 *
 * Rotation is handled in a single-process context (one Electron main process
 * per profile), so no cross-process locking is required. Concurrent async
 * appends from the same process are serialised via a write queue (promise
 * chain) so rotate + append ordering is correct without blocking.
 *
 * Failures are swallowed — logging must never throw or crash the app.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// Electron is loaded via createRequire so this module can be imported by
// unit tests running under ELECTRON_RUN_AS_NODE=1 without forcing a static
// electron import at evaluation time. Tests pass `overrideLogDir` so the
// `getApp()` path is never exercised in test context.
const requireElectron = createRequire(import.meta.url);
let _app: typeof import('electron').app | null = null;
function getApp(): typeof import('electron').app {
  if (_app) return _app;
  const electron = requireElectron('electron') as typeof import('electron');
  _app = electron.app;
  return _app;
}

type LogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

// ── Constants ─────────────────────────────────────────────────────────────────

const LOG_FILE_NAME = 'main.log';
const LOG_FILE_ROTATED = 'main.log.1';
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB rotation threshold
const MAX_ARG_BYTES = 4 * 1024;     // 4 KB per arg truncation

const LEVELS: LogLevel[] = ['log', 'info', 'warn', 'error', 'debug'];

// ── State ─────────────────────────────────────────────────────────────────────

let logFilePath: string | null = null;
let logDir: string | null = null;
let writeQueue: Promise<void> = Promise.resolve();
let _initialised = false;

/** Saved original console methods, so __resetMainLogForTest can restore them. */
const _originals: Partial<Record<LogLevel, (...args: unknown[]) => void>> = {};

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

function enqueueWrite(line: string): void {
  if (!logFilePath || !logDir) return;
  const filePath = logFilePath;
  const dir = logDir;
  writeQueue = writeQueue.then(async () => {
    try {
      let needsRotate = false;
      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.size >= MAX_BYTES) needsRotate = true;
      } catch {
        // File doesn't exist yet — no rotation needed.
      }
      if (needsRotate) {
        try {
          await fs.promises.rename(filePath, path.join(dir, LOG_FILE_ROTATED));
        } catch {
          // Rename failed — continue and append anyway.
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
 * Initialise the main-process log writer. Call once from entry.ts after
 * `app` is ready and after `app.setPath('userData', ...)` resolves to the
 * per-profile dir. Safe to call multiple times — subsequent calls are no-ops.
 *
 * Patches `console.{log,info,warn,error,debug}` so every existing and future
 * main-process console call also writes to `<userData>/logs/main.log`. The
 * original method is still invoked so stdout/stderr behavior is unchanged.
 *
 * @param overrideLogDir  Optional: inject a custom log dir (used by unit tests).
 */
export function initMainLog(overrideLogDir?: string): void {
  if (_initialised) return;
  if (overrideLogDir) {
    logDir = overrideLogDir;
  } else {
    try {
      logDir = path.join(getApp().getPath('userData'), 'logs');
    } catch {
      // If app isn't ready yet, bail — caller should call after app is ready.
      return;
    }
  }
  logFilePath = path.join(logDir, LOG_FILE_NAME);
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    // Swallow.
  }
  _initialised = true;

  // Patch console.{log,info,warn,error,debug}. Capture each original first,
  // then install a wrapper that writes to the file AND calls the original.
  for (const level of LEVELS) {
    const orig = (console[level] as (...args: unknown[]) => void).bind(console);
    _originals[level] = orig;
    (console as Record<LogLevel, (...args: unknown[]) => void>)[level] = (...args: unknown[]) => {
      try {
        const ts = new Date().toISOString();
        const message = args.map(serialiseArg).join(' ');
        enqueueWrite(`${ts} [${level}] main ${message}`);
      } catch {
        // Swallow.
      }
      try {
        orig(...args);
      } catch {
        // If the original somehow throws, don't propagate.
      }
    };
  }
}

// ── Exports for unit tests ────────────────────────────────────────────────────

/**
 * Write one log entry directly (unit-test seam — bypasses console patching).
 * Uses the same queue/rotation logic as the patched path.
 */
export function writeMainLogEntry(level: LogLevel, args: unknown[]): void {
  if (!logFilePath) return;
  const message = args.map(serialiseArg).join(' ');
  const ts = new Date().toISOString();
  enqueueWrite(`${ts} [${level}] main ${message}`);
}

/**
 * Flush the write queue (unit-test seam). Returns a promise that resolves
 * after all pending writes complete.
 */
export function flushMainLog(): Promise<void> {
  return writeQueue;
}

/**
 * Reset state for unit tests. Restores the original console methods so
 * subsequent tests aren't observing each other's writes.
 */
export function __resetMainLogForTest(): void {
  for (const level of LEVELS) {
    const orig = _originals[level];
    if (orig) {
      (console as Record<LogLevel, (...args: unknown[]) => void>)[level] = orig;
      delete _originals[level];
    }
  }
  _initialised = false;
  logFilePath = null;
  logDir = null;
  writeQueue = Promise.resolve();
}
