/**
 * Unit tests for local-feature-watch.ts: a change in a watched feature folder
 * reloads that feature once after the debounce, noise is ignored, reloads of
 * one feature never overlap, and sync() starts and stops watches to match the
 * feature list. The folder-watch port and the timers are fakes.
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';

import { LocalFeatureWatcher, isIgnoredChange, type FolderWatchPort } from './local-feature-watch.js';

class FakePort implements FolderWatchPort {
  listeners = new Map<string, (rel: string | null) => void>();
  closed: string[] = [];
  watch(dir: string, onChange: (rel: string | null) => void) {
    this.listeners.set(dir, onChange);
    return { close: () => { this.closed.push(dir); this.listeners.delete(dir); } };
  }
  change(dir: string, rel: string | null) {
    this.listeners.get(dir)?.(rel);
  }
}

class FakeTimers {
  private next = 1;
  pending = new Map<number, () => void>();
  set = (fn: () => void) => { const h = this.next++; this.pending.set(h, fn); return h; };
  clear = (h: unknown) => { this.pending.delete(h as number); };
  fireAll() {
    const fns = [...this.pending.values()];
    this.pending.clear();
    for (const fn of fns) fn();
  }
}

const flush = () => new Promise(resolve => setImmediate(resolve));

describe('isIgnoredChange', () => {
  it('ignores version control, worktrees, dependencies, dotfiles and editor files', () => {
    for (const p of ['.git/index', '.worktrees/a/run.js', 'node_modules/x/y.js', '.DS_Store', 'run.js~', '.run.js.swp', 'a/b.tmp']) {
      assert.strictEqual(isIgnoredChange(p), true, p);
    }
  });
  it('keeps feature files and unknown paths', () => {
    for (const p of ['manifest.json', 'run.js', 'sub/page.html', null]) {
      assert.strictEqual(isIgnoredChange(p), false, String(p));
    }
  });
});

describe('LocalFeatureWatcher', () => {
  let port: FakePort;
  let timers: FakeTimers;
  let reloads: string[];
  let watcher: LocalFeatureWatcher;

  beforeEach(() => {
    port = new FakePort();
    timers = new FakeTimers();
    reloads = [];
    watcher = new LocalFeatureWatcher({
      port,
      reload: id => { reloads.push(id); },
      setTimer: timers.set,
      clearTimer: timers.clear,
    });
  });

  it('reloads once for a burst of changes, after the debounce', async () => {
    watcher.sync([{ id: 'vat', path: '/f/vat' }]);
    port.change('/f/vat', 'run.js');
    port.change('/f/vat', 'run.html');
    port.change('/f/vat', 'manifest.json');
    assert.deepStrictEqual(reloads, []);
    assert.strictEqual(timers.pending.size, 1);
    timers.fireAll();
    await flush();
    assert.deepStrictEqual(reloads, ['vat']);
  });

  it('does not reload for ignored changes', async () => {
    watcher.sync([{ id: 'vat', path: '/f/vat' }]);
    port.change('/f/vat', '.git/HEAD');
    port.change('/f/vat', '.DS_Store');
    assert.strictEqual(timers.pending.size, 0);
  });

  it('queues exactly one more reload for changes during a reload', async () => {
    let release!: () => void;
    const started: string[] = [];
    watcher = new LocalFeatureWatcher({
      port,
      reload: id => { started.push(id); return new Promise<void>(r => { release = r; }); },
      setTimer: timers.set,
      clearTimer: timers.clear,
    });
    watcher.sync([{ id: 'vat', path: '/f/vat' }]);
    port.change('/f/vat', 'run.js');
    timers.fireAll();
    await flush();
    assert.strictEqual(started.length, 1);

    port.change('/f/vat', 'run.js');
    timers.fireAll();
    port.change('/f/vat', 'run.html');
    timers.fireAll();
    await flush();
    assert.strictEqual(started.length, 1, 'no overlapping reload');

    release();
    await flush();
    assert.strictEqual(started.length, 2, 'one queued reload after the first');
    release();
    await flush();
    assert.strictEqual(started.length, 2);
  });

  it('keeps watching after a reload throws', async () => {
    watcher = new LocalFeatureWatcher({
      port,
      reload: id => { reloads.push(id); throw new Error('boom'); },
      setTimer: timers.set,
      clearTimer: timers.clear,
    });
    watcher.sync([{ id: 'vat', path: '/f/vat' }]);
    port.change('/f/vat', 'run.js');
    timers.fireAll();
    await flush();
    port.change('/f/vat', 'run.js');
    timers.fireAll();
    await flush();
    assert.deepStrictEqual(reloads, ['vat', 'vat']);
  });

  it('sync starts new watches, stops dropped ones and re-watches a moved folder', () => {
    watcher.sync([{ id: 'a', path: '/f/a' }, { id: 'b', path: '/f/b' }]);
    assert.deepStrictEqual(watcher.watching().sort(), ['a', 'b']);

    watcher.sync([{ id: 'a', path: '/f/a2' }]);
    assert.deepStrictEqual(watcher.watching(), ['a']);
    assert.deepStrictEqual(port.closed.sort(), ['/f/a', '/f/b']);
    assert.ok(port.listeners.has('/f/a2'));
  });

  it('a stopped feature does not reload from a pending change', async () => {
    watcher.sync([{ id: 'vat', path: '/f/vat' }]);
    port.change('/f/vat', 'run.js');
    watcher.sync([]);
    assert.strictEqual(timers.pending.size, 0);
    timers.fireAll();
    await flush();
    assert.deepStrictEqual(reloads, []);
  });
});
