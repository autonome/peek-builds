/**
 * Unit tests for the two-pass Escape caller (`window-escape-runtime.ts`).
 *
 * Harness conventions follow `window-escape.test.ts`: `node:test` +
 * `node:assert`, `.js`-suffixed imports of the compiled output, a branded-id
 * builder, scenes folded from real `WindowRegistered` events with the flags the
 * real construction sites pass.
 *
 * What these pin: the renderer ask is a round trip of up to 500ms
 * (`windows.ts askWebContentsToHandleEscape`), and the world moves while it is
 * outstanding. Pass B re-reads state, and for a `'global'` landing
 * `resolveEscapeTarget` always names the CURRENT key holder — so without a
 * check of its own, pass B would apply a keystroke pressed against window A to
 * whatever window B holds key by the time the answer lands. Measured live: an
 * Escape pressed with a page host key, whose ask timed out, closed the peek
 * that had opened during the wait — the press predated the window it closed.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  initialState,
  evolve,
  BASE_LAYER,
  type Command,
  type Event,
  type State,
  type WindowId,
} from './window-kernel.js';
import { handleEscapePress, type EscapeRuntimeDeps } from './window-escape-runtime.js';

// ── Builders ────────────────────────────────────────────────────────────────

const wid = (n: number): WindowId => `wer-${n}` as WindowId;
const FLOATING = BASE_LAYER + 1;

function fold(events: Event[], start: State = initialState()): State {
  return events.reduce(evolve, start);
}

const host = wid(1);
const peek = wid(2);

/** `hybrid-overlay.ts` opens page hosts as `role:'content'`, class `'primary'`. */
const regHost = (id: WindowId): Event => ({
  type: 'WindowRegistered', id, kind: 'page-host', layer: BASE_LAYER,
  canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'content',
});
/** A slide/peek, as `features/peeks/background.js executeItem` opens one. */
const regQuickView = (id: WindowId): Event => ({
  type: 'WindowRegistered', id, kind: 'page-host', layer: FLOATING,
  canBecomeKey: true, acceptsInput: true, class: 'quick-view', role: 'quick-view',
});
const show = (id: WindowId): Event => ({ type: 'WindowShown', id });
const focus = (id: WindowId): Event => ({ type: 'OsFocusGained', id });
const orderable = (id: WindowId): Event => ({ type: 'WindowContentOrderable', id });

/** A lone page host, shown, settled and holding key. */
function hostHoldsKey(): State {
  return fold([{ type: 'AppActivated' }, regHost(host), show(host), orderable(host), focus(host)]);
}

/** The same host, with a peek opened over it and holding key. */
function peekOverHost(): State {
  return fold([regQuickView(peek), show(peek), orderable(peek), focus(peek)], hostHoldsKey());
}

/** A settle: let the ask's `.then` run. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Harness {
  deps: EscapeRuntimeDeps;
  executed: Command[];
  published: string[];
  asked: WindowId[];
  answer(rendererHandled: boolean): void;
  setState(next: State): void;
}

/**
 * Injected deps with a hand-driven ask: `answer()` resolves it, and
 * `setState()` moves the world between pass A and pass B.
 */
function harness(initial: State): Harness {
  let state = initial;
  const executed: Command[] = [];
  const published: string[] = [];
  const asked: WindowId[] = [];
  let resolveAsk: ((handled: boolean) => void) | null = null;
  const deps: EscapeRuntimeDeps = {
    getState: () => state,
    execute: (command) => { executed.push(command); },
    publish: (topic) => { published.push(topic); },
    ask: (id) => {
      asked.push(id);
      return new Promise<boolean>((resolve) => { resolveAsk = resolve; });
    },
    track: () => {},
  };
  return {
    deps,
    executed,
    published,
    asked,
    answer: (handled) => {
      assert.ok(resolveAsk !== null, 'no ask outstanding');
      resolveAsk(handled);
    },
    setState: (next) => { state = next; },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('window-escape-runtime: pass B acts only on the window pass A asked', () => {
  it('an Escape pressed with a host key, answered after a peek opened over it, does NOT close the peek', async () => {
    const h = harness(hostHoldsKey());
    handleEscapePress({ landedId: 'global' }, h.deps);
    assert.deepStrictEqual(h.asked, [host], 'pass A asks the host');

    // The world moves during the ask: a peek opens and takes key.
    h.setState(peekOverHost());
    h.answer(false);
    await tick();

    assert.deepStrictEqual(h.executed, [], 'the press predates the peek, so nothing is closed');
    assert.deepStrictEqual(h.published, [], 'and the switcher is not opened over it either');
  });

  it('control: the same press with the host still key opens the switcher', async () => {
    const h = harness(hostHoldsKey());
    handleEscapePress({ landedId: 'global' }, h.deps);
    h.answer(false);
    await tick();

    assert.deepStrictEqual(h.executed, []);
    assert.deepStrictEqual(h.published, ['cmd:execute:windows']);
  });

  it('control: an Escape pressed with the peek key, answered with the peek still key, closes the peek', async () => {
    const h = harness(peekOverHost());
    handleEscapePress({ landedId: 'global' }, h.deps);
    assert.deepStrictEqual(h.asked, [peek]);
    h.answer(false);
    await tick();

    assert.strictEqual(h.executed.length, 1);
    assert.strictEqual(h.executed[0].type, 'CloseOrHideWindow');
    assert.strictEqual((h.executed[0] as Extract<Command, { type: 'CloseOrHideWindow' }>).id, peek);
  });

  it('a press whose asked window is gone by pass B does nothing', async () => {
    const h = harness(peekOverHost());
    handleEscapePress({ landedId: 'global' }, h.deps);
    assert.deepStrictEqual(h.asked, [peek]);

    // The peek closed on its own during the ask; the host is key again.
    h.setState(fold([{ type: 'WindowClosed', id: peek }, focus(host)], peekOverHost()));
    h.answer(false);
    await tick();

    assert.deepStrictEqual(h.executed, []);
    assert.deepStrictEqual(h.published, [], 'in particular the switcher does not open over the host');
  });
});
