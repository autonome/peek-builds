/**
 * window-kernel.ts — the rewritten window-manager kernel (draft).
 *
 * Blueprint: `docs/design/window-manager.md` §0.1 ("The rewritten kernel — state
 * shape and structure"). Follow that section; this file is a literal, minimal
 * implementation of it, not a redesign.
 *
 * SCOPE: greenfield. NOTHING in the app imports this module yet — it sits
 * alongside the existing reducer (`window-state.ts`), which stays untouched and
 * in charge. This file carries the first two slices of the ~45-event surface
 * (§0.1.1's "~17 commands, ~20 events" split) — visibility + raise, 5
 * commands/8 events — plus fullscreen (§0.1.8: pulled forward out of the
 * geometry slice because it is orthogonal to `key`/`order` and needs no
 * bounds tracking to land): 6 commands, 13 events total. The REST of
 * geometry (bounds, maximize, display) is still a later slice.
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

/** Minimal outer-bounds rectangle — enough to stash/restore a pre-fullscreen frame. */
export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Fullscreen as its own orthogonal region on the record (§0.1.8), not flags
 * spread across the machine: independent of `key` and of position in
 * `order`. `preBounds` (the pre-fullscreen rectangle to restore on exit)
 * lives INSIDE the non-normal variants — it CANNOT exist for a `normal`
 * window, and a non-normal window cannot lack the *concept*: `preBounds:
 * null` is the legitimate "OS/green-button entry where no stash was
 * possible" case, never "field missing". This is the `window-state.ts
 * FsMode` encoding (the `aa34cb50` fullscreen-lookalike trap), ported
 * verbatim because the encoding — not the reducer's code shape — is what's
 * load-bearing. `pendingDesire` coalesces a request that arrives mid-flight
 * (§0.1.8's async edge): it is applied when the in-flight transition
 * settles, never opens a second transition.
 */
export type FsMode =
  | { name: 'normal' }
  | { name: 'entering'; preBounds: Rectangle | null; pendingDesire?: boolean }
  | { name: 'fullscreen'; preBounds: Rectangle | null }
  | { name: 'leaving'; preBounds: Rectangle | null; pendingDesire?: boolean };

/**
 * A registered window's record. §0.1.4: "orthogonal properties, no
 * pre-combined class" — `layer` / `canBecomeKey` / `acceptsInput` are each
 * looked up independently; nothing branches on `class` (a lookup-only field,
 * §0.1.4's "mechanical test").
 *
 * Starting field set only — the design lists geometry/etc. as "carry over
 * unchanged" for a later slice; this file adds none of that yet. Fullscreen
 * (`fsMode`) is pulled forward out of that later slice deliberately (§0.1.8):
 * it is orthogonal to everything else here, so it does not need geometry
 * tracking to land on the record first.
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

  /**
   * A window opened with `keepLive` is HIDDEN on `CloseOrHideWindow`, never
   * closed, so its content keeps running (e.g. a slide playing music while
   * backgrounded). The branch lives in `decide`, never in `evolve`.
   */
  keepLive?: boolean;

  /**
   * Whether the window's native window can be z-ordered yet. `true` from
   * birth for `kind: 'browser'`; a `'page-host'` starts `false` and flips to
   * `true` on its first-composited-frame report (`WindowContentOrderable`).
   * Never reset once true.
   */
  orderable: boolean;

  /** Fullscreen region (§0.1.8) — orthogonal to `key` and to `order`. See `FsMode`. */
  fsMode: FsMode;

  /**
   * The window's last OS-reported outer bounds. Ported from `window-state.ts
   * WindowRecord.bounds`: an honest mirror of native reality, never a live
   * query at decision time. It also tracks the transient fullscreen rect —
   * the restorable pre-fullscreen geometry lives in `fsMode.preBounds`, NOT
   * here (the same aa34cb50 lookalike trap the old reducer names). `undefined`
   * only when no rect has ever been reported. Written by `BoundsChanged` and,
   * in this kernel's diff-based `react` (§0.1.1: effects are a pure diff of
   * `prev`/`next`, never a read of `ev`'s payload), also by the accepted
   * geometry commands below and by a `DisplayChanged` projection that lands
   * unblocked — each writes the mirror eagerly so the transition is
   * diffable, trusting the dispatch-is-synchronous contract the old reducer
   * already documents (a later genuine OS echo just reconfirms the value).
   */
  bounds?: Rectangle;
  /**
   * Machine-owned, ported from `window-state.ts WindowRecord.maximized`: set
   * only by the `Maximize`/`Unmaximize` transitions, never an OS
   * `isMaximized()` report (frameless macOS windows don't reliably flip it).
   * "Maximize" is a work-area snap (a bounds write), not a platform
   * `maximize()` call.
   */
  maximized: boolean;
  /**
   * Non-null ONLY while `maximized` — the two transitions maintain the
   * pairing. `null` while maximized legitimately means "no bounds had ever
   * been reported, so no stash was possible" (same distinction as
   * `FsMode.preBounds`).
   */
  preMaxBounds: Rectangle | null;
  /** Pinned to every macOS Space or not — ported from `window-state.ts WindowRecord.visibleOnAllSpaces`. */
  visibleOnAllSpaces: boolean;
  /**
   * A `DisplayChanged` projection computed while this window was BLOCKED from
   * receiving it — blocked meaning `fsMode.name !== 'normal'` or
   * `visible === false`. Last projection wins while still blocked (overwrite,
   * never queue). Flushed as a bounds write — and cleared — only once BOTH
   * axes clear (`fsMode.name === 'normal'` AND `visible`); it stays held if
   * only one axis unblocks. Cleared WITHOUT flushing by any explicit bounds
   * write (`SetBounds`/`Maximize`/`Unmaximize`), so a stale projection can
   * never snap a deliberately-moved window back. `null` when nothing is held.
   */
  pendingProjectedBounds: Rectangle | null;

  /**
   * OVERLAY ATTACHMENT. Set on an OVERLAY record: the host window this
   * overlay frames. Absent = detached — the overlay belongs to nothing and
   * must not be on screen. Stored on the OVERLAY (one host per overlay),
   * not as a host -> overlay map: the app has ONE shared chrome overlay, so
   * "is this overlay attached, and to what?" is a record read, while the
   * reverse ("does this host have an overlay?") stays a scan of a handful
   * of records (`overlayForHost`). Attach / retarget / detach are the ONE
   * transition (`AttachOverlay`, `hostId: null` = detach); the follow is
   * driven by the host's `BoundsChanged` (`react`'s diff), never a live
   * query at decision time — ported from `window-state.ts
   * WindowRecord.overlayFor`.
   */
  overlayFor?: WindowId;
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
      keepLive?: boolean;
    }
  | { type: 'WindowShown'; id: WindowId }
  | { type: 'WindowHidden'; id: WindowId }
  | { type: 'WindowClosed'; id: WindowId }
  | { type: 'OsFocusGained'; id: WindowId }
  | { type: 'OsFocusLost'; id: WindowId }
  | { type: 'AppActiveChanged'; active: boolean }
  /** The first-composited-frame report — flips `orderable` to `true`. */
  | { type: 'WindowContentOrderable'; id: WindowId }
  /**
   * `decide`'s translation of a `SetFullscreen` command that starts a FRESH
   * transition (the target was settled — `normal`/`fullscreen`) into a fact
   * `evolve` can apply mechanically. The "is a transition already in
   * flight" guard lives in `decide` (§0.1.8) — by the time this event
   * exists, that guard has already run, so `evolve` just writes the given
   * fields, no per-mode branching. `preBounds` is resolved by `decide` from
   * the CURRENT record (its own read of `state`, same as any other guard).
   */
  | { type: 'FullscreenTransitionStarted'; id: WindowId; entering: boolean; preBounds: Rectangle | null }
  /**
   * `decide`'s translation of a `SetFullscreen` command that arrived while a
   * transition was already in flight (`entering`/`leaving`) — coalesces
   * into `pendingDesire` rather than starting a second transition. Applied
   * when that transition settles (`OsFullscreenEntered`/`OsFullscreenLeft`/
   * `FullscreenSettleTimeout` below).
   */
  | { type: 'FullscreenDesireRecorded'; id: WindowId; desired: boolean }
  /** OS report: the window IS fullscreen now. Settles `entering`/`leaving`/`normal` (§0.1.8). */
  | { type: 'OsFullscreenEntered'; id: WindowId }
  /** OS report: the window is NOT fullscreen now. Settles `leaving`/`entering`/`fullscreen`. */
  | { type: 'OsFullscreenLeft'; id: WindowId }
  /** The OS never reported a settle for this transition — force it out of `entering`/`leaving`. */
  | { type: 'FullscreenSettleTimeout'; id: WindowId }
  /**
   * The backend's native resize/move report (ported from `window-state.ts
   * BOUNDS_CHANGED`) — the OS report. The SOLE origin of a fact that writes
   * `WindowRecord.bounds`; `decide`'s translations of `SetBounds` /
   * `Maximize` / `Unmaximize` below reuse this same event shape rather than
   * inventing a second bounds-writing fact, under the dispatch-is-synchronous
   * contract described on the field.
   */
  | { type: 'BoundsChanged'; id: WindowId; bounds: Rectangle }
  /**
   * The display layout changed (ported from `window-state.ts
   * DISPLAY_CHANGED`) — one already-computed target rect per affected
   * window (this file keeps zero value imports and cannot ask `screen` for
   * anything itself). A window that is blocked (non-`normal` `fsMode` or
   * `visible: false`) has its entry held on `pendingProjectedBounds` instead
   * of applied; an unblocked entry writes `bounds` directly.
   */
  | { type: 'DisplayChanged'; projections: ReadonlyArray<{ id: WindowId; bounds: Rectangle }> }
  /**
   * A resize gesture invalidated maximize (ported from `window-state.ts
   * MAXIMIZE_EXITED_BY_RESIZE`) — dispatched at the press of a resize on a
   * maximized window, or by a native-resize reconciler. Clears `maximized` +
   * `preMaxBounds`, drives nothing back at the OS: the gesture owns the
   * window's bounds.
   */
  | { type: 'MaximizeExitedByResize'; id: WindowId }
  /**
   * `decide`'s translation of an accepted `Maximize` command into a fact
   * `evolve` can apply mechanically — `preMaxBounds` is resolved by `decide`
   * from the record's CURRENT `bounds` mirror (never a live query), same
   * pattern as `FullscreenTransitionStarted.preBounds`.
   */
  | { type: 'Maximized'; id: WindowId; preMaxBounds: Rectangle | null }
  /** `decide`'s translation of an accepted `Unmaximize` command — clears `maximized` + `preMaxBounds`. */
  | { type: 'Unmaximized'; id: WindowId }
  /**
   * `decide`'s translation of every accepted `SetBounds`/`Maximize`/
   * `Unmaximize` command: an explicit geometry decision supersedes any held
   * `DisplayChanged` projection, discarding it WITHOUT flushing (a stale
   * projection must never snap a deliberately-moved window back). Kept as
   * its own event — rather than folded into `BoundsChanged`/`Maximized`/
   * `Unmaximized` — so those stay single-purpose and this one fact covers
   * all three origins identically.
   */
  | { type: 'PendingProjectionDiscarded'; id: WindowId }
  /** `decide`'s translation of an accepted `SetVisibleOnAllSpaces` command. */
  | { type: 'VisibleOnAllSpacesSet'; id: WindowId; on: boolean }
  /**
   * `decide`'s translation of an accepted `AttachOverlay` command — attach,
   * retarget, and detach are all this ONE event (`hostId: null` = detach).
   * `evolve` just writes the given `hostId` onto the overlay record; the
   * follow itself is `react`'s job, driven off the host's next
   * `BoundsChanged`, never a live query at this event's own dispatch time.
   */
  | { type: 'OverlayAttached'; overlayId: WindowId; hostId: WindowId | null };

// ─────────────────────────────────────────────────────────────────────────────
// Commands — rejectable requests (§0.1.1, §0.1.2). Every variant carries
// `expectedVersion`; `decide` rejects on mismatch with a typed `Rejection`.
// ─────────────────────────────────────────────────────────────────────────────

export type Command =
  | { type: 'RaiseWindow'; id: WindowId; expectedVersion: number }
  | { type: 'ShowWindow'; id: WindowId; expectedVersion: number }
  | { type: 'HideWindow'; id: WindowId; expectedVersion: number }
  /** The keepLive branch point (§0.1): hide if keepLive, else close. Decided in `decide`, never `evolve`. */
  | { type: 'CloseOrHideWindow'; id: WindowId; expectedVersion: number }
  /** Carries the intrinsic properties; `decide` produces a `WindowRegistered` event. */
  | {
      type: 'RegisterWindow';
      id: WindowId;
      kind: WindowKind;
      layer: number;
      canBecomeKey: boolean;
      acceptsInput: boolean;
      class: string;
      parentId?: WindowId;
      keepLive?: boolean;
      expectedVersion: number;
    }
  /**
   * Fullscreen intent (§0.1.8) — orthogonal to `RaiseWindow`/`ShowWindow`:
   * never writes `key`, never reorders `order`. The command only expresses
   * intent; `OsFullscreenEntered`/`OsFullscreenLeft` are what actually settle
   * the region.
   */
  | { type: 'SetFullscreen'; id: WindowId; desired: boolean; expectedVersion: number }
  /**
   * App code wants this window at `bounds` (ported from `window-state.ts
   * SET_BOUNDS_REQUESTED`) — the rect is computed at the dispatch site
   * (this file keeps zero value imports). No-op while `fsMode` is non-normal:
   * fullscreen owns the display (the aa34cb50 family).
   */
  | { type: 'SetBounds'; id: WindowId; bounds: Rectangle; expectedVersion: number }
  /**
   * App code wants this window maximized (ported from `window-state.ts
   * MAXIMIZE_REQUESTED`) — a work-area snap, not a platform `maximize()`
   * call. Unlike the old event, this command carries no work-area rect: the
   * dispatch site issues a separate `SetBounds` for the actual snap, so this
   * kernel never needs `screen`. No-op while `fsMode` is non-normal (the
   * aa34cb50 family) or while already maximized (nothing new to snap to).
   */
  | { type: 'Maximize'; id: WindowId; expectedVersion: number }
  /**
   * App code wants this window restored from maximized (ported from
   * `window-state.ts UNMAXIMIZE_REQUESTED`): clears `maximized`, restores
   * `preMaxBounds` when a stash exists. No-op when not maximized.
   */
  | { type: 'Unmaximize'; id: WindowId; expectedVersion: number }
  /**
   * App code wants this window pinned to (or unpinned from) every macOS
   * Space (ported from `window-state.ts SET_VISIBLE_ON_ALL_SPACES_REQUESTED`,
   * raw path only — the role-derived `SPACES_POLICY_REQUESTED` policy stays
   * outside the kernel and is expressed as a caller composing this command).
   */
  | { type: 'SetVisibleOnAllSpaces'; id: WindowId; on: boolean; expectedVersion: number }
  /**
   * Attach, retarget, or detach the shared chrome overlay — `hostId: null`
   * is detach. One transition, no separate detach command (see the doc on
   * `WindowRecord.overlayFor`). `decide` rejects if either named window is
   * absent from `order`.
   */
  | { type: 'AttachOverlay'; overlayId: WindowId; hostId: WindowId | null; expectedVersion: number };

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
  | { type: 'RaiseWindow'; id: WindowId; opSeq: number }
  /** Drive the OS into fullscreen — emitted only when a record freshly transitions INTO `entering`. */
  | { type: 'SetFullscreen'; id: WindowId }
  /** Drive the OS out of fullscreen — emitted only when a record freshly transitions INTO `leaving`. */
  | { type: 'ExitFullscreen'; id: WindowId }
  /** Move the window's outer bounds — emitted by `react` as a structural diff of `bounds`, never from an event's own payload. */
  | { type: 'SetBounds'; id: WindowId; bounds: Rectangle }
  /** Pin/unpin the window on every macOS Space — emitted by `react` as a structural diff of `visibleOnAllSpaces`. */
  | { type: 'SetVisibleOnAllSpaces'; id: WindowId; on: boolean };

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
// Fullscreen transition table (§0.1.8) — pure `FsMode -> FsMode` helpers,
// ported from `window-state.ts applyFullscreenRequest` /
// `applyOsFullscreenEntered` / `applyOsFullscreenLeft`. Kept as free
// functions (not inlined in `evolve`'s switch) because each is total over
// `FsMode['name']` on its own, same reasoning as the old sub-reducer.
// ─────────────────────────────────────────────────────────────────────────────

/** `OsFullscreenEntered` settles `entering` -> `fullscreen` (or straight through to `leaving` on a coalesced cancel). */
function nextFsModeForOsEntered(mode: FsMode): FsMode {
  switch (mode.name) {
    case 'normal':
      // Green-button/OS-initiated entry — no stash was possible.
      return { name: 'fullscreen', preBounds: null };
    case 'entering':
      // Honor a coalesced "actually, leave" desire recorded mid-animation.
      return mode.pendingDesire === false
        ? { name: 'leaving', preBounds: mode.preBounds }
        : { name: 'fullscreen', preBounds: mode.preBounds };
    case 'leaving':
      // The OS won the race — fullscreen after all. Ported verbatim from
      // `window-state.ts`: a `pendingDesire` recorded here is dropped, not honored.
      return { name: 'fullscreen', preBounds: mode.preBounds };
    case 'fullscreen':
      return mode;
  }
}

/** `OsFullscreenLeft` settles `leaving` -> `normal` (or straight through to `entering` on a coalesced re-enter). */
function nextFsModeForOsLeft(mode: FsMode): FsMode {
  switch (mode.name) {
    case 'fullscreen':
      // Green-button/OS-initiated leave — clears the stash.
      return { name: 'normal' };
    case 'leaving':
      // Honor a coalesced "actually, re-enter" desire; no captured bounds here.
      return mode.pendingDesire === true ? { name: 'entering', preBounds: null } : { name: 'normal' };
    case 'entering':
      // Aborted by the OS mid-enter. Ported verbatim: a `pendingDesire`
      // recorded here is dropped, not honored.
      return { name: 'normal' };
    case 'normal':
      return mode;
  }
}

/**
 * `FullscreenSettleTimeout` — the OS never reported a settle for this
 * transition. Unlike the two settle functions above, this ALWAYS lands on a
 * settled bucket (`normal`/`fullscreen`), never chains into the other
 * transitional state, even when a `pendingDesire` was recorded — chaining
 * would just trade one stuck transition for another, and "never leave the
 * record transitional after a timeout" is the whole point of this event. A
 * `pendingDesire` that was still pending when the timeout fired is dropped;
 * the caller re-requests once settled, if it's still wanted.
 */
function nextFsModeForSettleTimeout(mode: FsMode): FsMode {
  switch (mode.name) {
    case 'entering':
      return { name: 'fullscreen', preBounds: mode.preBounds };
    case 'leaving':
      return { name: 'normal' };
    case 'normal':
    case 'fullscreen':
      return mode;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Geometry helpers (this slice) — pure, total, ported from `window-state.ts`
// `flushPendingProjection` and its `bounds` field-equality reasoning.
// ─────────────────────────────────────────────────────────────────────────────

/** Field-wise `Rectangle` equality — `bounds` diffs by value, never by reference. */
function boundsEqual(a: Rectangle | undefined, b: Rectangle | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * Flush a held `DisplayChanged` projection into `bounds` once BOTH blocking
 * axes are clear — ported from `window-state.ts flushPendingProjection`.
 * Total and side-effect-free: called from every evolve case that can newly
 * clear an axis (`WindowShown`, and the two fsMode settle cases that can land
 * on `normal`); a record that is still blocked, or holds nothing, passes
 * through unchanged.
 */
function withPendingProjectionFlushed(record: WindowRecord): WindowRecord {
  if (record.pendingProjectedBounds === null) return record;
  if (record.fsMode.name !== 'normal' || !record.visible) return record;
  return { ...record, bounds: record.pendingProjectedBounds, pendingProjectedBounds: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// evolve — TOTAL. No guards. Cannot throw. Reads nothing but its two
// arguments. Every event bumps `version`.
// ─────────────────────────────────────────────────────────────────────────────

export function evolve(state: State, ev: Event): State {
  switch (ev.type) {
    case 'WindowRegistered': {
      // Re-registration of a still-live id is real, expected traffic (e.g.
      // `ipc.ts`'s tile-launch path registers the same window twice) — a
      // "richer re-registration merge", not a rejection: the event's
      // intrinsic, declared-at-registration properties overwrite the
      // existing record, but LIVED facts (`visible`, `openSeq`) and its
      // position in `order` are preserved. Re-registration is not a raise.
      const existingIdx = state.order.findIndex((w) => w.id === ev.id);
      if (existingIdx !== -1) {
        const existing = state.order[existingIdx];
        const merged: WindowRecord = {
          id: existing.id,
          kind: ev.kind,
          layer: ev.layer,
          canBecomeKey: ev.canBecomeKey,
          acceptsInput: ev.acceptsInput,
          class: ev.class,
          visible: existing.visible,
          openSeq: existing.openSeq,
          // Never reset once true (§0.1.4): a re-registration that names
          // 'browser' also sets it true; it cannot flip back off.
          orderable: existing.orderable || ev.kind === 'browser',
          // A lived fact (§0.1.8), same as `visible`/`openSeq` — re-registration
          // must not reset an in-flight or settled fullscreen region.
          fsMode: existing.fsMode,
          // Lived geometry facts (this slice) — preserved across a
          // re-registration merge exactly like `fsMode` above.
          maximized: existing.maximized,
          preMaxBounds: existing.preMaxBounds,
          visibleOnAllSpaces: existing.visibleOnAllSpaces,
          pendingProjectedBounds: existing.pendingProjectedBounds,
          ...(existing.bounds !== undefined ? { bounds: existing.bounds } : {}),
          // A lived fact (attachment), same reasoning as `fsMode` above —
          // re-registration must not sever a live overlay attachment.
          ...(existing.overlayFor !== undefined ? { overlayFor: existing.overlayFor } : {}),
          ...(ev.parentId !== undefined ? { parentId: ev.parentId } : {}),
          ...(ev.keepLive !== undefined ? { keepLive: ev.keepLive } : {}),
        };
        return {
          ...state,
          order: [...state.order.slice(0, existingIdx), merged, ...state.order.slice(existingIdx + 1)],
          version: state.version + 1,
        };
      }

      const record: WindowRecord = {
        id: ev.id,
        kind: ev.kind,
        layer: ev.layer,
        canBecomeKey: ev.canBecomeKey,
        acceptsInput: ev.acceptsInput,
        class: ev.class,
        visible: false,
        openSeq: state.openSeqCounter,
        // `orderable` starts true only for 'browser' (§0.1.4); a 'page-host'
        // starts false and flips via `WindowContentOrderable`.
        orderable: ev.kind === 'browser',
        fsMode: { name: 'normal' },
        // Fresh geometry facts (this slice) — no rect has ever been
        // reported, nothing is stashed, nothing pinned, nothing held.
        maximized: false,
        preMaxBounds: null,
        visibleOnAllSpaces: false,
        pendingProjectedBounds: null,
        ...(ev.parentId !== undefined ? { parentId: ev.parentId } : {}),
        ...(ev.keepLive !== undefined ? { keepLive: ev.keepLive } : {}),
      };
      return {
        ...state,
        order: [...state.order, record],
        version: state.version + 1,
        openSeqCounter: state.openSeqCounter + 1,
      };
    }

    case 'WindowShown': {
      // Showing can newly clear the visibility axis of a held
      // DisplayChanged projection — flush if fsMode is also already normal.
      return {
        ...state,
        order: state.order.map((w) => (w.id === ev.id ? withPendingProjectionFlushed({ ...w, visible: true }) : w)),
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
      // key id is unobservable rather than repaired here. A record whose
      // `overlayFor` names the closed id is detached mechanically in the
      // same pass — an overlay must never keep pointing at a retired host.
      return {
        ...state,
        order: state.order
          .filter((w) => w.id !== ev.id)
          .map((w) => (w.overlayFor === ev.id ? { ...w, overlayFor: undefined } : w)),
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

    case 'WindowContentOrderable': {
      // Never resets to false — a miss (unregistered id) or a window already
      // orderable is a harmless no-op, not a repair.
      return {
        ...state,
        order: state.order.map((w) => (w.id === ev.id ? { ...w, orderable: true } : w)),
        version: state.version + 1,
      };
    }

    case 'FullscreenTransitionStarted': {
      // `decide` already ran the in-flight guard and resolved `preBounds` —
      // this is a mechanical write, no per-mode branching.
      return {
        ...state,
        order: state.order.map((w) =>
          w.id === ev.id
            ? { ...w, fsMode: ev.entering ? { name: 'entering', preBounds: ev.preBounds } : { name: 'leaving', preBounds: ev.preBounds } }
            : w,
        ),
        version: state.version + 1,
      };
    }

    case 'FullscreenDesireRecorded': {
      return {
        ...state,
        order: state.order.map((w) => {
          if (w.id !== ev.id) return w;
          const mode = w.fsMode;
          // Total against nonsense input (a fuzzed sequence bypassing
          // `decide`'s guard): coalescing only means something on an
          // in-flight transition; on a settled record this is a no-op.
          if (mode.name !== 'entering' && mode.name !== 'leaving') return w;
          return { ...w, fsMode: { ...mode, pendingDesire: ev.desired } };
        }),
        version: state.version + 1,
      };
    }

    case 'OsFullscreenEntered': {
      return {
        ...state,
        order: state.order.map((w) => (w.id === ev.id ? { ...w, fsMode: nextFsModeForOsEntered(w.fsMode) } : w)),
        version: state.version + 1,
      };
    }

    case 'OsFullscreenLeft': {
      // Can newly clear the fsMode axis of a held DisplayChanged projection
      // (several of its arms settle onto 'normal') — flush if visible too.
      return {
        ...state,
        order: state.order.map((w) =>
          w.id === ev.id ? withPendingProjectionFlushed({ ...w, fsMode: nextFsModeForOsLeft(w.fsMode) }) : w,
        ),
        version: state.version + 1,
      };
    }

    case 'FullscreenSettleTimeout': {
      // Same reasoning as OsFullscreenLeft: the 'leaving' arm can settle onto 'normal'.
      return {
        ...state,
        order: state.order.map((w) =>
          w.id === ev.id ? withPendingProjectionFlushed({ ...w, fsMode: nextFsModeForSettleTimeout(w.fsMode) }) : w,
        ),
        version: state.version + 1,
      };
    }

    // ── Geometry (this slice) ────────────────────────────────────────────────

    case 'BoundsChanged': {
      // The sole writer of `bounds` for a genuine OS report; also reused by
      // `decide`'s translation of SetBounds/Maximize/Unmaximize (see the
      // event doc). Mirror only — no other field, no effects computed here
      // (effects are `react`'s job, from the diff).
      return {
        ...state,
        order: state.order.map((w) => (w.id === ev.id ? { ...w, bounds: ev.bounds } : w)),
        version: state.version + 1,
      };
    }

    case 'DisplayChanged': {
      return {
        ...state,
        order: state.order.map((w) => {
          const projection = ev.projections.find((p) => p.id === w.id);
          if (projection === undefined) return w; // not named by this event — untouched
          const blocked = w.fsMode.name !== 'normal' || !w.visible;
          return blocked ? { ...w, pendingProjectedBounds: projection.bounds } : { ...w, bounds: projection.bounds };
        }),
        version: state.version + 1,
      };
    }

    case 'MaximizeExitedByResize': {
      // Total, guard-free: a not-maximized record already holds these values,
      // so this is an idempotent no-op for it — the guard old code needed
      // ("not maximized -> nothing to restore") is unnecessary here.
      return {
        ...state,
        order: state.order.map((w) => (w.id === ev.id ? { ...w, maximized: false, preMaxBounds: null } : w)),
        version: state.version + 1,
      };
    }

    case 'Maximized': {
      return {
        ...state,
        order: state.order.map((w) => (w.id === ev.id ? { ...w, maximized: true, preMaxBounds: ev.preMaxBounds } : w)),
        version: state.version + 1,
      };
    }

    case 'Unmaximized': {
      return {
        ...state,
        order: state.order.map((w) => (w.id === ev.id ? { ...w, maximized: false, preMaxBounds: null } : w)),
        version: state.version + 1,
      };
    }

    case 'PendingProjectionDiscarded': {
      return {
        ...state,
        order: state.order.map((w) => (w.id === ev.id ? { ...w, pendingProjectedBounds: null } : w)),
        version: state.version + 1,
      };
    }

    case 'VisibleOnAllSpacesSet': {
      return {
        ...state,
        order: state.order.map((w) => (w.id === ev.id ? { ...w, visibleOnAllSpaces: ev.on } : w)),
        version: state.version + 1,
      };
    }

    case 'OverlayAttached': {
      // Mechanical write — attach, retarget, and detach are this ONE case.
      // `hostId: null` clears the relation (`overlayFor: undefined`); a
      // nonexistent `overlayId` is a harmless no-op, same as any other
      // dangling-id event elsewhere in this file.
      return {
        ...state,
        order: state.order.map((w) => (w.id === ev.overlayId ? { ...w, overlayFor: ev.hostId ?? undefined } : w)),
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

  // Fullscreen (§0.1.8): a pure structural diff of `fsMode.name`, same
  // pattern as the visibility loop above — never branches on `ev.type`, so a
  // command-driven start, a coalesced re-entry after `leaving`, and a forced
  // settle-timeout resolution are all covered by one rule. A record whose
  // `fsMode.name` doesn't change (idempotent re-request, or a pendingDesire
  // coalesced without changing the transition's name) emits nothing.
  for (const nextRecord of next.order) {
    const prevRecord = prev.order.find((w) => w.id === nextRecord.id);
    if (prevRecord === undefined) {
      continue;
    }
    if (prevRecord.fsMode.name !== 'entering' && nextRecord.fsMode.name === 'entering') {
      effects.push({ type: 'SetFullscreen', id: nextRecord.id });
    } else if (prevRecord.fsMode.name !== 'leaving' && nextRecord.fsMode.name === 'leaving') {
      effects.push({ type: 'ExitFullscreen', id: nextRecord.id });
    }
  }

  // Geometry (this slice): `bounds` — a pure structural diff of the mirror,
  // same pattern as visibility/fullscreen above. Fires regardless of WHICH
  // event moved the mirror (an OS report, an accepted SetBounds/Maximize/
  // Unmaximize, an unblocked DisplayChanged projection, or a flushed
  // pendingProjectedBounds) — never branches on `ev.type`. A genuine OS echo
  // that merely reconfirms the mirror's current value diffs to nothing, so
  // re-requesting the current bounds emits no effect.
  for (const nextRecord of next.order) {
    const prevRecord = prev.order.find((w) => w.id === nextRecord.id);
    if (prevRecord === undefined) {
      continue;
    }
    if (nextRecord.bounds !== undefined && !boundsEqual(prevRecord.bounds, nextRecord.bounds)) {
      effects.push({ type: 'SetBounds', id: nextRecord.id, bounds: nextRecord.bounds });
    }
  }

  // Geometry (this slice): `visibleOnAllSpaces` — same diff pattern.
  for (const nextRecord of next.order) {
    const prevRecord = prev.order.find((w) => w.id === nextRecord.id);
    if (prevRecord === undefined) {
      continue;
    }
    if (prevRecord.visibleOnAllSpaces !== nextRecord.visibleOnAllSpaces) {
      effects.push({ type: 'SetVisibleOnAllSpaces', id: nextRecord.id, on: nextRecord.visibleOnAllSpaces });
    }
  }

  // Overlay follow (§ WindowRecord.overlayFor): an attached overlay's bounds
  // effect mirrors its HOST's bounds diff — never a live query, never a
  // branch on `ev.type`. A detached overlay (`overlayFor` undefined) has no
  // host to diff against and is skipped.
  for (const nextRecord of next.order) {
    if (nextRecord.overlayFor === undefined) continue;
    const prevHost = prev.order.find((w) => w.id === nextRecord.overlayFor);
    const nextHost = next.order.find((w) => w.id === nextRecord.overlayFor);
    if (nextHost === undefined) continue;
    if (nextHost.bounds !== undefined && !boundsEqual(prevHost?.bounds, nextHost.bounds)) {
      effects.push({ type: 'SetBounds', id: nextRecord.id, bounds: nextHost.bounds });
    }
  }

  // Overlay detach (an AttachOverlay retarget/detach, or the host closing):
  // a structural diff of `overlayFor` going from set -> unset. `evolve`
  // never flips `visible` for this, so a still-visible overlay must be
  // driven off screen explicitly here.
  for (const nextRecord of next.order) {
    const prevRecord = prev.order.find((w) => w.id === nextRecord.id);
    if (prevRecord === undefined) continue;
    if (prevRecord.overlayFor !== undefined && nextRecord.overlayFor === undefined && nextRecord.visible) {
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
  // bottom -> top stacking over visible, ORDERABLE windows, one SetStacking
  // per window. A window that is not yet orderable (a fresh page-host before
  // its first composited frame) cannot be positioned by the OS, so it is
  // omitted from the emission entirely.
  const orderChanged =
    prev.order.length !== next.order.length || prev.order.some((w, i) => w.id !== next.order[i]?.id);

  // When `WindowContentOrderable` flips a window from non-orderable to
  // orderable, that alone must trigger a fresh full re-emission — the
  // machine form of the old first-frame re-assert, with no timer and no poll
  // — even though `order`'s ids/positions did not change.
  const justBecameOrderable =
    ev.type === 'WindowContentOrderable' &&
    prev.order.find((w) => w.id === ev.id)?.orderable !== true &&
    next.order.find((w) => w.id === ev.id)?.orderable === true;

  if (orderChanged || justBecameOrderable) {
    for (const w of next.order) {
      if (w.visible && w.orderable) {
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

  // RegisterWindow is the one command that may legitimately name a window
  // not yet in `order` (that's the point of it) — it skips the existence
  // guard below entirely and just produces the matching event.
  if (cmd.type === 'RegisterWindow') {
    return {
      events: [
        {
          type: 'WindowRegistered',
          id: cmd.id,
          kind: cmd.kind,
          layer: cmd.layer,
          canBecomeKey: cmd.canBecomeKey,
          acceptsInput: cmd.acceptsInput,
          class: cmd.class,
          ...(cmd.parentId !== undefined ? { parentId: cmd.parentId } : {}),
          ...(cmd.keepLive !== undefined ? { keepLive: cmd.keepLive } : {}),
        },
      ],
    };
  }

  // AttachOverlay carries `overlayId`/`hostId`, not `id` — handled here,
  // before the generic `cmd.id` guard below, same reasoning as the
  // RegisterWindow special-case above.
  if (cmd.type === 'AttachOverlay') {
    if (!state.order.some((w) => w.id === cmd.overlayId)) {
      return { rejected: 'no-such-window' };
    }
    if (cmd.hostId !== null && !state.order.some((w) => w.id === cmd.hostId)) {
      return { rejected: 'no-such-window' };
    }
    return { events: [{ type: 'OverlayAttached', overlayId: cmd.overlayId, hostId: cmd.hostId }] };
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
    case 'CloseOrHideWindow': {
      // THE branch point (§0.1): keepLive === true hides, never closes, so
      // its content keeps running; otherwise it closes. This guard lives
      // here, never in `evolve`.
      const record = state.order.find((w) => w.id === cmd.id)!;
      return record.keepLive
        ? { events: [{ type: 'WindowHidden', id: cmd.id }] }
        : { events: [{ type: 'WindowClosed', id: cmd.id }] };
    }
    case 'SetFullscreen': {
      const rec = state.order.find((w) => w.id === cmd.id)!;
      const mode = rec.fsMode;
      // THE guard (§0.1.8's async edge, same shape as CloseOrHideWindow's
      // keepLive branch above): a request arriving while a transition is
      // already in flight does not start a second one — it coalesces into
      // `pendingDesire`, applied when that transition settles.
      if (mode.name === 'entering' || mode.name === 'leaving') {
        return { events: [{ type: 'FullscreenDesireRecorded', id: cmd.id, desired: cmd.desired }] };
      }
      if (mode.name === 'normal') {
        if (!cmd.desired) return { events: [] }; // already normal -> no-op, no OS call
        return { events: [{ type: 'FullscreenTransitionStarted', id: cmd.id, entering: true, preBounds: null }] };
      }
      // mode.name === 'fullscreen'
      if (cmd.desired) return { events: [] }; // already fullscreen -> no-op, no OS call
      return { events: [{ type: 'FullscreenTransitionStarted', id: cmd.id, entering: false, preBounds: mode.preBounds }] };
    }
    case 'SetBounds': {
      const rec = state.order.find((w) => w.id === cmd.id)!;
      // Fullscreen owns the display (aa34cb50 family, ported from
      // window-state.ts SET_BOUNDS_REQUESTED): a mid-episode bounds write
      // would corrupt the fullscreen geometry.
      if (rec.fsMode.name !== 'normal') return { events: [] };
      return {
        events: [
          { type: 'PendingProjectionDiscarded', id: cmd.id },
          { type: 'BoundsChanged', id: cmd.id, bounds: cmd.bounds },
        ],
      };
    }
    case 'Maximize': {
      const rec = state.order.find((w) => w.id === cmd.id)!;
      // Same aa34cb50 guard as SetBounds.
      if (rec.fsMode.name !== 'normal') return { events: [] };
      // Already maximized: this command carries no work-area rect (the
      // dispatch site owns that OS-boundary math), so there is nothing new
      // to snap to — a no-op rather than a re-snap.
      if (rec.maximized) return { events: [] };
      return {
        events: [
          { type: 'PendingProjectionDiscarded', id: cmd.id },
          // Stash the pre-maximize rect from the machine's own bounds
          // mirror — never a live query. `null` = no stash was possible.
          { type: 'Maximized', id: cmd.id, preMaxBounds: rec.bounds ?? null },
        ],
      };
    }
    case 'Unmaximize': {
      const rec = state.order.find((w) => w.id === cmd.id)!;
      if (!rec.maximized) return { events: [] }; // not maximized — nothing to restore
      const restore = rec.preMaxBounds;
      return {
        events: [
          { type: 'PendingProjectionDiscarded', id: cmd.id },
          { type: 'Unmaximized', id: cmd.id },
          // A null stash just clears the flag — nowhere to restore to.
          ...(restore !== null ? ([{ type: 'BoundsChanged', id: cmd.id, bounds: restore }] as Event[]) : []),
        ],
      };
    }
    case 'SetVisibleOnAllSpaces':
      return { events: [{ type: 'VisibleOnAllSpacesSet', id: cmd.id, on: cmd.on }] };
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

/**
 * The overlay attached to `hostId`, or null — the reverse scan named on
 * `WindowRecord.overlayFor`'s doc comment. A scan rather than an index: the
 * app has one shared chrome overlay and the record set is small.
 */
export function overlayForHost(state: State, hostId: WindowId): WindowRecord | null {
  for (const w of state.order) {
    if (w.overlayFor === hostId) return w;
  }
  return null;
}
