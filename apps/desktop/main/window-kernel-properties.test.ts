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
  selectAppResignTransients,
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

/** A log item is either a fact fed straight to `evolve`, or a request fed through `decide` first. */
type LogItem = Event | Command;

/** Distinguishes the two — only `Command` variants carry `expectedVersion`. */
function isCommand(item: LogItem): item is Command {
  return 'expectedVersion' in item;
}

/**
 * `state` is the live state at generation time — used only to produce a
 * mostly-plausible `expectedVersion` for the command variants (sometimes
 * deliberately stale, to exercise rejection). It does not make the log
 * non-reproducible: the same seed walks the same state trajectory, so the
 * same seed always produces the same concrete log.
 */
function randomLogItem(rng: Rng, state: State): LogItem {
  const variant = randomInt(rng, 32);
  const id = wid(randomInt(rng, POOL_SIZE));
  switch (variant) {
    case 0: {
      const hasParent = rng() < 0.3;
      const hasKeepLive = rng() < 0.3;
      const role = pick(rng, ROLES);
      const escapeMode = pick(rng, ESCAPE_MODES);
      return {
        type: 'WindowRegistered',
        id,
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
      const hasParent = rng() < 0.3;
      const hasKeepLive = rng() < 0.3;
      const stale = rng() < 0.2;
      const role = pick(rng, ROLES);
      const escapeMode = pick(rng, ESCAPE_MODES);
      return {
        type: 'RegisterWindow',
        id,
        kind: pick(rng, KINDS),
        layer: randomInt(rng, 4),
        canBecomeKey: randomBool(rng),
        acceptsInput: randomBool(rng),
        class: pick(rng, CLASSES),
        ...(role !== undefined ? { role } : {}),
        ...(hasParent ? { parentId: wid(randomInt(rng, POOL_SIZE)) } : {}),
        ...(hasKeepLive ? { keepLive: randomBool(rng) } : {}),
        ...(escapeMode !== undefined ? { escapeMode } : {}),
        expectedVersion: stale ? state.version + 1 : state.version,
      };
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
    default:
      return { type: 'ContentFirstResponderChanged', id, held: randomBool(rng) };
  }
}

/**
 * Applies one log item: an `Event` folds straight through `evolve`; a
 * `Command` first goes through `decide` — a rejection is a no-op (same
 * `state` returned, by reference, so callers can tell nothing happened), an
 * acceptance folds its (possibly empty) event list, accumulating `react`
 * effects at each step exactly like a directly-supplied event would.
 */
function stepLogItem(state: State, item: LogItem): { state: State; effects: Effect[] } {
  if (!isCommand(item)) {
    const next = evolve(state, item);
    return { state: next, effects: react(state, item, next) };
  }
  const decision = decide(state, item);
  if ('rejected' in decision) {
    return { state, effects: [] };
  }
  let s = state;
  const effects: Effect[] = [];
  for (const ev of decision.events) {
    const next = evolve(s, ev);
    effects.push(...react(s, ev, next));
    s = next;
  }
  return { state: s, effects };
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
function checkSettleTimeoutInvariant(item: LogItem, next: State): string[] {
  const violations: string[] = [];
  if (item.type === 'FullscreenSettleTimeout') {
    const record = next.order.find((w) => w.id === item.id);
    if (record !== undefined && (record.fsMode.name === 'entering' || record.fsMode.name === 'leaving')) {
      violations.push(
        `FullscreenSettleTimeout left ${item.id} in a transitional fsMode: ${JSON.stringify(record.fsMode)}`,
      );
    }
  }
  return violations;
}

/**
 * Extra invariants on the two transient-autoclose selectors, checked against
 * every generated state. The role sets are restated here rather than imported
 * — the kernel keeps them private, and an independent restatement is what
 * makes this a check rather than a tautology.
 */
/**
 * The document-like roles `isContentWindow` admits, restated independently of
 * the kernel's own `CONTENT_ROLES` for the same reason as the sets below: an
 * imported constant would make the soundness check a tautology.
 */
const CONTENT_ROLES_EXPECTED = new Set(['content', 'child-content', 'workspace']);

const TRANSIENT_ROLES_EXPECTED = new Set(['palette', 'quick-view', 'overlay']);
const AUTOCLOSE_EXEMPT_ROLES_EXPECTED = new Set(['overlay']);
const AUTOCLOSE_FOCUSER_EXEMPT_ROLES_EXPECTED = new Set(['utility', 'overlay']);

function checkAutocloseInvariants(state: State): string[] {
  const violations: string[] = [];

  const isSweepableVictim = (id: WindowId, focusedId: WindowId): boolean => {
    const rec = state.order.find((w) => w.id === id);
    if (rec === undefined) return false;
    if (rec.id === focusedId) return false;
    if (!rec.visible) return false;
    if (rec.role === undefined) return false;
    if (!TRANSIENT_ROLES_EXPECTED.has(rec.role)) return false;
    if (AUTOCLOSE_EXEMPT_ROLES_EXPECTED.has(rec.role)) return false;
    return true;
  };

  // Every id in the pool, plus one that is never registered, as the focuser.
  const focusers = [...Array.from({ length: POOL_SIZE }, (_, n) => wid(n)), wid(POOL_SIZE + 100)];
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
      // An exempt focuser sweeps nothing, whatever the cause.
      if (focuser.role !== undefined && AUTOCLOSE_FOCUSER_EXEMPT_ROLES_EXPECTED.has(focuser.role)) {
        if (world.length > 0 || machine.length > 0) {
          violations.push(`an exempt focuser (${focuser.role}) swept something: ${JSON.stringify(world)}`);
        }
      }
    }
  }

  for (const victim of selectAppResignTransients(state)) {
    const rec = state.order.find((w) => w.id === victim);
    if (
      rec === undefined ||
      rec.kind !== 'page-host' ||
      !rec.visible ||
      rec.role === undefined ||
      !TRANSIENT_ROLES_EXPECTED.has(rec.role) ||
      AUTOCLOSE_EXEMPT_ROLES_EXPECTED.has(rec.role)
    ) {
      violations.push(`selectAppResignTransients named an ineligible window: ${victim}`);
    }
  }

  // The two app-resign sweeps answer different questions about the same edge
  // and may never name the same window: the hide is reversible and undone by
  // `AppActivated`, the transient dismissal is final.
  const dismissed = new Set(selectAppResignTransients(state));
  for (const record of state.order) {
    if (isAppResignSweepEligible(record) && dismissed.has(record.id)) {
      violations.push(`a window is both hidden by the app-resign sweep and dismissed as a transient: ${record.id}`);
    }
  }

  return violations;
}

/**
 * Extra invariant on `react`'s output: every emitted effect names a window
 * still in `next.order` — this is what guarantees, among other things, that
 * no `SetBounds` effect (this slice) ever names a window absent from `order`.
 */
function checkEffectInvariants(effects: Effect[], next: State): string[] {
  const violations: string[] = [];
  for (const effect of effects) {
    const record = next.order.find((w) => w.id === effect.id);
    if (record === undefined) {
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
        let result: { state: State; effects: Effect[] };
        try {
          result = stepLogItem(state, item);
        } catch (err) {
          throw new Error(reproMessage(seed, log, i, `evolve/decide threw: ${(err as Error).message}`));
        }
        const { state: next, effects } = result;

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

        const settleViolations = checkSettleTimeoutInvariant(item, next);
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
// Pinned merge coverage — MEASURED, not assumed. The random generator's odds
// of producing "a lived fact is written for id X, and X is then re-registered
// while still live" are thin at POOL_SIZE=6 / LOG_LENGTH=30: only ~2 of the
// 32 variants register, so most ids are never registered at all, and across
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
