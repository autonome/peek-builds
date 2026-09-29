// Randomized model tests for the window-manager kernel (window-kernel.ts):
// generate random command/event sequences and assert the invariant list
// after every step. Design reasoning: docs/design/window-manager.md § 0.1.8.
// Separate from window-kernel.test.ts, which is example-based.

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  initialState,
  evolve,
  react,
  decide,
  keyWindow,
  selectTransientAutoclose,
  traceTransientAutoclose,
  isAppResignSweepEligible,
  isContentWindow,
  hostForOverlay,
  onCurrentDesktop,
  BASE_LAYER,
  type State,
  type Event,
  type Command,
  type Effect,
  type WindowId,
  type WindowKind,
  type Rectangle,
  type FocusCause,
} from './window-kernel.js';
import { windowIsTransient, windowNonActivating } from './izui-roles.js';

type Rng = () => number;

// No Math.random() anywhere in this file — a given seed always produces the same log.
function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInt(rng: Rng, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive);
}

function randomBool(rng: Rng): boolean {
  return rng() < 0.5;
}

function pick<T>(rng: Rng, values: readonly T[]): T {
  return values[randomInt(rng, values.length)];
}

function randomRectangle(rng: Rng): Rectangle {
  return {
    x: randomInt(rng, 2000),
    y: randomInt(rng, 2000),
    width: randomInt(rng, 2000) + 1,
    height: randomInt(rng, 2000) + 1,
  };
}

// Small pool of ids so collisions, reuse, and never-registered references happen naturally.
const POOL_SIZE = 6;
const wid = (n: number): WindowId => `wkp-${n}` as WindowId;
const KINDS: readonly WindowKind[] = ['page-host', 'browser'];
const CLASSES = ['primary', 'hud', 'overlay', 'utility'];
// The live IZUI role vocabulary plus `undefined`, which is a legitimate value on its own.
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
// The Escape override plus `undefined`, generated at least as often as the one live value.
const ESCAPE_MODES: readonly ('ignore' | undefined)[] = ['ignore', undefined];

// Malformed as often as not — unknown ids, duplicates, partial and full permutations — so the
// membership-preservation and one-order invariants below are actually exercised, not assumed.
function randomStackOrderPayload(rng: Rng): WindowId[] {
  switch (randomInt(rng, 5)) {
    case 0:
      return [];
    case 1:
      return Array.from({ length: 1 + randomInt(rng, 3) }, () => wid(POOL_SIZE + randomInt(rng, 4)));
    case 2: {
      const a = wid(randomInt(rng, POOL_SIZE));
      const b = wid(randomInt(rng, POOL_SIZE));
      return [a, b, a, b, a];
    }
    case 3:
      return Array.from({ length: 1 + randomInt(rng, POOL_SIZE) }, () => wid(randomInt(rng, POOL_SIZE)));
    default: {
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

type LogItem = Event | Command;

// Only `Command` variants carry `expectedVersion`.
function isCommand(item: LogItem): item is Command {
  return 'expectedVersion' in item;
}

// A second stream per generated log, for the `transient` draw only.
const transientStreams = new WeakMap<Rng, Rng>();

function randomRegistrationFields(rng: Rng) {
  const hasParent = rng() < 0.3;
  const hasKeepLive = rng() < 0.3;
  const role = pick(rng, ROLES);
  const escapeMode = pick(rng, ESCAPE_MODES);
  // Hoisted to the same textual position `tracksBaseLayerTop` below reads it at, so no draw is
  // added and no pinned seed's downstream rng() numbers move.
  const kind = pick(rng, KINDS);
  return {
    kind,
    layer: randomInt(rng, 4),
    canBecomeKey: randomBool(rng),
    acceptsInput: randomBool(rng),
    class: pick(rng, CLASSES),
    ...(role !== undefined ? { role } : {}),
    ...(hasParent ? { parentId: wid(randomInt(rng, POOL_SIZE)) } : {}),
    ...(hasKeepLive ? { keepLive: randomBool(rng) } : {}),
    ...(escapeMode !== undefined ? { escapeMode } : {}),
    ...(kind === 'browser' ? { tracksBaseLayerTop: true } : {}),
    ...(role === 'palette' || role === 'quick-view' ? { selfClosesOnBlur: true } : {}),
    // Drawn independently of role: transience is a window-open parameter,
    // never a property of the feature that opened the window. From its own
    // stream, so every other draw of a seed is unchanged by it.
    ...(randomBool(transientStreams.get(rng) ?? rng) ? { transient: true } : {}),
  };
}

const REGISTRATION_BIAS = 0.3;
const EXISTING_WINDOW_BIAS = 0.65;
const SHOWN_BIAS = 0.15;

// Deliberately unfiltered — ids may be unregistered or already closed, and orderings may be
// nonsensical, so evolve's/decide's total handling is exercised rather than assumed.
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
    case 4: {
      const causeVariant = randomInt(rng, 3);
      const cause: FocusCause | undefined =
        causeVariant === 0 ? undefined : causeVariant === 1 ? { kind: 'world' } : { kind: 'machine', opSeq: randomInt(rng, 2001) - 1000 };
      return cause === undefined ? { type: 'OsFocusGained', id } : { type: 'OsFocusGained', id, cause };
    }
    case 5:
      return { type: 'OsFocusLost', id };
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
    case 16: {
      const stale = rng() < 0.2;
      return { type: 'SetBounds', id, bounds: randomRectangle(rng), expectedVersion: stale ? state.version + 1 : state.version };
    }
    case 17: {
      const stale = rng() < 0.2;
      const hasWorkArea = rng() < 0.7;
      return {
        type: 'Maximize',
        id,
        ...(hasWorkArea ? { workArea: randomRectangle(rng) } : {}),
        expectedVersion: stale ? state.version + 1 : state.version,
      };
    }
    case 18: {
      const stale = rng() < 0.2;
      return { type: 'Unmaximize', id, expectedVersion: stale ? state.version + 1 : state.version };
    }
    case 19: {
      const stale = rng() < 0.2;
      return {
        type: 'SetDesktopMembership',
        id,
        membership: randomBool(rng) ? 'follow' : 'anchor',
        expectedVersion: stale ? state.version + 1 : state.version,
      };
    }
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
    case 23:
      return { type: 'Maximized', id, preMaxBounds: rng() < 0.5 ? null : randomRectangle(rng) };
    case 24:
      return { type: 'Unmaximized', id };
    case 25:
      return { type: 'PendingProjectionDiscarded', id };
    case 26:
      return { type: 'DesktopMembershipSet', id, membership: randomBool(rng) ? 'follow' : 'anchor' };
    case 27: {
      const stale = rng() < 0.2;
      let hostId: WindowId | null = rng() < 0.2 ? null : wid(randomInt(rng, POOL_SIZE));
      if (hostId === id) hostId = null; // no window is its own overlay host
      return { type: 'AttachOverlay', overlayId: id, hostId, expectedVersion: stale ? state.version + 1 : state.version };
    }
    case 28: {
      // Fed straight to evolve, bypassing decide's guard, so a nonsensical hostId must be
      // normalized into a detach rather than stored — checkInvariants below relies on that.
      const hostId: WindowId | null = rng() < 0.2 ? null : wid(randomInt(rng, POOL_SIZE));
      return { type: 'OverlayAttached', overlayId: id, hostId };
    }
    case 29:
      return { type: 'AppActivated' };
    case 30:
      return { type: 'AppResignSettled' };
    case 31:
      return rng() < 0.5
        ? { type: 'ContentFirstResponderChanged', id, held: randomBool(rng) }
        : { type: 'WindowAcceptsInputChanged', id, acceptsInput: randomBool(rng) };
    // Teardown commands mostly name a window never registered or already retired — that's the
    // production case (ipc.ts runHybridFinalize), and it's what exercises the unknown-window
    // exemption. All four share one variant slot so their share stays where it was measured.
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
        default:
          return { type: 'DestroyAllGuests', expectedVersion };
      }
    }
    case 33: {
      const order = randomStackOrderPayload(rng);
      if (rng() < 0.5) return { type: 'StackOrderImported', order };
      const stale = rng() < 0.2;
      return { type: 'ImportStackOrder', order, expectedVersion: stale ? state.version + 1 : state.version };
    }
    case 34: {
      // null clears the latch — a real payload, not an omission.
      const latch: WindowId | null = rng() < 0.25 ? null : wid(randomInt(rng, POOL_SIZE + 2));
      if (rng() < 0.5) return { type: 'ColdStartFocusArmed', id: latch };
      const stale = rng() < 0.2;
      return { type: 'ArmColdStartFocus', id: latch, expectedVersion: stale ? state.version + 1 : state.version };
    }
    // Command and raw event both generated — decide gates AssertFocus on isContentWindow, so the
    // command alone would leave evolve's/react's handling of a non-content target ungenerated.
    case 35:
    default: {
      if (rng() < 0.5) return { type: 'FocusAssertRequested', id };
      const stale = rng() < 0.2;
      return { type: 'AssertFocus', id, expectedVersion: stale ? state.version + 1 : state.version };
    }
  }
}

function stepLogItem(state: State, item: LogItem): { state: State; effects: Effect[]; steps: Step[] } {
  if (!isCommand(item)) {
    const next = evolve(state, item);
    const effects = react(state, item, next);
    return { state: next, effects, steps: [{ prev: state, next, effects }] };
  }
  const decision = decide(state, item);
  if ('rejected' in decision) {
    // Same state returned by reference, so callers can tell nothing happened.
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

// One evolve/react transition — kept per-event rather than per-log-item so aggregating a
// command's several events never blurs which transition minted which op token.
interface Step {
  prev: State;
  next: State;
  effects: Effect[];
}

// opSeqCounter advances by exactly 1 on a transition emitting a focus-family effect and never
// otherwise; that effect and the record it names must carry the same new counter value.
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
  transientStreams.set(rng, mulberry32(seed ^ 0x5eed7a11));
  const log: LogItem[] = [];
  let state = initialState();
  for (let i = 0; i < length; i++) {
    const item = randomLogItem(rng, state);
    log.push(item);
    state = stepLogItem(state, item).state;
  }
  return log;
}

// Returns a list of violation strings; empty = OK. `prev`, when given, lets the monotonicity
// clauses below check against the immediately prior step.
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
    // fsMode.name is one of the four, and preBounds is present exactly when non-normal.
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

    // preMaxBounds is non-null exactly while maximized.
    if (record.preMaxBounds !== null && !record.maximized) {
      violations.push(`preMaxBounds is non-null while not maximized for ${record.id}: ${JSON.stringify(record.preMaxBounds)}`);
    }
    // pendingProjectedBounds is held only while the window is blocked on at least one axis.
    if (record.pendingProjectedBounds !== null && record.fsMode.name === 'normal' && record.visible) {
      violations.push(`pendingProjectedBounds held for ${record.id} but neither axis is blocked`);
    }

    // overlayFor never dangles onto a window absent from order, and no window is its own host.
    if (record.overlayFor !== undefined) {
      if (!state.order.some((w) => w.id === record.overlayFor)) {
        violations.push(`overlayFor names a window absent from order for ${record.id}: ${JSON.stringify(record.overlayFor)}`);
      }
      if (record.overlayFor === record.id) {
        violations.push(`window is its own overlay host: ${record.id}`);
      }
    }

    // hiddenByAppBlur names a window the sweep hid — never true on a currently visible window.
    if (record.hiddenByAppBlur === true && record.visible) {
      violations.push(`hiddenByAppBlur is set on a visible window: ${record.id}`);
    }

    if (record.role !== undefined && (typeof record.role !== 'string' || record.role.length === 0)) {
      violations.push(`malformed role for ${record.id}: ${JSON.stringify(record.role)}`);
    }

    if (record.escapeMode !== undefined && record.escapeMode !== 'ignore') {
      violations.push(`invalid escapeMode for ${record.id}: ${JSON.stringify(record.escapeMode)}`);
    }

    // contentFocused is three-valued: absent, true, or false — never a fourth value.
    if (record.contentFocused !== undefined && typeof record.contentFocused !== 'boolean') {
      violations.push(`malformed contentFocused for ${record.id}: ${JSON.stringify(record.contentFocused)}`);
    }

    if (typeof record.acceptsInput !== 'boolean') {
      violations.push(`malformed acceptsInput for ${record.id}: ${JSON.stringify(record.acceptsInput)}`);
    }

    // pendingHidden legitimately clears back to absent, so no decay check applies to it.
    if (record.pendingHidden !== undefined && typeof record.pendingHidden !== 'boolean') {
      violations.push(`malformed pendingHidden for ${record.id}: ${JSON.stringify(record.pendingHidden)}`);
    }

    // isContentWindow is restated independently: everything it admits must be visible,
    // key-capable, not pendingHidden, and a document-like role.
    if (isContentWindow(record)) {
      if (!record.visible || !record.canBecomeKey) {
        violations.push(`isContentWindow admitted a hidden or non-key-capable window: ${record.id}`);
      }
      if (record.pendingHidden) {
        violations.push(`isContentWindow admitted a pendingHidden window: ${record.id}`);
      }
      if (record.role === undefined || !CONTENT_ROLES_EXPECTED.has(record.role)) {
        violations.push(`isContentWindow admitted a non-content role for ${record.id}: ${JSON.stringify(record.role)}`);
      }
    }

    // A content window is never app-resign-sweep eligible.
    if (isContentWindow(record) && isAppResignSweepEligible(record)) {
      violations.push(`a window is both content and app-resign-sweep eligible: ${record.id}`);
    }

    // hostForOverlay and overlayFor are the same fact read two ways.
    const host = hostForOverlay(state, record.id);
    if (record.overlayFor === undefined) {
      if (host !== null) {
        violations.push(`hostForOverlay returned a host for a detached record ${record.id}: ${host.id}`);
      }
    } else if (host === null || host.id !== record.overlayFor) {
      violations.push(`hostForOverlay disagreed with overlayFor for ${record.id}: ${JSON.stringify(host?.id)}`);
    }
  }

  // The sweep flag can only be armed while the app is inactive.
  if (state.appActive && state.pendingAppResignSweep) {
    violations.push('pendingAppResignSweep is true while appActive is true');
  }

  const kw = keyWindow(state);
  if (kw !== null && !state.order.some((w) => w.id === kw.id)) {
    violations.push(`keyWindow() resolved to a record not present in order: ${JSON.stringify(kw)}`);
  }

  // Whenever `key` resolves to a record, that record is the topmost one in order — WindowClosed's
  // parent-refocus and StackOrderImported's key-lift are the only transitions allowed to move
  // membership/position, and both preserve this.
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
    // lastTeardown.seq never repeats or decreases, and is never cleared once set.
    if (prev.lastTeardown !== null && state.lastTeardown === null) {
      violations.push('lastTeardown was cleared back to null');
    }
    if (state.lastTeardown !== null && prev.lastTeardown !== null && state.lastTeardown.seq < prev.lastTeardown.seq) {
      violations.push(`lastTeardown.seq decreased: prev=${prev.lastTeardown.seq} next=${state.lastTeardown.seq}`);
    }
    // lastFocusAssert has the same never-repeat/never-clear rule, for the same reason.
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
    // lastAttention has the same never-repeat/never-clear rule, for the same reason.
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
    // orderable never flips true -> false.
    for (const prevRecord of prev.order) {
      const nextRecord = state.order.find((w) => w.id === prevRecord.id);
      if (nextRecord !== undefined && prevRecord.orderable && !nextRecord.orderable) {
        violations.push(`orderable flipped true -> false for ${prevRecord.id}`);
      }
      // lastOpSeq (focus provenance) never decreases per window.
      if (
        nextRecord !== undefined &&
        prevRecord.lastOpSeq !== undefined &&
        (nextRecord.lastOpSeq === undefined || nextRecord.lastOpSeq < prevRecord.lastOpSeq)
      ) {
        violations.push(`lastOpSeq decreased for ${prevRecord.id}: prev=${prevRecord.lastOpSeq} next=${nextRecord.lastOpSeq}`);
      }
      // contentFocused never decays back to absent — a re-registration merge must preserve it.
      if (nextRecord !== undefined && prevRecord.contentFocused !== undefined && nextRecord.contentFocused === undefined) {
        violations.push(`contentFocused decayed back to absent for ${prevRecord.id}`);
      }
      // Same rule for escapeMode: an omission on re-registration means "did not report", never "clear".
      if (nextRecord !== undefined && prevRecord.escapeMode !== undefined && nextRecord.escapeMode === undefined) {
        violations.push(`escapeMode was silently stripped from ${prevRecord.id}`);
      }
      // Same rule for keepLive: decided once at registration and never revisited by a runtime
      // writer, so a re-registration merge must not drop it.
      if (nextRecord !== undefined && prevRecord.keepLive !== undefined && nextRecord.keepLive === undefined) {
        violations.push(`keepLive decayed back to absent for ${prevRecord.id}`);
      }
      // Same rule for tracksBaseLayerTop: declared once at registration, must survive the merge.
      if (
        nextRecord !== undefined &&
        prevRecord.tracksBaseLayerTop !== undefined &&
        nextRecord.tracksBaseLayerTop === undefined
      ) {
        violations.push(`tracksBaseLayerTop decayed back to absent for ${prevRecord.id}`);
      }
      // Same rule for selfClosesOnBlur: declared once at registration, must survive the merge.
      if (
        nextRecord !== undefined &&
        prevRecord.selfClosesOnBlur !== undefined &&
        nextRecord.selfClosesOnBlur === undefined
      ) {
        violations.push(`selfClosesOnBlur decayed back to absent for ${prevRecord.id}`);
      }
      // Same rule for overlayFrame: a lived fact that must survive the merge.
      if (nextRecord !== undefined && prevRecord.overlayFrame !== undefined && nextRecord.overlayFrame === undefined) {
        violations.push(`overlayFrame decayed back to absent for ${prevRecord.id}`);
      }
      // Same rule for bounds: once the OS has reported a rect, a merge must not drop it.
      if (nextRecord !== undefined && prevRecord.bounds !== undefined && nextRecord.bounds === undefined) {
        violations.push(`bounds decayed back to absent for ${prevRecord.id}`);
      }
    }
  }

  return violations;
}

// A window named by FullscreenSettleTimeout must never sit in entering/leaving afterward
// without being marked unverified — leaving it unmarked strands it, since nothing else settles it.
function checkSettleTimeoutInvariant(item: LogItem, next: State): string[] {
  const violations: string[] = [];
  if (item.type !== 'FullscreenSettleTimeout') return violations;

  const record = next.order.find((w) => w.id === item.id);
  if (record === undefined) return violations;
  if (record.fsMode.name !== 'entering' && record.fsMode.name !== 'leaving') return violations;

  if (record.fsMode.unverified !== true) {
    violations.push(`FullscreenSettleTimeout left ${item.id} in ${JSON.stringify(record.fsMode)} without marking it unverified`);
  }
  return violations;
}

// The document-like roles isContentWindow admits, restated independently of the kernel's own
// CONTENT_ROLES — an imported constant would make the soundness check a tautology.
const CONTENT_ROLES_EXPECTED = new Set(['content', 'child-content', 'workspace']);

function checkAutocloseInvariants(state: State): string[] {
  const violations: string[] = [];

  const isSweepableVictim = (id: WindowId, focusedId: WindowId): boolean => {
    const rec = state.order.find((w) => w.id === id);
    if (rec === undefined) return false;
    if (rec.id === focusedId) return false;
    if (!rec.visible) return false;
    // Candidacy: the window was opened transient, whatever its role.
    if (rec.transient !== true) return false;
    if (rec.overlayFor !== undefined) return false;
    // A window the pointer passes through is never a victim.
    if (!rec.acceptsInput) return false;
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
    // A machine cause can only ever spare windows relative to a world-caused focus, never sweep extra ones.
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

  // The app-resign hide sweep and transient autoclose may legitimately name the same window —
  // not a contradiction, since both read the same visible fact. Once hiddenByAppBlur is true for
  // a window, it can no longer be a selectTransientAutoclose victim for any focuser.
  for (const record of state.order) {
    if (record.hiddenByAppBlur === true && sweptByTransientAutoclose.has(record.id)) {
      violations.push(
        `a window already hidden by the app-resign sweep is still named by transient autoclose: ${record.id}`,
      );
    }
  }

  return violations;
}

// react's DismissWindow effects equal exactly the pendingHidden true-flips in this transition,
// with no duplicate id, unless a teardown request on the same record explains the flip instead.
function checkAutocloseWiring(step: Step): string[] {
  const { prev, next, effects } = step;
  const violations: string[] = [];
  const dismissedList = effects.filter((e) => e.type === 'DismissWindow').map((e) => e.id);
  const dismissed = new Set(dismissedList);

  if (dismissedList.length !== dismissed.size) {
    violations.push(`duplicate id among one react() call's DismissWindow effects: ${JSON.stringify(dismissedList)}`);
  }

  for (const id of dismissed) {
    if (next.order.find((w) => w.id === id)?.pendingHidden !== true) {
      violations.push(`DismissWindow named ${id}, but its pendingHidden does not read true in next`);
    }
  }

  const freshTeardown =
    next.lastTeardown !== null && next.lastTeardown.seq !== prev.lastTeardown?.seq ? next.lastTeardown : null;
  const teardownTargetId = freshTeardown !== null && freshTeardown.kind !== 'destroy-all-guests' ? freshTeardown.id : undefined;
  const expected = new Set(
    next.order
      .filter((r) => r.pendingHidden === true && r.id !== teardownTargetId)
      .filter((r) => prev.order.find((w) => w.id === r.id)?.pendingHidden !== true)
      .map((r) => r.id),
  );
  if (expected.size !== dismissed.size || [...expected].some((id) => !dismissed.has(id))) {
    violations.push(
      `react's DismissWindow effects diverged from the pendingHidden diff: expected=${JSON.stringify([...expected])} actual=${JSON.stringify([...dismissed])}`,
    );
  }

  return violations;
}

// No transient record may carry hiddenByAppBlur===true unless a
// focuser/overlay/click-through exemption holds — restated as literal clauses so this catches a
// hide-instead-of-dismiss path even one that never calls selectTransientAutoclose at all.
function checkTransientHideIsNotDismiss(step: Step): string[] {
  const violations: string[] = [];
  const holder = step.next.lastAttention?.holder ?? null;
  const focuser = holder !== null ? step.next.order.find((w) => w.id === holder) : undefined;
  for (const rec of step.next.order) {
    if (rec.hiddenByAppBlur !== true) continue;
    if (rec.transient !== true) continue;
    if (!rec.orderable) continue;
    if (focuser !== undefined && (focuser.parentId === rec.id || focuser.overlayFor === rec.id)) continue;
    if (rec.overlayFor !== undefined) continue;
    if (!rec.acceptsInput) continue;
    violations.push(
      `transient record ${rec.id} (role=${rec.role}) carries hiddenByAppBlur===true with none of the three ` +
        `exemptions holding — docs/design/window-manager.md § 0: a transient closes on any focus loss, always`,
    );
  }
  return violations;
}

// Cross-checks the kernel's hiddenByAppBlur marks against what selectTransientAutoclose would
// say if the record were visible — a counterfactual probe, since the selector skips invisible
// records outright and so cannot be compared to them directly otherwise.
function checkStrandedHideAgreesWithSelector(step: Step): string[] {
  const { prev, next } = step;
  const violations: string[] = [];
  for (const rec of next.order) {
    if (rec.transient !== true) continue;
    const probe: State = {
      ...next,
      order: next.order.map((w) => (w.id === rec.id ? { ...w, visible: true } : w)),
    };
    const wouldBeSwept = selectTransientAutoclose(probe, null).includes(rec.id);

    if (wouldBeSwept && rec.hiddenByAppBlur === true) {
      violations.push(
        `transient ${rec.id} (role=${rec.role}) carries hiddenByAppBlur===true though ` +
          `selectTransientAutoclose would sweep it were it visible — a reversible hide standing in for a dismissal`,
      );
    }

    const wasMarked = prev.order.find((w) => w.id === rec.id)?.hiddenByAppBlur === true;
    const clearedWhileStillHidden = wasMarked && rec.hiddenByAppBlur !== true && !rec.visible;
    if (clearedWhileStillHidden && !wouldBeSwept) {
      const traced = traceTransientAutoclose(probe, null).find((t) => t.id === rec.id);
      const why = traced === undefined ? 'not a candidate' : traced.dismissed ? 'no exemption' : traced.exemption;
      violations.push(
        `transient ${rec.id} (role=${rec.role}) had its hiddenByAppBlur cleared while still hidden, ` +
          `but selectTransientAutoclose spares it (${why}) — the app-resign hide it was carrying was ` +
          `dropped rather than honoured`,
      );
    }
  }
  return violations;
}

// ipc.ts runHybridFinalize dispatches a content-close naming a window that retired microseconds
// earlier in the same synchronous body, so these three effects' commands are exempt from
// decide's unknown-window rejection and may still name a just-retired record here.
const TEARDOWN_EFFECTS_MAY_NAME_A_RETIRED_WINDOW: ReadonlySet<Effect['type']> = new Set([
  'DestroyWindow',
  'CloseContent',
  'CloseWindowDirect',
]);

// Every emitted effect must name a window still in next.order, except CloseWindow (react derives
// it from the record's absence, so it can only ever name one already gone) and the three teardown
// effects above.
function checkEffectInvariants(effects: Effect[], next: State): string[] {
  const violations: string[] = [];
  for (const effect of effects) {
    if (effect.type === 'DestroyAllGuests') continue;
    if (effect.type === 'HideApp') continue;
    // AttachOverlayTo names a relation (overlayId + hostId), not a single window.
    if (effect.type === 'AttachOverlayTo') {
      if (!next.order.some((w) => w.id === effect.overlayId)) {
        violations.push(`AttachOverlayTo names an overlayId not present in order: ${JSON.stringify(effect)}`);
      }
      if (effect.hostId !== null && !next.order.some((w) => w.id === effect.hostId)) {
        violations.push(`AttachOverlayTo names a hostId not present in order: ${JSON.stringify(effect)}`);
      }
      continue;
    }
    if (effect.type === 'ShowDesktop') {
      if (!next.desktops.some((d) => d.id === effect.desktop)) {
        violations.push(`ShowDesktop names a desktop not in the layout: ${JSON.stringify(effect)}`);
      }
      continue;
    }
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

// Every failure message carries the seed and the full JSON log, so it replays verbatim.
function reproMessage(seed: number, log: LogItem[], stepIndex: number, detail: string): string {
  return `${detail}\n  seed=${seed} step=${stepIndex}/${log.length}\n  log=${JSON.stringify(log)}`;
}

const SEED_COUNT = 200;
const LOG_LENGTH = 30;

// A fixed, committed list of seeds (deterministic, not time-derived): 0..199.
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

        for (const step of steps) {
          const opSeqViolations = checkOpSeqInvariants(step);
          if (opSeqViolations.length > 0) {
            throw new Error(reproMessage(seed, log, i, `op-token invariant violation(s): ${opSeqViolations.join('; ')}`));
          }
          const wiringViolations = checkAutocloseWiring(step);
          if (wiringViolations.length > 0) {
            throw new Error(reproMessage(seed, log, i, `autoclose wiring violation(s): ${wiringViolations.join('; ')}`));
          }
          const hideNotDismissViolations = checkTransientHideIsNotDismiss(step);
          if (hideNotDismissViolations.length > 0) {
            throw new Error(
              reproMessage(seed, log, i, `transient-dismissal law violation(s): ${hideNotDismissViolations.join('; ')}`),
            );
          }
          const strandedViolations = checkStrandedHideAgreesWithSelector(step);
          if (strandedViolations.length > 0) {
            throw new Error(
              reproMessage(seed, log, i, `stranded-hide/selector disagreement(s): ${strandedViolations.join('; ')}`),
            );
          }
        }

        // A rejected command is a no-op (same state, by reference) — nothing to check.
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

      // Replay determinism: folding the same log twice must produce identical state and effects.
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

describe('window-kernel: the op-token invariants are not vacuous', () => {
  // Measured at POOL_SIZE=6, LOG_LENGTH=30, 200 seeds: 190 seeds issue a focus-family op, 524
  // ops total. Trajectory-sensitive, not proportional to variant count — one extra generator
  // variant re-rolls every seed's log, so re-measure and re-record after any generator change.
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
    assert.ok(seedsWithAnOp >= 150, `only ${seedsWithAnOp}/${SEED_COUNT} seeds issued an op (${issued} ops total)`);
    assert.ok(issued >= 400, `only ${issued} focus-family ops across ${SEED_COUNT} seeds`);
  });

  it('the checker names the violation when the counter goes inert', () => {
    // Hand-built: a transition emits ShowWindow but the counter and stamp don't move.
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
    // The counter advances and the effect is stamped, but the record keeps an older lastOpSeq.
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

// A second WindowRegistered for a still-live id must merge in place, not append a duplicate record.
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

// A fresh registration is inserted below the key window, never above it — pinned by hand since
// the generator's odds of registering while another window holds key are thin.
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
    // The pre-rule shape (a plain append) is hand-built so the clause is proven to fire.
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

// Pinned on a hand-built log — the generator's odds of a lived-fact-then-re-register sequence
// are thin, and both bugs this property suite has ever caught were a lived field silently dropped.
describe('window-kernel: the re-registration merge preserves every lived fact', () => {
  const id = wid(0);
  const host = wid(1);

  const register = (escapeMode?: 'ignore', keepLive?: boolean, parentId?: WindowId): Event => ({
    type: 'WindowRegistered',
    id,
    kind: 'page-host',
    // BASE_LAYER deliberately — a higher layer would also make this isAppResignSweepEligible,
    // adding an unrelated violation to the assertion below.
    layer: BASE_LAYER,
    canBecomeKey: true,
    acceptsInput: true,
    class: 'primary',
    role: 'content',
    ...(escapeMode !== undefined ? { escapeMode } : {}),
    ...(keepLive !== undefined ? { keepLive } : {}),
    ...(parentId !== undefined ? { parentId } : {}),
  });

  const livedLog = (): LogItem[] => [
    { type: 'WindowRegistered', id: host, kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'content' },
    register('ignore', true, host),
    { type: 'WindowShown', id },
    { type: 'OsFocusGained', id },
    { type: 'WindowContentOrderable', id },
    { type: 'BoundsChanged', id, bounds: { x: 1, y: 2, width: 3, height: 4 } },
    { type: 'Maximized', id, preMaxBounds: { x: 5, y: 6, width: 7, height: 8 } },
    { type: 'DesktopMembershipSet', id, membership: 'anchor' },
    { type: 'OverlayAttached', overlayId: id, hostId: host, frame: { x: 10, y: 20, width: 30, height: 40 } },
    { type: 'ContentFirstResponderChanged', id, held: false },
    // register() above declares acceptsInput: true; flipping it false here proves the merge
    // preserves the lived value rather than the one the event happens to share with registration.
    { type: 'WindowAcceptsInputChanged', id, acceptsInput: false },
    { type: 'FullscreenTransitionStarted', id, entering: true, preBounds: { x: 9, y: 9, width: 9, height: 9 } },
    // A teardown request, not the confirming WindowClosed — sets pendingHidden without removing
    // the record, or the assertion below would be vacuous for that field.
    { type: 'WindowDestroyRequested', id },
  ];

  it('a re-registration that names none of them changes no lived fact', () => {
    const before = fold(livedLog());
    const after = evolve(before, register());
    const prevRecord = before.order.find((w) => w.id === id)!;
    const nextRecord = after.order.find((w) => w.id === id)!;

    // Everything except version is identical, and each of these fields specifically survives
    // the merge: keepLive, the OverlayAttached frame, the BoundsChanged bounds, and the
    // teardown-request pendingHidden mark — the fields once silently dropped.
    assert.deepStrictEqual(nextRecord, prevRecord);
    assert.strictEqual(nextRecord.keepLive, true);
    assert.deepStrictEqual(nextRecord.overlayFrame, { x: 10, y: 20, width: 30, height: 40 });
    assert.deepStrictEqual(nextRecord.bounds, { x: 1, y: 2, width: 3, height: 4 });
    assert.strictEqual(nextRecord.pendingHidden, true);
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
    assert.strictEqual(record.desktopMembership, 'anchor');
    assert.strictEqual(record.overlayFor, host);
    assert.notStrictEqual(record.overlayFrame, undefined);
    assert.notStrictEqual(record.lastOpSeq, undefined);
    assert.strictEqual(record.contentFocused, false);
    assert.strictEqual(record.escapeMode, 'ignore');
    assert.strictEqual(record.keepLive, true);
    assert.strictEqual(record.parentId, host);
    assert.strictEqual(record.pendingHidden, true);
    assert.strictEqual(record.acceptsInput, false);
  });

  it('the hiddenByAppBlur mark survives a re-registration mid-sweep', () => {
    // Non-focusable + floating so the sweep takes it — the only way to set the mark.
    const swept = wid(2);
    const reg: Event = { type: 'WindowRegistered', id: swept, kind: 'browser', layer: 1, canBecomeKey: false, acceptsInput: true, class: 'hud', role: 'workspace' };
    const before = fold([reg, { type: 'WindowShown', id: swept }, { type: 'AppResigned' }, { type: 'AppResignSettled' }]);
    assert.strictEqual(before.order.find((w) => w.id === swept)?.hiddenByAppBlur, true);

    const after = evolve(before, reg);
    assert.strictEqual(after.order.find((w) => w.id === swept)?.hiddenByAppBlur, true);
    assert.deepStrictEqual(checkInvariants(after, before), []);
  });

  it('a re-registration that turns a marked window transient drops the reversible hide', () => {
    const marked = wid(3);
    // Floating, input-taking, non-content — the shape isAppResignSweepEligible accepts, the
    // only way to get the mark. An input-taking transient must have the hide dropped, or
    // AppActivated would later reveal a window the law says should have been dismissed.
    const asWorkspace: Event = { type: 'WindowRegistered', id: marked, kind: 'browser', layer: BASE_LAYER + 1, canBecomeKey: false, acceptsInput: true, class: 'hud', role: 'workspace' };
    const before = fold([asWorkspace, { type: 'WindowShown', id: marked }, { type: 'AppResigned' }, { type: 'AppResignSettled' }]);
    const markedRecord = before.order.find((w) => w.id === marked)!;
    assert.strictEqual(markedRecord.hiddenByAppBlur, true, 'the resign sweep marked it');
    assert.strictEqual(markedRecord.visible, false, 'a marked window is hidden');

    const asPalette: Event = { ...asWorkspace, role: 'palette', transient: true };
    const after = evolve(before, asPalette);
    const afterRecord = after.order.find((w) => w.id === marked)!;
    assert.strictEqual(afterRecord.transient, true, 'the merge took the new declaration');
    assert.strictEqual(
      afterRecord.hiddenByAppBlur,
      false,
      'a transient the law would dismiss may not sit on a hide AppActivated would reverse',
    );
    // Still hidden — the fix clears the mark, not the hide; nothing re-shows the window here.
    assert.strictEqual(afterRecord.visible, false);
    assert.deepStrictEqual(checkInvariants(after, before), []);
    assert.deepStrictEqual(checkStrandedHideAgreesWithSelector({ prev: before, next: after, effects: [] }), []);
  });

  it('a re-registration that turns a marked CLICK-THROUGH window transient keeps the hide', () => {
    // A click-through transient keeps its hide — the law spares click-through windows outright.
    const marked = wid(4);
    const asWorkspace: Event = { type: 'WindowRegistered', id: marked, kind: 'browser', layer: BASE_LAYER + 1, canBecomeKey: false, acceptsInput: true, class: 'hud', role: 'workspace' };
    const before = fold([
      asWorkspace,
      { type: 'WindowShown', id: marked },
      { type: 'AppResigned' },
      { type: 'AppResignSettled' },
      { type: 'WindowAcceptsInputChanged', id: marked, acceptsInput: false },
    ]);
    const markedRecord = before.order.find((w) => w.id === marked)!;
    assert.strictEqual(markedRecord.hiddenByAppBlur, true, 'the resign sweep marked it while it still took input');
    assert.strictEqual(markedRecord.acceptsInput, false, 'and it went click-through afterwards');

    const asPalette: Event = { ...asWorkspace, role: 'palette', transient: true };
    const after = evolve(before, asPalette);
    const afterRecord = after.order.find((w) => w.id === marked)!;
    assert.strictEqual(afterRecord.transient, true, 'the merge took the new declaration');
    assert.strictEqual(afterRecord.acceptsInput, false, 'and left the lived click-through fact alone');
    assert.strictEqual(
      afterRecord.hiddenByAppBlur,
      true,
      'the law spares a click-through transient, so its reversible hide stands',
    );
    assert.deepStrictEqual(checkInvariants(after, before), []);
    assert.deepStrictEqual(checkStrandedHideAgreesWithSelector({ prev: before, next: after, effects: [] }), []);
  });

  it('the prev/next invariants name the field when a lived fact IS dropped', () => {
    // Feeds checkInvariants a hand-mutilated next — the shape a merge bug produces.
    const before = fold(livedLog());
    const record = before.order.find((w) => w.id === id)!;
    const strip = (field: 'contentFocused' | 'escapeMode' | 'bounds' | 'pendingHidden' | 'acceptsInput'): State => {
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
    assert.deepStrictEqual(checkInvariants(strip('bounds'), before), [
      `bounds decayed back to absent for ${id}`,
    ]);
    // acceptsInput is required, so stripping it is a shape violation, not a decay-to-absent one.
    assert.deepStrictEqual(checkInvariants(strip('acceptsInput'), before), [
      `malformed acceptsInput for ${id}: undefined`,
    ]);
    // pendingHidden is the deliberate exception — clearing it is legitimate kernel behavior.
    assert.deepStrictEqual(checkInvariants(strip('pendingHidden'), before), []);
  });
});

// Pinned by hand — the generator only rarely produces the asserted-twice sequence these two
// clauses need.
describe('window-kernel: the lastFocusAssert invariants name the violation', () => {
  const id = wid(0);

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

// Proven non-vacuous, not just present.
describe('window-kernel: the settle-timeout invariant names the violation', () => {
  const id = wid(0);

  const timedOut = (): { next: State; item: LogItem } => {
    const prev = fold([
      { type: 'WindowRegistered', id, kind: 'page-host', layer: 0, canBecomeKey: true, acceptsInput: true, class: 'primary', role: 'content' },
      { type: 'WindowShown', id },
      { type: 'FullscreenTransitionStarted', id, entering: true, preBounds: null },
    ]);
    const item: LogItem = { type: 'FullscreenSettleTimeout', id };
    return { next: evolve(prev, item), item };
  };

  it('the scene really is in flight and really is marked unverified, so the mutilation below is of a real fact', () => {
    const { next, item } = timedOut();
    assert.strictEqual(next.order[0]?.fsMode.name, 'entering', 'the timeout leaves it in flight — it asks rather than decides');
    assert.strictEqual(next.order[0]?.fsMode.unverified, true);
    assert.deepStrictEqual(checkSettleTimeoutInvariant(item, next), []);
  });

  it('a timeout that leaves the record unmarked is named — the stranded-window shape', () => {
    const { next, item } = timedOut();
    const stranded: State = {
      ...next,
      order: next.order.map((w) => (w.id === id ? { ...w, fsMode: { name: 'entering' as const, preBounds: null } } : w)),
    };
    assert.deepStrictEqual(checkSettleTimeoutInvariant(item, stranded), [
      `FullscreenSettleTimeout left ${id} in {"name":"entering","preBounds":null} without marking it unverified`,
    ]);
  });
});

// The key-carry after a dismissed peek changes where the next peek is staged, but not the
// transient-autoclose verdict — refuted here against the hypothesis that it would.
describe('window-kernel: the WindowRegistered key-carry moves staging, not the transient-autoclose verdict', () => {
  const hostA = wid(0);
  const peek1 = wid(1);
  const peek2 = wid(2);

  const machineCause: FocusCause = { kind: 'machine', opSeq: 0 };
  const worldCause: FocusCause = { kind: 'world' };

  const registerHost = (): Event => ({
    type: 'WindowRegistered',
    id: hostA,
    kind: 'page-host',
    layer: 0,
    canBecomeKey: true,
    acceptsInput: true,
    class: 'primary',
    role: 'content',
  });
  const registerPeek = (id: WindowId): Event => ({
    type: 'WindowRegistered',
    id,
    kind: 'browser',
    layer: 0,
    canBecomeKey: true,
    acceptsInput: true,
    class: 'primary',
    role: 'quick-view',
    keepLive: false,
    transient: true,
  });

  const baseline = (): State =>
    fold([registerHost(), { type: 'WindowContentOrderable', id: hostA }, { type: 'WindowShown', id: hostA }, { type: 'OsFocusGained', id: hostA, cause: worldCause }]);

  // hostA reclaims key before the sweep runs (react's raise-then-sweep order), so WindowClosed
  // sees key already live.
  const liveCarryPrefix = (): State =>
    fold(
      [
        registerPeek(peek1),
        { type: 'WindowShown', id: peek1 },
        { type: 'OsFocusGained', id: peek1, cause: machineCause },
        { type: 'OsFocusGained', id: hostA, cause: worldCause },
        { type: 'WindowClosed', id: peek1 },
      ],
      baseline(),
    );

  // The peek is closed while still holding key, before anything else retakes it — key is left
  // dangling.
  const danglingCarryPrefix = (): State =>
    fold(
      [registerPeek(peek1), { type: 'WindowShown', id: peek1 }, { type: 'OsFocusGained', id: peek1, cause: machineCause }, { type: 'WindowClosed', id: peek1 }],
      baseline(),
    );

  it('the two prefixes disagree only on the key carry, so the comparison below is of that carry alone', () => {
    const live = liveCarryPrefix();
    const dangling = danglingCarryPrefix();
    assert.deepStrictEqual(live.order.map((w) => w.id), [hostA]);
    assert.deepStrictEqual(dangling.order.map((w) => w.id), [hostA]);
    assert.strictEqual(live.key, hostA);
    assert.strictEqual(dangling.key, peek1);
    assert.ok(!dangling.order.some((w) => w.id === dangling.key), 'the dangling prefix must actually be dangling');
    assert.deepStrictEqual(checkInvariants(live), []);
    assert.deepStrictEqual(checkInvariants(dangling), []);
  });

  it('the carry moves where the next peek is registered — dangling appends on top, live inserts below the key window', () => {
    const afterLive = evolve(liveCarryPrefix(), registerPeek(peek2));
    const afterDangling = evolve(danglingCarryPrefix(), registerPeek(peek2));
    assert.deepStrictEqual(afterLive.order.map((w) => w.id), [peek2, hostA]);
    assert.deepStrictEqual(afterDangling.order.map((w) => w.id), [hostA, peek2]);
  });

  it('the carry changes which SetStacking effects the next peek’s show emits', () => {
    const stackingTargets = (prefix: State): WindowId[] => {
      const prev = evolve(prefix, registerPeek(peek2));
      const shown: Event = { type: 'WindowShown', id: peek2 };
      const next = evolve(prev, shown);
      return react(prev, shown, next)
        .filter((e) => e.type === 'SetStacking')
        .map((e) => e.id);
    };
    // Live re-derives hostA's stacking too (the minimal-diff suffix replay); dangling only
    // replays peek2's own show.
    assert.deepStrictEqual(stackingTargets(liveCarryPrefix()), [peek2, hostA]);
    assert.deepStrictEqual(stackingTargets(danglingCarryPrefix()), [peek2]);
  });

  // Holds the refocus cause fixed as the only variable between carries — if the carry mattered,
  // the two would disagree here.
  const dismissVerdict = (prefix: State, hostRefocusCause: FocusCause): boolean => {
    let state = evolve(prefix, registerPeek(peek2));
    state = evolve(state, { type: 'WindowShown', id: peek2 });
    state = evolve(state, { type: 'OsFocusGained', id: peek2, cause: machineCause });
    const refocus: Event = { type: 'OsFocusGained', id: hostA, cause: hostRefocusCause };
    const next = evolve(state, refocus);
    return react(state, refocus, next).some((e) => e.type === 'DismissWindow' && e.id === peek2);
  };

  it('a world-caused refocus dismisses press 2’s peek identically for both carries', () => {
    assert.strictEqual(dismissVerdict(liveCarryPrefix(), worldCause), true);
    assert.strictEqual(dismissVerdict(danglingCarryPrefix(), worldCause), true);
  });

  it('a machine-caused refocus spares press 2’s peek identically for both carries (the newer-than-focuser exemption)', () => {
    assert.strictEqual(dismissVerdict(liveCarryPrefix(), machineCause), false);
    assert.strictEqual(dismissVerdict(danglingCarryPrefix(), machineCause), false);
  });
});

// specs/kernel-desktops.md, "7.1 Automated tests": with only what the fallback
// provider sends (one layout, each window placed on its screen's only desktop,
// no current-desktop change), every effect list equals the one with desktops
// ignored. Commands in the desktop run have their expected version shifted by
// the version bumps the desktop events add, so they are accepted or rejected alike.
describe('window-kernel: the fallback provider changes no effect', () => {
  const layout: Event = { type: 'DesktopLayoutReported', screens: [{ id: 'S', current: 'd' }], desktops: [{ id: 'd', screen: 'S' }] };
  for (let seed = 0; seed < SEED_COUNT; seed++) {
    it(`seed ${seed}: the same effects with and without desktop reports`, () => {
      const log = generateLog(seed, LOG_LENGTH);
      let plain = initialState();
      let desk = evolve(plain, layout);
      assert.deepStrictEqual(react(plain, layout, desk), []);
      for (let i = 0; i < log.length; i++) {
        const item = log[i];
        const shifted: LogItem =
          isCommand(item) && 'expectedVersion' in item
            ? ({ ...item, expectedVersion: item.expectedVersion + (desk.version - plain.version) } as LogItem)
            : item;
        const a = stepLogItem(plain, item);
        const b = stepLogItem(desk, shifted);
        assert.deepStrictEqual(b.effects, a.effects, reproMessage(seed, log, i, 'effects differ with desktop reports'));
        plain = a.state;
        desk = b.state;
        for (const w of desk.order) {
          if (w.screen !== undefined) continue;
          const placement: Event = { type: 'WindowPlacementReported', id: w.id, screen: 'S', desktop: 'd', onEveryDesktop: w.onEveryDesktop === true };
          const next = evolve(desk, placement);
          assert.deepStrictEqual(react(desk, placement, next), [], reproMessage(seed, log, i, 'a placement report emitted an effect'));
          desk = next;
        }
      }
    });
  }
});

// specs/kernel-desktops.md, "7.1 Automated tests", the transience property:
// over the window API, not the features that use it. Each case starts with
// Peek or another app focused, opens a chain of windows from random open
// options (a global trigger opens the first, each opens the next), declares
// each window from those options alone (`izui-roles.ts windowIsTransient`,
// and non-activating when transient, as the spec's "How a transient window is
// built" requires), then applies one leave event. Pass: every transient
// window in the chain has ended, none is left showing on the desktop switched
// to, and while another app is in front the leave raises and focuses nothing.
// Roles are drawn at random so no case names the palette, a peek or a page.
describe('window-kernel: every transient window in a chain ends when the user leaves', () => {
  type OpenOptions = { modal?: boolean; overlay?: boolean; focusable?: boolean; clickThrough?: boolean; type?: 'panel'; show?: boolean };
  type Leave = 'clicks another app' | 'clicks another Peek window' | 'Peek comes forward' | 'switches desktop';
  const LEAVES: readonly Leave[] = ['clicks another app', 'clicks another Peek window', 'Peek comes forward', 'switches desktop'];
  const BASE = wid(0);
  const layout: Event = {
    type: 'DesktopLayoutReported',
    screens: [{ id: 'S', current: 'd1' }],
    desktops: [{ id: 'd1', screen: 'S' }, { id: 'd2', screen: 'S' }],
  };
  const baseWindow: Event = {
    type: 'WindowRegistered', id: BASE, kind: 'browser', layer: BASE_LAYER, canBecomeKey: true, acceptsInput: true, class: 'primary',
  };

  const randomOpenOptions = (rng: Rng): OpenOptions => ({
    modal: pick(rng, [true, undefined]),
    overlay: pick(rng, [true, undefined]),
    focusable: pick(rng, [false, undefined, undefined, undefined]),
    clickThrough: pick(rng, [true, undefined, undefined, undefined]),
    type: pick(rng, ['panel', undefined] as const),
    show: pick(rng, [false, undefined, undefined, undefined]),
  });

  // The events one open produces: registration, then, if shown and able to
  // take key, a user-intent raise and the OS focus report. An activating
  // window taking key over another app brings the app forward first.
  function openWindow(rng: Rng, state: State, id: WindowId, opener: WindowId | null): { events: Event[]; transient: boolean } {
    const options = randomOpenOptions(rng);
    const keyHeldWhileAppInactive = !state.appActive && state.key !== null;
    const transient = windowIsTransient(keyHeldWhileAppInactive, options);
    const nonActivating = windowNonActivating(options) || transient;
    const canBecomeKey = options.focusable !== false;
    const events: Event[] = [{
      type: 'WindowRegistered',
      id,
      kind: pick(rng, KINDS),
      layer: BASE_LAYER,
      canBecomeKey,
      acceptsInput: canBecomeKey && options.clickThrough !== true,
      class: pick(rng, ['primary', 'utility', 'palette']),
      role: pick(rng, ROLES),
      ...(opener ? { parentId: opener } : {}),
      ...(transient ? { transient: true } : {}),
      ...(nonActivating ? { nonActivating: true } : {}),
    }];
    if (options.show === false) return { events, transient };
    events.push({ type: 'WindowShown', id }, { type: 'WindowContentOrderable', id });
    if (!canBecomeKey) return { events, transient };
    events.push({ type: 'FocusRaiseRequested', id, intent: 'user' });
    if (!state.appActive && !nonActivating) events.push({ type: 'AppActivated' });
    events.push({ type: 'OsFocusGained', id });
    return { events, transient };
  }

  function leaveEvents(state: State, leave: Leave): Event[] {
    const key = state.key;
    switch (leave) {
      // Resigning settles after a delay the backend owns (`AppResignSettled`).
      case 'clicks another app':
        return state.appActive
          ? [{ type: 'AppResigned' }, ...(key ? [{ type: 'OsFocusLost', id: key } as Event] : []), { type: 'AppResignSettled' }]
          : key ? [{ type: 'OsFocusLost', id: key }] : [];
      case 'clicks another Peek window':
        return [...(state.appActive ? [] : [{ type: 'AppActivated' } as Event]), { type: 'OsFocusGained', id: BASE, cause: { kind: 'world' } }];
      // Only a leave while another app is in front; with Peek in front there is nothing to come forward.
      case 'Peek comes forward':
        return state.appActive ? [] : [{ type: 'AppActivated' }];
      case 'switches desktop':
        return [
          { type: 'DesktopSwitchObserved' },
          { type: 'CurrentDesktopChanged', screen: 'S', desktop: 'd2' },
          ...state.order.filter((w) => w.desktop !== undefined).map((w): Event => (
            { type: 'WindowPlacementReported', id: w.id, screen: 'S', desktop: 'd1', onEveryDesktop: false })),
          { type: 'DesktopsRead', switchesSeen: state.desktopSwitchCount + 1 },
        ];
    }
  }

  function scenario(seed: number) {
    const rng = mulberry32(seed);
    const peekFocused = randomBool(rng);
    const log: Event[] = [layout, baseWindow, { type: 'WindowShown', id: BASE }, { type: 'OsFocusGained', id: BASE }];
    if (!peekFocused) log.push({ type: 'AppResigned' }, { type: 'OsFocusLost', id: BASE });
    let { state, effects } = foldWithEffects(log);
    const dismissed = new Set(effects.flatMap((e) => (e.type === 'DismissWindow' ? [e.id] : [])));
    const transients = new Set<WindowId>();
    const depth = randomInt(rng, 4) + 1;
    let opener: WindowId | null = null;
    for (let n = 1; n <= depth; n++) {
      const id = wid(n);
      const open = openWindow(rng, state, id, opener);
      if (open.transient) transients.add(id);
      const r = foldWithEffects(open.events, state);
      for (const e of r.effects) if (e.type === 'DismissWindow') dismissed.add(e.id);
      log.push(...open.events);
      state = r.state;
      assert.strictEqual(state.order.find((w) => w.id === id)?.transient === true, open.transient,
        `seed ${seed}: the kernel records the transience the open options decided\n  log=${JSON.stringify(log)}`);
      if (state.key === id) opener = id;
    }
    return { state, log, dismissed, transients };
  }

  const ended = (state: State, dismissed: ReadonlySet<WindowId>, id: WindowId): boolean => {
    const w = state.order.find((r) => r.id === id);
    return !w || !w.visible || w.pendingHidden === true || dismissed.has(id);
  };

  for (const leave of LEAVES) {
    it(`the user ${leave}: every transient window in the chain ends`, () => {
      let exercised = 0;
      let cases = 0;
      for (let seed = 0; seed < SEED_COUNT; seed++) {
        const { state, log, dismissed, transients } = scenario(seed);
        if (leave === 'Peek comes forward' && state.appActive) continue;
        cases++;
        const shownTransients = [...transients].filter((id) => !ended(state, dismissed, id));
        if (shownTransients.length > 0) exercised++;
        const events = leaveEvents(state, leave);
        const after = foldWithEffects(events, state);
        for (const e of after.effects) if (e.type === 'DismissWindow') dismissed.add(e.id);
        const repro = (detail: string) => `seed ${seed}: ${detail}\n  log=${JSON.stringify([...log, ...events])}\n  effects=${JSON.stringify(after.effects)}`;
        for (const id of transients) {
          assert.ok(ended(after.state, dismissed, id), repro(`transient ${id} is still showing`));
        }
        if (!state.appActive && (leave === 'clicks another app' || leave === 'switches desktop')) {
          const moved = after.effects.filter((e) => e.type === 'RaiseWindow' || e.type === 'ShowDesktop' || e.type === 'FocusContent' || e.type === 'ShowWindow');
          assert.deepStrictEqual(moved, [], repro('a Peek window was raised or given key while another app is in front'));
          assert.strictEqual(after.state.appActive, false, repro('Peek came forward'));
        }
      }
      assert.ok(exercised >= cases / 4, `only ${exercised}/${cases} cases had a transient window showing before the leave`);
    });
  }
});

// specs/kernel-desktops.md section 4 "Enforcement": random event sequences over
// two desktops. No `RaiseWindow` or `FocusContent` reaches a window off every
// current desktop unless a `ShowDesktop` for its desktop precedes it in the
// same transition (a named request, rule 1); no raise without user intent is
// emitted while the app is inactive (`admitsFocus`); and every op token a
// transition stamps pairs with the effect that carries it.
describe('window-kernel: nothing is brought forward on a desktop the user is not on', () => {
  const layout: Event = {
    type: 'DesktopLayoutReported',
    screens: [{ id: 'S', current: 'd1' }],
    desktops: [{ id: 'd1', screen: 'S' }, { id: 'd2', screen: 'S' }],
  };
  const DESKTOP_EVENT_BIAS = 0.25;
  // Longer than the base logs: an off-desktop raise needs a window shown, placed on the other
  // desktop, a switch away, and then a request for it, in that order.
  const ENFORCEMENT_LOG_LENGTH = 120;

  function randomDesktopEvents(rng: Rng, state: State): Event[] {
    if (randomBool(rng)) {
      return [
        { type: 'DesktopSwitchObserved' },
        { type: 'CurrentDesktopChanged', screen: 'S', desktop: pick(rng, ['d1', 'd2']) },
        { type: 'DesktopsRead', switchesSeen: state.desktopSwitchCount + 1 },
      ];
    }
    return [{
      type: 'WindowPlacementReported',
      id: wid(randomInt(rng, POOL_SIZE)),
      screen: 'S',
      desktop: pick(rng, ['d1', 'd2']),
      onEveryDesktop: randomInt(rng, 8) === 0,
    }];
  }

  function checkEnforcement(step: Step): string[] {
    const violations: string[] = [];
    step.effects.forEach((effect, i) => {
      if (effect.type !== 'RaiseWindow' && effect.type !== 'FocusContent') return;
      const record = step.next.order.find((w) => w.id === effect.id);
      if (record !== undefined && !onCurrentDesktop(step.next, record)) {
        const named = step.effects
          .slice(0, i)
          .some((e) => e.type === 'ShowDesktop' && e.desktop === record.desktop);
        if (!named) violations.push(`${effect.type} for ${effect.id} on desktop ${String(record.desktop)}, off every current desktop, with no ShowDesktop before it`);
      }
      if (effect.type === 'RaiseWindow' && effect.intent !== 'user' && !step.next.appActive) {
        violations.push(`RaiseWindow for ${effect.id} without user intent while the app is inactive`);
      }
    });
    return violations;
  }

  for (let seed = 0; seed < SEED_COUNT; seed++) {
    it(`seed ${seed}: every raise lands on a current desktop or was named`, () => {
      const rng = mulberry32(seed ^ 0xde5c7095);
      transientStreams.set(rng, mulberry32(seed ^ 0x5eed7a11));
      const log: LogItem[] = [layout];
      let state = stepLogItem(initialState(), layout).state;
      for (let i = 0; i < ENFORCEMENT_LOG_LENGTH; i++) {
        const items: LogItem[] = randomInt(rng, 100) < DESKTOP_EVENT_BIAS * 100
          ? randomDesktopEvents(rng, state)
          : [randomLogItem(rng, state)];
        for (const item of items) {
          log.push(item);
          const r = stepLogItem(state, item);
          for (const step of r.steps) {
            const violations = [...checkEnforcement(step), ...checkOpSeqInvariants(step)];
            assert.deepStrictEqual(violations, [], reproMessage(seed, log, log.length - 1, violations.join('; ')));
          }
          state = r.state;
        }
      }
    });
  }
});
