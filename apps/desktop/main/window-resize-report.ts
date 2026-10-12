// Tells the tile that opened a window when that window has been resized and the
// resize has settled, so a feature can keep a window's size across restarts
// (slides per edge, peeks per key). Fed from the kernel's own window records —
// the `bounds` the backend reports on every native resize — so nothing here
// knows which backend drew the window.
//
// One report per gesture: a resize emits bounds at native-event frequency, so a
// report waits `delayMs` after the last size change of that window. A move
// alone never reports (width and height unchanged), and neither does the first
// size a window is seen with — that is the size it was opened at, not one the
// user chose. A maximized or fullscreen window does not report: that size
// belongs to the screen, not to the window. Only a window opened with a `key`
// reports, since the key is what the opener files the size under.
import type { WindowId } from './window-kernel.js';

export interface ResizeReportRecord {
  id: WindowId;
  bounds?: { width: number; height: number };
  maximized: boolean;
  fsMode: { name: string };
}

export interface ResizeReport {
  id: WindowId;
  source: string;
  key: string;
  width: number;
  height: number;
}

export interface ResizeReporterDeps {
  delayMs: number;
  // The window's opening source and its open `key`, or undefined when the
  // window carries no open payload (tile and infrastructure windows).
  lookupOpener: (id: WindowId) => { source: string; key?: unknown } | undefined;
  send: (report: ResizeReport) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface ResizeReporter {
  observe: (records: readonly ResizeReportRecord[]) => void;
}

export function createResizeReporter(deps: ResizeReporterDeps): ResizeReporter {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const lastSize = new Map<WindowId, { width: number; height: number }>();
  const timers = new Map<WindowId, unknown>();

  const cancel = (id: WindowId): void => {
    const t = timers.get(id);
    if (t !== undefined) {
      clearTimer(t);
      timers.delete(id);
    }
  };

  const fire = (id: WindowId, width: number, height: number): void => {
    timers.delete(id);
    const opener = deps.lookupOpener(id);
    if (!opener || typeof opener.key !== 'string' || opener.key === '') return;
    deps.send({ id, source: opener.source, key: opener.key, width, height });
  };

  return {
    observe(records) {
      const seen = new Set<WindowId>();
      for (const r of records) {
        seen.add(r.id);
        if (!r.bounds) continue;
        const { width, height } = r.bounds;
        const prev = lastSize.get(r.id);
        lastSize.set(r.id, { width, height });
        if (!prev || (prev.width === width && prev.height === height)) continue;
        cancel(r.id);
        if (r.maximized || r.fsMode.name !== 'normal') continue;
        timers.set(r.id, setTimer(() => fire(r.id, width, height), deps.delayMs));
      }
      for (const id of [...lastSize.keys()]) {
        if (seen.has(id)) continue;
        lastSize.delete(id);
        cancel(id);
      }
    },
  };
}
