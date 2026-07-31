/**
 * Unit tests for hybrid-page-host-registry.ts (P1.4a).
 *
 * The hybrid page-host path shipped window-reuse dedup (find-by-url /
 * find-by-key) WITHOUT unit coverage. These tests pin that contract down so
 * the dedup behavior the window-open handler relies on (ipc.ts ~1342 / ~1448)
 * cannot silently regress.
 *
 * Active-window / focus-group / native-fullscreen tracking has moved to the
 * window-state machine (window-state.test.ts) — this file covers object
 * lifecycle/lookup/dedup only.
 *
 * A `BaseWindow` / `WebContents` is never constructed here — the registry only
 * touches a tiny surface on each (`isDestroyed` / `isFocused` / `getBounds` /
 * `getURL` / `getTitle` / `on` / `once`), so cheap fakes that drive the same
 * events deterministically cover every path.
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import type { BaseWindow, WebContents } from 'electron';
import {
  _resetForTests,
  findHybridWindowByKey,
  findHybridWindowByUrl,
  getAllHybridWindows,
  getHybridContentWC,
  getHybridWindow,
  getHybridWindowByContentWC,
  registerHybridWindow,
  markHybridPainted,
  hasHybridPainted,
  unregisterHybridWindow,
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
function mk(opts: { url?: string; title?: string; key?: string } = {}): Fake {
  const id = nextId++;
  const baseWin = new FakeBaseWindow();
  const wc = new FakeWebContents(opts.url ?? '', opts.title ?? '');
  registerHybridWindow(id, {
    baseWin: baseWin as unknown as BaseWindow,
    contentWC: wc as unknown as WebContents,
    key: opts.key,
    url: opts.url,
  });
  return { id, baseWin, wc };
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

  it('matches host case-insensitively (path case is significant — canvas/datastore parity)', () => {
    // Host is case-insensitive per URL spec; path is NOT (servers may serve
    // different resources for /Path vs /path), matching datastore.normalizeUrl.
    const f = mk({ url: 'https://Example.COM/Path' });
    assert.strictEqual(findHybridWindowByUrl('https://EXAMPLE.com/Path')!.windowId, f.id);
    assert.strictEqual(findHybridWindowByUrl('https://example.com/path'), null);
  });

  it('dedups on the requested open address, surviving in-page navigation', () => {
    // A window opened for X that then navigates/redirects to Y still dedups a
    // repeat open of X (match on the stored requested address).
    const f = mk({ url: 'https://example.com/' });
    f.wc.navigate('https://example.com/deep/link');
    assert.strictEqual(findHybridWindowByUrl('https://example.com/')!.windowId, f.id);
  });

  it('dedups on the LIVE content url too — reopening the redirected-to address reuses the window (Mechanism 1)', () => {
    // Regression (ab104fc5): a window opened for X that redirects/SPA-navigates
    // to Y must ALSO dedup a repeat open of Y (what the user is now looking at),
    // matching on the live content URL — not just the static requested address.
    const f = mk({ url: 'https://example.com/' });
    f.wc.navigate('https://example.com/deep/link');
    assert.strictEqual(findHybridWindowByUrl('https://example.com/deep/link')!.windowId, f.id);
  });

  it('canonicalizes query-param ORDER — opens differing only in param order dedup (Mechanism 2)', () => {
    const f = mk({ url: 'https://example.com/p?b=2&a=1' });
    assert.strictEqual(findHybridWindowByUrl('https://example.com/p?a=1&b=2')!.windowId, f.id);
  });

  it('canonicalizes DEFAULT PORTS — :443/:80 dedup against the portless form (Mechanism 2)', () => {
    const https = mk({ url: 'https://example.com/p' });
    assert.strictEqual(findHybridWindowByUrl('https://example.com:443/p')!.windowId, https.id);
    const http = mk({ url: 'http://plain.test/q' });
    assert.strictEqual(findHybridWindowByUrl('http://plain.test:80/q')!.windowId, http.id);
  });

  it('does NOT dedup a non-default port (real distinction preserved)', () => {
    mk({ url: 'https://example.com/p' });
    assert.strictEqual(findHybridWindowByUrl('https://example.com:8443/p'), null);
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

// ── Loading-card first-paint tracking ────────────────────────────────────────
describe('hybrid-page-host-registry: first-paint (loading card gate)', () => {
  beforeEach(() => {
    _resetForTests();
    nextId = 1;
  });

  it('a fresh window has not painted (firstLoad = true)', () => {
    assert.strictEqual(hasHybridPainted(1), false);
  });

  it('markHybridPainted flips it — a subsequent load is no longer firstLoad', () => {
    markHybridPainted(1);
    assert.strictEqual(hasHybridPainted(1), true);
    assert.strictEqual(hasHybridPainted(2), false); // per-window
  });

  it('teardown clears the painted flag (a reused id starts unpainted)', () => {
    const f = mk({ url: 'https://a.test/' });
    markHybridPainted(f.id);
    assert.strictEqual(hasHybridPainted(f.id), true);
    unregisterHybridWindow(f.id);
    assert.strictEqual(hasHybridPainted(f.id), false);
  });
});

// ── Content-WC reverse lookup (the will-download "is this hybrid?" test) ─────
// The will-download cleanup asks this registry whether a download's WC is hybrid
// content, then feeds that + the paint flag to `downloadCloseTarget` (pure; see
// izui-roles.test.ts) to decide what closes. This registry only has to answer the
// lookup honestly — including saying "no live host" for orphan/destroyed cases.
describe('hybrid-page-host-registry: content-WC reverse lookup', () => {
  beforeEach(() => {
    _resetForTests();
    nextId = 1;
  });

  it('resolves the owning hybrid entry for a registered content WC', () => {
    const f = mk({ url: 'https://dl.example/file.bin' });
    const host = getHybridWindowByContentWC(f.wc as unknown as WebContents);
    assert.ok(host, 'a live hybrid content WC should resolve to its host');
    assert.strictEqual(host!.windowId, f.id);
  });

  it('returns null when no hybrid window owns the content WC', () => {
    const orphan = new FakeWebContents('https://x.test/');
    assert.strictEqual(
      getHybridWindowByContentWC(orphan as unknown as WebContents),
      null,
    );
  });

  it('returns null when the resolved host base window is already destroyed', () => {
    const f = mk({ url: 'https://dl.example/file.bin' });
    f.baseWin.destroyed = true;
    assert.strictEqual(
      getHybridWindowByContentWC(f.wc as unknown as WebContents),
      null,
    );
  });

  it('paint flag discriminates a fresh download popup from a real page being browsed', () => {
    // The two download shapes, as the will-download call site reads them:
    // a fresh target=_blank download popup never paints; the Fastmail repro
    // (download link clicked while browsing) has painted → must survive.
    const fresh = mk({ url: 'https://dl.example/file.bin' });
    assert.strictEqual(hasHybridPainted(fresh.id), false);
    const browsing = mk({ url: 'https://www.fastmail.com/mail/' });
    markHybridPainted(browsing.id);
    assert.strictEqual(hasHybridPainted(browsing.id), true);
  });
});

// Maximize-state tests moved with the state itself: `maximized`/`preMaxBounds`
// now live on the window-state machine record (§5 step 7B) and are pinned in
// window-state.test.ts (MAXIMIZE_REQUESTED / UNMAXIMIZE_REQUESTED /
// MAXIMIZE_RESTORED / MAXIMIZE_EXITED_BY_RESIZE suites).
