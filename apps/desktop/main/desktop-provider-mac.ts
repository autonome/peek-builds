/**
 * macOS desktop provider — specs/kernel-desktops.md, section 6 "macOS: native helper, reads".
 *
 * A Node client of the desktop helper (`native/desktop-helper/main.swift`, protocol in its
 * header): spawns it, speaks one JSON object per line, and answers `DesktopProvider` requests
 * from it. Reads, and switching the shown desktop through the helper. Placing a window is
 * done by the injected `moveWindow` (in the app's own process) because the window server
 * ignores the move from any other process; `probePlace` is the helper's own diagnostic move.
 *
 * Failure reporting, for `FailSafeDesktopProvider`: `start` rejects when the helper is missing,
 * fails to spawn, exits before answering `hello`, or reports a required private symbol
 * unavailable. After a good start, a helper exit or an unparseable line is reported once as a
 * `failed` change, and every pending request rejects. This client sets no timeouts; the wrapper
 * does. Answers are passed through unvalidated; the wrapper validates them.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { DesktopId } from './window-kernel.js';
import type {
  DesktopChange,
  DesktopProvider,
  Placement,
  PlatformWindowId,
  ProviderLayout,
} from './desktop-provider.js';

/** Protocol version this client speaks. */
export const MAC_HELPER_VERSION = 1;
/** Symbols the reads cannot do without; `hello` naming any of them `false` fails the start. */
export const MAC_REQUIRED_SYMBOLS = [
  'CGSMainConnectionID',
  'CGSCopyManagedDisplaySpaces',
  'CGSCopySpacesForWindows',
] as const;
export const MAC_HELPER_BINARY = 'peek-desktop-helper';

/**
 * Where the helper lives: `Contents/Resources` when packaged (electron-builder
 * `extraResources`), `dist/native` when run from source.
 */
export function macHelperPath(packaged: boolean, resourcesPath: string): string {
  if (packaged) return join(resourcesPath, MAC_HELPER_BINARY);
  // This file compiles to dist/main/; the build puts the helper in dist/native/.
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'native', MAC_HELPER_BINARY);
}

/**
 * The window server number inside a desktop-capture source id (`window:<n>:<m>`), which is how
 * an Electron backend names its windows to this provider. `null` for any other shape and for
 * `0`, which a window not yet known to the window server reports.
 */
export function windowNumberFromSourceId(sourceId: string): PlatformWindowId | null {
  const match = /^window:(\d+):\d+$/.exec(sourceId);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export interface MacProviderOptions {
  /** Executable to spawn: the helper, or (tests) any program speaking its protocol. */
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Asks the window server, from this process, to put one of this app's windows on a desktop.
   * True when the call was made; `placeWindow` reads the result back.
   */
  readonly moveWindow?: (win: PlatformWindowId, desktop: DesktopId) => boolean;
}

/** What `hello` answered, kept for diagnostics. */
export interface MacHelperHello {
  readonly version: number;
  readonly symbols: Readonly<Record<string, boolean>>;
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
}

export class MacDesktopProvider implements DesktopProvider {
  readonly name = 'mac';
  readonly canShowDesktops = true;
  /** `hello`'s answer once started. */
  hello: MacHelperHello | null = null;

  private child: ChildProcess | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private started = false;
  private ended = false;
  private onChange: ((change: DesktopChange) => void) | null = null;

  constructor(private readonly opts: MacProviderOptions) {}

  /** Placing needs a mover: without one this provider only reads. */
  get canPlaceWindows(): boolean {
    return this.opts.moveWindow !== undefined;
  }

  async start(onChange: (change: DesktopChange) => void): Promise<void> {
    // A start after a stop or a failure (the fail-safe wrapper probes a failed helper again)
    // begins a fresh session; events of the earlier child are ignored below.
    this.stop();
    this.ended = false;
    this.started = false;
    this.hello = null;
    this.onChange = onChange;
    if (!existsSync(this.opts.command)) throw new Error('helper-missing');
    const child = spawn(this.opts.command, [...(this.opts.args ?? [])], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: this.opts.env ?? process.env,
    });
    this.child = child;
    // A write to a helper that already exited must not throw in the main process.
    child.stdin?.on('error', () => {});
    child.on('error', (err) => {
      if (this.child === child) this.end(`helper-spawn-failed:${err.message}`);
    });
    child.on('exit', (code, signal) => {
      if (this.child === child) {
        this.end(signal ? `helper-exit signal=${signal}` : `helper-exit code=${code ?? 'null'}`);
      }
    });
    if (child.stdout) {
      createInterface({ input: child.stdout }).on('line', (line) => {
        if (this.child === child) this.onLine(line);
      });
    }

    const hello = (await this.request('hello', {})) as Partial<MacHelperHello> | null;
    if (
      typeof hello !== 'object' ||
      hello === null ||
      hello.version !== MAC_HELPER_VERSION ||
      typeof hello.symbols !== 'object' ||
      hello.symbols === null
    ) {
      this.stop();
      throw new Error('bad-hello');
    }
    const missing = MAC_REQUIRED_SYMBOLS.filter((s) => hello.symbols?.[s] !== true);
    if (missing.length > 0) {
      this.stop();
      throw new Error(`symbols-unavailable:${missing.join(',')}`);
    }
    this.hello = { version: hello.version, symbols: { ...hello.symbols } };
    this.started = true;
  }

  async layout(): Promise<ProviderLayout> {
    return (await this.request('layout', {})) as ProviderLayout;
  }

  async placements(windows: PlatformWindowId[]): Promise<Placement[]> {
    return (await this.request('placements', { windows })) as Placement[];
  }

  /**
   * Moves the window with the injected mover (the window server honours the move only from the
   * window's own process, so the helper cannot do it) and answers whether the helper reads it on
   * `desktop` afterwards. A window on every desktop never reads as on one.
   */
  async placeWindow(win: PlatformWindowId, desktop: DesktopId): Promise<boolean> {
    const move = this.opts.moveWindow;
    if (!move || !move(win, desktop)) return false;
    // The window server applies the move asynchronously; allow it a few reads.
    for (let attempt = 0; attempt < 5; attempt++) {
      const [placement] = (await this.placements([win])) ?? [];
      if (placement?.desktop === desktop) return true;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return false;
  }

  /**
   * Makes `desktop` the one its display shows, through the helper: the window server honours
   * that from any process. True when the helper then reads it as shown; a refusal is false.
   */
  async showDesktop(desktop: DesktopId): Promise<boolean> {
    try {
      const result = (await this.request('show', { desktop })) as { current?: unknown } | null;
      return result?.current === desktop;
    } catch (err) {
      // A refusal for this desktop is not a failed helper; only a dead one rejects otherwise.
      if (err instanceof Error && err.message.startsWith('helper-error:')) return false;
      throw err;
    }
  }

  /**
   * Diagnostics only (live acceptance, write test): asks the helper to move a window and
   * returns whether the call was attempted and the window's desktops afterwards.
   */
  async probePlace(
    win: PlatformWindowId,
    desktop: DesktopId,
  ): Promise<{ attempted: boolean; desktops: DesktopId[] }> {
    return (await this.request('place', { window: win, desktop })) as {
      attempted: boolean;
      desktops: DesktopId[];
    };
  }

  stop(): void {
    this.halt('stopped');
  }

  private halt(reason: string): void {
    this.ended = true;
    this.onChange = null;
    this.rejectAll(reason);
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
  }

  private request(op: string, args: Record<string, unknown>): Promise<unknown> {
    const child = this.child;
    if (this.ended || !child?.stdin) return Promise.reject(new Error('helper-not-running'));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin!.write(`${JSON.stringify({ id, op, ...args })}\n`);
    });
  }

  private onLine(line: string): void {
    if (this.ended || line.trim() === '') return;
    let msg: { id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      this.fail('malformed-line');
      return;
    }
    const entry = typeof msg?.id === 'number' ? this.pending.get(msg.id) : undefined;
    if (!entry) {
      this.fail('malformed-line');
      return;
    }
    this.pending.delete(msg.id as number);
    if (msg.ok === true) entry.resolve(msg.result);
    else entry.reject(new Error(`helper-error:${typeof msg.error === 'string' ? msg.error : '?'}`));
  }

  /** The helper can no longer be trusted: report once, stop it. */
  private fail(reason: string): void {
    if (this.ended) return;
    const onChange = this.onChange;
    this.onChange = null;
    // Reported before pending requests reject, so the fallback line carries this reason.
    if (this.started) onChange?.({ kind: 'failed', reason });
    this.halt(reason);
  }

  /** The helper process is gone (exit or spawn error). */
  private end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    const onChange = this.onChange;
    this.onChange = null;
    this.child = null;
    // Before a good start, the pending `hello` rejects and `start` carries the reason.
    if (this.started) onChange?.({ kind: 'failed', reason });
    this.rejectAll(reason);
  }

  private rejectAll(reason: string): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) p.reject(new Error(reason));
  }
}
