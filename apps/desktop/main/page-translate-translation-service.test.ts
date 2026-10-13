/**
 * Translation service (page-translate/translation-service.ts): sessions per window over linkedom
 * pages running the real injected translator, with a stub engine that marks text by target
 * language. Sits at the top level of main/ so the shared `dist/main/*.test.js` glob runs it.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as vm from 'node:vm';
import { parseHTML } from 'linkedom';

import { callSource } from './page-translate/content-script.js';
import type { EngineRequest, SessionState } from './page-translate/page-session.js';
import {
  createTranslationService,
  pageFromWebContents,
  TRANSLATE_WORLD_ID,
  type TranslationServiceOptions,
} from './page-translate/translation-service.js';

const ORIGINAL = '<p>Hallo Welt</p>';

function fakePage(body = ORIGINAL, opts: { failRestore?: boolean } = {}) {
  const { document } = parseHTML(`<!doctype html><html lang="de"><head></head><body>${body}</body></html>`);
  const ctx = vm.createContext({ document });
  let reloads = 0;
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    body: () => (document as any).body.innerHTML as string,
    reloads: () => reloads,
    page: {
      async run(script: string) {
        if (opts.failRestore && script === callSource('restore')) throw new Error('restore failed');
        const v = vm.runInContext(script, ctx);
        return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
      },
      reload() {
        reloads++;
      },
    },
  };
}

/** Prefixes every text run with the target language, so a page shows which pair translated it. */
function mark(s: string, to: string, isHTML: boolean) {
  return isHTML ? s.replace(/(^|>)([^<]+)/g, (_m, p: string, t: string) => `${p}${to}:${t}`) : `${to}:${s}`;
}

const markingEngine = {
  async translate(req: EngineRequest) {
    return req.segments.map((s) => mark(s, req.to, req.isHTML));
  },
};

const noTimers = { setTimer: () => 0, clearTimer: () => {} };

function service(pages: Record<number, ReturnType<typeof fakePage>>, extra: Partial<TranslationServiceOptions> = {}) {
  const states: Array<[number, SessionState]> = [];
  const svc = createTranslationService({
    pageFor: (id) => pages[id]?.page ?? null,
    engine: markingEngine,
    onState: (id, s) => states.push([id, s]),
    ...noTimers,
    ...extra,
  });
  return { svc, states };
}

describe('translation service', () => {
  it('reports no page for a window without one and keeps no session for it', () => {
    const { svc } = service({});
    assert.strictEqual(svc.translate(7, { from: 'de', to: 'en' }), 'no-page');
    assert.strictEqual(svc.state(7), null);
  });

  it('translates one window and leaves the others alone', async () => {
    const a = fakePage();
    const b = fakePage();
    const { svc, states } = service({ 1: a, 2: b });
    assert.strictEqual(svc.translate(1, { from: 'de', to: 'en' }), 'started');
    await svc.idle(1);
    assert.strictEqual(a.body(), '<p>en:Hallo Welt</p>');
    assert.strictEqual(b.body(), ORIGINAL);
    assert.strictEqual(svc.state(1)?.phase, 'translated');
    assert.strictEqual(svc.state(2), null);
    assert.ok(states.every(([id]) => id === 1));
  });

  it('the same pair again changes nothing', async () => {
    const a = fakePage();
    const { svc } = service({ 1: a });
    svc.translate(1, { from: 'de', to: 'en' });
    await svc.idle(1);
    const before = svc.state(1);
    assert.strictEqual(svc.translate(1, { from: 'de', to: 'en' }), 'unchanged');
    assert.strictEqual(svc.state(1), before);
  });

  it('another target while translated restores, then translates to the new one', async () => {
    const a = fakePage();
    const { svc, states } = service({ 1: a });
    svc.translate(1, { from: 'de', to: 'en' });
    await svc.idle(1);
    assert.strictEqual(svc.translate(1, { from: 'de', to: 'fr' }), 'queued');
    await svc.idle(1);
    assert.strictEqual(a.body(), '<p>fr:Hallo Welt</p>');
    assert.strictEqual(svc.state(1)?.to, 'fr');
    const phases = states.map(([, s]) => s.phase);
    assert.ok(phases.indexOf('restoring') < phases.lastIndexOf('translated'));
  });

  it('a translate while restoring waits for the restore', async () => {
    const a = fakePage();
    const { svc } = service({ 1: a });
    svc.translate(1, { from: 'de', to: 'en' });
    await svc.idle(1);
    svc.showOriginal(1);
    assert.strictEqual(svc.state(1)?.phase, 'restoring');
    assert.strictEqual(svc.translate(1, { from: 'de', to: 'fr' }), 'queued');
    await svc.idle(1);
    assert.strictEqual(a.body(), '<p>fr:Hallo Welt</p>');
  });

  it('show original puts the page back and cancels a queued translation', async () => {
    const a = fakePage();
    const { svc } = service({ 1: a });
    svc.translate(1, { from: 'de', to: 'en' });
    await svc.idle(1);
    svc.translate(1, { from: 'de', to: 'fr' });
    svc.showOriginal(1);
    await svc.idle(1);
    assert.strictEqual(a.body(), ORIGINAL);
    assert.strictEqual(svc.state(1)?.phase, 'idle');
  });

  it('a failed restore reloads the page and drops the queued translation', async () => {
    const a = fakePage(ORIGINAL, { failRestore: true });
    const { svc } = service({ 1: a });
    svc.translate(1, { from: 'de', to: 'en' });
    await svc.idle(1);
    svc.translate(1, { from: 'de', to: 'fr' });
    await svc.idle(1);
    assert.strictEqual(a.reloads(), 1);
    const s = svc.state(1);
    assert.strictEqual(s?.phase, 'idle');
    assert.strictEqual(s?.error, 'restore failed');
    assert.strictEqual(s?.to, 'en');
  });

  it('navigation ends the translation and keeps the session', async () => {
    const a = fakePage();
    const { svc } = service({ 1: a });
    svc.translate(1, { from: 'de', to: 'en' });
    await svc.idle(1);
    svc.navigated(1);
    assert.strictEqual(svc.state(1)?.phase, 'idle');
    assert.strictEqual(svc.translate(1, { from: 'de', to: 'en' }), 'started');
  });

  it('closing aborts the engine request and forgets the window', async () => {
    const a = fakePage();
    let signal: AbortSignal | null = null;
    const { svc } = service(
      { 1: a },
      {
        engine: {
          translate(req) {
            signal = req.signal;
            return new Promise(() => {});
          },
        },
      },
    );
    svc.translate(1, { from: 'de', to: 'en' });
    for (let i = 0; i < 20 && !signal; i++) await new Promise((r) => setImmediate(r));
    assert.ok(signal, 'engine was asked');
    svc.closed(1);
    assert.strictEqual((signal as AbortSignal | null)?.aborted, true);
    assert.strictEqual(svc.state(1), null);
  });

  it('dispose closes every session', async () => {
    const { svc } = service({ 1: fakePage(), 2: fakePage() });
    svc.translate(1, { from: 'de', to: 'en' });
    svc.translate(2, { from: 'de', to: 'en' });
    svc.dispose();
    assert.strictEqual(svc.state(1), null);
    assert.strictEqual(svc.state(2), null);
  });
});

describe('pageFromWebContents', () => {
  function fakeWC() {
    const calls: Array<[number, Array<{ code: string }>]> = [];
    let destroyed = false;
    let reloads = 0;
    return {
      calls,
      reloads: () => reloads,
      destroy: () => {
        destroyed = true;
      },
      wc: {
        isDestroyed: () => destroyed,
        async executeJavaScriptInIsolatedWorld(worldId: number, scripts: Array<{ code: string }>) {
          calls.push([worldId, scripts]);
          return 42;
        },
        reload: () => {
          reloads++;
        },
      },
    };
  }

  it('runs scripts in the translation world', async () => {
    const f = fakeWC();
    const page = pageFromWebContents(f.wc);
    assert.strictEqual(await page.run('1 + 1'), 42);
    assert.deepStrictEqual(f.calls, [[TRANSLATE_WORLD_ID, [{ code: '1 + 1' }]]]);
    page.reload();
    assert.strictEqual(f.reloads(), 1);
  });

  it('refuses to run in or reload a destroyed page', async () => {
    const f = fakeWC();
    const page = pageFromWebContents(f.wc);
    f.destroy();
    await assert.rejects(page.run('1'), /page is gone/);
    page.reload();
    assert.strictEqual(f.reloads(), 0);
    assert.strictEqual(f.calls.length, 0);
  });
});
