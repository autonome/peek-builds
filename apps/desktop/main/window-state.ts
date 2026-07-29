/**
 * window-state.ts — the ONE deterministic owner of front-window / fullscreen /
 * switcher / escape state for the desktop app.
 *
 * Blueprint: `docs/design/window-manager.md`. This module is the ONE owner of
 * rule R1 in that mandate: a single `AppWindowState` value mutated ONLY by
 * a pure, Electron-free reducer `reduce(state, event) -> { state, effects[] }`.
 * The reducer never touches Electron, never runs a timer, never performs a side
 * effect — it returns `effects[]` that an OS-boundary adapter (a later slice)
 * executes. Illegal states are made unrepresentable in the type shape; a front
 * invariant is re-established after every transition.
 *
 * SCOPE (first slice): this file + its test are self-contained. NOTHING in the
 * app imports this module yet — consumers are cut over seam-by-seam in later
 * slices (§3). This slice changes zero runtime behavior.
 *
 * Electron-free by construction: there is NO `import ... from 'electron'` here.
 * The reducer is loadable and testable under plain `node --test` /
 * `electron --test` with no display and no window plumbing.
 */

// ─────────────────────────────────────────────────────────────────────────────
// State shape — illegal states unrepresentable (§2.2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The WM's own window identity — an opaque branded string (`"wm-1"`, `"wm-2"`),
 * minted ONLY by the WM (the OS adapter's `registerWindow`, from a WM-internal
 * counter). Never an Electron window id, never a webContents id.
 *
 * Why a STRING brand: the failure mode this type exists to kill is numeric
 * indistinguishability — Electron window ids and webContents ids are both small
 * integers, so a mix-up is silent (design §3, "three colliding id spaces"). A
 * number brand only helps at compile time and evaporates over IPC; a string is
 * runtime-distinguishable (`typeof`/prefix check) and log-greppable (`wm-` never
 * collides with a bare number in a trace).
 *
 * The adapter maps `WindowId ↔ platform handle` internally and never leaks the
 * platform id (design §3: "the backend maps WindowId -> platform handle
 * internally").
 */
export type WindowId = string & { readonly __brand: 'WindowId' };

/** Plain rectangle (mirrors Electron's `Rectangle`, kept local so this file is Electron-free). */
export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type WindowKind = 'page-host' /* BaseWindow + WebContentsView */ | 'browser';

/**
 * Special window classes (design §4.3 dim 8b) — a CLOSED enum. Every window
 * carries exactly one class, declared at registration; the class replaces the
 * 8+ per-module window singletons (`main.ts mainWindow`, `core-glue.ts
 * coreBackgroundWindow`, `test-fixture-glue.ts testFixtureWindow`,
 * `chrome-extensions.ts` bridge/UI maps as class-tagged records, …) and the
 * HUD-sniffing predicate (`isAlwaysOnTop() && !isFocusable()` + the
 * `__hudHidden` expando — both deleted in §5 step 4).
 *
 *   - `primary`      ordinary user-facing content window (page hosts, tiles)
 *   - `quick-view`   peeks/slides — front-eligible transients
 *   - `overlay`      chrome overlay / switcher overlay surfaces
 *   - `palette`      command palette / modal picker surfaces
 *   - `hud`          always-on-top non-focusable heads-up display
 *   - `background`   the hidden core background renderer
 *   - `bridge`       hidden chrome-extension bridge windows
 *   - `offscreen`    hidden chrome.offscreen polyfill document windows
 *   - `extension-ui` chrome-extension popup/options UI windows
 *   - `test-fixture` the Playwright test-fixture renderer
 *   - `devtools`     a detached devtools window
 */
export type WindowClass =
  | 'primary'
  | 'quick-view'
  | 'overlay'
  | 'palette'
  | 'hud'
  | 'background'
  | 'bridge'
  | 'offscreen'
  | 'extension-ui'
  | 'test-fixture'
  | 'devtools';

/**
 * A window's stacking level (§4.3 dim 3, §5 step 5) — how it participates in
 * z-order. Derived ONCE per registration by `deriveStackingLevel` (the single
 * owner of the rule), stored on the record:
 *
 *   - `stacked`  participates in the ordered stack (`AppWindowState.stackOrder`):
 *                primary, quick-view, extension-ui — the windows the user
 *                actually layers.
 *   - `pinned`   floats ABOVE the whole regular stack (hud / overlay / palette).
 *                Their above-ness is realized by the existing `SET_ALWAYS_ON_TOP`
 *                pin (macOS window level 'floating'), NOT by list position —
 *                the ordered stack never contains them, and `SET_STACKING`
 *                (a same-level relative raise) could not express them anyway.
 *   - `excluded` never on the user-visible stack in an orderable sense:
 *                background / bridge / offscreen / test-fixture / devtools plus any other
 *                satellite (modal dialogs, focusable:false surfaces) — their
 *                z-relationship is OS/parent-managed, not machine-ordered.
 */
export type StackingLevel = 'stacked' | 'pinned' | 'excluded';

/** The window's ESC override. 'ignore' passes ESC straight through to the page. */
export type EscapeMode = 'auto' | 'close' | 'navigate' | 'ignore';

/**
 * Fullscreen is a MODE with explicit async edges, not a boolean.
 *
 * `preBounds` (the pre-fullscreen window rectangle to restore on exit / persist)
 * lives INSIDE the non-normal variants: it CANNOT exist for a `normal` window,
 * and a `fullscreen` window cannot lack the *concept* — `preBounds: null` is the
 * legitimate "OS/green-button entry where no stash was possible" case. This
 * encodes the `aa34cb50` fullscreen-lookalike session-save fix STRUCTURALLY:
 * `null` here means "genuinely no stash", never "field missing / defaulted".
 */
export type FsMode =
  | { name: 'normal' }
  | { name: 'entering-fullscreen'; preBounds: Rectangle | null; pendingDesire?: boolean }
  | { name: 'fullscreen'; preBounds: Rectangle | null }
  | { name: 'leaving-fullscreen'; preBounds: Rectangle | null; pendingDesire?: boolean };

export interface WindowRecord {
  id: WindowId;
  kind: WindowKind;
  /** Existing IZUI role vocabulary (palette / quick-view / overlay / workspace / content / child-content / utility). */
  role: string;
  /**
   * The window's class (closed enum, §4.3 dim 8b). Declared at registration
   * (`classifyWindowRegistration` for ordinary windows; the special classes
   * are declared explicitly by their glue modules). Singleton lookups
   * (`getCoreBackgroundWindow`, `getTestFixtureWindow`, the HUD hide/show
   * sweep) are lookups by this field now.
   */
  class: WindowClass;
  /**
   * The registered parent window (from the open params' `parentWindowId`,
   * converted to a WindowId at registration). Closing a window with a parent
   * hands `front` back to the parent — the reducer transition that replaced
   * the `main.ts browser-window-created → 'closed' → parentWin.focus()` block.
   */
  parentId?: WindowId;
  /**
   * The window-manager registry payload the deleted `main.ts windowRegistry`
   * Map used to hold (§4.1 dim 1a): the opening source address plus the open
   * params. `params` is OPAQUE app data to the reducer — it is stored BY
   * REFERENCE and legacy consumers still mutate it in place
   * (`params.currentUrl`, `params.x/width`, …); the reducer itself never
   * reads inside it. Both fields are absent for windows that never carried a
   * registry payload (tile windows, bridge/offscreen/background/test-fixture/devtools),
   * which is exactly how the numeric-id seam (`main.ts getWindowInfo` /
   * `getAllWindows`) preserves the old registry's membership.
   */
  source?: string;
  params?: Record<string, unknown>;
  /**
   * keepLive policy (§4.3 dim 4, §5 step 6): a window opened with
   * `keepLive: true` (e.g. the left slide playing music) is HIDDEN on
   * close-or-hide, never closed, so its content keeps running and the
   * window-open key/url-reuse path can re-show it. First-class on the record
   * (NOT read out of the opaque `params` bag) because the reducer's
   * `WINDOW_CLOSE_OR_HIDE_REQUESTED` clause branches on it: keepLive →
   * `HIDE_WINDOW`, else → `CLOSE_WINDOW`. Set at registration; the
   * `WINDOW_PARAMS_SET` merge can also carry it (the payload-after-
   * registration path, e.g. the hybrid test bridge).
   */
  keepLive?: boolean;
  /**
   * Set while a `hud`-class window is hidden by the APP_RESIGNED sweep, so
   * APP_ACTIVATED re-shows exactly the windows that sweep hid — the
   * structural replacement for the deleted `(win as any).__hudHidden` expando.
   */
  hiddenByAppBlur?: boolean;
  /**
   * OVERLAY ATTACHMENT (§4.3 dim 3b, §5 step 9). Set on an OVERLAY record: the
   * HOST window this overlay frames. Absent = detached (the overlay belongs to
   * nothing and must not be on screen).
   *
   * This one relation replaces `hybrid-overlay.ts`'s module-level
   * `followedBaseWin` / `onFollowedMove` pair plus its per-follow live queries
   * (`baseWin.getBounds()`, `baseWin.isFullScreen()`, `overlayWin.isVisible()`).
   * Attach / retarget / detach are the ONE transition
   * (`OVERLAY_ATTACH_REQUESTED`, host `null` = detach), and the follow is driven
   * by the host's `BOUNDS_CHANGED` — command + event, never query (§3).
   *
   * Deliberately stored on the OVERLAY (one host per overlay) rather than a
   * `hostId -> overlayId` map: the app has ONE shared chrome overlay, and this
   * direction makes "is this overlay attached, and to what?" a record read while
   * the reverse ("does this host have an overlay?") stays a scan of a handful of
   * records (`overlayIdForHost`).
   */
  overlayFor?: WindowId;
  escapeMode?: EscapeMode;
  /**
   * Satellite = a surface that can hold OS focus but is never "the window the
   * user is working in": the shared chrome overlay, command palette / modal
   * dialogs, the switcher overlay, HUD. Generalizes the registry's overlay
   * focus-group AND the resolver's modal exclusion into one declared property,
   * set at registration. A satellite can NEVER become `front`.
   */
  satellite: boolean;
  visible: boolean;
  /**
   * The record's stacking level (§4.3 dim 3) — see `StackingLevel`. Derived by
   * `deriveStackingLevel` at registration (and re-derived on the richer
   * re-registration merge, which can flip `satellite`). `stacked` + `visible`
   * is exactly membership in `AppWindowState.stackOrder`.
   */
  stackingLevel: StackingLevel;
  /**
   * Whether the window's NSWindow can actually be z-ordered yet. TRUE from
   * birth for a `browser` window; a `page-host`'s WebContentsView NSWindow
   * silently NO-OPS relative raises until its content has produced a first
   * composited frame, so page-hosts start FALSE and flip on the
   * `WINDOW_CONTENT_ORDERABLE` event (whose reducer clause re-drives
   * `SET_STACKING` for the window and everything stacked above it — the
   * machine form of `session.ts reassertStackingOrder`'s first-frame re-assert,
   * with no timer and no poll). Never reset: compositing survives hide/show,
   * and a re-fire against an already-orderable window is structurally inert
   * (the legacy listener's "disarm so a stray late frame can't restack").
   */
  orderable: boolean;
  fsMode: FsMode;
  /**
   * The window's last OS-reported outer bounds (§4.2 dim 2, §5 step 7A).
   * Seeded at registration from the backend's one boundary read (§5 step 7B
   * — see the WINDOW_REGISTERED `bounds` field doc) and from then on written
   * SOLELY by the `BOUNDS_CHANGED` clause — the machine's mirror of
   * native reality (the backend's resize/move listeners), never a live
   * `getBounds()` question at decision time (§3: command + event, never
   * query). Absent only when registration carried no rect and no native
   * report has arrived. Deliberately an honest
   * mirror: it also tracks the transient fullscreen rect — the restorable
   * pre-fullscreen geometry lives structurally in `fsMode.preBounds`
   * (the aa34cb50 lookalike trap), not here.
   */
  bounds?: Rectangle;
  /**
   * Maximized is a MACHINE-owned flag, set/cleared ONLY by the
   * MAXIMIZE_REQUESTED / UNMAXIMIZE_REQUESTED transitions — never an OS
   * `isMaximized()` question (§4.2 dim 2): frameless / panel-style macOS
   * windows don't reliably flip Electron's native maximize flag (the
   * tile-ipc.ts + hybrid-page-host-registry distrust workarounds this
   * absorbs), so the app's own intent is the single truth. "Maximize" here
   * is the app's work-area snap (a SET_BOUNDS effect), not the platform
   * `maximize()` call.
   */
  maximized: boolean;
  /**
   * The outer bounds the window had immediately before it was maximized —
   * the rect UNMAXIMIZE_REQUESTED restores. Non-null ONLY while `maximized`
   * (the two transitions maintain the pairing); `null` while maximized means
   * "no stash was possible" (no bounds had ever been reported), mirroring
   * `FsMode.preBounds: null`.
   */
  preMaxBounds: Rectangle | null;
  /**
   * Whether the window is pinned to EVERY macOS Space (§4.2 dim 7b, §5 step
   * 10). Today the platform call (`setVisibleOnAllWorkspaces`) is write-only:
   * it is issued at open time and never read back, so nothing in the app can
   * answer "is this window on all Spaces?" without asking the OS — the query
   * half §3 forbids. This field is the machine's record of that intent,
   * declared by `SET_VISIBLE_ON_ALL_SPACES_REQUESTED` (raw) or
   * `SPACES_POLICY_REQUESTED` (role-derived) and readable from state
   * afterwards. `false` for every window until asked otherwise (the platform
   * default), and preserved across a re-registration merge like every other
   * LIVED field.
   *
   * Note an `anchor` policy leaves this `false` — its true→false pair ends
   * unpinned by design, and "anchored to a Space" is exactly what `false`
   * means. So this field records where the window IS, not which policy put it
   * there; nothing today needs to tell "anchored via the pair" apart from
   * "never touched", so no policy field exists.
   */
  visibleOnAllSpaces: boolean;
  /**
   * A `DISPLAY_CHANGED` projection computed while the window was blocked from
   * receiving it (non-`normal` `fsMode`, or `visible:false`) — held here
   * instead of discarded, so a resolution/display change that lands mid-
   * fullscreen or while hidden isn't lost. Overwritten (last projection wins)
   * by a later `DISPLAY_CHANGED` while still blocked. Flushed as a `SET_BOUNDS`
   * — and cleared — by `flushPendingProjection`, called from every transition
   * that lifts the block (the `→ normal` `fsMode` transitions, `WINDOW_SHOWN`),
   * but only once BOTH axes (`fsMode: 'normal'` AND `visible`) are clear; it
   * stays held if only one axis unblocks. Also cleared — WITHOUT flushing — by
   * an explicit bounds write (`SET_BOUNDS_REQUESTED` / `MAXIMIZE_REQUESTED` /
   * `UNMAXIMIZE_REQUESTED`) via `discardPendingProjection`, so a stale
   * projection can never snap a deliberately-moved window back. `null` when
   * nothing is held (the common case).
   */
  pendingProjectedBounds: Rectangle | null;
  /** MRU counter (absorbs `focus-order.ts`). Higher = more recently focused. */
  focusSeq: number;
  /**
   * Registration order (§4.4 dim 4b): a monotonic stamp taken from
   * `AppWindowState.openSeqCounter` when the record is CREATED. Higher = opened
   * later. Never reassigned — the richer re-registration merge preserves it,
   * because "when did this window come into being" is lived state, not spec.
   *
   * Exists for exactly one decision: the transient autoclose needs to know
   * whether the window it is about to dismiss was opened BEFORE or AFTER the
   * action that produced this focus (see `selectTransientAutoclose`). Deliberately
   * a reducer-owned counter and not a clock: `window-state.ts` has zero value
   * imports, and ordering — not elapsed time — is the whole fact.
   *
   * NOT persisted in the session descriptor, on purpose: it is runtime ordering
   * within one app lifetime. A restored window must be numbered by when THIS run
   * opened it, not inherit a stale stamp from the run that saved it — a restored
   * host carrying a low saved seq would consider every window of the new session
   * "newer" and stop sweeping them forever.
   */
  openSeq: number;
  /**
   * Whether this window has EVER been shown with activation intent
   * (`WINDOW_SHOW_REQUESTED { activate: true }`) — the app saying "put the user
   * in this window", which is what makes the focus that eventually arrives the
   * completion of an action rather than a fresh user gesture. Arms the
   * first-focus clause in `selectTransientAutoclose`.
   *
   * A restore's inactive show (`activate: false`) deliberately does NOT set it:
   * such a window's first focus comes much later, from a genuine user raise, and
   * must sweep normally.
   */
  shownWithActivateIntent?: boolean;
  /**
   * Whether an `OS_FOCUS_GAINED` has ever landed on this window. Written SOLELY
   * by that arm — NOT by `WINDOW_SHOWN { focused: true }`, which is a
   * registration-time visibility import rather than evidence the OS moved focus
   * (the same distinction the autoclose clause itself makes). Absent = "no OS
   * focus reported yet", the same "nothing reported yet" default as
   * `hiddenByAppBlur`.
   */
  hasHeldOsFocus?: boolean;
  /** Absorbs `lastContentWindowId` (devtools target). */
  lastHttpUrl?: string;
  /**
   * Whether this window's renderer WebContents currently holds macOS
   * first-responder status (§5 step 11 — the front/first-responder
   * collapse). Written SOLELY by `CONTENT_FIRST_RESPONDER_CHANGED`, the
   * backend's mirror of the native `rendererWC 'focus'`/`'blur'` events —
   * never a live `wc.isFocused()` question at a decision site (§3). Absent
   * at registration (same "nothing reported yet" default as
   * `hiddenByAppBlur`). Purely additive for now: nothing reads this yet.
   */
  contentFocused?: boolean;
}

/** Mirrors the IZUI session coordinator's tri-state (idle / transient / active). */
export type IzuiSession = 'idle' | 'transient' | 'active';

export type SwitcherState =
  | { open: false }
  | {
      open: true;
      /**
       * The overlay window rendering the switcher, or `null` while the machine
       * has requested the open but the overlay window does not exist yet
       * (`SWITCHER_OPENED` fixes it up to the real id). Replaces the old `-1`
       * numeric sentinel.
       */
      windowId: WindowId | null;
      previousFront: WindowId | null;
    };

export interface AppWindowState {
  appActive: boolean;
  /**
   * Mirrors the IZUI coordinator's session tri-state. NOT a first-class window
   * dimension — it exists solely so `decideEscape` step 6 can consult the ported
   * `escPolicy`/`escUnhandledPolicy` tables (§2.4). See the divergence note in the
   * module header of the test file.
   */
  session: IzuiSession;
  /**
   * THE target window. Replaces both `lastFocusedVisibleWindowId` (S1) and
   * `activeHybridWindowId` (S2) as separate truths. Invariant (re-established
   * after every transition): `front` is `null` or refers to a live, visible,
   * non-satellite record.
   */
  front: WindowId | null;
  /**
   * The ordered stack (§4.3 dim 3): BOTTOM → TOP, last element = topmost. The
   * machine's INTENDED z-order for the level-`stacked` windows — the state
   * that "owned nowhere" z-order becomes (§6). Membership is exactly the
   * records with `stackingLevel: 'stacked' && visible: true`; `pinned`
   * records float above it via `SET_ALWAYS_ON_TOP`, `excluded` records never
   * enter. Maintained by the transitions:
   *   - WINDOW_SHOWN raises the shown window to the top (native show /
   *     showInactive both order the window frontmost);
   *   - WINDOW_HIDDEN / WINDOW_CLOSED remove it;
   *   - `applyRaiseRequest` raises its target to the top whenever it drives
   *     the OS (`RAISE_WINDOW` + `SET_STACKING` + this mirror, one emitter),
   *     and `applyOsFocusRealized` mirrors an OS-reported focus landing on
   *     `front` to the top without driving anything;
   *   - WINDOW_CONTENT_ORDERABLE re-drives `SET_STACKING` to converge native
   *     order onto this list as page-hosts become orderable;
   *   - STACK_ORDER_IMPORTED replaces the list wholesale with a persisted
   *     bottom→top order (session restore) and drives the whole order.
   * Fullscreen transitions do NOT change membership: fullscreen is a display
   * mode (the window occupies its own Space), not a stacking removal, and a
   * relative raise against it is a harmless native no-op.
   */
  stackOrder: WindowId[];
  switcher: SwitcherState;
  windows: Map<WindowId, WindowRecord>;
  /** Monotonic source for `WindowRecord.focusSeq`. */
  focusSeqCounter: number;
  /**
   * Monotonic source for `WindowRecord.openSeq` — bumped once per record
   * CREATION (never on a re-registration merge). Reducer state rather than a
   * module-level counter or a clock: the reducer is pure and imports no values,
   * so the only place a number can come from is the state it was handed.
   */
  openSeqCounter: number;
  /**
   * The ONE outstanding renderer escape question (`ASK_RENDERER`), or null when
   * no answer is awaited. The renderer answer arrives asynchronously (up to the
   * IPC timeout), so it MUST be judged against the state that asked it, not
   * whatever state happens to be current when it lands: during the wait the
   * session can flip, the switcher can open, the window can close, or a newer
   * Esc can supersede this one — and each of those changes the step-6 policy
   * outcome. `seq` is the epoch token: an answer whose `seq` does not match the
   * pending ask is stale and produces NOTHING. Every clause that invalidates the
   * question clears this field, which is what makes a stale answer inert
   * (structural, not a timer or a guard flag).
   */
  escAsk: { id: WindowId; seq: number } | null;
  /** Monotonic source for `escAsk.seq`. Never reset while the app runs. */
  escSeq: number;
  /**
   * ARMED app-resign transient sweep (§4.4 dim 4b, §5 step 9) — the structural
   * replacement for `ipc.ts`'s `pendingAppResignClose` setTimeout HANDLE.
   *
   * The problem the timer existed for: macOS fires a brief `did-resign-active`
   * → `did-become-active` DANCE (no real app switch) during startup restore and
   * around overlay/activation transitions, and dismissing the hybrid transients
   * on the resign edge of that dance is what made "the slide hotkey did nothing
   * the first time after startup" (peek 8e5c3174, second half). The old code
   * deferred the close by `HYBRID_APP_RESIGN_SETTLE_MS` and had
   * `did-become-active` `clearTimeout` it.
   *
   * Here the DECISION and its CANCELLATION are pure state, not a timer:
   * `APP_RESIGNED` ARMS this flag (and closes nothing), `APP_ACTIVATED` DISARMS
   * it — that disarm IS the dance cancel — and `APP_RESIGN_SETTLED` is inert
   * unless it is still armed. A settle signal that arrives after the app came
   * back can therefore close nothing at all, which is the property the
   * `clearTimeout` was buying. The reducer NEVER schedules: the settle signal's
   * timing belongs to whatever produces `APP_RESIGN_SETTLED` at the OS boundary
   * (no producer is wired in this slice), and no timing choice out there can
   * make the reducer dismiss a surface the user is back in front of.
   */
  pendingAppResignSweep: boolean;

  /**
   * The window a COLD-START restore asked to be re-raised on the FIRST
   * `APP_ACTIVATED` after it finished, or null. One-shot: `APP_ACTIVATED`
   * consumes and clears it (§5 step 11).
   *
   * Why it exists: restore raises + activates the saved-focused descriptor, but
   * the macOS startup activation dance can fire a FINAL `did-resign-active`
   * AFTER that, re-stranding Peek behind the previous app (its menubar, its key
   * window). The next `did-become-active` is the moment to put the saved-focused
   * window back in front — so the latch replays that window through
   * `applyRaiseRequest`, the single `RAISE_WINDOW` emitter, which drives the
   * raise (+ content first responder for a page-host) and the stacking. `front`
   * itself is NOT assigned here: it is a pure projection of OS focus, so the
   * raise's own focus event is what moves it. This was `session.ts`'s pair of
   * module-level lets (`_coldStartReassertArmed` / `_coldStartReassertId`) plus a
   * `reassertColdStartFocusOnce()` that called the OS itself.
   *
   * No timer, as before: the latch is armed by `COLD_START_FOCUS_ARMED` and
   * driven by a real lifecycle event. Arming is the restore's decision (cold
   * start + non-headless + the window is actually there); firing is the
   * machine's.
   */
  pendingColdStartFocus: WindowId | null;
}

export function createInitialState(): AppWindowState {
  return {
    appActive: true, // at launch Peek IS the active app (mirrors the coordinator)
    session: 'idle',
    front: null,
    stackOrder: [],
    switcher: { open: false },
    windows: new Map(),
    focusSeqCounter: 0,
    openSeqCounter: 0,
    escAsk: null,
    escSeq: 0,
    pendingAppResignSweep: false,
    pendingColdStartFocus: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Event alphabet (§2.3) — normalized by the OS adapter; no payload shape here is
// Electron-typed.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One window's already-computed target rectangle, carried by `DISPLAY_CHANGED`
 * (§4.2 dim 7, §5 step 10). The projection math (`window-placement.ts
 * computePlacement` against the live display layout) runs AT THE DISPATCH SITE
 * and rides the event — same rule as `MAXIMIZE_REQUESTED.workArea`, because
 * this reducer keeps ZERO value imports (§4.2 dim 2b resolution).
 */
export interface ProjectedWindowBounds {
  id: WindowId;
  bounds: Rectangle;
}

export type WindowEvent =
  | {
      type: 'WINDOW_REGISTERED';
      id: WindowId;
      kind: WindowKind;
      role: string;
      satellite: boolean;
      escapeMode?: EscapeMode;
      lastHttpUrl?: string;
      /** Window class (§4.3 dim 8b). Optional on the raw event (defaults to 'primary'); the registration spec (`WindowSpec.class`) is required, so every real registration declares it. */
      class?: WindowClass;
      /** Parent linkage (open params `parentWindowId`, WM-id-converted at the registration seam). Drives the parent-refocus transition on WINDOW_CLOSED. */
      parentId?: WindowId | null;
      /** The old windowRegistry payload (§4.1 dim 1a): opening source + open params (opaque, stored by reference). */
      source?: string;
      params?: Record<string, unknown>;
      /** Declared always-on-top intent: registration emits SET_ALWAYS_ON_TOP (replaces the ipc.ts post-ctor `setAlwaysOnTop(true,'floating')` reinforcement). */
      alwaysOnTop?: boolean;
      /** keepLive policy declared at open time — see `WindowRecord.keepLive`. */
      keepLive?: boolean;
      /**
       * The window's outer bounds at registration time, read ONCE by the
       * backend (§5 step 7B — same boundary-read pattern as
       * `decideWindowRegistration`'s `nativeVisible`). Seeds the
       * `WindowRecord.bounds` mirror so a window that is never natively
       * resized/moved before its first MAXIMIZE_REQUESTED still has a real
       * rect to stash as `preMaxBounds` (a ctor-placed window fires no
       * `resize`/`move`, so BOUNDS_CHANGED alone leaves the mirror empty
       * until the first gesture). On a re-registration the LIVED mirror
       * wins; this only fills an absent one.
       */
      bounds?: Rectangle;
    }
  /**
   * Merge a windowRegistry payload onto an ALREADY-REGISTERED window — the
   * machine-side form of the old `main.ts registerWindow(id, source, params)`
   * writer (its callers run after `registerWindowWithMachine`). No-op for an
   * unknown id.
   */
  | { type: 'WINDOW_PARAMS_SET'; id: WindowId; source: string; params: Record<string, unknown>; keepLive?: boolean }
  /** App code wants this window CLOSED (guest-safe direct close — no keepLive policy; that is WINDOW_CLOSE_OR_HIDE_REQUESTED). */
  | { type: 'WINDOW_CLOSE_REQUESTED'; id: WindowId }
  /**
   * App code wants this window closed-or-hidden per its keepLive policy (§5
   * step 6A-1): the reducer — not the caller — decides from the record.
   * keepLive → `HIDE_WINDOW` (the backend hides; its native `hide` event is
   * what writes `visible:false`); else → `CLOSE_WINDOW` (the resolved close:
   * child windows + host). No producers wired yet — this lands the decision
   * only; the app-facing seam that dispatches it (`windows.ts
   * closeOrHideWindow`) is future work.
   */
  | { type: 'WINDOW_CLOSE_OR_HIDE_REQUESTED'; id: WindowId }
  /** App code wants this window forcefully DESTROYED (extension bridge/UI teardown, quit paths). */
  | { type: 'WINDOW_DESTROY_REQUESTED'; id: WindowId }
  /** App code wants this window shown (activate:false = show without stealing focus). */
  | { type: 'WINDOW_SHOW_REQUESTED'; id: WindowId; activate: boolean }
  /**
   * App code wants this window hidden but kept alive (§5 step 6A-4 — the
   * `tile:window:hide` / `hide-self` / `modWindow` affordances: re-shown
   * later via `WINDOW_SHOW_REQUESTED`, never a close). The backend hides;
   * its native `hide` event (`WINDOW_HIDDEN`) is what writes `visible:false`
   * — same acceptance as the 6A-3 keepLive cutover. Unlike
   * `WINDOW_CLOSE_OR_HIDE_REQUESTED` there is no keepLive policy to decide:
   * the caller's intent IS hide.
   */
  | { type: 'WINDOW_HIDE_REQUESTED'; id: WindowId }
  /** App code wants this window's CONTENT surface torn down (the hybrid finalize's `contentWC.close()`). */
  | { type: 'WINDOW_CONTENT_CLOSE_REQUESTED'; id: WindowId }
  /** Quit teardown: destroy every registered page-host guest WC before native quit closes their hosts (peek d1cf0b9a). */
  | { type: 'GUEST_TEARDOWN_REQUESTED' }
  /**
   * Devtools opened/closed for a registered window (§4.6 dim 8a). Both edges
   * re-drive `front` via `applyRaiseRequest` — the machine form of the old
   * "re-focus the content window after devtools opens/closes" handlers.
   */
  | { type: 'DEVTOOLS_OPENED'; id: WindowId }
  | { type: 'DEVTOOLS_CLOSED'; id: WindowId }
  | { type: 'WINDOW_SHOWN'; id: WindowId; focused: boolean }
  /**
   * A page-host's content produced its first composited frame, making its
   * NSWindow actually z-orderable (§5 step 5 — the page-host orderability
   * caveat: until this moment the window server silently NO-OPS relative
   * raises against it, which is why the legacy restore's bulk `moveTop` pass
   * left internal tiles on top). The reducer marks the record `orderable` and
   * re-drives `SET_STACKING` for the window and everything stacked above it,
   * converging native order onto `stackOrder` as each page-host composites —
   * event-driven, no timer, no poll. PRODUCER (§5 step 5 part B): the
   * permanent `hybrid:first-frame` IPC listener in `session.ts` (the
   * double-rAF signal from runtime-external-preload.cjs), which replaced the
   * legacy restore-scoped `reassertStackingOrder` walk.
   */
  | { type: 'WINDOW_CONTENT_ORDERABLE'; id: WindowId }
  /**
   * Import a persisted z-order (session restore, bottom → top). Reorder only —
   * membership is untouched: ids that are unknown / hidden / not stacked are
   * dropped from the import, and current stack members the import does not
   * name keep their relative order BELOW the imported set (the import is
   * authoritative for the windows it names, silent about the rest). The
   * reducer emits `SET_STACKING` for the entire resulting order, bottom → top
   * — page-hosts that have not composited yet no-op natively and converge via
   * their own `WINDOW_CONTENT_ORDERABLE`. Order only: no activation, no
   * assertion change (activating the focused descriptor stays the restore
   * focus block's separate step). Replaces the legacy restore's reverse
   * `moveTop()` walk (§5 step 5 part B).
   */
  | { type: 'STACK_ORDER_IMPORTED'; order: WindowId[] }
  | { type: 'WINDOW_HIDDEN'; id: WindowId }
  | { type: 'WINDOW_CLOSED'; id: WindowId }
  | { type: 'OS_FOCUS_GAINED'; id: WindowId; lastHttpUrl?: string }
  | { type: 'OS_FOCUS_SETTLED_NULL' }
  | { type: 'APP_ACTIVATED' }
  | { type: 'APP_RESIGNED' }
  /**
   * A cold-start restore asks for `id` to be put back in front on the first
   * `APP_ACTIVATED` that follows — see `AppWindowState.pendingColdStartFocus`
   * for the trailing-dance failure it covers. Arms a latch and nothing else:
   * no effect, no front change, inert until the app next activates. `id: null`
   * CLEARS it, which is how a fresh restore pass drops a latch an earlier pass
   * armed and never spent.
   */
  | { type: 'COLD_START_FOCUS_ARMED'; id: WindowId | null }
  /**
   * Session tri-state mirror. `izui-state.ts`'s coordinator is the SINGLE owner
   * of `idle/transient/active` (design §2.1/§3: "coordinator keeps only session
   * idle/transient/active + setAppFocused mirroring appActive"). The adapter
   * subscribes to the coordinator's session transitions and feeds them in here;
   * the reducer NEVER derives session on its own (that would be a second, rival
   * authority — a split-brain). `decideEscape` step 6 reads this mirrored value.
   */
  | { type: 'SESSION_CHANGED'; session: IzuiSession }
  | { type: 'FULLSCREEN_REQUESTED'; id?: WindowId; desired?: boolean; bounds?: Rectangle | null }
  | { type: 'OS_FULLSCREEN_ENTERED'; id: WindowId }
  | { type: 'OS_FULLSCREEN_LEFT'; id: WindowId }
  | { type: 'FULLSCREEN_SETTLE_TIMEOUT'; id: WindowId }
  /**
   * The backend's native resize/move report (§4.2 dim 2, §5 step 7A — the
   * port's `boundsChanged` event): the SOLE writer of `WindowRecord.bounds`.
   * Emitted by the backend's `'resize'`/`'move'`/`'moved'` listeners for
   * every registered window; a duplicate report (macOS fires both `move` and
   * `moved` for one gesture) re-merges the same rect, structurally inert.
   */
  | {
      type: 'BOUNDS_CHANGED';
      id: WindowId;
      bounds: Rectangle;
      /**
       * The OVERLAY FRAME for this host rect (§4.3 dim 3b, §5 step 9) — the
       * rect an attached overlay must take so it frames `bounds`. Rides the
       * payload for the same reason `MAXIMIZE_REQUESTED.workArea` does: the
       * frame is the host rect grown by the chrome gutters and then CLAMPED to
       * the display work area (`hybrid-overlay.ts expandToOverlayFrame`, which
       * needs `screen`), so computing it is OS-boundary math and this reducer
       * keeps ZERO value imports.
       *
       * Absent = the dispatch site had no frame to offer (no overlay attached
       * to this host, or no display info): the follow then drives ORDER and
       * VISIBILITY only, never a stale rect.
       */
      overlayFrame?: Rectangle;
    }
  /**
   * Attach / retarget / detach the chrome overlay (§4.3 dim 3b, §5 step 9) —
   * ONE transition covering all three, mirroring `hybrid-overlay.ts retarget(id
   * | null)`: `hostId` non-null attaches (or moves) `id`'s attachment onto that
   * host and drives the follow; `hostId: null` detaches and takes the overlay
   * off screen. Re-attaching to the SAME host is a plain re-follow (the
   * idempotent "re-frame onto the current host" call the app-active gate makes).
   *
   * `frame` is the overlay's frame rect for the host's CURRENT bounds, computed
   * at the dispatch site — see `BOUNDS_CHANGED.overlayFrame` for why the rect
   * cannot be computed here. Absent = order + visibility only.
   *
   * No-op for an unknown overlay id. An unknown/undefined host is a DETACH: an
   * attachment to a window the machine does not know cannot be followed, and a
   * dangling `overlayFor` would leave the overlay stranded on screen (today's
   * `retarget` treats "active window vanished between signal and handling"
   * exactly this way — clear + hide).
   */
  | { type: 'OVERLAY_ATTACH_REQUESTED'; id: WindowId; hostId: WindowId | null; frame?: Rectangle }
  /**
   * The app-resign settle point (§4.4 dim 4b, §5 step 9): "the app has stayed
   * resigned — this was a real app switch, not the macOS activation dance." The
   * reducer sweeps the visible transient page-hosts ONLY if the sweep is still
   * armed (see `AppWindowState.pendingAppResignSweep`); an `APP_ACTIVATED` in
   * between disarms it, so a settle signal that lands after the user came back
   * closes nothing. Inert on its own — arming happens on `APP_RESIGNED`.
   */
  | { type: 'APP_RESIGN_SETTLED' }
  /**
   * App code wants this window at `bounds` (§4.2 dim 2, §5 step 7E) — the
   * plain geometry-write intent behind every legacy direct `setBounds`:
   * tile:window:set-bounds/center IPC, reuse/open placement, and the hybrid
   * drag/resize streams (page:set-bounds + the band-drag `applyResize`).
   * Like MAXIMIZE_REQUESTED, the rect is computed AT THE DISPATCH SITE
   * (`computePlacement`, gesture math) and rides the event — this reducer
   * keeps ZERO value imports. Emits SET_BOUNDS; the `bounds` mirror is NOT
   * written here — it updates only via the backend's `BOUNDS_CHANGED` echo
   * (the mirror stays an honest record of native reality, §5 step 7A).
   * No-op while `fsMode` is non-normal: fullscreen owns the display, and a
   * mid-fullscreen bounds write would corrupt the episode's geometry (the
   * aa34cb50 family — same guard as MAXIMIZE_REQUESTED). Deliberately does
   * NOT touch `maximized`/`preMaxBounds`: the legacy direct calls never did,
   * and the only sanctioned maximize-invalidation path stays
   * MAXIMIZE_EXITED_BY_RESIZE (its producers run at the gesture press, before
   * the per-move stream dispatches these). High-frequency per-gesture use is
   * fine by design: the pump already carries `BOUNDS_CHANGED` at native
   * resize-event frequency, and dispatch is synchronous (read-after-dispatch
   * contract), so a gesture stream through the reducer costs what the echo
   * stream already costs.
   */
  | { type: 'SET_BOUNDS_REQUESTED'; id: WindowId; bounds: Rectangle }
  /**
   * App code wants this window maximized — snapped to its display's work
   * area (§4.2 dim 2, §5 step 7A). A reducer TRANSITION, never an OS
   * question: the reducer stashes `preMaxBounds`, flips `maximized`, and
   * emits SET_BOUNDS(workArea). `workArea` is carried ON THE EVENT by the
   * dispatch site (which may compute it via `window-placement.ts
   * computePlacement` / the display work-area) because this reducer keeps
   * ZERO value imports — see the §4.2 dim 2b resolution note in the design
   * doc. Already-maximized: re-snap only (SET_BOUNDS re-emitted, stash
   * untouched — overwriting it with already-maximized bounds is the classic
   * trap that turns the next unmaximize into a no-op, cf the tile-ipc.ts
   * X11 near-work-area heuristic). No-op while `fsMode` is not `normal`:
   * fullscreen owns the display, and a maximize recorded mid-fullscreen
   * would stash the fullscreen rect as `preMaxBounds` (the aa34cb50
   * lookalike trap, maximize edition).
   */
  | { type: 'MAXIMIZE_REQUESTED'; id: WindowId; workArea: Rectangle }
  /**
   * App code wants this window restored from maximized (§5 step 7A): clears
   * `maximized`, emits SET_BOUNDS(preMaxBounds) when a stash exists, and
   * clears the stash. No-op when not maximized (the machine's own flag is
   * the truth — no `isMaximized()` distrust dance).
   */
  | { type: 'UNMAXIMIZE_REQUESTED'; id: WindowId }
  /**
   * Construction-time maximize restore (§5 step 7B): reopen-last-closed and
   * session restore rebuild a window whose CREATION bounds already ARE the
   * maximized rect (the saved presentation bounds), carrying the SAVED
   * pre-maximize rect separately. Seeds `maximized` + `preMaxBounds` WITHOUT
   * driving SET_BOUNDS — there is nothing to resize, the machine only needs
   * to know. `preMaxBounds: null` = the save carried no restorable rect
   * (same "no stash was possible" meaning as elsewhere). No-op for an
   * unknown id or while `fsMode` is non-normal (the aa34cb50 guard, same as
   * MAXIMIZE_REQUESTED).
   */
  | { type: 'MAXIMIZE_RESTORED'; id: WindowId; preMaxBounds: Rectangle | null }
  /**
   * A resize gesture invalidated maximize (§5 step 7B — the pinned "resize
   * gesture exits maximize AT PRESS" invariant): dispatched by the band-drag
   * press on a maximized host, and by the native-resize reconciler when the
   * OS itself resizes a frameless host away from the work area (that gesture
   * never enters the app's input stream). Clears `maximized` + `preMaxBounds`
   * and drives NOTHING back at the OS — the gesture owns the window's bounds;
   * leaving the stash set is the stale-preMaxBounds de-sync (a later toggle
   * would "restore" to a rect the user already resized away from). Clearing
   * at press rather than release means an abandoned drag still leaves
   * coherent state. No-op when not maximized (so the machine's own
   * maximize-snap SET_BOUNDS echo cannot self-trip anything here either).
   */
  | { type: 'MAXIMIZE_EXITED_BY_RESIZE'; id: WindowId }
  /**
   * The display layout changed (§4.2 dim 7, §5 step 10) — the port's
   * `displayChanged` event: a display was added, removed, or had its
   * bounds/workArea/scaleFactor rewritten. Carries the windows whose placement
   * intent re-projects to a NEW rectangle, each with the rect it should move
   * to; the reducer emits one `SET_BOUNDS` per surviving entry, in the order
   * given.
   *
   * Why the rects come in on the event: `display-watcher.ts` today asks the OS
   * for the layout, runs `computePlacement` per window, and calls `setBounds()`
   * itself — the last big geometry writer outside the machine. The cutover
   * makes it a pure PRODUCER: it still owns the placement math (this reducer
   * has ZERO value imports and cannot call `computePlacement`), but it stops
   * touching windows and dispatches the projected rects here instead, so the
   * ONE effect funnel (R2) performs the moves. Entries whose placement did not
   * change ("keep") are filtered at the dispatch site and never appear.
   *
   * The reducer drops an entry outright — no effect, no state change — only
   * when the window is unknown. When the machine's `visible` mirror says it is
   * not on screen (the legacy watcher's `isVisible()` filter, now answered
   * from state instead of an OS query), or its `fsMode` is non-normal
   * (fullscreen owns the display — the same guard
   * `SET_BOUNDS_REQUESTED`/`MAXIMIZE_REQUESTED` apply), the projection is NOT
   * discarded: it is DEFERRED onto `WindowRecord.pendingProjectedBounds` and
   * flushed as a `SET_BOUNDS` once both axes clear (see that field's doc and
   * `flushPendingProjection`) — so a window that is fullscreen or hidden when
   * a display change lands is still correctly re-placed once it returns to
   * normal and visible, rather than left stranded at a rect that no longer
   * satisfies its placement intent. Like every other geometry write it does
   * NOT touch the `bounds` mirror (the backend's `BOUNDS_CHANGED` echo is its
   * sole writer) and does NOT touch `maximized`/`preMaxBounds`: a reprojection
   * re-places the window, it is not a user gesture, and the legacy watcher
   * never disturbed maximize state either.
   */
  | { type: 'DISPLAY_CHANGED'; projected: ProjectedWindowBounds[] }
  /**
   * App code wants this window pinned to (or unpinned from) every macOS Space
   * (§4.2 dim 7b, §5 step 10) — the inbound intent behind the write-only
   * `setVisibleOnAllWorkspaces` calls. Records the intent on
   * `WindowRecord.visibleOnAllSpaces`, which is what makes the state readable
   * for the first time. No-op for an unknown window.
   *
   * This is the RAW path: caller-supplied `on` plus caller-supplied platform
   * options, straight through to one `SET_VISIBLE_ON_ALL_SPACES` effect. It
   * exists for the renderer-driven tile IPC
   * (`tile:window:set-visible-on-all-workspaces`), whose caller passes both
   * halves and has no role/policy to consult. App-internal, role-driven
   * callers use `SPACES_POLICY_REQUESTED` instead — it owns the follow/anchor
   * decision AND the anchor pair.
   *
   * The two optional flags are platform call options, NOT state: they ride the
   * effect and are never stored (`WindowRecord` holds only the `on` intent).
   * See `WindowBackend.setVisibleOnAllSpaces` for why they must be expressible
   * per call.
   *
   * The effect is emitted even when `on` already equals the record's value:
   * macOS silently drops the all-Spaces flag across some window/Space
   * transitions, so a re-assert is a real OS write, not a redundant one (the
   * keepLive-reuse `follow` re-assert in `ipc.ts` is exactly that).
   */
  | {
      type: 'SET_VISIBLE_ON_ALL_SPACES_REQUESTED';
      id: WindowId;
      on: boolean;
      visibleOnFullScreen?: boolean;
      skipTransformProcessType?: boolean;
    }
  /**
   * The INTENT path behind the same OS write (§4.2 dim 7b, §5 step 10): "apply
   * this window's role-derived Spaces policy", where the policy comes from the
   * pure `izui-roles.ts spacesPolicyForRole(role, platform)` at the dispatch
   * site (the reducer has zero value imports and cannot call it).
   *
   *   'follow' — palette/quick-view/overlay (cmd panel, slides, peeks): the
   *     window rides along to whichever Space the user is on. ONE effect,
   *     `on:true` with both flags.
   *   'anchor' — everything else on darwin: the deliberate ORDERED PAIR,
   *     `true` (both flags) then `false` (skipTransformProcessType only).
   *     Issued synchronously right after creation, that pair is what makes
   *     macOS land the window on the user's ACTIVE Space and then pin it
   *     there — a bare `false` would leave it on the Space the app happened
   *     to be created from. The two calls carry DIFFERENT options, which is
   *     why the pair cannot collapse into one effect.
   *   'none' — non-darwin (no Spaces exist): no effect, no state change.
   *
   * The pair lives HERE rather than at the call site so it is unit-testable
   * and so `ipc.ts` stays a one-line dispatcher. Note the record ends
   * `visibleOnAllSpaces: false` after an anchor — which reads correctly as
   * "anchored to a Space", the same value a never-touched window holds.
   */
  | { type: 'SPACES_POLICY_REQUESTED'; id: WindowId; policy: 'follow' | 'anchor' | 'none' }
  /**
   * The user switched to a different macOS Space (§4.2 dim 7c, §5 step 10) —
   * the port's `spaceChanged`, emitted by the backend's
   * `NSWorkspaceActiveSpaceDidChangeNotification` subscription.
   *
   * It carries NO payload, and cannot: the notification's `userInfo` is empty
   * (verified on a real machine — two switches, two empty payloads), so macOS
   * tells us THAT the active Space changed and never WHICH one it is. There is
   * therefore no Space identity to record, and no per-Space state for the
   * machine to hold.
   *
   * The reducer clause is INERT — it writes no state and emits no effects.
   * The all-Spaces pin does not need re-asserting on a switch (that flag is
   * sticky by definition), and re-asserting would fire a native call per
   * pinned window mid Space-transition, in the background, from the one call
   * this repo has flash regressions on. The clause carries the full argument.
   * The event stays wired so the signal exists the day something genuinely
   * needs it.
   */
  | { type: 'SPACE_CHANGED' }
  | { type: 'ESC_PRESSED'; landedId: WindowId | 'global' }
  /**
   * The renderer's answer to an `ASK_RENDERER`. `seq` echoes the epoch of the
   * ask it answers (see `AppWindowState.escAsk`); an answer that does not match
   * the pending ask is stale and is dropped.
   */
  | { type: 'ESC_RENDERER_ANSWER'; id: WindowId; handled: boolean; close?: boolean; seq: number }
  | { type: 'SWITCHER_OPEN_REQUESTED'; windowId?: WindowId }
  | { type: 'SWITCHER_SELECTED'; id: WindowId | null }
  /**
   * Mirror-only (staged cutover): the switcher overlay WINDOW actually opened.
   * The overlay-window lifecycle (open/select/teardown/focus-restore + the macOS
   * focus-dance cooldowns) stays owned by `izui-state.ts` + `main.ts`; this event
   * only records switcher state in the machine so `decideEscape` step 1
   * (`switcher.open → close-switcher`) and the derived Esc-grab predicate fire
   * correctly. It emits NO effect — the window already exists.
   */
  | { type: 'SWITCHER_OPENED'; windowId: WindowId }
  /**
   * The window's renderer WebContents gained or lost macOS first-responder
   * status (§5 step 11 — the front/first-responder collapse). Purely
   * additive for now: sets `WindowRecord.contentFocused` and nothing else.
   * No consumer keys off this yet — a later step re-derives
   * `deriveEscGrabRegistered` from it. No-op for an unknown id.
   */
  | { type: 'CONTENT_FIRST_RESPONDER_CHANGED'; id: WindowId; held: boolean }
  /**
   * A USER-REQUESTED raise (switcher selection, Escape closing the switcher,
   * devtools, parent handoff on close, the successor after the front hid) —
   * the machine driving the OS toward a target something named, never a
   * re-drive of its own belief. Does NOT write `front` and does NOT bump `focusSeq`;
   * `front` moves only via `applyFocusGained` on the resulting evidence.
   * Backend contract: `RAISE_WINDOW` → `raiseWindow` → `WINDOW_SHOWN
   * {focused:true}`, never `OS_FOCUS_GAINED` — the sweep-free echo.
   */
  | { type: 'RAISE_WINDOW_REQUESTED'; id: WindowId };

// ─────────────────────────────────────────────────────────────────────────────
// Effects — returned by the reducer, executed by the OS adapter (§2.6). The
// reducer NEVER performs these; it only describes them.
// ─────────────────────────────────────────────────────────────────────────────

export type Effect =
  | { type: 'SET_FULLSCREEN'; id: WindowId; on: boolean }
  /** The single sanctioned OS poll: adapter reads `isFullScreen()` once and re-dispatches OS_FULLSCREEN_ENTERED/LEFT. */
  | { type: 'RECONCILE_FULLSCREEN'; id: WindowId }
  | { type: 'OPEN_SWITCHER_WINDOW'; previousFront: WindowId | null }
  /**
   * `switcherWindowId` is the overlay window to tear down. In the staged cutover
   * the adapter DELEGATES the teardown to izui (`closeOrHideWindow`) only on the
   * ESC path (`restoreFocus:true`); on app-blur (`restoreFocus:false`) the
   * existing `main.ts did-resign-active` block owns the teardown (with its
   * cooldown focus-dance protection), so the adapter is a no-op there.
   */
  | { type: 'CLOSE_SWITCHER_WINDOW'; restoreTarget: WindowId | null; restoreFocus: boolean; switcherWindowId: WindowId | null }
  | { type: 'RAISE_WINDOW'; id: WindowId }
  /**
   * Place the window at the top of its (regular) window level — RELATIVE ORDER
   * ONLY, the `moveTop` replacement (§4.3 dim 3): no activation, no key-window
   * change, no first-responder semantics (those are `RAISE_WINDOW` /
   * `FOCUS_CONTENT`). The SOLE ordering effect: emitted by `applyRaiseRequest`
   * alongside the raise it drives (so every machine-driven raise also drives
   * order, §6), and re-driven by `WINDOW_CONTENT_ORDERABLE` as page-hosts
   * become orderable. To realize a full order the reducer emits one per
   * window, bottom → top (each raise stacks on the previous).
   *
   * `level` rides the payload rather than being looked up by the executor from
   * record state (the executor is stateless w.r.t. records — see
   * `window-os-adapter.ts`): a `pinned` level realizes as
   * `setAlwaysOnTop(true, 'floating')` (the overlay's z-pin), anything else as
   * a plain `moveTop()`.
   */
  | { type: 'SET_STACKING'; id: WindowId; level: StackingLevel }
  /**
   * Make a page-host's content WebContentsView the macOS first responder (the
   * `shouldFocusHybridContentOnHostFocus` invariant). Exactly two emitters:
   *   - `applyRaiseRequest`, alongside the `RAISE_WINDOW` it drives, when the
   *     raise target is a page-host;
   *   - `applyOsFocusRealized`, on an `OS_FOCUS_GAINED` that landed on `front`
   *     — the OS made the HOST key, which says nothing about whether its
   *     content view is first responder (the 7c61e917 raise-by-chrome bug), so
   *     that one half is driven even though no raise is.
   */
  | { type: 'FOCUS_CONTENT'; id: WindowId }
  /**
   * Ask the renderer whether it handled ESC (the `escape-pressed` IPC, unchanged
   * protocol). `seq` is the epoch token the adapter MUST echo back on the
   * resulting `ESC_RENDERER_ANSWER` so a deferred answer is judged against the
   * ask that produced it (see `AppWindowState.escAsk`).
   */
  | { type: 'ASK_RENDERER'; id: WindowId; seq: number }
  | { type: 'CLOSE_WINDOW'; id: WindowId }
  /** Guest-safe direct close (destroy registered guests, then close the host) — the absorbed windows.ts `closeHostWindow` path. No keepLive policy. */
  | { type: 'CLOSE_WINDOW_DIRECT'; id: WindowId }
  /** Forceful native destroy (extension bridge/UI teardown, quit paths). */
  | { type: 'DESTROY_WINDOW'; id: WindowId }
  /** Tear down the window's content surface (the hybrid finalize's `contentWC.close()`). */
  | { type: 'CLOSE_CONTENT'; id: WindowId }
  /** Show without (or with) activation. Executor skips it under headless — both consumers (HUD re-show, extension-UI dev autoopen) were `!isHeadless()`-guarded before the machine owned them. */
  | { type: 'SHOW_WINDOW'; id: WindowId; activate: boolean }
  /** Hide, keep alive (the HUD app-blur sweep, the keepLive close-request decision — see `WINDOW_CLOSE_OR_HIDE_REQUESTED` — and the plain hide intent, `WINDOW_HIDE_REQUESTED`). */
  | { type: 'HIDE_WINDOW'; id: WindowId }
  /** Pin above regular windows (registration-declared alwaysOnTop). Executor skips under headless (compositor-flash parity with the old guard). */
  | { type: 'SET_ALWAYS_ON_TOP'; id: WindowId; on: boolean }
  /**
   * Pin the window to (or unpin it from) every macOS Space (§4.2 dim 7b, §5
   * step 10) — executed by the port's `setVisibleOnAllSpaces`. Emitted by the
   * raw `SET_VISIBLE_ON_ALL_SPACES_REQUESTED` and, one or TWO at a time, by
   * `SPACES_POLICY_REQUESTED`.
   *
   * The two optional flags are platform call options that ride the payload
   * because the executor is stateless w.r.t. records and MUST NOT re-derive
   * them: `skipTransformProcessType` is required on every real call (it stops
   * macOS toggling the activation policy, which flashes every other Peek
   * window), and `visibleOnFullScreen` belongs on the `on:true` calls only.
   * Absent = "don't pass the option", not `false`.
   */
  | {
      type: 'SET_VISIBLE_ON_ALL_SPACES';
      id: WindowId;
      on: boolean;
      visibleOnFullScreen?: boolean;
      skipTransformProcessType?: boolean;
    }
  /** Quit teardown: destroy every registered page-host guest WC (peek d1cf0b9a). */
  | { type: 'DESTROY_ALL_GUESTS' }
  /**
   * Position and size the window (§4.2 dim 2, §5 step 7A) — the §3 table's
   * `setBounds(id, rect)` command, executed by the port's `setWindowBounds`.
   * Emitted by the maximize/unmaximize transitions and by
   * `SET_BOUNDS_REQUESTED` — the inbound intent every legacy direct
   * `setBounds` call site was routed through (§5 step 7E).
   */
  | { type: 'SET_BOUNDS'; id: WindowId; bounds: Rectangle }
  /** ESC consumed by leaving fullscreen (also drives the leaving fsMode edge + SET_FULLSCREEN in the same reduce). */
  | { type: 'EXIT_FULLSCREEN'; id: WindowId }
  /** ESC passed straight to the page (escapeMode 'ignore'). */
  | { type: 'PASS_THROUGH'; id: WindowId }
  | { type: 'NOTHING' };

/**
 * The Spaces effect on its own, so the reducer can BUILD one incrementally
 * (adding only the flags the caller supplied) — a `Effect`-typed local would
 * reject the property writes, and spreading `undefined` flags in would make
 * the emitted shape differ from the equivalent literal.
 */
type SetVisibleOnAllSpacesEffect = Extract<Effect, { type: 'SET_VISIBLE_ON_ALL_SPACES' }>;

export interface ReduceResult {
  state: AppWindowState;
  effects: Effect[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Escape decision (§2.4) — the doc's total function. Split across the
// ask-renderer await boundary: `decideEscape` runs steps 1-5;
// `decideEscapeUnhandled` runs step 6 on the renderer's `handled:false` answer.
// Both are pure and separately exported for direct unit testing.
// ─────────────────────────────────────────────────────────────────────────────

export type EscapeDecision =
  | { kind: 'close-switcher' }
  | { kind: 'open-switcher' }
  | { kind: 'pass-through'; id: WindowId }
  | { kind: 'exit-fullscreen'; id: WindowId }
  | { kind: 'ask-renderer'; id: WindowId };

export type EscapeUnhandledDecision =
  | { kind: 'close-window'; id: WindowId }
  | { kind: 'open-switcher' }
  | { kind: 'nothing' };

/**
 * decideEscape — steps 1-5 of the doc's total escape function.
 *
 *   1. switcher open                     -> close-switcher (restore previousFront)
 *   2. front == null                     -> open-switcher (the old global-fallback case)
 *   3. front.escapeMode == 'ignore'      -> pass-through
 *   4. front.fsMode.name != 'normal'     -> exit-fullscreen(front)  (entering/full/leaving all exit)
 *   5. -> ask-renderer(front); the renderer answer drives step 6 (`decideEscapeUnhandled`)
 *
 * Step 4 precedes EVERY switcher outcome in EVERY entry path (both
 * before-input-event AND the global grab dispatch the SAME ESC_PRESSED), making
 * "switcher over fullscreen" structurally impossible. The target is always
 * `front` — a landed id is treated as first-responder noise.
 */
export function decideEscape(state: AppWindowState): EscapeDecision {
  if (state.switcher.open) return { kind: 'close-switcher' };
  const t = state.front;
  if (t == null) return { kind: 'open-switcher' };
  const rec = state.windows.get(t);
  // A front that no longer resolves is an invariant violation elsewhere; treat
  // as "no target" so ESC still has a defined outcome.
  if (!rec) return { kind: 'open-switcher' };
  if (rec.escapeMode === 'ignore') return { kind: 'pass-through', id: t };
  if (rec.fsMode.name !== 'normal') return { kind: 'exit-fullscreen', id: t };
  return { kind: 'ask-renderer', id: t };
}

/**
 * decideEscapeUnhandled — step 6: role x session policy table, absorbing
 * `escPolicy` + `escUnhandledPolicy` VERBATIM (ported below). Consulted only
 * after the renderer answered `handled:false`.
 */
export function decideEscapeUnhandled(state: AppWindowState, windowId: WindowId): EscapeUnhandledDecision {
  const rec = state.windows.get(windowId);
  if (!rec) return { kind: 'nothing' };
  const policy = escPolicy(state.session, rec.role);
  if (policy === 'close' || policy === 'close-and-restore') {
    return { kind: 'close-window', id: windowId };
  }
  // policy === 'nothing' -> second-phase unhandled policy
  const unhandled = escUnhandledPolicy(state.session, rec.role);
  if (unhandled === 'open-switcher') return { kind: 'open-switcher' };
  return { kind: 'nothing' };
}

/**
 * ESC policy — ported VERBATIM from `izui-state.ts escPolicy` (§3: absorbed as
 * `decideEscape` step 6). Given session state and window role, what ESC does.
 */
export function escPolicy(sessionState: string, role: string): 'close' | 'close-and-restore' | 'nothing' {
  if (['quick-view', 'palette', 'utility'].includes(role)) return 'close';
  if (role === 'overlay') return 'close-and-restore';
  if (role === 'workspace') return 'nothing';
  if (sessionState === 'transient') return 'close';
  return 'nothing';
}

/**
 * ESC unhandled policy — ported VERBATIM from `izui-state.ts escUnhandledPolicy`.
 * Second phase: what to do when ESC has nowhere left to navigate.
 *
 * The `'overlay'` arm is UNREACHABLE through `reduce`: `window-state-singleton.ts
 * clampSession` maps the coordinator's 'overlay' to 'active' before it is
 * dispatched, so `state.session` only ever holds `IzuiSession`. It is kept
 * because this table is a verbatim port and the parameter is typed `string`;
 * do not read it as "the switcher-open session suppresses the switcher."
 */
export function escUnhandledPolicy(sessionState: string, role: string): 'open-switcher' | 'nothing' {
  if (sessionState === 'transient' || sessionState === 'overlay') return 'nothing';
  if (['workspace', 'content', 'child-content'].includes(role)) return 'open-switcher';
  return 'nothing';
}

// ─────────────────────────────────────────────────────────────────────────────
// Front arbitration helpers (§2.4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * isSatelliteRegistration — the SINGLE owner of the front-ineligibility rule
 * applied when a window is registered. A "satellite" can never become `front`
 * (see WindowRecord.satellite / isEligibleFront). Every registration site
 * (ipc.ts window-open, main.ts tile-launcher hook) computes `satellite` through
 * THIS predicate so the two can't drift.
 *
 * A window is a satellite when it is structurally front-ineligible:
 *   - role 'overlay' / 'palette' — chrome/focus-group surfaces, never a target;
 *   - a close-on-blur modal dialog (judgment call 1);
 *   - `focusable === false` — one that can never be the OS key window, so it
 *     must never be `front`. Otherwise the derived Esc grab is suppressed
 *     (front != null) while the window can't receive `before-input-event`
 *     either → dead ESC (cf ebb10894 / 7c61e917).
 *
 * `focusable` is the RESOLVED focusability (or undefined = Electron's default
 * true); callers normalize before passing.
 *
 * Extended with the window CLASS (§5 step 4, rather than duplicating the rule
 * elsewhere): the infrastructure classes — hud, background, bridge, offscreen,
 * test-fixture, devtools — are structurally front-ineligible regardless of
 * role/focusable. `extension-ui` is deliberately NOT here: an extension popup
 * is a real user-facing window the user works in, so it stays front-eligible.
 */
const SATELLITE_CLASSES: ReadonlySet<WindowClass> = new Set<WindowClass>([
  'hud',
  'background',
  'bridge',
  'offscreen',
  'test-fixture',
  'devtools',
]);

export function isSatelliteRegistration(
  role: string,
  opts: { modal?: boolean; focusable?: boolean; windowClass?: WindowClass } = {},
): boolean {
  if (opts.windowClass !== undefined && SATELLITE_CLASSES.has(opts.windowClass)) return true;
  if (role === 'overlay' || role === 'palette') return true;
  if (opts.modal === true) return true;
  if (opts.focusable === false) return true;
  return false;
}

/**
 * classifyWindowRegistration — the SINGLE owner of the "which class is an
 * ordinary window-open?" rule (§4.3 dim 8b). The special infrastructure
 * classes (background / bridge / offscreen / extension-ui / test-fixture / devtools) are
 * never inferred — their glue modules declare them explicitly at registration.
 *
 * The `hud` arm is the DECLARED replacement for the deleted sniffing
 * predicate `isAlwaysOnTop() && !isFocusable()` (main.ts app-blur sweep):
 * the same pair of properties, but judged ONCE from the open params at
 * registration and stored as a class, instead of live-queried per sweep.
 */
export function classifyWindowRegistration(
  role: string,
  opts: { alwaysOnTop?: boolean; focusable?: boolean } = {},
): WindowClass {
  if (role === 'overlay') return 'overlay';
  if (role === 'palette') return 'palette';
  if (role === 'quick-view') return 'quick-view';
  if (opts.alwaysOnTop === true && opts.focusable === false) return 'hud';
  return 'primary';
}

/**
 * The classes whose windows pin ABOVE the whole regular stack (`StackingLevel
 * 'pinned'`): their above-ness rides the existing `SET_ALWAYS_ON_TOP` pin, so
 * the ordered stack never contains them.
 */
const PINNED_CLASSES: ReadonlySet<WindowClass> = new Set<WindowClass>(['hud', 'overlay', 'palette']);

/**
 * deriveStackingLevel — the SINGLE owner of the "does this window participate
 * in the ordered stack, float above it, or stay out of it?" rule (§4.3 dim 3).
 * Judged once per registration from the record's declared class + satellite
 * flag (both already settled by `classifyWindowRegistration` /
 * `isSatelliteRegistration`):
 *   - hud / overlay / palette          -> 'pinned'   (above the stack, via the pin)
 *   - any other satellite              -> 'excluded' (background/bridge/offscreen/
 *                                                     test-fixture/devtools, modals, focusable:false
 *                                                     — OS/parent-managed z-relationship)
 *   - the rest                         -> 'stacked'  (primary, quick-view, extension-ui)
 * Note `stacked` coincides with front-eligibility's non-satellite half by
 * construction, so a legal `front` is always a `stacked` record.
 */
export function deriveStackingLevel(windowClass: WindowClass, satellite: boolean): StackingLevel {
  if (PINNED_CLASSES.has(windowClass)) return 'pinned';
  if (satellite) return 'excluded';
  return 'stacked';
}

/**
 * What one registration call must do. Every field is a decision, not a value,
 * executed verbatim in two halves: the backend
 * (`electron-window-backend.ts registerWindow`) performs the merge +
 * native-listener attach, the executor (`window-os-adapter.ts registerWindow`)
 * performs the event pumps + the Esc-interceptor port command.
 */
export interface WindowRegistrationDecision {
  /** The id was already registered: this call is a MERGE, not a first registration. */
  reRegistration: boolean;
  /**
   * Attach the native window listeners (focus/blur/show/hide/closed/fullscreen).
   * False on a re-registration — attaching a second set would double every
   * event the window emits.
   */
  attachNativeListeners: boolean;
  /**
   * Attach the `before-input-event` Escape interceptor (`windows.ts
   * addEscHandler`). False on a re-registration: a second interceptor turned ONE
   * physical Escape into TWO `ESC_PRESSED` dispatches, which is what made the
   * switcher reopen itself in a loop (7fffa286). Also false for a `page-host`
   * (a BaseWindow has no root webContents; its Escape rides the content
   * WebContentsView) and for a caller that opts out (the shared chrome overlay,
   * which handles Escape in its own renderer).
   */
  attachEscHandler: boolean;
  /**
   * Overwrite the retained renderer WebContents with the incoming spec's.
   * A first registration always installs one (`null` when the caller supplied
   * none); a re-registration only when the caller actually passed the field, so
   * a later, thinner spec cannot blank out a WC the first one established.
   */
  adoptRendererWC: boolean;
  /**
   * Pump `WINDOW_REGISTERED` into the reducer. ALWAYS true, including on a
   * duplicate — deliberately. The later spec is the RICHER one (ipc.ts knows the
   * real `modal`/`focusable`, the tile-launcher hook only `win.isFocusable()`),
   * and `satellite` lives in the reducer's `WindowRecord`, so swallowing the
   * re-pump would strand the reducer on the thin spec and regress the
   * `isSatelliteRegistration` modal clause. `WINDOW_REGISTERED` is an idempotent
   * MERGE in `reduce` (it preserves `visible`/`focusSeq`/`fsMode`), so the
   * re-pump costs nothing beyond refreshing the declared fields.
   */
  pumpRegisteredEvent: boolean;
  /**
   * Pump `WINDOW_SHOWN { focused: true }` after the (re-)registration pump,
   * importing the native window's CURRENT visibility into the machine. True
   * whenever the native window is already visible at registration time.
   *
   * WHY (gate fallout of the WindowId cutover): a BrowserWindow constructed
   * with `show: true` (the window-open browser branch, pseudo-tiles) never
   * fires a `'show'` TRANSITION — it is born visible — and under a headless
   * run nothing ever focuses it either, so without this import the machine
   * literally never learns the window exists on screen: `front` stays null and
   * every front consumer (`getFocusedVisibleWindowId`, session-save's focused
   * descriptor, the overlay retarget) reads null forever. `focused: true`
   * ports the deleted "track immediately at open" behavior (old ipc.ts
   * `trackVisibleWindowFocus` at the open site): opening a visible window
   * makes it the target. Satellite/modal arbitration is structural in the
   * reducer (`applyFocusGained` ignores ineligible fronts), so this is safe to
   * pump for every kind — and on a RE-registration it lands after the richer
   * `WINDOW_REGISTERED` merge, so a modal is already a satellite by the time
   * the focused-shown event is judged.
   *
   * CONSTRAINT — registration happens at OPEN time only. `focused: true` is
   * correct solely because every current caller registers a window at the
   * moment it is opened, when an already-visible window is by construction the
   * one the user just targeted; this decision has NO input saying whether the
   * window actually holds OS focus. If a future path re-registers an
   * already-visible BACKGROUND window while another window holds OS focus,
   * this pump would steal `front` from the genuinely-focused window. Such a
   * path must not reuse this decision as-is: it needs real focus state as an
   * input (pump `focused: <actual OS focus>` instead), or must suppress the
   * shown pump entirely.
   */
  pumpShownEvent: boolean;
}

/**
 * decideWindowRegistration — the SINGLE owner of the "is this a re-registration,
 * and if so what carries over vs. what the new spec overwrites?" branch that
 * `WindowOsAdapter.registerWindow` executes.
 *
 * WHY it lives here and not next to its callers: `electron-window-backend.ts`
 * (which executes the merge/listener half) has a value-side
 * `import { app, globalShortcut } from 'electron'`, and `window-os-adapter.ts`
 * (which executes the pump/Esc-attach half) pulls it in transitively as its
 * default backend. The main-process unit gate runs its tests under
 * `ELECTRON_RUN_AS_NODE=1`, where that import throws at parse ("The requested
 * module 'electron' does not provide an export named …" — see the explanatory
 * comment in `window-registry.ts`). A test file importing either module would
 * take down the whole ~1950-test runner. `window-state.ts` has zero imports,
 * so the decision is testable here and nowhere else. Same pattern as the pure
 * predicates in `izui-roles.ts` and `isSatelliteRegistration` above.
 */
export function decideWindowRegistration(input: {
  /** Whether the adapter already retains an entry for this window id. */
  alreadyRegistered: boolean;
  kind: WindowKind;
  /** Whether the spec carries a `contentWC` field at all (`undefined` = absent). */
  hasContentWC: boolean;
  /** The spec's `attachEscHandler` opt-out (`undefined` = default on). */
  attachEscHandlerRequested?: boolean;
  /**
   * Whether the native window is ALREADY VISIBLE at registration time
   * (`win.isVisible()`, read once by the adapter). `undefined` = not visible.
   * Drives `pumpShownEvent` — see its doc for why registration must import
   * current visibility (a ctor-shown window has no `'show'` transition).
   */
  nativeVisible?: boolean;
}): WindowRegistrationDecision {
  const { alreadyRegistered, kind, hasContentWC, attachEscHandlerRequested, nativeVisible } = input;
  const fresh = !alreadyRegistered;
  return {
    reRegistration: alreadyRegistered,
    attachNativeListeners: fresh,
    attachEscHandler: fresh && kind === 'browser' && attachEscHandlerRequested !== false,
    adoptRendererWC: fresh || hasContentWC,
    pumpRegisteredEvent: true,
    // Registration-time-only assumption — see the `pumpShownEvent` field doc:
    // visible-at-registration implies "just opened, user-targeted" ONLY while
    // every caller registers at open time. A path re-registering a visible
    // background window must not take this branch as-is (latent front-steal).
    pumpShownEvent: nativeVisible === true,
  };
}

/** A record is a legal `front` iff it is live, visible, and non-satellite. */
export function isEligibleFront(rec: WindowRecord | undefined): rec is WindowRecord {
  return !!rec && rec.visible && !rec.satellite;
}

/** MRU successor: the visible non-satellite window with the highest focusSeq (null if none). */
function successorFront(state: AppWindowState, excludeId?: WindowId): WindowId | null {
  let best: WindowRecord | null = null;
  for (const rec of state.windows.values()) {
    if (rec.id === excludeId) continue;
    if (!isEligibleFront(rec)) continue;
    if (!best || rec.focusSeq > best.focusSeq) best = rec;
  }
  return best ? best.id : null;
}

/** True while ANY window is mid-transition (entering/leaving fullscreen) — the "transition pin". */
export function anyFullscreenTransitionInFlight(state: AppWindowState): boolean {
  for (const rec of state.windows.values()) {
    if (rec.fsMode.name === 'entering-fullscreen' || rec.fsMode.name === 'leaving-fullscreen') return true;
  }
  return false;
}

/** Whether `state.front` currently satisfies the front invariant. */
export function frontInvariantHolds(state: AppWindowState): boolean {
  if (state.front == null) return true;
  return isEligibleFront(state.windows.get(state.front));
}

/** A record belongs in the ordered stack iff it is level-`stacked` AND visible. */
function isStackMember(rec: WindowRecord | undefined): rec is WindowRecord {
  return !!rec && rec.stackingLevel === 'stacked' && rec.visible;
}

/**
 * Whether `stackOrder` currently satisfies its invariant: no duplicates, and
 * its membership is EXACTLY the records with `stackingLevel 'stacked' &&
 * visible` (order itself is state, not derivable — this checks consistency,
 * not position). Exported for the test suite's per-step assertion, the same
 * way `frontInvariantHolds` is.
 */
export function stackOrderInvariantHolds(state: AppWindowState): boolean {
  const seen = new Set<WindowId>();
  for (const id of state.stackOrder) {
    if (seen.has(id)) return false;
    seen.add(id);
    if (!isStackMember(state.windows.get(id))) return false;
  }
  for (const rec of state.windows.values()) {
    if (isStackMember(rec) && !seen.has(rec.id)) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Immutable-update helpers (the reducer must not mutate its input)
// ─────────────────────────────────────────────────────────────────────────────

function cloneState(state: AppWindowState): AppWindowState {
  return {
    appActive: state.appActive,
    session: state.session,
    front: state.front,
    stackOrder: [...state.stackOrder],
    switcher: state.switcher,
    windows: new Map(state.windows),
    focusSeqCounter: state.focusSeqCounter,
    openSeqCounter: state.openSeqCounter,
    escAsk: state.escAsk,
    escSeq: state.escSeq,
    pendingAppResignSweep: state.pendingAppResignSweep,
    pendingColdStartFocus: state.pendingColdStartFocus,
  };
}

/** Copy a record and apply a patch; write it back into a (freshly cloned) map. */
function patchRecord(state: AppWindowState, id: WindowId, patch: Partial<WindowRecord>): void {
  const cur = state.windows.get(id);
  if (!cur) return;
  state.windows.set(id, { ...cur, ...patch });
}

/**
 * The SINGLE place a window moves from "holding a deferred `DISPLAY_CHANGED`
 * projection" to "flushed" (see `WindowRecord.pendingProjectedBounds`). Called
 * from every transition that can lift ONE of the two blocking axes
 * (`→ normal` fsMode, `WINDOW_SHOWN`); only actually emits once BOTH are
 * clear — a window that becomes visible while still fullscreen keeps holding.
 */
function flushPendingProjection(state: AppWindowState, id: WindowId, effects: Effect[]): void {
  const rec = state.windows.get(id);
  if (!rec || rec.pendingProjectedBounds === null) return;
  if (rec.fsMode.name !== 'normal' || !rec.visible) return; // still blocked on the other axis
  effects.push({ type: 'SET_BOUNDS', id, bounds: rec.pendingProjectedBounds });
  patchRecord(state, id, { pendingProjectedBounds: null });
}

/**
 * Drop a held `DISPLAY_CHANGED` projection WITHOUT emitting it — called from
 * every explicit bounds write (`SET_BOUNDS_REQUESTED` / `MAXIMIZE_REQUESTED` /
 * `UNMAXIMIZE_REQUESTED`) so a stale deferred projection can never snap a
 * deliberately-moved window back afterwards.
 */
function discardPendingProjection(state: AppWindowState, id: WindowId): void {
  const rec = state.windows.get(id);
  if (!rec || rec.pendingProjectedBounds === null) return;
  patchRecord(state, id, { pendingProjectedBounds: null });
}

/** Bump a record's focusSeq to a fresh MRU value. Mutates the (already-cloned) state. */
function bumpFocusSeq(state: AppWindowState, id: WindowId): void {
  const cur = state.windows.get(id);
  if (!cur) return;
  state.focusSeqCounter += 1;
  state.windows.set(id, { ...cur, focusSeq: state.focusSeqCounter });
}

/** Drop a window from the ordered stack (hide/close). Mutates the cloned state. */
function stackRemove(state: AppWindowState, id: WindowId): void {
  const i = state.stackOrder.indexOf(id);
  if (i !== -1) state.stackOrder.splice(i, 1);
}

/**
 * Move a window to the TOP of the ordered stack (appending if absent) — the
 * list mirror of a native order-front. No-op for a non-member (hidden /
 * pinned / excluded), which keeps the membership invariant by construction.
 */
function stackRaise(state: AppWindowState, id: WindowId): void {
  if (!isStackMember(state.windows.get(id))) return;
  stackRemove(state, id);
  state.stackOrder.push(id);
}

/**
 * Re-establish a single window's stack membership after something that can
 * flip it (the richer re-registration merge changing `satellite`/`class`).
 * A window that becomes a member joins at the TOP (it is visible now, and
 * registration happens at open time); one that stops being a member leaves.
 */
function reconcileStackMembership(state: AppWindowState, id: WindowId): void {
  const rec = state.windows.get(id);
  if (isStackMember(rec)) {
    if (!state.stackOrder.includes(id)) state.stackOrder.push(id);
  } else {
    stackRemove(state, id);
  }
}

/**
 * Whether the front-invariant guard THROWS (dev/test) rather than silently
 * self-correcting (production). Read live (not cached) so tests can flip the
 * boundary per-case.
 *
 * Boundary choice (design §2.5): `process.env.NODE_ENV !== 'production'`.
 *   - The main-process unit gate runs with `NODE_ENV=test`, and standalone
 *     `node --test` leaves `NODE_ENV` unset — both are non-production, so the
 *     guard is ACTIVE there and a reducer bug throws instead of being papered.
 *   - The packaged production app runs with `NODE_ENV=production`, where an
 *     illegal front self-corrects silently.
 * Chosen over importing `config.ts`'s `isTestProfile()`/`isDevProfile()` to keep
 * this reducer strictly Electron-free and free of runtime-state coupling.
 */
function throwOnIllegalFront(): boolean {
  return process.env.NODE_ENV !== 'production';
}

/**
 * Re-establish the front invariant as the FINAL step of every reduce (design
 * §2.5). If `reduce` produced an illegal `front` (absent / hidden / satellite):
 *   - dev/test: THROW, naming the offending event + illegal front id, so the
 *     reducer bug is caught, not papered. For a correct reducer this never fires
 *     on a legitimate event sequence.
 *   - production: self-correct to the MRU successor.
 */
function enforceFrontInvariant(state: AppWindowState, event: WindowEvent): void {
  if (frontInvariantHolds(state)) return;
  if (throwOnIllegalFront()) {
    throw new Error(
      `[window-state] reduce produced an illegal front=${state.front} after ${event.type}: ` +
        `front must reference a live, visible, non-satellite window. This is a reducer bug.`,
    );
  }
  state.front = successorFront(state);
}

/**
 * Drive a raise onto the OS: `RAISE_WINDOW` (+ `FOCUS_CONTENT` for a page-host)
 * + `SET_STACKING`, and the matching list mirror.
 *
 * The SOLE `RAISE_WINDOW` emitter, and that is load-bearing: no arm reachable
 * from a `RAISE_WINDOW` echo may call it, i.e. the `WINDOW_SHOWN` and
 * `OS_FOCUS_GAINED` arms must NEVER call this. That structural fact — not a
 * runtime ordering coincidence — is what terminates the `window-os-adapter.ts`
 * `pump` drain (see its docblock).
 */
function applyRaiseRequest(state: AppWindowState, id: WindowId | null, effects: Effect[]): void {
  if (id == null) return;
  if (!state.appActive) return; // no focus theft while Peek is background (sites 2 and 3 fire while inactive)
  if (state.switcher.open) return; // must not yank key out of the overlay
  const rec = state.windows.get(id);
  if (!isEligibleFront(rec)) return;
  effects.push({ type: 'RAISE_WINDOW', id });
  if (rec.kind === 'page-host') effects.push({ type: 'FOCUS_CONTENT', id });
  effects.push({ type: 'SET_STACKING', id, level: rec.stackingLevel });
  stackRaise(state, id);
}

/**
 * Record what an `OS_FOCUS_GAINED` that landed on `front` ALREADY realized —
 * the OS itself made that window key and ordered it front, so the machine
 * mirrors the order rather than driving a raise back at the OS.
 *
 * Echoing a raise here would not be merely redundant, it is a feedback loop:
 * `RAISE_WINDOW` is an ACTIVATING show+focus, so with several focus events in
 * flight (a restore loop show()s multiple tiles active while the app is
 * frontmost), each stale event flips `front`, the echoed raise re-keys that
 * stale window and emits a FRESH focus event, and three windows ping-pong
 * forever (observed live, 2026-07-22 clone restore — megabytes of
 * `OS_FOCUS_GAINED` → `RAISE_WINDOW` cycles; headless runs can never ignite it
 * because a non-frontmost app's `focus()` does not move the key window).
 * Without the echo the stale in-flight events drain and the LAST one matches
 * the true native key window — convergence by construction.
 *
 * The one half the OS event does NOT vouch for is a page-host's CONTENT first
 * responder (host key ≠ content focused — the 7c61e917 raise-by-chrome bug), so
 * that half IS driven. Only for `kind: 'page-host'`: `attachNativeListeners`
 * wires the content `rendererWC` for page-hosts alone, and a browser window's
 * root webContents is first responder whenever the window is key.
 *
 * Called from the `OS_FOCUS_GAINED` arm ONLY — deliberately NOT from
 * `applyFocusGained`, which `WINDOW_SHOWN {focused:true}` also reaches. That
 * event's dominant producer is `decideWindowRegistration.pumpShownEvent`, a
 * registration-time visibility IMPORT that makes no claim about OS focus, so
 * pushing `FOCUS_CONTENT` from there would steal first responder onto a
 * just-registered background window.
 */
function applyOsFocusRealized(state: AppWindowState, id: WindowId, effects: Effect[]): void {
  if (!state.appActive) return;
  if (state.front !== id) return;
  const rec = state.windows.get(id);
  if (!rec) return;
  if (rec.kind === 'page-host') effects.push({ type: 'FOCUS_CONTENT', id });
  stackRaise(state, id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Overlay attachment + transient autoclose (§4.3 dim 3b, §4.4 dim 4b, §5 step 9)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The overlay attached to `hostId`, or null. A scan rather than an index: the
 * app has one shared chrome overlay and the record set is small — see the
 * direction note on `WindowRecord.overlayFor`.
 */
export function overlayIdForHost(state: AppWindowState, hostId: WindowId): WindowId | null {
  for (const rec of state.windows.values()) {
    if (rec.overlayFor === hostId) return rec.id;
  }
  return null;
}

/**
 * Drive the overlay attached to `hostId` (if any) onto the host — the machine
 * form of `hybrid-overlay.ts frameBounds()`, with every live query it made
 * replaced by a record read:
 *
 *   `baseWin.isFullScreen()`  -> the host record's `fsMode`
 *   module-level `appActive`  -> `AppWindowState.appActive` (the ONE copy)
 *   `overlayWin.isVisible()`  -> the overlay record's `visible`
 *
 * The decision, in the SAME order the original performed it:
 *   - host not `normal` (entering / in / leaving native fullscreen): the chrome
 *     is unavailable — take the overlay off screen and drive NOTHING else. A
 *     normal-level window pushed over a fullscreen Space is what AppKit used to
 *     promote into an all-black fullscreen tile, so this must precede the bounds
 *     write, not follow it.
 *   - `frame` given: `SET_BOUNDS` — position/size ALWAYS happens, even while the
 *     app is inactive.
 *   - app inactive: STOP (peek 71cfde09 item 7 / R6). Never reveal the chrome or
 *     float it over the foreground app; `APP_ACTIVATED` re-runs this follow and
 *     reveals it then, which is why no timer or poll is needed.
 *   - else: `SET_STACKING` (the overlay's z-pinning re-assert — §4.3 makes
 *     `setStacking` the sole ordering effect; on a `pinned` record the executor
 *     realizes it as the floating-level re-assert the original did with
 *     `setAlwaysOnTop(true, 'floating')`), then `SHOW_WINDOW { activate: false }`
 *     when the overlay is not already visible — the original's `showInactive()`,
 *     focus-free.
 *
 * `visible` is NOT written here: like every other show/hide intent in this
 * reducer it flips on the backend's native `shown`/`hidden` echo.
 */
function applyOverlayFollow(
  state: AppWindowState,
  hostId: WindowId,
  frame: Rectangle | undefined,
  effects: Effect[],
): void {
  const overlayId = overlayIdForHost(state, hostId);
  if (overlayId == null) return;
  const overlay = state.windows.get(overlayId);
  const host = state.windows.get(hostId);
  if (!overlay || !host) return;

  if (host.fsMode.name !== 'normal') {
    if (overlay.visible) effects.push({ type: 'HIDE_WINDOW', id: overlayId });
    return;
  }
  if (frame) effects.push({ type: 'SET_BOUNDS', id: overlayId, bounds: frame });
  if (!state.appActive) return;
  effects.push({ type: 'SET_STACKING', id: overlayId, level: overlay.stackingLevel });
  if (!overlay.visible) effects.push({ type: 'SHOW_WINDOW', id: overlayId, activate: false });
}

/**
 * Detach an overlay from whatever it framed and take it off screen — the
 * `retarget(null)` path (no host, or the host vanished). Clearing the relation
 * is what keeps `overlayFor` from dangling onto a dead id.
 */
function detachOverlay(state: AppWindowState, overlayId: WindowId, effects: Effect[]): void {
  const overlay = state.windows.get(overlayId);
  if (!overlay) return;
  if (overlay.overlayFor === undefined) return;
  patchRecord(state, overlayId, { overlayFor: undefined });
  if (overlay.visible) effects.push({ type: 'HIDE_WINDOW', id: overlayId });
}

/**
 * The roles that are TRANSIENT — they open and close frequently and ride above
 * the workspace. Ported VERBATIM from `izui-roles.ts TRANSIENT_ROLES`, which
 * survives the §5 step 9 cutover for its OTHER consumer (the `peek://`
 * devtools/URL gating in `ipc.ts`). The two must agree.
 */
const TRANSIENT_ROLES: ReadonlySet<string> = new Set(['palette', 'quick-view', 'overlay']);

/**
 * Transient roles that the autoclose EXEMPTS. `overlay` is transient-class but
 * manages its own show/hide through the attachment relation above, never
 * through a close — so an autoclose must never touch it (ported verbatim from
 * `selectTransientSiblingsToClose`'s `if (c.role === 'overlay') continue`).
 */
const AUTOCLOSE_EXEMPT_ROLES: ReadonlySet<string> = new Set(['overlay']);

/**
 * Roles that, when THEY are the one gaining focus, must sweep NOTHING —
 * the focuser-side exemption set. Distinct from `AUTOCLOSE_EXEMPT_ROLES`
 * (which protects a transient from being SWEPT); this set protects other
 * transients from being swept BY a focus on one of these roles:
 *
 *   - `utility`  a chain popup, child of a transient — it must not dismiss
 *                its own transient parent (ported verbatim from the
 *                pre-cutover `focuser?.role === 'utility'` short-circuit).
 *   - `overlay`  the shared chrome overlay (`hybrid-overlay.ts`) is app
 *                chrome attached to the very window it would be dismissing
 *                (it is explicitly focusable — Cmd+L into the navbar) — a
 *                focus landing on it is not "the user switched to a
 *                different window" and must not sweep the host it frames.
 *                Needed because d9509368 moved this clause from running on
 *                exactly two focus producers (`ipc.ts` window-open's
 *                `win.on('focus')` and `onHybridHostFocus`) into the reducer
 *                driven by `OS_FOCUS_GAINED`, which fires for EVERY
 *                machine-registered window's focus — including the overlay's.
 */
const AUTOCLOSE_FOCUSER_EXEMPT_ROLES: ReadonlySet<string> = new Set(['utility', 'overlay']);

/**
 * Which transient siblings a newly-focused window dismisses (§4.4 dim 4b) —
 * the reducer port of `izui-roles.ts selectTransientSiblingsToClose`, with the
 * candidate gathering (two registries + a live `isVisible()` per window)
 * replaced by the record set. Semantics are preserved EXACTLY:
 *
 *   - a focuser whose role is in `AUTOCLOSE_FOCUSER_EXEMPT_ROLES` closes
 *     NOTHING;
 *   - skip the focuser itself, any non-visible window, any non-transient role;
 *   - `overlay` is exempt as a VICTIM too (see `AUTOCLOSE_EXEMPT_ROLES`).
 *
 * An UNREGISTERED focuser (no record) has an undefined role, which is not in
 * the exempt set — so it closes every visible transient, matching the
 * original's `getWindowInfo(focusedId)?.params?.role` returning undefined.
 *
 * Kind-agnostic on purpose: the original's whole point was that BOTH plain
 * BrowserWindows and hybrid page-hosts are candidates (the close-on-blur
 * regression, peek 8e5c3174, was hybrid windows never being in the set).
 *
 * ONE further clause, on top of the ported semantics — the SLOW-OPEN RACE. The
 * user hotkeys a page host (a peek/slide), it takes time to load, and before it
 * finishes the user opens a palette. Then the host's load completes, it takes
 * OS focus, and this sweep dismissed the palette the user asked for AFTERWARDS.
 * The missing fact was never "which role" — it was WHEN the action that caused
 * this focus was initiated, which is why the fix is not a third entry in
 * `AUTOCLOSE_FOCUSER_EXEMPT_ROLES` (the roles involved are exactly the ones a
 * legitimate switch must still sweep). So: a window whose activating show has
 * not yet produced a focus — `shownWithActivateIntent && !hasHeldOsFocus` —
 * cannot dismiss anything registered after it (`openSeq` greater than its own).
 * Every SUBSEQUENT focus on that window sweeps exactly as before, which is what
 * keeps "the user clicked back onto the host" dismissing the palette.
 */
export function selectTransientAutoclose(state: AppWindowState, focusedId: WindowId): WindowId[] {
  const focuser = state.windows.get(focusedId);
  if (focuser && AUTOCLOSE_FOCUSER_EXEMPT_ROLES.has(focuser.role)) return [];
  // See the docblock. An unregistered focuser has no seq and no arming, so it
  // sweeps everything, unchanged.
  const focuserIsCompletingItsOpen =
    focuser !== undefined && focuser.shownWithActivateIntent === true && focuser.hasHeldOsFocus !== true;
  const out: WindowId[] = [];
  for (const rec of state.windows.values()) {
    if (rec.id === focusedId) continue;
    if (!rec.visible) continue;
    if (!TRANSIENT_ROLES.has(rec.role)) continue;
    if (AUTOCLOSE_EXEMPT_ROLES.has(rec.role)) continue;
    if (focuserIsCompletingItsOpen && rec.openSeq > (focuser as WindowRecord).openSeq) continue;
    out.push(rec.id);
  }
  return out;
}

/**
 * Which transient surfaces a REAL app switch dismisses (§4.4 dim 4b) — the
 * reducer port of `ipc.ts doCloseTransientHybridWindows`. Same role/visibility
 * rule as the focus-driven autoclose with no focuser to exclude, and scoped to
 * `page-host` windows: a transient BrowserWindow modal already self-closes via
 * its own per-window `blur` handler on app blur, so sweeping it here would race
 * that path (the original's "scoped to HYBRID windows" comment).
 */
export function selectAppResignTransients(state: AppWindowState): WindowId[] {
  const out: WindowId[] = [];
  for (const rec of state.windows.values()) {
    if (rec.kind !== 'page-host') continue;
    if (!rec.visible) continue;
    if (!TRANSIENT_ROLES.has(rec.role)) continue;
    if (AUTOCLOSE_EXEMPT_ROLES.has(rec.role)) continue;
    out.push(rec.id);
  }
  return out;
}

/**
 * How `WINDOW_CLOSE_OR_HIDE_REQUESTED` resolves the keepLive decision for ONE
 * window (the app-facing "close" that may really be a hide).
 *
 * NOT `DESTROY_WINDOW`, despite §4.4's "emitting destroy effects" wording: a
 * `keepLive` slide (the left slide playing music) must be HIDDEN, not destroyed
 * — destroying it is exactly the regression peek 2c94c125 fixed.
 */
function closeOrHideEffect(rec: WindowRecord): Effect {
  return rec.keepLive ? { type: 'HIDE_WINDOW', id: rec.id } : { type: 'CLOSE_WINDOW', id: rec.id };
}

/**
 * Emit the dismissal effect for a list of AUTOCLOSE transient siblings.
 *
 * Unconditionally `CLOSE_WINDOW`, never the keepLive-resolved
 * `closeOrHideEffect` above: `CLOSE_WINDOW` routes through
 * `backend.closeOrHide` -> `windows.ts closeOrHideWindow`, which runs the
 * black-macOS-Space preamble (exit native fullscreen, await the settled
 * `normal` mode) BEFORE it re-dispatches `WINDOW_CLOSE_OR_HIDE_REQUESTED` to
 * resolve keepLive here. Pre-resolving to `HIDE_WINDOW` here would skip that
 * preamble for a fullscreen keepLive victim — the bug this comment is
 * guarding against (a raw `hide()` while still fullscreen strands a black
 * Space). Keeping this a bare `CLOSE_WINDOW` reproduces the pre-cutover path,
 * where every dismissed window (regardless of keepLive) went through
 * `closeOrHideWindow` and only THAT function's own keepLive branch decided
 * hide-vs-close.
 */
function pushCloseOrHide(state: AppWindowState, ids: WindowId[], effects: Effect[]): void {
  for (const id of ids) {
    if (state.windows.has(id)) effects.push({ type: 'CLOSE_WINDOW', id });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fullscreen sub-reducer (§2.4 transition table). Total over (mode x event).
// Mutates the already-cloned `state`; pushes effects onto `effects`.
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve the desired fullscreen state for a toggle/explicit request. */
function desiredFullscreen(mode: FsMode, desired: boolean | undefined): boolean {
  if (desired !== undefined) return desired;
  // Toggle semantics against the current mode.
  switch (mode.name) {
    case 'normal':
      return true;
    case 'fullscreen':
      return false;
    case 'entering-fullscreen':
      return false; // toggling mid-enter means cancel
    case 'leaving-fullscreen':
      return true; // toggling mid-leave means re-enter
  }
}

function applyFullscreenRequest(
  state: AppWindowState,
  id: WindowId,
  desired: boolean | undefined,
  bounds: Rectangle | null | undefined,
  effects: Effect[],
): void {
  const rec = state.windows.get(id);
  if (!rec) return;
  const mode = rec.fsMode;
  const want = desiredFullscreen(mode, desired);

  switch (mode.name) {
    case 'normal': {
      if (!want) return; // already normal -> no-op
      patchRecord(state, id, { fsMode: { name: 'entering-fullscreen', preBounds: bounds ?? null } });
      effects.push({ type: 'SET_FULLSCREEN', id, on: true });
      return;
    }
    case 'fullscreen': {
      if (want) return; // already fullscreen -> no-op
      patchRecord(state, id, { fsMode: { name: 'leaving-fullscreen', preBounds: mode.preBounds } });
      effects.push({ type: 'SET_FULLSCREEN', id, on: false });
      return;
    }
    case 'entering-fullscreen': {
      // Coalesce: record the latest desire, DO NOT issue a second setFullScreen
      // mid-animation. Honored when OS_FULLSCREEN_ENTERED settles.
      patchRecord(state, id, { fsMode: { ...mode, pendingDesire: want } });
      return;
    }
    case 'leaving-fullscreen': {
      patchRecord(state, id, { fsMode: { ...mode, pendingDesire: want } });
      return;
    }
  }
}

function applyOsFullscreenEntered(state: AppWindowState, id: WindowId, effects: Effect[]): void {
  const rec = state.windows.get(id);
  if (!rec) return;
  const mode = rec.fsMode;
  switch (mode.name) {
    case 'normal': {
      // OS/green-button initiated entry — no stash was possible.
      patchRecord(state, id, { fsMode: { name: 'fullscreen', preBounds: null } });
      return;
    }
    case 'entering-fullscreen': {
      patchRecord(state, id, { fsMode: { name: 'fullscreen', preBounds: mode.preBounds } });
      // Honor a coalesced "actually, leave" desire recorded mid-animation.
      if (mode.pendingDesire === false) {
        applyFullscreenRequest(state, id, false, undefined, effects);
      }
      return;
    }
    case 'leaving-fullscreen': {
      // OS won the race — the window is fullscreen after all.
      patchRecord(state, id, { fsMode: { name: 'fullscreen', preBounds: mode.preBounds } });
      return;
    }
    case 'fullscreen':
      return; // no-op
  }
}

function applyOsFullscreenLeft(state: AppWindowState, id: WindowId, effects: Effect[]): void {
  const rec = state.windows.get(id);
  if (!rec) return;
  const mode = rec.fsMode;
  switch (mode.name) {
    case 'fullscreen': {
      // OS/green-button initiated leave — clear stash.
      patchRecord(state, id, { fsMode: { name: 'normal' } });
      flushPendingProjection(state, id, effects);
      return;
    }
    case 'leaving-fullscreen': {
      patchRecord(state, id, { fsMode: { name: 'normal' } });
      flushPendingProjection(state, id, effects);
      // Honor a coalesced "actually, re-enter" desire (no captured bounds here).
      if (mode.pendingDesire === true) {
        applyFullscreenRequest(state, id, true, null, effects);
      }
      return;
    }
    case 'entering-fullscreen': {
      // Aborted by the OS mid-enter.
      patchRecord(state, id, { fsMode: { name: 'normal' } });
      flushPendingProjection(state, id, effects);
      return;
    }
    case 'normal':
      return; // no-op
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The reducer — the ONLY mutator. Pure: builds and returns a new state.
// ─────────────────────────────────────────────────────────────────────────────

export function reduce(prev: AppWindowState, event: WindowEvent): ReduceResult {
  const state = cloneState(prev);
  const effects: Effect[] = [];
  const prevFront = prev.front;

  switch (event.type) {
    case 'WINDOW_REGISTERED': {
      const existing = state.windows.get(event.id);
      if (existing) {
        // RE-registration is a MERGE, never a reset. Two live call sites register
        // the same BrowserWindow (the tile-launcher hook and the ipc.ts
        // window-open site), and the later one carries the RICHER spec (real
        // `modal`/`focusable` → `isSatelliteRegistration`), so the incoming
        // declared fields must win. What must NOT be reset is everything the
        // window has since LIVED: rebuilding a fresh record would drop it back to
        // `visible:false, focusSeq:0, fsMode:normal`, which silently makes an
        // already-visible focused window front-ineligible → the front invariant
        // guard throws (dev) or reassigns `front` (production).
        state.windows.set(event.id, {
          ...existing,
          kind: event.kind,
          role: event.role,
          escapeMode: event.escapeMode,
          satellite: event.satellite,
          class: event.class ?? existing.class,
          // Re-derive from the merged (richer) spec — it can flip `satellite`
          // and therefore the level; membership is reconciled below.
          stackingLevel: deriveStackingLevel(event.class ?? existing.class, event.satellite),
          // Orderability only ever upgrades: compositing is a fact about the
          // native window, not the spec, so a re-registration never resets it.
          orderable: existing.orderable || event.kind !== 'page-host',
          parentId: event.parentId ?? existing.parentId,
          source: event.source ?? existing.source,
          params: event.params ?? existing.params,
          keepLive: event.keepLive ?? existing.keepLive,
          lastHttpUrl: event.lastHttpUrl ?? existing.lastHttpUrl,
          // The lived mirror wins (BOUNDS_CHANGED reports are fresher than a
          // re-registration's boundary read); the seed only fills absence.
          bounds: existing.bounds ?? event.bounds,
        });
        // If the richer spec turned the CURRENT front into a satellite, hand
        // `front` to the MRU successor here rather than leave an illegal front
        // for the guard to trip on.
        if (state.front === event.id && !isEligibleFront(state.windows.get(event.id))) {
          state.front = successorFront(state, event.id);
        }
        // The re-derived level can add or remove the window from the ordered
        // stack (e.g. the richer spec revealing `modal` demotes it to
        // 'excluded' — the same flip the front fixup above handles).
        reconcileStackMembership(state, event.id);
        // Declared always-on-top intent (see the fresh branch below) —
        // idempotent to re-assert on a richer re-registration.
        if (event.alwaysOnTop === true) {
          effects.push({ type: 'SET_ALWAYS_ON_TOP', id: event.id, on: true });
        }
        break;
      }
      // Registration order — see `WindowRecord.openSeq`. Bumped ONLY here, on
      // record creation; the merge branch above keeps the existing stamp.
      state.openSeqCounter += 1;
      const rec: WindowRecord = {
        id: event.id,
        kind: event.kind,
        role: event.role,
        class: event.class ?? 'primary',
        stackingLevel: deriveStackingLevel(event.class ?? 'primary', event.satellite),
        // A browser window's NSWindow is orderable from birth; a page-host's
        // no-ops raises until first composited frame (WINDOW_CONTENT_ORDERABLE).
        orderable: event.kind !== 'page-host',
        parentId: event.parentId ?? undefined,
        source: event.source,
        params: event.params,
        escapeMode: event.escapeMode,
        satellite: event.satellite,
        keepLive: event.keepLive,
        visible: false,
        fsMode: { name: 'normal' },
        // Registration-time seed of the bounds mirror (see the event field
        // doc); BOUNDS_CHANGED remains the sole ONGOING writer.
        bounds: event.bounds,
        maximized: false,
        preMaxBounds: null,
        // The platform default (§4.2 dim 7b): a fresh window lives on one
        // Space until something asks otherwise.
        visibleOnAllSpaces: false,
        // Nothing has been projected-and-blocked yet — see the field doc.
        pendingProjectedBounds: null,
        focusSeq: 0,
        openSeq: state.openSeqCounter,
        lastHttpUrl: event.lastHttpUrl,
      };
      state.windows.set(event.id, rec);
      // Declared always-on-top: registration is the ONE place the pin is
      // asserted (replaces the ipc.ts post-ctor `setAlwaysOnTop(true,
      // 'floating')` reinforcement — the macOS ctor flag alone is unreliable).
      if (event.alwaysOnTop === true) {
        effects.push({ type: 'SET_ALWAYS_ON_TOP', id: event.id, on: true });
      }
      break;
    }

    case 'WINDOW_PARAMS_SET': {
      const rec = state.windows.get(event.id);
      if (!rec) break; // unknown window — the payload has nothing to attach to
      state.windows.set(event.id, {
        ...rec,
        source: event.source,
        params: event.params,
        keepLive: event.keepLive ?? rec.keepLive,
      });
      break;
    }

    case 'WINDOW_CLOSE_REQUESTED': {
      // No state change — the record retires on the WINDOW_CLOSED event the
      // native teardown emits. The effect is emitted even for an unknown id:
      // the backend resolves the handle itself and no-ops when gone.
      effects.push({ type: 'CLOSE_WINDOW_DIRECT', id: event.id });
      break;
    }

    case 'WINDOW_CLOSE_OR_HIDE_REQUESTED': {
      const rec = state.windows.get(event.id);
      if (!rec) break; // unknown window — nothing to decide against
      // keepLive: hide, keep the record registered. `visible` is untouched
      // here — it flips on the backend's native hide event (WINDOW_HIDDEN).
      // Otherwise: the resolved close (no keepLive policy left to apply).
      // This is the SOLE keepLive resolution point now: the §5 step 9
      // transient autoclose (`pushCloseOrHide`) deliberately emits a bare
      // `CLOSE_WINDOW` instead of pre-resolving here, so `closeOrHideWindow`'s
      // fullscreen-exit preamble runs before this decision is re-dispatched.
      effects.push(closeOrHideEffect(rec));
      break;
    }

    case 'WINDOW_DESTROY_REQUESTED': {
      effects.push({ type: 'DESTROY_WINDOW', id: event.id });
      break;
    }

    case 'WINDOW_SHOW_REQUESTED': {
      effects.push({ type: 'SHOW_WINDOW', id: event.id, activate: event.activate });
      // The CONTENT half of the show invariant (§5 step 8 — the last direct OS
      // call `windows.ts showHybridHost` used to make itself). A page-host
      // shown WITH activation intent must also make its content
      // `WebContentsView` the macOS first responder, or key equivalents (ESC,
      // cmd+L) reach no target: NSBeep, and the overlay never reveals
      // (regression cluster 1b6eaf0b / 7c61e917).
      //
      // Not redundant with the show it accompanies: `showWindow` in
      // `electron-window-backend.ts` MASKS `osActivate` to false for a
      // `quick-view` page-host (a non-activating `type:'panel'` NSPanel takes
      // key input without activating the app — regression 524f7aba), so the
      // show alone never confers first responder there.
      //
      // Deliberately NOT routed through `applyRaiseRequest`: that would put a
      // `RAISE_WINDOW` on the window-OPEN path, and a raise is an activating
      // show whose `WINDOW_SHOWN` echo would feed straight back — the very
      // cycle the `WINDOW_SHOWN` arm exists to cut. `applyRaiseRequest` stays
      // the sole `RAISE_WINDOW` emitter.
      //
      // `activate:false` (session restore's `show:false` opens) emits nothing:
      // a restored host must stay focus-free until the restore loop picks the
      // ONE descriptor to re-activate. Non-page-host kinds emit nothing either
      // — only a page-host has a separate content WC to focus (the backend
      // wires `rendererWC` for page-hosts alone). Headless is handled where
      // every other focus effect is, in the executor's `FOCUS_CONTENT` arm.
      const showRec = state.windows.get(event.id);
      if (event.activate && showRec?.kind === 'page-host') {
        effects.push({ type: 'FOCUS_CONTENT', id: event.id });
      }
      // The same `activate` fact, recorded on the record (§4.4 dim 4b): an
      // activating show is the app saying "put the user in this window", so the
      // focus that eventually lands is the COMPLETION of that action, not a new
      // gesture. `selectTransientAutoclose` needs that to tell the slow-open race
      // apart from a real window switch. Kind-agnostic on purpose (unlike the
      // FOCUS_CONTENT half above) — the race is about timing, not about having a
      // separate content WebContents.
      if (event.activate) patchRecord(state, event.id, { shownWithActivateIntent: true });
      break;
    }

    case 'WINDOW_HIDE_REQUESTED': {
      // No state change — `visible` flips on the backend's native hide event
      // (WINDOW_HIDDEN), mirroring WINDOW_SHOW_REQUESTED's echo contract. The
      // effect is emitted even for an unknown id: the backend resolves the
      // handle itself and no-ops when gone.
      effects.push({ type: 'HIDE_WINDOW', id: event.id });
      break;
    }

    case 'WINDOW_CONTENT_CLOSE_REQUESTED': {
      effects.push({ type: 'CLOSE_CONTENT', id: event.id });
      break;
    }

    case 'GUEST_TEARDOWN_REQUESTED': {
      effects.push({ type: 'DESTROY_ALL_GUESTS' });
      break;
    }

    case 'DEVTOOLS_OPENED':
    case 'DEVTOOLS_CLOSED': {
      // No state change. `event.id` — the window whose devtools opened/closed
      // — is deliberately UNUSED here: `main.ts` dispatches the devtools
      // host's own id, which need not be `front`, and raising it would steal
      // key onto a background window. The explicit raise targets
      // `state.front`, the window that actually lost key — the machine form
      // of the old "re-focus the content window when devtools opens/closes"
      // handlers. Devtools opens with activate:false, so re-driving here also
      // keeps the derived Esc grab off (a grabbed Esc would be eaten before
      // the devtools/front window ever saw it).
      applyRaiseRequest(state, state.front, effects);
      break;
    }

    case 'WINDOW_SHOWN': {
      const rec = state.windows.get(event.id);
      if (!rec) break;
      // Ordered-stack mirror: a HIDDEN→VISIBLE show orders the window frontmost
      // natively (`show` and `showInactive` both order-front), so the list
      // mirrors it on top. An ALREADY-VISIBLE record deliberately does NOT
      // reorder: every native show is emitted twice (the synchronous show-seam
      // dispatch and the backend's async native-'show' mirror), and the late
      // mirror lands AFTER whatever the machine has since decided — live-run
      // proof: a post-restore STACK_ORDER_IMPORTED was scrambled back to show
      // order by the trailing page-host mirrors, and the first-frame re-drives
      // then realized the scrambled order on screen. A raise of a visible
      // window is a machine decision (`applyRaiseRequest` / SET_STACKING /
      // STACK_ORDER_IMPORTED), never inferred from a repeated native echo.
      // NOTE this arm emits NO raise at all, on either branch, including
      // `focused: true` — that is the `RAISE_WINDOW` → `WINDOW_SHOWN` echo
      // cycle, and cutting it here is what makes the pump's drain terminate
      // (see `applyRaiseRequest`). The `FOCUS_CONTENT` half of a genuine OS
      // focus arrives on the accompanying `OS_FOCUS_GAINED`.
      const wasVisible = rec.visible;
      patchRecord(state, event.id, { visible: true });
      if (!wasVisible) {
        stackRaise(state, event.id);
        // The other unblock edge for a held DISPLAY_CHANGED projection (see
        // `pendingProjectedBounds`) — flushes only if `fsMode` is ALSO normal.
        flushPendingProjection(state, event.id, effects);
      }
      // Session is NOT derived here — `izui-state.ts` owns it and feeds it in via
      // SESSION_CHANGED. Deriving it here would be a rival authority (§3).
      if (event.focused) {
        applyFocusGained(state, event.id);
      } else if (state.front == null && !rec.satellite) {
        // Non-satellite shown while there is no front -> seed it (restore /
        // show:false case the old resolver ranks 4-5 patched).
        state.front = event.id;
      }
      break;
    }

    case 'WINDOW_HIDDEN': {
      const rec = state.windows.get(event.id);
      if (!rec) break;
      // Judged BEFORE `front` moves to a successor — this is the case the
      // raise below exists for.
      const frontLeft = state.front === event.id;
      patchRecord(state, event.id, { visible: false });
      stackRemove(state, event.id);
      if (frontLeft) {
        state.front = successorFront(state, event.id);
      }
      // A host that left the screen has no chrome to wear (§5 step 9): detach
      // its overlay and take it down with it — the `retarget(null)` path.
      const overlayId = overlayIdForHost(state, event.id);
      if (overlayId != null) detachOverlay(state, overlayId, effects);
      // The front went off screen, so the OS gave key to whatever it liked —
      // drive the successor explicitly. Placed after `detachOverlay` so the
      // ordering stays [HIDE_WINDOW(overlay), RAISE_WINDOW, FOCUS_CONTENT,
      // SET_STACKING]. No-op for a null successor.
      if (frontLeft) applyRaiseRequest(state, state.front, effects);
      break;
    }

    case 'WINDOW_CONTENT_ORDERABLE': {
      const rec = state.windows.get(event.id);
      if (!rec) break;
      // Already orderable: a stray late frame (a surviving page-host
      // re-navigating re-runs its preload and reports again) must not restack —
      // the structural form of the legacy listener's disarm.
      if (rec.orderable) break;
      patchRecord(state, event.id, { orderable: true });
      // The window's earlier raises were window-server no-ops, so it sits
      // BELOW its intended position. Re-drive it and everything stacked above
      // it, bottom → top, converging native order onto `stackOrder` — order
      // only, no activation, no assertion change (front never moved).
      const idx = state.stackOrder.indexOf(event.id);
      if (idx !== -1) {
        for (const id of state.stackOrder.slice(idx)) {
          const member = state.windows.get(id);
          if (!member) continue;
          effects.push({ type: 'SET_STACKING', id, level: member.stackingLevel });
        }
      }
      break;
    }

    case 'STACK_ORDER_IMPORTED': {
      // Reorder only — membership is invariant by construction: the import is
      // filtered to CURRENT stack members (deduped), and members it does not
      // name keep their relative order below it. See the event doc.
      const named = new Set<WindowId>();
      const imported: WindowId[] = [];
      for (const id of event.order) {
        if (named.has(id)) continue;
        named.add(id);
        if (isStackMember(state.windows.get(id))) imported.push(id);
      }
      if (imported.length === 0) break;
      const unnamed = state.stackOrder.filter((id) => !named.has(id));
      state.stackOrder = [...unnamed, ...imported];
      // Realize the whole order natively, bottom → top (each relative raise
      // stacks on the previous). Order only — no raise, no assertion change.
      for (const id of state.stackOrder) {
        const member = state.windows.get(id);
        if (!member) continue;
        effects.push({ type: 'SET_STACKING', id, level: member.stackingLevel });
      }
      break;
    }

    case 'WINDOW_CLOSED': {
      const closedRec = prev.windows.get(event.id);
      state.windows.delete(event.id);
      stackRemove(state, event.id);
      // A pending renderer question aimed at this window can never be answered
      // meaningfully — drop it so a late answer is inert.
      if (state.escAsk && state.escAsk.id === event.id) state.escAsk = null;
      // Single raise target for this arm — computed below, emitted once at
      // the tail via `applyRaiseRequest` (no-op for null). The parent-handoff
      // assignment runs after the successor one and deliberately overwrites
      // it: a closing front child with an eligible parent raises the parent,
      // not the MRU successor.
      let raiseTarget: WindowId | null = null;
      if (state.front === event.id) {
        state.front = successorFront(state);
        raiseTarget = state.front;
      }
      // Parent refocus (replaces the deleted main.ts `browser-window-created →
      // 'closed' → parentWin.focus()` block): a closing window with a
      // registered parent hands the target back to that parent — taking
      // precedence over the MRU successor — whenever the parent is a legal
      // front. The raise below fires even when the parent already WAS front,
      // which is what re-drives the raise/first-responder exactly like the
      // old `parentWin.focus()` did.
      if (closedRec?.parentId != null) {
        const parent = state.windows.get(closedRec.parentId);
        if (isEligibleFront(parent)) {
          state.front = parent.id;
          bumpFocusSeq(state, parent.id);
          // Explicit parent-handoff raise (§5 step 5) — the child held key
          // right up to its close, so the parent is driven even when it
          // already was `front`.
          raiseTarget = parent.id;
        }
      }
      if (state.switcher.open && state.switcher.windowId === event.id) {
        state.switcher = { open: false };
      }
      // The framed host is gone (§5 step 9) — detach + hide its overlay rather
      // than leave `overlayFor` pointing at a retired id.
      const orphanedOverlay = overlayIdForHost(state, event.id);
      if (orphanedOverlay != null) detachOverlay(state, orphanedOverlay, effects);
      // Session end (last window closed -> idle) is owned by `izui-state.ts`
      // (its `popWindow`/`endSession`), mirrored in via SESSION_CHANGED. Not
      // derived here (§3).
      applyRaiseRequest(state, raiseTarget, effects);
      break;
    }

    case 'OS_FOCUS_GAINED': {
      applyFocusGained(state, event.id, event.lastHttpUrl);
      // Transient-sibling autoclose (§4.4 dim 4b, §5 step 9): the FOCUSER
      // dismisses the transients it is not. Driven from OS focus only — this
      // is the machine form of the `win.on('focus')` / `onHybridHostFocus`
      // producers, and deliberately NOT of `WINDOW_SHOWN { focused: true }`,
      // which is a registration-time visibility IMPORT (see
      // `WindowRegistrationDecision.pumpShownEvent`) rather than evidence that
      // the OS moved focus. The dismissed records retire on their own
      // `WINDOW_CLOSED` / `WINDOW_HIDDEN`, so this clause is effect-only and
      // cannot break the front invariant.
      pushCloseOrHide(state, selectTransientAutoclose(state, event.id), effects);
      // The SOLE writer of `hasHeldOsFocus`, and necessarily AFTER the sweep
      // above — the sweep's whole question is whether THIS focus is the
      // window's first. From here on the window sweeps like any other.
      patchRecord(state, event.id, { hasHeldOsFocus: true });
      // What the OS already did for us, mirrored into the machine (+ the one
      // half it does not vouch for). Emits NO raise — see `applyRaiseRequest`.
      // AFTER the autoclose so effect order stays [autoclose…, FOCUS_CONTENT].
      applyOsFocusRealized(state, event.id, effects);
      break;
    }

    case 'OS_FOCUS_SETTLED_NULL': {
      // Front UNCHANGED — the target must survive an app switch. `appActive`
      // (via APP_RESIGNED) carries "is Peek front", not `front`.
      break;
    }

    case 'CONTENT_FIRST_RESPONDER_CHANGED': {
      // Purely additive (§5 step 11): mirrors the backend's native
      // focus/blur report onto the record. No-op for an unknown id.
      const rec = state.windows.get(event.id);
      if (!rec) break;
      patchRecord(state, event.id, { contentFocused: event.held });
      break;
    }

    case 'RAISE_WINDOW_REQUESTED': {
      applyRaiseRequest(state, event.id, effects);
      break;
    }

    case 'APP_ACTIVATED': {
      state.appActive = true;
      // The macOS resign→become DANCE cancel (§5 step 9): the user is back, so
      // the armed app-resign sweep is void. This assignment replaces
      // `ipc.ts onAppDidBecomeActive`'s `clearTimeout(pendingAppResignClose)`.
      state.pendingAppResignSweep = false;
      // Consume the cold-start re-raise latch, at most once (§5 step 11). If a
      // boot restore armed it, THIS is the activation it was waiting for; the
      // raise itself is driven at the END of this arm, where the retired
      // closing-assertion step used to run (see below).
      const coldStartFocus = state.pendingColdStartFocus;
      state.pendingColdStartFocus = null;
      // The transient->active promotion is owned by `izui-state.ts setAppFocused`
      // and mirrored in via SESSION_CHANGED — not derived here (§3).
      // Reconcile any in-flight fullscreen transition against reality (§2.5).
      for (const rec of state.windows.values()) {
        if (rec.fsMode.name === 'entering-fullscreen' || rec.fsMode.name === 'leaving-fullscreen') {
          effects.push({ type: 'RECONCILE_FULLSCREEN', id: rec.id });
        }
      }
      // Re-show the HUD windows the APP_RESIGNED sweep hid — exactly those
      // (the `hiddenByAppBlur` flag replaces the `__hudHidden` expando), and
      // without activation. Headless safety lives in the backend's show
      // policy (§5 step 6A-2): `showWindow` zeroes opacity before showing,
      // so the re-show can never paint on the user's real desktop (the old
      // executor-side headless skip is gone — with the windows.ts show seams
      // routed through SHOW_WINDOW it would suppress every headless show).
      for (const rec of [...state.windows.values()]) {
        if (rec.class === 'hud' && rec.hiddenByAppBlur === true) {
          patchRecord(state, rec.id, { hiddenByAppBlur: false });
          effects.push({ type: 'SHOW_WINDOW', id: rec.id, activate: false });
        }
      }
      // Re-reveal every attached overlay over its host (§5 step 9) — the
      // machine form of `hybrid-overlay.ts onAppBecomeActive`'s "restore the
      // floating level, then re-frame onto the current host". No `frame` is
      // available on this event, so this drives ORDER + VISIBILITY only; the
      // host's next `BOUNDS_CHANGED` refreshes the rect, and the overlay's
      // bounds were never moved while it was hidden. No flag is needed to
      // remember which overlays to re-show (unlike the HUD sweep's
      // `hiddenByAppBlur`): the attachment relation IS that memory.
      for (const rec of [...state.windows.values()]) {
        if (rec.overlayFor != null) applyOverlayFollow(state, rec.overlayFor, undefined, effects);
      }
      // Fire the cold-start re-raise LAST, so its RAISE_WINDOW (+ FOCUS_CONTENT
      // for a page-host) + SET_STACKING and its `stackRaise` land after this
      // arm's own effects — the position the retired closing-assertion step
      // occupied, which ran after the whole switch. `applyRaiseRequest` is now
      // the single `RAISE_WINDOW` emitter and performs exactly the OS work
      // `session.ts reassertColdStartFocusOnce()` used to do by hand. A gone or
      // ineligible window is a no-op inside it, which is what the old
      // `isDestroyed()` guard bought.
      applyRaiseRequest(state, coldStartFocus, effects);
      break;
    }

    case 'SESSION_CHANGED': {
      // Mirror the coordinator's session tri-state. Single authority is
      // `izui-state.ts`; the reducer only records what it is told (§3).
      state.session = event.session;
      // Step 6's policy table is keyed on the session, so a session change
      // invalidates any question asked under the previous one.
      state.escAsk = null;
      break;
    }

    case 'COLD_START_FOCUS_ARMED': {
      // Latch only — no effect, no front change. See
      // `AppWindowState.pendingColdStartFocus`; `APP_ACTIVATED` fires it.
      state.pendingColdStartFocus = event.id;
      break;
    }

    case 'APP_RESIGNED': {
      state.appActive = false;
      // Peek is no longer the active app — an outstanding Esc question must not
      // resolve into a switcher-open after the user left.
      state.escAsk = null;
      // ARM the transient sweep; do NOT run it here (§5 step 9). This edge may
      // be the resign half of the macOS activation dance, which an
      // APP_ACTIVATED would immediately disarm — see
      // `AppWindowState.pendingAppResignSweep`.
      state.pendingAppResignSweep = true;
      // Hide visible HUD-class windows while the app is inactive (the old
      // main.ts did-resign-active sweep over `isAlwaysOnTop() && isVisible()
      // && !isFocusable()` — the class field replaces the sniffing predicate,
      // `hiddenByAppBlur` replaces the `__hudHidden` expando). Focusable
      // always-on-top windows (cmd panel → class 'palette') are untouched,
      // same as before: they have their own blur handling and would blink.
      for (const rec of [...state.windows.values()]) {
        if (rec.class === 'hud' && rec.visible) {
          patchRecord(state, rec.id, { hiddenByAppBlur: true });
          effects.push({ type: 'HIDE_WINDOW', id: rec.id });
        }
      }
      // The chrome overlay is chrome for the ACTIVE page: while Peek is not the
      // active app it must not linger on screen or float over the foreground
      // app (peek 88797f2d / R6). Ports `hybrid-overlay.ts onAppResignActive`'s
      // hide; the attachment SURVIVES, so APP_ACTIVATED re-reveals it.
      for (const rec of [...state.windows.values()]) {
        if (rec.overlayFor != null && rec.visible) {
          effects.push({ type: 'HIDE_WINDOW', id: rec.id });
        }
      }
      if (state.switcher.open) {
        // Close without focus theft — the user is switching to another app. In
        // the staged cutover the adapter treats this (restoreFocus:false) as a
        // no-op and lets `main.ts did-resign-active` own the actual teardown.
        const restoreTarget = state.switcher.previousFront;
        const switcherWindowId = state.switcher.windowId;
        effects.push({ type: 'CLOSE_SWITCHER_WINDOW', restoreTarget, restoreFocus: false, switcherWindowId });
        state.switcher = { open: false };
      }
      break;
    }

    case 'APP_RESIGN_SETTLED': {
      // The settle point of a REAL app switch (§4.4 dim 4b, §5 step 9). Inert
      // unless the sweep is still armed — an APP_ACTIVATED in between (the
      // macOS dance) disarmed it, which is the whole cancel semantics of the
      // deleted `pendingAppResignClose` timer, now structural.
      if (!state.pendingAppResignSweep) break;
      state.pendingAppResignSweep = false;
      // Defensive: the app came back without an APP_ACTIVATED reaching the
      // machine. Belief-vs-reality here is `appActive`'s job, and a visible
      // surface must never be dismissed while the app is front.
      if (state.appActive) break;
      // Focus left Peek entirely, so there is no focuser to exclude: every
      // visible transient page-host is dismissed (the original passed the
      // no-match sentinel id -1 with an undefined focuser role).
      pushCloseOrHide(state, selectAppResignTransients(state), effects);
      break;
    }

    case 'FULLSCREEN_REQUESTED': {
      const id = event.id ?? state.front;
      if (id == null) break;
      const rec = state.windows.get(id);
      if (!rec) break;
      // Making a window fullscreen makes it the target — but only if it is an
      // ELIGIBLE front (present, visible, non-satellite). A fullscreen request
      // aimed at a satellite must not install an illegal `front`; its fsMode
      // edge still runs below (harmless) so the transition table stays total.
      if (isEligibleFront(rec)) state.front = id;
      applyFullscreenRequest(state, id, event.desired, event.bounds, effects);
      break;
    }

    case 'OS_FULLSCREEN_ENTERED': {
      applyOsFullscreenEntered(state, event.id, effects);
      // Fullscreen edges are the DETERMINISTIC signal for the overlay's
      // availability (§5 step 9): a host whose bounds already fill the work
      // area can enter/leave native fullscreen with NO bounds change, so
      // `BOUNDS_CHANGED` alone cannot be trusted to fire. Ports the
      // `enter-full-screen`/`leave-full-screen` listeners the old follow wired.
      applyOverlayFollow(state, event.id, undefined, effects);
      break;
    }

    case 'OS_FULLSCREEN_LEFT': {
      applyOsFullscreenLeft(state, event.id, effects);
      // Back to `normal` -> the same follow re-reveals the overlay, with no
      // rect needed: it was hidden at its pre-fullscreen frame, never moved
      // (the fullscreen branch of `applyOverlayFollow` drives no SET_BOUNDS).
      applyOverlayFollow(state, event.id, undefined, effects);
      break;
    }

    case 'FULLSCREEN_SETTLE_TIMEOUT': {
      const rec = state.windows.get(event.id);
      if (rec && (rec.fsMode.name === 'entering-fullscreen' || rec.fsMode.name === 'leaving-fullscreen')) {
        effects.push({ type: 'RECONCILE_FULLSCREEN', id: event.id });
      }
      break;
    }

    // ── Geometry (§4.2 dim 2, §5 step 7A) ────────────────────────────────────

    case 'BOUNDS_CHANGED': {
      const rec = state.windows.get(event.id);
      if (!rec) break; // unregistered window — nothing to mirror onto
      // The sole writer of `bounds` (see WindowRecord.bounds). Mirror only:
      // no effects, no front/assertion change — a resize/move never moves OS
      // focus, and echoing anything back at the OS here would loop (our own
      // SET_BOUNDS lands right back as this event).
      patchRecord(state, event.id, { bounds: event.bounds });
      // OVERLAY FOLLOW (§4.3 dim 3b, §5 step 9): the host moved/resized, so its
      // attached overlay re-frames. This is the "follow ... driven by
      // boundsChanged" the design names, and it replaces the pair of native
      // 'move'/'resize' listeners `retarget()` used to attach to whichever host
      // was active. No attachment -> nothing at all, so the ordinary
      // bounds-mirror path stays effect-free.
      applyOverlayFollow(state, event.id, event.overlayFrame, effects);
      break;
    }

    case 'OVERLAY_ATTACH_REQUESTED': {
      const overlay = state.windows.get(event.id);
      if (!overlay) break; // unknown overlay — nothing to attach
      const host = event.hostId != null ? state.windows.get(event.hostId) : undefined;
      if (!host) {
        // Detach: no host, or a host the machine does not know (the "active
        // window vanished between signal and handling" case).
        detachOverlay(state, event.id, effects);
        break;
      }
      // Attach OR retarget — the same assignment either way (the previous
      // host's follow is dropped with the relation, so there is no `unfollow`
      // step to perform).
      patchRecord(state, event.id, { overlayFor: host.id });
      applyOverlayFollow(state, host.id, event.frame, effects);
      break;
    }

    case 'SET_BOUNDS_REQUESTED': {
      const rec = state.windows.get(event.id);
      if (!rec) break;
      // Fullscreen owns the display (aa34cb50 family — same guard as
      // MAXIMIZE_REQUESTED): a bounds write mid-episode is dropped.
      if (rec.fsMode.name !== 'normal') break;
      // An explicit write supersedes any held DISPLAY_CHANGED projection —
      // see `discardPendingProjection`.
      discardPendingProjection(state, event.id);
      // Plain geometry write: no mirror write (BOUNDS_CHANGED echoes it),
      // no maximize interaction (see the event doc).
      effects.push({ type: 'SET_BOUNDS', id: event.id, bounds: event.bounds });
      break;
    }

    case 'MAXIMIZE_REQUESTED': {
      const rec = state.windows.get(event.id);
      if (!rec) break;
      // Fullscreen owns the display: a maximize mid-fullscreen (any
      // non-normal mode) is a no-op — recording it would stash the
      // fullscreen rect as `preMaxBounds` (the aa34cb50 lookalike trap).
      if (rec.fsMode.name !== 'normal') break;
      // An explicit write supersedes any held DISPLAY_CHANGED projection —
      // see `discardPendingProjection`.
      discardPendingProjection(state, event.id);
      if (rec.maximized) {
        // Re-snap only. The stash is NOT overwritten: the machine's flag is
        // trusted (no isMaximized() distrust), and overwriting the stash
        // with already-maximized bounds turns the next unmaximize into a
        // no-op (the exact trap tile-ipc.ts's X11 heuristic guards against).
        effects.push({ type: 'SET_BOUNDS', id: event.id, bounds: event.workArea });
        break;
      }
      // Stash the pre-maximize rect from the machine's own bounds mirror —
      // never a live getBounds() read. `null` when no bounds were ever
      // reported ("no stash was possible", mirroring FsMode.preBounds).
      patchRecord(state, event.id, { maximized: true, preMaxBounds: rec.bounds ?? null });
      effects.push({ type: 'SET_BOUNDS', id: event.id, bounds: event.workArea });
      break;
    }

    case 'UNMAXIMIZE_REQUESTED': {
      const rec = state.windows.get(event.id);
      if (!rec) break;
      if (!rec.maximized) break; // not maximized — nothing to restore
      const restore = rec.preMaxBounds;
      patchRecord(state, event.id, { maximized: false, preMaxBounds: null });
      // An explicit write supersedes any held DISPLAY_CHANGED projection —
      // see `discardPendingProjection`.
      discardPendingProjection(state, event.id);
      // A null stash (maximized with no restorable rect) just clears the
      // flag — there is nowhere to restore to, same as FsMode's null stash.
      if (restore) effects.push({ type: 'SET_BOUNDS', id: event.id, bounds: restore });
      break;
    }

    case 'MAXIMIZE_RESTORED': {
      const rec = state.windows.get(event.id);
      if (!rec) break;
      // Same fullscreen guard as MAXIMIZE_REQUESTED (aa34cb50 family).
      if (rec.fsMode.name !== 'normal') break;
      // Seed only — the window was CONSTRUCTED at the maximized rect, so no
      // SET_BOUNDS is driven (see the event doc).
      patchRecord(state, event.id, { maximized: true, preMaxBounds: event.preMaxBounds });
      break;
    }

    case 'MAXIMIZE_EXITED_BY_RESIZE': {
      const rec = state.windows.get(event.id);
      if (!rec || !rec.maximized) break; // not maximized — nothing to exit
      // Clear both, drive nothing: the gesture owns the bounds (event doc).
      patchRecord(state, event.id, { maximized: false, preMaxBounds: null });
      break;
    }

    // ── Displays and Spaces (§4.2 dims 7 / 7b, §5 step 10) ───────────────────

    case 'DISPLAY_CHANGED': {
      for (const projection of event.projected) {
        const rec = state.windows.get(projection.id);
        if (!rec) continue; // unregistered window — nothing to move
        // The legacy watcher's `isVisible()` filter, answered from the
        // machine's own mirror instead of an OS query (§3: never a question
        // at decision time). Fullscreen owns the display (aa34cb50 family —
        // same guard as SET_BOUNDS_REQUESTED / MAXIMIZE_REQUESTED): a
        // reprojection mid-episode would fight the fullscreen geometry and
        // corrupt it. Either condition DEFERS rather than drops: the rect is
        // held on `pendingProjectedBounds` (last projection wins over any
        // earlier held one) and flushed by `flushPendingProjection` from
        // whichever transition lifts the block last — the `→ normal` fsMode
        // transitions, or `WINDOW_SHOWN` — so a display/resolution change that
        // lands mid-fullscreen or while hidden still lands once the window is
        // both normal and visible again.
        if (!rec.visible || rec.fsMode.name !== 'normal') {
          patchRecord(state, projection.id, { pendingProjectedBounds: projection.bounds });
          continue;
        }
        // No mirror write (BOUNDS_CHANGED echoes it), no maximize interaction
        // — see the event doc.
        effects.push({ type: 'SET_BOUNDS', id: projection.id, bounds: projection.bounds });
      }
      break;
    }

    case 'SET_VISIBLE_ON_ALL_SPACES_REQUESTED': {
      const rec = state.windows.get(event.id);
      if (!rec) break; // unknown window — no record to hold the intent
      patchRecord(state, event.id, { visibleOnAllSpaces: event.on });
      // Emitted UNCONDITIONALLY, including when the value is unchanged: macOS
      // drops the all-Spaces flag across some transitions, so a re-assert is
      // a real write (see the event doc). Only the flags the caller actually
      // supplied are put on the effect — absent means "don't pass the
      // option", which is not the same as `false`.
      const eff: SetVisibleOnAllSpacesEffect = { type: 'SET_VISIBLE_ON_ALL_SPACES', id: event.id, on: event.on };
      if (event.visibleOnFullScreen !== undefined) eff.visibleOnFullScreen = event.visibleOnFullScreen;
      if (event.skipTransformProcessType !== undefined) eff.skipTransformProcessType = event.skipTransformProcessType;
      effects.push(eff);
      break;
    }

    case 'SPACES_POLICY_REQUESTED': {
      const rec = state.windows.get(event.id);
      if (!rec) break; // unknown window — nothing to apply the policy to
      if (event.policy === 'none') break; // no Spaces on this platform
      if (event.policy === 'follow') {
        patchRecord(state, event.id, { visibleOnAllSpaces: true });
        effects.push({
          type: 'SET_VISIBLE_ON_ALL_SPACES',
          id: event.id,
          on: true,
          visibleOnFullScreen: true,
          skipTransformProcessType: true,
        });
        break;
      }
      // 'anchor' — the ORDERED PAIR (see the event doc). true-then-false is
      // what lands the window on the ACTIVE Space and pins it there; the two
      // calls carry DIFFERENT options, so they cannot collapse into one
      // effect. Net record value is `false` — "anchored to a Space".
      patchRecord(state, event.id, { visibleOnAllSpaces: false });
      effects.push({
        type: 'SET_VISIBLE_ON_ALL_SPACES',
        id: event.id,
        on: true,
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
      effects.push({
        type: 'SET_VISIBLE_ON_ALL_SPACES',
        id: event.id,
        on: false,
        skipTransformProcessType: true,
      });
      break;
    }

    case 'SPACE_CHANGED': {
      // Deliberately does nothing: no state written, no effects emitted.
      //
      // There is no state to write — the event carries no Space identity (see
      // its doc). And there is nothing to re-assert either. The all-Spaces
      // flag (`canJoinAllSpaces`) is sticky collection behavior on the native
      // window; surviving a Space switch is the whole point of setting it, so
      // a switch is not a moment where the OS forgets it. The claim this
      // clause was first written from — "macOS silently drops the flag across
      // some window/Space transitions" — has no source anywhere in this repo.
      // It was borrowed from `SET_VISIBLE_ON_ALL_SPACES_REQUESTED`, which is
      // really about not suppressing a write the caller explicitly asked for;
      // that event's one live re-assert (`ipc.ts`, reusing a hidden keepLive
      // window) happens at SHOW time for a different stated reason — so the
      // hidden window follows the user to the active Space instead of dragging
      // them back to its home Space. Neither is evidence about Space switches.
      //
      // Re-asserting anyway would cost one native `setVisibleOnAllWorkspaces`
      // per follow window on every switch, fired in the middle of the Space
      // transition animation, and the workspace notification arrives even when
      // Peek is in the background. That is the exact call this repo has flash
      // regressions on, so the price is real while the fix is speculative.
      //
      // The reason anchored windows would be skipped is still worth recording,
      // even though nothing is emitted either way: replaying an anchor's
      // creation-time true-then-false pair on a Space switch would land the
      // window on whichever Space the user just moved to, teleporting it away
      // from the Space it was anchored to. (A bare `on: false` effect would
      // NOT do that — only `SPACES_POLICY_REQUESTED` with the `anchor` policy
      // emits the pair.) `ipc.ts` states the same rule independently for
      // keepLive reuse. Note the records cannot actually tell an anchored
      // window from one whose Spaces policy was never set — both hold
      // `visibleOnAllSpaces: false` — so the honest phrasing is "do nothing
      // for anything not pinned to all Spaces".
      //
      // So the event lands wired but inert, the way `visibleOnAllSpaces` and
      // its raw event first landed (`af540e74`). If a genuine dropped flag is
      // ever observed on a real display, this clause is where the re-assert
      // belongs.
      break;
    }

    case 'ESC_PRESSED': {
      // A newer Esc supersedes any older pending question outright.
      state.escAsk = null;
      applyEscape(state, effects);
      break;
    }

    case 'ESC_RENDERER_ANSWER': {
      // Epoch check FIRST: an answer that does not match the outstanding ask
      // (superseded, or invalidated by a session/switcher/close/app-blur change
      // during the wait) is judged under a policy that no longer applies, so it
      // is dropped. This is the structural fix for "Esc reopens the switcher
      // 500ms after closing it".
      if (state.escAsk == null || event.seq !== state.escAsk.seq) {
        effects.push({ type: 'NOTHING' });
        break;
      }
      state.escAsk = null;
      if (event.handled) {
        effects.push({ type: 'NOTHING' });
        break;
      }
      const decision = decideEscapeUnhandled(state, event.id);
      applyUnhandledEscape(state, decision, effects);
      break;
    }

    case 'SWITCHER_OPEN_REQUESTED': {
      const windowId = event.windowId ?? null;
      state.switcher = { open: true, windowId, previousFront: state.front };
      effects.push({ type: 'OPEN_SWITCHER_WINDOW', previousFront: prevFront });
      break;
    }

    case 'SWITCHER_SELECTED': {
      const previousFront = state.switcher.open ? state.switcher.previousFront : null;
      const target = event.id ?? previousFront;
      state.switcher = { open: false };
      if (target != null && isEligibleFront(state.windows.get(target))) {
        state.front = target;
        bumpFocusSeq(state, target);
        // Explicit user-requested raise (§5 step 5) — the switcher selection
        // is the user naming a target. The overlay held key right up to the
        // selection, so the target has to be driven onto the OS even when it
        // resolves back to the window that was already `front`.
        applyRaiseRequest(state, target, effects);
      }
      break;
    }

    case 'SWITCHER_OPENED': {
      // Mirror the externally-opened overlay window into switcher state (no
      // effect — the window already exists). If the machine had already opened
      // the switcher (decideEscape → OPEN_SWITCHER_WINDOW), this fixes up the
      // sentinel windowId to the real overlay id.
      state.switcher = { open: true, windowId: event.windowId, previousFront: state.front };
      // With the switcher open, `decideEscape` step 1 owns Esc — an answer asked
      // before it opened would resolve under the wrong branch.
      state.escAsk = null;
      break;
    }
  }

  enforceFrontInvariant(state, event);
  return { state, effects };
}

/**
 * OS_FOCUS_GAINED front arbitration (§2.4). Shared by OS_FOCUS_GAINED and the
 * focused variant of WINDOW_SHOWN.
 *   - satellite            -> no front change (bump focusSeq only)
 *   - transition in flight -> ignored for front (the "transition pin")
 *   - else                 -> front = id, bump focusSeq
 */
function applyFocusGained(state: AppWindowState, id: WindowId, lastHttpUrl?: string): void {
  const rec = state.windows.get(id);
  if (!rec) return;
  bumpFocusSeq(state, id);
  // Track the most-recent http(s) address per record (absorbs the old
  // `lastContentWindowId` devtools-target tracker). Only set when the focused
  // window is on an http(s) page, mirroring `trackContentWindowFocus`.
  if (lastHttpUrl && (lastHttpUrl.startsWith('http://') || lastHttpUrl.startsWith('https://'))) {
    patchRecord(state, id, { lastHttpUrl });
  }
  // A satellite (chrome overlay / palette / dialog / switcher) or a not-yet-
  // visible window can never be `front`. Gating here — not only on `satellite`
  // — keeps `front` eligible by construction so the invariant guard never trips.
  if (!isEligibleFront(state.windows.get(id))) return;
  if (anyFullscreenTransitionInFlight(state)) return; // Space-switch churn mid-animation is ignored
  state.front = id;
}

/** Apply the escape decision (steps 1-5) into state + effects. */
function applyEscape(state: AppWindowState, effects: Effect[]): void {
  const decision = decideEscape(state);
  switch (decision.kind) {
    case 'close-switcher': {
      const restoreTarget = state.switcher.open ? state.switcher.previousFront : null;
      const switcherWindowId = state.switcher.open ? state.switcher.windowId : null;
      state.switcher = { open: false };
      // restoreFocus:true → ESC path: the adapter delegates the overlay-window
      // teardown to izui (`closeOrHideWindow`), the single close path now that
      // the old `escPolicy('overlay')` route is deleted.
      effects.push({ type: 'CLOSE_SWITCHER_WINDOW', restoreTarget, restoreFocus: true, switcherWindowId });
      if (restoreTarget != null && isEligibleFront(state.windows.get(restoreTarget))) {
        state.front = restoreTarget;
      }
      // Explicit user-requested raise (§5 step 5): Escape closing the switcher
      // is the user naming the restore target, unconditionally — unlike the
      // pre-step-5 behavior, this no longer depends on whether the switcher
      // was opened via `SWITCHER_OPENED` (which invalidated the assertion) or
      // only `SWITCHER_OPEN_REQUESTED` (which did not). `applyRaiseRequest`
      // itself is a no-op for a null/ineligible target.
      applyRaiseRequest(state, restoreTarget, effects);
      return;
    }
    case 'open-switcher': {
      openSwitcher(state, effects);
      return;
    }
    case 'pass-through': {
      effects.push({ type: 'PASS_THROUGH', id: decision.id });
      return;
    }
    case 'exit-fullscreen': {
      effects.push({ type: 'EXIT_FULLSCREEN', id: decision.id });
      // Drive the leaving edge in the same step (SET_FULLSCREEN(id,false) etc.).
      applyFullscreenRequest(state, decision.id, false, undefined, effects);
      return;
    }
    case 'ask-renderer': {
      // Stamp the question with a fresh epoch so the (deferred) answer can be
      // matched back to THIS ask — see `AppWindowState.escAsk`.
      state.escSeq += 1;
      state.escAsk = { id: decision.id, seq: state.escSeq };
      effects.push({ type: 'ASK_RENDERER', id: decision.id, seq: state.escSeq });
      return;
    }
  }
}

function applyUnhandledEscape(state: AppWindowState, decision: EscapeUnhandledDecision, effects: Effect[]): void {
  switch (decision.kind) {
    case 'close-window':
      effects.push({ type: 'CLOSE_WINDOW', id: decision.id });
      return;
    case 'open-switcher':
      openSwitcher(state, effects);
      return;
    case 'nothing':
      effects.push({ type: 'NOTHING' });
      return;
  }
}

function openSwitcher(state: AppWindowState, effects: Effect[]): void {
  const previousFront = state.front;
  state.switcher = { open: true, windowId: null, previousFront };
  effects.push({ type: 'OPEN_SWITCHER_WINDOW', previousFront });
}

// ─────────────────────────────────────────────────────────────────────────────
// Selectors (§2.4 derived reads)
// ─────────────────────────────────────────────────────────────────────────────

/** Command target / close target / Esc target / session-save focused descriptor. */
export function getFrontWindowId(state: AppWindowState): WindowId | null {
  return state.front;
}

export function getWindowMode(state: AppWindowState, id: WindowId): FsMode['name'] | null {
  const rec = state.windows.get(id);
  return rec ? rec.fsMode.name : null;
}

/**
 * The pre-fullscreen bounds stashed for a window (absorbs the registry's
 * `preFullScreenBounds` — `window-presenter.ts` reads this to persist the real
 * window geometry instead of the transient work-area-sized fullscreen rect).
 * `null` for a `normal` window OR for an OS/green-button entry where no stash
 * was possible — both mean "no restorable geometry", exactly as before.
 */
export function getWindowPreBounds(state: AppWindowState, id: WindowId): Rectangle | null {
  const rec = state.windows.get(id);
  if (!rec || rec.fsMode.name === 'normal') return null;
  return rec.fsMode.preBounds;
}

/**
 * The intended z-order of the level-`stacked` windows, BOTTOM → TOP (a copy).
 * Session-save's z-order rank and the §5 step 5 part B consumers read this
 * instead of live-polling native order.
 */
export function getStackOrder(state: AppWindowState): WindowId[] {
  return [...state.stackOrder];
}

/**
 * A window's MRU focus rank (absorbs `focus-order.ts` `getFocusOrder`): higher =
 * more recently focused, 0 if never focused / unregistered. Session-save reads
 * this to rank windows for eager/deferred restore.
 */
export function getWindowFocusSeq(state: AppWindowState, id: WindowId): number {
  return state.windows.get(id)?.focusSeq ?? 0;
}

/**
 * Devtools target selector (absorbs `lastContentWindowId`): the most-recently
 * focused window bearing an http(s) `lastHttpUrl`, or null. Replaces
 * `getLastContentWindowId()` in the `tile:window:devtools` fallback.
 */
export function getDevtoolsTargetId(state: AppWindowState): WindowId | null {
  let best: WindowRecord | null = null;
  for (const rec of state.windows.values()) {
    if (!rec.lastHttpUrl) continue;
    if (!best || rec.focusSeq > best.focusSeq) best = rec;
  }
  return best ? best.id : null;
}

/**
 * The host an overlay is currently attached to, or null (§4.3 dim 3b). The
 * reducer-state answer to `hybrid-overlay.ts`'s `followedBaseWin` — a read, not
 * a live `getBounds()`/`isVisible()` question.
 */
export function getOverlayHost(state: AppWindowState, overlayId: WindowId): WindowId | null {
  return state.windows.get(overlayId)?.overlayFor ?? null;
}

/** A structural, read-only view for tests + the Playwright bridge. */
export interface StateSnapshot {
  appActive: boolean;
  session: IzuiSession;
  front: WindowId | null;
  /** See `AppWindowState.stackOrder` — the intended z-order, bottom → top. */
  stackOrder: WindowId[];
  switcher: SwitcherState;
  windows: WindowRecord[];
}

export function snapshot(state: AppWindowState): StateSnapshot {
  return {
    appActive: state.appActive,
    session: state.session,
    front: state.front,
    stackOrder: [...state.stackOrder],
    switcher: state.switcher,
    windows: [...state.windows.values()].map((r) => ({ ...r })),
  };
}

/**
 * Derived Escape-grab predicate (design §2 "The Escape grab becomes honest"):
 * whether the OS-level `globalShortcut('Escape')` safety net should be held.
 *
 *   appActive && (front === null || front's WindowRecord.contentFocused === false)
 *
 * i.e. the net is on exactly when the machine CANNOT VOUCH that some window is
 * positioned to receive Escape through `before-input-event`.
 *
 * §5 step 11 re-key: the front-not-first-responder half reads
 * `WindowRecord.contentFocused` (the backend's mirror of the native
 * `rendererWC 'focus'`/`'blur'` pair, via `CONTENT_FIRST_RESPONDER_CHANGED`)
 * rather than a machine-side CLAIM that the OS matched an emitted
 * `RAISE_WINDOW`/`FOCUS_CONTENT`. (It used to read such a claim; that field
 * and its machinery were retired the step after.) Same intent as the old
 * half: arm the net whenever the front page-host's content is NOT actually the
 * macOS first responder — some palette/satellite holds key instead, so Escape
 * must be caught globally rather than by the content itself. Verified live
 * (2026-07): `contentFocused` stays correct across an app resign/activate
 * cycle where `front` itself briefly oscillates — it is the stable signal the
 * retired machine-side claim was only approximating.
 *
 * ABSENT (`contentFocused === undefined`) reads as "nothing reported yet", NOT
 * "content is unfocused" — the same convention as `hiddenByAppBlur`. Two cases
 * hit this: (a) a `browser`-kind front, whose kind never gets a
 * `CONTENT_FIRST_RESPONDER_CHANGED` at all (`attachNativeListeners` wires the
 * `rendererWC 'focus'/'blur'` pair only for `kind: 'page-host'` — a browser
 * window's root webContents IS first responder whenever the window is key, so
 * there is nothing independent to track); (b) a page-host between a just-driven
 * `FOCUS_CONTENT` and the async native `'focus'` event it produces. Treating
 * absent as "armed" would permanently arm the net for every browser-kind front
 * (Escape already works there via `before-input-event` — a regression of its
 * own) and would flap the net on for the ordinary micro-gap after every fresh
 * show/raise. So absent does NOT arm: only an EXPLICIT `contentFocused ===
 * false` — an actually-observed loss of first responder — arms the net. This
 * preserves 7fffa286/7c61e917 (the regression pair the retired claim was built
 * for): live evidence shows a real resign fires the content blur BEFORE
 * `APP_RESIGNED` itself, so `contentFocused` is already `false` by the time the
 * app goes inactive, and it STAYS `false` through `APP_ACTIVATED` until a fresh
 * `CONTENT_FIRST_RESPONDER_CHANGED{held:true}` lands — arming the net for
 * exactly the window where `before-input-event` would otherwise be deaf.
 *
 * Reads reducer state ONLY. Widening it back into live Electron/OS reads is
 * explicitly REJECTED (design §2 / §7): that reintroduces the rival-authority
 * pattern this machine exists to delete, and papers over a wrong `front` instead
 * of surfacing it.
 *
 * `!switcher.open` is carried over from the old predicate and is NOT redundant
 * — if anything it is now load-bearing rather than merely reinforcing: the
 * switcher overlay taking key blurs the front's content WC too (a real,
 * reported loss of first responder), so without this clause the net would
 * switch ON for the one surface that handles Escape in its own renderer. An OS
 * grab pre-empts `before-input-event`, so it would eat the switcher's own
 * Escape, and a second `ESC_PRESSED` per keypress is the switcher-reopen loop
 * (7fffa286).
 *
 * Lives here rather than next to its executor in `window-os-adapter.ts` for the
 * same reason `decideWindowRegistration` does — that module transitively
 * value-imports `electron` (via `electron-window-backend.ts`, its default
 * backend), which makes it unloadable from a test under the unit gate's
 * `ELECTRON_RUN_AS_NODE=1`. This file has zero imports, so the predicate is
 * testable here and nowhere else.
 */
export function deriveEscGrabRegistered(snap: StateSnapshot): boolean {
  if (!snap.appActive) return false;
  if (snap.switcher.open) return false;
  if (snap.front === null) return true;
  // `rec` is guaranteed non-null here: `enforceFrontInvariant` runs as the LAST
  // step of every `reduce`, so a non-null `snap.front` always names a live
  // record by the time any snapshot is taken (throws in dev/test on a reducer
  // bug, self-corrects in production) — a dangling front is not a
  // representable `StateSnapshot`. `.find` (not a direct index) only because
  // `StateSnapshot.windows` is an array, not a `Map`.
  const rec = snap.windows.find((w) => w.id === snap.front);
  // `=== false`, not `!rec?.contentFocused` — see the docblock's ABSENT note.
  return rec?.contentFocused === false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Owner surface — holds the single mutable state instance and drives the pure
// reducer. `reduce` itself stays pure and separately exported; this layer is the
// only place a mutable `AppWindowState` lives. NO consumers are wired in this
// slice; this is the seam later slices will attach to.
// ─────────────────────────────────────────────────────────────────────────────

export type Listener = (snap: StateSnapshot, effects: Effect[]) => void;

export class WindowStateOwner {
  private state: AppWindowState = createInitialState();
  private listeners = new Set<Listener>();

  /** The only mutator. Runs the pure reducer, commits, fires subscribers. */
  dispatch(event: WindowEvent): Effect[] {
    const { state, effects } = reduce(this.state, event);
    this.state = state;
    const snap = snapshot(state);
    for (const l of this.listeners) l(snap, effects);
    return effects;
  }

  /** Fired on every dispatch (replaces `onActiveHybridWindowChange`). */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getFrontWindowId(): WindowId | null {
    return getFrontWindowId(this.state);
  }

  getWindowMode(id: WindowId): FsMode['name'] | null {
    return getWindowMode(this.state, id);
  }

  getWindowPreBounds(id: WindowId): Rectangle | null {
    return getWindowPreBounds(this.state, id);
  }

  getDevtoolsTargetId(): WindowId | null {
    return getDevtoolsTargetId(this.state);
  }

  /** The host this overlay frames, or null (§4.3 dim 3b). */
  getOverlayHost(overlayId: WindowId): WindowId | null {
    return getOverlayHost(this.state, overlayId);
  }

  /** The overlay attached to this host, or null (§4.3 dim 3b). */
  getOverlayForHost(hostId: WindowId): WindowId | null {
    return overlayIdForHost(this.state, hostId);
  }

  getWindowFocusSeq(id: WindowId): number {
    return getWindowFocusSeq(this.state, id);
  }

  snapshot(): StateSnapshot {
    return snapshot(this.state);
  }

  /**
   * The live record for one window — READ-ONLY by contract (no copy, so the
   * numeric-id registry seam in main.ts stays allocation-free on hot paths;
   * note `params` is deliberately a shared mutable bag, see WindowRecord).
   */
  getWindowRecord(id: WindowId): WindowRecord | undefined {
    return this.state.windows.get(id);
  }

  /** All live records (fresh array, records themselves NOT copied — read-only by contract). */
  listWindowRecords(): WindowRecord[] {
    return [...this.state.windows.values()];
  }

  /**
   * Resolve when window `id` reaches fullscreen `mode`. The settle-await callers
   * want (§2.4) — on the machine, not a promise inside the mutator. Resolves
   * immediately if already there.
   */
  waitForMode(id: WindowId, mode: FsMode['name']): Promise<void> {
    if (getWindowMode(this.state, id) === mode) return Promise.resolve();
    return new Promise((resolve) => {
      const unsub = this.subscribe(() => {
        if (getWindowMode(this.state, id) === mode) {
          unsub();
          resolve();
        }
      });
    });
  }

  /** Test-only reset. */
  _resetForTest(): void {
    this.state = createInitialState();
    this.listeners.clear();
  }
}
