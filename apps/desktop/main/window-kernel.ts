/**
 * window-kernel.ts — the rewritten window-manager kernel (draft).
 *
 * Blueprint: `docs/design/window-manager.md` §0.1 ("The rewritten kernel — state
 * shape and structure"). Follow that section; this file is a literal, minimal
 * implementation of it, not a redesign.
 *
 * SCOPE: no longer greenfield. A cutover moved production readers of the old
 * reducer's `front` field onto this file's queries (`isContentWindow`,
 * `isFrontEligibleWindow`, `topmost`, `keyWindow`) — `windows.ts`, `ipc.ts` and
 * `hybrid-overlay.ts` among them; `window-state.ts` has since been deleted,
 * and this file is now the sole authority those callers read. This file
 * carries the first two slices of the ~45-event surface
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
 * ZERO value imports (mirrors the rule `window-state.ts` followed before it
 * was deleted): this
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
 *
 * `unverified` marks that the machine no longer trusts this belief — the
 * settle timeout expired with no native report, or the app just came back
 * active after a possible background transition — and is answered by
 * `react`'s fullscreen-reconcile rule (see its doc). It is unrepresentable on
 * `normal`/`fullscreen` by construction: only a transition still in flight can
 * be unverified. It self-clears for free rather than needing an explicit
 * clear step: `nextFsModeForOsEntered`/`nextFsModeForOsLeft` build a fresh
 * mode object on every settle, and a fresh object has no `unverified` key.
 */
export type FsMode =
  | { name: 'normal' }
  | { name: 'entering'; preBounds: Rectangle | null; pendingDesire?: boolean; unverified?: true }
  | { name: 'fullscreen'; preBounds: Rectangle | null }
  | { name: 'leaving'; preBounds: Rectangle | null; pendingDesire?: boolean; unverified?: true };

/**
 * Bounded wait for the native macOS fullscreen enter/leave animation to
 * settle (AppKit's own animation runs ~600ms; this leaves margin). Used by
 * both the boundary timer that emits `FULLSCREEN_SETTLE_TIMEOUT`
 * (`electron-window-backend.ts`) and the kernel executor's
 * `waitForSettledFsMode` default (`window-kernel-executor.ts`) — one value so
 * the two settle bounds cannot drift apart. Lives here rather than in
 * `electron-window-backend.ts` because that module is the only window-manager
 * module that imports `electron`, and a value import from it would pull
 * `electron` transitively into the executor.
 */
export const FULLSCREEN_SETTLE_TIMEOUT_MS = 1500;

/**
 * Index 0 of §0.1.6's fixed ordered layer array — where every ordinary window
 * sits. A record at a HIGHER index floats above the whole regular stack; that
 * is what Electron's `alwaysOnTop` buys, expressed as a band rather than a
 * per-window boolean. The array itself belongs to the (not yet built) adapter,
 * so the kernel names only the floor its own predicates compare against.
 */
export const BASE_LAYER = 0;

/**
 * Which set of desktops a window belongs to, per-window and binary — the
 * platform-neutral intention (`docs/design/window-manager.md` §0, "the
 * governing rule set"): every window either FOLLOWS the user from desktop to
 * desktop, or BELONGS to the desktop it was opened on. Nothing above the
 * port may ask which OS concept realizes either one, how many native calls
 * that takes, or whether the current platform has a notion of "desktop" at
 * all — that is the backend's business (`window-backend.ts
 * setDesktopMembership`). This kernel and the port therefore never spell
 * Apple's name for the underlying mechanism.
 *
 *   - `follow`  rides along to whichever desktop the user is currently on.
 *   - `anchor`  stays on the desktop it was opened on.
 */
export type DesktopMembership = 'follow' | 'anchor';

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
  /**
   * false = click-through (`setIgnoreMouseEvents`). Set at registration; a
   * window whose click-through changes afterward (e.g. the Space border's
   * separate IPC round trip) is kept honest by `WindowAcceptsInputChanged`,
   * the sole post-registration writer — see that event's doc.
   */
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
  /**
   * THE MACHINE'S OWN BELIEF that this window is going away, ahead of the
   * OS's confirmation — distinct from `visible`, which keeps meaning strictly
   * "what the OS last reported" and is written only by the backend's
   * shown/hidden echo. That echo is queued behind whatever the executor's
   * pump is already draining, so a rule reading `visible` alone can act on a
   * window the machine has already decided to tear down: raise it as a
   * successor, attach the shared chrome overlay to it, resurrect it on app
   * activation. This field is the separate lived fact those rules need.
   *
   * SET by the three window-naming teardown arms (`WindowDestroyRequested`,
   * `WindowContentCloseRequested`, `WindowDirectCloseRequested`) — see
   * `evolve`'s TEARDOWN section for why `GuestTeardownRequested` does NOT set
   * it: that teardown names no window, and inferring which records own
   * guests is not something the kernel can know. NOT set for a
   * transient-autoclose dismissal victim either (`selectTransientAutoclose`)
   * — that selector is a pure query `react` runs off `next`, and marking a
   * victim here would make the sweep consume its own output.
   *
   * CLEARED by `WindowShown` (mirrors the `hiddenByAppBlur` clear on that
   * same arm) and by `WindowHidden` (the confirming echo — the fact has done
   * its job). `WindowClosed` needs no clear for the closed record itself (it
   * leaves `order` entirely), but DOES clear it on any record it mechanically
   * detaches (`overlayFor === ev.id`) — otherwise the shared chrome overlay
   * would carry a stale mark forever and vanish from
   * `isBaseLayerPageHost`/`topmostBaseLayerPageHost` for good, the original
   * overlay-attach defect inverted.
   *
   * ACCEPTED RESIDUE: a destroy the backend never completes produces neither
   * a `WindowClosed` nor a `WindowHidden`, so the mark can persist forever.
   * There is deliberately no repair path — a repair would mean the machine
   * inferring a teardown's outcome instead of being told it, which is exactly
   * the belief-versus-reality discipline `visible` exists to keep honest.
   */
  pendingHidden?: boolean;
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
  /**
   * Which desktops this window belongs to (see `DesktopMembership`) — the
   * window's declared INTENTION, never an OS flag. `undefined` until the
   * first `SetDesktopMembership` command: a window nobody has ever asked to
   * follow or anchor is simply untouched, not "anchored" by default.
   *
   * Ported from `window-state.ts WindowRecord.visibleOnAllSpaces`, whose
   * boolean encoding could not tell an anchored window (which explicitly
   * settles on `false`) apart from one nobody had ever asked about — both
   * read `false`. This field's optionality is what removes that conflation:
   * "anchored" and "never touched" are now different values.
   */
  desktopMembership?: DesktopMembership;
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
   * ATTACHED-OVERLAY TARGET FRAME. Set on an OVERLAY record alongside
   * `overlayFor`: the frame the overlay should currently occupy, taken
   * verbatim from whichever call supplied one (`AttachOverlay.frame`,
   * `BoundsChanged.overlayFrame`) — the kernel never computes this itself.
   * `expandToOverlayFrame` (`overlay-frame.ts`) needs a work-area read
   * (`screen.getDisplayNearestPoint`), which is platform data this
   * zero-value-import file cannot ask for, so the frame rides on the
   * command/event as data, computed at the dispatch site that already knows
   * the work area — the same design `window-state.ts
   * OVERLAY_ATTACH_REQUESTED.frame` / `BOUNDS_CHANGED.overlayFrame` used.
   *
   * DISTINCT FROM `bounds`, deliberately: `bounds` is a window's own
   * OS-mirrored rect, written only by a genuine `BoundsChanged` naming THAT
   * window. `overlayFrame` is a TARGET this window (the overlay) has not
   * necessarily reached on screen yet — which is exactly what makes it a
   * STORED FACT `react` can diff into a `SetBounds` effect (see `react`'s
   * "Overlay follow — frame" rule) without reading `ev.type`: the fact
   * exists so `react` never has to ask which event produced it, only
   * whether it moved. `undefined` until the first frame is ever given, and
   * untouched by a hide (a fullscreen-hidden overlay keeps its last frame,
   * so re-revealing it needs no new `SetBounds`).
   */
  overlayFrame?: Rectangle;

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
   * Set while this window went off screen BECAUSE the app stopped being active
   * (ported from `window-state.ts WindowRecord.hiddenByAppBlur`) — the
   * structural replacement for a native-window expando. `AppActivated` re-shows
   * exactly the windows carrying this flag and clears it; a window hidden for
   * any other reason (a plain `WindowHidden`, an overlay detach) must not be
   * re-shown by that re-activation.
   *
   * SET ON THE RAW `AppResigned` EDGE, not the settle, for both attached
   * overlays and `isAppResignSweepEligible` floaters (the two share
   * `layer > BASE_LAYER` — floating above the regular stack means floating
   * above OTHER applications' windows too). `AppResignSettled` re-runs the
   * same sweep only as a backstop for a window that became eligible in the
   * gap between the two events. Both are reversible visibility, so both are
   * undone by the same re-show. What waits for the settle is DISMISSAL (the
   * `pendingAppResignSweep`/`appActive` diff `react` sweeps off, not this
   * flag), because dismissal is destructive — a dismissed palette does not
   * come back, so the activation dance must not trigger it. A hide
   * that `AppActivated` will undo carries no such risk, and a floating window
   * cannot afford the delay: 500ms of it is 500ms of Peek's chrome or HUD
   * hanging over the app the user just switched to.
   */
  hiddenByAppBlur?: boolean;

  /**
   * ESCAPE OVERRIDE, declared at registration. `'ignore'` means "Escape is
   * this window's own business — hand it to the page and decide nothing".
   * ABSENT means the window takes part in the ordinary Escape path; that is
   * the meaningful default, not a hole, and it is what every window without
   * an explicit override gets.
   *
   * ONE value, matching `window-backend.ts EscapeMode` — narrowed to
   * `'ignore'` because that is the only value any code ever branched on:
   * the old reducer read it once (`decideEscape` step 3 -> pass-through),
   * the current one reads it the same way (`window-escape.ts
   * interpretEscape` step 3). `'close'` and `'auto'` never reached a branch
   * at all; `'navigate'` had one reader, `izui-roles.ts inferIzuiRole`,
   * which mapped it to `role: 'workspace'` — but no production caller ever
   * passed it, so the arm was deleted along with the type's other two dead
   * values with no behaviour change.
   *
   * Live producers of `'ignore'`: `renderer/hud/background.js` (the HUD) and
   * `chrome-extensions.ts` (extension popup/options pages, whose own DOM
   * handles Escape).
   *
   * The kernel stores this and nothing more. WHAT Escape does is interpreted
   * outside the machine (§0: "input interpretation lives OUTSIDE the window
   * manager") — the kernel never learns that a key called Escape exists.
   *
   * DO NOT DELETE THIS FIELD as unread. No rule in this file branches on it,
   * which makes it look like dead weight to a size-reduction pass; its reader
   * is `window-escape.ts interpretEscape`, which is outside the kernel by
   * design. Nothing in that function's role x session table means "pass
   * Escape through", so removing the field sends the HUD (role `workspace`)
   * and extension pages (role `content`) to `escapeFallbackPolicy`, and
   * Escape opens the switcher instead of reaching their own DOM handlers.
   */
  escapeMode?: 'ignore';

  /**
   * Whether this window is the shared chrome overlay singleton — the one
   * window whose job is to frame whichever base-layer page host is topmost
   * (`topmostBaseLayerPageHost`). A DECLARED fact in the sense of §0 stored
   * fact 3 ("each window's own lifecycle state, plus its intrinsic
   * properties as created"): written at registration, never revisited, and
   * — like every other declared fact on this record — OVERWRITTEN rather
   * than preserved by the re-registration merge.
   *
   * NOT `role === 'overlay'`, deliberately. Keying the behavior on role
   * would silently capture any future overlay-role window that is not the
   * shared chrome — this file's repeated correction (`overlayFor`,
   * `parentId`, and now this field) is that these relations are structural
   * facts, never role lookups. It exists because the rule that will consume
   * it must be able to name the overlay record when the overlay is
   * DETACHED — at which point `overlayFor` is absent and there is no
   * attachment edge left to find it by.
   *
   * Inert today: nothing reads this field yet. A later change adds the
   * effect that does.
   */
  tracksBaseLayerTop?: boolean;

  /**
   * Whether this window tears itself down the moment it loses focus — the
   * `modal` open option (`izui-roles.ts windowSelfClosesOnBlur`). A DECLARED
   * fact, same shape as `tracksBaseLayerTop` above: written at registration
   * from the caller's open-time options, never revisited, and OVERWRITTEN
   * rather than preserved by the re-registration merge.
   *
   * There is no dedicated blur handler anywhere in the backend — a `modal`
   * window closes through the same route as everything else: a blur feeds
   * the ordinary focus/app-resign flow (`electron-window-backend.ts`'s
   * deferred blur settle), and `isTransientAutocloseCandidate` admits a
   * record with this field set as a candidate for the transient-dismissal law
   * (`selectTransientAutoclose`) alongside every `TRANSIENT_ROLES` window,
   * roleless or not — so it is dismissed by `react`'s ordinary sweep, not a
   * call site of its own.
   *
   * The other thing `isAppResignSweepEligible` reads it for: a window that
   * already closes itself on blur already owns its own app-resign policy, so
   * the raw-edge sweep hiding it too would be redundant — and worse, would
   * stamp `hiddenByAppBlur` on a record that is about to be torn down anyway,
   * for `AppActivated` to find nothing left to re-show.
   */
  selfClosesOnBlur?: boolean;

  /**
   * Declared at registration, same shape as `selfClosesOnBlur`/
   * `tracksBaseLayerTop` above: this window's lifetime is the app's own, not
   * an ordinary user-closable surface. `decide`'s `CloseOrHideWindow` branch
   * REJECTS a command naming a record with this set — neither hiding nor
   * closing it — and the cascade that branch runs for a closing window's
   * descendants (`descendantsToCascadeClose`) skips a record carrying this
   * flag, and its whole subtree, rather than sweeping it. The one live
   * producer is the hidden core background window (`core-glue.ts`, the
   * `WEB_CORE_ADDRESS` document) — its teardown is a quit concern
   * (`GuestTeardownRequested`/`WindowDestroyRequested`), never an ordinary
   * close request, so an ordinary close request must never reach it. Absent
   * is the meaningful default: every other window is an ordinary closable
   * surface.
   */
  appLifetime?: boolean;

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
   * consumer this exists for (`window-escape.ts shouldArmEscapeGrab`, the
   * replacement for `window-state.ts deriveEscGrabRegistered`) tests
   * `=== false` explicitly, because the two absent cases must NOT behave like an observed loss:
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
  /**
   * The most recent teardown request, or `null` before any (§0.1.5 "window
   * teardown enters the kernel as commands and leaves as effects").
   *
   * WHY IT IS STATE AT ALL. Teardown changes nothing else the kernel stores:
   * the record retires on the native `WindowClosed` report the teardown
   * causes, never on the request itself (the same acceptance the old machine's
   * `WINDOW_DESTROY_REQUESTED` / `WINDOW_CONTENT_CLOSE_REQUESTED` /
   * `GUEST_TEARDOWN_REQUESTED` arms record). A transition with no state diff
   * has no effect either, because `react` is a pure structural projection and
   * may not branch on `ev.type`. So the request has to become a FACT `react`
   * can diff, and this field is that fact.
   *
   * `seq` is what makes repetition visible: two identical destroy requests for
   * the same window are two teardowns, and comparing payloads would collapse
   * them into one. It counts teardowns only — it is not `opSeqCounter`, which
   * orders focus ops and is read by the stale-echo guard.
   *
   * Nothing clears the field. A later non-teardown transition leaves it
   * untouched, which diffs to nothing, so "stale" here is unobservable: the
   * value means "the last teardown requested was this one", not "a teardown is
   * pending".
   */
  readonly lastTeardown: TeardownRequest | null;
  /**
   * The most recent FOCUS ASSERT request, or `null` before any — "re-assert
   * the raise on this window, which is already where the machine wants it".
   *
   * WHY IT IS STATE AT ALL, and it is the same reason `lastTeardown` above is:
   * the request changes nothing else the kernel stores. Its target is already
   * topmost, already visible, already key — so `prev` and `next` are identical
   * everywhere else, and a transition with no state diff has no effect either,
   * because `react` is a pure structural projection that may not branch on
   * `ev.type`. The request therefore has to become a FACT `react` can diff,
   * and this field is that fact.
   *
   * WHY THE APP NEEDS ONE. Devtools opens with `activate: false` and takes
   * macOS first responder off the content `WebContentsView` of whatever window
   * is in front. Nothing about the window model changed — the same window is
   * still front, still visible, still key — but its content no longer hears
   * keystrokes, which is the `7c61e917` shape ("dead until you click the
   * page": no `before-input-event`, so Escape has no handler at all). The old
   * machine handled it by re-running its raise on the current front
   * (`window-state.ts`'s shared `DEVTOOLS_OPENED`/`DEVTOOLS_CLOSED` arm ->
   * `applyRaiseRequest`), which is exactly what this fact reproduces.
   *
   * `seq` is what makes repetition visible, for the same reason it is on
   * `TeardownRequest`: two asserts for the same window are two asserts, and
   * comparing payloads would collapse them into one — which for this family is
   * the whole point, since the payload is IDENTICAL every time (open devtools,
   * close devtools, open again). It counts asserts only; it is not
   * `opSeqCounter`, which orders focus ops and is read by the stale-echo guard.
   *
   * Nothing clears the field. A later unrelated transition leaves it
   * untouched, which diffs to nothing, so "stale" here is unobservable: the
   * value means "the last assert requested was this one", not "an assert is
   * pending".
   */
  readonly lastFocusAssert: FocusAssertRequest | null;
  /**
   * THE MOST RECENT FOCUS REPORT, or `null` before any — the fact that lets
   * `react` apply transient autoclose (§0: "no dispatch site can silently
   * skip running it") as a pure structural diff instead of a branch on
   * `ev.type`. `OsFocusGained` is its only writer. The app-resign half of
   * dismissal (attention leaving Peek entirely) is a SEPARATE structural diff
   * now, over `pendingAppResignSweep`/`appActive` — see `react`'s resign-sweep
   * rule — because that half needed no payload of its own beyond a flag a
   * prior transition already had to store for the dance guard.
   *
   * `holder` is the window attention is on — EXPLICIT, not derived at diff
   * time from `key`, even though `OsFocusGained`'s two branches always write
   * it the same `ev.id` that lands on `key` in the same transition: `react`
   * reads this field alone, so the sweep never has to reach past it into a
   * differently-shaped field.
   *
   * WHY IT IS STATE AT ALL, and the shape mirrors `lastTeardown` /
   * `lastFocusAssert` exactly: `react(prev, ev, next)` may not read `ev`
   * (§0.1.1), so `selectTransientAutoclose`'s `cause` argument — which would
   * otherwise ride on the triggering event's own payload — has to become a
   * FACT `react` can diff before the sweep can be driven off `next` alone.
   *
   * `seq` is what makes repetition visible, for the same reason it is on
   * `TeardownRequest`/`FocusAssertRequest`: the old machine ran the sweep on
   * EVERY `OS_FOCUS_GAINED` report, including one that re-confirms the window
   * already holding key (an echo), so a repeated or reset seq would collapse
   * two reports — and two sweeps — into one.
   *
   * Nothing clears the field, for the same reason nothing clears the other
   * two: a later transition that writes neither writer's event leaves it
   * untouched, which diffs to nothing.
   */
  readonly lastAttention: Attention | null;
  /**
   * THE ARMED COLD-START FOCUS LATCH — the window a later app activation is to
   * put back in front, or `null` for "nothing armed" (ported from
   * `window-state.ts AppWindowState.pendingColdStartFocus`).
   *
   * WHY IT EXISTS. Session restore raises and activates the saved-focused
   * descriptor, but the macOS startup activation dance can fire a FINAL resign
   * AFTER that, re-stranding the app behind the previous one — its menubar, its
   * key window. The next activation is the moment to put the saved-focused
   * window back in front, and this field is what remembers which window that
   * is. There is no timer: arming is the restore's decision (cold start,
   * non-headless, the window is actually there) and firing is the machine's.
   *
   * `null` IS A PAYLOAD, NOT A HOLE. `session.ts restoreSessionSnapshot` arms
   * `null` as its first statement — clearing a latch a previous restore pass
   * armed and never spent — and arms a real id later in the same pass. Both are
   * ordinary traffic, and "clear" has no separate event.
   *
   * Armed by `ColdStartFocusArmed` and spent by `AppActivated`, which clears it
   * to `null` and records the re-raise on `lastFocusAssert` — see that arm for
   * why the spend goes through the assert fact rather than through `order`. The
   * latch is one-shot: an activation with nothing armed changes neither field,
   * and only a fresh arm refills it.
   *
   * The id is stored AS GIVEN, including one naming no member of `order`:
   * arming happens before the named window is guaranteed live, and a window
   * that has gone by the time the latch is spent makes the spend a no-op —
   * `react`'s assert rule emits nothing for a target absent from `order`.
   */
  readonly pendingColdStartFocus: WindowId | null;
  /**
   * THE ARMED SWITCHER SELECTION — the window to put in front when the
   * switcher that armed it goes away, or `null` for "nothing armed".
   *
   * WHY IT EXISTS. Picking a window in the switcher and dismissing the
   * switcher with Escape are the same closing window from the outside, and
   * only the first restores focus: a plain dismiss deliberately leaves the
   * user's current desktop alone, because raising the previously-focused
   * window can drag them to a desktop it happens to be anchored to. The
   * difference between the two is the SELECTION, and it is knowable only
   * while the switcher is still open — so it is recorded then, not
   * reconstructed at close time.
   *
   * WHY IT IS A PAIR. `armer` is the switcher; `target` is what the user
   * picked. The spend is keyed on the armer's own removal rather than on any
   * close, so an unrelated window closing while a selection is armed leaves
   * it armed — a selection outlives everything except the switcher it was
   * made in.
   *
   * WHY A `WindowId` AND NOT A PLATFORM ID. The decision used to live in
   * `main.ts`'s native `'closed'` handler, matching the closing window's
   * numeric Electron id against a parallel session object, and it had to live
   * there because the backend has already dropped its id map by the time the
   * kernel hears about the close. Recording the intent as a `WindowId` at
   * SELECTION time — while the window is alive and resolvable — removes the
   * need for a platform id at close time entirely, so the rule can be a
   * kernel rule (`apps/desktop/CLAUDE.md`, "Electron is ONE backend, not the
   * design").
   *
   * Armed by `SelectionFocusArmed` and spent by `WindowClosed` naming the
   * armer, which clears it to `null` and records the raise on
   * `lastFocusAssert` — the same one-shot shape `pendingColdStartFocus` has,
   * and the same reason for going through the assert fact: the transition
   * changes nothing else `react` could diff.
   *
   * The target is stored AS GIVEN, including one naming no member of `order`:
   * a window that has gone by the time the latch is spent makes the spend a
   * no-op, because `react`'s assert rule emits nothing for a target absent
   * from `order`.
   */
  readonly pendingSelectionFocus: SelectionFocus | null;
  /**
   * PEEK'S WINDOWS CAME UP WHILE THE USER WAS IN ANOTHER APP, and the user has
   * not come to Peek since. The one fact the Escape decider needs about the
   * app's session (`window-escape.ts escapeClosePolicy` /
   * `escapeFallbackPolicy`).
   *
   * WHAT IT CHANGES. A window that appeared over whatever the user was already
   * doing — a peek, a slide — is something Escape should just dismiss, handing
   * them straight back. A window they opened while working in Peek is
   * somewhere they meant to be, so Escape navigates within Peek instead, and
   * falls back to the switcher rather than closing.
   *
   * WHY THIS AND NOT THE COORDINATOR'S FOUR STATES. `izui-state.ts` carries a
   * four-value session (idle/transient/active/overlay) that co-decided
   * dismissal from outside the kernel. The Escape decider never needed four:
   * its dispatch already folded `overlay` into `active`, and both of its
   * policy tables then compare against `transient` alone — `idle` and `active`
   * take the same branch in each. So the fact the decider actually reads is
   * this single bit, and modelling the bit is what lets the kernel own the
   * decision without importing a second state machine's vocabulary. The
   * coordinator's four states remain, for display; nothing decides on them.
   *
   * THE RULE, transliterated from `izui-state.ts evaluateOnShow` +
   * `notifyAppActiveGained`:
   *   - The FIRST window to join an empty `order` sets it: `true` when the app
   *     is not active at that moment, `false` when it is.
   *   - Any later window opening while the app IS active clears it, and so
   *     does `AppActivated`. Both are the coordinator's one-way ratchet: the
   *     user has arrived in Peek, so this is somewhere they meant to be. There
   *     is no path back to `true` without the session ending first.
   *   - Emptying `order` resets it to `false`, which is that session ending.
   *     The coordinator ends its session when its window stack empties, and an
   *     empty `order` is that same fact.
   *
   * Drives no effect. It is an input to the Escape interpreter, which reads
   * state and issues commands; `react` never diffs it.
   */
  readonly openedInBackground: boolean;
}

/**
 * An armed switcher selection — see `State.pendingSelectionFocus`. Always a
 * pair: the rule is "when THIS window goes, raise THAT one", and neither half
 * is derivable from the other.
 */
export interface SelectionFocus {
  armer: WindowId;
  target: WindowId;
}

/**
 * A focus re-assert the kernel was asked to perform. Always names a window —
 * unlike `TeardownRequest`, there is no process-wide variant: "re-assert the
 * raise" is meaningless without a target, and the CALLER picks that target
 * (see the `AssertFocus` command for which conditions the caller owns).
 */
export interface FocusAssertRequest {
  id: WindowId;
  seq: number;
}

/**
 * The most recent focus report — see `State.lastAttention`. `holder` is
 * EXPLICIT rather than read off `key`: see that field's doc for why `key`
 * cannot stand in for it. `OsFocusGained` is the only writer, so `holder` is
 * always a real `WindowId` — the app-resign half of dismissal (attention
 * landing on nothing of Peek's) is a separate structural diff now, over
 * `pendingAppResignSweep`/`appActive`, and never comes through here.
 */
export interface Attention {
  holder: WindowId;
  cause: FocusCause;
  seq: number;
}

/**
 * A teardown the kernel was asked to perform (§0.1.5). Three name a window;
 * `destroy-all-guests` names none — the event, the effect, and the port's
 * `destroyAllContentGuests` are all process-wide, iterating the guest map
 * directly. Fanning it out over `order` at any layer would MISS guests whose
 * host record has already retired, which is precisely the quit case it exists
 * for.
 */
export type TeardownRequest =
  | { kind: 'destroy-window'; id: WindowId; seq: number }
  | { kind: 'close-content'; id: WindowId; seq: number }
  | { kind: 'close-window-direct'; id: WindowId; seq: number }
  | { kind: 'destroy-all-guests'; seq: number };

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
      /** See `RegisterWindow.bounds`'s doc — carried through unchanged by `decide`. */
      bounds?: Rectangle;
      /** See `WindowRecord.tracksBaseLayerTop` — declared here, nothing reads it yet. */
      tracksBaseLayerTop?: boolean;
      /** See `WindowRecord.selfClosesOnBlur`'s doc — declared here. */
      selfClosesOnBlur?: boolean;
      /** See `WindowRecord.appLifetime`'s doc — declared here. */
      appLifetime?: boolean;
    }
  /**
   * `opSeq` is present only when this event is the backend's own echo of a
   * `ShowWindow`/`HideWindow`/`RaiseWindow` effect this executor just issued
   * (`electron-window-backend.ts showWindow`/`hideWindow`/`raiseWindow`
   * thread the effect's op token straight through) — the SAME provenance
   * shape `OsFocusGained.cause` uses, one level down: a visibility echo
   * carries the token of the op that provoked it, absent means a producer
   * not yet taught to report one (a bare `ShowWindow`/`HideWindow` COMMAND,
   * `decide` above). Consulted only by `isStaleWindowEcho` — `evolve` itself
   * still reads none of this (see that function's doc for why the drop has
   * to happen before `evolve`, not inside it).
   */
  | { type: 'WindowShown'; id: WindowId; opSeq?: number }
  | { type: 'WindowHidden'; id: WindowId; opSeq?: number }
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
   * windows (`isAppResignSweepEligible` — every floater above the regular
   * stack that does not already close itself on blur) and marks them
   * `hiddenByAppBlur`. Never writes `key`, never reorders `order`.
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
   * A window's click-through state changed AFTER registration — the report
   * that closes the gap `izui-roles.ts deriveAcceptsInput` names in its own
   * doc: "A window whose click-through changes after registration needs an
   * event, not a re-derivation." Drives no effect of its own: it is a report
   * ABOUT the OS, not a request OF it, same as `ContentFirstResponderChanged`
   * above. A report naming an unregistered window is a no-op, like every
   * other dangling-id event here.
   *
   * NOW REACHED THROUGH THE `SetAcceptsInput` COMMAND for every production
   * site: `tile-ipc.ts`'s `tile:window:set-ignore-mouse` handler (the Space
   * border's, `features/spaces/background.js showBorder`, route to it) and
   * `hybrid-overlay.ts`'s `wireClickCapture`/`wireAppActiveGate` used to
   * dispatch this event directly, at the moment each made the native change
   * — Electron has no getter for `setIgnoreMouseEvents` (the same reason
   * `hybrid-overlay.ts` keeps its own `lastCaptureState` mirror rather than
   * asking the OS), so there was no native echo to await. They now issue the
   * command instead and let `decide` produce this same event, so today NO
   * production site feeds it directly. The shape stays: a backend that COULD
   * observe an externally-caused click-through change (one this machine never
   * asked for) still has this event to report it through, unlike
   * `WindowContentOrderable` above's genuinely-still-fed "no query exists"
   * compromise.
   */
  | { type: 'WindowAcceptsInputChanged'; id: WindowId; acceptsInput: boolean }
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
   *
   * `overlayFrame` is the freshly expanded overlay frame for THIS window,
   * when it is hosting the shared chrome overlay — ported from
   * `window-state.ts BOUNDS_CHANGED.overlayFrame`. Computed at the dispatch
   * site the same way `AttachOverlay.frame` is (see
   * `WindowRecord.overlayFrame`'s doc for why): the backend already computes
   * it for every page-host's bounds report and only needs to stop dropping
   * it at the kernel's edge (`window-kernel-dispatch.ts
   * kernelBoundsChanged`). Absent when this window has no overlay
   * attached, or the dispatch site could not read a work area — `evolve`
   * treats an absent frame as "nothing new to reframe to", same as
   * `AttachOverlay` with no `frame`.
   */
  | { type: 'BoundsChanged'; id: WindowId; bounds: Rectangle; overlayFrame?: Rectangle }
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
   * pattern as `FullscreenTransitionStarted.preBounds`. Carries no bounds of
   * its own: when the accepted command carried a `workArea`, `decide` pairs
   * this with a `BoundsChanged` event carrying it — that is what actually
   * snaps the window. Absent, nothing moves.
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
  /** `decide`'s translation of an accepted `SetDesktopMembership` command. */
  | { type: 'DesktopMembershipSet'; id: WindowId; membership: DesktopMembership }
  /**
   * `decide`'s translation of an accepted `AttachOverlay` command — attach,
   * retarget, and detach are all this ONE event (`hostId: null` = detach).
   * As an event, it is a fact already decided elsewhere and can never be
   * rejected here: `evolve` normalizes a `hostId` that isn't registered, or
   * that names the overlay itself, into a detach rather than storing it —
   * see `evolve`'s `OverlayAttached` case. The follow (reveal, hide, reframe)
   * is decided IN `evolve`, from the host's CURRENT `fsMode` and
   * `state.appActive` — never a live query at some later point, and never a
   * branch `react` has to make: `evolve` writes the result onto the overlay's
   * `visible`/`overlayFrame` fields, and `react` only diffs them.
   *
   * `frame` is the freshly expanded overlay frame for the NEW host, computed
   * at the dispatch site the same way `BoundsChanged.overlayFrame` is (see
   * `WindowRecord.overlayFrame`'s doc) — ported from `window-state.ts
   * OVERLAY_ATTACH_REQUESTED.frame`. Absent on a detach, or when the
   * dispatch site could not read the host's bounds between the retarget
   * signal and this call.
   */
  | { type: 'OverlayAttached'; overlayId: WindowId; hostId: WindowId | null; frame?: Rectangle }
  /**
   * A persisted bottom -> top stack order was imported (`decide`'s translation
   * of `ImportStackOrder`; ported from `window-state.ts
   * STACK_ORDER_IMPORTED`). A PERMUTATION of `order` and nothing else:
   * membership cannot change, `key` is untouched (RULE 2), no record field
   * moves.
   *
   * The payload is advisory, not authoritative. Ids it names that are not
   * registered are ignored and duplicates collapse to their first occurrence —
   * both are ordinary traffic, because `session.ts restoreSessionSnapshot`
   * assembles the list through `getWindowIdFor` over windows that may have died
   * mid-restore.
   */
  | { type: 'StackOrderImported'; order: readonly WindowId[] }
  /**
   * TEARDOWN (§0.1.5) — the four facts below are `decide`'s translations of
   * the teardown commands, and they share one shape: each records that a
   * teardown was asked for (`State.lastTeardown`) and changes NOTHING else.
   * Membership shrinks on `WindowClosed` alone (RULE 1), which arrives later
   * as the native report the teardown causes; a teardown fact that also
   * retired the record would make the kernel a second authority over `order`
   * and would double-count the close.
   *
   * All four are legitimate for a window absent from `order`: see the
   * commands' own doc for why (`ipc.ts runHybridFinalize` names a record
   * retired microseconds earlier, in the same synchronous body).
   *
   * Forceful native destroy — the extension-bridge / UI-teardown path. Skips
   * beforeunload and close events entirely, and has NO guest pass, so it is
   * never the right teardown for a window that owns page-host guests (peek
   * `d1cf0b9a`: a guest dereferenced inside `-[NSWindow __close]`).
   */
  | { type: 'WindowDestroyRequested'; id: WindowId }
  /**
   * The window's CONTENT surface torn down (the hybrid finalize's
   * `contentWC.close()`) — the bounded-timeout fallback, see the
   * `CloseContent` command.
   */
  | { type: 'WindowContentCloseRequested'; id: WindowId }
  /** The guest-safe direct close — destroy registered guests, await them, then close the host. No keepLive policy. */
  | { type: 'WindowDirectCloseRequested'; id: WindowId }
  /** Quit teardown: destroy every registered page-host guest WC, process-wide. Names no window. */
  | { type: 'GuestTeardownRequested' }
  /**
   * `decide`'s translation of an accepted `AssertFocus` command: a request to
   * re-drive the raise onto a window that is ALREADY where the machine wants
   * it (see `State.lastFocusAssert`). Records the request on that field and
   * changes nothing else about the window model — `key` is untouched (RULE 2
   * leaves it to `OsFocusGained`/`OsFocusLost`), `order` is untouched (RULE 1),
   * and no record field moves except the focus-op stamp the raise it drives
   * carries.
   */
  | { type: 'FocusAssertRequested'; id: WindowId }
  /**
   * The cold-start focus latch was armed (ported from `window-state.ts
   * COLD_START_FOCUS_ARMED`) — `decide`'s translation of `ArmColdStartFocus`.
   * Writes `State.pendingColdStartFocus` and NOTHING else: not `key` (RULE 2 —
   * arming is not a focus report), not `order` (RULE 1), no record field.
   *
   * `id: null` is a real payload — it CLEARS the latch — and not a missing one;
   * see the field's own doc for the restore pass that arms both a `null` and a
   * real id.
   *
   * Drives no effect, and no rule in `react` exists to make that so: `react` is
   * a pure structural diff and nothing in it reads `pendingColdStartFocus`, so
   * a transition that changes only this field projects to nothing.
   */
  | { type: 'ColdStartFocusArmed'; id: WindowId | null }
  /**
   * A switcher selection was armed — or cleared — `decide`'s translation of
   * `ArmSelectionFocus` (see `State.pendingSelectionFocus`). Writes that field
   * and NOTHING else: not `key` (RULE 2 — arming is not a focus report), not
   * `order` (RULE 1), no record field. `target: null` is a real payload, the
   * clear.
   *
   * Drives no effect of its own, and no rule in `react` exists to make that
   * so: `react` is a pure structural diff and nothing in it reads
   * `pendingSelectionFocus`, so a transition changing only this field projects
   * to nothing. The effect comes later, when `WindowClosed` spends the latch
   * onto `lastFocusAssert`.
   */
  | { type: 'SelectionFocusArmed'; armer: WindowId; target: WindowId | null };

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
      /**
       * The window's construction-time rect, computed at the dispatch site
       * (this file keeps zero value imports) — seeds `WindowRecord.bounds`
       * so a window maximized before its first native resize/move has
       * something to restore to (see `WindowRecord.bounds`'s doc for why
       * that mirror is otherwise empty until the first gesture). Optional
       * for the same reason `AttachOverlay.frame` is: a caller with nothing
       * to seed just registers without it.
       */
      bounds?: Rectangle;
      /** See `WindowRecord.tracksBaseLayerTop` — declared here, nothing reads it yet. */
      tracksBaseLayerTop?: boolean;
      /** See `WindowRecord.selfClosesOnBlur`'s doc — declared here. */
      selfClosesOnBlur?: boolean;
      /** See `WindowRecord.appLifetime`'s doc — declared here. */
      appLifetime?: boolean;
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
   * call. `workArea` is the target rect: a `screen` work-area read is
   * platform data this zero-value-import file cannot obtain itself, so it
   * rides the command as data, computed at the dispatch site the same way
   * `AttachOverlay.frame` is (see `WindowRecord.overlayFrame`'s doc for why
   * — the `459ed219` shape). Optional for the same reason `AttachOverlay
   * .frame` is: `decide` just skips the paired `BoundsChanged` when it is
   * absent (a flag flip with nothing to snap to, rather than a rejection) —
   * every production dispatch site (`ipc.ts page:maximize`, `tile-ipc.ts
   * tile:window:maximize`) always supplies it. No-op while `fsMode` is
   * non-normal (the aa34cb50 family) or while already maximized (nothing
   * new to snap to).
   */
  | { type: 'Maximize'; id: WindowId; workArea?: Rectangle; expectedVersion: number }
  /**
   * A window was CONSTRUCTED already maximized — reopen-last-closed and
   * session restore build it at the saved maximized rect — and the record
   * needs seeding to match (ported from `window-state.ts
   * MAXIMIZE_RESTORED`). Distinct from `Maximize`, and the distinction is
   * load-bearing rather than cosmetic: `Maximize` derives the stash from
   * `rec.bounds`, but at construction time those bounds ALREADY ARE the
   * maximized rect, so replaying `Maximize` here would stash the maximized
   * rect as the thing to unmaximize back to. Hence the EXPLICIT
   * `preMaxBounds`, carried from the saved session data by the caller — the
   * same distinction `MAXIMIZE_RESTORED` drew from `MAXIMIZE_REQUESTED`.
   *
   * Seed only: no paired `BoundsChanged`, because the window is already at
   * the rect a snap would write. `null` is a legitimate value — a window
   * saved maximized with no restorable rect behind it. No-op while `fsMode`
   * is non-normal (the aa34cb50 family, same guard as `Maximize`); NOT
   * guarded on `rec.maximized`, since re-seeding an already-maximized record
   * with an explicit stash is the point of the command rather than a
   * redundant re-snap.
   */
  | { type: 'SeedMaximized'; id: WindowId; preMaxBounds: Rectangle | null; expectedVersion: number }
  /**
   * App code wants this window restored from maximized (ported from
   * `window-state.ts UNMAXIMIZE_REQUESTED`): clears `maximized`, restores
   * `preMaxBounds` when a stash exists. No-op when not maximized.
   */
  | { type: 'Unmaximize'; id: WindowId; expectedVersion: number }
  /**
   * App code wants this window to belong to a particular set of desktops
   * (see `DesktopMembership`) — ported from `window-state.ts`'s pair of
   * events over the same OS-level fact, `SET_VISIBLE_ON_ALL_SPACES_REQUESTED`
   * (raw path) and `SPACES_POLICY_REQUESTED` (role-derived), collapsed into
   * one command because the kernel only ever needs the resolved intention:
   * WHICH of `'follow'`/`'anchor'` a given role wants, and WHETHER/HOW a
   * given backend realizes either one, both stay outside the kernel — the
   * former decided by the caller composing this command (the role-derivation
   * the old `SPACES_POLICY_REQUESTED` did inline), the latter entirely the
   * backend's business (`window-backend.ts setDesktopMembership`).
   */
  | { type: 'SetDesktopMembership'; id: WindowId; membership: DesktopMembership; expectedVersion: number }
  /**
   * App code wants this window's click-through state changed (see
   * `WindowRecord.acceptsInput`) — the REQUEST counterpart to the report-only
   * `WindowAcceptsInputChanged` event: this is the machine deciding to make
   * the change happen, as opposed to a fact fed in from a site that already
   * made it happen natively (the Space border's separate IPC round trip — see
   * that event's doc for why that case has no command to go through).
   * `decide`'s arm is unconditional, always emitting
   * `WindowAcceptsInputChanged{acceptsInput: cmd.acceptsInput}` — the SAME
   * event, reused rather than inventing a second acceptsInput-writing fact,
   * the same reuse `SetBounds`/`Maximize`/`Unmaximize` make of `BoundsChanged`.
   */
  | { type: 'SetAcceptsInput'; id: WindowId; acceptsInput: boolean; expectedVersion: number }
  /**
   * Attach, retarget, or detach the shared chrome overlay — `hostId: null`
   * is detach. One transition, no separate detach command (see the doc on
   * `WindowRecord.overlayFor`). `decide` rejects if either named window is
   * absent from `order`.
   *
   * `frame` carries the newly expanded overlay frame for `hostId`, computed
   * at the caller's dispatch site — see `WindowRecord.overlayFrame`'s doc for
   * why the kernel takes this as data rather than computing it. Meaningless
   * on a detach (`hostId: null`), and safely ignored there.
   */
  | { type: 'AttachOverlay'; overlayId: WindowId; hostId: WindowId | null; frame?: Rectangle; expectedVersion: number }
  /**
   * Restore a persisted bottom -> top stack order (ported from
   * `window-state.ts STACK_ORDER_IMPORTED`) — the session-restore ordering
   * pass. Carries no `id`, so `decide` answers it before the generic
   * unknown-window guard, the same structural reason `RegisterWindow` and
   * `AttachOverlay` are answered early.
   *
   * UNKNOWN IDS ARE NOT REJECTED, deliberately. `session.ts
   * restoreSessionSnapshot` assembles this payload through `getWindowIdFor`
   * over windows that may have died mid-restore, so an id naming nothing is
   * expected traffic, not caller error; it is silently inert. Duplicates
   * collapse to their first occurrence for the same reason.
   *
   * Never activates anything: the import writes `order` and `order` only, and
   * `react`'s raise rule is based on `key`, which no permutation touches.
   */
  | { type: 'ImportStackOrder'; order: readonly WindowId[]; expectedVersion: number }
  /**
   * TEARDOWN (§0.1.5) — the four commands below are the ONLY way a teardown
   * enters the kernel, and they share one property that the rest of this union
   * does not: **they are exempt from `decide`'s unknown-window rejection.**
   *
   * That exemption is required, not a convenience. `ipc.ts runHybridFinalize`
   * dispatches a content-close naming a window that `finalizeWindowClose`
   * retired microseconds earlier, in the same synchronous body — on every
   * hybrid close; the opener-initiated path has the same shape, its
   * `hostMachineId` being a captured constant that is never re-resolved. The
   * old machine accepted this deliberately (`window-state.ts`, pinned by
   * `window-state.test.ts` "even after the record retired"), and the port must
   * too: rejecting would silently drop every hybrid content-WC teardown. The
   * port resolves the native handle itself and no-ops when it is already gone,
   * which is what makes accepting a dangling id safe.
   *
   * Forceful native destroy (extension bridge / UI teardown). NEVER for a
   * window that owns page-host guests — it has no guest pass; `CloseWindowDirect`
   * is the teardown that does (peek `d1cf0b9a`).
   */
  | { type: 'DestroyWindow'; id: WindowId; expectedVersion: number }
  /**
   * Tear down the window's CONTENT surface (the hybrid finalize's
   * `contentWC.close()`).
   *
   * A BOUNDED-TIMEOUT FALLBACK, not the ordinary quit path. Since
   * `electron-window-backend.ts destroyAllContentGuests` awaits
   * `guest-teardown.ts destroyGuestsAndWait` and `entry.ts runBeforeQuitCleanup`
   * awaits that before the re-quit, no ordinary path reaches this with a live
   * WebContents: both interactive closes no-op (the guest pass already
   * destroyed the WC, and finalize is triggered BY that WC's `'destroyed'`
   * event), and quit no-ops too — measured over six restored page hosts, zero
   * real `wc.close()` calls. The one case that still delivers a live
   * WebContents is a wedged guest outliving `QUIT_GUEST_TEARDOWN_BUDGET_MS`,
   * where quit proceeds by design.
   */
  | { type: 'CloseContent'; id: WindowId; expectedVersion: number }
  /**
   * The guest-safe direct close (the absorbed `windows.ts closeHostWindow`
   * path): the port destroys and AWAITS the window's registered guests, then
   * closes the host. No keepLive policy — the caller's intent is close.
   *
   * Distinct from `CloseOrHideWindow` in origin, not in realization: that one
   * resolves keepLive and retires the record, and its `CloseWindow` effect is
   * derived from the resulting membership diff. This one asserts nothing about
   * membership; the record retires when the native close reports back.
   */
  | { type: 'CloseWindowDirect'; id: WindowId; expectedVersion: number }
  /**
   * Quit teardown: destroy every registered page-host guest WebContents before
   * native quit closes their hosts (peek `d1cf0b9a`).
   *
   * NAMES NO WINDOW, and must not be reshaped into one that does. The port's
   * `destroyAllContentGuests` iterates the process-wide guest map; a caller-side
   * fan-out over `order` would miss every guest whose host record has already
   * retired — which at quit is the common case, not the corner one.
   */
  | { type: 'DestroyAllGuests'; expectedVersion: number }
  /**
   * RE-ASSERT THE RAISE on a window that is already front — the port of the
   * old machine's shared `DEVTOOLS_OPENED`/`DEVTOOLS_CLOSED` arm (see
   * `State.lastFocusAssert` for why the app needs it at all).
   *
   * NOT exempt from the unknown-window rejection, unlike the four teardown
   * commands above. Their exemption exists for one measured race — `ipc.ts
   * runHybridFinalize` naming a record retired microseconds earlier in the
   * same synchronous body — and this command has no such producer: its caller
   * picks the target by READING the current state (`topmost(state,
   * isContentWindow)`), so a target absent from `order` means the caller asked
   * about a window that does not exist, which is precisely what the guard is
   * for.
   *
   * A target that is not `isContentWindow` is accepted and does nothing (no
   * events) — the port of `applyRaiseRequest`'s `isEligibleFront(rec)` early
   * return, and the reason it must not be a raise: driving an activating show
   * onto a window the user is not working in steals key onto a background
   * surface.
   *
   * TWO CONDITIONS THE CALLER OWNS, both of them guards the old
   * `applyRaiseRequest` held itself:
   *
   *   - `state.appActive` — no focus theft while Peek is in the background.
   *     The kernel HAS this fact, so the guard could live here; it does not,
   *     because it belongs with the switcher condition below rather than being
   *     split across two layers, and a caller that assembles the request
   *     already knows whether the app is active.
   *   - the switcher is not open — must not yank key out of the switcher
   *     overlay. This one CANNOT live here: the switcher is homed outside the
   *     kernel (§0: input interpretation and the surfaces built on it are not
   *     the window manager's business), and inventing a kernel switcher
   *     concept to hold one guard would put a second model of that surface in
   *     the machine.
   *
   * So the composition at the call site is: app active, switcher closed, and a
   * target of `topmost(state, isContentWindow)`.
   */
  | { type: 'AssertFocus'; id: WindowId; expectedVersion: number }
  /**
   * Arm — or clear — the cold-start focus latch (see
   * `State.pendingColdStartFocus`). `id: null` is the clear, and the restore
   * pass issues both forms.
   *
   * Answered BEFORE the generic unknown-`cmd.id` guard, exactly as
   * `ImportStackOrder` above is, and for the same structural reason: there is
   * no window here to guard existence against. The stale-version guard is the
   * only one it carries.
   *
   * That is not merely an unnecessary guard but a wrong one, on both payload
   * shapes. `null` names nothing at all, so an existence check would reject
   * every clear. And a non-null id is a NOTE to be read at some later
   * activation rather than a window to act on now — whether it is still live is
   * a question for the moment the latch is spent, not for this one, so arming
   * before the named window is registered is legitimate traffic.
   */
  | { type: 'ArmColdStartFocus'; id: WindowId | null; expectedVersion: number }
  /**
   * Arm — or clear — a switcher selection (see `State.pendingSelectionFocus`).
   * `target: null` is the clear.
   *
   * Answered BEFORE the generic unknown-`cmd.id` guard, for the same
   * structural reason `ArmColdStartFocus` is: this command carries no `id`
   * field for that guard to read. It carries its own existence check instead,
   * on the ARMER only — arming a rule about a switcher that is not registered
   * would leave a latch nothing can ever spend, because only that window's
   * `WindowClosed` spends it.
   *
   * The TARGET is deliberately unchecked. It is a note to be read when the
   * switcher closes, and whether it is still live is a question for that
   * moment, not this one — the same reasoning `ArmColdStartFocus` gives for
   * its own id.
   */
  | { type: 'ArmSelectionFocus'; armer: WindowId; target: WindowId | null; expectedVersion: number };

export type Rejection = 'stale-version' | 'no-such-window' | 'app-lifetime-window';

// ─────────────────────────────────────────────────────────────────────────────
// Effects — described by `decide`'s future effect-emitting counterpart (not
// built in this slice), executed by an OS adapter. Focus-family effects
// (`ShowWindow`, `RaiseWindow` — the two that can make the OS move focus, same
// split as `window-state.ts`'s `OpToken`) carry `opSeq` for focus provenance;
// `SetStacking` carries none (a reorder has no echo to disambiguate).
// `HideWindow` carries `opSeq` too, but for a NARROWER reason than the
// focus-family pair: it never moves focus, but its confirming `WindowHidden`
// echo needs the same op token `ShowWindow`'s `WindowShown` echo carries, so
// the executor can tell a hide's own stale echo apart from a show that has
// since superseded it — see `isStaleWindowEcho`.
// ─────────────────────────────────────────────────────────────────────────────

export type Effect =
  | { type: 'SetStacking'; id: WindowId; layer: number }
  | { type: 'ShowWindow'; id: WindowId; opSeq: number }
  | { type: 'HideWindow'; id: WindowId; opSeq: number }
  /** Drive the OS to close the window (dismiss the non-keepLive branch of `CloseOrHideWindow`) — visibility-only, same as `HideWindow`, carries no `opSeq`. */
  | { type: 'CloseWindow'; id: WindowId }
  /**
   * Dismiss a transient sibling the transient-autoclose sweep named
   * (`selectTransientAutoclose`, emitted by `react` off two structural diffs
   * — `State.lastAttention`'s `seq` diff for a focus report, and the
   * `pendingAppResignSweep`/`appActive` diff for an app-resign settle) —
   * DISTINCT from `CloseWindow` above,
   * and deliberately not reused as one. `CloseWindow` is realized as a hard
   * `backend.closeWindow`, which has no keepLive branch and no
   * exit-native-fullscreen preamble; the old machine's equivalent sweep
   * (`window-state.ts pushCloseOrHide`) deliberately pushed an unconditional
   * `CLOSE_WINDOW` that routed through `backend.closeOrHide` ->
   * `windows.ts closeOrHideWindow`, so a dismissed `keepLive` slide is hidden
   * rather than destroyed and a dismissed fullscreen victim exits fullscreen
   * before it is hidden or closed — a raw close/hide would strand a black
   * macOS Space. This effect is the port of that same unconditional call, and
   * the keepLive/fullscreen resolution stays downstream of it, not here.
   */
  | { type: 'DismissWindow'; id: WindowId }
  | { type: 'RaiseWindow'; id: WindowId; opSeq: number }
  /** Drive the OS into fullscreen — emitted only when a record freshly transitions INTO `entering`. */
  | { type: 'SetFullscreen'; id: WindowId }
  /** Drive the OS out of fullscreen — emitted only when a record freshly transitions INTO `leaving`. */
  | { type: 'ExitFullscreen'; id: WindowId }
  /**
   * Drive the port's one sanctioned native `isFullScreen()` read (§0.1.8: the
   * machine no longer trusts its own `fsMode` for this window). Its answer
   * comes back as an ordinary `OsFullscreenEntered`/`OsFullscreenLeft` event —
   * command in, event out, same as every other OS truth — rather than being
   * decided here.
   */
  | { type: 'ReconcileFullscreen'; id: WindowId }
  /** Move the window's outer bounds — emitted by `react` as a structural diff of `bounds`, never from an event's own payload. */
  | { type: 'SetBounds'; id: WindowId; bounds: Rectangle }
  /**
   * Realize the window's desktop membership (see `DesktopMembership`) —
   * emitted by `react` as a structural diff of `desktopMembership`. How many
   * native calls that takes on a given platform — including zero — is the
   * backend's decision, never this kernel's.
   */
  | { type: 'SetDesktopMembership'; id: WindowId; membership: DesktopMembership }
  /**
   * Realize the window's click-through state (see `WindowRecord.acceptsInput`)
   * — emitted by `react` as a structural diff of `acceptsInput`, same pattern
   * as `SetBounds`/`SetDesktopMembership` above. Fires regardless of whether
   * the transition came from the `SetAcceptsInput` command or from a genuine
   * externally-caused `WindowAcceptsInputChanged` report — same accepted echo
   * the bounds family's `SetBounds` effect above already lives with.
   */
  | { type: 'SetAcceptsInput'; id: WindowId; acceptsInput: boolean }
  /**
   * TEARDOWN (§0.1.5) — the four below are emitted by `react` as a structural
   * diff of `State.lastTeardown`, one per teardown transition, and each may
   * name a window that is NOT in `order` (the commands' exemption; see them
   * for why). The port resolves the handle and no-ops when it is gone.
   *
   * Forceful native destroy — no guest pass, no beforeunload.
   */
  | { type: 'DestroyWindow'; id: WindowId }
  /** Tear down the window's content surface — the wedged-guest fallback (see the `CloseContent` command). */
  | { type: 'CloseContent'; id: WindowId }
  /** Guest-safe direct close: destroy and await the window's guests, then close the host. */
  | { type: 'CloseWindowDirect'; id: WindowId }
  /** Destroy every registered page-host guest WebContents, process-wide. The one effect that names no window. */
  | { type: 'DestroyAllGuests' }
  /**
   * Put the app out of the way, handing the user back to whatever they were in
   * before — issued when the last window that was keeping Peek on screen goes
   * away (see `react`'s rule and `holdsAppOnScreen`). Names no window, like
   * `DestroyAllGuests`, because it is about the app rather than any one
   * window; the backend's `hideApp` performs it.
   */
  | { type: 'HideApp' }
  /**
   * Make the window's CONTENT surface the OS first responder — the port of the
   * old `FOCUS_CONTENT` effect, and the half of a raise that an already-front
   * window still needs when something took first responder off it without
   * changing anything else (devtools opening with `activate: false`).
   *
   * Carries no `opSeq`, unlike the focus-family pair above. It never moves the
   * key window on its own, so there is no self-caused FOCUS report for a token
   * to disambiguate; the assert that emits it emits a `RaiseWindow` in the same
   * transition, and that one carries the token for both.
   */
  | { type: 'FocusContent'; id: WindowId }
  /**
   * THE FIRST EFFECT THAT NAMES A RELATION, not a per-window operation — every
   * other variant above says "do this to window `id`"; this one says "this
   * overlay's host is now this window". Emitted by `react` as a diff of
   * `topmostBaseLayerPageHost` across the transition (see that rule, placed
   * first in `react`) — never a per-window state field on the overlay's own
   * record.
   *
   * CARRIES NO FRAME. The frame needs a work-area read
   * (`overlay-frame.ts expandToOverlayFrame` + the nearest display's work
   * area), which this zero-value-import file cannot perform — the backend
   * computes it and reports it back as an `OverlayAttached` event, the same
   * one-hop-later shape every other OS-observed fact already takes here.
   * `hostId: null` means detach.
   *
   * A REQUEST THE OUTSIDE MAY DECLINE, not an assertion the kernel enforces:
   * `docs/design/window-manager.md` forbids a kernel invariant that makes
   * attachment agree with stacking order, so this effect asks and the stored
   * `overlayFor` relation is written only by the backend's report, one hop
   * later, whatever it turns out to be.
   */
  | { type: 'AttachOverlayTo'; overlayId: WindowId; hostId: WindowId | null };

// ─────────────────────────────────────────────────────────────────────────────
// initialState
// ─────────────────────────────────────────────────────────────────────────────

export function initialState(): State {
  return {
    order: [],
    key: null,
    version: 0,
    opSeqCounter: 0,
    // Launching an app activates it — that is true of every platform this
    // targets, so it is the honest belief to start from rather than an
    // invented event. The alternative, starting inactive and waiting for the
    // first activation report, is not merely conservative: a backend on a
    // platform that reports no activation edges at all leaves the machine
    // believing forever that Peek is in the background, which suppresses every
    // raise and keeps attached chrome off screen for the process lifetime. The
    // rule this fact serves — Peek does not reorder its own windows on its own
    // initiative while it is not the active app — is about what the app does
    // AFTER the user leaves it, and a just-launched app has not been left.
    appActive: true,
    openSeqCounter: 0,
    pendingAppResignSweep: false,
    lastTeardown: null,
    lastFocusAssert: null,
    lastAttention: null,
    pendingColdStartFocus: null,
    pendingSelectionFocus: null,
    // No windows yet, so no session — the first registration decides this.
    openedInBackground: false,
  };
}

/** The next `TeardownRequest.seq` — one per teardown event, monotone, never reused. */
function nextTeardownSeq(state: State): number {
  return (state.lastTeardown?.seq ?? 0) + 1;
}

/**
 * The next `Attention.seq` — one per `OsFocusGained`, its only writer,
 * monotone, never reused. Derived from state rather than a module counter,
 * same as `nextTeardownSeq`/`nextFocusAssertSeq`: a module counter would make
 * `evolve` read something other than its two arguments and would break replay
 * determinism.
 */
function nextAttentionSeq(state: State): number {
  return (state.lastAttention?.seq ?? 0) + 1;
}

/**
 * The next `FocusAssertRequest.seq` — one per focus-assert event, monotone,
 * never reused. Derived from state rather than from a module counter, same as
 * `nextTeardownSeq` above: a module counter would make `evolve` read something
 * other than its two arguments and would break replay determinism.
 */
function nextFocusAssertSeq(state: State): number {
  return (state.lastFocusAssert?.seq ?? 0) + 1;
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
 * Mark a still-in-flight mode `unverified` — the machine no longer trusts
 * this belief, see `FsMode`'s doc. A no-op (same reference back) on
 * `normal`/`fullscreen`, where the flag is unrepresentable, so a caller may
 * apply this unconditionally to every record without first testing `.name`.
 */
function markFsModeUnverified(mode: FsMode): FsMode {
  if (mode.name !== 'entering' && mode.name !== 'leaving') return mode;
  return { ...mode, unverified: true };
}

/** Whether a mode is a still-in-flight transition the machine has flagged unverified. */
function isFsModeUnverified(mode: FsMode): boolean {
  return (mode.name === 'entering' || mode.name === 'leaving') && mode.unverified === true;
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
// Overlay follow (§ WindowRecord.overlayFor/overlayFrame) — the decision half
// of `window-state.ts applyOverlayFollow`, ported WITHOUT its effects: it
// returns the record patch an evolve arm merges onto an attached overlay,
// rather than pushing effects itself (effects are `react`'s job, from the
// diff those patches leave behind). Shared by every evolve arm that can move
// an attached overlay's visibility or frame (`OverlayAttached`,
// `BoundsChanged`, `OsFullscreenEntered`, `OsFullscreenLeft`) so the rule —
// a non-normal host always hides; a normal host takes the given frame and
// reveals while the app is active — lives in exactly one place. Total and
// reads only the values it is given, same as every other evolve helper.
// ─────────────────────────────────────────────────────────────────────────────

/** The record patch `overlayFollowPatch` can produce — see that function. */
type OverlayFollowPatch = Partial<Pick<WindowRecord, 'overlayFrame' | 'visible' | 'hiddenByAppBlur'>>;

function overlayFollowPatch(overlay: WindowRecord, hostNormal: boolean, appActive: boolean, frame: Rectangle | undefined): OverlayFollowPatch {
  if (!hostNormal) {
    // Ported verbatim: a non-normal host hides and returns — no frame write,
    // even when one was given, and no reveal.
    return overlay.visible ? { visible: false } : {};
  }
  const patch: OverlayFollowPatch = {};
  if (frame !== undefined) patch.overlayFrame = frame;
  if (appActive && !overlay.visible) {
    patch.visible = true;
    // `hiddenByAppBlur` can never be true on a visible window (checked by
    // `window-kernel-properties.test.ts checkInvariants`) — cleared here the
    // same way `WindowShown`'s arm clears it on any genuine show.
    if (overlay.hiddenByAppBlur === true) patch.hiddenByAppBlur = false;
  }
  return patch;
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
          // A LIVED fact (§ WindowRecord.acceptsInput's doc), same shape as
          // `fsMode` below — never taken from a re-registration event.
          // `ipc.ts` re-registers windows routinely and recomputes
          // `deriveWindowSurface(...)` fresh from open params, which for the
          // Space border yields `acceptsInput: true` (its click-through is a
          // separate IPC call the re-derivation cannot see — see
          // `izui-roles.ts deriveAcceptsInput`'s doc); taking the event's
          // value here would silently undo the honest fact
          // `WindowAcceptsInputChanged` reported.
          acceptsInput: existing.acceptsInput,
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
          pendingProjectedBounds: existing.pendingProjectedBounds,
          // `bounds` is a LIVED fact once the OS has reported one, so a
          // re-registration must not clobber it — `ipc.ts`'s real-tile-launch
          // path registers each window twice, and a second registration
          // carrying stale construction-time bounds must not overwrite
          // geometry the OS has since reported. The event's `bounds` seed
          // only fills an EMPTY mirror, exactly like the fresh-record branch
          // below — never an already-lived one.
          ...(existing.bounds !== undefined ? { bounds: existing.bounds } : ev.bounds !== undefined ? { bounds: ev.bounds } : {}),
          // A lived fact (desktop membership), same reasoning as `overlayFor`
          // below — re-registration must not forget which desktops the
          // window was asked to belong to, and must not turn a real answer
          // back into "never asked" (see the field's own doc).
          ...(existing.desktopMembership !== undefined ? { desktopMembership: existing.desktopMembership } : {}),
          // A lived fact (attachment), same reasoning as `fsMode` above —
          // re-registration must not sever a live overlay attachment.
          ...(existing.overlayFor !== undefined ? { overlayFor: existing.overlayFor } : {}),
          // A lived fact (the frame the overlay was last asked to occupy),
          // same reasoning as `overlayFor` above — re-registration must not
          // un-frame an overlay that has already been placed. Judged
          // low-risk in practice (the shared overlay singleton is never
          // re-registered in production, only ever attached/retargeted), but
          // the merge must not decay it regardless — this is what the
          // property suite below checks for.
          ...(existing.overlayFrame !== undefined ? { overlayFrame: existing.overlayFrame } : {}),
          // A lived fact (focus provenance), same reasoning — re-registration
          // must not erase the newest op issued for this window.
          ...(existing.lastOpSeq !== undefined ? { lastOpSeq: existing.lastOpSeq } : {}),
          // A lived fact (app-resign sweep memory), same reasoning — a
          // re-registration mid-sweep must not lose the mark AppActivated
          // needs to know which windows to re-show.
          ...(existing.hiddenByAppBlur !== undefined ? { hiddenByAppBlur: existing.hiddenByAppBlur } : {}),
          // A lived fact (teardown-in-flight), same reasoning — a producer
          // re-announcing a window's declared properties (`ipc.ts` does this
          // routinely) knows nothing about an in-flight teardown, so it must
          // never be taken from the event.
          ...(existing.pendingHidden !== undefined ? { pendingHidden: existing.pendingHidden } : {}),
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
          ...(ev.parentId !== undefined
            ? { parentId: ev.parentId }
            : existing.parentId !== undefined
              ? { parentId: existing.parentId }
              : {}),
          ...(ev.keepLive !== undefined
            ? { keepLive: ev.keepLive }
            : existing.keepLive !== undefined
              ? { keepLive: existing.keepLive }
              : {}),
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
          // Intrinsic, same shape as `role`/`keepLive`/`escapeMode` above —
          // see `WindowRecord.tracksBaseLayerTop`'s doc: a DECLARED fact, so
          // an event that names it overwrites, and an event that omits it
          // keeps the existing value rather than erasing it.
          ...(ev.tracksBaseLayerTop !== undefined
            ? { tracksBaseLayerTop: ev.tracksBaseLayerTop }
            : existing.tracksBaseLayerTop !== undefined
              ? { tracksBaseLayerTop: existing.tracksBaseLayerTop }
              : {}),
          // Intrinsic, same shape as `role`/`keepLive`/`escapeMode`/
          // `tracksBaseLayerTop` above — see `WindowRecord.selfClosesOnBlur`'s
          // doc: a DECLARED fact, so an event that names it overwrites, and an
          // event that omits it keeps the existing value rather than erasing it.
          ...(ev.selfClosesOnBlur !== undefined
            ? { selfClosesOnBlur: ev.selfClosesOnBlur }
            : existing.selfClosesOnBlur !== undefined
              ? { selfClosesOnBlur: existing.selfClosesOnBlur }
              : {}),
          // Intrinsic, same shape as `role`/`keepLive`/`escapeMode`/
          // `tracksBaseLayerTop`/`selfClosesOnBlur` above — see
          // `WindowRecord.appLifetime`'s doc: a DECLARED fact, so an event
          // that names it overwrites, and an event that omits it keeps the
          // existing value rather than erasing it.
          ...(ev.appLifetime !== undefined
            ? { appLifetime: ev.appLifetime }
            : existing.appLifetime !== undefined
              ? { appLifetime: existing.appLifetime }
              : {}),
        };
        // A REVERSIBLE HIDE MUST NEVER SURVIVE INTO A TRANSIENT IDENTITY IT
        // WOULD NOT HAVE BEEN GIVEN IN THE FIRST PLACE (same law as
        // `AppResigned`/`AppResignSettled`'s own fix — see those arms' doc —
        // reached here through a re-registration instead of a resign):
        // `hiddenByAppBlur` was preserved above as a lived fact from a
        // registration whose `role` may have been anything; if THIS merge is
        // what makes the record transient, `AppActivated` would later reveal
        // it rather than the machine ever dismissing it.
        //
        // `selectTransientAutoclose` cannot answer this: a hidden record is
        // invisible to its own `visible` clause, and `state.order` still holds
        // the PRE-merge record, so it would answer about the old identity.
        // What the law's EXEMPTIONS say is asked directly instead, of
        // `merged` — the post-merge identity — through the one predicate both
        // sweeps read, so this arm cannot drift from them.
        //
        // The arguments STATE the degenerate case rather than leaving it to
        // silent omission: `undefined` focuser, because a re-registration
        // names no focuser at all and so nothing can be spared by the
        // focuser-relation clause; `null` ordering floor, because with no
        // focuser there is no `openSeq` to be newer than. Candidacy is the
        // caller's to test, so it is tested here — via the same
        // `isTransientAutocloseCandidate` the other two readers use, not a
        // restated `roleIn` check.
        const strandedByRoleChange =
          merged.hiddenByAppBlur === true &&
          isTransientAutocloseCandidate(merged) &&
          transientAutocloseExemption(merged, undefined, null) === null;
        const mergedRecord = strandedByRoleChange ? { ...merged, hiddenByAppBlur: false } : merged;
        return {
          ...state,
          order: [...state.order.slice(0, existingIdx), mergedRecord, ...state.order.slice(existingIdx + 1)],
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
        // Seeded from the caller's construction-time rect when supplied (see
        // `RegisterWindow.bounds`'s doc) — the sole other writer of this
        // mirror is the backend's native resize/move echo, and a window
        // placed at construction fires neither until its first gesture.
        ...(ev.bounds !== undefined ? { bounds: ev.bounds } : {}),
        // Fresh geometry facts (this slice) — nothing is stashed, nothing
        // pinned, nothing held, regardless of whether `bounds` was seeded.
        maximized: false,
        preMaxBounds: null,
        // `desktopMembership` is deliberately NOT seeded — registration is
        // exactly the moment nobody has asked yet (see the field's doc),
        // same reasoning as `contentFocused` below.
        pendingProjectedBounds: null,
        ...(ev.role !== undefined ? { role: ev.role } : {}),
        ...(ev.parentId !== undefined ? { parentId: ev.parentId } : {}),
        ...(ev.keepLive !== undefined ? { keepLive: ev.keepLive } : {}),
        ...(ev.escapeMode !== undefined ? { escapeMode: ev.escapeMode } : {}),
        ...(ev.tracksBaseLayerTop !== undefined ? { tracksBaseLayerTop: ev.tracksBaseLayerTop } : {}),
        ...(ev.selfClosesOnBlur !== undefined ? { selfClosesOnBlur: ev.selfClosesOnBlur } : {}),
        ...(ev.appLifetime !== undefined ? { appLifetime: ev.appLifetime } : {}),
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
      // Whether Peek's windows came up while the user was in another app (see
      // `State.openedInBackground`) — transliterated from `izui-state.ts
      // evaluateOnShow`, which the app calls on exactly this edge: a window
      // opening. Registration is the kernel's own version of that edge, and a
      // window joining an EMPTY `order` is the coordinator's "no session yet".
      //
      // Two of the coordinator's three arms are here. The first window decides
      // the answer from `appActive`. A later window opening while the app is
      // active clears it — the ratchet, "the user has arrived in Peek". A later
      // window opening while the app is NOT active changes nothing, which is
      // the ratchet's one-way half: a session that became the user's does not
      // become incidental again. (`AppActivated` carries the same ratchet on
      // its own edge; emptying `order` is the reset.)
      const openedInBackground = state.order.length === 0
        ? !state.appActive
        : state.appActive
          ? false
          : state.openedInBackground;
      return {
        ...state,
        order: [...state.order.slice(0, insertAt), record, ...state.order.slice(insertAt)],
        openedInBackground,
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
          // Any `WindowShown` — not just the `AppActivated` re-show — makes
          // the window visible, so any stale sweep mark is cleared here too:
          // `hiddenByAppBlur` can never be true on a visible window (checked
          // by `window-kernel-properties.test.ts checkInvariants`). A window
          // that was never swept keeps the field absent rather than gaining
          // an explicit `false` it never earned.
          const flushed = withPendingProjectionFlushed({
            ...w,
            visible: true,
            ...(w.hiddenByAppBlur === true ? { hiddenByAppBlur: false } : {}),
            // Any genuine show clears a doomed mark too — the OS just put
            // this window back on screen, so whatever teardown asked for it
            // did not (yet) happen. See `WindowRecord.pendingHidden`'s doc.
            ...(w.pendingHidden === true ? { pendingHidden: false } : {}),
          });
          return w.visible ? flushed : { ...flushed, lastOpSeq: opSeq };
        }),
        opSeqCounter: opSeq,
        version: state.version + 1,
      };
    }

    case 'WindowHidden': {
      // Successor raise (ported from `window-state.ts`'s `WINDOW_HIDDEN` arm):
      // when the window going off screen is the one holding key, hiding it
      // must not leave nothing focused. `key` is deliberately left untouched —
      // RULE 2 reserves that write for `OsFocusGained`; the OS's echo of the
      // raise `react` emits is what will eventually write it. `order` is
      // deliberately NOT reordered: leaving the hidden record where it sits
      // keeps "key window is topmost" untouched (unlike the `WindowClosed`
      // parent-refocus arm, which removes a record and so has to reorder to
      // preserve that invariant) — and `isContentWindow` short-circuits on
      // `!visible`, so the successor query below already skips the record
      // being hidden without an explicit exclusion.
      //
      // GENUINE-HIDE ONLY: a duplicate hide (the backend echo plus the lagged
      // native event, see the "duplicate WindowHidden" test) must stay inert.
      // `hidesGenuinely` gates the whole rule on the record existing and
      // currently `visible === true`, mirroring the `issuesShow` gate
      // `WindowShown` uses above for the same reason.
      const target = state.order.find((w) => w.id === ev.id);
      const hidesGenuinely = target !== undefined && target.visible === true;
      // The confirming echo clears a doomed mark, genuine or not — this is
      // the report a teardown was waiting for. Written the same conditional
      // way `WindowShown`'s clear is, so a repeat pass (the mark already
      // `false`) touches nothing and stays byte-identical — see the pinned
      // duplicate-`WindowHidden` test.
      const order = state.order.map((w) =>
        w.id === ev.id ? { ...w, visible: false, ...(w.pendingHidden === true ? { pendingHidden: false } : {}) } : w,
      );
      const successor =
        hidesGenuinely && state.key === ev.id && state.appActive === true
          ? topmost({ ...state, order }, isContentWindow)
          : null;
      const opSeq = successor !== null ? state.opSeqCounter + 1 : state.opSeqCounter;
      return {
        ...state,
        order: successor !== null ? order.map((w) => (w.id === successor.id ? { ...w, lastOpSeq: opSeq } : w)) : order,
        opSeqCounter: opSeq,
        version: state.version + 1,
      };
    }

    case 'WindowClosed': {
      // RULE 1: removal is the only way membership shrinks. `key`, even if it
      // names this id, is left untouched — see `keyWindow` for why a dangling
      // key id is unobservable rather than repaired here. A record whose
      // `overlayFor` names the closed id is detached mechanically in the
      // same pass — an overlay must never keep pointing at a retired host —
      // and, when that record currently reads `visible: true`, this write
      // also clears it: any transition that detaches a visible overlay
      // writes the visibility fact itself, the same treatment the
      // `OverlayAttached` arm's own detach path gives it, rather than
      // leaving a stale `visible: true` for a queued sweep to act on before
      // the backend's native-hide echo can correct it. The detached record's
      // own `pendingHidden` is cleared in the SAME map for the same reason:
      // the overlay singleton is never itself the doomed window here (its
      // HOST is), so a stale mark left on it would exclude the shared chrome
      // overlay from `isBaseLayerPageHost`/`topmostBaseLayerPageHost` forever
      // — the original overlay-attach defect, inverted onto this field.
      const closedRec = state.order.find((w) => w.id === ev.id);
      const filtered = state.order
        .filter((w) => w.id !== ev.id)
        .map((w) =>
          w.overlayFor === ev.id
            ? {
                ...w,
                overlayFor: undefined,
                ...(w.visible ? { visible: false } : {}),
                ...(w.pendingHidden === true ? { pendingHidden: false } : {}),
              }
            : w,
        );
      // Parent refocus (ported from `window-state.ts`'s `WINDOW_CLOSED` arm —
      // the deleted `main.ts browser-window-created -> 'closed' ->
      // parentWin.focus()` block): a closing window whose parent is still
      // registered and eligible hands the raise to that parent, the same
      // `react` diffs into a `RaiseWindow` effect below. Eligibility is
      // `isContentWindow` — this kernel's nearest port of the old
      // `isEligibleFront` (`visible && !satellite`): both exclude a hidden
      // parent, and both admit an ordinary page/browser host, which is the
      // only shape the old test suite exercises this against.
      //
      // `key` is deliberately left untouched — RULE 2 reserves that write for
      // `OsFocusGained`; the OS's echo of the raise `react` emits is what
      // will eventually write it. The parent's `lastOpSeq` IS stamped
      // unconditionally here whenever the raise fires (matching `react`'s own
      // unconditional emission below), so `checkOpSeqInvariants`' biconditional
      // between a focus-family effect and the counter advancing always holds.
      //
      // Whether the parent is actually MOVED to the top of `order`, though, is
      // conditional — and that condition is the fix for a real violation of
      // §0.1.10's one-order rule (`window-kernel-properties.test.ts`
      // `checkInvariants`: whenever `key` resolves to a record, that record is
      // the topmost one). `key` can be untouched by this event and still name
      // a LIVE record other than the parent (the closed window need not have
      // held key itself — this handoff is unconditional on that, ported
      // verbatim from the old `parentWin.focus()` call). Moving the parent
      // above that record would put a non-key record on top while `key` names
      // someone else — the exact violation this scene proves
      // (`window-kernel.test.ts` "closing a background (non-key) child never
      // puts its parent above the record that actually holds key"). RULE 2
      // forbids fixing that by writing `key` here instead.
      //
      // So the reorder happens ONLY when the closed record itself held `key`:
      // in that case `key` still names the now-removed id, `keyWindow`
      // resolves it to null (unobservable, RULE 2), and moving the parent to
      // the top is exactly the case §0.1.6 cares about — without it, the
      // trailing `SetStacking` sweep (`react`, driven off `orderChanged`)
      // would re-stack straight over the parent's own raise, since it replays
      // `order` as-is. When some OTHER live record holds key, that race is
      // accepted rather than the invariant: the parent still gets raised (the
      // `RaiseWindow` effect below fires either way), and the real OS focus
      // change it causes is what the eventual `OsFocusGained` echo will
      // reconcile into `order` for real.
      const parent = closedRec?.parentId !== undefined ? filtered.find((w) => w.id === closedRec.parentId) : undefined;
      const raisesParent = parent !== undefined && isContentWindow(parent);
      // SPENDING THE SWITCHER SELECTION. `pendingSelectionFocus` names a
      // switcher and the window the user picked in it; this close is the spend
      // when it is that switcher going away (see the field's own doc). The
      // latch is one-shot — cleared below whether or not the target survives to
      // be raised — so a switcher that closes twice cannot restore focus twice,
      // and a later close of some unrelated window finds nothing armed.
      //
      // The raise goes through `lastFocusAssert`, exactly as `AppActivated`
      // spends the cold-start latch, and for the same reason: `react` is a pure
      // structural diff that may not branch on `ev.type`, so the request has to
      // become a fact it can diff. `react` emits its assert rule LAST, after
      // the parent-refocus raise this same arm may also drive — which is the
      // order the two want: an explicit selection is the user's own answer and
      // belongs on top of a structural parent handoff.
      //
      // The raise condition is `admitsFocusAssert` against the POST-REMOVAL
      // order, mirroring `react`'s assert rule exactly — the same reason
      // `FocusAssertRequested` mirrors it rather than settling for "present in
      // `order`". A target that closed while the switcher was open is simply
      // absent here, and the spend raises nothing.
      const spentSelection = state.pendingSelectionFocus?.armer === ev.id
        ? state.pendingSelectionFocus
        : null;
      const selectionTarget = spentSelection !== null
        ? filtered.find((w) => w.id === spentSelection.target && admitsFocusAssert(w, w.visible))
        : undefined;
      // ONE TOKEN FOR THE TRANSITION, not one per effect (see
      // `State.opSeqCounter`): this arm can now issue two focus-family ops —
      // the parent handoff and the selection raise — and `react` stamps both
      // with the same `next.opSeqCounter`. So the counter advances if EITHER
      // fires, and every record either op names is stamped with that one value,
      // which is what keeps `checkOpSeqInvariants`' biconditional true.
      const opSeq = raisesParent || selectionTarget !== undefined
        ? state.opSeqCounter + 1
        : state.opSeqCounter;
      const stamped = raisesParent ? { ...parent, lastOpSeq: opSeq } : undefined;
      const shouldReorder = raisesParent && closedRec?.id === state.key;
      const withParent = shouldReorder
        ? [...filtered.filter((w) => w.id !== stamped!.id), stamped!]
        : stamped !== undefined
          ? filtered.map((w) => (w.id === stamped.id ? stamped : w))
          : filtered;
      // The selection target is STAMPED but never reordered: `key` and the
      // stack position it implies are the OS echo's to write (RULE 2), the same
      // way every other raise in this kernel settles. Applied after the parent
      // map so a window that is both the parent and the selection target — the
      // user picking the closing switcher's own opener — is stamped once, with
      // the same token either way.
      const order = selectionTarget !== undefined
        ? withParent.map((w) => (w.id === selectionTarget.id ? { ...w, lastOpSeq: opSeq } : w))
        : withParent;
      return {
        ...state,
        order,
        opSeqCounter: opSeq,
        ...(spentSelection !== null
          ? {
              pendingSelectionFocus: null,
              lastFocusAssert: { id: spentSelection.target, seq: nextFocusAssertSeq(state) },
            }
          : {}),
        // The session ending (see `State.openedInBackground`): the coordinator
        // ends its session when its window stack empties, and an empty `order`
        // is that same fact. Resetting here rather than leaving the last value
        // to be read by the next session is the point — the next session gets
        // its answer from its own first window.
        ...(order.length === 0 ? { openedInBackground: false } : {}),
        version: state.version + 1,
      };
    }

    case 'OsFocusGained': {
      // RULE 2: `key` is a reported fact, written only here. A raise moves
      // the focused window to the top of `order` (§0.1.10 — one order, and a
      // window that was not focused does not go on top); a window not
      // currently registered still gets recorded as `key` (it will simply
      // resolve to null via `keyWindow`, same as any other dangling id).
      //
      // `lastAttention` is written alongside `key` in BOTH branches below,
      // unconditionally — the same total, guard-free shape `key` itself has.
      // It is not gated on `issuesRaise` the way `lastOpSeq` is: the old
      // machine ran its transient-autoclose sweep on EVERY `OS_FOCUS_GAINED`
      // report, including one that re-confirms the window already holding
      // key, so every report has to leave a fresh, distinct `seq` for `react`
      // to diff — see `State.lastAttention`. `holder` is `ev.id` as given,
      // even for a dangling id (mirroring `key` itself, RULE 2) — `react`'s
      // own guard is what declines to act on a holder absent from `order`.
      const attention: Attention = { holder: ev.id, cause: ev.cause ?? { kind: 'world' }, seq: nextAttentionSeq(state) };
      const idx = state.order.findIndex((w) => w.id === ev.id);
      if (idx === -1) {
        return { ...state, key: ev.id, lastAttention: attention, version: state.version + 1 };
      }
      const record = state.order[idx];
      const withoutRecord = [...state.order.slice(0, idx), ...state.order.slice(idx + 1)];
      // `lastOpSeq` is stamped only when this genuinely takes key — the same
      // condition `react` uses to emit `RaiseWindow`, mirrored here the way
      // `WindowShown`'s `issuesShow` and `FocusAssertRequested`'s own
      // `issuesRaise` are. A report re-confirming the window that already
      // holds key (the echo of the machine's own raise) asserts nothing,
      // stamps nothing, and issues no op, so the counter stays put.
      const issuesRaise = state.key !== ev.id;
      const opSeq = issuesRaise ? state.opSeqCounter + 1 : state.opSeqCounter;
      const movedRecord = issuesRaise ? { ...record, lastOpSeq: opSeq } : record;
      return {
        ...state,
        order: [...withoutRecord, movedRecord],
        key: ev.id,
        opSeqCounter: opSeq,
        lastAttention: attention,
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
      // ARMS the sweep — that half hides nothing yet. See
      // `pendingAppResignSweep`'s doc: this may be the resign half of a dance an
      // `AppActivated` is about to cancel, and DISMISSAL cannot be taken back.
      //
      // ATTACHED OVERLAYS AND SWEEP-ELIGIBLE FLOATERS HIDE HERE, ON THE RAW
      // EDGE, and that difference from the settled sweep is the rule rather
      // than an exception to it (`WindowRecord.hiddenByAppBlur` carries the
      // reasoning). Both share the one structural fact that puts them here:
      // `layer > BASE_LAYER` (an attached overlay is chrome drawn above its
      // host; `isAppResignSweepEligible` tests the same clause directly) means
      // a window sits above the regular stack, and above the regular stack
      // means above OTHER applications' windows too. Waiting out the settle
      // delay would leave it floating over the app the user just switched to
      // for the whole of it. The hide is reversible and `AppActivated`
      // reverses it, so the dance costs a flicker at worst where a dismissal
      // would cost a palette outright — the same trade `isAppResignSweepEligible`
      // already accepted for the HUD once the settle delay used to gate it too.
      //
      // ATTACHMENT AND `layer`, NEVER ROLE, select the victims. Attachment is
      // the same relation `selectTransientAutoclose` reads, and the reason
      // that query skips overlays outright: an attached overlay's visibility
      // belongs to its attachment, so it is driven here and never dismissed.
      // `isAppResignSweepEligible` layers on `!selfClosesOnBlur` for the same
      // reason (a window that already tears itself down on blur already owns
      // its own app-resign policy) — a defensive exclusion so this rule never
      // doubles up with that window's own handler, not the selector itself.
      // An already-hidden window of either kind is left alone, which is what
      // keeps a host in fullscreen (whose overlay the `OsFullscreenEntered`
      // evolve arm already drove off screen, via `overlayFollowPatch`) from
      // having its chrome revealed by the next activation.
      //
      // No `opSeq` is stamped, exactly as the `AppResignSettled` sweep stamps
      // none: `lastOpSeq` tracks focus-family ops and `HideWindow` carries no
      // token. Nothing here touches `key` or `order` (RULE 2).
      //
      // A REVERSIBLE HIDE MUST NEVER CLAIM A DISMISSAL VICTIM. `dismissVictims`
      // is exactly `selectTransientAutoclose`'s answer for this resign — there
      // is no focuser at an app resign, so `null` yields the law's three
      // exemptions with the focuser-relation clause vacuous (see that
      // function's doc). A transient this raw edge hid would read `!visible`
      // to `selectTransientAutoclose` at the settle and survive it; excluding
      // it here instead leaves it visible for the settle to dismiss.
      const dismissVictims = new Set(selectTransientAutoclose(state, null));
      const hidesImmediately = (w: WindowRecord): boolean =>
        !dismissVictims.has(w.id) && w.visible && (w.overlayFor !== undefined || isAppResignSweepEligible(w));
      const hidesSomething = state.order.some(hidesImmediately);
      return {
        ...state,
        appActive: false,
        pendingAppResignSweep: true,
        order: hidesSomething
          ? state.order.map((w) => (hidesImmediately(w) ? { ...w, visible: false, hiddenByAppBlur: true } : w))
          : state.order,
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
      const reshown = state.order.some((w) => appBlurRevealAdmits(state, w) && !w.visible);

      // SPENDING THE COLD-START FOCUS LATCH. `pendingColdStartFocus` names the
      // window a restore asked a later activation to put back in front (see
      // that field's doc for why the app needs it at all); this is the
      // activation, so the latch is spent here and cleared unconditionally —
      // one-shot, and only a fresh arm ever refills it.
      //
      // SPENT AS AN ASSERT FACT, NOT AS A MOVE IN `order`. The latch exists for
      // the case where the model ALREADY believes the armed window is on top
      // and only the OS disagrees: a trailing `did-resign-active` at cold start
      // leaves the app stranded behind the previous one while the window model
      // is entirely correct. Consuming the latch by moving the record to the
      // top of `order` would therefore diff to NOTHING in exactly the scenario
      // the latch was built for, and `react` could not rescue it — `react` may
      // not branch on `ev.type`, so it has nothing else to read. Writing
      // `lastFocusAssert` is the whole mechanism: it is a fact whose `seq`
      // makes a repeat visible even when the payload and the window model are
      // identical, which is what `react`'s assert rule diffs into a
      // `RaiseWindow` (plus `FocusContent` for a content window).
      //
      // ORDERING IS `react`'s, NOT THIS ARM'S. The assert rule is the LAST rule
      // in `react`, so the raise is emitted after this transition's re-show
      // work no matter where in this object the field is written — which is how
      // the old machine's ordering survives the port (it raised at the TAIL of
      // its `APP_ACTIVATED` arm, after the same re-show).
      //
      // `key` is NOT written (RULE 2): `front` is a pure projection of OS
      // focus, and the focus echo the raise itself provokes is what moves it.
      //
      // A latch naming a window absent from `order` needs no guard here, and
      // gets none — `evolve` is total. `react`'s assert rule is already gated
      // on the target being in `next.order`, so such a latch emits nothing and
      // is simply cleared; the old machine's consumption was a no-op in the
      // same case.
      const latched = state.pendingColdStartFocus;
      // Mirrors `react`'s emission exactly, the same way `FocusAssertRequested`
      // computes its own `issuesRaise`: a token is minted for a transition that
      // issues at least one op, and a latch that raises nothing issues none.
      //
      // THE VISIBILITY TESTED HERE IS POST-RE-SHOW, NOT `state`'s. `react` runs
      // its assert rule against `next`, i.e. AFTER this same transition's
      // re-show work below, so the latched window's visibility `react` sees is
      // what the re-show leaves it as — not what `state` (pre-transition)
      // still says. A latch naming a window this very activation is about to
      // re-show (`hiddenByAppBlur`, admitted by `appBlurRevealAdmits`) is
      // therefore raise-eligible even though `state` still has it hidden;
      // testing only `state`'s `visible` would silently disagree with `react`
      // and break the one-token-per-op invariant. `record.visible === true` is
      // the "already visible" case (the ordinary re-activation raise);
      // `appBlurRevealAdmits(state, record)` is the query the re-show map
      // below uses to decide `visible: true` — reused rather than restated so
      // the two can never drift apart.
      const latchedRecord = latched !== null ? state.order.find((w) => w.id === latched) : undefined;
      const assertsFocus =
        latchedRecord !== undefined &&
        admitsFocusAssert(latchedRecord, latchedRecord.visible === true || appBlurRevealAdmits(state, latchedRecord));

      // FULLSCREEN RECONCILE SWEEP (ported from `window-state.ts`'s
      // `APP_ACTIVATED` arm, which pushed one reconcile effect per in-flight
      // record from inside this same handler). macOS can enter or leave
      // fullscreen while Peek is backgrounded, so a transition still marked
      // `entering`/`leaving` here may have completed unobserved — every such
      // record is marked `unverified` (see `FsMode`'s doc) rather than
      // trusted as-is; `react`'s reconcile rule turns the mark into one
      // `ReconcileFullscreen` per record it newly sees.
      const opSeq = reshown || assertsFocus ? state.opSeqCounter + 1 : state.opSeqCounter;
      return {
        ...state,
        appActive: true,
        pendingAppResignSweep: false,
        order: state.order.map((w) => {
          const reshow = appBlurRevealAdmits(state, w);
          // One op means one token: a window both re-shown and raised carries
          // that single number once.
          const stamped = (reshow && !w.visible) || (assertsFocus && w.id === latched);
          const unverifiedMode = markFsModeUnverified(w.fsMode);
          if (!reshow && !stamped && unverifiedMode === w.fsMode) {
            return w;
          }
          return {
            ...w,
            ...(reshow ? { visible: true, hiddenByAppBlur: false } : {}),
            ...(stamped ? { lastOpSeq: opSeq } : {}),
            fsMode: unverifiedMode,
          };
        }),
        opSeqCounter: opSeq,
        pendingColdStartFocus: null,
        // The other half of the ratchet (see `State.openedInBackground`, and
        // the `WindowRegistered` arm that carries the first half): the user has
        // come to Peek, so whatever is on screen is somewhere they are now,
        // not something that appeared over what they were doing. Ported from
        // `izui-state.ts notifyAppActiveGained`, which promotes on this same
        // edge. Unconditional and one-way — nothing here can set it back.
        openedInBackground: false,
        // Untouched when no latch was held — an activation that was not asked
        // to re-raise anything must not bump the assert `seq`, or every app
        // activation would project to a spurious raise.
        lastFocusAssert:
          latched !== null ? { id: latched, seq: nextFocusAssertSeq(state) } : state.lastFocusAssert,
        version: state.version + 1,
      };
    }

    case 'AppResignSettled': {
      // Inert unless still armed — an AppActivated in between (the dance)
      // already disarmed this. When armed, the resign was real.
      //
      // THE SWEEP-ELIGIBLE HIDE ITSELF ALREADY RAN, on the raw `AppResigned`
      // edge above — see that arm's doc for why floaters moved there with the
      // attached overlays. Re-running `isAppResignSweepEligible` here is a
      // backstop, not the primary mechanism: it only catches a window that
      // BECAME sweep-eligible after the raw edge and before this settle (e.g.
      // one registered and shown while Peek was already backgrounded), which
      // the raw edge had no chance to see. For everything visible at the raw
      // edge this map is a no-op — already hidden, already excluded by its own
      // `visible` clause.
      if (!state.pendingAppResignSweep) {
        return { ...state, version: state.version + 1 };
      }
      // Defensive, ported from `window-state.ts`'s `APP_RESIGN_SETTLED` arm:
      // the app came back active without an `AppActivated` reaching the
      // machine. Belief-vs-reality here is `appActive`'s job, and a visible
      // surface must never be dismissed while the app is front — so this
      // settle still disarms and still runs the backstop hide above, but must
      // not let `react` treat attention as having left either. This arm never
      // touches `appActive` (RULE 2's sibling for this field), so `next.appActive`
      // below is exactly `state.appActive`, and `react`'s resign-sweep rule
      // reads `!next.appActive` off the very state this write produces — no
      // separate signal needed. `attentionLost` names that same test locally,
      // for `dismissVictims` below.
      const attentionLost = !state.appActive;
      // A REVERSIBLE HIDE MUST NEVER CLAIM A DISMISSAL VICTIM (see the
      // `AppResigned` arm's matching note). Computed only when `react`'s
      // resign-sweep rule will actually fire (`attentionLost`): a settle that
      // does not dismiss runs the backstop hide unfiltered, exactly as it does
      // today.
      const dismissVictims = attentionLost ? new Set(selectTransientAutoclose(state, null)) : null;
      return {
        ...state,
        pendingAppResignSweep: false,
        order: state.order.map((w) =>
          isAppResignSweepEligible(w) && !(dismissVictims?.has(w.id) ?? false)
            ? { ...w, visible: false, hiddenByAppBlur: true }
            : w,
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

    case 'WindowAcceptsInputChanged': {
      // Mechanical mirror write, total and guard-free: an unregistered id is
      // a harmless no-op, and `acceptsInput` is stored as reported — same
      // shape as `ContentFirstResponderChanged` above, and the sole
      // post-registration writer of the field (see `WindowRecord.acceptsInput`'s doc).
      return {
        ...state,
        order: state.order.map((w) => (w.id === ev.id ? { ...w, acceptsInput: ev.acceptsInput } : w)),
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
      // OVERLAY FOLLOW (ported from `window-state.ts applyOverlayFollow`'s
      // fullscreen branch): `nextFsModeForOsEntered` never settles a host
      // back to `normal` (every one of its arms lands on `entering`,
      // `leaving`, or `fullscreen` — see that function), so a host entering
      // fullscreen always takes its attached overlay off screen. No opSeq
      // stamp: a hide is never a focus-family effect.
      const overlay = overlayForHost(state, ev.id);
      const patch = overlay !== null ? overlayFollowPatch(overlay, false, state.appActive, undefined) : null;
      return {
        ...state,
        order: state.order.map((w) => {
          if (w.id === ev.id) return { ...w, fsMode: nextFsModeForOsEntered(w.fsMode) };
          if (patch !== null && overlay !== null && w.id === overlay.id) return { ...w, ...patch };
          return w;
        }),
        version: state.version + 1,
      };
    }

    case 'OsFullscreenLeft': {
      // Can newly clear the fsMode axis of a held DisplayChanged projection
      // (several of its arms settle onto 'normal') — flush if visible too.
      //
      // OVERLAY FOLLOW: the reverse of `OsFullscreenEntered` above — settling
      // back to `normal` re-reveals the attached overlay while the app is
      // active, at its LAST frame (no `frame` is given here, mirroring
      // `window-state.ts applyOverlayFollow`'s "never moved while hidden, so
      // no rect needed" case). `settlesNormal` reads the host's PRIOR
      // (`state`) record, since this arm computes the settle itself rather
      // than reading it back off `next` — `evolve` may read only its own two
      // arguments.
      const hostBefore = state.order.find((w) => w.id === ev.id);
      const settlesNormal = hostBefore !== undefined && nextFsModeForOsLeft(hostBefore.fsMode).name === 'normal';
      const overlay = overlayForHost(state, ev.id);
      const patch = overlay !== null ? overlayFollowPatch(overlay, settlesNormal, state.appActive, undefined) : null;
      const issuesShow = patch !== null && patch.visible === true;
      const opSeq = issuesShow ? state.opSeqCounter + 1 : state.opSeqCounter;
      return {
        ...state,
        order: state.order.map((w) => {
          if (w.id === ev.id) return withPendingProjectionFlushed({ ...w, fsMode: nextFsModeForOsLeft(w.fsMode) });
          if (patch !== null && overlay !== null && w.id === overlay.id) {
            return { ...w, ...patch, ...(issuesShow ? { lastOpSeq: opSeq } : {}) };
          }
          return w;
        }),
        opSeqCounter: opSeq,
        version: state.version + 1,
      };
    }

    case 'FullscreenSettleTimeout': {
      // Does NOT force-settle `fsMode` — the old machine's
      // `window-state.ts FULLSCREEN_SETTLE_TIMEOUT` arm never guessed either;
      // it only ever asked the OS and settled on whatever answer came back.
      // Force-settling here was a divergence introduced by this port, and a
      // wrong guess is not a harmless one: guessing `fullscreen` on a window
      // that is really `normal` strands its `preBounds`, and guessing
      // `normal` on a window that is really fullscreen leaves a black macOS
      // Space behind. So every record's `fsMode` is left exactly where it
      // was, and this becomes a REQUEST instead — the record is marked
      // `unverified` (see `FsMode`'s doc) for `react` to turn into a
      // `ReconcileFullscreen` effect — for a named record still genuinely in
      // flight (`entering`/`leaving`). A record that has already settled, or
      // that names nothing in `order`, has nothing to ask about: `order` is
      // left untouched, which diffs to no effect.
      const record = state.order.find((w) => w.id === ev.id);
      const inFlight = record !== undefined && (record.fsMode.name === 'entering' || record.fsMode.name === 'leaving');
      return {
        ...state,
        order: inFlight
          ? state.order.map((w) => (w.id === ev.id ? { ...w, fsMode: markFsModeUnverified(w.fsMode) } : w))
          : state.order,
        version: state.version + 1,
      };
    }

    // ── Geometry (this slice) ────────────────────────────────────────────────

    case 'BoundsChanged': {
      // The sole writer of `bounds` for a genuine OS report; also reused by
      // `decide`'s translation of SetBounds/Maximize/Unmaximize (see the
      // event doc). Mirror only — no other field, no effects computed here
      // (effects are `react`'s job, from the diff).
      //
      // OVERLAY FOLLOW (ported from `window-state.ts applyOverlayFollow`,
      // §5 step 9's "follow driven by boundsChanged"): the host's own bounds
      // write above is untouched by this — only its ATTACHED overlay (if
      // any) reframes, off `ev.overlayFrame` (the dispatch site's freshly
      // expanded frame, computed alongside the raw bounds — see the event's
      // own doc), and reveals when the host is normal and the app is active.
      const host = state.order.find((w) => w.id === ev.id);
      const overlay = overlayForHost(state, ev.id);
      const patch = overlay !== null && host !== undefined ? overlayFollowPatch(overlay, host.fsMode.name === 'normal', state.appActive, ev.overlayFrame) : null;
      const issuesShow = patch !== null && patch.visible === true;
      const opSeq = issuesShow ? state.opSeqCounter + 1 : state.opSeqCounter;
      return {
        ...state,
        order: state.order.map((w) => {
          if (w.id === ev.id) return { ...w, bounds: ev.bounds };
          if (patch !== null && overlay !== null && w.id === overlay.id) {
            return { ...w, ...patch, ...(issuesShow ? { lastOpSeq: opSeq } : {}) };
          }
          return w;
        }),
        opSeqCounter: opSeq,
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

    case 'DesktopMembershipSet': {
      return {
        ...state,
        order: state.order.map((w) => (w.id === ev.id ? { ...w, desktopMembership: ev.membership } : w)),
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
      // OVERLAY FOLLOW (ported from `window-state.ts applyOverlayFollow`, via
      // `overlayFollowPatch`): attach and retarget drive the SAME
      // reveal/reframe decision the bounds- and fullscreen-driven follow
      // rules elsewhere in this switch drive. Detach (`host === undefined`)
      // writes `visible: false` directly, same as the reveal side writes
      // `visible: true` — the overlay's visibility is a stored fact this
      // arm owns on BOTH sides of the relation, not something left for the
      // backend's native-hide echo to report back later. Leaving it to that
      // echo let a record still read `visible: true` after the machine had
      // already decided to hide it — long enough for a transient-autoclose
      // sweep queued ahead of the echo to read the stale fact and dismiss
      // the overlay's singleton window (see the `OverlayAttached` field doc
      // above this switch). `react`'s visibility diff is what turns this
      // stored fact into the `HideWindow` effect, same loop that turns the
      // reveal side's `visible: true` into `ShowWindow`.
      const host = resolvedHostId !== undefined ? state.order.find((w) => w.id === resolvedHostId) : undefined;
      const overlay = state.order.find((w) => w.id === ev.overlayId);
      const patch =
        host !== undefined && overlay !== undefined
          ? overlayFollowPatch(overlay, host.fsMode.name === 'normal', state.appActive, ev.frame)
          : resolvedHostId === undefined && overlay?.visible === true
            ? { visible: false }
            : {};
      const issuesShow = patch.visible === true;
      const opSeq = issuesShow ? state.opSeqCounter + 1 : state.opSeqCounter;
      return {
        ...state,
        order: state.order.map((w) =>
          w.id === ev.overlayId ? { ...w, overlayFor: resolvedHostId, ...patch, ...(issuesShow ? { lastOpSeq: opSeq } : {}) } : w,
        ),
        opSeqCounter: opSeq,
        version: state.version + 1,
      };
    }

    case 'StackOrderImported': {
      // MEMBERSHIP IS PRESERVED BY CONSTRUCTION, not by a check. This arm is
      // total and guard-free like every other, so "the import must not drop or
      // invent a window" cannot be a rule someone remembers to honor — the
      // result is assembled out of `state.order`'s OWN records and nothing
      // else. No record is ever constructed here and none is ever left out: an
      // id the payload names that is absent from `order` matches no record and
      // contributes nothing, and a repeated id is collapsed by `seen`.
      //
      // WHERE UNNAMED WINDOWS GO — a conscious divergence from the old
      // machine. `window-state.ts`'s `STACK_ORDER_IMPORTED` arm rebuilt the
      // list as `[...unnamed, ...imported]`, pushing every member the import
      // did not name BELOW the entire imported set (was pinned by
      // `window-state.test.ts` "members the import does not name keep their
      // relative order BELOW the imported set" — that test was deliberately NOT
      // ported). It cannot carry over, because the two structures hold
      // different populations: the old `stackOrder` held only stack members,
      // while RULE 1 makes this kernel's `order` hold EVERY registered window
      // — command panel, HUD, peeks/slides, the chrome overlay. Demoting all
      // of them beneath every restored page would corrupt the
      // `topmost(...)`-based queries built on that total order (overlay
      // attachment, `isContentWindow` resolution, the Cmd+W target).
      //
      // So the import permutes only WITHIN the array slots the named ids
      // already occupy: every record the payload does not name keeps its
      // index, and the named records are written back into their own slots in
      // the payload's relative order.
      //
      // An empty or identity payload is the identity permutation, so `react`'s
      // order-changed rule sees no change and emits nothing. That falls out of
      // the construction — there is no early return making it true.
      const seen = new Set<WindowId>();
      const namedRecords: WindowRecord[] = [];
      for (const id of ev.order) {
        if (seen.has(id)) continue;
        seen.add(id);
        const record = state.order.find((w) => w.id === id);
        if (record !== undefined) namedRecords.push(record);
      }
      const namedIds = new Set<WindowId>(namedRecords.map((w) => w.id));
      // One slot per named record, by construction: `namedIds` is exactly the
      // set of ids `namedRecords` carries, and an id occurs at most once in
      // `order` (RULE 1), so the predicate holds for precisely
      // `namedRecords.length` slots and the cursor cannot run off the end.
      let cursor = 0;
      const permuted = state.order.map((w) => (namedIds.has(w.id) ? namedRecords[cursor++] : w));
      // THE KEY WINDOW NEVER LEAVES THE TOP. §0.1.10's one-order clause holds
      // whenever `key` resolves to a record, that record is topmost — and a
      // slot-preserving permutation can otherwise violate it outright: an
      // import naming the key window plus a window below it would, by the
      // rule above, write the key window's record back into that lower slot.
      // `key` itself is still never written here (an import must never
      // activate anything, same as every other line in this arm) — only the
      // key's CURRENT record is lifted, same move `WindowClosed`'s parent
      // refocus uses to keep the clause intact through its own reorder. When
      // `key` is null, or names no live record, or already names the topmost
      // one, `permuted.find` either finds nothing or finds the last element,
      // and the lift is a no-op — so the identity-payload guarantee above
      // still holds. This is a lift, not a re-sort: every other record keeps
      // its resulting relative order from `permuted`; `order` is
      // movement-ordered, never layer-sorted.
      const keyRecord = permuted.find((w) => w.id === state.key);
      const order = keyRecord === undefined ? permuted : [...permuted.filter((w) => w.id !== keyRecord.id), keyRecord];
      return {
        ...state,
        order,
        version: state.version + 1,
      };
    }

    // TEARDOWN (§0.1.5) — four arms, one shape: record the request on
    // `lastTeardown` (the fact `react` diffs) and change nothing else about
    // the window model, with one addition on the three arms that NAME a
    // window: mark that record `pendingHidden` (see the field's doc) — the
    // machine has now decided the window is going away, ahead of the OS's
    // confirming `WindowShown`/`WindowHidden`/`WindowClosed`. The write is a
    // `.map` that simply matches nothing for an id absent from `order`,
    // which is exactly what the commands' unknown-window exemption requires
    // downstream. `GuestTeardownRequested` marks no record: it names no
    // window at all (process-wide, iterating the guest map directly — see
    // `TeardownRequest`'s doc), and inferring which records own guests is not
    // something the kernel can know.
    //
    // Membership is deliberately untouched. `WindowClosed` is the sole event
    // that shrinks `order` (RULE 1), and it arrives on its own as the native
    // report the teardown causes; retiring the record here would emit a
    // `CloseWindow` from the membership diff ON TOP of the teardown effect,
    // closing the same window twice through two different port methods.
    //
    // Total and guard-free like every arm here: an id absent from `order` is
    // stored as given rather than filtered out, which is exactly what the
    // commands' unknown-window exemption requires downstream.
    case 'WindowDestroyRequested': {
      return {
        ...state,
        order: state.order.map((w) => (w.id === ev.id ? { ...w, pendingHidden: true } : w)),
        lastTeardown: { kind: 'destroy-window', id: ev.id, seq: nextTeardownSeq(state) },
        version: state.version + 1,
      };
    }

    case 'WindowContentCloseRequested': {
      return {
        ...state,
        order: state.order.map((w) => (w.id === ev.id ? { ...w, pendingHidden: true } : w)),
        lastTeardown: { kind: 'close-content', id: ev.id, seq: nextTeardownSeq(state) },
        version: state.version + 1,
      };
    }

    case 'WindowDirectCloseRequested': {
      return {
        ...state,
        order: state.order.map((w) => (w.id === ev.id ? { ...w, pendingHidden: true } : w)),
        lastTeardown: { kind: 'close-window-direct', id: ev.id, seq: nextTeardownSeq(state) },
        version: state.version + 1,
      };
    }

    case 'GuestTeardownRequested': {
      // No `id` to store — the request is process-wide, and no record can be
      // marked `pendingHidden` for the same reason (see the section doc above).
      return {
        ...state,
        lastTeardown: { kind: 'destroy-all-guests', seq: nextTeardownSeq(state) },
        version: state.version + 1,
      };
    }

    case 'FocusAssertRequested': {
      // One shape, same as the teardown arms above: record the request on the
      // fact `react` diffs (`lastFocusAssert`) and touch nothing about the
      // window model. `key` and `order` are deliberately untouched — the
      // target is ALREADY topmost and already key, which is the entire reason
      // this event exists.
      //
      // The one record write is the focus-op stamp, and it is not an
      // exception to that: `react` turns this transition into a `RaiseWindow`,
      // a focus-family effect, so the same stamp every other op-issuing arm
      // writes has to be written here too or the token the backend arms its
      // self-caused-focus expectation with would be a previous op's. The
      // condition mirrors `react`'s own emission exactly (a registered
      // target), the same way `WindowShown`'s `issuesShow` and
      // `OsFocusGained`'s own `issuesRaise` do — one token per transition that
      // issues at least one op, and none for a transition that issues none.
      //
      // Total and guard-free like every arm here: an id absent from `order`
      // still records the request (the field is a record of what was asked)
      // and simply matches no record to stamp.
      //
      // Mirrors `react`'s emission exactly: `react` only raises a `visible`,
      // non-doomed target (an off-screen `RaiseWindow` would activate and
      // show it; a doomed one would raise a window already committed to
      // teardown), so the stamp has to require the same thing or the two
      // would disagree about whether this transition issued an op at all —
      // see `admitsFocusAssert`, the one place that condition lives.
      const issuesRaise = state.order.some((w) => w.id === ev.id && admitsFocusAssert(w, w.visible));
      const opSeq = issuesRaise ? state.opSeqCounter + 1 : state.opSeqCounter;
      return {
        ...state,
        order: state.order.map((w) => (w.id === ev.id ? { ...w, lastOpSeq: opSeq } : w)),
        opSeqCounter: opSeq,
        lastFocusAssert: { id: ev.id, seq: nextFocusAssertSeq(state) },
        version: state.version + 1,
      };
    }

    case 'ColdStartFocusArmed': {
      // Latch only: `State.pendingColdStartFocus` and nothing else. `key` is
      // untouched (RULE 2 — arming is a note about a future activation, not a
      // focus report), `order` is untouched (RULE 1), and no record field moves.
      //
      // `null` is applied like any other value, because it IS one: it clears a
      // latch an earlier arm left behind, which is the restore pass's first
      // statement. There is no separate clear event and no branch here.
      //
      // Total and guard-free like every arm in this switch: the id is stored AS
      // GIVEN, including one naming no member of `order`. Filtering it out would
      // drop the ordinary case rather than protect against a bad one — arming
      // runs before the named window is guaranteed live, and a window that has
      // gone by the time the latch is spent is handled where it is spent.
      //
      // Emits nothing, and that needs no rule: nothing in `react` reads this
      // field, so a transition that changes only it projects to no effect.
      return { ...state, pendingColdStartFocus: ev.id, version: state.version + 1 };
    }

    case 'SelectionFocusArmed': {
      // Latch only, the same shape as `ColdStartFocusArmed` above and for all
      // the same reasons: `State.pendingSelectionFocus` and nothing else. `key`
      // is untouched (RULE 2 — a selection is a note about a future close, not
      // a focus report), `order` is untouched (RULE 1), no record field moves,
      // and nothing in `react` reads the field, so this transition projects to
      // no effect.
      //
      // `target: null` is applied like any other value, because it IS one: it
      // clears a selection an earlier arm left behind — the switcher re-arms as
      // the highlight moves, and a dismissed switcher clears. There is no
      // separate clear event.
      //
      // Total and guard-free: both ids are stored AS GIVEN, including ones
      // naming no member of `order`. Liveness is a question for the spend, and
      // that is where `WindowClosed` asks it.
      return {
        ...state,
        pendingSelectionFocus: ev.target === null ? null : { armer: ev.armer, target: ev.target },
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

  // Overlay attach target (§ Effect.AttachOverlayTo): a structural diff of
  // `topmostBaseLayerPageHost` across the transition — NEVER a comparison
  // against the stored `overlayFor` relation. The latter shape
  // (`next.overlayFor !== topmostBaseLayerPageHost(next)`) is a repair loop,
  // and `docs/design/window-manager.md` forbids it: attachment and stacking
  // order are ALLOWED to diverge, and enforcing agreement would mean either
  // constraining order to follow attachment (a second ordering rule, itself
  // forbidden) or constraining attachment to follow order (impossible).
  // Nothing here re-emits, so every legitimate divergence survives.
  //
  // PLACED FIRST, ahead of the overlay-frame loop just below: the attach
  // decides the frame, and a reveal must never paint at a stale one.
  //
  // The `isNew` arm is the boot seed, and it is a diff too — before this
  // transition there was no such overlay record, after it there is. It
  // exists because the overlay singleton is minted after windows may already
  // be registered, and since nothing here re-emits, a steady-state
  // divergence at boot would otherwise persist forever. It is a membership
  // diff, the same shape as this function's other membership rules
  // (`Close`, `Parent refocus`, below) — it is NOT a branch on `ev.type`.
  const prevTarget = topmostBaseLayerPageHost(prev)?.id ?? null;
  const nextTarget = topmostBaseLayerPageHost(next)?.id ?? null;
  for (const r of next.order) {
    if (!r.tracksBaseLayerTop) continue;
    const isNew = !prev.order.some((w) => w.id === r.id);
    if (prevTarget !== nextTarget || isNew) {
      effects.push({ type: 'AttachOverlayTo', overlayId: r.id, hostId: nextTarget });
    }
  }

  // Overlay follow — FRAME (§ WindowRecord.overlayFrame): a structural diff
  // of the stored target frame `evolve` writes (`OverlayAttached`,
  // `BoundsChanged`, `OsFullscreenLeft` — see `overlayFollowPatch`), reading
  // only `prev`/`next` and never `ev.type`. PLACED FIRST, ahead of the
  // visibility loop just below, so a reveal never paints the overlay at a
  // stale frame — the kernel's structural-diff form of `window-state.ts
  // applyOverlayFollow`'s `SET_BOUNDS`-before-`SHOW_WINDOW` ordering.
  for (const nextRecord of next.order) {
    const prevRecord = prev.order.find((w) => w.id === nextRecord.id);
    if (prevRecord === undefined) continue;
    if (nextRecord.overlayFrame !== undefined && !boundsEqual(prevRecord.overlayFrame, nextRecord.overlayFrame)) {
      effects.push({ type: 'SetBounds', id: nextRecord.id, bounds: nextRecord.overlayFrame });
    }
  }

  // Visibility: a record present in both states whose `visible` flipped.
  // (A closed window vanishes from `next.order` entirely — no HideWindow;
  // its dismissal is the CloseWindow diff below instead.) This is also the
  // ONLY rule that drives a visible overlay off screen when it detaches —
  // any transition that detaches a visible overlay (`OverlayAttached`'s own
  // detach path, `WindowClosed`'s mechanical clear of a record's
  // `overlayFor`) writes `visible: false` on that record in `evolve` itself,
  // so there is no overlay-specific case here to diff `overlayFor` against.
  for (const nextRecord of next.order) {
    const prevRecord = prev.order.find((w) => w.id === nextRecord.id);
    if (prevRecord === undefined) {
      continue;
    }
    if (!prevRecord.visible && nextRecord.visible) {
      effects.push({ type: 'ShowWindow', id: nextRecord.id, opSeq: next.opSeqCounter });
    } else if (prevRecord.visible && !nextRecord.visible) {
      // Same token source as the `ShowWindow` arm above (`next.opSeqCounter`,
      // taken once this transition's own evolve has run) — see the `Effect`
      // union's `HideWindow` doc for why a visibility-only effect still needs
      // one.
      effects.push({ type: 'HideWindow', id: nextRecord.id, opSeq: next.opSeqCounter });
    }
  }

  // Close: a record present in `prev.order` and absent from `next.order` —
  // RULE 1 makes `WindowClosed` the only event that shrinks membership, so
  // this membership diff is exactly "this window was closed", never a branch
  // on `ev.type`. Mirrors the visibility loop above, one level up (presence
  // rather than a field on a still-present record).
  for (const prevRecord of prev.order) {
    if (!next.order.some((w) => w.id === prevRecord.id)) {
      effects.push({ type: 'CloseWindow', id: prevRecord.id });
    }
  }

  // Parent refocus (ported from `window-state.ts`'s `WINDOW_CLOSED` arm — the
  // `main.ts parentWin.focus()` replacement): the SAME membership-shrink diff
  // as the `CloseWindow` loop just above, read a second time for the removed
  // record's `parentId` rather than its own id. The parent's eligibility is
  // judged against its CURRENT (`next`) record, never `prev`'s — `evolve`
  // stamps `lastOpSeq` on it only when `isContentWindow` already held there
  // (see the `WindowClosed` arm), so this reads as a pure structural diff
  // and never re-derives the guard from `ev`.
  //
  // PLACED HERE, immediately after `CloseWindow` and well before
  // `SetStacking`/`DismissWindow` further down: when the closed record held
  // `key`, `evolve` moves the eligible parent to the top of `order` in the
  // SAME transition (see the `WindowClosed` arm — that reorder is
  // conditional, guarding §0.1.10's one-order invariant), so this raise has
  // to reach the executor before the trailing `SetStacking` sweep (driven
  // off the length change this same close already causes) replays that new
  // top-of-order position — emitting it later would still be correct
  // z-order-wise (the array already reflects the raise) but would separate
  // two effects of one logical "hand it back to the parent" from their
  // natural CloseWindow/RaiseWindow pairing. When the closed record did NOT
  // hold key, `evolve` leaves the parent's position alone (moving it would
  // put a non-key record above whoever does hold key), so this raise still
  // fires but the trailing `SetStacking` sweep may briefly restack over it —
  // accepted until the real OS focus change this raise causes echoes back as
  // `OsFocusGained` and reconciles `order` for real. `DismissWindow`
  // (transient autoclose) is unaffected either way: it diffs `lastAttention`
  // and `pendingAppResignSweep`/`appActive`, neither of which a plain
  // `WindowClosed` touches, so it fires here or later with identical (empty)
  // result for this transition.
  for (const prevRecord of prev.order) {
    if (next.order.some((w) => w.id === prevRecord.id)) continue;
    if (prevRecord.parentId === undefined) continue;
    const parent = next.order.find((w) => w.id === prevRecord.parentId);
    if (parent !== undefined && isContentWindow(parent)) {
      effects.push({ type: 'RaiseWindow', id: parent.id, opSeq: next.opSeqCounter });
    }
  }

  // Successor raise on hide (ported from `window-state.ts`'s `WINDOW_HIDDEN`
  // arm — the sibling of the parent-refocus rule just above, read off the
  // SAME visibility diff the `ShowWindow`/`HideWindow` loop at the top of
  // this function computes, rather than the membership diff those two loops
  // read). A record that went `visible: true` -> `false` and held `prev.key`
  // hands the raise to whatever content window is left, exactly mirroring
  // `evolve`'s `WindowHidden` arm — which stamps `lastOpSeq` on that same
  // successor under this identical condition — so this reads as a pure
  // structural diff and never re-derives the guard from `ev`.
  //
  // WHY THE `appActive` TEST IS LOAD-BEARING HERE, AND WHAT HOLDS IT UP. This
  // rule cannot tell which event flipped the visibility — that is the whole
  // point of a structural diff — so it must not fire on the OTHER two arms
  // that clear `visible` on a record `key` may name. `AppResigned` is safe
  // locally: it writes `appActive: false` in the same transition, so the test
  // below excludes it. `AppResignSettled` is NOT safe locally — it hides
  // sweep-eligible windows without consulting `appActive`, deliberately, so
  // that the defensive path still runs its reversible hide. Its safety is
  // NON-LOCAL: it rests on `appActive: true` and `pendingAppResignSweep: true`
  // never holding together, since `AppActivated` is the only writer of the
  // former and clears the latter in the same object. That is not an argument
  // left in a comment — `window-kernel-properties.test.ts checkInvariants`
  // asserts it under "App activation dance". Were it ever to regress, this
  // loop would emit a `RaiseWindow` that `evolve` minted no token for, and the
  // op-seq biconditional would break rather than anything visible going wrong.
  //
  // A record REMOVED from `order` is never visited: this walks `next.order`
  // and looks each id up in `prev`, and `WindowClosed` is the only arm that
  // shrinks the order.
  for (const nextRecord of next.order) {
    const prevRecord = prev.order.find((w) => w.id === nextRecord.id);
    if (prevRecord === undefined) continue;
    if (!prevRecord.visible || nextRecord.visible) continue;
    if (prevRecord.id !== prev.key) continue;
    if (next.appActive !== true) continue;
    const successor = topmost(next, isContentWindow);
    if (successor !== null) {
      effects.push({ type: 'RaiseWindow', id: successor.id, opSeq: next.opSeqCounter });
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

  // Desktop membership (see `DesktopMembership`) — same diff pattern as
  // bounds above. `undefined` is a real state (nobody has asked), so the
  // guard is not just `!==`: it also excludes the (never-occurring, since
  // nothing clears the field) defined -> undefined direction, keeping the
  // effect payload's `membership` non-optional as a type fact rather than a
  // runtime one.
  for (const nextRecord of next.order) {
    const prevRecord = prev.order.find((w) => w.id === nextRecord.id);
    if (prevRecord === undefined) {
      continue;
    }
    if (prevRecord.desktopMembership !== nextRecord.desktopMembership && nextRecord.desktopMembership !== undefined) {
      effects.push({ type: 'SetDesktopMembership', id: nextRecord.id, membership: nextRecord.desktopMembership });
    }
  }

  // Click-through (see `WindowRecord.acceptsInput`) — same diff pattern as
  // bounds/desktop-membership above. Fires whether the mirror moved via the
  // `SetAcceptsInput` command or a genuine externally-caused
  // `WindowAcceptsInputChanged` report (the Space border) — never branches on
  // `ev.type`. A window's own registration transition emits nothing here
  // (`prevRecord` is undefined for it), same as bounds/desktop-membership.
  for (const nextRecord of next.order) {
    const prevRecord = prev.order.find((w) => w.id === nextRecord.id);
    if (prevRecord === undefined) {
      continue;
    }
    if (prevRecord.acceptsInput !== nextRecord.acceptsInput) {
      effects.push({ type: 'SetAcceptsInput', id: nextRecord.id, acceptsInput: nextRecord.acceptsInput });
    }
  }

  // RaiseWindow: `State.key` now names a different window. Same structural
  // shape as every rule above — one field, diffed between `prev` and `next` —
  // so it reads `prev`/`next` only and never asks which event caused the move.
  //
  // WHY `key` AND NOT THE TOP OF `order`. A raise asserts which window is the
  // one in use, and `key` IS that fact: `OsFocusGained` is its only writer,
  // and `decide` turns a `RaiseWindow` COMMAND into exactly that event, so the
  // raise path is preserved verbatim by diffing the field the command's own
  // event writes. Diffing the top of `order` instead answered the question
  // only indirectly, and needed a length-equality trick to do it — `order`
  // moves for reasons that are not a focus change, so the rule had to exclude
  // every membership change to keep registration and close from raising.
  //
  // The two halves that separates, which a top-of-stack diff cannot express:
  //
  //  - a pure REORDER (`order` permuted, `key` untouched) raises NOTHING. A
  //    stack-order import during session restore permutes `order` wholesale;
  //    an activating raise there would take key from whatever holds it and —
  //    since a raise SHOWS what it raises — could put a hidden window on
  //    screen. The old machine forbade it outright (`window-state.ts`
  //    `STACK_ORDER_IMPORTED`: an order import must never activate anything).
  //  - a focus report on a window that is ALREADY topmost still raises when it
  //    takes key from somebody else (after an `OsFocusLost`, or with a palette
  //    holding key over it). Nothing in `order` moves, so the old rule emitted
  //    nothing and the model never re-asserted its answer.
  //
  // A membership change is still not a raise, now as a consequence rather than
  // a special case: registration and close do not write `key`. Closing the top
  // window promotes the one beneath it in `order` and leaves `key` dangling on
  // the retired id — no diff, no raise, so the promoted window is never guessed
  // at as a successor (RULE 2).
  //
  // `next.key === null` (an `OsFocusLost`) raises nothing: there is no window
  // to name. So does a `key` naming an id absent from `next.order` — a raise
  // has to reach a real window, and a dangling key is unobservable by design
  // (see `keyWindow`).
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
  //     emission is its own fixed point. The raise makes its target the window
  //     in use, so the focus the OS echoes back names the window `key` ALREADY
  //     holds — the diff is empty and the echo emits nothing. One correcting
  //     write, then silence. (Provenance —
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
  const nextKey = next.key;
  if (nextKey !== null && nextKey !== prev.key && next.order.some((w) => w.id === nextKey)) {
    effects.push({ type: 'RaiseWindow', id: nextKey, opSeq: next.opSeqCounter });
  }

  // Transient autoclose (§0: "the machine applies the rule; no caller does" —
  // `selectTransientAutoclose` stays a pure QUERY, and `react` is what turns
  // its answer into effects, so rule application is non-optional). Dismissal
  // used to be ONE condition; it is now TWO structural diffs, kept at this
  // same slot — immediately after the `RaiseWindow` rule and before
  // `SetStacking` — so emitted effect ordering is unchanged: the old
  // machine's fixed effect order was `[autoclose…, FOCUS_CONTENT]`, sweep
  // before the trailing focus re-assert, and both halves below still ride
  // right after the raise they are triggered alongside.
  //
  // (a) FOCUS-REPORT SWEEP — a structural diff of `State.lastAttention`, the
  // same shape as the teardown/focus-assert rules below it in this function:
  // the `seq` comparison is what makes it a diff rather than a read, so a
  // transition that did not write a fresh attention fact leaves the field
  // alone and emits nothing, and two reports for the same holder — even an
  // echo re-confirming the window that already holds key — carry different
  // `seq` values and are each swept independently, mirroring the old
  // machine's `OS_FOCUS_GAINED` arm running `selectTransientAutoclose` on
  // every report, not just the ones that moved `front`.
  //
  // decide's `RaiseWindow` COMMAND is translated into an `OsFocusGained`
  // event, so a machine-issued raise sweeps where the old machine's
  // `RAISE_WINDOW_REQUESTED` did not. That is intended, not a gap: a raise
  // that genuinely takes key IS "some other window takes key", and the
  // machine-cause ordering floor `selectTransientAutoclose` holds (spare
  // anything opened after the op that caused the focus) is what keeps a
  // machine-driven raise from sweeping something opened after it was issued.
  // That floor arms ONLY on a `machine` cause, so every producer of a
  // machine-issued focus report owes one: `decide`'s `RaiseWindow` arm above,
  // `window-kernel-dispatch.ts`'s `kernelOsFocusGained` (threading the
  // backend's `takeFocusCause`) and `kernelWindowShown`'s companion
  // focus. A producer that omits it reads as the world, the floor disarms, and
  // a raise sweeps the window whose own opening provoked it.
  const attention = next.lastAttention;
  if (attention !== null && attention.seq !== prev.lastAttention?.seq) {
    const holder = attention.holder;
    // An INDETERMINATE holder — absent from `order` — declines rather than
    // guesses: the machine holds no record for it, so it cannot evaluate the
    // ownership relation (`parentId`/`overlayFor`) `selectTransientAutoclose`
    // needs — the same guard the `RaiseWindow` rule above holds for a
    // dangling `key`, since `evolve` writes `holder` (and `key`) even for a
    // focuser absent from `order`. `holder` is always a real `WindowId` here
    // (`Attention.holder`'s type, narrowed once the app-resign write below
    // stopped sharing this field) — attention landing on nothing of Peek's
    // is rule (b) below, not a `null` holder here.
    if (next.order.some((w) => w.id === holder)) {
      for (const id of selectTransientAutoclose(next, holder, attention.cause)) {
        effects.push({ type: 'DismissWindow', id });
      }
    }
  }

  // (b) RESIGN SWEEP — a structural diff of `pendingAppResignSweep`/
  // `appActive`, replacing the `holder: null` write `AppResignSettled` used
  // to stamp onto `State.lastAttention` as a one-shot message. The diff is
  // that arm's own `attentionLost` test (`!state.appActive`) restated so
  // `react` can read it without branching on `ev.type`: the arm never
  // touches `appActive`, so `next.appActive === state.appActive` there, and
  // `!next.appActive` IS `attentionLost`. `AppActivated` also disarms
  // `pendingAppResignSweep`, but sets `appActive: true` in the same
  // transition, so `!next.appActive` is exactly what separates a real settle
  // from the dance cancel; an inert settle (the early return on
  // `!state.pendingAppResignSweep`) never even satisfies
  // `prev.pendingAppResignSweep`. `focusedId: null` — attention on nothing of
  // Peek's — is a DETERMINATE fact, so unlike (a) this rule needs no
  // indeterminate guard.
  if (prev.pendingAppResignSweep && !next.pendingAppResignSweep && !next.appActive) {
    for (const id of selectTransientAutoclose(next, null)) {
      effects.push({ type: 'DismissWindow', id });
    }
  }

  // SetStacking (§0.1.6): a MINIMAL replay, not a re-assert of everything
  // eligible. The native primitive is move-to-top, so a window whose index in
  // its band did not change can still end up in the wrong place once a
  // DIFFERENT window moves past it — bottom -> top `[A,B,C]` -> `[B,A,C]`
  // only changes A's and B's index, but replaying move-to-top on just those
  // two yields `[C,B,A]`, not `[B,A,C]`. The unit that has to be re-announced
  // is therefore not "windows whose index changed" but the SMALLEST trailing
  // run of the band's new order that, replayed bottom -> top over whatever
  // the OS already has, reproduces the whole band — in the example above,
  // that is A then C.
  //
  // Computed independently PER BAND (`w.layer > BASE_LAYER` is "pinned",
  // everything else is "stacked" — §0.1.6's fixed layer array), because a
  // native move-to-top only reorders within its own level and cannot perturb
  // the other band. Within a band, `N` and `P` below sort by `layer`
  // ascending then by position in their respective `order` — the SAME
  // ordering `window-kernel-executor.ts reassertStacking` sorts its replay
  // by, so the two stay in step.
  //
  // A window is FORCED into the suffix no matter where the minimal-diff
  // search would have put it: one absent from `prev.order` entirely (a fresh
  // registration), or whose `visible` or `orderable` flipped false -> true.
  // Each of those is a window the OS has never placed at all, so it needs a
  // replay even when its position in the band looks unchanged.
  //
  // When nothing in a band moved, this emits nothing for it — the emission
  // is a genuine diff now, not an idempotent re-assert; see the doc on
  // `window-kernel-executor.ts runEffects` for what that trades away.
  for (const pinnedBand of [false, true] as const) {
    const inBand = (w: WindowRecord) => (w.layer > BASE_LAYER) === pinnedBand;
    const eligible = (w: WindowRecord) => w.visible && w.orderable && inBand(w);

    const N = next.order.filter(eligible).sort((a, b) => a.layer - b.layer);
    const nIds = new Set(N.map((w) => w.id));
    const P = prev.order
      .filter(eligible)
      .sort((a, b) => a.layer - b.layer)
      .filter((w) => nIds.has(w.id));

    // Smallest `k` such that dropping N's last `k` ids — from BOTH N and P —
    // leaves the two sequences equal. `k` always resolves by `N.length`: at
    // that point every id is dropped from both sides and both are empty.
    let k = 0;
    for (; k <= N.length; k++) {
      const suffixIds = new Set(N.slice(N.length - k).map((w) => w.id));
      const head = N.slice(0, N.length - k);
      const pRemaining = P.filter((w) => !suffixIds.has(w.id));
      if (head.length === pRemaining.length && head.every((w, i) => w.id === pRemaining[i].id)) break;
    }
    let suffixStart = N.length - k;

    for (let i = 0; i < N.length; i++) {
      const prevRecord = prev.order.find((p) => p.id === N[i].id);
      const forced =
        prevRecord === undefined || (!prevRecord.visible && N[i].visible) || (!prevRecord.orderable && N[i].orderable);
      if (forced) suffixStart = Math.min(suffixStart, i);
    }

    for (let i = suffixStart; i < N.length; i++) {
      effects.push({ type: 'SetStacking', id: N[i].id, layer: N[i].layer });
    }
  }

  // Teardown (§0.1.5): a structural diff of `State.lastTeardown` — the same
  // shape as every rule above, one level up from a record field. The `seq`
  // comparison is what makes it a diff rather than a read: a transition that
  // did not request a teardown leaves the field alone and emits nothing, and
  // two identical requests for the same window carry different `seq` values,
  // so the second is a second teardown rather than a no-op.
  //
  // The switch is over STATE (`kind`), never over `ev.type` — which is why
  // this rule holds identically for a teardown fed in directly and for one
  // `decide` translated from a command. `destroy-all-guests` is the one arm
  // whose effect names no window: it is process-wide by construction (see
  // `TeardownRequest`).
  const teardown = next.lastTeardown;
  if (teardown !== null && teardown.seq !== prev.lastTeardown?.seq) {
    switch (teardown.kind) {
      case 'destroy-window':
        effects.push({ type: 'DestroyWindow', id: teardown.id });
        break;
      case 'close-content':
        effects.push({ type: 'CloseContent', id: teardown.id });
        break;
      case 'close-window-direct':
        effects.push({ type: 'CloseWindowDirect', id: teardown.id });
        break;
      case 'destroy-all-guests':
        effects.push({ type: 'DestroyAllGuests' });
        break;
    }
  }

  // Fullscreen reconcile: a per-record structural diff of `fsMode.unverified`
  // (see `FsMode`'s doc) — one `ReconcileFullscreen` for every record whose
  // mark newly went false -> true, never a branch on `ev.type`. A record
  // already unverified in `prev` (a second settle timeout, or a second
  // `AppActivated`, while it is still in flight) emits nothing a second time
  // — safe, because `electron-window-backend.ts reconcileFullscreen` answers
  // synchronously, so an unverified window is one pump-drain wide.
  for (const record of next.order) {
    if (!isFsModeUnverified(record.fsMode)) continue;
    const prevRecord = prev.order.find((w) => w.id === record.id);
    if (prevRecord !== undefined && isFsModeUnverified(prevRecord.fsMode)) continue;
    effects.push({ type: 'ReconcileFullscreen', id: record.id });
  }

  // App hide: the last window that was keeping Peek on screen has gone away,
  // so hand the user back to whatever they were in before. Ported from
  // `windows.ts maybeHideApp`, which the two `closeOrHideWindow` tails called
  // themselves.
  //
  // A STRUCTURAL DIFF, like every other rule here: the app hides when this
  // transition took the count of app-holding windows from some to none. Both
  // halves are needed. Without the "was some" half every later transition in
  // an app with nothing on screen would re-issue the hide; without the "now
  // none" half a close that leaves other windows up would hide the app out
  // from under them.
  //
  // THE OLD OVERLAY EXEMPTION FALLS OUT rather than being carried. `windows.ts`
  // skipped the hide when the CLOSING window was the switcher, as a named
  // special case. Here the switcher's class is one that never held the app open
  // in the first place, so its close cannot take the count from some to none —
  // the diff is simply false, and there is no case to write.
  //
  // A HIDE, not a quit, and not a window operation: Peek's own windows are
  // untouched. The backend's `hideApp` performs it, and a platform without the
  // concept answers with nothing.
  const heldBefore = prev.order.some(holdsAppOnScreen);
  const heldAfter = next.order.some(holdsAppOnScreen);
  if (heldBefore && !heldAfter) {
    effects.push({ type: 'HideApp' });
  }

  // Focus assert: a structural diff of `State.lastFocusAssert`, the same shape
  // as the teardown rule above and for the same reason — the transition it
  // projects changes nothing else, so there is nothing else to diff. The `seq`
  // comparison is what makes it a diff rather than a read: a transition that
  // did not ask for an assert leaves the field alone and emits nothing, and
  // two asserts for the same window carry different `seq` values, so the
  // second is a second assert rather than a no-op. That matters more here than
  // it does for teardown: the payload is identical every single time (open
  // devtools, close devtools, open again), so `seq` is the ONLY thing
  // distinguishing them.
  //
  // LAST, deliberately. `react` emits in rule order and the executor performs
  // in that order, so an assert has to land after the re-show / overlay-reveal
  // / stacking work above — the old machine's arm ran `applyRaiseRequest`
  // after its own re-show work for the same reason. An assert emitted first
  // would drive first responder onto the content surface and then have a
  // re-show or a stacking re-assert land on top of it.
  //
  // Faithful to `applyRaiseRequest`: a raise, plus the content-focus half for
  // a window whose content surface is a thing to focus, and nothing for a
  // target that is not there to raise. The two reads of `next.order` are
  // structural, not branches on `ev.type` — the rule holds identically for an
  // assert fed in directly and for one `decide` translated from a command.
  //
  // GATED ON `admitsFocusAssert`, not merely present in `next.order`. Every
  // other `RaiseWindow` emitter in this function carries an eligibility
  // predicate; `backend.raiseWindow` is an activating show, so without this
  // test an assert naming an off-screen OR doomed window would pull it onto
  // the screen and take key. `evolve`'s `FocusAssertRequested` and
  // `AppActivated` arms stamp `lastOpSeq` under this exact condition — see
  // `admitsFocusAssert`'s own doc for why the three share one helper.
  const focusAssert = next.lastFocusAssert;
  if (focusAssert !== null && focusAssert.seq !== prev.lastFocusAssert?.seq) {
    const record = next.order.find((w) => w.id === focusAssert.id);
    if (record !== undefined && admitsFocusAssert(record, record.visible)) {
      effects.push({ type: 'RaiseWindow', id: focusAssert.id, opSeq: next.opSeqCounter });
      // `isContentWindow` rather than `kind === 'page-host'` (the old arm's
      // own test): this kernel's content predicate is the one that answers
      // "the window the user is working in", and it is the same predicate
      // `decide` gates the command on — so through the command path this
      // clause always holds, and it earns its keep for an assert dispatched
      // as a raw event, which bypasses `decide` entirely.
      if (isContentWindow(record)) {
        effects.push({ type: 'FocusContent', id: focusAssert.id });
      }
    }
  }

  return effects;
}

/**
 * The ids `CloseOrHideWindow` must ALSO close when it closes `rootId` — every
 * window `rootId` opened, transitively, walked over the kernel's OWN
 * `parentId` edges rather than any address/string graph a caller might keep
 * (ported intent of the old `windows.ts closeChildWindows`, which walked a
 * legacy registry's `params.parentAddress` string instead — a different
 * graph, and one that could close windows this graph has no edge for; see
 * the migration note on `closeChildWindows`'s own call site).
 *
 * DEEPEST FIRST (post-order): a child's own descendants come before the
 * child itself, and `rootId`'s descendants all come before `rootId`'s own
 * event — `decide`'s caller appends that separately — mirroring the old
 * function's recurse-then-close shape, so a leaf's teardown always precedes
 * the ancestor that owned it.
 *
 * SKIPS an `appLifetime` record AND its whole subtree, never descending into
 * one — same boundary `closeChildWindows` drew for `WEB_CORE_ADDRESS`
 * (return immediately rather than recurse). A window whose lifetime is the
 * app's own is never swept as someone else's descendant.
 *
 * ALWAYS a close, never a hide, for every id this returns — `keepLive` is
 * read only for `rootId` itself (`decide`'s `CloseOrHideWindow` case); a
 * cascaded descendant is torn down unconditionally, matching
 * `closeChildWindows`'s own unconditional `closeHostWindow` call, which never
 * consulted a child's own keepLive.
 *
 * CYCLE-SAFE, by its own guard rather than by a caller's convention. Nothing
 * constrains `parentId` to point backwards in registration order, so these
 * edges are a general graph and not a forest; a cycle would otherwise recurse
 * until the stack overflows inside `decide`. `visited` caps the walk at one
 * visit per id, so a cycle yields each member once and terminates. On acyclic
 * input the result is byte-identical to the unguarded walk.
 */
function descendantsToCascadeClose(
  state: State,
  rootId: WindowId,
  visited: Set<WindowId> = new Set([rootId]),
): WindowId[] {
  const ids: WindowId[] = [];
  for (const child of state.order.filter((w) => w.parentId === rootId)) {
    if (child.appLifetime === true) continue;
    if (visited.has(child.id)) continue;
    visited.add(child.id);
    ids.push(...descendantsToCascadeClose(state, child.id, visited));
    ids.push(child.id);
  }
  return ids;
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
          ...(cmd.bounds !== undefined ? { bounds: cmd.bounds } : {}),
          ...(cmd.tracksBaseLayerTop !== undefined ? { tracksBaseLayerTop: cmd.tracksBaseLayerTop } : {}),
          ...(cmd.selfClosesOnBlur !== undefined ? { selfClosesOnBlur: cmd.selfClosesOnBlur } : {}),
          ...(cmd.appLifetime !== undefined ? { appLifetime: cmd.appLifetime } : {}),
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
    return {
      events: [{ type: 'OverlayAttached', overlayId: cmd.overlayId, hostId: cmd.hostId, ...(cmd.frame !== undefined ? { frame: cmd.frame } : {}) }],
    };
  }

  // ImportStackOrder carries `order`, not `id` — handled here, before the
  // generic `cmd.id` guard below, same structural reason as the two
  // special-cases above.
  //
  // The stale-version guard at the top of `decide` is the ONLY guard it gets.
  // Unknown ids are NOT rejected: `session.ts restoreSessionSnapshot` builds
  // the payload through `getWindowIdFor` over windows that may have died
  // mid-restore, so an id naming nothing is expected traffic and is inert in
  // `evolve` rather than fatal here. Nothing else needs guarding — membership
  // is preserved by the arm's construction, not by validating the payload.
  if (cmd.type === 'ImportStackOrder') {
    return { events: [{ type: 'StackOrderImported', order: cmd.order }] };
  }

  // ArmColdStartFocus carries an id that may be `null` and, when it is not, may
  // name a window that is not live yet — handled here, before the generic
  // `cmd.id` guard below, the same structural reason `ImportStackOrder` above
  // is. The stale-version guard at the top of `decide` is the ONLY guard it
  // gets, and an existence guard would be wrong rather than redundant: it would
  // reject every clear (`null` names nothing), and a real id is a note to be
  // read at a later activation, whose liveness is a question for the moment the
  // latch is spent. See the command's own doc.
  if (cmd.type === 'ArmColdStartFocus') {
    return { events: [{ type: 'ColdStartFocusArmed', id: cmd.id }] };
  }

  // ArmSelectionFocus carries `armer`/`target` rather than `id` — handled here,
  // before the generic `cmd.id` guard below, the same structural reason the
  // three above are.
  //
  // It carries ONE guard of its own, and only on the armer: the latch is spent
  // by that window's `WindowClosed` and by nothing else, so arming against a
  // window the kernel does not have leaves a latch nothing can ever spend —
  // which would then fire on whichever future window happened to be minted the
  // same id. A clear (`target: null`) still needs a live armer for the same
  // reason it needs one at all: it names whose selection is being cleared.
  //
  // The TARGET is deliberately unguarded, the same call `ArmColdStartFocus`
  // makes: it is a note to be read when the switcher closes, and a target that
  // dies in between makes the spend a no-op rather than making this arm wrong.
  if (cmd.type === 'ArmSelectionFocus') {
    if (!state.order.some((w) => w.id === cmd.armer)) {
      return { rejected: 'no-such-window' };
    }
    return { events: [{ type: 'SelectionFocusArmed', armer: cmd.armer, target: cmd.target }] };
  }

  // TEARDOWN (§0.1.5) — handled BEFORE the existence guard below, and that
  // ordering is the whole point: these four are exempt from unknown-window
  // rejection. `ipc.ts runHybridFinalize` names a window `finalizeWindowClose`
  // retired microseconds earlier in the same synchronous body, on every hybrid
  // close, so a rejecting arm would silently drop the content-WC teardown of
  // every hybrid window. See the commands' own doc for the full reasoning; the
  // old machine's four arms accept the same traffic, pinned by
  // `window-state.test.ts` ("even after the record retired").
  //
  // `DestroyAllGuests` carries no `cmd.id` at all and so must be answered here
  // regardless — same structural reason `RegisterWindow` and `AttachOverlay`
  // are handled above. There is no guard left for any of the four: `decide`
  // holds all guards, and teardown has none to hold.
  if (cmd.type === 'DestroyWindow') {
    return { events: [{ type: 'WindowDestroyRequested', id: cmd.id }] };
  }
  if (cmd.type === 'CloseContent') {
    return { events: [{ type: 'WindowContentCloseRequested', id: cmd.id }] };
  }
  if (cmd.type === 'CloseWindowDirect') {
    return { events: [{ type: 'WindowDirectCloseRequested', id: cmd.id }] };
  }
  if (cmd.type === 'DestroyAllGuests') {
    return { events: [{ type: 'GuestTeardownRequested' }] };
  }

  if (!state.order.some((w) => w.id === cmd.id)) {
    return { rejected: 'no-such-window' };
  }

  switch (cmd.type) {
    case 'RaiseWindow':
      // A raise is a focus request (§0.1.10: use-order and z-order are one
      // order, so raising a window is what makes it key).
      //
      // `machine` provenance, because the machine is literally the one asking:
      // this event is manufactured from a COMMAND, not reported by the OS. The
      // token is the counter as it stands now — `evolve` mints the NEXT one for
      // this transition, so the record's `lastOpSeq` can only be <= this value
      // when the event is applied to the state `decide` saw, and the
      // stale-self-echo guard drops it only if a newer op for the same window
      // was applied while it sat in the pump's queue. Without a cause the event
      // reads as the WORLD taking key, which disarms
      // `selectTransientAutoclose`'s ordering floor and lets a machine raise
      // sweep a transient opened after the raise was issued.
      return { events: [{ type: 'OsFocusGained', id: cmd.id, cause: { kind: 'machine', opSeq: state.opSeqCounter } }] };
    case 'ShowWindow':
      return { events: [{ type: 'WindowShown', id: cmd.id }] };
    case 'HideWindow':
      return { events: [{ type: 'WindowHidden', id: cmd.id }] };
    case 'CloseOrHideWindow': {
      // REFUSAL FIRST (§0.1): a record whose lifetime is the app's own
      // (`WindowRecord.appLifetime`) rejects the command outright — neither
      // hidden nor closed, and no cascade runs. Ported from
      // `windows.ts closeOrHideWindow`'s address-keyed background-window
      // refusal, now a property of the record instead of an address test.
      const record = state.order.find((w) => w.id === cmd.id)!;
      if (record.appLifetime === true) {
        return { rejected: 'app-lifetime-window' };
      }
      // CASCADE: every window this one opened, transitively, over the
      // kernel's own `parentId` edges (`descendantsToCascadeClose`) — closed
      // unconditionally, deepest first, before `cmd.id`'s own event.
      const cascade: Event[] = descendantsToCascadeClose(state, cmd.id).map((id) => ({ type: 'WindowClosed', id }));
      // THE branch point (§0.1): keepLive === true hides, never closes, so
      // its content keeps running; otherwise it closes. This guard lives
      // here, never in `evolve`, and applies only to `cmd.id` itself — a
      // cascaded descendant above is torn down regardless of its own
      // keepLive (see `descendantsToCascadeClose`'s doc).
      const own: Event = record.keepLive ? { type: 'WindowHidden', id: cmd.id } : { type: 'WindowClosed', id: cmd.id };
      return { events: [...cascade, own] };
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
        // Stash the pre-fullscreen rect from the machine's own bounds
        // mirror — never a live query, and read from `rec` (the
        // pre-transition record), same pattern as Maximize's `preMaxBounds`
        // stash above. `null` = no stash was possible (no bounds ever
        // reported for this window).
        return { events: [{ type: 'FullscreenTransitionStarted', id: cmd.id, entering: true, preBounds: rec.bounds ?? null }] };
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
      // Already maximized: nothing new to snap to (the caller's `workArea`
      // is discarded) — a no-op rather than a re-snap.
      if (rec.maximized) return { events: [] };
      return {
        events: [
          { type: 'PendingProjectionDiscarded', id: cmd.id },
          // Stash the pre-maximize rect from the machine's own bounds
          // mirror — never a live query, and read from `rec` (the
          // pre-transition record) rather than anything the paired
          // BoundsChanged below writes, so the stash can never see the
          // post-maximize rect. `null` = no stash was possible.
          { type: 'Maximized', id: cmd.id, preMaxBounds: rec.bounds ?? null },
          // Drive the actual snap, reusing BoundsChanged (see that event's
          // doc) — the same event SetBounds/Unmaximize write bounds
          // through. Skipped when the caller had no rect to hand (see the
          // command's own doc for why that is a valid, if inert, request).
          ...(cmd.workArea !== undefined ? ([{ type: 'BoundsChanged', id: cmd.id, bounds: cmd.workArea }] as Event[]) : []),
        ],
      };
    }
    case 'SeedMaximized': {
      const rec = state.order.find((w) => w.id === cmd.id)!;
      // Same aa34cb50 guard as Maximize/SetBounds.
      if (rec.fsMode.name !== 'normal') return { events: [] };
      return {
        events: [
          // The stash comes from the command, NEVER from `rec.bounds` the
          // way `Maximize` resolves it: at construction time those bounds
          // are the maximized rect (see the command's own doc). No paired
          // `BoundsChanged` — the window is already there — and no
          // `PendingProjectionDiscarded` either: this seeds a record to
          // match geometry that already exists rather than deciding new
          // geometry, so a held projection is not superseded by it.
          { type: 'Maximized', id: cmd.id, preMaxBounds: cmd.preMaxBounds },
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
    case 'SetDesktopMembership':
      return { events: [{ type: 'DesktopMembershipSet', id: cmd.id, membership: cmd.membership }] };
    case 'SetAcceptsInput':
      return { events: [{ type: 'WindowAcceptsInputChanged', id: cmd.id, acceptsInput: cmd.acceptsInput }] };
    case 'AssertFocus': {
      // Reached only after the unknown-window guard above — this command is
      // NOT exempt from it (see the command's own doc for why the teardown
      // exemption does not carry over).
      //
      // THE remaining guard, and the port of `applyRaiseRequest`'s
      // `isEligibleFront(rec)` early return: a target that is not the kind of
      // window the user works in is accepted and drives nothing, rather than
      // being raised. The two conditions the old function ALSO held —
      // `state.appActive` and `!state.switcher.open` — belong to the caller;
      // the command's doc records which and why.
      const rec = state.order.find((w) => w.id === cmd.id)!;
      if (!isContentWindow(rec)) return { events: [] };
      return { events: [{ type: 'FocusAssertRequested', id: cmd.id }] };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Queries that replace `front` (§0.1.5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scans `order` from the top (the END of the array) and returns the first match, else null.
 *
 * TRUSTWORTHY ONLY WHEN `pred` ADMITS RECORDS FROM ONE `layer`. `order` is
 * insertion- and movement-ordered, never layer-sorted (§0.1.6), so array
 * position and visual stacking agree only within a single layer band. A
 * predicate whose admitted set spans bands can have this function return a
 * window that is not visually topmost, with no error path to catch it — the
 * winner is simply wrong. A predicate that spans bands must add a `layer`
 * clause narrowing it to one band, or be replaced with a band-aware query.
 */
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
 * The registered record for `id`, or null when `id` names no member of
 * `order` — a plain-lookup sibling to `keyWindow`/`topmost`, so callers that
 * only need to resolve a known id do not each write their own `order.find`.
 */
export function windowById(state: State, id: WindowId): WindowRecord | null {
  return state.order.find((w) => w.id === id) ?? null;
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
 * True when a `WindowShown`/`WindowHidden` event's `opSeq` is OLDER than the
 * newest op issued for `id` (`WindowRecord.lastOpSeq`) — the same comparison
 * `isStaleSelfEcho` makes for a focus report, generalized to a bare token
 * instead of a `FocusCause` (a visibility echo carries no "who" to ask, only
 * "which op"). An event with no `opSeq` (a bare `ShowWindow`/`HideWindow`
 * COMMAND's event, or any producer not yet taught to report one) is never
 * stale — absent is not a token to compare, same reading `OsFocusGained`'s
 * missing `cause` gets.
 *
 * WHY THIS MATTERS: an `AttachOverlayTo` that re-targets the shared chrome
 * overlay onto a surviving page host and a `HideWindow` that detaches it from
 * a closing one can both be emitted for the SAME transition (`react`'s
 * attach-diff and visibility-diff are independent passes over the same
 * `prev`/`next`). Each performs a real native call and queues its own
 * confirming echo; the attach's `OverlayAttached` is applied before the
 * hide's queued `WindowHidden` (`react` pushes `AttachOverlayTo` ahead of
 * `HideWindow`, and effects run in that order), so by the time the hide's
 * echo is applied the overlay may already be visible again. Without this
 * check that stale echo reads as a genuine fresh hide, `react` re-emits
 * `HideWindow`, its own echo lands after the attach's `ShowWindow` re-fires
 * to correct it, and the two alternate forever — `pump`'s queue has no depth
 * limit and never runs out of events to drain. See
 * `hybrid-close-two-hosts-hang.spec.ts`.
 */
export function isStaleWindowEcho(state: State, id: WindowId, opSeq: number | undefined): boolean {
  if (opSeq === undefined) return false;
  const record = state.order.find((w) => w.id === id);
  return record?.lastOpSeq !== undefined && opSeq < record.lastOpSeq;
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
 * The roles that hold key without being what the user thinks of as their
 * document — chrome, a launcher, a mode switcher. Ported from `ipc.ts`'s
 * registration predicate (`satellite: role === 'overlay' || role === 'palette'
 * || role === 'switcher'`), which is where the old reducer's per-window
 * `satellite` flag was actually decided. See `isFrontEligibleWindow` for the
 * query this set backs, and its doc for why the membership stops one role
 * short of `TRANSIENT_ROLES` below (`quick-view` is transient but NOT
 * satellite).
 */
export const SATELLITE_ROLES: ReadonlySet<string> = new Set(['overlay', 'palette', 'switcher']);

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
 *   - `!pendingHidden` the machine's own belief that this window is going
 *                      away, ahead of the OS's confirming echo (see that
 *                      field's doc). This predicate drives the successor
 *                      raise, the parent-refocus handoff, and the
 *                      focus-assert gate (`admitsFocusAssert`) — every one of
 *                      those is an activating show, so admitting a doomed
 *                      window here would raise a window the machine has
 *                      already committed to tearing down.
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
 * and it is a non-interaction BY CONSTRUCTION, not by coincidence.
 * `isAppResignSweepEligible` carries an explicit `!isContentWindow(record)`
 * clause naming this predicate directly, so no content window is ever hidden
 * by an app switch and no `visible` answer here flickers as the app resigns
 * and re-activates, whatever `layer` or `canBecomeKey` a future content
 * window registers with. (Earlier this rested on `isAppResignSweepEligible`
 * requiring `!canBecomeKey` while this predicate requires `canBecomeKey` —
 * true of every production window at the time, but not a constructional
 * guarantee, and the property suite's generator did produce a counterexample
 * once `isAppResignSweepEligible` stopped testing `canBecomeKey` at all; the
 * explicit clause closes that gap for good.) A property invariant asserts the
 * disjointness rather than leaving it to this comment. The resign sweep's
 * `selectTransientAutoclose(state, null)` call is also disjoint: it
 * takes only transient roles, none of which are in `CONTENT_ROLES`.
 *
 * ONE PREDICATE, NOT THE ONLY ONE. Two upcoming callers want a NARROWER set
 * and must not be served by widening this one: `tile-ipc.ts`
 * `tileResolveWebWindow` and `tile:window:devtools` want http/https content
 * only. That needs a URL fact this kernel does not carry yet (the old
 * `WindowRecord.lastHttpUrl`); until it does, those callers post-filter.
 *
 * A WIDER sibling exists too, and is the one to reach for instead of loosening
 * this predicate: `isFrontEligibleWindow`, below, admits `quick-view` (a peek
 * or a slide) where this predicate excludes it. The Cmd+W target
 * (`windows.ts resolveFocusedWindowIdForClose`) is a COMPOSITION over THAT
 * predicate, not over this one and not a fourth predicate of its own: the key
 * window when it is itself front-eligible, else `topmost(state,
 * isFrontEligibleWindow)`. A composition over `isContentWindow` here would
 * exclude a focused peek from being its own close target and fall through to
 * whatever page host sits behind it — see `isFrontEligibleWindow`'s doc for
 * why the two predicates diverge on that one role.
 */
export function isContentWindow(record: WindowRecord): boolean {
  if (!record.visible) return false;
  if (record.pendingHidden) return false;
  if (!record.canBecomeKey) return false;
  return roleIn(CONTENT_ROLES, record.role);
}

/**
 * The window CLASSES that never keep the app on screen. Ported verbatim from
 * `windows.ts APP_HIDE_EXCLUDED_CLASSES`, which carried this note about where
 * each entry came from:
 *   - 'background'                     was: the web-core address
 *   - 'quick-view'/'palette'/'overlay' was: the transient roles
 *   - 'hud'                            was: role 'utility' + not focusable
 *
 * A CLASS SET, not the record's `satellite` flag, and the reason is in the two
 * disagreements: a quick-view is `satellite: false` yet does not hold the app
 * open, while a detached devtools window (`satellite: true`) and the
 * extension-UI popups are real surfaces the user is looking at, and always
 * did keep it open.
 */
const APP_HOLD_EXCLUDED_CLASSES: ReadonlySet<string> = new Set([
  'background',
  'quick-view',
  'palette',
  'overlay',
  'hud',
]);

/**
 * THIS WINDOW IS A REASON FOR PEEK TO STAY ON SCREEN — a surface the user is
 * actually looking at, as opposed to chrome, a peek, or the invisible
 * background window.
 *
 * The one input to `react`'s app-hide rule, and it replaces `windows.ts
 * getVisibleWindowCount`, whose `excludeId` parameter has no counterpart here:
 * that argument existed because the closing window's native hide had not yet
 * echoed into the machine when the old caller counted, and asking `next.order`
 * inside the transition that removed or hid it does not have that problem.
 */
export function holdsAppOnScreen(record: WindowRecord): boolean {
  // `visible` ALONE, deliberately — no `pendingHidden` clause, unlike
  // `isContentWindow` above. A window on its way out is still on the screen,
  // and the app must not step aside while the user can still see it: gating on
  // the intent instead of the fact made every teardown REQUEST hide the app,
  // including requests that never complete. The real edge is the visibility
  // report that follows, and that is what this reads.
  if (!record.visible) return false;
  return !APP_HOLD_EXCLUDED_CLASSES.has(record.class);
}

/**
 * The old `window-state.ts isEligibleFront` rule (`visible && !satellite &&
 * live`) preserved as a rule of its own, not folded into `isContentWindow`
 * above and not a replacement for it. Names the set `isEligibleFront` named:
 * a window visible, able to take keystrokes, and not one of the
 * `SATELLITE_ROLES` — the set the user is directly working in, in the sense
 * of "the window a close/reload/print command should act on if nothing more
 * specific is focused", rather than in the sense of "the standard document
 * window" `isContentWindow` answers for the kernel's own ordering and focus
 * rules (the successor raise, the focus-assert gate, transient dismissal).
 * `order` membership already stands in for the old rule's `live` clause — a
 * closed window is never in `order` at all (RULE 1).
 *
 * DELIBERATELY ADMITS `quick-view` WHERE `isContentWindow` EXCLUDES IT. A peek
 * or a slide is not a document the kernel should treat as AppKit's main window
 * — `isContentWindow`'s own doc explains why key shifting to a panel must not
 * move main — but it IS a window the user opened and is directly acting on:
 * typing into it, scrolling it, closing it. `role: 'quick-view'` is in neither
 * `CONTENT_ROLES` nor `SATELLITE_ROLES`, so it was silently swept into
 * `isContentWindow`'s exclusion when the Cmd+W target was ported to compose
 * over that predicate — a peek is a panel for the kernel's OWN purposes, but
 * it was never a satellite for the old machine's, and Cmd+W inherited the
 * wrong one of the two exclusions. `isContentWindow`'s docblock justifies
 * excluding `quick-view` with "Escape now targets key, so nothing is lost by
 * treating a peek as the panel it is" — that reasoning is specifically about
 * ESCAPE (which already reads `key`, unaffected by either predicate) and does
 * not carry to a close command, which has no target at all once both `key`
 * and `topmost` skip past the focused peek to the page host behind it.
 */
export function isFrontEligibleWindow(record: WindowRecord): boolean {
  if (!record.visible) return false;
  if (!record.canBecomeKey) return false;
  return !roleIn(SATELLITE_ROLES, record.role);
}

/**
 * A window record that counts as a base-layer page-host, with two clauses,
 * neither of which is optional:
 *
 *   - a role in `CONTENT_ROLES`,
 *     or `'quick-view'`             `kind: 'page-host'` alone is not enough to
 *                                   mean "a base-layer page" — `ipc.ts
 *                                   assembleHybridPageHost` registers EVERY
 *                                   hybrid page host with `kind: 'page-host'`,
 *                                   including peeks and slides, which
 *                                   register `role: 'quick-view'`.
 *
 *                                   `'quick-view'` is ADMITTED, not excluded.
 *                                   Peeks and slides are explicitly built to
 *                                   use the shared overlay's address bar —
 *                                   `features/peeks/background.js` and
 *                                   `features/slides/background.js` both open
 *                                   with `pageHost: true` under the comment
 *                                   "page-host shell with address bar (task
 *                                   ff3b18ba)", and neither ships a navbar of
 *                                   its own. Excluding the role left a
 *                                   frontmost peek framed by nothing: with
 *                                   another page underneath, the chrome
 *                                   painted around that page instead — the
 *                                   window the user is NOT working in — and
 *                                   with the peek alone on screen, there was
 *                                   no address bar at all. A frontmost peek IS
 *                                   the window the user is working in, so this
 *                                   predicate has to name it, not whatever
 *                                   ordinary page happens to sit behind it.
 *   - `layer === BASE_LAYER`       a page-host is not confined to the base
 *                                   layer — one can sit in a floating band
 *                                   behind the cmd panel, a peek, or a slide,
 *                                   alongside base-layer page-hosts. `order`
 *                                   is insertion- and movement-ordered, never
 *                                   layer-sorted, so without this clause array
 *                                   position and visual stacking diverge with
 *                                   no error path — the topmost `order` entry
 *                                   need not be the topmost on screen. Real
 *                                   peeks/slides land at `BASE_LAYER` too
 *                                   (`izui-roles.ts deriveWindowLayer`: they
 *                                   declare no `alwaysOnTop`), so this clause
 *                                   never excludes them on its own.
 *
 * `visible` and `orderable` are carried over from the same reasoning
 * `isContentWindow` and the `SetStacking` emission (`react`) already apply: a
 * hidden window is not on screen to frame, and a page-host the OS cannot yet
 * z-order (before its first composited frame) cannot be the overlay's target.
 *
 * `!pendingHidden` for the same reason `isContentWindow` carries it: the
 * machine's own belief that this window is going away, ahead of the OS's
 * confirming echo (see that field's doc). Attaching the shared chrome
 * overlay singleton to a doomed host is the original overlay-attach defect
 * family this predicate exists to close.
 */
export function isBaseLayerPageHost(r: WindowRecord): boolean {
  return (
    r.kind === 'page-host' &&
    r.visible &&
    !r.pendingHidden &&
    r.orderable &&
    r.layer === BASE_LAYER &&
    (roleIn(CONTENT_ROLES, r.role) || r.role === 'quick-view')
  );
}

/**
 * `isFrontEligibleWindow`, clamped to `BASE_LAYER` and additionally excluding
 * a doomed window — the admitted set `topmostBaseLayerPageHost` below scans
 * `order` over. See that function's doc for why the clamp is needed at all,
 * `topmost`'s own doc for the one-layer contract the clamp holds, and the
 * "doomed vs. not-yet-ready" contrast on `topmostBaseLayerPageHost` for why
 * `!pendingHidden` belongs HERE — deliberately NOT on `isFrontEligibleWindow`
 * itself, whose other caller (the Cmd+W close target) must keep naming a
 * window the user is in the middle of closing.
 */
function isBaseLayerFrontEligible(r: WindowRecord): boolean {
  return isFrontEligibleWindow(r) && !r.pendingHidden && r.layer === BASE_LAYER;
}

/**
 * THE OVERLAY ATTACH TARGET — a *main-window* question (§0.1.5, "Key vs.
 * main"), not a key-window one: which window the user could be working in,
 * answered as "the topmost such window, attached to only if it is a
 * base-layer page host, and `null` otherwise". `null` is a real answer, and
 * the whole point of this shape — it is what tells the caller to DETACH the
 * shared chrome overlay, rather than leave it painted around a page the user
 * has moved on from.
 *
 * TWO STEPS, NOT ONE `topmost(state, isBaseLayerPageHost)` CALL, and the
 * split is load-bearing:
 *
 *   1. `topmost(state, isBaseLayerFrontEligible)` finds the topmost window
 *      the user could plausibly be working in, clamped to `BASE_LAYER`
 *      before the predicate is even applied.
 *   2. Only THEN is that window tested against `isBaseLayerPageHost`.
 *
 * WHY BAND-CLAMPED RATHER THAN SCANNING EVERY LAYER AND TESTING THE WINNER.
 * `order` is insertion- and movement-ordered, never layer-sorted (§0.1.6) —
 * see `topmost`'s own doc for the general rule this predicate exists to
 * satisfy: a `topmost` predicate whose admitted set spans layer bands can
 * return a window that is not visually topmost, with no error path. A single
 * `topmost(state, isBaseLayerPageHost)` call happens to hold that contract
 * (`isBaseLayerPageHost` already clamps to `BASE_LAYER`), but the OLD
 * one-line shape this replaces asked only that question — it could never
 * answer `null` while any base-layer page host was visible anywhere in
 * `order`, so focusing an ordinary base-layer browser window while a page
 * host was still visible left the query naming the page host regardless.
 * The fix is not to widen the predicate's admitted set — that would
 * reintroduce the cross-band defect above — but to test topmost-overall
 * (within the band) against the narrower fact.
 *
 * WHY NOT CONDITIONED ON `key`. The shared chrome overlay legitimately holds
 * key on Cmd+L (typing a URL takes key), so a query gated on "is the
 * topmost-and-key window a page host" would drop the attachment — and
 * therefore the chrome — every time Cmd+L moved key onto the overlay itself,
 * making the chrome flicker and re-attach on every keystroke. Excluding
 * satellites (which `isFrontEligibleWindow` already does, via
 * `SATELLITE_ROLES`) answers the same "is the user working in an ordinary
 * window or a panel" question without that flicker, because the overlay
 * holding key never changes which window is topmost among front-eligible
 * ones.
 *
 * WHY `isFrontEligibleWindow` AND NOT `isContentWindow`. `isContentWindow`
 * excludes `role: 'quick-view'` (peeks and slides) — see that predicate's own
 * doc for why panels don't become AppKit's main window. But a frontmost peek
 * or slide is exactly the window the user is working in, and it opens with
 * `pageHost: true` specifically to use the shared address bar and ships no
 * navbar of its own. Composing over `isContentWindow` here would skip a
 * frontmost peek/slide entirely and let the chrome frame whatever ordinary
 * page happens to sit behind it — the window the user is NOT working in.
 *
 * DOOMED VS. NOT-YET-READY — the topmost candidate can fail to be the attach
 * target for two structurally different reasons, and this query treats them
 * differently on purpose:
 *
 *   - DOOMED (`pendingHidden`): the machine has already decided this window
 *     is going away (a teardown request already accepted — see that field's
 *     doc). It is not a window the user could be working in, so
 *     `isBaseLayerFrontEligible` excludes it outright and the scan continues
 *     to the live window underneath — the same `!pendingHidden` reasoning
 *     `isContentWindow` already carries. Answering `null` instead, and
 *     waiting for the close to finish, would still be correct eventually, but
 *     it is the wrong shape for an everyday gesture: closing the frontmost of
 *     two page hosts (Cmd+W) would detach the overlay on the doomed host and
 *     then immediately re-attach it to the one underneath once `WindowClosed`
 *     retires the doomed record — two stacking replays (§0.1.6) for one
 *     gesture, an `A -> null -> A` shape that is a known self-sustaining input
 *     to a show/hide feedback loop this predicate is actively trying to damp.
 *     Skipping straight to the live successor keeps it to the one retarget
 *     the gesture actually needs.
 *   - NOT YET READY (`!orderable`): nothing has decided this window is going
 *     away — the user genuinely IS working in it, it just cannot be z-ordered
 *     until its content reports a first composited frame. `isBaseLayerPageHost`
 *     carries `orderable`, but `isBaseLayerFrontEligible` deliberately does
 *     NOT — so this case is NOT skipped in the first step. The topmost
 *     front-eligible window IS this one, it fails `isBaseLayerPageHost`, and
 *     the query answers `null` rather than falling through to an older,
 *     already-orderable page host underneath it. Falling through here would
 *     frame the chrome around the wrong window — one the user has already
 *     moved past. `null` self-heals, because the same `WindowContentOrderable`
 *     transition that flips the host orderable changes this query's answer
 *     without any other input moving.
 */
export function topmostBaseLayerPageHost(state: State): WindowRecord | null {
  const front = topmost(state, isBaseLayerFrontEligible);
  return front !== null && isBaseLayerPageHost(front) ? front : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transient autoclose — the role set and the selector, ported from
// `window-state.ts` (`TRANSIENT_ROLES`, `selectTransientAutoclose`). The
// exemption itself is NOT ported: it is a relation over `overlayFor` and
// `parentId`, not a role set — see §0 of `docs/design/window-manager.md`,
// "Ownership, not role."
//
// It is a QUERY, not a transition: it answers "which windows should be
// dismissed", and the caller turns each id into a `CloseOrHideWindow` command
// — which is where the keepLive branch already lives (§0.1, `decide`). That
// keeps `evolve` guard-free and keeps effects a structural diff, instead of
// teaching an event arm to sweep.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The roles that are TRANSIENT — they open and close frequently and ride above
 * the workspace. Ported VERBATIM from `izui-roles.ts TRANSIENT_ROLES` (which
 * `window-state.ts` also carried a copy of before it was deleted); both
 * remaining copies must agree.
 */
export const TRANSIENT_ROLES: ReadonlySet<string> = new Set(['palette', 'quick-view', 'overlay', 'switcher']);

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
 * Candidacy for the transient-dismissal law — the gate every reader of
 * `transientAutocloseExemption` applies BEFORE asking it anything, so the law
 * is asked only about a record it actually governs. A record is a candidate
 * either by role (`TRANSIENT_ROLES`) or by declaring `selfClosesOnBlur` —
 * `izui-roles.ts windowSelfClosesOnBlur`'s `modal` open option, which opens a
 * window carrying no role at all (the cmd panel is `type:'panel'`, roleless).
 * A `selfClosesOnBlur` candidate runs through the same four exemptions as any
 * other: a modal window parented to its focuser, or one an overlay is
 * attached to, is spared exactly like any other candidate would be.
 *
 * ALL THREE readers of the law — `selectTransientAutoclose`,
 * `traceTransientAutoclose`, and `evolve`'s `WindowRegistered` merge arm's
 * `strandedByRoleChange` check — call this instead of restating
 * `roleIn(TRANSIENT_ROLES, rec.role)` by hand, for the same reason
 * `transientAutocloseExemption` itself is shared rather than copied: a
 * restated candidacy test is exactly how one of the three came to omit a
 * clause silently.
 */
export function isTransientAutocloseCandidate(rec: WindowRecord): boolean {
  return roleIn(TRANSIENT_ROLES, rec.role) || rec.selfClosesOnBlur === true;
}

/** Which of the four exemption clauses in the transient-dismissal law spared a candidate. */
export type TransientAutocloseExemption = 'overlay-attached' | 'no-input' | 'focuser-relation' | 'newer-than-focuser';

/**
 * THE EXEMPTIONS OF THE TRANSIENT-DISMISSAL LAW, AS ONE STATEMENT. A
 * transient closes when it loses focus, always — `docs/design/window-manager.md`
 * § 0 — and this function is the whole of what spares one. It answers for a
 * SINGLE record already known to be a candidate: the caller owns candidacy
 * (not the focuser, transient role, and — where it applies — visible) and
 * owns iteration and output shape; this owns only the exemptions, in order.
 * `null` means nothing spares the record.
 *
 * Every reader of the law calls this: `selectTransientAutoclose` (the
 * decision), `traceTransientAutoclose` (the diagnostic), and `evolve`'s
 * `WindowRegistered` merge arm (which asks the degenerate, focuser-less
 * question about a record that is not yet in `state.order`). Restating the
 * clauses instead was how a copy came to be missing one: the merge arm
 * omitted `focuser-relation` silently, and nothing said whether that was a
 * decision or an oversight.
 *
 * The parameters are the only facts the exemptions read beyond the record
 * itself, and each is passed rather than derived so a caller with no focuser
 * (`undefined`) or no ordering floor (`null`) STATES that degenerate case
 * instead of expressing it by omission. `orderingFloor` is the focuser's
 * `openSeq` when a machine-caused focus armed the ordering test, and `null`
 * when no test is armed.
 *
 * Deliberately NOT parameterised by anything else — in particular there is no
 * "ignore visible" switch. Making the law's answer depend on which caller
 * asked is the exact defect this consolidation removes.
 *
 * Why each clause spares what it spares — the Space border, the shared chrome
 * overlay, the two live ordering failures — is documented on
 * `selectTransientAutoclose` below, which remains the law's prose home.
 */
export function transientAutocloseExemption(
  rec: WindowRecord,
  focuser: WindowRecord | undefined,
  orderingFloor: number | null,
): TransientAutocloseExemption | null {
  if (rec.overlayFor !== undefined) return 'overlay-attached';
  // Policy, not derivation — see `selectTransientAutoclose`'s doc for why and
  // for the Space border / chrome overlay cases this spares and does not spare.
  if (!rec.acceptsInput) return 'no-input';
  if (focuser?.parentId === rec.id || focuser?.overlayFor === rec.id) return 'focuser-relation';
  if (orderingFloor !== null && rec.openSeq > orderingFloor) return 'newer-than-focuser';
  return null;
}

/**
 * Which transient siblings a newly-focused window dismisses. A transient is
 * dismissed when some other window, not belonging to it, genuinely takes key
 * (`docs/design/window-manager.md` §0). "Belonging to it" is a relation, not
 * a role:
 *
 *   - skip the focuser itself, any non-visible window, any non-transient role;
 *   - a victim with `overlayFor` set is exempt — an attached overlay manages
 *     its own show/hide through the attachment relation
 *     (`WindowRecord.overlayFor`), never through a close, so an autoclose must
 *     never touch it;
 *   - a victim the FOCUSER points at — `focuser.parentId === victim.id` or
 *     `focuser.overlayFor === victim.id` — is exempt too: the focuser belongs
 *     to it, so this is not "some other window" taking key. Directional and
 *     one-hop on purpose: a window the transient merely creates (e.g. a
 *     command palette opening a page host) is NOT exempt, because that
 *     relation points the other way;
 *   - an UNREGISTERED focuser (no record) has no `parentId`/`overlayFor` to
 *     point anywhere — so it sweeps every visible transient.
 *   - `focusedId: null` means attention is on nothing of Peek's (a real
 *     app-deactivation settle) — it resolves no `focuser` record either, so
 *     it behaves exactly like an unregistered focuser and sweeps every
 *     visible transient. `rec.id === focusedId` is vacuously false (no `id`
 *     is ever `null`), and both relation clauses are already optional-chained
 *     off `focuser`, so no clause needs a null-specific branch.
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
 * In both, the missing fact was never "which relation" — the relations
 * involved are exactly the ones a legitimate switch must still sweep. The
 * missing fact was WHO asked for this focus and WHEN: `cause` states the
 * first (an executor report, never an inference) and `openSeq` supplies the
 * second.
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
 *
 * ONE MORE EXEMPTION, and it is POLICY, not a derivation: a victim that does
 * not accept input (`!rec.acceptsInput`) is spared. A window the pointer
 * passes through cannot be in the user's way, so nothing displaces it — that
 * is a decision about what dismissal is FOR, not a fact implied by the other
 * clauses. Today it spares exactly one window, the Space border
 * (`features/spaces/background.js showBorder`): a click-through, `role:
 * 'overlay'` ambient annotation meant to stay visible while the user works in
 * other applications, which every OTHER clause here admits as a victim (never
 * attached to a host, so `overlayFor` does not exempt it either). A FUTURE
 * click-through window that wants to be dismissed on an app blur would be
 * silently denied that by this clause — there is no carve-out for it, because
 * none is needed yet.
 *
 * The shared chrome overlay is click-through too, and is already exempt by
 * its attachment relation (`overlayFor !== undefined`, above) — but the two
 * exemptions are not redundant, because they cover DISJOINT parts of its
 * life. Before its first `AttachOverlay` lands, `overlayFor` is still absent,
 * so only the click-through clause protects it. Once attached, while the
 * pointer sits over real chrome and `wireClickCapture` has turned capture on
 * (`acceptsInput: true`), only the relation does — the click-through clause
 * has nothing left to exempt at that moment. Neither clause covers the whole
 * life on its own.
 */
export function selectTransientAutoclose(
  state: State,
  focusedId: WindowId | null,
  cause: FocusCause = WORLD_CAUSE,
): WindowId[] {
  const focuser = state.order.find((w) => w.id === focusedId);
  // The ordering floor is armed ONLY by a machine cause on a registered
  // focuser — an unregistered one has no `openSeq` to compare against, so it
  // sweeps everything whatever the cause.
  const orderingFloor: number | null = cause.kind === 'machine' && focuser !== undefined ? focuser.openSeq : null;
  const out: WindowId[] = [];
  for (const rec of state.order) {
    if (rec.id === focusedId) continue;
    if (!rec.visible) continue;
    if (!isTransientAutocloseCandidate(rec)) continue;
    if (transientAutocloseExemption(rec, focuser, orderingFloor) !== null) continue;
    out.push(rec.id);
  }
  return out;
}

/** One candidate's fate, as decided by `traceTransientAutoclose`. */
export type TransientAutocloseTrace =
  | { id: WindowId; dismissed: true }
  | { id: WindowId; dismissed: false; exemption: TransientAutocloseExemption };

/**
 * `selectTransientAutoclose`, restated as a per-candidate trace instead of a
 * bare victim list — the recurring bug shape in this subsystem is a rule that
 * matches nothing, and a list of dismissed ids cannot show that: it looks
 * identical whether nothing WAS a candidate or everything that was got
 * spared. This exists purely so `window-kernel-executor.ts` can log the
 * difference (§ diagnostics — this file keeps zero value imports and cannot
 * log anything itself).
 *
 * The EXEMPTIONS are not restated here: both this and
 * `selectTransientAutoclose` ask `transientAutocloseExemption`, so
 * `dismissed: true` is exactly that function's return set by construction
 * rather than by two copies being kept in lockstep. What stays separate is
 * everything the two do NOT share — the candidacy filters (not the focuser,
 * visible, transient role), the iteration, and the output shape — because the
 * two are read independently for different audiences, a decision function and
 * a diagnostic one, and neither should have to carry the other's shape. That
 * separation is sound; sharing the exemptions is not optional, because they
 * are the law and a law with two statements can disagree with itself.
 *
 * Non-candidates (the focuser itself, a hidden window, a non-transient role)
 * are OMITTED rather than traced with a reason: they were never in the
 * sweep's consideration set, so a caller logging "spared" for one of them
 * would manufacture a decision that was never made. Only genuine candidates
 * — visible, transient-role, not the focuser — appear here.
 */
export function traceTransientAutoclose(
  state: State,
  focusedId: WindowId | null,
  cause: FocusCause = WORLD_CAUSE,
): TransientAutocloseTrace[] {
  const focuser = state.order.find((w) => w.id === focusedId);
  const orderingFloor: number | null = cause.kind === 'machine' && focuser !== undefined ? focuser.openSeq : null;
  const out: TransientAutocloseTrace[] = [];
  for (const rec of state.order) {
    if (rec.id === focusedId) continue;
    if (!rec.visible) continue;
    if (!isTransientAutocloseCandidate(rec)) continue;
    const exemption = transientAutocloseExemption(rec, focuser, orderingFloor);
    out.push(exemption === null ? { id: rec.id, dismissed: true } : { id: rec.id, dismissed: false, exemption });
  }
  return out;
}

/**
 * Which windows a REAL app switch hides for the duration — `evolve`'s
 * `AppResigned` arm applies exactly this on the raw resign edge (alongside the
 * attached-overlay hide), and `AppResignSettled` re-applies it only as a
 * backstop for a window that became eligible in the gap before the settle;
 * `AppActivated` undoes exactly what either marked.
 *
 *   - `layer > BASE_LAYER`    it floats above the whole regular stack — which
 *                             means it floats above OTHER applications'
 *                             windows too, not just Peek's own base-layer
 *                             content;
 *   - `acceptsInput`          a click-through window is an ambient annotation,
 *                             never something the user is blocked by — the
 *                             Space border (`features/spaces/background.js
 *                             showBorder`) is `role:'overlay'`, always-on-top,
 *                             and deliberately meant to stay visible while the
 *                             user works in OTHER applications
 *                             (`selectTransientAutoclose`'s own doc makes the
 *                             same call for the same window), so it must never
 *                             be admitted here regardless of layer;
 *   - `!selfClosesOnBlur`     the window already tears itself down the moment
 *                             it loses focus (`WindowRecord.selfClosesOnBlur`
 *                             — the `modal` open option, e.g. the cmd panel),
 *                             so hiding it here is redundant, and would stamp
 *                             `hiddenByAppBlur` on a record about to disappear
 *                             on its own;
 *   - `!isContentWindow(record)` a content window is never hidden by an app
 *                             switch — STATED here rather than left to the
 *                             coincidence that no production content window
 *                             floats above the base layer, which a pinned
 *                             window would silently defeat;
 *   - `visible`               nothing hidden for another reason may be
 *                             marked, or the re-show on activation would
 *                             resurrect it.
 *
 * NO ROLE CLAUSE and NO BARE `canBecomeKey` CLAUSE — this predicate used to
 * carry both, and each excluded a window it should have admitted. The rule it
 * derives from is `WindowRecord.hiddenByAppBlur`'s own doc: reversible
 * visibility leaves on the RAW resign edge; only DISMISSAL
 * (`selectTransientAutoclose`) waits for the settle, because dismissal is
 * destructive and the settle exists so the macOS activation dance cannot
 * trigger one. This predicate is for the OTHER case — a non-transient floater
 * above the base layer with no dismissal policy of its own, that must still
 * leave the screen on an app switch regardless of what role it declares or
 * whether it can hold key. The HUD (`renderer/hud/background.js` —
 * `role:'workspace'`, always-on-top, `canBecomeKey:false`) is the motivating
 * one; the chain popup (`renderer/cmd/panel.js openChainPopup`, `role:
 * 'utility'`, always-on-top, non-modal, `canBecomeKey: true`) is the one
 * `!canBecomeKey`, once carried here as a stand-in for "heads-up surface",
 * used to wrongly exclude.
 *
 * A TRANSIENT-role window (`role: 'switcher'`, `'palette'`, `'quick-view'`,
 * `'overlay'` — `TRANSIENT_ROLES`) can still pass every clause here: the
 * windows switcher floats, accepts input, and does not self-close, so this
 * predicate alone reads it as eligible. It never actually gets swept —
 * a transient window loses focus on ANY app resign under the uniform
 * dismissal law, so it is always a `selectTransientAutoclose` candidate too,
 * and `evolve`'s `dismissVictims` exclusion (see the `AppResigned` arm's own
 * doc) routes it to that dismissal instead of the reversible hide this
 * predicate would otherwise grant it. The two rules are kept from ever
 * double-claiming the same window at that CALL SITE, not by a role clause
 * here.
 *
 * `acceptsInput` is NOT a reintroduction of the role-clause mistake — it is
 * measured, not a role stand-in: the HUD registers `acceptsInput: true` for
 * its whole life (never calls `setIgnoreMouseEvents`) and keeps hiding with
 * the app exactly as before; the Space border calls
 * `setIgnoreMouseEvents(true, …)` in the same async open flow that creates it
 * (`tile-ipc.ts` feeds the resulting `WindowAcceptsInputChanged`), so by the
 * time any real app-resign reaches it `acceptsInput` already reads `false`
 * and this clause is what keeps it admitted-nowhere, matching its documented
 * purpose.
 *
 * NEITHER `layer > BASE_LAYER` NOR `!selfClosesOnBlur` is sufficient alone,
 * for the same reasons as before this clause list grew: the first would sweep
 * a window that already closes itself on blur (merely redundant, but would
 * still overwrite `hiddenByAppBlur` on a record about to be torn down
 * anyway), and the second would take every base-layer content window too —
 * `!isContentWindow` is what now makes that impossible BY CONSTRUCTION rather
 * than by production windows happening not to float.
 */
/**
 * May an `AppActivated` put this record back on screen?
 *
 * `hiddenByAppBlur` records that a window went off screen BECAUSE the app
 * stopped being active, and the activation undoes exactly those hides. An
 * ATTACHED OVERLAY is the one case that gets to refuse, because its visibility
 * belongs to its attachment rather than to the app lifecycle: the host may have
 * entered fullscreen while Peek was in the background — macOS allows exactly
 * that, which is why `AppActivated` reconciles fullscreen at all — and chrome
 * revealed over a fullscreen host is the one thing overlay follow has never
 * done. A host that went off screen meanwhile refuses for the same reason.
 *
 * A refusal LEAVES THE MARK SET rather than clearing it, deliberately: the
 * record is still off screen for the reason the mark names, and nothing has
 * happened to make that untrue. Any genuine `WindowShown` clears the mark, so a
 * stale one self-heals the moment something legitimately shows the window, and
 * the next resign/activate cycle re-asks this question against the host's mode
 * at that time.
 *
 * A dangling `overlayFor` cannot reach here — `WindowClosed` mechanically
 * detaches every overlay naming the closed host.
 *
 * BOTH SIDES REFUSE A DOOMED WINDOW too (see `WindowRecord.pendingHidden`'s
 * doc): the record itself, because an app activation must not resurrect a
 * window the machine has already decided to tear down onto the screen; and
 * the overlay's host, because revealing chrome over a doomed host is the
 * same defect the fullscreen-host refusal above already guards against.
 */
function appBlurRevealAdmits(state: State, record: WindowRecord): boolean {
  if (record.hiddenByAppBlur !== true) return false;
  if (record.pendingHidden) return false;
  if (record.overlayFor === undefined) return true;
  const host = state.order.find((w) => w.id === record.overlayFor);
  return host !== undefined && host.visible && !host.pendingHidden && host.fsMode.name === 'normal';
}

export function isAppResignSweepEligible(record: WindowRecord): boolean {
  return (
    record.visible &&
    record.layer > BASE_LAYER &&
    record.acceptsInput &&
    !record.selfClosesOnBlur &&
    !isContentWindow(record)
  );
}

/**
 * Whether a focus-family raise may legitimately land on this record — the
 * ONE condition `evolve`'s `AppActivated` and `FocusAssertRequested` arms
 * each stamp `lastOpSeq` on, and `react`'s focus-assert rule gates its
 * `RaiseWindow` on. All three used to restate this by hand;
 * `window-kernel-properties.test.ts checkOpSeqInvariants` requires
 * `opSeqCounter` to advance by exactly 1 iff the transition emits at least
 * one focus-family effect, which is what makes a drift between the three
 * copies a real bug rather than a style nit — this helper is the one place
 * that can no longer drift, because there is only one place.
 *
 * `visible` is supplied by the caller rather than read off `record`, because
 * `AppActivated` tests POST-RE-SHOW visibility (`record.visible === true ||
 * appBlurRevealAdmits(state, record)`, not `record`'s own pre-transition
 * value — see that arm's own doc), while `FocusAssertRequested` and
 * `react`'s rule both test the record's own current value directly.
 *
 * `pendingHidden` is read off `record` directly in every case: a window the
 * machine has already decided to tear down is never a legitimate raise
 * target, however visible it currently reads — asserting focus onto it is an
 * activating show onto a window already gone (see that field's doc). The
 * property generator reaches a focus assert on a content window only 3 times
 * in 84 runs (`window-kernel-properties.test.ts`, measured), far too rarely
 * to catch a hand-restated copy drifting apart from the other two — this
 * helper, not the generator, is what protects the invariant here.
 */
export function admitsFocusAssert(record: WindowRecord, visible: boolean): boolean {
  return visible && !record.pendingHidden;
}
