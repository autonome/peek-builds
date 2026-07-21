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
 *                background / bridge / test-fixture / devtools plus any other
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
   * registry payload (tile windows, bridge/background/test-fixture/devtools),
   * which is exactly how the numeric-id seam (`main.ts getWindowInfo` /
   * `getAllWindows`) preserves the old registry's membership.
   */
  source?: string;
  params?: Record<string, unknown>;
  /**
   * Set while a `hud`-class window is hidden by the APP_RESIGNED sweep, so
   * APP_ACTIVATED re-shows exactly the windows that sweep hid — the
   * structural replacement for the deleted `(win as any).__hudHidden` expando.
   */
  hiddenByAppBlur?: boolean;
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
  /** MRU counter (absorbs `focus-order.ts`). Higher = more recently focused. */
  focusSeq: number;
  /** Absorbs `lastContentWindowId` (devtools target). */
  lastHttpUrl?: string;
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
   * The claim that the OS currently matches `front`.
   *
   * READ THIS BEFORE TOUCHING EITHER FIELD. `front` and `frontAsserted` are two
   * DIFFERENT things, and conflating them is the exact bug this field exists to
   * prevent:
   *   - `front` is INTENT — "the window the user is working in". It is a belief
   *     the machine holds; nothing about it says the OS agrees.
   *   - `frontAsserted` is whether we have actually DRIVEN the OS to match that
   *     intent: the window raised, and — for a `page-host` — its content view
   *     made the macOS first responder.
   *
   * "The target didn't change" (`front === prevFront`) does NOT imply "the OS
   * still matches the target". The deleted `frontChangeEffects` made exactly that
   * inference — it returned no effects whenever `front` was unchanged — so a
   * window that lost first responder while REMAINING `front` (app switch away and
   * back, a palette taking key, the switcher overlay opening) was never restored,
   * and its `before-input-event` stayed deaf forever (7c61e917 / 7fffa286).
   *
   * So: every event that can plausibly have moved OS focus off `front` clears
   * this flag (see `invalidatesFrontAssertion`), and the closing assertion step in
   * `reduce` re-drives the OS (`RAISE_WINDOW` [+ `FOCUS_CONTENT`]) whenever it is
   * false. It is set to `true` ONLY by that step — never by anything that merely
   * assigns `front`.
   */
  frontAsserted: boolean;
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
   *   - the closing assertion (`applyFrontAssertion`) raises `front` to the
   *     top whenever it drives the OS — so "after a machine-driven assertion,
   *     `front` is the top of this list" is what `frontAsserted` claims;
   *   - WINDOW_CONTENT_ORDERABLE re-drives `SET_STACKING` to converge native
   *     order onto this list as page-hosts become orderable.
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
}

export function createInitialState(): AppWindowState {
  return {
    appActive: true, // at launch Peek IS the active app (mirrors the coordinator)
    session: 'idle',
    front: null,
    // Nothing has been driven onto the OS yet. With `front: null` the closing
    // assertion step has nothing to assert; the derived Esc grab covers that gap.
    frontAsserted: false,
    stackOrder: [],
    switcher: { open: false },
    windows: new Map(),
    focusSeqCounter: 0,
    escAsk: null,
    escSeq: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Event alphabet (§2.3) — normalized by the OS adapter; no payload shape here is
// Electron-typed.
// ─────────────────────────────────────────────────────────────────────────────

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
    }
  /**
   * Merge a windowRegistry payload onto an ALREADY-REGISTERED window — the
   * machine-side form of the old `main.ts registerWindow(id, source, params)`
   * writer (its callers run after `registerWindowWithMachine`). No-op for an
   * unknown id.
   */
  | { type: 'WINDOW_PARAMS_SET'; id: WindowId; source: string; params: Record<string, unknown> }
  /** App code wants this window CLOSED (guest-safe direct close — no keepLive policy; that is CLOSE_WINDOW/closeOrHide). */
  | { type: 'WINDOW_CLOSE_REQUESTED'; id: WindowId }
  /** App code wants this window forcefully DESTROYED (extension bridge/UI teardown, quit paths). */
  | { type: 'WINDOW_DESTROY_REQUESTED'; id: WindowId }
  /** App code wants this window shown (activate:false = show without stealing focus). */
  | { type: 'WINDOW_SHOW_REQUESTED'; id: WindowId; activate: boolean }
  /** App code wants this window's CONTENT surface torn down (the hybrid finalize's `contentWC.close()`). */
  | { type: 'WINDOW_CONTENT_CLOSE_REQUESTED'; id: WindowId }
  /** Quit teardown: destroy every registered page-host guest WC before native quit closes their hosts (peek d1cf0b9a). */
  | { type: 'GUEST_TEARDOWN_REQUESTED' }
  /**
   * Devtools opened/closed for a registered window (§4.6 dim 8a). Both
   * invalidate the front assertion; the closing assertion step then re-drives
   * the front window — the machine form of the old "re-focus the content
   * window after devtools opens/closes" handlers.
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
   * event-driven, no timer, no poll (the machine form of `session.ts
   * reassertStackingOrder` keyed on the private `hybrid:first-frame` IPC).
   * PRODUCERS ARE NOT WIRED YET (§5 step 5 part B): the event exists unfired;
   * the legacy first-frame listener still owns the live re-assert.
   */
  | { type: 'WINDOW_CONTENT_ORDERABLE'; id: WindowId }
  | { type: 'WINDOW_HIDDEN'; id: WindowId }
  | { type: 'WINDOW_CLOSED'; id: WindowId }
  | { type: 'OS_FOCUS_GAINED'; id: WindowId; lastHttpUrl?: string }
  | { type: 'OS_FOCUS_SETTLED_NULL' }
  | { type: 'APP_ACTIVATED' }
  | { type: 'APP_RESIGNED' }
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
  | { type: 'SWITCHER_OPENED'; windowId: WindowId };

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
   * `FOCUS_CONTENT`). The SOLE ordering effect: emitted by the closing
   * assertion step alongside the existing raise (so the machine's own
   * front-driving also drives order — what makes `frontAsserted` mean "on
   * top", §6), and re-driven by `WINDOW_CONTENT_ORDERABLE` as page-hosts
   * become orderable. To realize a full order the reducer emits one per
   * window, bottom → top (each raise stacks on the previous).
   */
  | { type: 'SET_STACKING'; id: WindowId }
  /**
   * Make a page-host's content WebContentsView the macOS first responder (the
   * `shouldFocusHybridContentOnHostFocus` invariant). Emitted by the closing
   * assertion step alongside `RAISE_WINDOW` whenever the front window is a
   * page-host and the assertion is not currently held — NOT only when `front`
   * changes (see `AppWindowState.frontAsserted`).
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
  /** Hide, keep alive (the HUD app-blur sweep). */
  | { type: 'HIDE_WINDOW'; id: WindowId }
  /** Pin above regular windows (registration-declared alwaysOnTop). Executor skips under headless (compositor-flash parity with the old guard). */
  | { type: 'SET_ALWAYS_ON_TOP'; id: WindowId; on: boolean }
  /** Quit teardown: destroy every registered page-host guest WC (peek d1cf0b9a). */
  | { type: 'DESTROY_ALL_GUESTS' }
  /** ESC consumed by leaving fullscreen (also drives the leaving fsMode edge + SET_FULLSCREEN in the same reduce). */
  | { type: 'EXIT_FULLSCREEN'; id: WindowId }
  /** ESC passed straight to the page (escapeMode 'ignore'). */
  | { type: 'PASS_THROUGH'; id: WindowId }
  | { type: 'NOTHING' };

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
 * elsewhere): the infrastructure classes — hud, background, bridge,
 * test-fixture, devtools — are structurally front-ineligible regardless of
 * role/focusable. `extension-ui` is deliberately NOT here: an extension popup
 * is a real user-facing window the user works in, so it stays front-eligible.
 */
const SATELLITE_CLASSES: ReadonlySet<WindowClass> = new Set<WindowClass>([
  'hud',
  'background',
  'bridge',
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
 * classes (background / bridge / extension-ui / test-fixture / devtools) are
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
 *   - any other satellite              -> 'excluded' (background/bridge/test-fixture/
 *                                                     devtools, modals, focusable:false
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
    frontAsserted: state.frontAsserted,
    stackOrder: [...state.stackOrder],
    switcher: state.switcher,
    windows: new Map(state.windows),
    focusSeqCounter: state.focusSeqCounter,
    escAsk: state.escAsk,
    escSeq: state.escSeq,
  };
}

/** Copy a record and apply a patch; write it back into a (freshly cloned) map. */
function patchRecord(state: AppWindowState, id: WindowId, patch: Partial<WindowRecord>): void {
  const cur = state.windows.get(id);
  if (!cur) return;
  state.windows.set(id, { ...cur, ...patch });
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
 * Did THIS transition invalidate the claim that the OS matches `front`?
 *
 * The ONE place `frontAsserted` is ever cleared (via `applyFrontAssertion`), so
 * the whole invalidation rule reads as a single list rather than as assignments
 * scattered through the case arms. Each clause is a moment where the OS can
 * plausibly have taken the window raise / first responder away from `front`.
 *
 * NOT a list of "events that change front" — a change of `front` is only the
 * FIRST clause. The others all leave `front` exactly where it was, and they are
 * the whole reason this predicate exists (see `AppWindowState.frontAsserted`).
 */
function invalidatesFrontAssertion(prev: AppWindowState, next: AppWindowState, event: WindowEvent): boolean {
  // Trivially: the old assertion was about a different window.
  if (next.front !== prev.front) return true;
  switch (event.type) {
    // The user left Peek; on return, first responder is not guaranteed.
    case 'APP_RESIGNED':
      return true;
    // The switcher overlay took key from the front window.
    case 'SWITCHER_OPENED':
      return true;
    // The switcher overlay held key right up to the selection, so whatever the
    // selection resolves to has to be re-driven onto the OS — including when it
    // resolves back to the window that was already `front`.
    case 'SWITCHER_SELECTED':
      return true;
    // The asserted window is gone from screen. Judged against the front BEFORE
    // it moved to a successor, which is the case this clause is here for.
    case 'WINDOW_HIDDEN':
      return event.id === prev.front;
    // A child window with a registered parent closed: the parent must be
    // re-driven (raise + first responder) even when it already was `front` —
    // the machine form of the deleted `parentWin.focus()` (the front-changed
    // first clause covers the case where front actually moved).
    case 'WINDOW_CLOSED':
      return prev.windows.get(event.id)?.parentId != null;
    // Devtools took or released key for a registered window (§4.6 dim 8a).
    // Both edges re-drive the front in the SAME transition (no deferral):
    // devtools opens with activate:false, and the old handlers immediately
    // re-focused the content window — re-asserting here preserves that AND
    // keeps the derived Esc grab off (a grabbed Esc would be eaten before the
    // devtools/front window ever saw it).
    case 'DEVTOOLS_OPENED':
    case 'DEVTOOLS_CLOSED':
      return true;
    // A palette / modal / chrome overlay took key. It is a satellite, so `front`
    // deliberately did NOT move — which is exactly why the assertion has to.
    // EXCEPT a detached devtools window (class 'devtools'): clicking into
    // devtools must NOT flip the assertion off, or the derived Esc grab would
    // switch ON and eat every Esc typed inside devtools (before registration,
    // devtools focus was invisible to the machine — this keeps that behavior).
    case 'OS_FOCUS_GAINED': {
      const rec = next.windows.get(event.id);
      return rec?.satellite === true && rec.class !== 'devtools';
    }
    default:
      return false;
  }
}

/**
 * The closing assertion step (design §2): run after `enforceFrontInvariant` on
 * EVERY transition. Clear the assertion if this transition invalidated it, then
 * — if the machine cannot vouch that the OS matches `front` — describe the work
 * that makes it true and record the claim.
 *
 * `RAISE_WINDOW` alone is enough for a `browser` window (its root webContents IS
 * first responder whenever the window is key); a `page-host` is a BaseWindow
 * whose keyboard focus is a second, independently-losable piece of state, so it
 * additionally needs `FOCUS_CONTENT`.
 *
 * Two surfaces legitimately hold key at the moment they take it, and re-raising
 * `front` in the same breath would yank focus straight back out of them — so the
 * assertion is deferred to the NEXT transition in both cases:
 *   - the switcher overlay, for as long as it is open;
 *   - a satellite that just gained OS focus (design §2: "a satellite stealing key
 *     is self-healing — when it goes away, the next transition re-asserts").
 */
function applyFrontAssertion(
  prev: AppWindowState,
  state: AppWindowState,
  event: WindowEvent,
  effects: Effect[],
): void {
  if (invalidatesFrontAssertion(prev, state, event)) state.frontAsserted = false;

  if (state.switcher.open) return;
  if (event.type === 'OS_FOCUS_GAINED' && state.windows.get(event.id)?.satellite === true) return;

  if (!state.appActive) return;
  if (state.front == null || state.frontAsserted) return;
  const rec = state.windows.get(state.front);
  if (!rec) return;
  effects.push({ type: 'RAISE_WINDOW', id: state.front });
  if (rec.kind === 'page-host') effects.push({ type: 'FOCUS_CONTENT', id: state.front });
  // Driving the front now also drives ORDER (§5 step 5): the same closing
  // assertion that raises/first-responders the front places it on top of the
  // ordered stack — list and OS together, one emitter. This is what makes
  // `frontAsserted === true` mean "front is the top of `stackOrder` and we
  // drove the OS to match", killing the §6 buried-but-asserted state for
  // machine-driven raises. (A legal front is always a stack member —
  // `deriveStackingLevel` note — so the raise below is never a no-op.)
  effects.push({ type: 'SET_STACKING', id: state.front });
  stackRaise(state, state.front);
  state.frontAsserted = true;
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
      return;
    }
    case 'leaving-fullscreen': {
      patchRecord(state, id, { fsMode: { name: 'normal' } });
      // Honor a coalesced "actually, re-enter" desire (no captured bounds here).
      if (mode.pendingDesire === true) {
        applyFullscreenRequest(state, id, true, null, effects);
      }
      return;
    }
    case 'entering-fullscreen': {
      // Aborted by the OS mid-enter.
      patchRecord(state, id, { fsMode: { name: 'normal' } });
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
          lastHttpUrl: event.lastHttpUrl ?? existing.lastHttpUrl,
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
        visible: false,
        fsMode: { name: 'normal' },
        focusSeq: 0,
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
      state.windows.set(event.id, { ...rec, source: event.source, params: event.params });
      break;
    }

    case 'WINDOW_CLOSE_REQUESTED': {
      // No state change — the record retires on the WINDOW_CLOSED event the
      // native teardown emits. The effect is emitted even for an unknown id:
      // the backend resolves the handle itself and no-ops when gone.
      effects.push({ type: 'CLOSE_WINDOW_DIRECT', id: event.id });
      break;
    }

    case 'WINDOW_DESTROY_REQUESTED': {
      effects.push({ type: 'DESTROY_WINDOW', id: event.id });
      break;
    }

    case 'WINDOW_SHOW_REQUESTED': {
      effects.push({ type: 'SHOW_WINDOW', id: event.id, activate: event.activate });
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
      // No state change; both invalidate the front assertion (see
      // `invalidatesFrontAssertion`), and the closing assertion step re-drives
      // the front window in the SAME transition — the machine form of the old
      // "re-focus the content window when devtools opens/closes" handlers.
      break;
    }

    case 'WINDOW_SHOWN': {
      const rec = state.windows.get(event.id);
      if (!rec) break;
      patchRecord(state, event.id, { visible: true });
      // Ordered-stack import: showing orders the window frontmost natively
      // (`show` and `showInactive` both order-front), so the list mirrors it on
      // top. This is what makes a restore-shaped back→front import land in
      // exactly the imported order, focused last/on top. NOTE it deliberately
      // does NOT invalidate the front assertion: a non-focused show must not
      // trigger a RAISE_WINDOW (activation) storm — the burial converges when
      // the focused window's own event arrives, and the legacy restore
      // machinery still owns live restore ordering until §5 step 5 part B.
      stackRaise(state, event.id);
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
      patchRecord(state, event.id, { visible: false });
      stackRemove(state, event.id);
      if (state.front === event.id) {
        state.front = successorFront(state, event.id);
      }
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
          effects.push({ type: 'SET_STACKING', id });
        }
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
      if (state.front === event.id) {
        state.front = successorFront(state);
      }
      // Parent refocus (replaces the deleted main.ts `browser-window-created →
      // 'closed' → parentWin.focus()` block): a closing window with a
      // registered parent hands the target back to that parent — taking
      // precedence over the MRU successor — whenever the parent is a legal
      // front. `invalidatesFrontAssertion` returns true for this case even
      // when the parent already WAS front, so the closing assertion step
      // re-drives the raise/first-responder exactly like the old focus() did.
      if (closedRec?.parentId != null) {
        const parent = state.windows.get(closedRec.parentId);
        if (isEligibleFront(parent)) {
          state.front = parent.id;
          bumpFocusSeq(state, parent.id);
        }
      }
      if (state.switcher.open && state.switcher.windowId === event.id) {
        state.switcher = { open: false };
      }
      // Session end (last window closed -> idle) is owned by `izui-state.ts`
      // (its `popWindow`/`endSession`), mirrored in via SESSION_CHANGED. Not
      // derived here (§3).
      break;
    }

    case 'OS_FOCUS_GAINED': {
      applyFocusGained(state, event.id, event.lastHttpUrl);
      break;
    }

    case 'OS_FOCUS_SETTLED_NULL': {
      // Front UNCHANGED — the target must survive an app switch. `appActive`
      // (via APP_RESIGNED) carries "is Peek front", not `front`.
      break;
    }

    case 'APP_ACTIVATED': {
      state.appActive = true;
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
      // without activation. The executor skips SHOW_WINDOW under headless
      // (parity with the old "never re-show overlay/HUD windows under
      // headless" guard).
      for (const rec of [...state.windows.values()]) {
        if (rec.class === 'hud' && rec.hiddenByAppBlur === true) {
          patchRecord(state, rec.id, { hiddenByAppBlur: false });
          effects.push({ type: 'SHOW_WINDOW', id: rec.id, activate: false });
        }
      }
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

    case 'APP_RESIGNED': {
      state.appActive = false;
      // Peek is no longer the active app — an outstanding Esc question must not
      // resolve into a switcher-open after the user left.
      state.escAsk = null;
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
      break;
    }

    case 'OS_FULLSCREEN_LEFT': {
      applyOsFullscreenLeft(state, event.id, effects);
      break;
    }

    case 'FULLSCREEN_SETTLE_TIMEOUT': {
      const rec = state.windows.get(event.id);
      if (rec && (rec.fsMode.name === 'entering-fullscreen' || rec.fsMode.name === 'leaving-fullscreen')) {
        effects.push({ type: 'RECONCILE_FULLSCREEN', id: event.id });
      }
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
        // NO `RAISE_WINDOW` here. `SWITCHER_SELECTED` invalidates the assertion
        // (see `invalidatesFrontAssertion`), so the closing step raises the
        // selection — one place emits the raise, for every path, always.
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
  applyFrontAssertion(prev, state, event, effects);
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

/** A structural, read-only view for tests + the Playwright bridge. */
export interface StateSnapshot {
  appActive: boolean;
  session: IzuiSession;
  front: WindowId | null;
  /** See `AppWindowState.frontAsserted` — intent vs. asserted-onto-the-OS. */
  frontAsserted: boolean;
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
    frontAsserted: state.frontAsserted,
    stackOrder: [...state.stackOrder],
    switcher: state.switcher,
    windows: [...state.windows.values()].map((r) => ({ ...r })),
  };
}

/**
 * Derived Escape-grab predicate (design §2 "The Escape grab becomes honest"):
 * whether the OS-level `globalShortcut('Escape')` safety net should be held.
 *
 *   appActive && (front === null || !frontAsserted)
 *
 * i.e. the net is on exactly when the machine CANNOT VOUCH that some window is
 * positioned to receive Escape through `before-input-event`.
 *
 * The `!frontAsserted` half is the whole point. The previous version was
 * `appActive && front === null && !switcher.open` — a remembered belief with no
 * claim about the OS. Since `OS_FOCUS_SETTLED_NULL` deliberately never clears
 * `front`, a `front` the OS had drifted away from suppressed the net
 * PERMANENTLY: the front window was not first responder (so its
 * `before-input-event` was deaf) AND the grab was off (because `front != null`),
 * so Escape reached nothing at all, ever again (7fffa286). `frontAsserted` is
 * precisely "we have driven the OS to match `front`", which makes `!frontAsserted`
 * the honest form of the signal the old live-OS-read version was approximating.
 *
 * Reads reducer state ONLY. Widening it back into live Electron/OS reads is
 * explicitly REJECTED (design §2 / §7): that reintroduces the rival-authority
 * pattern this machine exists to delete, and papers over a wrong `front` instead
 * of surfacing it.
 *
 * `!switcher.open` is carried over from the old predicate and is NOT redundant:
 * `SWITCHER_OPENED` clears `frontAsserted` (the overlay legitimately took key),
 * which would otherwise switch the grab ON for the one surface that handles
 * Escape in its own renderer. An OS grab pre-empts `before-input-event`, so it
 * would eat the switcher's own Escape, and a second `ESC_PRESSED` per keypress is
 * the switcher-reopen loop (7fffa286).
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
  return snap.front === null || !snap.frontAsserted;
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
