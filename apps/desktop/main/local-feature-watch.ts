/**
 * Folder watching for features installed from a local folder (`source.type`
 * `local`): an edit to any file in the folder reloads the feature, so working
 * on a feature needs no app restart.
 *
 * This module only decides WHEN to reload: one watch per feature folder,
 * changes debounced, version-control and editor noise ignored, and reloads of
 * one feature never overlapping (a change during a reload queues exactly one
 * more). WHAT a reload does — unload, re-check approval, re-arm — is the
 * injected `reload` callback (`tile-ipc.ts reloadLocalFeature()`), so a
 * capability expansion still blocks the feature until it is approved again.
 *
 * Electron-free, so the unit test drives it with a fake folder-watch port and
 * fake timers.
 */

import fs from 'node:fs';
import path from 'node:path';

/** A feature folder to watch. */
export interface WatchedFeature {
  id: string;
  path: string;
}

/** Watches one folder recursively; `relPath` is relative to it, or null if unknown. */
export interface FolderWatchPort {
  watch(dir: string, onChange: (relPath: string | null) => void): { close(): void };
}

export interface LocalFeatureWatcherOptions {
  port: FolderWatchPort;
  reload: (featureId: string) => unknown;
  debounceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export const DEFAULT_RELOAD_DEBOUNCE_MS = 300;

const IGNORED_DIRS = new Set(['.git', '.worktrees', 'node_modules']);

/**
 * Whether a change can be ignored: anything under a version-control, worktree
 * or dependency folder, a dotfile (`.DS_Store`), or an editor swap or backup
 * file. An unknown path (null) is not ignored.
 */
export function isIgnoredChange(relPath: string | null): boolean {
  if (relPath === null) return false;
  const parts = relPath.split(/[\\/]/).filter(Boolean);
  if (parts.some(p => IGNORED_DIRS.has(p))) return true;
  const base = parts[parts.length - 1] ?? '';
  return base.startsWith('.') || base.endsWith('~') || /\.(swp|swx|tmp)$/.test(base);
}

interface Watch {
  path: string;
  handle: { close(): void };
  timer: unknown;
  running: boolean;
  pending: boolean;
}

export class LocalFeatureWatcher {
  private readonly watches = new Map<string, Watch>();
  private readonly debounceMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: LocalFeatureWatcherOptions) {
    this.debounceMs = options.debounceMs ?? DEFAULT_RELOAD_DEBOUNCE_MS;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? (h => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Watch exactly these features: start new ones, stop dropped ones, re-watch a moved folder. */
  sync(features: WatchedFeature[]): void {
    const wanted = new Map(features.map(f => [f.id, f.path]));
    for (const [id, w] of this.watches) {
      if (wanted.get(id) !== w.path) this.stop(id);
    }
    for (const [id, dir] of wanted) {
      if (this.watches.has(id)) continue;
      try {
        const handle = this.options.port.watch(dir, rel => this.onChange(id, rel));
        this.watches.set(id, { path: dir, handle, timer: null, running: false, pending: false });
      } catch (err) {
        console.error(`[local-feature-watch] Cannot watch ${id} at ${dir}:`, err);
      }
    }
  }

  /** Feature ids being watched. */
  watching(): string[] {
    return [...this.watches.keys()];
  }

  closeAll(): void {
    for (const id of [...this.watches.keys()]) this.stop(id);
  }

  private stop(id: string): void {
    const w = this.watches.get(id);
    if (!w) return;
    if (w.timer !== null) this.clearTimer(w.timer);
    w.handle.close();
    this.watches.delete(id);
  }

  private onChange(id: string, relPath: string | null): void {
    if (isIgnoredChange(relPath)) return;
    const w = this.watches.get(id);
    if (!w) return;
    if (w.timer !== null) this.clearTimer(w.timer);
    w.timer = this.setTimer(() => {
      w.timer = null;
      void this.run(id, w);
    }, this.debounceMs);
  }

  private async run(id: string, w: Watch): Promise<void> {
    if (w.running) {
      w.pending = true;
      return;
    }
    w.running = true;
    try {
      await this.options.reload(id);
    } catch (err) {
      console.error(`[local-feature-watch] Reload of ${id} failed:`, err);
    } finally {
      w.running = false;
    }
    if (w.pending && this.watches.get(id) === w) {
      w.pending = false;
      await this.run(id, w);
    }
  }
}

/** The real port: `fs.watch` recursive, which macOS and Linux both support. */
export const nodeFolderWatchPort: FolderWatchPort = {
  watch(dir, onChange) {
    const watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
      onChange(filename ? path.normalize(filename.toString()) : null);
    });
    watcher.on('error', err => console.error(`[local-feature-watch] Watch error in ${dir}:`, err));
    return { close: () => watcher.close() };
  },
};
