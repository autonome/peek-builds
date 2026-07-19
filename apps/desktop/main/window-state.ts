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
  switcher: SwitcherState;
  windows: Map<number, WindowRecord>;
  /** Monotonic source for `WindowRecord.focusSeq`. */
  focusSeqCounter: number;
}

export function createInitialState(): AppWindowState {
  return {
    appActive: true, // at launch Peek IS the active app (mirrors the coordinator)
    session: 'idle',
    front: null,
    switcher: { open: false },
    windows: new Map(),
    focusSeqCounter: 0,
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
  | { type: 'OS_FOCUS_GAINED'; id: number }
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
  | { type: 'ESC_RENDERER_ANSWER'; id: number; handled: boolean; close?: boolean }
  | { type: 'SWITCHER_OPEN_REQUESTED'; windowId?: number }
  | { type: 'SWITCHER_SELECTED'; id: number | null };

// ─────────────────────────────────────────────────────────────────────────────
// Effects — returned by the reducer, executed by the OS adapter (§2.6). The
// reducer NEVER performs these; it only describes them.
// ─────────────────────────────────────────────────────────────────────────────

export type Effect =
  | { type: 'SET_FULLSCREEN'; id: number; on: boolean }
  /** The single sanctioned OS poll: adapter reads `isFullScreen()` once and re-dispatches OS_FULLSCREEN_ENTERED/LEFT. */
  | { type: 'RECONCILE_FULLSCREEN'; id: number }
  | { type: 'OPEN_SWITCHER_WINDOW'; previousFront: number | null }
  | { type: 'CLOSE_SWITCHER_WINDOW'; restoreTarget: number | null; restoreFocus: boolean }
  | { type: 'RAISE_WINDOW'; id: number }
  /** Make a page-host's content WebContentsView the macOS first responder (the `shouldFocusHybridContentOnHostFocus` invariant, now standard on any front-change to a page-host). */
  | { type: 'FOCUS_CONTENT'; id: number }
  /** Ask the renderer whether it handled ESC (the `escape-pressed` IPC, unchanged protocol). */
  | { type: 'ASK_RENDERER'; id: number }
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
 */
export function escUnhandledPolicy(sessionState: string, role: string): 'open-switcher' | 'nothing' {
  if (sessionState === 'transient' || sessionState === 'overlay') return 'nothing';
  if (['workspace', 'content', 'child-content'].includes(role)) return 'open-switcher';
  return 'nothing';
}

// ─────────────────────────────────────────────────────────────────────────────
// Front arbitration helpers (§2.4)
// ─────────────────────────────────────────────────────────────────────────────

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
    switcher: state.switcher,
    windows: new Map(state.windows),
    focusSeqCounter: state.focusSeqCounter,
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
 * Emit FOCUS_CONTENT when `front` changed to a page-host (the first-responder
 * invariant becomes standard on any transition that makes a page-host front).
 * The adapter gates it on headless/appActive; the reducer only declares intent.
 */
function frontChangeEffects(prevFront: number | null, state: AppWindowState): Effect[] {
  if (state.front == null || state.front === prevFront) return [];
  const rec = state.windows.get(state.front);
  if (rec && rec.kind === 'page-host') return [{ type: 'FOCUS_CONTENT', id: state.front }];
  return [];
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
      applyFocusGained(state, event.id);
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
      break;
    }

    case 'APP_RESIGNED': {
      state.appActive = false;
      if (state.switcher.open) {
        // Close without focus theft — the user is switching to another app.
        const restoreTarget = state.switcher.previousFront;
        effects.push({ type: 'CLOSE_SWITCHER_WINDOW', restoreTarget, restoreFocus: false });
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
      applyEscape(state, effects);
      break;
    }

    case 'ESC_RENDERER_ANSWER': {
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
        effects.push({ type: 'RAISE_WINDOW', id: target });
      }
      break;
    }
  }

  enforceFrontInvariant(state, event);
  effects.push(...frontChangeEffects(prevFront, state));
  return { state, effects };
}

/**
 * OS_FOCUS_GAINED front arbitration (§2.4). Shared by OS_FOCUS_GAINED and the
 * focused variant of WINDOW_SHOWN.
 *   - satellite            -> no front change (bump focusSeq only)
 *   - transition in flight -> ignored for front (the "transition pin")
 *   - else                 -> front = id, bump focusSeq
 */
function applyFocusGained(state: AppWindowState, id: number): void {
  const rec = state.windows.get(id);
  if (!rec) return;
  bumpFocusSeq(state, id);
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
      state.switcher = { open: false };
      effects.push({ type: 'CLOSE_SWITCHER_WINDOW', restoreTarget, restoreFocus: true });
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
      effects.push({ type: 'ASK_RENDERER', id: decision.id });
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

/** A structural, read-only view for tests + the Playwright bridge. */
export interface StateSnapshot {
  appActive: boolean;
  session: IzuiSession;
  front: number | null;
  switcher: SwitcherState;
  windows: WindowRecord[];
}

export function snapshot(state: AppWindowState): StateSnapshot {
  return {
    appActive: state.appActive,
    session: state.session,
    front: state.front,
    switcher: state.switcher,
    windows: [...state.windows.values()].map((r) => ({ ...r })),
  };
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
