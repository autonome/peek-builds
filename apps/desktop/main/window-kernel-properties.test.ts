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
  decide,
  keyWindow,
  selectTransientAutoclose,
  isAppResignSweepEligible,
  isContentWindow,
  hostForOverlay,
  type State,
  type Event,
  type Command,
  type Effect,
  type WindowId,
  type WindowKind,
  type Rectangle,
  type FocusCause,
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

/** A small, plausible outer-bounds rectangle — this slice's geometry events. */
function randomRectangle(rng: Rng): Rectangle {
  return {
    x: randomInt(rng, 2000),
    y: randomInt(rng, 2000),
    width: randomInt(rng, 2000) + 1,
    height: randomInt(rng, 2000) + 1,
  };
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
/**
 * The live IZUI role vocabulary plus `undefined` — a registration that names
 * no role is as legitimate as one that does, and both the transient sets and
 * the exempt sets must be reachable by generation.
 */
const ROLES: readonly (string | undefined)[] = [
  'palette',
  'quick-view',
  'overlay',
  'switcher',
  'utility',
  'workspace',
  'content',
  'child-content',
  undefined,
];
/**
 * The Escape override plus `undefined` — absent is a meaningful value, not a
 * hole, so generation must produce it at least as often as the one live
 * override.
 */
const ESCAPE_MODES: readonly ('ignore' | undefined)[] = ['ignore', undefined];

/**
 * A stack-order import payload, DELIBERATELY MALFORMED as often as not. The
 * membership-preservation and one-order invariants below are worth nothing
 * against a generator that only ever emits well-formed orders, so all five
 * shapes are produced: empty, ids that were never registered, duplicates, an
 * arbitrary partial subset (which also produces duplicates on its own), and a
 * full shuffled permutation of the pool.
 */
function randomStackOrderPayload(rng: Rng): WindowId[] {
  switch (randomInt(rng, 5)) {
    case 0:
      // Empty — the identity permutation, and the shape `session.ts` produces
      // when every window it walked has already died.
      return [];
    case 1:
      // Names nothing that was ever registered.
      return Array.from({ length: 1 + randomInt(rng, 3) }, () => wid(POOL_SIZE + randomInt(rng, 4)));
    case 2: {
      // Explicit duplicates, interleaved — collapsing to the first occurrence
      // is a documented property of the arm, not a caller obligation.
      const a = wid(randomInt(rng, POOL_SIZE));
      const b = wid(randomInt(rng, POOL_SIZE));
      return [a, b, a, b, a];
    }
    case 3:
      // An arbitrary partial subset drawn with replacement — repeats and
      // omissions both fall out of this without being arranged.
      return Array.from({ length: 1 + randomInt(rng, POOL_SIZE) }, () => wid(randomInt(rng, POOL_SIZE)));
    default: {
      // A full permutation of the pool (Fisher-Yates over the seeded rng).
      const ids = Array.from({ length: POOL_SIZE }, (_, n) => wid(n));
      for (let i = ids.length - 1; i > 0; i--) {
        const j = randomInt(rng, i + 1);
        const swap = ids[i];
        ids[i] = ids[j];
        ids[j] = swap;
      }
      return ids;
    }
  }
}

/** A log item is either a fact fed straight to `evolve`, or a request fed through `decide` first. */
type LogItem = Event | Command;

/** Distinguishes the two — only `Command` variants carry `expectedVersion`. */
function isCommand(item: LogItem): item is Command {
  return 'expectedVersion' in item;
}

/**
 * The intrinsics shared by `WindowRegistered` (case 0) and `RegisterWindow`
 * (case 8) — pulled out once so the registration-bias branch below can build
 * either shape without duplicating the field list a third time.
 */
function randomRegistrationFields(rng: Rng) {
  const hasParent = rng() < 0.3;
  const hasKeepLive = rng() < 0.3;
  const role = pick(rng, ROLES);
  const escapeMode = pick(rng, ESCAPE_MODES);
  return {
    kind: pick(rng, KINDS),
    layer: randomInt(rng, 4),
    canBecomeKey: randomBool(rng),
    acceptsInput: randomBool(rng),
    class: pick(rng, CLASSES),
    ...(role !== undefined ? { role } : {}),
    ...(hasParent ? { parentId: wid(randomInt(rng, POOL_SIZE)) } : {}),
    ...(hasKeepLive ? { keepLive: randomBool(rng) } : {}),
    ...(escapeMode !== undefined ? { escapeMode } : {}),
  };
}

/**
 * Registration bias — MEASURED problem, not a hunch: a flat 36-way split
 * reaches registration (case 0/8) only ~2/36 of the time, roughly matching
 * how often a close-worthy variant fires, so `order` sat at 0-1 records deep
 * almost always (see the coverage comments below `checkOpSeqInvariants`).
 * That starved every arm needing a payload that names a REGISTERED,
 * currently-live window: the cold-start latch's raise-emitting half, `react`'s
 * `FocusContent` half of a focus assert, and the disjointness clause in
 * `checkAutocloseInvariants`. This constant raises registration's combined
 * share well above its flat-switch odds without suppressing anything the
 * switch below still generates — the roll happens BEFORE the 36-way switch,
 * as an extra source of registration traffic layered on top of it, same
 * event/command sub-roll shape as case 33/34/35 below.
 */
const REGISTRATION_BIAS = 0.3;

/**
 * A second, complementary bias: once registration (above) is no longer the
 * rare case, the id every OTHER variant names should follow suit — a raw
 * pool draw still lands on a currently-registered id only at `order`'s own
 * fill fraction, which is exactly the coincidence the cold-start latch's
 * raise-emitting half and `react`'s `FocusContent` half need (a window that
 * is not just registered but SHOWN, so an assert on it can resolve
 * `isContentWindow`). Drawing from `state.order` itself this often is what
 * makes those windows commonly NAMED, not just commonly present. Still fully
 * unfiltered: the complementary share keeps drawing from the raw pool, so a
 * never-registered or already-closed target stays ordinary generated
 * traffic, same as before.
 */
const EXISTING_WINDOW_BIAS = 0.65;

/**
 * A third bias, needed for the SAME reason `EXISTING_WINDOW_BIAS` is: a
 * registered-but-never-shown window is still `visible: false`, and
 * `isContentWindow` requires `visible` — so `react`'s `FocusContent` half
 * cannot fire on a window nobody ever showed, no matter how deep `order`
 * gets or how often a focus assert names a live id. `WindowShown` (case 1)
 * sits at the same flat ~1/36 odds as registration did, so it needed the same
 * treatment: a leading roll, at the existing-window-biased `id`, so a show
 * commonly lands on something already registered rather than on an id that
 * is not there to become visible. Still fully unfiltered — the complementary
 * share still reaches the flat switch's own `case 1`, which can and does
 * name an unregistered id.
 */
const SHOWN_BIAS = 0.15;

/**
 * `state` is the live state at generation time — used both to produce a
 * mostly-plausible `expectedVersion` for the command variants (sometimes
 * deliberately stale, to exercise rejection) and, via `EXISTING_WINDOW_BIAS`
 * above, to occasionally pick `id` off `state.order` itself. Neither reads
 * make the log non-reproducible: the same seed walks the same state
 * trajectory, so the same seed always produces the same concrete log.
 */
function randomLogItem(rng: Rng, state: State): LogItem {
  if (rng() < REGISTRATION_BIAS) {
    const id = wid(randomInt(rng, POOL_SIZE));
    const fields = randomRegistrationFields(rng);
    if (rng() < 0.5) return { type: 'WindowRegistered', id, ...fields };
    const stale = rng() < 0.2;
    return { type: 'RegisterWindow', id, ...fields, expectedVersion: stale ? state.version + 1 : state.version };
  }
  const id =
    state.order.length > 0 && rng() < EXISTING_WINDOW_BIAS
      ? pick(rng, state.order).id
      : wid(randomInt(rng, POOL_SIZE));
  if (rng() < SHOWN_BIAS) {
    return { type: 'WindowShown', id };
  }
  const variant = randomInt(rng, 36);
  switch (variant) {
    case 0:
      return { type: 'WindowRegistered', id, ...randomRegistrationFields(rng) };
    case 1:
      return { type: 'WindowShown', id };
    case 2:
      return { type: 'WindowHidden', id };
    case 3:
      return { type: 'WindowClosed', id };
    // Unfiltered — all three cause shapes (absent, world, machine with an
    // arbitrary opSeq, including ones from the future and the distant past),
    // same reasoning as every other event variant here.
    case 4: {
      const causeVariant = randomInt(rng, 3);
      const cause: FocusCause | undefined =
        causeVariant === 0 ? undefined : causeVariant === 1 ? { kind: 'world' } : { kind: 'machine', opSeq: randomInt(rng, 2001) - 1000 };
      return cause === undefined ? { type: 'OsFocusGained', id } : { type: 'OsFocusGained', id, cause };
    }
    case 5:
      return { type: 'OsFocusLost', id };
    // Unfiltered — nonsense orderings included (settle without a resign,
    // double activate, resign twice) so the dance guard's total handling of
    // every combination is exercised, same reasoning as every other event
    // variant here.
    case 6:
      return { type: 'AppResigned' };
    case 7:
      return { type: 'WindowContentOrderable', id };
    case 8: {
      const stale = rng() < 0.2;
      return { type: 'RegisterWindow', id, ...randomRegistrationFields(rng), expectedVersion: stale ? state.version + 1 : state.version };
    }
    case 9: {
      const stale = rng() < 0.2;
      return { type: 'CloseOrHideWindow', id, expectedVersion: stale ? state.version + 1 : state.version };
    }
    case 10: {
      const stale = rng() < 0.2;
      return { type: 'SetFullscreen', id, desired: randomBool(rng), expectedVersion: stale ? state.version + 1 : state.version };
    }
    // Unfiltered — the four "internal" fullscreen events, fed straight to
    // `evolve` bypassing `decide`, so nonsense combos (e.g. a
    // FullscreenDesireRecorded against a settled record) exercise its
    // total handling directly, same as any other event variant here.
    case 11:
      return { type: 'FullscreenTransitionStarted', id, entering: randomBool(rng), preBounds: null };
    case 12:
      return { type: 'FullscreenDesireRecorded', id, desired: randomBool(rng) };
    case 13:
      return { type: 'OsFullscreenEntered', id };
    case 14:
      return { type: 'OsFullscreenLeft', id };
    case 15:
      return { type: 'FullscreenSettleTimeout', id };
    // Geometry commands (this slice) — go through `decide`, same
    // stale-expectedVersion treatment as the other command variants above.
    case 16: {
      const stale = rng() < 0.2;
      return { type: 'SetBounds', id, bounds: randomRectangle(rng), expectedVersion: stale ? state.version + 1 : state.version };
    }
    case 17: {
      const stale = rng() < 0.2;
      return { type: 'Maximize', id, expectedVersion: stale ? state.version + 1 : state.version };
    }
    case 18: {
      const stale = rng() < 0.2;
      return { type: 'Unmaximize', id, expectedVersion: stale ? state.version + 1 : state.version };
    }
    case 19: {
      const stale = rng() < 0.2;
      return {
        type: 'SetVisibleOnAllSpaces',
        id,
        on: randomBool(rng),
        expectedVersion: stale ? state.version + 1 : state.version,
      };
    }
    // Unfiltered — the OS-report-style geometry events, fed straight to
    // `evolve` bypassing `decide`, same reasoning as the fullscreen family
    // above (variants 11-15).
    case 20:
      return { type: 'BoundsChanged', id, bounds: randomRectangle(rng) };
    case 21: {
      const count = 1 + randomInt(rng, 2);
      const projections = Array.from({ length: count }, () => ({
        id: wid(randomInt(rng, POOL_SIZE)),
        bounds: randomRectangle(rng),
      }));
      return { type: 'DisplayChanged', projections };
    }
    case 22:
      return { type: 'MaximizeExitedByResize', id };
    // Unfiltered — `decide`'s own synthetic geometry translations, fed
    // directly so nonsense combos (e.g. a Maximized against a not-`normal`
    // fsMode) exercise evolve's total handling directly, same reasoning as
    // FullscreenTransitionStarted/FullscreenDesireRecorded above.
    case 23:
      return { type: 'Maximized', id, preMaxBounds: rng() < 0.5 ? null : randomRectangle(rng) };
    case 24:
      return { type: 'Unmaximized', id };
    case 25:
      return { type: 'PendingProjectionDiscarded', id };
    case 26:
      return { type: 'VisibleOnAllSpacesSet', id, on: randomBool(rng) };
    // Overlay attachment (this slice) — goes through `decide`, same
    // stale-expectedVersion treatment as the other command variants above.
    // hostId is drawn from the raw id pool (possibly unregistered, possibly
    // `id` itself) since `decide`'s guard is what's under test here.
    case 27: {
      const stale = rng() < 0.2;
      let hostId: WindowId | null = rng() < 0.2 ? null : wid(randomInt(rng, POOL_SIZE));
      if (hostId === id) hostId = null; // never target self — no window is its own overlay host
      return { type: 'AttachOverlay', overlayId: id, hostId, expectedVersion: stale ? state.version + 1 : state.version };
    }
    case 28: {
      // Unfiltered — decide's own synthetic translation of AttachOverlay,
      // fed straight to `evolve` (same reasoning as Maximized/Unmaximized
      // above). `hostId` is drawn from the raw id pool like every other
      // event variant here — possibly unregistered, possibly `id` itself,
      // possibly a since-closed id. This bypasses `decide`'s guard entirely,
      // so `evolve` must normalize a nonsensical host into a detach rather
      // than store it; `checkInvariants` below holds only because of that
      // normalization, not because this generator avoids the cases.
      const hostId: WindowId | null = rng() < 0.2 ? null : wid(randomInt(rng, POOL_SIZE));
      return { type: 'OverlayAttached', overlayId: id, hostId };
    }
    // App activation dance (this slice) — unfiltered, same reasoning as
    // case 6 (`AppResigned`) above: nonsense orderings (settle without a
    // resign, double activate, resign twice) are exactly what exercises the
    // arm/disarm/settle guard's total handling.
    case 29:
      return { type: 'AppActivated' };
    case 30:
      return { type: 'AppResignSettled' };
    // Unfiltered like everything else: the first-responder mirror is reported
    // for ids that were never registered, for `browser`-kind windows that
    // would never produce one in production, and in nonsense orders (held
    // twice, lost before ever held).
    case 31:
      return { type: 'ContentFirstResponderChanged', id, held: randomBool(rng) };
    // Teardown commands (§0.1.5) — through `decide`, same stale-expectedVersion
    // treatment as the other command variants above. `id` is drawn from the raw
    // pool exactly like everything else here, so the majority of these name a
    // window that was never registered or has already retired: that is not a
    // degenerate case for this family, it is the production one (`ipc.ts
    // runHybridFinalize`), and it is what exercises the unknown-window
    // exemption and the effect-invariant permission it forces.
    //
    // ALL FOUR SHARE ONE VARIANT SLOT, chosen by a sub-roll (same shape as the
    // `cause` sub-roll in variant 4). Four slots of their own would have cut
    // the whole rest of the generator's share by an eighth, and the focus-family
    // op rate the next describe MEASURES is thin enough that it moved: 27 seeds
    // -> 15, below its own floor. One slot keeps the existing coverage where it
    // was measured while still reaching every teardown arm.
    case 32: {
      const stale = rng() < 0.2;
      const expectedVersion = stale ? state.version + 1 : state.version;
      switch (randomInt(rng, 4)) {
        case 0:
          return { type: 'DestroyWindow', id, expectedVersion };
        case 1:
          return { type: 'CloseContent', id, expectedVersion };
        case 2:
          return { type: 'CloseWindowDirect', id, expectedVersion };
        // Names no window — the shape a caller-side fan-out would destroy.
        default:
          return { type: 'DestroyAllGuests', expectedVersion };
      }
    }
    // Stack-order import — the command and the raw event, by a sub-roll (same
    // shape as the `cause` sub-roll in variant 4). The payload comes from
    // `randomStackOrderPayload`, which is malformed as often as not: empty,
    // unknown ids, duplicates, partial subsets, full permutations. None of
    // those shapes is held back — the arm's membership preservation is claimed
    // to fall out of its construction rather than out of caller discipline,
    // and that claim is only tested if the generator attacks it.
    case 33: {
      const order = randomStackOrderPayload(rng);
      if (rng() < 0.5) return { type: 'StackOrderImported', order };
      const stale = rng() < 0.2;
      return { type: 'ImportStackOrder', order, expectedVersion: stale ? state.version + 1 : state.version };
    }
    // Cold-start focus latch — command and raw event, same sub-roll shape.
    // `null` is a real payload (it CLEARS the latch), not an omission, so it is
    // generated as a value. The id pool is WIDER than the registration pool, so
    // a latch naming a window that was never registered is ordinary generated
    // traffic; a latch naming a window CLOSED before any activation spends it
    // falls out on its own from the `WindowClosed` variant, and that is the
    // production case the arm's "needs no guard here, and gets none" rests on.
    case 34: {
      const latch: WindowId | null = rng() < 0.25 ? null : wid(randomInt(rng, POOL_SIZE + 2));
      if (rng() < 0.5) return { type: 'ColdStartFocusArmed', id: latch };
      const stale = rng() < 0.2;
      return { type: 'ArmColdStartFocus', id: latch, expectedVersion: stale ? state.version + 1 : state.version };
    }
    // Focus assert — command and raw event, and the split is load-bearing
    // rather than symmetry for its own sake: `decide` gates `AssertFocus` on
    // `isContentWindow`, so generating only the command would leave `evolve`'s
    // and `react`'s handling of an assert on a NON-content or unregistered
    // window ungenerated. `id` is drawn from the raw pool like every other
    // variant here, so most targets are one or the other.
    case 35:
    default: {
      if (rng() < 0.5) return { type: 'FocusAssertRequested', id };
      const stale = rng() < 0.2;
      return { type: 'AssertFocus', id, expectedVersion: stale ? state.version + 1 : state.version };
    }
  }
}

/**
 * Applies one log item: an `Event` folds straight through `evolve`; a
 * `Command` first goes through `decide` — a rejection is a no-op (same
 * `state` returned, by reference, so callers can tell nothing happened), an
 * acceptance folds its (possibly empty) event list, accumulating `react`
 * effects at each step exactly like a directly-supplied event would.
 */
function stepLogItem(state: State, item: LogItem): { state: State; effects: Effect[]; steps: Step[] } {
  if (!isCommand(item)) {
    const next = evolve(state, item);
    const effects = react(state, item, next);
    return { state: next, effects, steps: [{ prev: state, next, effects }] };
  }
  const decision = decide(state, item);
  if ('rejected' in decision) {
    return { state, effects: [], steps: [] };
  }
  let s = state;
  const effects: Effect[] = [];
  const steps: Step[] = [];
  for (const ev of decision.events) {
    const next = evolve(s, ev);
    const stepEffects = react(s, ev, next);
    effects.push(...stepEffects);
    steps.push({ prev: s, next, effects: stepEffects });
    s = next;
  }
  return { state: s, effects, steps };
}

/**
 * ONE `evolve`/`react` transition. Kept per-EVENT rather than per-log-item so
 * the op-token invariants below are stated over the unit they are actually
 * about: a command can fold into several events, and aggregating their effects
 * would blur which transition minted which token.
 */
interface Step {
  prev: State;
  next: State;
  effects: Effect[];
}

/**
 * THE OP-TOKEN INVARIANTS (`State.opSeqCounter` / `WindowRecord.lastOpSeq`).
 *
 * This is the counter that makes an echo's provenance ORDERABLE, and it is
 * inert unless `evolve` advances it — a frozen counter hands every op ever
 * issued the same token, so `isStaleSelfEcho` matches nothing live traffic
 * produces while every example-based test that injects a synthetic older
 * token still passes. Stated as a biconditional in both directions, so the
 * counter cannot go inert (no advance where an op is issued) or noisy
 * (an advance where none is) without a failure here:
 *
 *   1. the counter advances by exactly 1 on a transition that emits at least
 *      one focus-family effect, and not at all on any other transition;
 *   2. every focus-family effect carries `next.opSeqCounter` as its token;
 *   3. the record that effect names carries the SAME number as `lastOpSeq` —
 *      `evolve`'s stamp and `react`'s token are one value, which is what lets
 *      the echo the backend sends back line up with the stamp the guard
 *      compares it against.
 */
function checkOpSeqInvariants(step: Step): string[] {
  const violations: string[] = [];
  const stamped = step.effects.filter((e) => e.type === 'ShowWindow' || e.type === 'RaiseWindow');
  const expected = step.prev.opSeqCounter + (stamped.length > 0 ? 1 : 0);
  if (step.next.opSeqCounter !== expected) {
    violations.push(
      `opSeqCounter moved ${step.prev.opSeqCounter} -> ${step.next.opSeqCounter} on a transition emitting ${stamped.length} focus-family effect(s); expected ${expected}`,
    );
  }
  for (const effect of stamped) {
    const token = (effect as { opSeq: number }).opSeq;
    if (token !== step.next.opSeqCounter) {
      violations.push(`${effect.type} for ${effect.id} carries opSeq ${token}, not next.opSeqCounter ${step.next.opSeqCounter}`);
    }
    const record = step.next.order.find((w) => w.id === effect.id);
    if (record === undefined || record.lastOpSeq !== token) {
      violations.push(
        `${effect.type} for ${effect.id} was issued with token ${token} but the record stamps lastOpSeq=${JSON.stringify(record?.lastOpSeq)}`,
      );
    }
  }
  return violations;
}

function generateLog(seed: number, length: number): LogItem[] {
  const rng = mulberry32(seed);
  const log: LogItem[] = [];
  let state = initialState();
  for (let i = 0; i < length; i++) {
    const item = randomLogItem(rng, state);
    log.push(item);
    state = stepLogItem(state, item).state;
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
    // Fullscreen (§0.1.8): `fsMode.name` is always one of the four, and
    // `preBounds` is present exactly when non-normal — never a missing key
    // on a non-normal record, never a stray key on `normal`.
    const fsModeNames = ['normal', 'entering', 'fullscreen', 'leaving'];
    if (!fsModeNames.includes(record.fsMode.name)) {
      violations.push(`invalid fsMode.name for ${record.id}: ${JSON.stringify(record.fsMode)}`);
    }
    const hasPreBounds = 'preBounds' in record.fsMode;
    if (record.fsMode.name === 'normal' && hasPreBounds) {
      violations.push(`normal fsMode carries a preBounds key for ${record.id}: ${JSON.stringify(record.fsMode)}`);
    }
    if (record.fsMode.name !== 'normal' && !hasPreBounds) {
      violations.push(`non-normal fsMode missing preBounds for ${record.id}: ${JSON.stringify(record.fsMode)}`);
    }

    // Geometry (this slice): preMaxBounds is non-null EXACTLY while maximized.
    if (record.preMaxBounds !== null && !record.maximized) {
      violations.push(`preMaxBounds is non-null while not maximized for ${record.id}: ${JSON.stringify(record.preMaxBounds)}`);
    }
    // pendingProjectedBounds is held only while the window is blocked on at
    // least one axis (non-normal fsMode, or hidden).
    if (record.pendingProjectedBounds !== null && record.fsMode.name === 'normal' && record.visible) {
      violations.push(`pendingProjectedBounds held for ${record.id} but neither axis is blocked`);
    }

    // Overlay attachment (this slice): `overlayFor` never dangles onto a
    // window absent from `order`, and no window is its own overlay host.
    if (record.overlayFor !== undefined) {
      if (!state.order.some((w) => w.id === record.overlayFor)) {
        violations.push(`overlayFor names a window absent from order for ${record.id}: ${JSON.stringify(record.overlayFor)}`);
      }
      if (record.overlayFor === record.id) {
        violations.push(`window is its own overlay host: ${record.id}`);
      }
    }

    // App activation dance (this slice): `hiddenByAppBlur` names a window the
    // sweep hid — it can never be true on a window that is currently visible.
    if (record.hiddenByAppBlur === true && record.visible) {
      violations.push(`hiddenByAppBlur is set on a visible window: ${record.id}`);
    }

    // Transient autoclose (this slice): `role` is an intrinsic declared at
    // registration — either absent or a non-empty string, never an empty
    // string or a non-string smuggled through the merge.
    if (record.role !== undefined && (typeof record.role !== 'string' || record.role.length === 0)) {
      violations.push(`malformed role for ${record.id}: ${JSON.stringify(record.role)}`);
    }

    // Escape override: absent, or exactly the ONE live value. Nothing may
    // smuggle a fourth-vocabulary value ('auto'/'close'/'navigate') onto a
    // record through the registration merge.
    if (record.escapeMode !== undefined && record.escapeMode !== 'ignore') {
      violations.push(`invalid escapeMode for ${record.id}: ${JSON.stringify(record.escapeMode)}`);
    }

    // First-responder mirror: THREE-VALUED. Absent, `true`, or `false` — and
    // never anything that would let a consumer's `=== false` test misfire.
    if (record.contentFocused !== undefined && typeof record.contentFocused !== 'boolean') {
      violations.push(`malformed contentFocused for ${record.id}: ${JSON.stringify(record.contentFocused)}`);
    }

    // The content predicate is SOUND: everything it admits is visible, can
    // hold key, and declares a document-like role. Restated independently
    // (like the role sets below) so this is a check, not a tautology.
    if (isContentWindow(record)) {
      if (!record.visible || !record.canBecomeKey) {
        violations.push(`isContentWindow admitted a hidden or non-key-capable window: ${record.id}`);
      }
      if (record.role === undefined || !CONTENT_ROLES_EXPECTED.has(record.role)) {
        violations.push(`isContentWindow admitted a non-content role for ${record.id}: ${JSON.stringify(record.role)}`);
      }
    }

    // The `hiddenByAppBlur` / `AppActivated` interaction, asserted rather than
    // reasoned about in a comment: a content window is never a candidate for
    // the app-resign hide sweep, so the predicate's `visible` clause cannot
    // flicker across an app switch. The two predicates disagree on
    // `canBecomeKey` by construction; this catches either one drifting.
    if (isContentWindow(record) && isAppResignSweepEligible(record)) {
      violations.push(`a window is both content and app-resign-sweep eligible: ${record.id}`);
    }

    // `hostForOverlay` and `overlayFor` are the same fact read two ways.
    const host = hostForOverlay(state, record.id);
    if (record.overlayFor === undefined) {
      if (host !== null) {
        violations.push(`hostForOverlay returned a host for a detached record ${record.id}: ${host.id}`);
      }
    } else if (host === null || host.id !== record.overlayFor) {
      violations.push(`hostForOverlay disagreed with overlayFor for ${record.id}: ${JSON.stringify(host?.id)}`);
    }
  }

  // App activation dance (this slice): the sweep flag can only be armed while
  // the app is inactive — `AppActivated` disarms it in the same step it flips
  // `appActive` true.
  if (state.appActive && state.pendingAppResignSweep) {
    violations.push('pendingAppResignSweep is true while appActive is true');
  }

  const kw = keyWindow(state);
  if (kw !== null && !state.order.some((w) => w.id === kw.id)) {
    violations.push(`keyWindow() resolved to a record not present in order: ${JSON.stringify(kw)}`);
  }

  // §0.1.10 — ONE ORDER: whenever `key` resolves to a record, that record is
  // the TOPMOST one. A fresh registration is inserted BELOW the key window
  // and a focus gain moves its target to the end — those two transitions are
  // why the clause holds in general. It is NOT true, though, that no other
  // transition touches membership or position:
  //
  //   - `WindowClosed`'s parent-refocus (`evolve`'s `WindowClosed` arm) moves
  //     an eligible parent to the top of `order`, but ONLY when the closed
  //     record itself held `key` — `key` then still names the just-removed
  //     id, so `keyWindow` below resolves to null and this clause is skipped
  //     entirely for that transition. The move can never land a parent above
  //     a record that still holds a LIVE key, by construction, not by luck.
  //   - `StackOrderImported` permutes `order` and, without a further step,
  //     could violate this clause: a slot-preserving permutation naming the
  //     key window and one record below it would otherwise demote the key
  //     window. So the arm lifts the key window's record to the top after
  //     assembling the permutation, without ever touching `key` itself
  //     (unconditional — an import must never activate anything): the
  //     import holds the key window at top. Verified by hand on two
  //     registered windows: key on the upper one, import `[key, other]`, and
  //     the key window stays topmost.
  //
  // Stated over every generated log — including the nonsense ones — rather
  // than over the hand-written scenes, because the pre-rule kernel
  // (registration appended on top) violated it with two events.
  const top = state.order[state.order.length - 1];
  if (kw !== null && top !== undefined && top.id !== kw.id) {
    violations.push(`the key window is not topmost in order: key=${kw.id} top=${top.id}`);
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
    // Teardown (§0.1.5): `lastTeardown.seq` is what `react` diffs, so it must
    // never repeat a value and never go backwards — two identical requests for
    // the same window have to read as two teardowns. Nothing clears the field
    // either: once set it stays set, so a later transition can never turn a
    // recorded teardown back into `null`.
    if (prev.lastTeardown !== null && state.lastTeardown === null) {
      violations.push('lastTeardown was cleared back to null');
    }
    if (state.lastTeardown !== null && prev.lastTeardown !== null && state.lastTeardown.seq < prev.lastTeardown.seq) {
      violations.push(`lastTeardown.seq decreased: prev=${prev.lastTeardown.seq} next=${state.lastTeardown.seq}`);
    }
    // Focus assert: the same two clauses, for the same reason — the whole
    // family rests on `lastFocusAssert.seq` being what `react` diffs, and the
    // payload is IDENTICAL between consecutive requests (the same window, every
    // devtools open and close), so a repeated or reset seq collapses two
    // asserts into one and the second re-assert silently never reaches the OS.
    if (prev.lastFocusAssert !== null && state.lastFocusAssert === null) {
      violations.push('lastFocusAssert was cleared back to null');
    }
    if (
      state.lastFocusAssert !== null &&
      prev.lastFocusAssert !== null &&
      state.lastFocusAssert.seq < prev.lastFocusAssert.seq
    ) {
      violations.push(`lastFocusAssert.seq decreased: prev=${prev.lastFocusAssert.seq} next=${state.lastFocusAssert.seq}`);
    }
    // Attention: the same two clauses again, for the same reason — `react`'s
    // transient-autoclose sweep rests on `lastAttention.seq` being what it
    // diffs, and the old machine ran that sweep on EVERY `OS_FOCUS_GAINED`
    // report (including an echo re-confirming the window that already holds
    // key), so a repeated or reset seq would collapse two reports — and two
    // sweeps — into one.
    if (prev.lastAttention !== null && state.lastAttention === null) {
      violations.push('lastAttention was cleared back to null');
    }
    if (
      state.lastAttention !== null &&
      prev.lastAttention !== null &&
      state.lastAttention.seq < prev.lastAttention.seq
    ) {
      violations.push(
        `lastAttention.seq decreased: prev=${prev.lastAttention.seq} next=${state.lastAttention.seq}`,
      );
    }
    // `orderable` never goes true -> false (§0.1.4: "Never reset once true").
    for (const prevRecord of prev.order) {
      const nextRecord = state.order.find((w) => w.id === prevRecord.id);
      if (nextRecord !== undefined && prevRecord.orderable && !nextRecord.orderable) {
        violations.push(`orderable flipped true -> false for ${prevRecord.id}`);
      }
      // `lastOpSeq` (focus provenance) never decreases per window.
      if (
        nextRecord !== undefined &&
        prevRecord.lastOpSeq !== undefined &&
        (nextRecord.lastOpSeq === undefined || nextRecord.lastOpSeq < prevRecord.lastOpSeq)
      ) {
        violations.push(`lastOpSeq decreased for ${prevRecord.id}: prev=${prevRecord.lastOpSeq} next=${nextRecord.lastOpSeq}`);
      }
      // `contentFocused` NEVER DECAYS BACK TO ABSENT. Once the OS has
      // reported first-responder status for a window, "nothing reported yet"
      // is no longer a true statement about it — and it is a DIFFERENT answer
      // from `false` for every consumer (see the field's doc). The only way
      // to lose it is a registration merge dropping the field, which is
      // exactly the bug class both prior property-test failures were.
      if (nextRecord !== undefined && prevRecord.contentFocused !== undefined && nextRecord.contentFocused === undefined) {
        violations.push(`contentFocused decayed back to absent for ${prevRecord.id}`);
      }
      // Same rule for the Escape override, for the same reason: a
      // re-registration that omits it means "did not report", never "clear".
      if (nextRecord !== undefined && prevRecord.escapeMode !== undefined && nextRecord.escapeMode === undefined) {
        violations.push(`escapeMode was silently stripped from ${prevRecord.id}`);
      }
    }
  }

  return violations;
}

/**
 * Extra invariant tied to a specific log item rather than to `state` alone
 * (§0.1.8): a window named by a `FullscreenSettleTimeout` must never sit in
 * `entering`/`leaving` afterward — that's the entire point of the event.
 */
function checkSettleTimeoutInvariant(item: LogItem, prev: State, next: State): string[] {
  const violations: string[] = [];
  if (item.type !== 'FullscreenSettleTimeout') return violations;

  const record = next.order.find((w) => w.id === item.id);
  if (record === undefined) return violations; // named a window that is not there — nothing to settle and nothing to ask about
  if (record.fsMode.name !== 'entering' && record.fsMode.name !== 'leaving') return violations;

  // The record is still in flight, which is CORRECT and is the whole contract:
  // the machine cannot know from the inside whether the OS completed the
  // transition, so a settle timeout asks rather than decides (§0, `fsMode`
  // reconcile). What it may never do is drop the question — a timeout that
  // leaves a window transitional AND asks nothing has stranded it, because no
  // later event will settle `fsMode` on its own.
  //
  // This replaced an earlier invariant asserting the opposite — that a settle
  // timeout must leave no record transitional. That held only while `evolve`
  // force-settled `fsMode` from its own belief, which the old reducer never
  // did and which could strand `preBounds` or leave a black macOS Space when
  // the guess was wrong.
  const recon = next.lastFsReconcile;
  const asked = recon !== null && recon.seq !== prev.lastFsReconcile?.seq && recon.ids.includes(item.id);
  if (!asked) {
    violations.push(
      `FullscreenSettleTimeout left ${item.id} in ${JSON.stringify(record.fsMode)} without a fresh lastFsReconcile naming it`,
    );
  }
  return violations;
}

/**
 * Extra invariants on the two transient-autoclose selectors, checked against
 * every generated state. The role set is restated here rather than imported
 * — the kernel keeps it private, and an independent restatement is what makes
 * this a check rather than a tautology. The exemption itself is NOT a role
 * set to restate: it's a relation over `overlayFor`/`parentId` (§0,
 * "Ownership, not role"), so the checks below read that relation directly off
 * `state` instead of a mirrored constant.
 */
/**
 * The document-like roles `isContentWindow` admits, restated independently of
 * the kernel's own `CONTENT_ROLES` for the same reason as the set below: an
 * imported constant would make the soundness check a tautology.
 */
const CONTENT_ROLES_EXPECTED = new Set(['content', 'child-content', 'workspace']);

// Mirrors `window-kernel.ts TRANSIENT_ROLES` exactly. A role present there but
// missing here makes `isSweepableVictim` report a false violation the moment the
// generator emits it. `'switcher'` is in the kernel set and is now emitted by
// `ROLES` too, so this set is no longer latent — the generator can reach it.
const TRANSIENT_ROLES_EXPECTED = new Set(['palette', 'quick-view', 'overlay', 'switcher']);

function checkAutocloseInvariants(state: State): string[] {
  const violations: string[] = [];

  const isSweepableVictim = (id: WindowId, focusedId: WindowId): boolean => {
    const rec = state.order.find((w) => w.id === id);
    if (rec === undefined) return false;
    if (rec.id === focusedId) return false;
    if (!rec.visible) return false;
    if (rec.role === undefined) return false;
    if (!TRANSIENT_ROLES_EXPECTED.has(rec.role)) return false;
    if (rec.overlayFor !== undefined) return false;
    const focuser = state.order.find((w) => w.id === focusedId);
    if (focuser?.parentId === rec.id || focuser?.overlayFor === rec.id) return false;
    return true;
  };

  // Every id in the pool, plus one that is never registered, as the focuser.
  const focusers = [...Array.from({ length: POOL_SIZE }, (_, n) => wid(n)), wid(POOL_SIZE + 100)];
  const sweptByTransientAutoclose = new Set<WindowId>();
  for (const focusedId of focusers) {
    const world = selectTransientAutoclose(state, focusedId, { kind: 'world' });
    const machine = selectTransientAutoclose(state, focusedId, { kind: 'machine', opSeq: 0 });

    if (new Set(world).size !== world.length) {
      violations.push(`selectTransientAutoclose returned a duplicate id for ${focusedId}: ${JSON.stringify(world)}`);
    }
    for (const victim of [...world, ...machine]) {
      if (!isSweepableVictim(victim, focusedId)) {
        violations.push(`selectTransientAutoclose named an ineligible victim ${victim} for focuser ${focusedId}`);
      }
      sweptByTransientAutoclose.add(victim);
    }
    // A machine cause arms an ORDERING test — it can only ever spare windows
    // relative to a world-caused focus, never sweep extra ones.
    for (const victim of machine) {
      if (!world.includes(victim)) {
        violations.push(`machine-caused sweep is not a subset of the world-caused one for ${focusedId}: ${victim}`);
      }
    }
    // A window newer than the focuser is never in the machine-caused sweep.
    const focuser = state.order.find((w) => w.id === focusedId);
    if (focuser !== undefined) {
      for (const victim of machine) {
        const rec = state.order.find((w) => w.id === victim)!;
        if (rec.openSeq > focuser.openSeq) {
          violations.push(`machine-caused sweep took a window opened after the focuser: ${victim} > ${focusedId}`);
        }
      }
    }
  }

  // The app-resign hide sweep and the transient autoclose sweep answer
  // different questions about the same edge and may never name the same
  // window: `isAppResignSweepEligible` excludes every transient role, while
  // `selectTransientAutoclose` requires one — so the two sets are disjoint by
  // construction, checked here rather than left to that construction alone.
  // MEASURED at POOL_SIZE=6 / LOG_LENGTH=30 / 200 seeds, same run as the
  // op-token measurement above: of 5416 reached states, 1670 have at least
  // one transient-autoclose victim (for some focuser) and 916 have at least
  // one app-resign-sweep-eligible window, with both kinds of candidate present
  // in the same state 315 times — none of those co-occurrences trips the
  // clause below, because it is the SAME window that is forbidden from being
  // both, not merely the same state holding one of each. The three biases
  // pushed `order` deep enough that the two candidate sets routinely coexist,
  // which is exactly the condition this clause needs to be worth checking.
  for (const record of state.order) {
    if (isAppResignSweepEligible(record) && sweptByTransientAutoclose.has(record.id)) {
      violations.push(`a window is both eligible for the app-resign hide sweep and swept by transient autoclose: ${record.id}`);
    }
  }

  return violations;
}

/**
 * Extra invariant proving `react` actually APPLIES `selectTransientAutoclose`
 * for the transition it just ran, rather than a lookalike rule that matches
 * nothing in practice (this repo's documented failure mode for predicates).
 * `checkAutocloseInvariants` above only checks the selector's own soundness in
 * isolation, against every possible focuser — it says nothing about whether
 * `react`'s emitted `DismissWindow` effects are actually its output for the
 * ONE real transition that just happened.
 *
 * `next.lastAttention` is the same fact `react` diffs, so this check reads no
 * event payload either — a genuine `prev`/`next` comparison, not a
 * restatement of `react`'s own condition. A non-null `holder` absent from
 * `next.order` is INDETERMINATE and expects no dismissal, mirroring `react`'s
 * own guard; a `null` holder is a determinate fact and expects the sweep to
 * run — see `react`'s own comment for why the two are not symmetric.
 *
 * Kept per-EVENT (`Step`, same unit `checkOpSeqInvariants` uses above), not
 * per-log-item: a command can fold into several events, and aggregating their
 * effects would blur which transition's attention advance produced which
 * dismissal.
 */
function checkAutocloseWiring(step: Step): string[] {
  const { prev, next, effects } = step;
  const violations: string[] = [];
  const dismissed = new Set(effects.filter((e) => e.type === 'DismissWindow').map((e) => e.id));

  const attention = next.lastAttention;
  const advanced = attention !== null && attention.seq !== prev.lastAttention?.seq;
  const holder = attention?.holder ?? null;
  const indeterminate = holder !== null && !next.order.some((w) => w.id === holder);

  if (advanced && !indeterminate && attention !== null) {
    const expected = new Set(selectTransientAutoclose(next, holder, attention.cause));
    if (expected.size !== dismissed.size || [...expected].some((id) => !dismissed.has(id))) {
      violations.push(
        `react's DismissWindow effects diverged from selectTransientAutoclose: expected=${JSON.stringify([...expected])} actual=${JSON.stringify([...dismissed])}`,
      );
    }
  } else if (dismissed.size > 0) {
    violations.push(
      `DismissWindow effect(s) emitted with no attention advance to a determinate holder: ${JSON.stringify([...dismissed])}`,
    );
  }

  return violations;
}

/**
 * Extra invariant on `react`'s output: every emitted effect names a window
 * still in `next.order` — this is what guarantees, among other things, that
 * no `SetBounds` effect (this slice) ever names a window absent from `order`.
 *
 * `CloseWindow` is the one deliberate exception: RULE 1 makes `WindowClosed`
 * the sole way membership shrinks, so `react` derives `CloseWindow` from a
 * record's ABSENCE in `next.order` (see `react`'s close diff) — the effect
 * can only ever name a window that has already left `order`, by construction.
 *
 * The three window-naming TEARDOWN effects (§0.1.5) are permitted the same
 * absence, and each for the same measured reason rather than for tidiness:
 * their commands are exempt from `decide`'s unknown-window rejection because
 * `ipc.ts runHybridFinalize` dispatches a content-close naming a window
 * `finalizeWindowClose` retired microseconds earlier, in the same synchronous
 * body, on every hybrid close (the opener-initiated path has the same shape,
 * its `hostMachineId` being a captured constant). Requiring presence here
 * would assert the opposite of what the port must accept. The permission is
 * exactly these three and stops there: it is granted per effect type, never
 * widened to "teardown-ish" effects, and every other effect type still has to
 * name a live record.
 *
 * `DestroyAllGuests` is skipped before the lookup rather than permitted after
 * it: it carries no `id` at all (the port iterates the process-wide guest map),
 * so "names a window not in order" is not a question that can be asked of it.
 */
const TEARDOWN_EFFECTS_MAY_NAME_A_RETIRED_WINDOW: ReadonlySet<Effect['type']> = new Set([
  'DestroyWindow',
  'CloseContent',
  'CloseWindowDirect',
]);

function checkEffectInvariants(effects: Effect[], next: State): string[] {
  const violations: string[] = [];
  for (const effect of effects) {
    if (effect.type === 'DestroyAllGuests') continue;
    const record = next.order.find((w) => w.id === effect.id);
    if (record === undefined) {
      if (effect.type === 'CloseWindow') continue;
      if (TEARDOWN_EFFECTS_MAY_NAME_A_RETIRED_WINDOW.has(effect.type)) continue;
      violations.push(`effect names a window not present in order: ${JSON.stringify(effect)}`);
      continue;
    }
    // No SetStacking effect may ever name a non-orderable or non-visible window.
    if (effect.type === 'SetStacking' && (!record.visible || !record.orderable)) {
      violations.push(`SetStacking named a non-visible/non-orderable window: ${JSON.stringify(effect)} record=${JSON.stringify(record)}`);
    }
  }
  return violations;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fold helpers over a mixed `LogItem[]` — an `Event` folds straight through
// `evolve`; a `Command` goes through `decide`/`stepLogItem` first (see above).
// ─────────────────────────────────────────────────────────────────────────────

function fold(log: LogItem[], start: State = initialState()): State {
  let state = start;
  for (const item of log) {
    state = stepLogItem(state, item).state;
  }
  return state;
}

function foldWithEffects(log: LogItem[], start: State = initialState()): { state: State; effects: Effect[] } {
  let state = start;
  const effects: Effect[] = [];
  for (const item of log) {
    const r = stepLogItem(state, item);
    effects.push(...r.effects);
    state = r.state;
  }
  return { state, effects };
}

/** Reproducibility: every failure message carries the seed and the full JSON log, so it replays verbatim. */
function reproMessage(seed: number, log: LogItem[], stepIndex: number, detail: string): string {
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
        const item = log[i];
        let result: { state: State; effects: Effect[]; steps: Step[] };
        try {
          result = stepLogItem(state, item);
        } catch (err) {
          throw new Error(reproMessage(seed, log, i, `evolve/decide threw: ${(err as Error).message}`));
        }
        const { state: next, effects, steps } = result;

        // Per-EVENT, and checked before the `next === state` early-out below:
        // a command that folds to zero events is a genuine no-op, but a
        // transition that changed nothing else can still have moved the
        // counter, and that would be a bug rather than a no-op.
        for (const step of steps) {
          const opSeqViolations = checkOpSeqInvariants(step);
          if (opSeqViolations.length > 0) {
            throw new Error(reproMessage(seed, log, i, `op-token invariant violation(s): ${opSeqViolations.join('; ')}`));
          }
          const wiringViolations = checkAutocloseWiring(step);
          if (wiringViolations.length > 0) {
            throw new Error(reproMessage(seed, log, i, `autoclose wiring violation(s): ${wiringViolations.join('; ')}`));
          }
        }

        // A rejected command is a no-op — same state, no events, nothing to
        // check (the version-strictly-increases invariant would misfire on
        // a genuine no-op, since nothing happened).
        if (next === state) {
          continue;
        }

        const stateViolations = checkInvariants(next, state);
        if (stateViolations.length > 0) {
          throw new Error(reproMessage(seed, log, i, `invariant violation(s): ${stateViolations.join('; ')}`));
        }

        const effectViolations = checkEffectInvariants(effects, next);
        if (effectViolations.length > 0) {
          throw new Error(reproMessage(seed, log, i, `effect invariant violation(s): ${effectViolations.join('; ')}`));
        }

        const autocloseViolations = checkAutocloseInvariants(next);
        if (autocloseViolations.length > 0) {
          throw new Error(reproMessage(seed, log, i, `autoclose invariant violation(s): ${autocloseViolations.join('; ')}`));
        }

        const settleViolations = checkSettleTimeoutInvariant(item, state, next);
        if (settleViolations.length > 0) {
          throw new Error(reproMessage(seed, log, i, `settle-timeout invariant violation(s): ${settleViolations.join('; ')}`));
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
// The op-token invariants, proven non-vacuous — MEASURED, not assumed. Both
// halves matter: the generated logs must actually issue focus-family ops (or
// clause 1 never has a positive case to check), and the checker must actually
// name a violation when the counter misbehaves (or it is decoration).
// ─────────────────────────────────────────────────────────────────────────────

describe('window-kernel: the op-token invariants are not vacuous', () => {
  /**
   * MEASURED at POOL_SIZE=6 / LOG_LENGTH=30 / 200 seeds: 190 seeds issue an
   * op, 524 ops in 6000 generated log items. No longer thin — the three
   * leading-roll biases above `randomLogItem` (`REGISTRATION_BIAS`,
   * `EXISTING_WINDOW_BIAS`, `SHOWN_BIAS`) exist specifically to raise the odds
   * of the combination an op needs: a REGISTERED window that is also
   * currently hidden (a show) or not currently the key holder (a raise). They
   * did — an op now fires in the large majority of seeds instead of a fifth
   * of them.
   *
   * THE NUMBER IS TRAJECTORY-SENSITIVE, not proportional to how many variants
   * exist. It was 27 seeds / 28 ops before the teardown variant (32) was added,
   * then 19/20 after, then 31/33, then 37/41 once variant 35's raw
   * `FocusAssertRequested` started minting tokens of its own; one extra
   * variant cannot dilute or inflate a rate by a third, and it did not —
   * adding any variant re-rolls every seed's whole log, and this rate rides on
   * id/state coincidences, so it moves for reasons unrelated to the addition
   * by itself. The jump to 190/524 has an unambiguous cause, not a re-roll
   * artifact: `REGISTRATION_BIAS` / `EXISTING_WINDOW_BIAS` / `SHOWN_BIAS` put
   * a registered, often-visible window in play on most log items instead of
   * leaving it to a rare id-pool coincidence, so a show or a raise stopped
   * being the exception and became the common case. Re-measure and re-record
   * after any generator or rule change rather than reading a move either way
   * as a regression. A counter that stopped advancing would fail ~190 seeds
   * here, which is a signal but not the proof; the example-based coverage
   * (`window-kernel.test.ts` "the op counter advances once per issued op",
   * `window-kernel-executor.test.ts` "drops the late echo of a superseded op")
   * is what actually pins this behaviour. Constraining generation to make ops
   * common is exactly the move that would make the invariant vacuous — the
   * generator stays unfiltered, and this rate is a side effect of biasing
   * WHICH window a payload names, not of suppressing anything; this test just
   * states the measurement.
   *
   * WHAT THE THREE NEWEST FAMILIES ACTUALLY REACH, measured the same way. The
   * same three biases also lifted `order`'s typical depth — averaging 2.86
   * (out of a POOL_SIZE of 6, n=5416 reached states, max 6) where it used to
   * sit at 0-1 — so a payload drawn from the id pool now names something live
   * far more often, and the arms below moved with it:
   *
   *   - stack-order import: 92 generated (down from ~170 — the leading rolls
   *     eat into the flat 36-way switch's own share), 15 of them actually
   *     PERMUTE `order`, and 3 land while `key` resolves. So the
   *     membership-preservation clause sees real permutations regularly now,
   *     not barely.
   *   - cold-start latch: 107 arms, and 23 activations spend a held latch —
   *     of those, 7 name a window that IS in `order` and visible, so the
   *     arm's raise-emitting half (a latch spent onto a live window) is now
   *     generated rather than reaching only `window-kernel.test.ts`.
   *   - focus assert: 84 generated, 21 naming a window absent from `order`,
   *     60 naming a registered NON-content window, and 3 naming a content
   *     window — so `react`'s `FocusContent` half of the assert rule is now
   *     generated (3 times) instead of zero, matching the 3 `FocusContent`
   *     effects `react` actually emitted across the run.
   *
   * A CONFLICT THIS GENERATION DID NOT HAPPEN TO HIT, recorded so it is not
   * rediscovered as a mystery failure. The §0.1.10 one-order clause in
   * `checkInvariants` ("the key window is not topmost in order") justifies
   * itself with "no other transition touches membership or position" — and
   * `StackOrderImported` permutes within the slots the named ids occupy
   * without touching `key` (deliberately: an import must never activate
   * anything). Left there, an import naming the key window and one below it
   * would demote the key window and violate the clause — so the arm lifts
   * the key window's record to the top after assembling the permutation.
   * Verified by hand on two registered windows: key on the upper one, import
   * `[key, other]`, and the key window stays topmost. Even with the deeper
   * `order` the biases now produce, only 3 of the 15 permuting imports above
   * land while `key` resolves, so this case still leans on the hand check
   * rather than on generation alone.
   */
  it('the generated logs issue focus-family ops at the measured rate', () => {
    let issued = 0;
    let seedsWithAnOp = 0;
    for (let seed = 0; seed < SEED_COUNT; seed++) {
      const log = generateLog(seed, LOG_LENGTH);
      let state = initialState();
      let emittingTransitions = 0;
      let count = 0;
      for (const item of log) {
        const result = stepLogItem(state, item);
        for (const step of result.steps) {
          const stamped = step.effects.filter((e) => e.type === 'ShowWindow' || e.type === 'RaiseWindow');
          count += stamped.length;
          if (stamped.length > 0) emittingTransitions += 1;
        }
        state = result.state;
      }
      issued += count;
      if (count > 0) seedsWithAnOp += 1;
      assert.strictEqual(state.opSeqCounter, emittingTransitions, `seed ${seed}: one token minted per emitting transition`);
    }
    // Floors sit just under the recorded measurement (190/524) — a wider
    // margin than the earlier pairs (15/15 under 19/20, 20/20 under 27/28,
    // 25/25 under 31/33, 30/30 under 37/41) carried, because the biases moved
    // the trajectory by an order of magnitude, not by a few counts. They exist
    // to catch the invariant going vacuous, not to pin an exact trajectory.
    assert.ok(seedsWithAnOp >= 150, `only ${seedsWithAnOp}/${SEED_COUNT} seeds issued an op (${issued} ops total)`);
    assert.ok(issued >= 400, `only ${issued} focus-family ops across ${SEED_COUNT} seeds`);
  });

  it('the checker names the violation when the counter goes inert', () => {
    // The pre-fix shape, hand-built: a transition that emits a ShowWindow but
    // leaves the counter (and the record's stamp) where they were.
    const id = wid(0);
    const reg: Event = { type: 'WindowRegistered', id, kind: 'browser', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' };
    const prev = fold([reg]);
    const next = evolve(prev, { type: 'WindowShown', id });
    const inert: State = {
      ...next,
      opSeqCounter: prev.opSeqCounter,
      order: next.order.map((w) => (w.id === id ? { ...w, lastOpSeq: prev.opSeqCounter } : w)),
    };
    const violations = checkOpSeqInvariants({
      prev,
      next: inert,
      effects: [{ type: 'ShowWindow', id, opSeq: inert.opSeqCounter }],
    });
    assert.deepStrictEqual(violations, [
      `opSeqCounter moved 0 -> 0 on a transition emitting 1 focus-family effect(s); expected 1`,
    ]);
  });

  it('the checker names the violation when the stamp and the token disagree', () => {
    // The other half of the round trip: the counter advanced and `react`
    // stamped the effect, but the record kept an older `lastOpSeq` — the shape
    // a stamp written from the PRE-transition counter produces.
    const id = wid(0);
    const reg: Event = { type: 'WindowRegistered', id, kind: 'browser', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary' };
    const prev = fold([reg]);
    const next = evolve(prev, { type: 'WindowShown', id });
    const mismatched: State = {
      ...next,
      order: next.order.map((w) => (w.id === id ? { ...w, lastOpSeq: prev.opSeqCounter } : w)),
    };
    const violations = checkOpSeqInvariants({
      prev,
      next: mismatched,
      effects: [{ type: 'ShowWindow', id, opSeq: mismatched.opSeqCounter }],
    });
    assert.deepStrictEqual(violations, [
      `ShowWindow for ${id} was issued with token 1 but the record stamps lastOpSeq=0`,
    ]);
  });
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

// ─────────────────────────────────────────────────────────────────────────────
// Pinned placement coverage (§0.1.10) — same reasoning as the merge coverage
// below: the generator's odds of registering a window WHILE another one holds
// key are thin (only ~2 of the 36 variants register, and `key` stays null
// until a focus event names an id that a registration already created), so the
// one-order invariant is pinned on a hand-built log rather than left to
// generator luck.
// ─────────────────────────────────────────────────────────────────────────────

describe('window-kernel: a registration never lands above the key window', () => {
  const inUse = wid(0);
  const opened = wid(1);

  const register = (id: WindowId): Event => ({
    type: 'WindowRegistered',
    id,
    kind: 'page-host',
    layer: 0,
    canBecomeKey: true,
    acceptsInput: true,
    class: 'primary',
    role: 'content',
  });

  const windowInUse = (): LogItem[] => [register(inUse), { type: 'WindowShown', id: inUse }, { type: 'OsFocusGained', id: inUse }];

  it('a background open goes under the key window, and every invariant still holds', () => {
    const before = fold(windowInUse());
    const after = evolve(before, register(opened));
    assert.deepStrictEqual(after.order.map((w) => w.id), [opened, inUse]);
    assert.deepStrictEqual(checkInvariants(after, before), []);
  });

  it('the invariant names the violation when a record IS placed on top', () => {
    // The pre-rule shape (`order: [...state.order, record]`), hand-built, so
    // the clause is proven to fire rather than merely present.
    const before = fold([...windowInUse(), register(opened)]);
    const appended: State = {
      ...before,
      order: [...before.order.filter((w) => w.id !== opened), before.order.find((w) => w.id === opened)!],
      version: before.version + 1,
    };
    assert.deepStrictEqual(checkInvariants(appended, before), [
      `the key window is not topmost in order: key=${inUse} top=${opened}`,
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pinned merge coverage — MEASURED, not assumed. The random generator's odds
// of producing "a lived fact is written for id X, and X is then re-registered
// while still live" are thin at POOL_SIZE=6 / LOG_LENGTH=30: only ~2 of the
// 36 variants register, so most ids are never registered at all, and across
// all 200 seeds the combination for a given field may not occur even once.
// That was checked by deliberately dropping `contentFocused` from the merge:
// every seed still passed. So the merge invariants above are pinned here on a
// hand-built log instead of left to generator luck — the re-registration merge
// is where both bugs this property suite has ever caught lived, and each was a
// lived field silently dropped.
// ─────────────────────────────────────────────────────────────────────────────

describe('window-kernel: the re-registration merge preserves every lived fact', () => {
  const id = wid(0);
  const host = wid(1);

  const register = (escapeMode?: 'ignore'): Event => ({
    type: 'WindowRegistered',
    id,
    kind: 'page-host',
    layer: 1,
    canBecomeKey: true,
    acceptsInput: true,
    class: 'primary',
    role: 'content',
    ...(escapeMode !== undefined ? { escapeMode } : {}),
  });

  /** A log that writes every lived fact the record can carry, then re-registers. */
  const livedLog = (): LogItem[] => [
    { type: 'WindowRegistered', id: host, kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'content' },
    register('ignore'),
    { type: 'WindowShown', id },
    { type: 'OsFocusGained', id },
    { type: 'WindowContentOrderable', id },
    { type: 'BoundsChanged', id, bounds: { x: 1, y: 2, width: 3, height: 4 } },
    { type: 'Maximized', id, preMaxBounds: { x: 5, y: 6, width: 7, height: 8 } },
    { type: 'VisibleOnAllSpacesSet', id, on: true },
    { type: 'OverlayAttached', overlayId: id, hostId: host },
    { type: 'ContentFirstResponderChanged', id, held: false },
    { type: 'FullscreenTransitionStarted', id, entering: true, preBounds: { x: 9, y: 9, width: 9, height: 9 } },
  ];

  it('a re-registration that names none of them changes no lived fact', () => {
    const before = fold(livedLog());
    const after = evolve(before, register());
    const prevRecord = before.order.find((w) => w.id === id)!;
    const nextRecord = after.order.find((w) => w.id === id)!;

    // Everything except `version` is identical — the merge overwrote the
    // intrinsics with the same values and touched nothing else.
    assert.deepStrictEqual(nextRecord, prevRecord);
    assert.deepStrictEqual(checkInvariants(after, before), []);
  });

  it('every lived fact is actually set, so the assertion above is not vacuous', () => {
    const record = fold(livedLog()).order.find((w) => w.id === id)!;
    assert.strictEqual(record.visible, true);
    assert.strictEqual(record.orderable, true);
    assert.strictEqual(record.fsMode.name, 'entering');
    assert.notStrictEqual(record.bounds, undefined);
    assert.strictEqual(record.maximized, true);
    assert.notStrictEqual(record.preMaxBounds, null);
    assert.strictEqual(record.visibleOnAllSpaces, true);
    assert.strictEqual(record.overlayFor, host);
    assert.notStrictEqual(record.lastOpSeq, undefined);
    assert.strictEqual(record.contentFocused, false);
    assert.strictEqual(record.escapeMode, 'ignore');
  });

  it('the hiddenByAppBlur mark survives a re-registration mid-sweep', () => {
    // Registered non-focusable + floating so the sweep takes it, which is the
    // only way to set the mark.
    const swept = wid(2);
    const reg: Event = { type: 'WindowRegistered', id: swept, kind: 'browser', layer: 1, canBecomeKey: false, acceptsInput: true, class: 'hud', role: 'workspace' };
    const before = fold([reg, { type: 'WindowShown', id: swept }, { type: 'AppResigned' }, { type: 'AppResignSettled' }]);
    assert.strictEqual(before.order.find((w) => w.id === swept)?.hiddenByAppBlur, true);

    const after = evolve(before, reg);
    assert.strictEqual(after.order.find((w) => w.id === swept)?.hiddenByAppBlur, true);
    assert.deepStrictEqual(checkInvariants(after, before), []);
  });

  it('the prev/next invariants name the field when a lived fact IS dropped', () => {
    // Feeds `checkInvariants` a hand-mutilated `next` — the shape a merge bug
    // produces — so the two new prev/next clauses are proven to fire rather
    // than merely present.
    const before = fold(livedLog());
    const record = before.order.find((w) => w.id === id)!;
    const strip = (field: 'contentFocused' | 'escapeMode'): State => {
      const mutilated: Record<string, unknown> = { ...record };
      delete mutilated[field];
      return {
        ...before,
        order: before.order.map((w) => (w.id === id ? (mutilated as unknown as typeof record) : w)),
        version: before.version + 1,
      };
    };

    assert.deepStrictEqual(checkInvariants(strip('contentFocused'), before), [
      `contentFocused decayed back to absent for ${id}`,
    ]);
    assert.deepStrictEqual(checkInvariants(strip('escapeMode'), before), [
      `escapeMode was silently stripped from ${id}`,
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The `lastFocusAssert` clauses, proven to fire.
//
// The generator DOES produce a focus assert now (variant 35, both the command
// and the raw event), but it almost never produces one that fires these two
// clauses: `lastFocusAssert` is only written by a second assert following a
// first, and the measurement recorded above shows the generated asserts name a
// window absent from `order` 21 times in 84, a registered non-content window
// 60 times, and a content window only 3 times. So the two clauses stay pinned
// here against hand-built states, the same anti-vacuity move the merge clauses
// above use: a clause nobody has ever seen fail is decoration, and generated
// coverage that thin is not a substitute for one that has.
// ─────────────────────────────────────────────────────────────────────────────

describe('window-kernel: the lastFocusAssert invariants name the violation', () => {
  const id = wid(0);

  /** One visible, focused content window, then an assert on it. */
  const asserted = (): { prev: State; next: State } => {
    const prev = fold([
      { type: 'WindowRegistered', id, kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'content' },
      { type: 'WindowShown', id },
      { type: 'OsFocusGained', id },
      { type: 'FocusAssertRequested', id },
    ]);
    const next = evolve(prev, { type: 'FocusAssertRequested', id });
    return { prev, next };
  };

  it('the assert really is recorded, so the mutilations below are of a real fact', () => {
    const { prev, next } = asserted();
    assert.strictEqual(prev.lastFocusAssert?.seq, 1);
    assert.strictEqual(next.lastFocusAssert?.seq, 2, 'a second identical request is a second assert');
    assert.deepStrictEqual(checkInvariants(next, prev), []);
  });

  it('a cleared field is named', () => {
    const { prev, next } = asserted();
    assert.deepStrictEqual(checkInvariants({ ...next, lastFocusAssert: null }, prev), [
      'lastFocusAssert was cleared back to null',
    ]);
  });

  it('a seq that went backwards is named — the shape that collapses two asserts into one', () => {
    const { prev, next } = asserted();
    assert.deepStrictEqual(checkInvariants({ ...next, lastFocusAssert: { id, seq: 0 } }, prev), [
      'lastFocusAssert.seq decreased: prev=1 next=0',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The settle-timeout invariant, proven non-vacuous. It replaced one asserting
// the OPPOSITE (that no record stays transitional through a timeout), so a
// silent pass here would mean the check had simply stopped looking rather than
// started checking the new contract.
// ─────────────────────────────────────────────────────────────────────────────

describe('window-kernel: the settle-timeout invariant names the violation', () => {
  const id = wid(0);

  /** One window mid-entry, then the settle timeout that asks about it. */
  const timedOut = (): { prev: State; next: State; item: LogItem } => {
    const prev = fold([
      { type: 'WindowRegistered', id, kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'content' },
      { type: 'WindowShown', id },
      { type: 'FullscreenTransitionStarted', id, entering: true, preBounds: null },
    ]);
    const item: LogItem = { type: 'FullscreenSettleTimeout', id };
    return { prev, next: evolve(prev, item), item };
  };

  it('the scene really is in flight and really does ask, so the mutilations below are of a real fact', () => {
    const { prev, next, item } = timedOut();
    assert.strictEqual(prev.order[0]?.fsMode.name, 'entering', 'the window must be mid-transition or this proves nothing');
    assert.strictEqual(next.order[0]?.fsMode.name, 'entering', 'the timeout leaves it in flight — it asks rather than decides');
    assert.deepStrictEqual(next.lastFsReconcile?.ids, [id]);
    assert.deepStrictEqual(checkSettleTimeoutInvariant(item, prev, next), []);
  });

  it('a timeout that asks nothing at all is named — the stranded-window shape', () => {
    const { prev, next, item } = timedOut();
    assert.deepStrictEqual(checkSettleTimeoutInvariant(item, prev, { ...next, lastFsReconcile: null }), [
      `FullscreenSettleTimeout left ${id} in {"name":"entering","preBounds":null} without a fresh lastFsReconcile naming it`,
    ]);
  });

  it('a reused seq is named — the shape that collapses two questions into one', () => {
    const { prev, next, item } = timedOut();
    assert.deepStrictEqual(
      checkSettleTimeoutInvariant(item, { ...prev, lastFsReconcile: { ids: [id], seq: 1 } }, next),
      [`FullscreenSettleTimeout left ${id} in {"name":"entering","preBounds":null} without a fresh lastFsReconcile naming it`],
    );
  });

  it('a fresh request naming some OTHER window is named — asking about the wrong one is not asking', () => {
    const { prev, next, item } = timedOut();
    assert.deepStrictEqual(
      checkSettleTimeoutInvariant(item, prev, { ...next, lastFsReconcile: { ids: [wid(9)], seq: 7 } }),
      [`FullscreenSettleTimeout left ${id} in {"name":"entering","preBounds":null} without a fresh lastFsReconcile naming it`],
    );
  });
});
