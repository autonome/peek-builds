/**
 * Desktop provider port — specs/kernel-desktops.md, section 5 "Backend contract".
 *
 * A window backend learns which desktops exist, which one each screen shows and which desktop
 * each of its windows is on through a desktop provider. The kernel never sees a provider: the
 * backend turns what the provider reports into kernel events. This file names no backend, no
 * OS call and no Electron type, so any backend (Electron, Tauri, …) can own a provider, and
 * `scripts/check-platform-leak.mjs` scans it.
 *
 * Also here: the fail-safe wrapper every backend starts its platform provider through. A failure
 * of the platform provider switches the session to the fallback provider, logged once as
 * `desktop-provider fallback reason=<…>`; the platform provider is then probed again after a
 * backoff and the session returns to it when it answers (`desktop-provider recovered`).
 */
import type { DesktopId } from './window-kernel.js';

/**
 * A platform's own number for a window: the window server number on macOS, the X window id on
 * X11. Derived by the backend for its own windows.
 */
export type PlatformWindowId = number;

/**
 * A platform's own id for a display, as a string. The backend maps it to its screen ids. The
 * fallback provider is fed the backend's screen ids, so for it the two are the same.
 */
export type ProviderDisplayId = string;

/** One screen as the provider sees it. `display: null` = every screen (desktops shared). */
export interface ProviderScreen {
  readonly display: ProviderDisplayId | null;
  readonly current: DesktopId;
}

/** One desktop. `display: null` = shared across screens. */
export interface ProviderDesktop {
  readonly id: DesktopId;
  readonly display: ProviderDisplayId | null;
}

export interface ProviderLayout {
  readonly screens: readonly ProviderScreen[];
  readonly desktops: readonly ProviderDesktop[];
}

/** Where one window is. `null` = the provider cannot tell; the backend leaves that field alone. */
export interface Placement {
  readonly window: PlatformWindowId;
  readonly display: ProviderDisplayId | null;
  readonly desktop: DesktopId | null;
  readonly onEveryDesktop: boolean;
}

/**
 * What a provider reports unasked. On `layout-changed` and `current-desktop-changed` the backend
 * re-reads layout and placements. `failed` means the provider can no longer answer (for a helper
 * process: it exited); the fail-safe wrapper turns it into a switch to the fallback provider and
 * never passes it on.
 */
export type DesktopChange =
  | { readonly kind: 'layout-changed' }
  | { readonly kind: 'current-desktop-changed'; readonly display: ProviderDisplayId | null }
  | { readonly kind: 'failed'; readonly reason: string };

export interface DesktopProvider {
  /** For logs. */
  readonly name: string;
  readonly canPlaceWindows: boolean;
  readonly canShowDesktops: boolean;
  /** Resolves once the provider can answer; rejects (reason in the error message) if it cannot. */
  start(onChange: (change: DesktopChange) => void): Promise<void>;
  layout(): Promise<ProviderLayout>;
  placements(windows: PlatformWindowId[]): Promise<Placement[]>;
  /** `false` when the provider lacks the capability or the write did not take. */
  placeWindow(win: PlatformWindowId, desktop: DesktopId): Promise<boolean>;
  /** `false` when the provider lacks the capability or the switch did not take. */
  showDesktop(desktop: DesktopId): Promise<boolean>;
  stop(): void;
}

/** Spec, "Fail-safe": the start handshake must answer within 1s. */
export const PROVIDER_HANDSHAKE_TIMEOUT_MS = 1000;
/** Spec, "Fail-safe": any later request must answer within 250ms. */
export const PROVIDER_REQUEST_TIMEOUT_MS = 250;
/**
 * A request that missed the 250ms budget is asked once more with this longer one before it counts
 * as a failure: a busy window server makes a healthy helper miss the short budget now and then.
 */
export const PROVIDER_RETRY_TIMEOUT_MS = 1500;
/** Waits before each re-probe of a failed platform provider; the last value repeats. */
export const PROVIDER_REPROBE_BACKOFF_MS: readonly number[] = [5_000, 30_000];

// ─── Validation ──────────────────────────────────────────────────────────────
// A provider's answers cross a process boundary on some platforms, so they are checked here,
// once, for every provider. Malformed data is a fail-safe trigger, not something to repair.

function isDisplayId(v: unknown): v is ProviderDisplayId | null {
  return v === null || (typeof v === 'string' && v.length > 0);
}

function isDesktopIdValue(v: unknown): v is DesktopId {
  return typeof v === 'string' && v.length > 0;
}

export function isProviderLayout(v: unknown): v is ProviderLayout {
  if (typeof v !== 'object' || v === null) return false;
  const { screens, desktops } = v as { screens?: unknown; desktops?: unknown };
  if (!Array.isArray(screens) || !Array.isArray(desktops)) return false;
  const known = new Set<DesktopId>();
  for (const d of desktops) {
    if (typeof d !== 'object' || d === null) return false;
    const { id, display } = d as { id?: unknown; display?: unknown };
    if (!isDesktopIdValue(id) || !isDisplayId(display)) return false;
    known.add(id);
  }
  for (const s of screens) {
    if (typeof s !== 'object' || s === null) return false;
    const { display, current } = s as { display?: unknown; current?: unknown };
    if (!isDisplayId(display) || !isDesktopIdValue(current)) return false;
    // A screen showing a desktop the layout does not list is not a layout.
    if (!known.has(current)) return false;
  }
  return true;
}

/** Placements must answer exactly the windows asked about, each once. */
export function isPlacementList(v: unknown, asked: readonly PlatformWindowId[]): v is Placement[] {
  if (!Array.isArray(v) || v.length !== asked.length) return false;
  const pending = new Set(asked);
  for (const p of v) {
    if (typeof p !== 'object' || p === null) return false;
    const { window, display, desktop, onEveryDesktop } = p as {
      window?: unknown;
      display?: unknown;
      desktop?: unknown;
      onEveryDesktop?: unknown;
    };
    if (typeof window !== 'number' || !pending.delete(window)) return false;
    if (!isDisplayId(display)) return false;
    if (desktop !== null && !isDesktopIdValue(desktop)) return false;
    if (typeof onEveryDesktop !== 'boolean') return false;
  }
  return pending.size === 0;
}

// ─── Fail-safe wrapper ───────────────────────────────────────────────────────

class ProviderFailure extends Error {}
/** The one failure worth another try: a dead or lying provider will not do better. */
class RequestTimeout extends ProviderFailure {}

function withTimeout<T>(p: Promise<T>, ms: number, reason: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RequestTimeout(reason)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function reasonOf(err: unknown, fallbackReason: string): string {
  if (err instanceof ProviderFailure) return err.message;
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return msg ? `${fallbackReason}:${msg}` : fallbackReason;
}

/** Log fields carry no whitespace, so a reason stays one grep-able token. */
function logToken(s: string): string {
  return s.replace(/\s+/g, '_');
}

export interface FailSafeOptions {
  /** The platform's provider; `null` when the platform has none. */
  readonly primary: DesktopProvider | null;
  readonly fallback: DesktopProvider;
  /** One log line, without the `[wm]` prefix. Defaults to stdout. */
  readonly log?: (line: string) => void;
  readonly handshakeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  /** Timeout of the one retry after a request timeout. */
  readonly retryTimeoutMs?: number;
  /** Waits before each re-probe of a failed platform provider; the last value repeats. */
  readonly reprobeBackoffMs?: readonly number[];
  /** Runs `fn` after `ms`; returns the cancel function. Defaults to an unref'd `setTimeout`. */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

const defaultLog = (line: string): void => {
  console.log(`[wm] t=${Date.now()} ${line}`);
};

/**
 * The provider a backend owns. Answers from the platform provider while it behaves. A request
 * that times out is asked once more with a longer timeout (logged `desktop-provider retry`). On a
 * failure (no provider, start rejected, handshake timeout, a request timing out twice, malformed
 * answer, a `failed` change) it stops the platform provider, starts the fallback, logs
 * `desktop-provider fallback reason=<…>`, answers the failing request from the fallback and sends
 * `layout-changed` so the backend re-reads everything from the fallback.
 *
 * A platform provider that had started, or whose handshake timed out, is probed again after a
 * backoff (5s, then 30s, repeating): when it answers, the session returns to it, logs
 * `desktop-provider recovered` and sends `layout-changed`. A provider that cannot start at all
 * (missing binary, unavailable symbols) or the absence of one is final for the session.
 */
export class FailSafeDesktopProvider implements DesktopProvider {
  private active: DesktopProvider;
  private primary: DesktopProvider | null;
  private readonly fallback: DesktopProvider;
  private readonly log: (line: string) => void;
  private readonly handshakeTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly retryTimeoutMs: number;
  private readonly reprobeBackoffMs: readonly number[];
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private cancelReprobe: (() => void) | null = null;
  private onChange: ((change: DesktopChange) => void) | null = null;
  private fellBack = false;
  private stopped = false;

  constructor(opts: FailSafeOptions) {
    this.primary = opts.primary;
    this.fallback = opts.fallback;
    this.active = opts.primary ?? opts.fallback;
    this.log = opts.log ?? defaultLog;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? PROVIDER_HANDSHAKE_TIMEOUT_MS;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? PROVIDER_REQUEST_TIMEOUT_MS;
    this.retryTimeoutMs = opts.retryTimeoutMs ?? PROVIDER_RETRY_TIMEOUT_MS;
    const backoff = opts.reprobeBackoffMs ?? PROVIDER_REPROBE_BACKOFF_MS;
    this.reprobeBackoffMs = backoff.length > 0 ? backoff : PROVIDER_REPROBE_BACKOFF_MS;
    this.schedule = opts.schedule ?? defaultSchedule;
  }

  get name(): string {
    return this.active.name;
  }
  get canPlaceWindows(): boolean {
    return this.active.canPlaceWindows;
  }
  get canShowDesktops(): boolean {
    return this.active.canShowDesktops;
  }
  /** True once the session runs on the fallback provider because the platform one failed. */
  get onFallback(): boolean {
    return this.fellBack || this.primary === null;
  }

  async start(onChange: (change: DesktopChange) => void): Promise<void> {
    this.onChange = onChange;
    const primary = this.primary;
    if (primary === null) {
      await this.switchToFallback('no-provider', { notify: false });
      return;
    }
    try {
      await withTimeout(
        primary.start((change) => this.fromPrimary(primary, change)),
        this.handshakeTimeoutMs,
        'handshake-timeout',
      );
    } catch (err) {
      await this.switchToFallback(reasonOf(err, 'start-failed'), { notify: false });
      return;
    }
    if (this.fellBack || this.stopped) return; // failed while starting
    this.log(`desktop-provider started name=${logToken(primary.name)}`);
  }

  async layout(): Promise<ProviderLayout> {
    return this.ask(
      (p) => p.layout(),
      (v): v is ProviderLayout => isProviderLayout(v),
      'layout',
    );
  }

  async placements(windows: PlatformWindowId[]): Promise<Placement[]> {
    const asked = [...windows];
    return this.ask(
      (p) => p.placements([...asked]),
      (v): v is Placement[] => isPlacementList(v, asked),
      'placements',
    );
  }

  async placeWindow(win: PlatformWindowId, desktop: DesktopId): Promise<boolean> {
    if (!this.active.canPlaceWindows) return false;
    return this.ask(
      (p) => p.placeWindow(win, desktop),
      (v): v is boolean => typeof v === 'boolean',
      'place',
    );
  }

  async showDesktop(desktop: DesktopId): Promise<boolean> {
    if (!this.active.canShowDesktops) return false;
    return this.ask(
      (p) => p.showDesktop(desktop),
      (v): v is boolean => typeof v === 'boolean',
      'show-desktop',
    );
  }

  stop(): void {
    this.stopped = true;
    this.onChange = null;
    this.cancelReprobe?.();
    this.cancelReprobe = null;
    this.active.stop();
  }

  private fromPrimary(primary: DesktopProvider, change: DesktopChange): void {
    if (this.active !== primary || this.stopped) return;
    if (change.kind === 'failed') {
      void this.switchToFallback(change.reason, { notify: true });
      return;
    }
    this.onChange?.(change);
  }

  /** Runs a request on the active provider; a platform-provider failure answers from the fallback. */
  private async ask<T>(
    run: (p: DesktopProvider) => Promise<T>,
    valid: (v: unknown) => v is T,
    op: string,
  ): Promise<T> {
    const provider = this.active;
    if (provider === this.fallback) return run(provider);
    let value: unknown;
    try {
      try {
        value = await withTimeout(run(provider), this.requestTimeoutMs, `request-timeout:${op}`);
      } catch (err) {
        // Only a miss of the short budget is retried, and only while this provider is still the one
        // in use; a provider that died or was replaced meanwhile has nothing to retry.
        if (!(err instanceof RequestTimeout) || this.active !== provider || this.stopped) throw err;
        this.log(`desktop-provider retry op=${op}`);
        value = await withTimeout(run(provider), this.retryTimeoutMs, `request-timeout:${op}`);
      }
    } catch (err) {
      await this.switchToFallback(reasonOf(err, `request-failed:${op}`), { notify: true });
      return run(this.fallback);
    }
    if (!valid(value)) {
      await this.switchToFallback(`malformed:${op}`, { notify: true });
      return run(this.fallback);
    }
    return value;
  }

  private async switchToFallback(reason: string, { notify }: { notify: boolean }): Promise<void> {
    // Already switched: a second in-flight request of the platform provider failed too.
    if (this.fellBack) return;
    const primary = this.primary;
    this.fellBack = true;
    this.active = this.fallback;
    this.log(`desktop-provider fallback reason=${logToken(reason)}`);
    if (primary) {
      try {
        primary.stop();
      } catch {
        // A provider that fails to stop is already out of the session.
      }
    }
    if (this.stopped) return;
    await this.fallback.start((change) => {
      if (!this.stopped && change.kind !== 'failed') this.onChange?.(change);
    });
    if (primary && !reason.startsWith('start-failed')) this.scheduleReprobe(0);
    if (notify && !this.stopped) {
      const onChange = this.onChange;
      queueMicrotask(() => onChange?.({ kind: 'layout-changed' }));
    }
  }

  /** Probes the platform provider again after the backoff for `attempt` (0-based). */
  private scheduleReprobe(attempt: number): void {
    if (this.stopped || !this.primary) return;
    const wait = this.reprobeBackoffMs[Math.min(attempt, this.reprobeBackoffMs.length - 1)];
    this.cancelReprobe = this.schedule(() => {
      this.cancelReprobe = null;
      void this.reprobe(attempt);
    }, wait);
  }

  private async reprobe(attempt: number): Promise<void> {
    const primary = this.primary;
    if (!primary || this.stopped || !this.fellBack) return;
    try {
      await withTimeout(
        primary.start((change) => this.fromPrimary(primary, change)),
        this.handshakeTimeoutMs,
        'handshake-timeout',
      );
      const layout = await withTimeout(primary.layout(), this.retryTimeoutMs, 'request-timeout:layout');
      if (!isProviderLayout(layout)) throw new Error('malformed:layout');
    } catch (err) {
      try {
        primary.stop();
      } catch {
        // A provider that fails to stop is already out of the session.
      }
      if (!this.stopped) {
        this.log(`desktop-provider reprobe-failed reason=${logToken(reasonOf(err, 'start-failed'))}`);
        this.scheduleReprobe(attempt + 1);
      }
      return;
    }
    if (this.stopped) {
      primary.stop();
      return;
    }
    this.fellBack = false;
    this.active = primary;
    this.fallback.stop();
    this.log(`desktop-provider recovered name=${logToken(primary.name)}`);
    const onChange = this.onChange;
    queueMicrotask(() => onChange?.({ kind: 'layout-changed' }));
  }
}
