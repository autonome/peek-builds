/**
 * Process → tile → window CPU/memory attribution.
 *
 * Answers the question that took ~15 manual steps to answer by hand during the
 * 2026-06-25 prod CPU dig (peek `c2bad3fc`): "which OS process is hot, and what
 * Peek tile / window is it?" — by joining `app.getAppMetrics()` (per-OS-process
 * CPU + memory) to every live `webContents` via `webContents.getOSProcessId()`,
 * then attributing each webContents to a tile-id (parsed from its peek:// URL)
 * and its owning window (BrowserWindow OR hybrid BaseWindow page-host).
 *
 * Consumed by:
 *   - the `debug-app-metrics` CLI verb (cli-router.ts) — one-shot inspection
 *   - the background CPU watchdog (cpu-watch.ts) — auto-logs the culprit when a
 *     process sustains high CPU, so a hot Peek is self-attributing in main.log
 *     with no live debugging.
 *   - the `tile:app:metrics` IPC (tile-ipc.ts) — aggregate memory for the
 *     memory HUD, via `summarizeMemory`.
 *
 * The join itself (`joinMetrics`) is a pure function over plain data so it is
 * unit-testable under ELECTRON_RUN_AS_NODE=1. Electron access goes through
 * `createRequire` (mirroring window-registry.ts) so importing this module in a
 * unit test doesn't force a static `electron` value import at parse time.
 */

import type { WebContents, BrowserWindow as BrowserWindowType } from 'electron';
import { createRequire } from 'node:module';
import {
  getAllHybridWindows,
} from './hybrid-page-host-registry.js';

const requireElectron = createRequire(import.meta.url);
let _electron: typeof import('electron') | null = null;
function getElectron(): typeof import('electron') | null {
  if (_electron) return _electron;
  const e = requireElectron('electron');
  if (typeof e !== 'object' || e === null) return null; // ELECTRON_RUN_AS_NODE
  _electron = e as typeof import('electron');
  return _electron;
}

// ─── Shapes ──────────────────────────────────────────────────────────────────

/** One live webContents, flattened to the plain fields the join needs. */
export interface WcDescriptor {
  webContentsId: number;
  osProcessId: number;
  /** Live URL (peek://… for tiles, http(s)://… for hybrid page-host content). */
  url: string;
  /** webContents.getType() — 'window' | 'webview' | 'browserView' | 'remote' | 'backgroundPage' | … */
  wcType: string;
  /** Tile id parsed from a peek:// URL, else null (web pages, blank, devtools). */
  tileId: string | null;
  windowId: number | null;
  windowTitle: string;
  /** Shown and not minimized. NOTE: does not detect occlusion — a visible-but-
   *  covered window still reports true here. visibilityState (async, renderer
   *  round-trip) is the precise throttle signal; see enrichVisibilityState. */
  visible: boolean;
  focused: boolean;
  hybrid: boolean;
}

/** One OS process, flattened from an Electron ProcessMetric. */
export interface ProcMetric {
  pid: number;
  /** ProcessMetric.type — 'Browser' | 'Tab' | 'GPU' | 'Utility' | 'Zygote' | … */
  procType: string;
  name?: string;
  serviceName?: string;
  percentCpu: number;
  /** workingSetSize, kilobytes (as Electron reports it). */
  memoryKb: number;
}

/** A process metric with its attributed webContents (0..n). */
export interface AttributedProcess extends ProcMetric {
  tiles: WcDescriptor[];
}

// ─── Pure join + parsing ───────────────────────────────────────────────────────

/**
 * Parse the tile id out of a peek:// URL. `peek://editor/home.html?x=1` →
 * `editor`. Returns null for non-peek URLs (web pages on a hybrid host, blank,
 * devtools://, chrome-extension://) — those are attributed by their raw URL.
 */
export function parseTileIdFromUrl(url: string): string | null {
  if (typeof url !== 'string') return null;
  const m = /^peek:\/\/([^/?#]+)/i.exec(url);
  return m ? m[1] : null;
}

/**
 * Join process metrics to webContents descriptors by OS pid. Pure — no Electron
 * access — so it is unit-testable. Each process carries every webContents whose
 * `osProcessId` matches its `pid`. Result is sorted by CPU descending.
 */
export function joinMetrics(
  metrics: ProcMetric[],
  wcs: WcDescriptor[],
): AttributedProcess[] {
  const byPid = new Map<number, WcDescriptor[]>();
  for (const wc of wcs) {
    const list = byPid.get(wc.osProcessId);
    if (list) list.push(wc);
    else byPid.set(wc.osProcessId, [wc]);
  }
  return metrics
    .map(m => ({ ...m, tiles: byPid.get(m.pid) ?? [] }))
    .sort((a, b) => b.percentCpu - a.percentCpu);
}

/** Aggregate memory across every Peek process (main, renderers, GPU, utility). */
export interface MemorySummary {
  /** Sum of every process's working set, kilobytes. */
  totalKb: number;
  processCount: number;
  /** Kilobytes per ProcessMetric type ('Browser', 'Tab', 'GPU', …). */
  byType: Record<string, number>;
}

/**
 * Sum process memory into one total plus a per-process-type breakdown. Pure.
 * A missing, non-finite or negative figure counts as zero so one odd process
 * can't poison the total; the process is still counted.
 */
export function summarizeMemory(metrics: ProcMetric[]): MemorySummary {
  let totalKb = 0;
  const byType: Record<string, number> = {};
  for (const m of metrics) {
    const kb = Number.isFinite(m.memoryKb) && m.memoryKb > 0 ? m.memoryKb : 0;
    const type = m.procType || 'unknown';
    totalKb += kb;
    byType[type] = (byType[type] ?? 0) + kb;
  }
  return { totalKb, processCount: metrics.length, byType };
}

// ─── Electron-side collection ──────────────────────────────────────────────────

/**
 * Enumerate every live webContents and flatten it to a WcDescriptor, resolving
 * its owning window (BrowserWindow first, then the hybrid page-host registry for
 * WebContentsView content). Returns [] under ELECTRON_RUN_AS_NODE.
 */
export function gatherWebContents(): WcDescriptor[] {
  const electron = getElectron();
  if (!electron) return [];
  const { webContents: allWC, BrowserWindow } = electron;

  // Map hybrid content-WC id → its registry entry (BaseWindow page-hosts are
  // invisible to BrowserWindow.fromWebContents).
  const hybridByWcId = new Map<number, ReturnType<typeof getAllHybridWindows>[number]>();
  for (const h of getAllHybridWindows()) {
    if (!h.contentWC.isDestroyed()) hybridByWcId.set(h.contentWC.id, h);
  }

  const out: WcDescriptor[] = [];
  for (const wc of allWC.getAllWebContents()) {
    if (wc.isDestroyed()) continue;

    const url = safe(() => wc.getURL(), '');
    const wcType = safe(() => wc.getType(), 'unknown');
    const osProcessId = safe(() => wc.getOSProcessId(), 0);

    let windowId: number | null = null;
    let windowTitle = '';
    let visible = false;
    let focused = false;
    let hybrid = false;

    const ownerWin: BrowserWindowType | null = safe(
      () => BrowserWindow.fromWebContents(wc) ?? null,
      null,
    );
    if (ownerWin && !ownerWin.isDestroyed()) {
      windowId = ownerWin.id;
      windowTitle = safe(() => ownerWin.getTitle(), '');
      visible = safe(() => ownerWin.isVisible() && !ownerWin.isMinimized(), false);
      focused = safe(() => ownerWin.isFocused(), false);
    } else {
      const h = hybridByWcId.get(wc.id);
      if (h) {
        hybrid = true;
        windowId = h.windowId;
        windowTitle = safe(() => h.title(), '');
        visible = safe(() => h.baseWin.isVisible() && !h.baseWin.isMinimized(), false);
        focused = safe(() => h.baseWin.isFocused(), false);
      }
    }

    out.push({
      webContentsId: wc.id,
      osProcessId,
      url,
      wcType,
      tileId: parseTileIdFromUrl(url),
      windowId,
      windowTitle,
      visible,
      focused,
      hybrid,
    });
  }
  return out;
}

/**
 * Read `app.getAppMetrics()` and flatten to ProcMetric[]. [] under
 * ELECTRON_RUN_AS_NODE.
 */
export function gatherProcessMetrics(): ProcMetric[] {
  const electron = getElectron();
  if (!electron) return [];
  return electron.app.getAppMetrics().map(m => ({
    pid: m.pid,
    procType: m.type,
    name: m.name,
    serviceName: m.serviceName,
    percentCpu: m.cpu?.percentCPUUsage ?? 0,
    memoryKb: m.memory?.workingSetSize ?? 0,
  }));
}

/**
 * One-shot snapshot: per-OS-process CPU + memory, each joined to the tiles /
 * windows it hosts, sorted by CPU descending. Cheap and synchronous (no
 * renderer round-trip). [] under ELECTRON_RUN_AS_NODE.
 */
export function collectProcessMetrics(): AttributedProcess[] {
  return joinMetrics(gatherProcessMetrics(), gatherWebContents());
}

/**
 * Best-effort overlay: ask the named webContents for `document.visibilityState`
 * ('visible' | 'hidden'), the precise rAF-throttle signal that `visible` (window
 * shown) can't see (an occluded foreground window throttles like a hidden one).
 * Each probe is raced against `timeoutMs` because a busy/hot renderer can be slow
 * to answer; a timeout or error yields 'unknown'. Returns a map keyed by
 * webContentsId. Only the ids passed in are probed (callers pass just the hot
 * ones — this is a renderer round-trip, not free).
 */
export async function probeVisibilityState(
  webContentsIds: number[],
  timeoutMs = 250,
): Promise<Map<number, string>> {
  const electron = getElectron();
  const result = new Map<number, string>();
  if (!electron) return result;
  const { webContents: allWC } = electron;
  await Promise.all(
    webContentsIds.map(async id => {
      const wc = allWC.fromId(id);
      if (!wc || wc.isDestroyed()) {
        result.set(id, 'gone');
        return;
      }
      try {
        const state = await raceTimeout(
          wc.executeJavaScript('document.visibilityState', false) as Promise<string>,
          timeoutMs,
        );
        result.set(id, typeof state === 'string' ? state : 'unknown');
      } catch {
        result.set(id, 'unknown');
      }
    }),
  );
  return result;
}

// ─── helpers ───────────────────────────────────────────────────────────────────

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), ms).unref?.(),
    ),
  ]);
}
