/**
 * Property-based model tests for the window-manager kernel (`window-kernel.ts`).
 *
 * Blueprint: `docs/design/window-manager.md` §0.1.8 item 1 ("Property-based
 * model testing ... generate random command/event sequences, assert the
 * invariant list after every step ... Highest return on this list").
 *
 * DEPENDENCY NOTE: the design doc's own phrasing names `fast-check`
 * `modelRun` as the reference tool, but no dependency is added here — the
 * kernel is pure (`evolve`/`react` read nothing but their arguments, §0.1.1),
 * so a numeric seed plus the recorded event log reproduces any failure
 * exactly. We hand-roll a tiny seeded PRNG (mulberry32) instead and accept
 * the loss of automatic shrinking in exchange for zero new dependencies —
 * a failing seed's full log is printed verbatim in the assertion message,
 * which is enough to replay it by hand.
 *
 * This is a separate file from `window-kernel.test.ts` by design (not an
 * addition to it) — the hand-written tests there are example-based; this
 * file is the randomized model-testing layer the design doc calls for.
 *
 * Follows the harness conventions of `window-kernel.test.ts`: `node:test` +
 * `node:assert`, a `.js`-suffixed import of the compiled output.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  initialState,
  evolve,
  react,
  keyWindow,
  type State,
  type Event,
  type Effect,
  type WindowId,
  type WindowKind,
} from './window-kernel.js';

// ─────────────────────────────────────────────────────────────────────────────
// Seeded PRNG — mulberry32. No Math.random() anywhere in this file: a given
// seed always produces the same log, forever.
// ─────────────────────────────────────────────────────────────────────────────

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in `[0, maxExclusive)`. */
function randomInt(rng: Rng, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive);
}

function randomBool(rng: Rng): boolean {
  return rng() < 0.5;
}

function pick<T>(rng: Rng, values: readonly T[]): T {
  return values[randomInt(rng, values.length)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Random event-log generator — deliberately unfiltered. It must produce
// nonsense as readily as sensible sequences: events naming windows that were
// never registered, a second WindowClosed for the same id, focus gained on a
// closed window. The hand-written tests already cover "legal" sequences;
// this exists to find the states those miss.
// ─────────────────────────────────────────────────────────────────────────────

/** Small pool of ids so collisions, reuse, and never-registered references happen naturally. */
const POOL_SIZE = 6;
const wid = (n: number): WindowId => `wkp-${n}` as WindowId;
const KINDS: readonly WindowKind[] = ['page-host', 'browser'];
const CLASSES = ['primary', 'hud', 'overlay', 'utility'];

function randomEvent(rng: Rng): Event {
  const variant = randomInt(rng, 7);
  const id = wid(randomInt(rng, POOL_SIZE));
  switch (variant) {
    case 0: {
      const hasParent = rng() < 0.3;
      return {
        type: 'WindowRegistered',
        id,
        kind: pick(rng, KINDS),
        layer: randomInt(rng, 4),
        canBecomeKey: randomBool(rng),
        acceptsInput: randomBool(rng),
        class: pick(rng, CLASSES),
        ...(hasParent ? { parentId: wid(randomInt(rng, POOL_SIZE)) } : {}),
      };
    }
    case 1:
      return { type: 'WindowShown', id };
    case 2:
      return { type: 'WindowHidden', id };
    case 3:
      return { type: 'WindowClosed', id };
    case 4:
      return { type: 'OsFocusGained', id };
    case 5:
      return { type: 'OsFocusLost', id };
    case 6:
    default:
      return { type: 'AppActiveChanged', active: randomBool(rng) };
  }
}

function generateLog(seed: number, length: number): Event[] {
  const rng = mulberry32(seed);
  const log: Event[] = [];
  for (let i = 0; i < length; i++) {
    log.push(randomEvent(rng));
  }
  return log;
}

// ─────────────────────────────────────────────────────────────────────────────
// Invariant checker — returns a list of violation strings; empty = OK.
// Takes the optional previous state so the two monotonicity invariants
// (version, the two counters) can be checked against the immediately prior
// step, the same way the property-test loop calls it.
// ─────────────────────────────────────────────────────────────────────────────

function checkInvariants(state: State, prev?: State): string[] {
  const violations: string[] = [];

  const seenIds = new Set<string>();
  for (const record of state.order) {
    if (seenIds.has(record.id)) {
      violations.push(`duplicate id in order: ${record.id}`);
    }
    seenIds.add(record.id);
    if (typeof record.id !== 'string' || record.id.length === 0) {
      violations.push(`malformed id in order: ${JSON.stringify(record.id)}`);
    }
    if (typeof record.layer !== 'number' || !Number.isFinite(record.layer)) {
      violations.push(`malformed layer for ${record.id}: ${JSON.stringify(record.layer)}`);
    }
  }

  const kw = keyWindow(state);
  if (kw !== null && !state.order.some((w) => w.id === kw.id)) {
    violations.push(`keyWindow() resolved to a record not present in order: ${JSON.stringify(kw)}`);
  }

  if (prev !== undefined) {
    if (!(state.version > prev.version)) {
      violations.push(`version did not strictly increase: prev=${prev.version} next=${state.version}`);
    }
    if (state.openSeqCounter < prev.openSeqCounter) {
      violations.push(`openSeqCounter decreased: prev=${prev.openSeqCounter} next=${state.openSeqCounter}`);
    }
    if (state.opSeqCounter < prev.opSeqCounter) {
      violations.push(`opSeqCounter decreased: prev=${prev.opSeqCounter} next=${state.opSeqCounter}`);
    }
  }

  return violations;
}

/** Extra invariant on `react`'s output: every emitted effect names a window still in `next.order`. */
function checkEffectInvariants(effects: Effect[], next: State): string[] {
  const violations: string[] = [];
  for (const effect of effects) {
    if (!next.order.some((w) => w.id === effect.id)) {
      violations.push(`effect names a window not present in order: ${JSON.stringify(effect)}`);
    }
  }
  return violations;
}

// ─────────────────────────────────────────────────────────────────────────────
// Local duplicates of the fold helpers from `window-kernel.test.ts` (not
// exported there, so duplicated here rather than modifying that file).
// ─────────────────────────────────────────────────────────────────────────────

function fold(events: Event[], start: State = initialState()): State {
  return events.reduce(evolve, start);
}

function foldWithEffects(events: Event[], start: State = initialState()): { state: State; effects: Effect[] } {
  let state = start;
  const effects: Effect[] = [];
  for (const ev of events) {
    const next = evolve(state, ev);
    effects.push(...react(state, ev, next));
    state = next;
  }
  return { state, effects };
}

/** Reproducibility: every failure message carries the seed and the full JSON log, so it replays verbatim. */
function reproMessage(seed: number, log: Event[], stepIndex: number, detail: string): string {
  return `${detail}\n  seed=${seed} step=${stepIndex}/${log.length}\n  log=${JSON.stringify(log)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The property tests — a fixed, committed list of seeds (deterministic, not
// time-derived): 0..199.
// ─────────────────────────────────────────────────────────────────────────────

const SEED_COUNT = 200;
const LOG_LENGTH = 30;

describe('window-kernel: property-based model tests (§0.1.8 item 1)', () => {
  for (let seed = 0; seed < SEED_COUNT; seed++) {
    it(`seed ${seed}: invariants hold after every step; evolve never throws; replay is deterministic`, () => {
      const log = generateLog(seed, LOG_LENGTH);

      let state = initialState();
      for (let i = 0; i < log.length; i++) {
        const ev = log[i];
        let next: State;
        try {
          next = evolve(state, ev);
        } catch (err) {
          throw new Error(reproMessage(seed, log, i, `evolve threw: ${(err as Error).message}`));
        }

        const stateViolations = checkInvariants(next, state);
        if (stateViolations.length > 0) {
          throw new Error(reproMessage(seed, log, i, `invariant violation(s): ${stateViolations.join('; ')}`));
        }

        const effects = react(state, ev, next);
        const effectViolations = checkEffectInvariants(effects, next);
        if (effectViolations.length > 0) {
          throw new Error(reproMessage(seed, log, i, `effect invariant violation(s): ${effectViolations.join('; ')}`));
        }

        state = next;
      }

      // Replay determinism + effect-list determinism (§0.1.8 item 2, applied
      // to a randomly generated log instead of a hand-written one).
      const r1 = foldWithEffects(log);
      const r2 = foldWithEffects(log);
      assert.deepStrictEqual(r1.state, r2.state, reproMessage(seed, log, log.length, 'replay determinism: state mismatch'));
      assert.deepStrictEqual(
        r1.effects,
        r2.effects,
        reproMessage(seed, log, log.length, 'replay determinism: effect list mismatch'),
      );
      assert.deepStrictEqual(r1.state, fold(log), reproMessage(seed, log, log.length, 'fold() and foldWithEffects() diverged'));
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Pinned reproducer, first surfaced by this property run at seed 0 (and
// ~half of seeds 0..199): two `WindowRegistered` events for the same id with
// no `WindowClosed` in between (the id is still live when the second one
// lands) must merge in place, not append a second record. Kept independent
// of the log generator so it survives any future change to `generateLog`.
// ─────────────────────────────────────────────────────────────────────────────

describe('window-kernel: re-registration of a still-live id merges in place', () => {
  it('a second WindowRegistered for a still-open id merges — no duplicate id in order', () => {
    const id = wid(0);
    const registered: Event = {
      type: 'WindowRegistered',
      id,
      kind: 'page-host',
      layer: 0,
      canBecomeKey: true,
      acceptsInput: true,
      class: 'primary',
    };
    const state = fold([registered, registered]);
    const violations = checkInvariants(state);
    assert.deepStrictEqual(violations, []);
  });
});
