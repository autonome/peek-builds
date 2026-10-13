/**
 * Page translation session (page-translate/page-session.ts): the transition table, then the
 * driver against a linkedom page running the real injected translator and a stub engine that
 * uppercases text. The test sits at the top level of main/ so the shared `dist/main/*.test.js`
 * glob runs it.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as vm from 'node:vm';
import { parseHTML } from 'linkedom';

import {
  createPageSession,
  INITIAL_SESSION_STATE,
  transition,
  type EngineRequest,
  type SessionEvent,
  type SessionState,
} from './page-translate/page-session.js';

const ITEM = { id: '0', text: 'Hallo', isHTML: true };

function run(events: SessionEvent[], from: SessionState = INITIAL_SESSION_STATE) {
  let state = from;
  const effects: string[] = [];
  for (const e of events) {
    const t = transition(state, e);
    state = t.state;
    effects.push(...t.effects.map((x) => x.type));
  }
  return { state, effects };
}

const start: SessionEvent = { type: 'translate', from: 'de', to: 'en' };

describe('page session transitions', () => {
  it('idle → collecting → translating → collecting → translated', () => {
    let t = transition(INITIAL_SESSION_STATE, start);
    assert.strictEqual(t.state.phase, 'collecting');
    assert.strictEqual(t.state.run, 1);
    assert.deepStrictEqual(t.effects, [{ type: 'collect', run: 1, pageLang: 'de' }]);

    t = transition(t.state, { type: 'batch', run: 1, items: [ITEM] });
    assert.strictEqual(t.state.phase, 'translating');
    assert.deepStrictEqual(t.effects, [{ type: 'translate', run: 1, from: 'de', to: 'en', items: [ITEM] }]);

    t = transition(t.state, { type: 'translated', run: 1, results: [{ id: '0', text: 'Hello' }] });
    assert.strictEqual(t.state.phase, 'collecting');
    assert.strictEqual(t.state.applied, 1);
    assert.deepStrictEqual(t.effects.map((e) => e.type), ['apply', 'drain']);

    t = transition(t.state, { type: 'batch', run: 1, items: [] });
    assert.strictEqual(t.state.phase, 'translated');
    assert.deepStrictEqual(t.effects, [{ type: 'schedule-poll', run: 1 }]);

    t = transition(t.state, { type: 'poll', run: 1 });
    assert.strictEqual(t.state.phase, 'collecting');
    assert.deepStrictEqual(t.effects, [{ type: 'drain', run: 1 }]);
  });

  it('an empty first batch goes straight to translated', () => {
    const r = run([start, { type: 'batch', run: 1, items: [] }]);
    assert.strictEqual(r.state.phase, 'translated');
  });

  it('show original during translation restores and drops the late engine result', () => {
    const r = run([start, { type: 'batch', run: 1, items: [ITEM] }, { type: 'show-original' }]);
    assert.strictEqual(r.state.phase, 'restoring');
    assert.strictEqual(r.state.run, 2);
    assert.deepStrictEqual(r.effects.slice(-2), ['cancel', 'restore']);

    const late = transition(r.state, { type: 'translated', run: 1, results: [{ id: '0', text: 'Hello' }] });
    assert.strictEqual(late.state, r.state);
    assert.deepStrictEqual(late.effects, []);

    const done = transition(r.state, { type: 'restored', run: 2 });
    assert.strictEqual(done.state.phase, 'idle');
  });

  it('show original while translated restores', () => {
    const r = run([start, { type: 'batch', run: 1, items: [] }, { type: 'show-original' }, { type: 'restored', run: 2 }]);
    assert.strictEqual(r.state.phase, 'idle');
    assert.deepStrictEqual(r.effects, ['collect', 'schedule-poll', 'cancel', 'restore']);
  });

  for (const phase of ['collecting', 'translating', 'translated', 'restoring'] as const) {
    it(`navigation during ${phase} cancels and returns to idle without restoring`, () => {
      const s: SessionState = { ...INITIAL_SESSION_STATE, phase, run: 3, from: 'de', to: 'en' };
      const t = transition(s, { type: 'navigated' });
      assert.strictEqual(t.state.phase, 'idle');
      assert.strictEqual(t.state.run, 4);
      assert.strictEqual(t.state.from, null);
      assert.deepStrictEqual(t.effects, [{ type: 'cancel', run: 3 }]);
      assert.deepStrictEqual(transition(t.state, { type: 'batch', run: 3, items: [ITEM] }).effects, []);
    });

    it(`page:will-close during ${phase} cancels and closes for good`, () => {
      const s: SessionState = { ...INITIAL_SESSION_STATE, phase, run: 3, from: 'de', to: 'en' };
      const t = transition(s, { type: 'will-close' });
      assert.strictEqual(t.state.phase, 'closed');
      assert.deepStrictEqual(t.effects, [{ type: 'cancel', run: 3 }]);
      for (const e of [start, { type: 'navigated' }, { type: 'show-original' }] as SessionEvent[]) {
        const after = transition(t.state, e);
        assert.strictEqual(after.state, t.state);
        assert.deepStrictEqual(after.effects, []);
      }
    });
  }

  it('navigation and close while idle', () => {
    assert.deepStrictEqual(transition(INITIAL_SESSION_STATE, { type: 'navigated' }).effects, []);
    assert.strictEqual(transition(INITIAL_SESSION_STATE, { type: 'will-close' }).state.phase, 'closed');
  });

  it('a failure while active restores and keeps the error', () => {
    const r = run([start, { type: 'failed', run: 1, error: 'engine died' }]);
    assert.strictEqual(r.state.phase, 'restoring');
    assert.strictEqual(r.state.error, 'engine died');
    assert.deepStrictEqual(r.effects, ['collect', 'cancel', 'restore']);
  });

  it('a failed restore falls back to a reload', () => {
    const r = run([start, { type: 'show-original' }, { type: 'failed', run: 2, error: 'gone' }]);
    assert.strictEqual(r.state.phase, 'idle');
    assert.deepStrictEqual(r.effects.slice(-1), ['reload']);
  });

  it('ignores translate while a session is active and restore events while idle', () => {
    const active = run([start]).state;
    assert.strictEqual(transition(active, start).state, active);
    assert.strictEqual(transition(INITIAL_SESSION_STATE, { type: 'show-original' }).state, INITIAL_SESSION_STATE);
    assert.strictEqual(transition(INITIAL_SESSION_STATE, { type: 'restored', run: 0 }).state, INITIAL_SESSION_STATE);
  });

  it('ignores a duplicate batch while translating', () => {
    const s = run([start, { type: 'batch', run: 1, items: [ITEM] }]).state;
    assert.deepStrictEqual(transition(s, { type: 'batch', run: 1, items: [ITEM] }).effects, []);
  });
});

function fakePage(body: string) {
  const { document } = parseHTML(`<!doctype html><html lang="de"><head></head><body>${body}</body></html>`);
  const ctx = vm.createContext({ document });
  let reloads = 0;
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    body: () => (document as any).body.innerHTML as string,
    reloads: () => reloads,
    page: {
      // executeJavaScript hands back a structured clone; JSON round-trips stand in for it.
      async run(script: string) {
        const v = vm.runInContext(script, ctx);
        return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
      },
      reload() {
        reloads++;
      },
    },
  };
}

function upper(s: string, isHTML: boolean) {
  return isHTML ? s.replace(/(^|>)([^<]+)/g, (_m, p: string, t: string) => p + t.toUpperCase()) : s.toUpperCase();
}

function manualTimers() {
  const pending: (() => void)[] = [];
  return {
    setTimer: (fn: () => void) => {
      pending.push(fn);
      return fn;
    },
    clearTimer: (h: unknown) => {
      const i = pending.indexOf(h as () => void);
      if (i >= 0) pending.splice(i, 1);
    },
    fire() {
      const fns = pending.splice(0);
      fns.forEach((f) => f());
    },
    count: () => pending.length,
  };
}

describe('page session driver', () => {
  it('translates a page, picks up added content, and restores it', async () => {
    const p = fakePage('<p>Hallo <b>Welt</b></p><img alt="Bild">');
    const timers = manualTimers();
    const requests: EngineRequest[] = [];
    const s = createPageSession({
      page: p.page,
      engine: {
        async translate(req) {
          requests.push(req);
          return req.segments.map((x) => upper(x, req.isHTML));
        },
      },
      ...timers,
    });
    s.dispatch({ type: 'translate', from: 'de', to: 'en' });
    await s.idle();
    assert.strictEqual(s.state().phase, 'translated');
    assert.strictEqual(p.body(), '<p>HALLO <b>WELT</b></p><img alt="BILD">');
    assert.deepStrictEqual(requests.map((r) => r.isHTML), [true, false]);
    assert.strictEqual(timers.count(), 1);

    timers.fire();
    await s.idle();
    assert.strictEqual(s.state().phase, 'translated');

    s.dispatch({ type: 'show-original' });
    await s.idle();
    assert.strictEqual(s.state().phase, 'idle');
    assert.strictEqual(timers.count(), 0);
    assert.strictEqual(p.body(), '<p>Hallo <b>Welt</b></p><img alt="Bild">');
  });

  it('show original while the engine is busy aborts it and leaves the page untouched', async () => {
    const p = fakePage('<p>Hallo</p>');
    let release!: () => void;
    let seen: EngineRequest | null = null;
    const s = createPageSession({
      page: p.page,
      engine: {
        translate(req) {
          seen = req;
          return new Promise((resolve) => {
            release = () => resolve(req.segments.map((x) => upper(x, req.isHTML)));
          });
        },
      },
    });
    s.dispatch({ type: 'translate', from: 'de', to: 'en' });
    while (!seen) await new Promise((r) => setImmediate(r));
    assert.strictEqual(s.state().phase, 'translating');
    s.dispatch({ type: 'show-original' });
    assert.strictEqual((seen as EngineRequest).signal.aborted, true);
    release();
    await s.idle();
    assert.strictEqual(s.state().phase, 'idle');
    assert.strictEqual(p.body(), '<p>Hallo</p>');
  });

  it('an engine failure restores the page and records the error', async () => {
    const p = fakePage('<p>Hallo</p>');
    const s = createPageSession({
      page: p.page,
      engine: {
        async translate() {
          throw new Error('no model for de-en');
        },
      },
    });
    s.dispatch({ type: 'translate', from: 'de', to: 'en' });
    await s.idle();
    assert.strictEqual(s.state().phase, 'idle');
    assert.strictEqual(s.state().error, 'no model for de-en');
    assert.strictEqual(p.body(), '<p>Hallo</p>');
  });

  it('a short engine reply fails the run instead of misplacing text', async () => {
    const p = fakePage('<p>Eins</p><p>Zwei</p>');
    const s = createPageSession({
      page: p.page,
      engine: { translate: async () => ['ONE'] },
    });
    s.dispatch({ type: 'translate', from: 'de', to: 'en' });
    await s.idle();
    assert.match(s.state().error ?? '', /1 results for 2 segments/);
    assert.strictEqual(p.body(), '<p>Eins</p><p>Zwei</p>');
  });

  it('a page that cannot restore is reloaded', async () => {
    const p = fakePage('<p>Hallo</p>');
    const s = createPageSession({
      page: {
        async run(script: string) {
          if (script.includes('.restore(')) throw new Error('frame gone');
          return p.page.run(script);
        },
        reload: p.page.reload,
      },
      engine: { translate: async (req) => req.segments },
      setTimer: () => 0,
      clearTimer: () => {},
    });
    s.dispatch({ type: 'translate', from: 'de', to: 'en' });
    await s.idle();
    s.dispatch({ type: 'show-original' });
    await s.idle();
    assert.strictEqual(s.state().phase, 'idle');
    assert.strictEqual(p.reloads(), 1);
  });
});
