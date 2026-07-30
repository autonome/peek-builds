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
 * Index 0 of §0.1.6's fixed ordered layer array — where every ordinary window
 * sits. A record at a HIGHER index floats above the whole regular stack; that
 * is what Electron's `alwaysOnTop` buys, expressed as a band rather than a
 * per-window boolean. The array itself belongs to the (not yet built) adapter,
 * so the kernel names only the floor its own predicates compare against.
 */
export const BASE_LAYER = 0;

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

  /**
   * The IZUI role vocabulary the app already speaks (`palette` / `quick-view` /
   * `overlay` / `workspace` / `content` / `child-content` / `utility`) — one of
   * the fields §0.1.4 carries over unchanged from `window-state.ts
   * WindowRecord.role`. Distinct from `class`: `class` is a lookup-only
   * shorthand nothing branches on, while `role` is a declared policy fact that
   * transient autoclose reads (see `selectTransientAutoclose`).
   *
   * Optional, and `undefined` is meaningful rather than a hole: a window
   * registered without one is in no role set, so it is never a transient
   * victim and never a focuser exemption — the same behavior the old selector
   * gave an unregistered focuser whose role read `undefined`.
   */
  role?: string;

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

  /**
   * The newest `opSeq` stamped on a focus-family effect (`ShowWindow` /
   * `RaiseWindow`) issued for this window — what `isStaleSelfEcho` compares
   * an incoming `machine`-caused `OsFocusGained` against. Written in `evolve`
   * exactly where those effects would be emitted (`WindowShown` genuinely
   * clearing `visible`, `OsFocusGained` genuinely raising, `AppActivated`
   * re-showing a window the resign sweep hid), mirroring `react`'s own diff so
   * it never drifts from what was actually stamped. The value written is the
   * token of THAT op — the same `opSeqCounter` `react` stamps on the effect
   * (see `State.opSeqCounter`), never the pre-transition counter.
   * `undefined` until the first such effect for this window.
   */
  lastOpSeq?: number;

  /**
   * Set while this window was hidden by the `AppResignSettled` sweep (ported
   * from `window-state.ts WindowRecord.hiddenByAppBlur`) — the structural
   * replacement for a native-window expando. `AppActivated` re-shows exactly
   * the windows carrying this flag and clears it; a window hidden for any
   * other reason (a plain `WindowHidden`, an overlay detach) must not be
   * re-shown by that re-activation.
   */
  hiddenByAppBlur?: boolean;

  /**
   * ESCAPE OVERRIDE, declared at registration. `'ignore'` means "Escape is
   * this window's own business — hand it to the page and decide nothing".
   * ABSENT means the window takes part in the ordinary Escape path; that is
   * the meaningful default, not a hole, and it is what every window without
   * an explicit override gets.
   *
   * ONE value, deliberately, where `window-state.ts EscapeMode` names four
   * (`'auto' | 'close' | 'navigate' | 'ignore'`). Only `'ignore'` is ever a
   * decision input: the old reducer branches on it once (`decideEscape` step
   * 3 -> pass-through) and never reads the other three. `'close'` and
   * `'auto'` reach no branch at all; `'navigate'` is read exactly once and
   * NOT as an escape decision — `izui-roles.ts inferIzuiRole` maps it to
   * `role: 'workspace'` at registration, so by the time a record exists the
   * fact has already become a role. The three survive as prose on
   * `windows.ts addEscHandler`, which still documents the app-facing
   * `api.window.open({ escapeMode })` vocabulary; modelling them here would
   * be modelling dead inputs.
   *
   * Live producers of `'ignore'`: `renderer/hud/background.js` (the HUD) and
   * `chrome-extensions.ts` (extension popup/options pages, whose own DOM
   * handles Escape).
   *
   * The kernel stores this and nothing more. WHAT Escape does is interpreted
   * outside the machine (§0: "input interpretation lives OUTSIDE the window
   * manager") — the kernel never learns that a key called Escape exists.
   */
  escapeMode?: 'ignore';

  /**
   * Whether this window's CONTENT web contents currently holds macOS
   * first-responder status — the mirror of the native `rendererWC
   * 'focus'`/`'blur'` pair, written solely by
   * `ContentFirstResponderChanged`, never a live `wc.isFocused()` question at
   * a decision site. Ported from `window-state.ts
   * WindowRecord.contentFocused`.
   *
   * THREE-VALUED ON PURPOSE — `undefined` is NOT `false`, and collapsing the
   * two is a bug, not a simplification. `undefined` means "nothing has been
   * reported yet"; `false` means "an observed loss of first responder". The
   * consumer this exists for (`window-state.ts deriveEscGrabRegistered`, and
   * whatever replaces it outside the kernel) tests `=== false` explicitly,
   * because the two absent cases must NOT behave like an observed loss:
   *
   *   - a `kind: 'browser'` window never gets a report at all (its root web
   *     contents IS first responder whenever the window is key, so there is
   *     nothing independent to track). Reading absent as unfocused would arm
   *     the OS-level Escape grab permanently for every browser window —
   *     where Escape already works through `before-input-event`.
   *   - a page-host in the micro-gap between a just-driven content focus and
   *     the async native `'focus'` event it produces. Reading absent as
   *     unfocused would flap the grab on after every fresh show/raise.
   *
   * Also why a plain `boolean` defaulting to `false` at registration would be
   * wrong: registration is exactly the moment nothing has been reported.
   */
  contentFocused?: boolean;
}

/**
 * WHO caused an `OsFocusGained` report (ported from `window-state.ts
 * FocusCause`): without it, an OS focus report means both "the user switched
 * windows" and "the OS is echoing an operation this machine just requested"
 * — indistinguishable, which is the defect that let a machine-issued raise
 * sweep a palette the user had just opened.
 *
 *   - `machine`  the echo of a focus-family effect (`RaiseWindow`/
 *                `ShowWindow`) this machine emitted — `opSeq` is that
 *                effect's token. Because the token is a stamp rather than a
 *                boolean, a STALE self-echo (an `opSeq` older than the latest
 *                one issued for that window — see `isStaleSelfEcho`) is
 *                identifiable too.
 *   - `world`    a real user gesture, another app, Mission Control, a page
 *                click — everything else.
 */
export type FocusCause = { kind: 'machine'; opSeq: number } | { kind: 'world' };

/**
 * RULE 1 (§0.1.4): `order` holds EVERY registered window, bottom -> top, as
 * ONE structure — not a Map plus a parallel id array, so membership and order
 * cannot disagree. `WindowRegistered` appends; `WindowClosed` removes.
 * Nothing else changes membership. There is no visibility filter and no
 * eligibility filter — `order` is the total set, always.
 *
 * RULE 2 (§0.1.4): `key` is written ONLY by `OsFocusGained` / `OsFocusLost`.
 * It is never inferred, never repaired, never successor-guessed. `null` is a
 * legal steady state. A dangling key id (the window it names has since
 * closed) is made unobservable by `keyWindow` rather than guarded against
 * here — see that function. Losing app-active status does not mean some
 * other window gained key: `AppResigned`/`AppActivated` (below) never touch
 * this field.
 */
export interface State {
  readonly order: readonly WindowRecord[];
  readonly key: WindowId | null;
  /** RULE 4 + stale-intent rejection (§0.1.2). Bumped by every accepted event. */
  readonly version: number;
  /**
   * The `OpToken` counter — the ordering the stale-echo guard reads
   * (`isStaleSelfEcho`). ONE TOKEN PER TRANSITION THAT ISSUES AT LEAST ONE
   * FOCUS-FAMILY OP: `evolve` bumps it by exactly 1 in each arm whose diff
   * `react` turns into a `ShowWindow`/`RaiseWindow` (a `WindowShown` that
   * genuinely flips `visible`, an `OsFocusGained` that genuinely raises, an
   * `AppActivated` that re-shows what the resign sweep hid), and leaves it
   * untouched in every other transition. That is what makes the token
   * meaningful: two ops issued at different moments carry different numbers,
   * so an echo of the older one is recognisable as stale.
   *
   * The bump is a PER-TRANSITION scalar, not per-effect, because `react`
   * stamps every focus-family effect it emits with `next.opSeqCounter` — one
   * `AppActivated` re-showing three windows issues one op with one token
   * against three windows, and each of those records is stamped
   * `lastOpSeq` = that same value. `evolve`'s stamp and `react`'s token are
   * therefore the same number by construction; the property suite asserts the
   * equality rather than trusting the two sites to stay in step.
   */
  readonly opSeqCounter: number;
  readonly appActive: boolean;
  readonly openSeqCounter: number;
  /**
   * ARMED app-resign sweep — the dance guard (§0.1.9, ported from
   * `window-state.ts AppWindowState.pendingAppResignSweep`). macOS produces a
   * resign→activate cycle as ordinary activation churn (entering/leaving an
   * overlay does it), so a resign must not act immediately: `AppResigned`
   * only ARMS this flag; `AppActivated` DISARMS it — that disarm IS the dance
   * cancel. Only `AppResignSettled` arriving while still armed means the
   * resign was real, and it is the one that hides the sweep-eligible windows.
   * The settle DELAY itself is not modelled here — it lives in the (not yet
   * built) executor; this flag models only the arm/disarm/settle ordering.
   */
  readonly pendingAppResignSweep: boolean;
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
      role?: string;
      parentId?: WindowId;
      keepLive?: boolean;
      /** See `WindowRecord.escapeMode` — one live value, absent is meaningful. */
      escapeMode?: 'ignore';
    }
  | { type: 'WindowShown'; id: WindowId }
  | { type: 'WindowHidden'; id: WindowId }
  | { type: 'WindowClosed'; id: WindowId }
  /**
   * WHO caused it (see `FocusCause`). Absent means `world` — load-bearing:
   * a producer not yet taught to report provenance keeps its exact current
   * behavior. Provenance does not change what `key` becomes here; it only
   * feeds later decisions (`isStaleSelfEcho`).
   */
  | { type: 'OsFocusGained'; id: WindowId; cause?: FocusCause }
  | { type: 'OsFocusLost'; id: WindowId }
  /**
   * The app lost active status (ported from `window-state.ts APP_RESIGNED`).
   * ARMS `pendingAppResignSweep` — see that field's doc. Does not itself hide
   * anything: this may just be the resign half of the macOS activation dance,
   * which an `AppActivated` before any settle would immediately cancel.
   */
  | { type: 'AppResigned' }
  /**
   * The app became active (ported from `window-state.ts APP_ACTIVATED`).
   * DISARMS `pendingAppResignSweep` — the dance cancel. Also re-shows every
   * window carrying `hiddenByAppBlur` (exactly those the prior
   * `AppResignSettled` sweep hid) and clears the mark; a window hidden for
   * any other reason is untouched. Never writes `key`, never reorders `order`.
   */
  | { type: 'AppActivated' }
  /**
   * The delayed confirmation that a resign was real (ported from
   * `window-state.ts APP_RESIGN_SETTLED`) — the settle DELAY itself is not
   * modelled here, only its ordering relative to arm/disarm. Inert unless
   * `pendingAppResignSweep` is still armed (an `AppActivated` in between — the
   * dance — already disarmed it); when armed, hides the sweep-eligible
   * windows (`isAppResignSweepEligible` — the heads-up surfaces that float
   * above the stack and cannot hold key) and marks them `hiddenByAppBlur`.
   * Never writes `key`, never reorders `order`.
   */
  | { type: 'AppResignSettled' }
  /** The first-composited-frame report — flips `orderable` to `true`. */
  | { type: 'WindowContentOrderable'; id: WindowId }
  /**
   * The backend's mirror of the native `rendererWC 'focus'`/`'blur'` pair
   * (ported from `window-state.ts CONTENT_FIRST_RESPONDER_CHANGED`) — the
   * sole writer of `WindowRecord.contentFocused`, and the producer that makes
   * that field's three-valued distinction meaningful: before the first such
   * report the field is absent, and absent is not `false` (see the field's
   * doc). A report naming an unregistered window is a no-op, like every other
   * dangling-id event here. Drives no effect: it is a report ABOUT the OS, not
   * a request OF it.
   */
  | { type: 'ContentFirstResponderChanged'; id: WindowId; held: boolean }
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
   * As an event, it is a fact already decided elsewhere and can never be
   * rejected here: `evolve` normalizes a `hostId` that isn't registered, or
   * that names the overlay itself, into a detach rather than storing it —
   * see `evolve`'s `OverlayAttached` case. The follow itself is `react`'s
   * job, driven off the host's next `BoundsChanged`, never a live query at
   * this event's own dispatch time.
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
      role?: string;
      parentId?: WindowId;
      keepLive?: boolean;
      /** See `WindowRecord.escapeMode` — one live value, absent is meaningful. */
      escapeMode?: 'ignore';
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
    pendingAppResignSweep: false,
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
          // A lived fact (focus provenance), same reasoning — re-registration
          // must not erase the newest op issued for this window.
          ...(existing.lastOpSeq !== undefined ? { lastOpSeq: existing.lastOpSeq } : {}),
          // A lived fact (app-resign sweep memory), same reasoning — a
          // re-registration mid-sweep must not lose the mark AppActivated
          // needs to know which windows to re-show.
          ...(existing.hiddenByAppBlur !== undefined ? { hiddenByAppBlur: existing.hiddenByAppBlur } : {}),
          // A lived fact (first-responder mirror), same reasoning — the
          // window's content did not lose or gain first responder because a
          // producer re-registered it, and dropping the field here would
          // silently turn an observed `false` back into "nothing reported
          // yet", which is a DIFFERENT answer (see the field's doc).
          ...(existing.contentFocused !== undefined ? { contentFocused: existing.contentFocused } : {}),
          // An intrinsic, declared-at-registration property — a
          // re-registration that names a role overwrites the old one. Absent
          // from the event, the existing role is kept rather than erased
          // (same shape as `parentId`/`keepLive` below): a producer that never
          // learned to report a role must not silently strip one.
          ...(ev.role !== undefined ? { role: ev.role } : existing.role !== undefined ? { role: existing.role } : {}),
          ...(ev.parentId !== undefined ? { parentId: ev.parentId } : {}),
          ...(ev.keepLive !== undefined ? { keepLive: ev.keepLive } : {}),
          // Intrinsic, same shape as `role` above: an event that names one
          // overwrites, an event that omits one KEEPS the existing value
          // rather than erasing it. The asymmetry is deliberate — absent on
          // the event means "this producer did not report an override", not
          // "clear the override" — and it matters because the two live
          // producers of `'ignore'` (the HUD, extension pages) are exactly
          // the kind of window a second registration path can re-announce.
          ...(ev.escapeMode !== undefined
            ? { escapeMode: ev.escapeMode }
            : existing.escapeMode !== undefined
              ? { escapeMode: existing.escapeMode }
              : {}),
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
        ...(ev.role !== undefined ? { role: ev.role } : {}),
        ...(ev.parentId !== undefined ? { parentId: ev.parentId } : {}),
        ...(ev.keepLive !== undefined ? { keepLive: ev.keepLive } : {}),
        ...(ev.escapeMode !== undefined ? { escapeMode: ev.escapeMode } : {}),
        // `contentFocused` is deliberately NOT seeded: registration is
        // exactly the moment nothing has been reported, and absent is the
        // honest answer for that (see the field's doc).
      };
      // §0.1.10 — ONE ORDER, and nothing else orders windows. A fresh
      // registration is placed BELOW the last-focused window, never on top:
      // "a window that was not focused does not go on top". The consequence
      // is deliberate — a background-opened window no longer appears above
      // the window being worked in (the conclusion Metacity's
      // focus-stealing work reached: stacked below the focused window, but
      // still mapped).
      //
      // REGISTRATION IS THE INSERTION POINT, and the only one. It is the
      // only event that ADDS to `order`, and the only other event that
      // moves anything — `OsFocusGained` — is precisely the activating
      // case, which raises its target to the top on its own. So the two
      // rules are complete and disjoint: an open lands under the key
      // window, and taking focus is what puts a window over it. The SHOW
      // cannot carry the rule: `WindowShown` states only that a window
      // became visible, and whether the show activated is a separate
      // reported fact (`OsFocusGained`), so re-deriving "was this a
      // background open?" at the show would mean putting an activation flag
      // back onto it — the second ordering input this section deletes. It
      // is also why `WindowShown` never reorders (see its case below).
      //
      // The insertion index is the key window's own. Because a focus gain
      // moves its target to the END and every later registration lands
      // below it, the key window is the last element of `order` whenever it
      // resolves — so this reads as "directly under the window in use,
      // above everything else". With no key window, or a `key` id naming no
      // record (it closed, or was never registered), there is nothing to go
      // below and the record appends on top; that keeps the "key resolves
      // -> key is topmost" property true by construction, including for the
      // case where the dangling id is THIS registration's own.
      const keyIdx = state.key === null ? -1 : state.order.findIndex((w) => w.id === state.key);
      const insertAt = keyIdx === -1 ? state.order.length : keyIdx;
      return {
        ...state,
        order: [...state.order.slice(0, insertAt), record, ...state.order.slice(insertAt)],
        version: state.version + 1,
        openSeqCounter: state.openSeqCounter + 1,
      };
    }

    case 'WindowShown': {
      // Never reorders (§0.1.10): a show states that a window became
      // visible, not that it became the one in use. Where the window sits
      // was decided when it was registered (below the key window) and is
      // changed only by taking focus (`OsFocusGained`).
      //
      // Showing can newly clear the visibility axis of a held
      // DisplayChanged projection — flush if fsMode is also already normal.
      // `lastOpSeq` is stamped only when this genuinely flips `visible`
      // (the same condition `react` uses to emit `ShowWindow`) — an
      // already-visible window re-shown is a no-op for the effect too, and
      // issues no op, so the counter does not move either.
      const issuesShow = state.order.some((w) => w.id === ev.id && !w.visible);
      const opSeq = issuesShow ? state.opSeqCounter + 1 : state.opSeqCounter;
      return {
        ...state,
        order: state.order.map((w) => {
          if (w.id !== ev.id) return w;
          const flushed = withPendingProjectionFlushed({ ...w, visible: true });
          return w.visible ? flushed : { ...flushed, lastOpSeq: opSeq };
        }),
        opSeqCounter: opSeq,
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
      // `lastOpSeq` is stamped only when this genuinely raises the window
      // (the same condition `react` uses to emit `RaiseWindow`) — a focus
      // report on the window already on top moves nothing, stamps nothing,
      // and issues no op, so the counter stays put.
      const genuinelyRaised = idx !== state.order.length - 1;
      const opSeq = genuinelyRaised ? state.opSeqCounter + 1 : state.opSeqCounter;
      const movedRecord = genuinelyRaised ? { ...record, lastOpSeq: opSeq } : record;
      return {
        ...state,
        order: [...withoutRecord, movedRecord],
        key: ev.id,
        opSeqCounter: opSeq,
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

    case 'AppResigned': {
      // ARM only — hides nothing yet. See `pendingAppResignSweep`'s doc: this
      // may be the resign half of a dance an `AppActivated` is about to cancel.
      return {
        ...state,
        appActive: false,
        pendingAppResignSweep: true,
        version: state.version + 1,
      };
    }

    case 'AppActivated': {
      // Disarm — the dance cancel. Re-show exactly the windows a prior
      // AppResignSettled sweep hid (`hiddenByAppBlur`), clearing the mark;
      // anything hidden for another reason is untouched. `key`/`order` are
      // never touched here.
      //
      // The re-show is a focus-family op like any other: `react` emits a
      // `ShowWindow` per window whose `visible` flips, all carrying the ONE
      // token this transition mints, so every window it shows is stamped with
      // that same token. A re-activation that re-shows nothing (the ordinary
      // dance cancel, or a marked window that is somehow already visible)
      // issues no op and does not move the counter.
      const reshown = state.order.some((w) => w.hiddenByAppBlur === true && !w.visible);
      const opSeq = reshown ? state.opSeqCounter + 1 : state.opSeqCounter;
      return {
        ...state,
        appActive: true,
        pendingAppResignSweep: false,
        order: state.order.map((w) =>
          w.hiddenByAppBlur === true
            ? { ...w, visible: true, hiddenByAppBlur: false, ...(w.visible ? {} : { lastOpSeq: opSeq }) }
            : w,
        ),
        opSeqCounter: opSeq,
        version: state.version + 1,
      };
    }

    case 'AppResignSettled': {
      // Inert unless still armed — an AppActivated in between (the dance)
      // already disarmed this. When armed, the resign was real: hide every
      // sweep-eligible window (`isAppResignSweepEligible` — the two orthogonal
      // properties that made a window the old reducer's `hud` class) and mark
      // them so AppActivated knows to undo exactly this sweep.
      if (!state.pendingAppResignSweep) {
        return { ...state, version: state.version + 1 };
      }
      return {
        ...state,
        pendingAppResignSweep: false,
        order: state.order.map((w) =>
          isAppResignSweepEligible(w) ? { ...w, visible: false, hiddenByAppBlur: true } : w,
        ),
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

    case 'ContentFirstResponderChanged': {
      // Mechanical mirror write, total and guard-free: an unregistered id is
      // a harmless no-op, and `held` is stored as reported — the machine
      // never infers first-responder status, it only records what the OS
      // said. This is the ONLY writer of `contentFocused`, which is what
      // keeps "absent = nothing reported yet" true by construction.
      return {
        ...state,
        order: state.order.map((w) => (w.id === ev.id ? { ...w, contentFocused: ev.held } : w)),
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
      // dangling-id event elsewhere in this file. As an event this can name
      // ANY `hostId` — unregistered, since-closed, or the overlay itself —
      // so it's normalized rather than trusted: a `hostId` absent from
      // `order`, or equal to `ev.overlayId`, resolves to a detach, keeping
      // the two `overlayFor` invariants (never dangling, never self) true
      // by construction instead of by relying on callers to only ever pass
      // a valid host.
      const resolvedHostId: WindowId | undefined =
        ev.hostId !== null && ev.hostId !== ev.overlayId && state.order.some((w) => w.id === ev.hostId) ? ev.hostId : undefined;
      return {
        ...state,
        order: state.order.map((w) => (w.id === ev.overlayId ? { ...w, overlayFor: resolvedHostId } : w)),
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

  // RaiseWindow: a REORDER put a different window on top. Same structural
  // shape as every rule above — same membership, different topmost id — so it
  // reads `prev`/`next` only and never asks which event caused the move.
  //
  // A membership change is deliberately NOT a raise. Registration can land a
  // record on top (no key window to go under), and closing the top window
  // promotes the one beneath it; in both the set changed rather than a window
  // taking focus, and asserting key for the promoted window would be exactly
  // the successor-guessing RULE 2 forbids — worse, the record beneath may be
  // hidden, and a raise SHOWS what it raises. Length equality is what
  // excludes both: the only event that reorders without changing membership
  // is `OsFocusGained`.
  //
  // WHY A FOCUS REPORT DRIVES AN OS RAISE AT ALL — this contradicts the old
  // reducer's standing invariant ("no RAISE_WINDOW from OS_FOCUS_GAINED, the
  // pump's convergence obligation"), which is superseded here rather than
  // violated:
  //
  //  1. It is the ONLY route to key. §0.1.10 makes use-order and z-order one
  //     order, so `decide` turns a `RaiseWindow` COMMAND into an
  //     `OsFocusGained` event — the same event an OS report produces. Drop
  //     this emission and a raise command reaches the OS as nothing but the
  //     `SetStacking` re-assert below, which is relative z-order with no
  //     activation and no first-responder semantics: the machine would move
  //     the window in its own model and never make it the window in use.
  //     The old reducer could hold the invariant because its raise had a
  //     SEPARATE effect route (`window-state.ts applyRaiseRequest`); this
  //     kernel has one route, and a structural diff cannot tell a report from
  //     a command — the two states are identical.
  //
  //  2. The feedback loop the invariant guarded against cannot run: this
  //     emission is its own fixed point. The raise moves its target to the
  //     top, so the focus the OS reports back finds it ALREADY topmost —
  //     `prev` and `next` have the same top, the diff is empty, and the echo
  //     emits nothing. One correcting write, then silence. (Provenance —
  //     `FocusCause` / `lastOpSeq` / `isStaleSelfEcho` — is NOT what closes
  //     this loop and cannot be: `react` reads no event payload. It solves a
  //     different problem at a different site — a LATE self-echo, arriving
  //     after some other window took key, is a genuine raise by this rule and
  //     must be dropped BEFORE it reaches `evolve`.)
  //
  //  3. §0.1.6 asks for exactly this. The OS stack is a write-only projection
  //     and a reconciliation path is required, not just a write path: when the
  //     OS reports a focus the machine did not order, the machine re-asserts
  //     its own model. Against an OS that already agrees the write is
  //     idempotent — activating an already-key window changes nothing and
  //     provokes no further focus report.
  //
  // Executor obligation: `RaiseWindow` is an ACTIVATING show, so whatever
  // performs it owes the same activation masks a show owes (never activate
  // under headless; a quick-view NSPanel never activates the app).
  const prevTop = prev.order[prev.order.length - 1];
  const nextTop = next.order[next.order.length - 1];
  if (
    prevTop !== undefined &&
    nextTop !== undefined &&
    prevTop.id !== nextTop.id &&
    prev.order.length === next.order.length &&
    prev.order.some((w) => w.id === nextTop.id)
  ) {
    effects.push({ type: 'RaiseWindow', id: nextTop.id, opSeq: next.opSeqCounter });
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
          ...(cmd.role !== undefined ? { role: cmd.role } : {}),
          ...(cmd.parentId !== undefined ? { parentId: cmd.parentId } : {}),
          ...(cmd.keepLive !== undefined ? { keepLive: cmd.keepLive } : {}),
          ...(cmd.escapeMode !== undefined ? { escapeMode: cmd.escapeMode } : {}),
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
 * True when `cause` is a `machine` echo whose `opSeq` is OLDER than the
 * newest op issued for `id` (`WindowRecord.lastOpSeq`) — a stale self-echo
 * that a later decision (the transient sweep, not built here) should
 * disregard rather than treat as fresh provenance. `world` is never stale
 * (there is no op to be stale against), and a window with no `lastOpSeq` yet
 * has nothing to compare against either.
 */
export function isStaleSelfEcho(state: State, id: WindowId, cause: FocusCause): boolean {
  if (cause.kind !== 'machine') return false;
  const record = state.order.find((w) => w.id === id);
  return record?.lastOpSeq !== undefined && cause.opSeq < record.lastOpSeq;
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

/**
 * The host an overlay is currently attached to, or null when it is detached
 * (or is not a registered window at all). Reads the OVERLAY record's own
 * `overlayFor` field — the direction the relation is stored in.
 *
 * The OPPOSITE query from `overlayForHost` above, and not interchangeable
 * with it. This one answers "what am I currently framing?", which is what
 * every read-back caller in `hybrid-overlay.ts` asks: `ensureOverlay()`'s
 * `did-finish-load` handoff, `wireShowNavbarFocus()`'s windowId gate,
 * `wireExecuteScript()`, `initHybridOverlay()`'s load-error callback, and the
 * test bridge. `overlayForHost` takes the host id those callers are trying to
 * FIND, so it cannot serve them.
 *
 * Deliberately NOT an ordering query either. "The topmost page-host" is
 * non-null in states where the overlay frames nothing — the base window was
 * destroyed, or the overlay id is not minted yet — and answering a read-back
 * with it paints chrome over a window that has none attached.
 */
export function hostForOverlay(state: State, overlayId: WindowId): WindowRecord | null {
  const overlay = state.order.find((w) => w.id === overlayId);
  if (overlay === undefined || overlay.overlayFor === undefined) return null;
  return state.order.find((w) => w.id === overlay.overlayFor) ?? null;
}

/**
 * The roles of a real, document-like window — the ones a user thinks of as
 * "what I am working in". Everything else is a panel, chrome, or
 * infrastructure. See `isContentWindow` for why the membership is what it is.
 */
export const CONTENT_ROLES: ReadonlySet<string> = new Set(['content', 'child-content', 'workspace']);

/**
 * THE content predicate — `topmost(state, isContentWindow)` is AppKit's *main
 * window* (§0.1.5 "Key vs. main"): the standard window where the user is
 * currently working, and so the semantic target of menus and commands. It is
 * the replacement for the old `window-state.ts isEligibleFront` (`visible &&
 * !satellite && live`), and it is the correct mapping for every production
 * reader of the retired `front` field — `keyWindow(state)` is the mapping for
 * NONE of them. Old `front` was satellite-excluding and sticky across app
 * switches; kernel `key` is neither (`OsFocusLost` nulls it, and the shared
 * chrome overlay can hold it), so a naive `key` mapping silently changes
 * behaviour with no error path.
 *
 * `WindowRecord` carries no `satellite` field — that flag was an invention
 * (§0), so the exclusion is reconstructed from the genuine OS-level and
 * declared facts:
 *
 *   - `visible`        the surviving half of `isEligibleFront`. Nothing off
 *                      screen is what the user is working in.
 *   - `canBecomeKey`   the `focusable: false` half. The OS genuinely will
 *                      never give such a window key, so it can never be what
 *                      the user is working in. This clause alone excludes the
 *                      HUD (`renderer/hud/background.js`, `alwaysOnTop:true,
 *                      focusable:false`) — which is load-bearing, because the
 *                      HUD's INFERRED role is `'workspace'`, an admitted one.
 *                      It also excludes the space-border indicator
 *                      (`features/spaces/background.js`) and the privileged
 *                      test fixture (`test-fixture-glue.ts`).
 *   - a role in
 *     `CONTENT_ROLES`  an allow-list, not a deny-list: an unknown role, or no
 *                      role at all, is NOT content. A deny-list would admit
 *                      every future surface by default, which is the failure
 *                      mode `satellite` had.
 *
 * WHAT THE ROLE ALLOW-LIST EXCLUDES, and why:
 *
 *   - `'palette'` / `'quick-view'` — panel-like transients. AppKit's rule
 *     exactly: when key shifts from a standard window to a PANEL, main stays
 *     with the standard window. The command palette holds key while the page
 *     host is still what a command must act on.
 *
 *     `'quick-view'` (peeks and slides) is the deliberate change here. The
 *     old model kept quick-views front-eligible on purpose — there is an
 *     explicit `isSatelliteRegistration` test saying so — but only because
 *     `front` had to double as the ESCAPE target as well as the command
 *     target. That coupling is exactly what the key/main split dissolves:
 *     Escape now targets `key` (the window actually taking keystrokes), so
 *     nothing is lost by treating a peek as the panel it is. A focused slide
 *     still receives its own Escape, because it holds key.
 *
 *   - `'overlay'` — the shared chrome overlay and the space-border indicator.
 *     Chrome attached to a window, never the window itself. It is
 *     deliberately focusable (typing a URL in the navbar takes key), so the
 *     role clause, not `canBecomeKey`, is what excludes it.
 *
 *   - `'utility'` — chain popups, AND every infrastructure window: each of
 *     `background` (`core-glue.ts`), `bridge` (`chrome-extensions.ts`),
 *     `offscreen` (`chrome-api-polyfills/offscreen.js`), `test-fixture` and
 *     `devtools` (`main.ts`) registers with `role: 'utility'`. That is why
 *     this predicate needs no `class` test to exclude them — which also keeps
 *     it inside §0.1.4's rule that `class` may be read for an identity, never
 *     for a decision.
 *
 * WHAT IT ADMITS: `'content'` and `'child-content'` (ordinary page hosts, and
 * chrome-extension popup/options pages, which register `role: 'content'` and
 * were front-eligible before), and `'workspace'` (the settings window, and
 * any non-web-page surface `inferIzuiRole` defaults to that role).
 *
 * NO `layer` CLAUSE, deliberately. Every window that floats above the base
 * layer in production is already excluded by one of the three clauses above —
 * the HUD and space border by `canBecomeKey`, the cmd panel and peeks/slides
 * by role — so a `layer <= BASE_LAYER` clause would discriminate nothing
 * today, and tomorrow it would silently demote a content window someone pins
 * on top. `isAppResignSweepEligible` DOES test `layer` because there the
 * clause has live windows on both sides of it; here it does not.
 *
 * INTERACTION WITH `hiddenByAppBlur` AND THE `AppActivated` RE-SHOW — checked,
 * and it is a non-interaction by construction. The app-resign sweep hides only
 * `isAppResignSweepEligible` windows, which requires `!canBecomeKey`; this
 * predicate requires `canBecomeKey`. The two sets are therefore DISJOINT, so
 * no content window is ever hidden by an app switch and no `visible` answer
 * here flickers as the app resigns and re-activates. (A property invariant
 * asserts the disjointness rather than leaving it to this comment.) The
 * separate `selectAppResignTransients` dismissal is also disjoint: it takes
 * only transient roles, none of which are in `CONTENT_ROLES`.
 *
 * ONE PREDICATE, NOT THE ONLY ONE. Two upcoming callers want a NARROWER set
 * and must not be served by widening this one: `tile-ipc.ts`
 * `tileResolveWebWindow` and `tile:window:devtools` want http/https content
 * only. That needs a URL fact this kernel does not carry yet (the old
 * `WindowRecord.lastHttpUrl`); until it does, those callers post-filter. The
 * Cmd+W target (`windows.ts resolveFocusedWindowIdForClose`) is a
 * COMPOSITION, not a fourth predicate: the key window when it is itself
 * content, else `topmost(state, isContentWindow)` — which is precisely the
 * overlay-focused redirect that predicate already hand-rolls.
 */
export function isContentWindow(record: WindowRecord): boolean {
  if (!record.visible) return false;
  if (!record.canBecomeKey) return false;
  return roleIn(CONTENT_ROLES, record.role);
}

/**
 * The page-host the shared chrome overlay should attach to: the topmost
 * `kind: 'page-host'` window sitting in the base layer. `topmost(state,
 * pred)` is trustworthy only when every record `pred` admits shares one
 * `layer` (see `topmost`'s own doc); this predicate holds that contract with
 * two clauses, neither of which is optional:
 *
 *   - a role in `CONTENT_ROLES`   `kind: 'page-host'` alone is not enough to
 *                                  mean "a base-layer page". `ipc.ts
 *                                  assembleHybridPageHost` registers EVERY
 *                                  hybrid page host with `kind: 'page-host'`,
 *                                  including peeks and slides, which register
 *                                  `role: 'quick-view'`. Without this clause
 *                                  the predicate admits a floating quick-view,
 *                                  and the overlay frames a peek while the
 *                                  base-layer page underneath it sits
 *                                  chrome-less.
 *   - `layer === BASE_LAYER`      a page-host is not confined to the base
 *                                  layer — one can sit in a floating band
 *                                  behind the cmd panel, a peek, or a slide,
 *                                  alongside base-layer page-hosts. `order` is
 *                                  insertion- and movement-ordered, never
 *                                  layer-sorted, so without this clause array
 *                                  position and visual stacking diverge with
 *                                  no error path — the topmost `order` entry
 *                                  need not be the topmost on screen.
 *
 * `visible` and `orderable` are carried over from the same reasoning
 * `isContentWindow` and the `SetStacking` emission (`react`) already apply: a
 * hidden window is not on screen to frame, and a page-host the OS cannot yet
 * z-order (before its first composited frame) cannot be the overlay's target.
 */
export function topmostBaseLayerPageHost(state: State): WindowRecord | null {
  return topmost(
    state,
    (r) => r.kind === 'page-host' && r.visible && r.orderable && r.layer === BASE_LAYER && roleIn(CONTENT_ROLES, r.role),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Transient autoclose — the role sets and the two selectors, ported from
// `window-state.ts` (`TRANSIENT_ROLES`, `AUTOCLOSE_EXEMPT_ROLES`,
// `AUTOCLOSE_FOCUSER_EXEMPT_ROLES`, `selectTransientAutoclose`,
// `selectAppResignTransients`).
//
// They are QUERIES, not transitions: each answers "which windows should be
// dismissed", and the caller turns each id into a `CloseOrHideWindow` command
// — which is where the keepLive branch already lives (§0.1, `decide`). That
// keeps `evolve` guard-free and keeps effects a structural diff, instead of
// teaching an event arm to sweep.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The roles that are TRANSIENT — they open and close frequently and ride above
 * the workspace. Ported VERBATIM from `izui-roles.ts TRANSIENT_ROLES` (via
 * `window-state.ts`); all three copies must agree.
 */
export const TRANSIENT_ROLES: ReadonlySet<string> = new Set(['palette', 'quick-view', 'overlay']);

/**
 * Transient roles the autoclose EXEMPTS as a VICTIM. `overlay` is
 * transient-class but manages its own show/hide through the attachment
 * relation (`WindowRecord.overlayFor`), never through a close — so an
 * autoclose must never touch it.
 */
export const AUTOCLOSE_EXEMPT_ROLES: ReadonlySet<string> = new Set(['overlay']);

/**
 * Roles that, when THEY are the one gaining focus, sweep NOTHING — the
 * focuser-side exemption set, distinct from `AUTOCLOSE_EXEMPT_ROLES`:
 *
 *   - `utility`  a chain popup, child of a transient — it must not dismiss
 *                its own transient parent.
 *   - `overlay`  the shared chrome overlay is app chrome attached to the very
 *                window it would be dismissing, and it is deliberately
 *                focusable (typing a URL in the navbar takes key), so a focus
 *                landing on it is not "the user switched to a different
 *                window".
 */
export const AUTOCLOSE_FOCUSER_EXEMPT_ROLES: ReadonlySet<string> = new Set(['utility', 'overlay']);

/** Default provenance for a focus report that carries none — see `FocusCause`. */
const WORLD_CAUSE: FocusCause = { kind: 'world' };

/**
 * `role` is optional on a record; an absent role is in no set. Exported
 * alongside the role sets themselves so an out-of-file caller consuming them
 * gets that convention rather than re-deriving it — `set.has(rec.role)` does
 * not type-check against an optional role, and the tempting workarounds
 * (`rec.role ?? ''`, a non-null assertion) each quietly invent a membership
 * answer for a window that declared nothing.
 */
export function roleIn(set: ReadonlySet<string>, role: string | undefined): boolean {
  return role !== undefined && set.has(role);
}

/**
 * Which transient siblings a newly-focused window dismisses. Semantics ported
 * exactly from `window-state.ts selectTransientAutoclose`:
 *
 *   - a focuser whose role is in `AUTOCLOSE_FOCUSER_EXEMPT_ROLES` closes
 *     NOTHING;
 *   - skip the focuser itself, any non-visible window, any non-transient role;
 *   - `overlay` is exempt as a VICTIM too (`AUTOCLOSE_EXEMPT_ROLES`);
 *   - an UNREGISTERED focuser (no record) has no role, which is in no exempt
 *     set — so it sweeps every visible transient.
 *
 * Kind-agnostic on purpose: BOTH `browser` and `page-host` windows are
 * candidates (the close-on-blur regression, peek 8e5c3174, was hybrid page
 * hosts never being in the candidate set).
 *
 * ONE further clause on top of that: a focus the MACHINE caused may not
 * dismiss anything opened AFTER the op that caused it. Two live failures share
 * this shape. (i) The slow-open race: a hotkeyed page host takes time to load,
 * the user opens a palette meanwhile, the host finally takes OS focus and the
 * sweep dismissed the palette asked for afterwards. (ii) The handoff-raise
 * echo (peek 7fffa286): a slide hides, the machine hands the front off with a
 * raise, and the OS echo of that machine-issued raise swept a palette the user
 * had opened one transition earlier.
 *
 * In both, the missing fact was never "which role" — the roles involved are
 * exactly the ones a legitimate switch must still sweep, which is why this is
 * not a third entry in `AUTOCLOSE_FOCUSER_EXEMPT_ROLES`. The missing fact was
 * WHO asked for this focus and WHEN: `cause` states the first (an executor
 * report, never an inference) and `openSeq` supplies the second.
 *
 * So `machine` ARMS AN ORDERING TEST — it never skips the sweep. A palette
 * that the machine legitimately raised over a slide is machine-caused too, and
 * it must still sweep that slide; what spares a window is being NEWER than the
 * focuser, not the cause on its own. `world` (the default) runs no ordering
 * test and sweeps every visible transient.
 *
 * `isStaleSelfEcho` is deliberately not consulted: a stale self-echo is still
 * a machine echo, and the ordering test it arms is already the conservative
 * answer for one (spare anything newer than the focuser). Reading staleness
 * here could only widen the sweep, which is the direction both live failures
 * came from.
 */
export function selectTransientAutoclose(
  state: State,
  focusedId: WindowId,
  cause: FocusCause = WORLD_CAUSE,
): WindowId[] {
  const focuser = state.order.find((w) => w.id === focusedId);
  if (focuser !== undefined && roleIn(AUTOCLOSE_FOCUSER_EXEMPT_ROLES, focuser.role)) return [];
  // The ordering floor is armed ONLY by a machine cause on a registered
  // focuser — an unregistered one has no `openSeq` to compare against, so it
  // sweeps everything whatever the cause.
  const orderingFloor: number | null = cause.kind === 'machine' && focuser !== undefined ? focuser.openSeq : null;
  const out: WindowId[] = [];
  for (const rec of state.order) {
    if (rec.id === focusedId) continue;
    if (!rec.visible) continue;
    if (!roleIn(TRANSIENT_ROLES, rec.role)) continue;
    if (roleIn(AUTOCLOSE_EXEMPT_ROLES, rec.role)) continue;
    if (orderingFloor !== null && rec.openSeq > orderingFloor) continue;
    out.push(rec.id);
  }
  return out;
}

/**
 * Which transient surfaces a REAL app switch dismisses — ported from
 * `window-state.ts selectAppResignTransients`. Same role/visibility rule as
 * the focus-driven selector with no focuser to exclude, and scoped to
 * `page-host` windows: a transient `browser` window already self-closes on
 * app blur through its own per-window path, so sweeping it here would race
 * that.
 *
 * Distinct from what `evolve`'s `AppResignSettled` arm does, and not a second
 * answer to the same question: that arm reversibly HIDES the heads-up surfaces
 * (`isAppResignSweepEligible`) and marks them for `AppActivated` to restore,
 * while these transients are dismissed outright and never come back. The two
 * sets cannot overlap — a transient role is excluded from the hide predicate
 * by construction, so no window is both hidden-for-later and dismissed.
 */
export function selectAppResignTransients(state: State): WindowId[] {
  const out: WindowId[] = [];
  for (const rec of state.order) {
    if (rec.kind !== 'page-host') continue;
    if (!rec.visible) continue;
    if (!roleIn(TRANSIENT_ROLES, rec.role)) continue;
    if (roleIn(AUTOCLOSE_EXEMPT_ROLES, rec.role)) continue;
    out.push(rec.id);
  }
  return out;
}

/**
 * Which windows a REAL app switch hides for the duration — `evolve`'s
 * `AppResignSettled` arm applies exactly this, and `AppActivated` undoes
 * exactly what it marked. Ported from `window-state.ts`'s `class === 'hud' &&
 * visible` sweep, decomposed into the orthogonal facts that MADE a window that
 * class (`classifyWindowRegistration`: `alwaysOnTop && focusable === false`,
 * with the role classes taking precedence):
 *
 *   - `layer > BASE_LAYER`   the `alwaysOnTop` half — it floats above the
 *                            whole regular stack;
 *   - `!canBecomeKey`        the `focusable: false` half — §0.1.4's "a HUD
 *                            never holds key";
 *   - a non-transient role   the role precedence, kept as a role test because
 *                            it is one: a palette / quick-view / overlay
 *                            declares its own app-resign policy (see
 *                            `selectAppResignTransients`, and the chrome
 *                            overlay's attachment relation), and never
 *                            classified as a HUD however it was constructed;
 *   - `visible`              nothing hidden for another reason may be marked,
 *                            or the re-show on activation would resurrect it.
 *
 * NEITHER half of the pair is sufficient alone, and the difference is live in
 * both directions: `!canBecomeKey` on its own also takes the space-border
 * indicator (`features/spaces/background.js`, an `alwaysOnTop` role-`overlay`
 * window) and the privileged test fixture (`test-fixture-glue.ts`,
 * `focusable: false` but NOT floating), neither of which the old reducer ever
 * swept; `layer > BASE_LAYER` on its own takes the focusable always-on-top
 * windows (a cmd panel) that the old sweep deliberately left alone because
 * they have their own blur handling and would blink.
 */
export function isAppResignSweepEligible(record: WindowRecord): boolean {
  if (!record.visible) return false;
  if (record.canBecomeKey) return false;
  if (record.layer <= BASE_LAYER) return false;
  if (roleIn(TRANSIENT_ROLES, record.role)) return false;
  return true;
}
