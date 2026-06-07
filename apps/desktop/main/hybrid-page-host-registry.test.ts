/**
 * Unit tests for hybrid-page-host-registry.ts (P1.4a).
 *
 * The hybrid page-host path shipped window-reuse dedup (find-by-url /
 * find-by-key) and focus-group active-window tracking WITHOUT unit coverage.
 * These tests pin that contract down so the dedup behavior the window-open
 * handler relies on (ipc.ts ~1342 / ~1448) cannot silently regress.
 *
 * A `BaseWindow` / `WebContents` is never constructed here — the registry only
 * touches a tiny surface on each (`isDestroyed` / `isFocused` / `getBounds` /
 * `getURL` / `getTitle` / `on` / `once`), so cheap fakes that drive the same
 * events deterministically cover every path. The registry's own test hooks
 * (`_resetForTests`, `_runDeferredBlurForTests`, `_setActiveHybridWindowForTests`)
 * exist precisely so the `setImmediate`-deferred blur decision can be run
 * synchronously without real OS focus.
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import type { BaseWindow, WebContents } from 'electron';
import {
  _resetForTests,
  _runDeferredBlurForTests,
  _setActiveHybridWindowForTests,
  findHybridWindowByKey,
  findHybridWindowByUrl,
  getActiveHybridWindowBounds,
  getActiveHybridWindowId,
  getAllHybridWindows,
  getHybridContentWC,
  getHybridWindow,
  onActiveHybridWindowChange,
  registerHybridWindow,
  setOverlayFocusProvider,
} from './hybrid-page-host-registry.js';

type Handler = (...args: unknown[]) => void;

/**
 * Minimal on/once/emit emitter matching how the registry wires listeners.
 * `once` handlers fire exactly once then drop, mirroring EventEmitter.
 */
class FakeEmitter {
  private handlers = new Map<string, { cb: Handler; once: boolean }[]>();
  on(event: string, cb: Handler): this {
    const list = this.handlers.get(event) ?? [];
    list.push({ cb, once: false });
    this.handlers.set(event, list);
    return this;
  }
  once(event: string, cb: Handler): this {
    const list = this.handlers.get(event) ?? [];
    list.push({ cb, once: true });
    this.handlers.set(event, list);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    const list = this.handlers.get(event);
    if (!list) return;
    const keep: { cb: Handler; once: boolean }[] = [];
    // Snapshot first: a handler may register/cleanup during emit.
    for (const h of [...list]) {
      h.cb(...args);
      if (!h.once) keep.push(h);
    }
    this.handlers.set(event, keep);
  }
}

class FakeBaseWindow extends FakeEmitter {
  destroyed = false;
  focused = false;
  bounds = { x: 10, y: 20, width: 800, height: 600 };
  isDestroyed(): boolean {
    return this.destroyed;
  }
  isFocused(): boolean {
    return this.focused;
  }
  getBounds(): { x: number; y: number; width: number; height: number } {
    return this.bounds;
  }
}

class FakeWebContents extends FakeEmitter {
  destroyed = false;
  constructor(
    private url = '',
    private title = '',
  ) {
    super();
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  getURL(): string {
    return this.url;
  }
  getTitle(): string {
    return this.title;
  }
  navigate(url: string, title = ''): void {
    this.url = url;
    this.title = title;
  }
}

interface Fake {
  id: number;
  baseWin: FakeBaseWindow;
  wc: FakeWebContents;
}

let nextId = 1;

/** Build + register a hybrid window. Returns the fake handles. */
function mk(opts: { url?: string; title?: string; key?: string; focusedAtRegister?: boolean } = {}): Fake {
  const id = nextId++;
  const baseWin = new FakeBaseWindow();
  const wc = new FakeWebContents(opts.url ?? '', opts.title ?? '');
  if (opts.focusedAtRegister) baseWin.focused = true;
  registerHybridWindow(id, {
    baseWin: baseWin as unknown as BaseWindow,
    contentWC: wc as unknown as WebContents,
    key: opts.key,
    url: opts.url,
  });
  return { id, baseWin, wc };
}

/**
 * Make exactly `winner` the focused hybrid window (single-focus invariant the
 * OS enforces): blur the previously focused, focus the winner. Pass null to
 * blur all (focus left the group). `emitWinnerFocus:false` simulates the
 * platform edge case where the new window's 'focus' is missed but its
 * isFocused() is already true — the case decideAfterBlur's retarget covers.
 */
function focusOnly(all: Fake[], winner: Fake | null, opts: { emitWinnerFocus?: boolean } = {}): void {
  const emitWinnerFocus = opts.emitWinnerFocus ?? true;
  for (const f of all) {
    const wasFocused = f.baseWin.focused;
    const isWinner = winner != null && f.id === winner.id;
    f.baseWin.focused = isWinner;
    if (wasFocused && !isWinner) f.baseWin.emit('blur');
  }
  if (winner && emitWinnerFocus) winner.baseWin.emit('focus');
}

describe('hybrid-page-host-registry: registration + lookup', () => {
  beforeEach(() => {
    _resetForTests();
    nextId = 1;
  });

  it('getHybridWindow returns the registered entry with live url/title', () => {
    const f = mk({ url: 'https://example.com/', title: 'Example' });
    const entry = getHybridWindow(f.id);
    assert.ok(entry);
    assert.strictEqual(entry!.windowId, f.id);
    assert.strictEqual(entry!.url(), 'https://example.com/');
    assert.strictEqual(entry!.title(), 'Example');
  });

  it('url()/title() reflect later navigation, not the open-time url', () => {
    const f = mk({ url: 'https://example.com/' });
    f.wc.navigate('https://example.com/inner', 'Inner');
    const entry = getHybridWindow(f.id)!;
    assert.strictEqual(entry.url(), 'https://example.com/inner');
    assert.strictEqual(entry.title(), 'Inner');
  });

  it('getHybridWindow(unknownId) returns null', () => {
    assert.strictEqual(getHybridWindow(424242), null);
  });

  it('getAllHybridWindows enumerates every registered window', () => {
    mk({ url: 'https://a/' });
    mk({ url: 'https://b/' });
    assert.strictEqual(getAllHybridWindows().length, 2);
  });

  it('getHybridContentWC returns the content wc, null once destroyed', () => {
    const f = mk({ url: 'https://x/' });
    assert.strictEqual(getHybridContentWC(f.id), f.wc as unknown as WebContents);
    f.wc.destroyed = true;
    assert.strictEqual(getHybridContentWC(f.id), null);
  });

  it('re-registering the same id overwrites the prior entry', () => {
    const f = mk({ url: 'https://first/' });
    const wc2 = new FakeWebContents('https://second/');
    registerHybridWindow(f.id, {
      baseWin: f.baseWin as unknown as BaseWindow,
      contentWC: wc2 as unknown as WebContents,
    });
    assert.strictEqual(getAllHybridWindows().length, 1);
    assert.strictEqual(getHybridWindow(f.id)!.url(), 'https://second/');
  });
});

describe('hybrid-page-host-registry: self-cleanup', () => {
  beforeEach(() => {
    _resetForTests();
    nextId = 1;
  });

  it("baseWin 'closed' drops the entry", () => {
    const f = mk({ url: 'https://x/' });
    f.baseWin.emit('closed');
    assert.strictEqual(getHybridWindow(f.id), null);
    assert.strictEqual(getAllHybridWindows().length, 0);
  });

  it("content wc 'destroyed' drops the entry", () => {
    const f = mk({ url: 'https://x/' });
    f.wc.emit('destroyed');
    assert.strictEqual(getHybridWindow(f.id), null);
  });

  it("a stale 'closed' from a replaced window does not drop the live re-registration", () => {
    const f = mk({ url: 'https://first/' });
    const oldBase = f.baseWin;
    const wc2 = new FakeWebContents('https://second/');
    const newBase = new FakeBaseWindow();
    registerHybridWindow(f.id, {
      baseWin: newBase as unknown as BaseWindow,
      contentWC: wc2 as unknown as WebContents,
    });
    // The original window's late 'closed' must not evict the replacement.
    oldBase.emit('closed');
    assert.ok(getHybridWindow(f.id));
    assert.strictEqual(getHybridWindow(f.id)!.url(), 'https://second/');
  });
});

describe('hybrid-page-host-registry: dedup by url', () => {
  beforeEach(() => {
    _resetForTests();
    nextId = 1;
  });

  it('exact http url match returns the entry', () => {
    const f = mk({ url: 'https://example.com/page' });
    assert.strictEqual(findHybridWindowByUrl('https://example.com/page')!.windowId, f.id);
  });

  it('is trailing-slash tolerant', () => {
    const f = mk({ url: 'https://example.com/' });
    assert.strictEqual(findHybridWindowByUrl('https://example.com')!.windowId, f.id);
  });

  it('strips a lone trailing ? or # before matching', () => {
    const f = mk({ url: 'https://example.com/p' });
    assert.strictEqual(findHybridWindowByUrl('https://example.com/p?')!.windowId, f.id);
    assert.strictEqual(findHybridWindowByUrl('https://example.com/p#')!.windowId, f.id);
  });

  it('matches case-insensitively', () => {
    const f = mk({ url: 'https://Example.COM/Path' });
    assert.strictEqual(findHybridWindowByUrl('https://example.com/path')!.windowId, f.id);
  });

  it('dedups on the requested open address, surviving in-page navigation', () => {
    // The whole point of requested-address (not live-url) matching: a window
    // opened for X that then navigates/redirects to Y still dedups a repeat
    // open of X — and does NOT spuriously dedup an open of Y.
    const f = mk({ url: 'https://example.com/' });
    f.wc.navigate('https://example.com/deep/link');
    assert.strictEqual(findHybridWindowByUrl('https://example.com/')!.windowId, f.id);
    assert.strictEqual(findHybridWindowByUrl('https://example.com/deep/link'), null);
  });

  it('returns null for a non-matching url', () => {
    mk({ url: 'https://example.com/' });
    assert.strictEqual(findHybridWindowByUrl('https://other.com/'), null);
  });

  it('ignores non-http(s) and empty query urls (matches the canvas path)', () => {
    mk({ url: 'peek://app/page/index.html' });
    assert.strictEqual(findHybridWindowByUrl('peek://app/page/index.html'), null);
    assert.strictEqual(findHybridWindowByUrl('file:///tmp/x.html'), null);
    assert.strictEqual(findHybridWindowByUrl(''), null);
  });

  it('does not match a window registered without a requested url', () => {
    // makeWiredHybrid-style opener windows register no url → never dedup-match.
    mk({}); // no url
    assert.strictEqual(findHybridWindowByUrl('https://example.com/'), null);
  });

  it('skips a window whose host baseWin was destroyed', () => {
    const f = mk({ url: 'https://example.com/' });
    f.baseWin.destroyed = true;
    assert.strictEqual(findHybridWindowByUrl('https://example.com/'), null);
  });
});

describe('hybrid-page-host-registry: dedup by key', () => {
  beforeEach(() => {
    _resetForTests();
    nextId = 1;
  });

  it('returns the window registered with the key', () => {
    const f = mk({ url: 'https://x/', key: 'tab:7' });
    assert.strictEqual(findHybridWindowByKey('tab:7')!.windowId, f.id);
  });

  it('returns null for an empty key or an unknown key', () => {
    mk({ url: 'https://x/', key: 'tab:7' });
    assert.strictEqual(findHybridWindowByKey(''), null);
    assert.strictEqual(findHybridWindowByKey('tab:9'), null);
  });

  it('skips a window whose baseWin was destroyed', () => {
    const f = mk({ url: 'https://x/', key: 'tab:7' });
    f.baseWin.destroyed = true;
    assert.strictEqual(findHybridWindowByKey('tab:7'), null);
  });

  it('does not match on url (key lookup is key-only)', () => {
    mk({ url: 'https://x/', key: 'tab:7' });
    assert.strictEqual(findHybridWindowByKey('https://x/'), null);
  });
});

describe('hybrid-page-host-registry: active-window tracking', () => {
  beforeEach(() => {
    _resetForTests();
    nextId = 1;
  });

  it('starts with no active window', () => {
    assert.strictEqual(getActiveHybridWindowId(), null);
  });

  it('seeds active id when the window is already focused at registration', () => {
    const f = mk({ url: 'https://x/', focusedAtRegister: true });
    assert.strictEqual(getActiveHybridWindowId(), f.id);
  });

  it("baseWin 'focus' sets the active id and fires the change signal once", () => {
    const seen: (number | null)[] = [];
    const off = onActiveHybridWindowChange(id => seen.push(id));
    const f = mk({ url: 'https://x/' });
    focusOnly([f], f);
    assert.strictEqual(getActiveHybridWindowId(), f.id);
    assert.deepStrictEqual(seen, [f.id]);
    off();
  });

  it('content-wc focus is a fallback path to active (host focus missed)', () => {
    const f = mk({ url: 'https://x/' });
    f.baseWin.focused = true;
    f.wc.emit('focus');
    assert.strictEqual(getActiveHybridWindowId(), f.id);
  });

  it('getActiveHybridWindowBounds returns the active window outer bounds', () => {
    const f = mk({ url: 'https://x/' });
    focusOnly([f], f);
    assert.deepStrictEqual(getActiveHybridWindowBounds(), { x: 10, y: 20, width: 800, height: 600 });
  });

  it('reports null active (and bounds) once the active window is destroyed', () => {
    const f = mk({ url: 'https://x/' });
    focusOnly([f], f);
    f.baseWin.destroyed = true;
    assert.strictEqual(getActiveHybridWindowId(), null);
    assert.strictEqual(getActiveHybridWindowBounds(), null);
  });

  it("closing the active window nulls active and fires the change signal", () => {
    const seen: (number | null)[] = [];
    const f = mk({ url: 'https://x/' });
    focusOnly([f], f);
    const off = onActiveHybridWindowChange(id => seen.push(id));
    f.baseWin.emit('closed');
    assert.strictEqual(getActiveHybridWindowId(), null);
    assert.deepStrictEqual(seen, [null]);
    off();
  });

  it('_setActiveHybridWindowForTests rejects an unregistered id', () => {
    assert.strictEqual(_setActiveHybridWindowForTests(999), false);
    const f = mk({ url: 'https://x/' });
    assert.strictEqual(_setActiveHybridWindowForTests(f.id), true);
    assert.strictEqual(getActiveHybridWindowId(), f.id);
    assert.strictEqual(_setActiveHybridWindowForTests(null), true);
    assert.strictEqual(getActiveHybridWindowId(), null);
  });
});

describe('hybrid-page-host-registry: focus-group deferred blur', () => {
  beforeEach(() => {
    _resetForTests();
    nextId = 1;
    setOverlayFocusProvider(null);
  });

  it("blur alone does NOT immediately deactivate (decision is deferred)", () => {
    const f = mk({ url: 'https://x/' });
    focusOnly([f], f);
    // Blur with nothing else focused, but BEFORE the deferred tick runs.
    f.baseWin.focused = false;
    f.baseWin.emit('blur');
    assert.strictEqual(getActiveHybridWindowId(), f.id, 'stays active until the deferred decision');
  });

  it('focus landing on the overlay keeps the content window active', () => {
    const f = mk({ url: 'https://x/' });
    focusOnly([f], f);
    setOverlayFocusProvider(() => true); // overlay is now key
    f.baseWin.focused = false;
    f.baseWin.emit('blur');
    assert.strictEqual(_runDeferredBlurForTests(f.id), f.id);
  });

  it('focus leaving the whole group (no overlay, no hybrid) deactivates', () => {
    const f = mk({ url: 'https://x/' });
    focusOnly([f], f);
    setOverlayFocusProvider(() => false);
    f.baseWin.focused = false;
    f.baseWin.emit('blur');
    assert.strictEqual(_runDeferredBlurForTests(f.id), null);
  });

  it('a real switch to another hybrid retargets active to it', () => {
    const a = mk({ url: 'https://a/' });
    const b = mk({ url: 'https://b/' });
    focusOnly([a, b], a);
    assert.strictEqual(getActiveHybridWindowId(), a.id);
    // Real switch: b's own focus fires, which sets active to b directly.
    focusOnly([a, b], b);
    assert.strictEqual(getActiveHybridWindowId(), b.id);
    // a's deferred decision is now a no-op (active already moved off a).
    assert.strictEqual(_runDeferredBlurForTests(a.id), b.id);
  });

  it("retargets to a focused hybrid even when that window's focus event was missed", () => {
    const a = mk({ url: 'https://a/' });
    const b = mk({ url: 'https://b/' });
    focusOnly([a, b], a);
    // Platform edge: b becomes focused but its 'focus' never fired, so active
    // is still a. The deferred decision must discover b via isFocused().
    focusOnly([a, b], b, { emitWinnerFocus: false });
    assert.strictEqual(getActiveHybridWindowId(), a.id, 'still a — b focus was missed');
    assert.strictEqual(_runDeferredBlurForTests(a.id), b.id);
  });

  it('a re-focus before the deferred tick cancels the stale deactivation', () => {
    const f = mk({ url: 'https://x/' });
    focusOnly([f], f);
    // Focus bounces out then back within one tick (e.g. content→overlay→content).
    f.baseWin.focused = false;
    f.baseWin.emit('blur');
    focusOnly([f], f); // re-focus cancels the pending blur check
    // No pending decision remains → still active.
    assert.strictEqual(_runDeferredBlurForTests(f.id), f.id);
    assert.strictEqual(getActiveHybridWindowId(), f.id);
  });

  it('an overlay-focus provider that throws falls through to deactivate', () => {
    const f = mk({ url: 'https://x/' });
    focusOnly([f], f);
    setOverlayFocusProvider(() => {
      throw new Error('provider boom');
    });
    f.baseWin.focused = false;
    f.baseWin.emit('blur');
    assert.strictEqual(_runDeferredBlurForTests(f.id), null);
  });
});
