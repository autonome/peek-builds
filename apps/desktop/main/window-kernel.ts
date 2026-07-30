/**
 * window-kernel.ts — the rewritten window-manager kernel (draft).
 *
 * Blueprint: `docs/design/window-manager.md` §0.1 ("The rewritten kernel — state
 * shape and structure"). Follow that section; this file is a literal, minimal
 * implementation of it, not a redesign.
 *
 * SCOPE: greenfield. NOTHING in the app imports this module yet — it sits
 * alongside the existing reducer (`window-state.ts`), which stays untouched and
 * in charge. This file carries only the first slice of the ~45-event surface
 * (§0.1.1's "~17 commands, ~20 events" split): 3 commands, 7 events.
 *
 * The two structural rules this file exists to prove out (§0.1.1, §0.1.8):
 *
 *   1. **Commands and events are separate unions.** `decide` may reject
 *      (`{ rejected: Rejection }`); `evolve` never can — it is TOTAL, has no
 *      guards, and cannot throw. All guards live in `decide`.
 *   2. **Replay determinism.** `evolve` may read nothing but its two arguments
 *      — no `Date.now()`, no `Math.random()`, no module-level mutable state,
 *      no iteration over a non-deterministically-ordered structure. This is
 *      enforced by a standing test (`window-kernel.test.ts`), not just a
 *      sentence here — see §0.1.8 item 2.
 *
 * ZERO value imports (mirrors the existing rule on `window-state.ts`): this
 * file must stay loadable under plain `node --test` / `ELECTRON_RUN_AS_NODE=1
 * electron --test` with no display and no window plumbing. Type-only imports
 * are fine; there are none needed yet.
 */

// ─────────────────────────────────────────────────────────────────────────────
// State shape (§0.1.4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The WM's own window identity — an opaque branded string, same pattern as
 * `window-state.ts WindowId`. Never an Electron window id, never a webContents
 * id — the adapter (a later slice) maps `WindowId <-> platform handle`
 * internally and never leaks the platform id.
 */
export type WindowId = string & { readonly __brand: 'WindowId' };

export type WindowKind = 'page-host' | 'browser';

/**
 * A registered window's record. §0.1.4: "orthogonal properties, no
 * pre-combined class" — `layer` / `canBecomeKey` / `acceptsInput` are each
 * looked up independently; nothing branches on `class` (a lookup-only field,
 * §0.1.4's "mechanical test").
 *
 * Starting field set only — the design lists geometry/fsMode/etc. as
 * "carry over unchanged" for a later slice; this file adds none of that yet.
 */
export interface WindowRecord {
  id: WindowId;
  kind: WindowKind;

  /** Index into a fixed ordered layer array (§0.1.6). Higher = above. */
  layer: number;
  /** Electron `focusable` (§0.1.4: "a HUD never holds key" needs no special case). */
  canBecomeKey: boolean;
  /** false = click-through (`setIgnoreMouseEvents`). */
  acceptsInput: boolean;

  /** Creation-time shorthand for logs and singleton lookups. Nothing branches on it. */
  class: string;

  visible: boolean;
  /** Open order (not use order) — assigned once at registration, never re-derived. */
  openSeq: number;
  parentId?: WindowId;
}

/**
 * RULE 1 (§0.1.4): `order` holds EVERY registered window, bottom -> top, as
 * ONE structure — not a Map plus a parallel id array, so membership and order
 * cannot disagree. `WindowRegistered` appends; `WindowClosed` removes.
 * Nothing else changes membership. There is no visibility filter and no
 * eligibility filter — `order` is the total set, always.
 *
 * RULE 2 (§0.1.4): `key` is written ONLY by `OsFocusGained` / `OsFocusLost` /
 * `AppActiveChanged`. It is never inferred, never repaired, never
 * successor-guessed. `null` is a legal steady state. A dangling key id (the
 * window it names has since closed) is made unobservable by `keyWindow`
 * rather than guarded against here — see that function.
 */
export interface State {
  readonly order: readonly WindowRecord[];
  readonly key: WindowId | null;
  /** RULE 4 + stale-intent rejection (§0.1.2). Bumped by every accepted event. */
  readonly version: number;
  /** Reserved for the (not-yet-built) effect-stamping executor — the `OpToken` counter. */
  readonly opSeqCounter: number;
  readonly appActive: boolean;
  readonly openSeqCounter: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Events — past-tense facts. Already happened. `evolve` cannot reject them.
// ─────────────────────────────────────────────────────────────────────────────

export type Event =
  | {
      type: 'WindowRegistered';
      id: WindowId;
      kind: WindowKind;
      layer: number;
      canBecomeKey: boolean;
      acceptsInput: boolean;
      class: string;
      parentId?: WindowId;
    }
  | { type: 'WindowShown'; id: WindowId }
  | { type: 'WindowHidden'; id: WindowId }
  | { type: 'WindowClosed'; id: WindowId }
  | { type: 'OsFocusGained'; id: WindowId }
  | { type: 'OsFocusLost'; id: WindowId }
  | { type: 'AppActiveChanged'; active: boolean };

// ─────────────────────────────────────────────────────────────────────────────
// Commands — rejectable requests (§0.1.1, §0.1.2). Every variant carries
// `expectedVersion`; `decide` rejects on mismatch with a typed `Rejection`.
// ─────────────────────────────────────────────────────────────────────────────

export type Command =
  | { type: 'RaiseWindow'; id: WindowId; expectedVersion: number }
  | { type: 'ShowWindow'; id: WindowId; expectedVersion: number }
  | { type: 'HideWindow'; id: WindowId; expectedVersion: number };

export type Rejection = 'stale-version' | 'no-such-window';

// ─────────────────────────────────────────────────────────────────────────────
// Effects — described by `decide`'s future effect-emitting counterpart (not
// built in this slice), executed by an OS adapter. Focus-family effects
// (`ShowWindow`, `RaiseWindow` — the two that can make the OS move focus, same
// split as `window-state.ts`'s `OpToken`) carry `opSeq`; `SetStacking` and
// `HideWindow` are relative-order/visibility only and carry none.
// ─────────────────────────────────────────────────────────────────────────────

export type Effect =
  | { type: 'SetStacking'; id: WindowId; layer: number }
  | { type: 'ShowWindow'; id: WindowId; opSeq: number }
  | { type: 'HideWindow'; id: WindowId }
  | { type: 'RaiseWindow'; id: WindowId; opSeq: number };

// ─────────────────────────────────────────────────────────────────────────────
// initialState
// ─────────────────────────────────────────────────────────────────────────────

export function initialState(): State {
  return {
    order: [],
    key: null,
    version: 0,
    opSeqCounter: 0,
    appActive: false,
    openSeqCounter: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// evolve — TOTAL. No guards. Cannot throw. Reads nothing but its two
// arguments. Every event bumps `version`.
// ─────────────────────────────────────────────────────────────────────────────

export function evolve(state: State, ev: Event): State {
  switch (ev.type) {
    case 'WindowRegistered': {
      const record: WindowRecord = {
        id: ev.id,
        kind: ev.kind,
        layer: ev.layer,
        canBecomeKey: ev.canBecomeKey,
        acceptsInput: ev.acceptsInput,
        class: ev.class,
        visible: false,
        openSeq: state.openSeqCounter,
        ...(ev.parentId !== undefined ? { parentId: ev.parentId } : {}),
      };
      return {
        ...state,
        order: [...state.order, record],
        version: state.version + 1,
        openSeqCounter: state.openSeqCounter + 1,
      };
    }

    case 'WindowShown': {
      return {
        ...state,
        order: state.order.map((w) => (w.id === ev.id ? { ...w, visible: true } : w)),
        version: state.version + 1,
      };
    }

    case 'WindowHidden': {
      return {
        ...state,
        order: state.order.map((w) => (w.id === ev.id ? { ...w, visible: false } : w)),
        version: state.version + 1,
      };
    }

    case 'WindowClosed': {
      // RULE 1: removal is the only way membership shrinks. `key`, even if it
      // names this id, is left untouched — see `keyWindow` for why a dangling
      // key id is unobservable rather than repaired here.
      return {
        ...state,
        order: state.order.filter((w) => w.id !== ev.id),
        version: state.version + 1,
      };
    }

    case 'OsFocusGained': {
      // RULE 2: `key` is a reported fact, written only here. A raise moves
      // the focused window to the top of `order` (§0.1.10 — one order, and a
      // window that was not focused does not go on top); a window not
      // currently registered still gets recorded as `key` (it will simply
      // resolve to null via `keyWindow`, same as any other dangling id).
      const idx = state.order.findIndex((w) => w.id === ev.id);
      if (idx === -1) {
        return { ...state, key: ev.id, version: state.version + 1 };
      }
      const record = state.order[idx];
      const withoutRecord = [...state.order.slice(0, idx), ...state.order.slice(idx + 1)];
      return {
        ...state,
        order: [...withoutRecord, record],
        key: ev.id,
        version: state.version + 1,
      };
    }

    case 'OsFocusLost': {
      // Only clears `key` if this id is the one currently holding it — a
      // stale/duplicate report about a window that isn't key is a no-op, not
      // a repair.
      return {
        ...state,
        key: state.key === ev.id ? null : state.key,
        version: state.version + 1,
      };
    }

    case 'AppActiveChanged': {
      return {
        ...state,
        appActive: ev.active,
        version: state.version + 1,
      };
    }

    default: {
      const _exhaustive: never = ev;
      return _exhaustive;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// react — effects are a PURE PROJECTION of the transition (§0.1.1), not a
// side-channel: reads nothing but `prev`/`ev`/`next`, no guards, cannot throw.
// Effects are derived from the DIFFERENCE between `prev` and `next` — never
// from `ev`'s payload where the two could disagree. Focus-family effects
// (`ShowWindow`, `RaiseWindow`) carry `opSeq` taken from `next.opSeqCounter`,
// never a counter of react's own.
// ─────────────────────────────────────────────────────────────────────────────

export function react(prev: State, ev: Event, next: State): Effect[] {
  const effects: Effect[] = [];

  // Visibility: a record present in both states whose `visible` flipped.
  // (A closed window vanishes from `next.order` entirely — no HideWindow;
  // there is no DestroyWindow effect in this slice's Effect union.)
  for (const nextRecord of next.order) {
    const prevRecord = prev.order.find((w) => w.id === nextRecord.id);
    if (prevRecord === undefined) {
      continue;
    }
    if (!prevRecord.visible && nextRecord.visible) {
      effects.push({ type: 'ShowWindow', id: nextRecord.id, opSeq: next.opSeqCounter });
    } else if (prevRecord.visible && !nextRecord.visible) {
      effects.push({ type: 'HideWindow', id: nextRecord.id });
    }
  }

  // RaiseWindow: only when OsFocusGained genuinely moved the target off its
  // prior position — a window already on top, or a dangling id with no
  // record to move, raises nothing.
  if (ev.type === 'OsFocusGained') {
    const prevIdx = prev.order.findIndex((w) => w.id === ev.id);
    const genuinelyRaised = prevIdx !== -1 && prevIdx !== prev.order.length - 1;
    if (genuinelyRaised) {
      effects.push({ type: 'RaiseWindow', id: ev.id, opSeq: next.opSeqCounter });
    }
  }

  // SetStacking: §0.1.6 — the executor is a re-assert loop, not a diff. Any
  // change to `order` (registration, close, raise) re-emits the FULL
  // bottom -> top stacking over visible windows, one SetStacking per window.
  const orderChanged =
    prev.order.length !== next.order.length || prev.order.some((w, i) => w.id !== next.order[i]?.id);
  if (orderChanged) {
    for (const w of next.order) {
      if (w.visible) {
        effects.push({ type: 'SetStacking', id: w.id, layer: w.layer });
      }
    }
  }

  return effects;
}

// ─────────────────────────────────────────────────────────────────────────────
// decide — ALL guards live here. Rejects on a stale `expectedVersion` or a
// command naming a window that isn't in `order`.
// ─────────────────────────────────────────────────────────────────────────────

export function decide(state: State, cmd: Command): { events: Event[] } | { rejected: Rejection } {
  if (cmd.expectedVersion !== state.version) {
    return { rejected: 'stale-version' };
  }
  if (!state.order.some((w) => w.id === cmd.id)) {
    return { rejected: 'no-such-window' };
  }

  switch (cmd.type) {
    case 'RaiseWindow':
      // A raise is a focus request (§0.1.10: use-order and z-order are one
      // order, so raising a window is what makes it key).
      return { events: [{ type: 'OsFocusGained', id: cmd.id }] };
    case 'ShowWindow':
      return { events: [{ type: 'WindowShown', id: cmd.id }] };
    case 'HideWindow':
      return { events: [{ type: 'WindowHidden', id: cmd.id }] };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Queries that replace `front` (§0.1.5)
// ─────────────────────────────────────────────────────────────────────────────

/** Scans `order` from the top (the END of the array) and returns the first match, else null. */
export function topmost(state: State, pred: (r: WindowRecord) => boolean): WindowRecord | null {
  for (let i = state.order.length - 1; i >= 0; i--) {
    if (pred(state.order[i])) {
      return state.order[i];
    }
  }
  return null;
}

/**
 * Resolves `state.key` against `order`. Returns `null` on a miss, so a
 * dangling key id (its window has since closed) reads as "nobody holds key"
 * — the honest answer — rather than an illegal state (§0.1.4).
 */
export function keyWindow(state: State): WindowRecord | null {
  if (state.key === null) {
    return null;
  }
  return state.order.find((w) => w.id === state.key) ?? null;
}
