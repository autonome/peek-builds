/**
 * Background CPU watchdog.
 *
 * Samples per-OS-process CPU on an interval (via process-metrics.ts) and, when a
 * process sustains CPU above a threshold, logs ONE attributed line per hot
 * process to console — which main-log.ts mirrors to `<userData>/logs/main.log`.
 * The point: a hot Peek in production self-attributes ("which tile/window is
 * burning CPU") in the log with no live debugging, so the culprit can be read
 * off `tail -f main.log` instead of reverse-engineered from `ps`/`top` cmdlines.
 *
 * Born from the 2026-06-25 prod CPU dig (peek `c2bad3fc` / `2f24e384`): the burn
 * ROTATES across visible editor tiles as window focus changes, so a single
 * snapshot misses it — a continuous sampler is what catches the intermittent
 * spike the user still reports after the per-frame getContent() poll fix.
 *
 * Defaults: ON in non-headless builds. Tunable / disable via env:
 *   PEEK_CPU_WATCH=0                 disable entirely
 *   PEEK_CPU_WATCH_INTERVAL_MS=15000 sample period
 *   PEEK_CPU_WATCH_THRESHOLD=10      percent-CPU that counts as "hot"
 *   PEEK_CPU_WATCH_HEARTBEAT=20      every Nth tick, log the top process even if
 *                                    cold (0 disables the heartbeat)
 *
 * Threshold calibration: app.getAppMetrics() percentCPUUsage is a real percent
 * (~100 = one full core), measured live — idle renderers sit ~0.1%, a renderer
 * at boot ~9%. The rotating editor-tile burn this whole effort chases was ~3%
 * PER (per-process) tile, so the default is set low (10%) to catch a sustained
 * single-process burn while staying ~100x above idle noise; tune down in prod
 * via PEEK_CPU_WATCH_THRESHOLD if a subtler burn needs catching.
 */

import {
  collectProcessMetrics,
  probeVisibilityState,
  type AttributedProcess,
  type WcDescriptor,
} from './process-metrics.js';

export interface CpuWatchConfig {
  enabled: boolean;
  intervalMs: number;
  thresholdPct: number;
  /** Log the top process every Nth tick regardless of threshold. 0 = off. */
  heartbeatEvery: number;
}

const DEFAULTS: CpuWatchConfig = {
  enabled: true,
  intervalMs: 15_000,
  thresholdPct: 10,
  heartbeatEvery: 20,
};

/**
 * Resolve config from an env bag (pure — testable). An explicit
 * `PEEK_CPU_WATCH=0` disables; bad/missing numeric overrides fall back to
 * defaults.
 */
export function resolveConfig(env: Record<string, string | undefined>): CpuWatchConfig {
  return {
    enabled: env.PEEK_CPU_WATCH !== '0',
    intervalMs: posIntOr(env.PEEK_CPU_WATCH_INTERVAL_MS, DEFAULTS.intervalMs),
    thresholdPct: posNumOr(env.PEEK_CPU_WATCH_THRESHOLD, DEFAULTS.thresholdPct),
    heartbeatEvery: nonNegIntOr(env.PEEK_CPU_WATCH_HEARTBEAT, DEFAULTS.heartbeatEvery),
  };
}

function posIntOr(v: string | undefined, fallback: number): number {
  const n = v === undefined ? NaN : Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function posNumOr(v: string | undefined, fallback: number): number {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nonNegIntOr(v: string | undefined, fallback: number): number {
  const n = v === undefined ? NaN : Number(v);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/**
 * Format one attributed process as a single greppable log line. `visState` maps
 * webContentsId → document.visibilityState ('visible'|'hidden'|…) when probed.
 * Pure — testable without Electron.
 */
export function formatProcessLine(
  proc: AttributedProcess,
  visState?: Map<number, string>,
): string {
  const head =
    `pid=${proc.pid} type=${proc.procType} cpu=${proc.percentCpu.toFixed(1)}% ` +
    `mem=${(proc.memoryKb / 1024).toFixed(0)}MB`;
  if (proc.tiles.length === 0) {
    const label = proc.serviceName || proc.name || proc.procType;
    return `${head} (${label}, no webContents)`;
  }
  return `${head} → ${proc.tiles.map(t => formatTile(t, visState)).join(' | ')}`;
}

function formatTile(t: WcDescriptor, visState?: Map<number, string>): string {
  const attribution = t.tileId
    ? `tile=${t.tileId}`
    : `url=${t.url || '(blank)'}`;
  const win = t.windowId !== null
    ? ` win=#${t.windowId}${t.windowTitle ? ` "${t.windowTitle}"` : ''}`
    : '';
  const vs = visState?.get(t.webContentsId);
  const flags = [
    t.hybrid ? 'hybrid' : '',
    `vis=${t.visible}`,
    vs ? `visState=${vs}` : '',
    t.focused ? 'focused' : '',
  ].filter(Boolean).join(' ');
  // Include the full URL for tiles too — itemId etc. is the real identity.
  const urlPart = t.tileId ? ` url=${t.url}` : '';
  return `${attribution}${urlPart} wc=${t.webContentsId}${win} ${flags}`.trim();
}

// ─── runtime ───────────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;
let tick = 0;

/**
 * Start the watchdog. No-op if disabled by config or already running. The caller
 * is responsible for not starting it in headless/test runs (entry.ts gates on
 * isHeadless()).
 */
export function startCpuWatch(env: Record<string, string | undefined> = process.env): void {
  if (timer) return;
  const cfg = resolveConfig(env);
  if (!cfg.enabled) return;

  console.log(
    `[cpu-watch] started: interval=${cfg.intervalMs}ms threshold=${cfg.thresholdPct}% ` +
    `heartbeat=every ${cfg.heartbeatEvery} ticks`,
  );

  timer = setInterval(() => {
    void sample(cfg);
  }, cfg.intervalMs);
  timer.unref?.();
}

/** Stop the watchdog (test teardown / pref toggle). */
export function stopCpuWatch(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function sample(cfg: CpuWatchConfig): Promise<void> {
  tick++;
  let procs: AttributedProcess[];
  try {
    procs = collectProcessMetrics();
  } catch (err) {
    console.error('[cpu-watch] sample failed:', err);
    return;
  }
  if (procs.length === 0) return;

  const hot = procs.filter(p => p.percentCpu >= cfg.thresholdPct);

  if (hot.length > 0) {
    // Probe the precise throttle state for the hot processes' tiles only —
    // a renderer round-trip, so we don't do it for the whole snapshot.
    const hotWcIds = hot.flatMap(p => p.tiles.map(t => t.webContentsId));
    const visState = hotWcIds.length > 0
      ? await probeVisibilityState(hotWcIds).catch(() => undefined)
      : undefined;
    for (const p of hot) {
      console.warn(`[cpu-watch] HOT ${formatProcessLine(p, visState)}`);
    }
    return;
  }

  if (cfg.heartbeatEvery > 0 && tick % cfg.heartbeatEvery === 0) {
    console.log(`[cpu-watch] heartbeat top: ${formatProcessLine(procs[0])}`);
  }
}

/** Test seam: reset tick counter + timer state. */
export function _resetForTests(): void {
  stopCpuWatch();
  tick = 0;
}
