/**
 * window-state.ts — the ONE deterministic owner of front-window / fullscreen /
 * switcher / escape state for the desktop app.
 *
 * Blueprint: `docs/design/fullscreen-escape-window-fsm.md`. This module is the
 * pure core of that design (§2): a single `AppWindowState` value mutated ONLY by
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

/** Plain rectangle (mirrors Electron's `Rectangle`, kept local so this file is Electron-free). */
export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type WindowKind = 'page-host' /* BaseWindow + WebContentsView */ | 'browser';

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
  id: number;
  kind: WindowKind;
  /** Existing IZUI role vocabulary (palette / quick-view / overlay / workspace / content / child-content / utility). */
  role: string;
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
  | { open: true; windowId: number; previousFront: number | null };

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
  front: number | null;
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
  switcher: SwitcherState;
  windows: Map<number, WindowRecord>;
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
  escAsk: { id: number; seq: number } | null;
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
  | { type: 'WINDOW_REGISTERED'; id: number; kind: WindowKind; role: string; satellite: boolean; escapeMode?: EscapeMode; lastHttpUrl?: string }
  | { type: 'WINDOW_SHOWN'; id: number; focused: boolean }
  | { type: 'WINDOW_HIDDEN'; id: number }
  | { type: 'WINDOW_CLOSED'; id: number }
  | { type: 'OS_FOCUS_GAINED'; id: number; lastHttpUrl?: string }
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
  | { type: 'FULLSCREEN_REQUESTED'; id?: number; desired?: boolean; bounds?: Rectangle | null }
  | { type: 'OS_FULLSCREEN_ENTERED'; id: number }
  | { type: 'OS_FULLSCREEN_LEFT'; id: number }
  | { type: 'FULLSCREEN_SETTLE_TIMEOUT'; id: number }
  | { type: 'ESC_PRESSED'; landedId: number | 'global' }
  /**
   * The renderer's answer to an `ASK_RENDERER`. `seq` echoes the epoch of the
   * ask it answers (see `AppWindowState.escAsk`); an answer that does not match
   * the pending ask is stale and is dropped.
   */
  | { type: 'ESC_RENDERER_ANSWER'; id: number; handled: boolean; close?: boolean; seq: number }
  | { type: 'SWITCHER_OPEN_REQUESTED'; windowId?: number }
  | { type: 'SWITCHER_SELECTED'; id: number | null }
  /**
   * Mirror-only (staged cutover): the switcher overlay WINDOW actually opened.
   * The overlay-window lifecycle (open/select/teardown/focus-restore + the macOS
   * focus-dance cooldowns) stays owned by `izui-state.ts` + `main.ts`; this event
   * only records switcher state in the machine so `decideEscape` step 1
   * (`switcher.open → close-switcher`) and the derived Esc-grab predicate fire
   * correctly. It emits NO effect — the window already exists.
   */
  | { type: 'SWITCHER_OPENED'; windowId: number };

// ─────────────────────────────────────────────────────────────────────────────
// Effects — returned by the reducer, executed by the OS adapter (§2.6). The
// reducer NEVER performs these; it only describes them.
// ─────────────────────────────────────────────────────────────────────────────

export type Effect =
  | { type: 'SET_FULLSCREEN'; id: number; on: boolean }
  /** The single sanctioned OS poll: adapter reads `isFullScreen()` once and re-dispatches OS_FULLSCREEN_ENTERED/LEFT. */
  | { type: 'RECONCILE_FULLSCREEN'; id: number }
  | { type: 'OPEN_SWITCHER_WINDOW'; previousFront: number | null }
  /**
   * `switcherWindowId` is the overlay window to tear down. In the staged cutover
   * the adapter DELEGATES the teardown to izui (`closeOrHideWindow`) only on the
   * ESC path (`restoreFocus:true`); on app-blur (`restoreFocus:false`) the
   * existing `main.ts did-resign-active` block owns the teardown (with its
   * cooldown focus-dance protection), so the adapter is a no-op there.
   */
  | { type: 'CLOSE_SWITCHER_WINDOW'; restoreTarget: number | null; restoreFocus: boolean; switcherWindowId: number | null }
  | { type: 'RAISE_WINDOW'; id: number }
  /**
   * Make a page-host's content WebContentsView the macOS first responder (the
   * `shouldFocusHybridContentOnHostFocus` invariant). Emitted by the closing
   * assertion step alongside `RAISE_WINDOW` whenever the front window is a
   * page-host and the assertion is not currently held — NOT only when `front`
   * changes (see `AppWindowState.frontAsserted`).
   */
  | { type: 'FOCUS_CONTENT'; id: number }
  /**
   * Ask the renderer whether it handled ESC (the `escape-pressed` IPC, unchanged
   * protocol). `seq` is the epoch token the adapter MUST echo back on the
   * resulting `ESC_RENDERER_ANSWER` so a deferred answer is judged against the
   * ask that produced it (see `AppWindowState.escAsk`).
   */
  | { type: 'ASK_RENDERER'; id: number; seq: number }
  | { type: 'CLOSE_WINDOW'; id: number }
  /** ESC consumed by leaving fullscreen (also drives the leaving fsMode edge + SET_FULLSCREEN in the same reduce). */
  | { type: 'EXIT_FULLSCREEN'; id: number }
  /** ESC passed straight to the page (escapeMode 'ignore'). */
  | { type: 'PASS_THROUGH'; id: number }
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
  | { kind: 'pass-through'; id: number }
  | { kind: 'exit-fullscreen'; id: number }
  | { kind: 'ask-renderer'; id: number };

export type EscapeUnhandledDecision =
  | { kind: 'close-window'; id: number }
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
export function decideEscapeUnhandled(state: AppWindowState, windowId: number): EscapeUnhandledDecision {
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
 */
export function isSatelliteRegistration(
  role: string,
  opts: { modal?: boolean; focusable?: boolean } = {},
): boolean {
  if (role === 'overlay' || role === 'palette') return true;
  if (opts.modal === true) return true;
  if (opts.focusable === false) return true;
  return false;
}

/**
 * What `WindowOsAdapter.registerWindow` must do for one registration call.
 * Every field is a decision, not a value — the adapter executes it verbatim.
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
}

/**
 * decideWindowRegistration — the SINGLE owner of the "is this a re-registration,
 * and if so what carries over vs. what the new spec overwrites?" branch that
 * `WindowOsAdapter.registerWindow` executes.
 *
 * WHY it lives here and not next to its caller: `window-os-adapter.ts` has a
 * value-side `import { app, BrowserWindow, globalShortcut } from 'electron'`,
 * and the main-process unit gate runs its tests under `ELECTRON_RUN_AS_NODE=1`,
 * where that import throws at parse ("The requested module 'electron' does not
 * provide an export named 'BrowserWindow'" — see the explanatory comment in
 * `window-registry.ts`). A test file importing the adapter would take down the
 * whole ~1950-test runner. `window-state.ts` has zero imports, so the decision
 * is testable here and nowhere else. Same pattern as the pure predicates in
 * `izui-roles.ts` and `isSatelliteRegistration` above.
 */
export function decideWindowRegistration(input: {
  /** Whether the adapter already retains an entry for this window id. */
  alreadyRegistered: boolean;
  kind: WindowKind;
  /** Whether the spec carries a `contentWC` field at all (`undefined` = absent). */
  hasContentWC: boolean;
  /** The spec's `attachEscHandler` opt-out (`undefined` = default on). */
  attachEscHandlerRequested?: boolean;
}): WindowRegistrationDecision {
  const { alreadyRegistered, kind, hasContentWC, attachEscHandlerRequested } = input;
  const fresh = !alreadyRegistered;
  return {
    reRegistration: alreadyRegistered,
    attachNativeListeners: fresh,
    attachEscHandler: fresh && kind === 'browser' && attachEscHandlerRequested !== false,
    adoptRendererWC: fresh || hasContentWC,
    pumpRegisteredEvent: true,
  };
}

/** A record is a legal `front` iff it is live, visible, and non-satellite. */
export function isEligibleFront(rec: WindowRecord | undefined): rec is WindowRecord {
  return !!rec && rec.visible && !rec.satellite;
}

/** MRU successor: the visible non-satellite window with the highest focusSeq (null if none). */
function successorFront(state: AppWindowState, excludeId?: number): number | null {
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

// ─────────────────────────────────────────────────────────────────────────────
// Immutable-update helpers (the reducer must not mutate its input)
// ─────────────────────────────────────────────────────────────────────────────

function cloneState(state: AppWindowState): AppWindowState {
  return {
    appActive: state.appActive,
    session: state.session,
    front: state.front,
    frontAsserted: state.frontAsserted,
    switcher: state.switcher,
    windows: new Map(state.windows),
    focusSeqCounter: state.focusSeqCounter,
    escAsk: state.escAsk,
    escSeq: state.escSeq,
  };
}

/** Copy a record and apply a patch; write it back into a (freshly cloned) map. */
function patchRecord(state: AppWindowState, id: number, patch: Partial<WindowRecord>): void {
  const cur = state.windows.get(id);
  if (!cur) return;
  state.windows.set(id, { ...cur, ...patch });
}

/** Bump a record's focusSeq to a fresh MRU value. Mutates the (already-cloned) state. */
function bumpFocusSeq(state: AppWindowState, id: number): void {
  const cur = state.windows.get(id);
  if (!cur) return;
  state.focusSeqCounter += 1;
  state.windows.set(id, { ...cur, focusSeq: state.focusSeqCounter });
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
    // A palette / modal / chrome overlay took key. It is a satellite, so `front`
    // deliberately did NOT move — which is exactly why the assertion has to.
    case 'OS_FOCUS_GAINED':
      return next.windows.get(event.id)?.satellite === true;
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
  id: number,
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

function applyOsFullscreenEntered(state: AppWindowState, id: number, effects: Effect[]): void {
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

function applyOsFullscreenLeft(state: AppWindowState, id: number, effects: Effect[]): void {
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
          lastHttpUrl: event.lastHttpUrl ?? existing.lastHttpUrl,
        });
        // If the richer spec turned the CURRENT front into a satellite, hand
        // `front` to the MRU successor here rather than leave an illegal front
        // for the guard to trip on.
        if (state.front === event.id && !isEligibleFront(state.windows.get(event.id))) {
          state.front = successorFront(state, event.id);
        }
        break;
      }
      const rec: WindowRecord = {
        id: event.id,
        kind: event.kind,
        role: event.role,
        escapeMode: event.escapeMode,
        satellite: event.satellite,
        visible: false,
        fsMode: { name: 'normal' },
        focusSeq: 0,
        lastHttpUrl: event.lastHttpUrl,
      };
      state.windows.set(event.id, rec);
      break;
    }

    case 'WINDOW_SHOWN': {
      const rec = state.windows.get(event.id);
      if (!rec) break;
      patchRecord(state, event.id, { visible: true });
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
      if (state.front === event.id) {
        state.front = successorFront(state, event.id);
      }
      break;
    }

    case 'WINDOW_CLOSED': {
      state.windows.delete(event.id);
      // A pending renderer question aimed at this window can never be answered
      // meaningfully — drop it so a late answer is inert.
      if (state.escAsk && state.escAsk.id === event.id) state.escAsk = null;
      if (state.front === event.id) {
        state.front = successorFront(state);
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
      const windowId = event.windowId ?? -1;
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
function applyFocusGained(state: AppWindowState, id: number, lastHttpUrl?: string): void {
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
  state.switcher = { open: true, windowId: -1, previousFront };
  effects.push({ type: 'OPEN_SWITCHER_WINDOW', previousFront });
}

// ─────────────────────────────────────────────────────────────────────────────
// Selectors (§2.4 derived reads)
// ─────────────────────────────────────────────────────────────────────────────

/** Command target / close target / Esc target / session-save focused descriptor. */
export function getFrontWindowId(state: AppWindowState): number | null {
  return state.front;
}

export function getWindowMode(state: AppWindowState, id: number): FsMode['name'] | null {
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
export function getWindowPreBounds(state: AppWindowState, id: number): Rectangle | null {
  const rec = state.windows.get(id);
  if (!rec || rec.fsMode.name === 'normal') return null;
  return rec.fsMode.preBounds;
}

/**
 * A window's MRU focus rank (absorbs `focus-order.ts` `getFocusOrder`): higher =
 * more recently focused, 0 if never focused / unregistered. Session-save reads
 * this to rank windows for eager/deferred restore.
 */
export function getWindowFocusSeq(state: AppWindowState, id: number): number {
  return state.windows.get(id)?.focusSeq ?? 0;
}

/**
 * Devtools target selector (absorbs `lastContentWindowId`): the most-recently
 * focused window bearing an http(s) `lastHttpUrl`, or null. Replaces
 * `getLastContentWindowId()` in the `tile:window:devtools` fallback.
 */
export function getDevtoolsTargetId(state: AppWindowState): number | null {
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
  front: number | null;
  /** See `AppWindowState.frontAsserted` — intent vs. asserted-onto-the-OS. */
  frontAsserted: boolean;
  switcher: SwitcherState;
  windows: WindowRecord[];
}

export function snapshot(state: AppWindowState): StateSnapshot {
  return {
    appActive: state.appActive,
    session: state.session,
    front: state.front,
    frontAsserted: state.frontAsserted,
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
 * same reason `decideWindowRegistration` does — that module's value-side
 * `electron` import makes it unloadable from a test under the unit gate's
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

  getFrontWindowId(): number | null {
    return getFrontWindowId(this.state);
  }

  getWindowMode(id: number): FsMode['name'] | null {
    return getWindowMode(this.state, id);
  }

  getWindowPreBounds(id: number): Rectangle | null {
    return getWindowPreBounds(this.state, id);
  }

  getDevtoolsTargetId(): number | null {
    return getDevtoolsTargetId(this.state);
  }

  getWindowFocusSeq(id: number): number {
    return getWindowFocusSeq(this.state, id);
  }

  snapshot(): StateSnapshot {
    return snapshot(this.state);
  }

  /**
   * Resolve when window `id` reaches fullscreen `mode`. The settle-await callers
   * want (§2.4) — on the machine, not a promise inside the mutator. Resolves
   * immediately if already there.
   */
  waitForMode(id: number, mode: FsMode['name']): Promise<void> {
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
