/**
 * window-os-adapter.ts — the OS-boundary adapter for the deterministic window
 * state machine (design §2.6, Unit C).
 *
 * Blueprint: `docs/design/fullscreen-escape-window-fsm.md`. `window-state.ts`
 * is the pure, Electron-free reducer/owner (§2). THIS module is the ONLY file
 * that touches native window events + effects for that domain: it normalizes
 * Electron's `focus`/`blur`/`show`/`hide`/`closed`/`enter-full-screen`/
 * `leave-full-screen` (plus the content-WebContents `focus`) into the reducer's
 * event alphabet, and executes the effects the reducer returns
 * (`setFullScreen`, show/raise/activate + `contentWC.focus()`, the Escape grab,
 * `ASK_RENDERER`, open/close switcher, `RECONCILE_FULLSCREEN`).
 *
 * SCOPE (this slice — Unit C, NO consumers wired): this module is importable and
 * self-contained but runs in SHADOW. Nothing in the app's wiring calls
 * `attachAppListeners()` / `registerWindow()` yet, so no listener is attached and
 * no effect executes at runtime. The seam cutovers (ipc.ts / izui-roles.ts /
 * windows.ts / main.ts / tile-ipc.ts …) that route the app THROUGH this adapter
 * and delete the old focus/fullscreen/Esc paths are later slices (§3, D–H). This
 * slice changes zero runtime behavior. Do NOT wire it here.
 *
 * Two OS/Chromium boundary workarounds live here (and NOWHERE else — the reducer
 * has no timers), each commented at its site:
 *   - the ONE deferred-blur settle that emits `OS_FOCUS_SETTLED_NULL` (§4.4);
 *   - the bounded fullscreen settle timer that emits `FULLSCREEN_SETTLE_TIMEOUT`
 *     (§2.3) so a stuck `entering`/`leaving` mode self-corrects via `reconcile`.
 *
 * Headless gating: focus/activation side effects are gated on `isHeadless()` —
 * the SAME predicate `hybridShowIntent`/`showHybridHost` (windows.ts) use — so an
 * agent/CI run never steals the user's OS focus (peek 2b55f3af). We reuse those
 * seams directly (`showHybridHost` already calls `hybridShowIntent(isHeadless())`)
 * rather than re-deriving the decision.
 */

import { app, BrowserWindow, globalShortcut } from 'electron';
import type { BaseWindow, WebContents } from 'electron';

import { isHeadless, DEBUG } from './config.js';
import { publish, getSystemAddress } from './pubsub.js';
import {
  showHybridHost,
  showWindowHeadlessSafe,
  askWebContentsToHandleEscape,
  closeOrHideWindow,
  addEscHandler,
} from './windows.js';
import {
  WindowStateOwner,
  decideWindowRegistration,
  type Effect,
  type StateSnapshot,
  type WindowEvent,
  type WindowKind,
  type EscapeMode,
} from './window-state.js';

// Bounded wait for the native fullscreen transition to settle, matching the
// pre-machine owner (`hybrid-page-host-registry.ts HYBRID_FULLSCREEN_SETTLE_TIMEOUT_MS`).
// The AppKit enter/leave-fullscreen animation runs ~600ms; this leaves margin so
// a destroyed / no-op window (which never emits the settled event) can't strand
// the machine in `entering`/`leaving` forever — the timer dispatches
// FULLSCREEN_SETTLE_TIMEOUT, whose reducer clause emits RECONCILE_FULLSCREEN.
const FULLSCREEN_SETTLE_TIMEOUT_MS = 1500;

/**
 * The structural minimum of a native window this adapter drives. Both
 * `BaseWindow` (page-host) and `BrowserWindow` (browser) satisfy it — a
 * BaseWindow is NOT a BrowserWindow (no root `.webContents`), so we keep the
 * per-kind divergence (content WC, raise seam) explicit rather than casting one
 * to the other. Every method here exists on BOTH kinds in Electron 40.
 */
interface NativeWindow {
  id: number;
  isDestroyed(): boolean;
  isFocused(): boolean;
  isFullScreen(): boolean;
  setFullScreen(flag: boolean): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** What the adapter retains per registered window to execute effects against it. */
interface AdapterWindow {
  win: NativeWindow;
  kind: WindowKind;
  /**
   * The renderer WebContents that answers the `escape-pressed` IPC and is the
   * macOS first responder: the content `WebContentsView`'s WC for a page-host,
   * the root WC for a browser window. `null` if the caller supplied none.
   */
  rendererWC: WebContents | null;
}

/**
 * Derived Escape-grab predicate (§2.4 "Derived — never stored"): the OS-level
 * `globalShortcut('Escape')` grab is registered IFF Peek is active, there is no
 * front window to receive `before-input-event`, and the switcher is closed.
 *
 * Pure and exported so the later grab-seam slice (which deletes main.ts's
 * `shouldRegisterGlobalEscFallback` + its 5 re-evaluation sites) shares ONE
 * definition, and so it is unit-testable in isolation from the OS.
 */
export function deriveEscGrabRegistered(snap: StateSnapshot): boolean {
  return snap.appActive && snap.front === null && !snap.switcher.open;
}

export interface RegisterWindowSpec {
  id: number;
  kind: WindowKind;
  role: string;
  satellite: boolean;
  escapeMode?: EscapeMode;
  lastHttpUrl?: string;
  /** The native window handle (BaseWindow for page-host, BrowserWindow for browser). */
  win: NativeWindow;
  /**
   * The renderer WebContents: the content view's WC for a page-host, the root WC
   * for a browser. Used for `ASK_RENDERER` and (page-host only) `FOCUS_CONTENT`.
   */
  contentWC?: WebContents | null;
  /**
   * Whether THIS adapter owns the window's `before-input-event` Esc interceptor
   * (`windows.ts addEscHandler` → `ESC_PRESSED`). Defaults to true for `browser`
   * windows — registration is the single owner of the attach, so it can never be
   * attached twice for one window.
   *
   * Ignored for `page-host` windows: a BaseWindow has no root webContents, and
   * its Esc already rides on the content WebContentsView's `before-input-event`
   * (`wireHybridContentEvents` in ipc.ts).
   *
   * The ONE browser window that opts OUT is the shared chrome overlay
   * (`hybrid-overlay.ts`): it has never had a main-process Esc interceptor and
   * handles Escape in its own renderer (closing the address bar), which a
   * `preventDefault`ing main-side handler would swallow.
   */
  attachEscHandler?: boolean;
}

/**
 * The OS-boundary adapter. Holds the (single) `WindowStateOwner`, attaches native
 * listeners that dispatch into it, and executes the effects it returns. One
 * instance per app; later slices construct it once and hand the SAME owner to
 * the read-only consumers.
 */
export class WindowOsAdapter {
  private readonly owner: WindowStateOwner;

  /** Native handles + renderer WC per registered window id (for effect execution). */
  private readonly windows = new Map<number, AdapterWindow>();

  /** The ONE deferred-blur settle handle (§4.4) — coalesced, at most one pending. */
  private pendingBlurSettle: ReturnType<typeof setImmediate> | null = null;

  /** Per-window bounded fullscreen settle timers (§2.3). */
  private readonly fullscreenSettleTimers = new Map<number, ReturnType<typeof setTimeout>>();

  /** Whether we currently hold the OS Escape grab (mirrors `deriveEscGrabRegistered`). */
  private escGrabRegistered = false;

  /** Stable handler reference so register/unregister target the same closure. */
  private readonly escGrabHandler = (): void => {
    // The grab fires the SAME `ESC_PRESSED` the before-input-event path will (a
    // later seam) — `decideEscape` is the single decision, so a stale grab is
    // harmless (defense by shared decision, not by registration timing, §4.2).
    this.pump({ type: 'ESC_PRESSED', landedId: 'global' });
  };

  constructor(owner: WindowStateOwner = new WindowStateOwner()) {
    this.owner = owner;
  }

  /** The shared state owner (read-only consumers attach to this). */
  getOwner(): WindowStateOwner {
    return this.owner;
  }

  /**
   * Public dispatch entry for the live consumers that feed the machine from
   * outside the native-listener paths this adapter attaches itself: the ESC
   * before-input seam (ipc.ts / windows.ts → `ESC_PRESSED`), the fullscreen
   * command (tile-ipc.ts → `FULLSCREEN_REQUESTED`), the synchronous hide seam
   * (`WINDOW_HIDDEN`), the switcher mirror (`SWITCHER_OPENED`), and the session
   * mirror (`SESSION_CHANGED`). Runs the SAME pump every native
   * listener does — effects execute, transition log fires, Esc grab reconciles.
   */
  dispatch(event: WindowEvent): void {
    this.pump(event);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Listener attachment (§2.6). NOTHING in this slice calls these.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * App-level focus listeners → `APP_ACTIVATED`/`APP_RESIGNED`. `APP_ACTIVATED`
   * makes the reducer emit `RECONCILE_FULLSCREEN` for any in-flight transition
   * (§2.5). Later slices move main.ts's `did-become/resign-active` dispatch here.
   */
  attachAppListeners(): void {
    (app as unknown as { on(e: string, l: () => void): void }).on('did-become-active', () => {
      this.pump({ type: 'APP_ACTIVATED' });
    });
    (app as unknown as { on(e: string, l: () => void): void }).on('did-resign-active', () => {
      this.pump({ type: 'APP_RESIGNED' });
    });
  }

  /**
   * Dispatch `WINDOW_REGISTERED`, attach the window's Esc interceptor, and attach
   * the per-window native listeners for BOTH kinds (§2.6): `focus`, `blur`,
   * `show`, `hide`, `closed`, `enter-full-screen`, `leave-full-screen`, plus the
   * content-WC `focus` for page-hosts. Each is a one-line dispatch — the sole
   * exception is `blur`, which arms the ONE deferred-blur settle instead of
   * dispatching (§4.4).
   *
   * IDEMPOTENT per window id, and that is load-bearing: more than one call site
   * registers the same BrowserWindow (the tile-launcher hook inside
   * `createTileBrowserWindow`, then the `ipc.ts` window-open site for the same
   * window). Re-attaching would give one physical Escape TWO `ESC_PRESSED`
   * dispatches — and the second one, arriving after the switcher already closed,
   * re-opened it 500ms later in an unbreakable loop. So a repeat registration
   * MERGES the (richer) spec and returns without touching listeners.
   *
   * The branch itself is NOT decided here: `decideWindowRegistration`
   * (`window-state.ts`) owns it, so it can be unit-tested — this module's
   * value-side `electron` import makes a test file next to it unloadable under
   * the unit gate's `ELECTRON_RUN_AS_NODE=1`. This method only EXECUTES the
   * decision against the OS.
   */
  registerWindow(spec: RegisterWindowSpec): void {
    const { id, kind, role, satellite, escapeMode, lastHttpUrl, win } = spec;
    const rendererWC = spec.contentWC ?? null;

    const existing = this.windows.get(id);
    const decision = decideWindowRegistration({
      alreadyRegistered: existing !== undefined,
      kind,
      hasContentWC: spec.contentWC !== undefined,
      attachEscHandlerRequested: spec.attachEscHandler,
    });

    if (existing) {
      existing.win = win;
      existing.kind = kind;
      if (decision.adoptRendererWC) existing.rendererWC = rendererWC;
    } else {
      this.windows.set(id, { win, kind, rendererWC });
    }

    if (decision.pumpRegisteredEvent) {
      this.pump({ type: 'WINDOW_REGISTERED', id, kind, role, satellite, escapeMode, lastHttpUrl });
    }

    // The SINGLE owner of the `before-input-event` Esc attach for browser
    // windows (see `RegisterWindowSpec.attachEscHandler`). There is exactly one
    // attach per window, so one keypress can only ever produce one `ESC_PRESSED`.
    if (decision.attachEscHandler) {
      try {
        addEscHandler(win as unknown as BrowserWindow);
      } catch (err) {
        DEBUG && console.log('[window-state] esc handler attach failed for', id, err);
      }
    }

    if (!decision.attachNativeListeners) return;

    win.on('focus', () => {
      this.cancelBlurSettle();
      this.pump({ type: 'OS_FOCUS_GAINED', id, lastHttpUrl: this.readHttpUrl(id) });
    });
    // The ONE deferred-blur settle: blur alone can't tell "focus left Peek" from
    // "focus is moving to the next Peek window" — Electron fires the old window's
    // `blur` BEFORE the new window's `focus` (§4.4). So arm a one-tick settle; a
    // focus that lands in-app cancels it before it runs.
    win.on('blur', () => {
      this.armBlurSettle();
    });
    win.on('show', () => {
      this.pump({ type: 'WINDOW_SHOWN', id, focused: this.isFocused(win) });
    });
    win.on('hide', () => {
      this.pump({ type: 'WINDOW_HIDDEN', id });
    });
    win.on('closed', () => {
      this.clearFullscreenSettle(id);
      this.windows.delete(id);
      this.pump({ type: 'WINDOW_CLOSED', id });
    });
    win.on('enter-full-screen', () => {
      this.clearFullscreenSettle(id);
      this.pump({ type: 'OS_FULLSCREEN_ENTERED', id });
    });
    win.on('leave-full-screen', () => {
      this.clearFullscreenSettle(id);
      this.pump({ type: 'OS_FULLSCREEN_LEFT', id });
    });
    // Page-host: clicking directly into the page focuses the content WC even when
    // the host BaseWindow's own `focus` is missed (belt-and-suspenders, mirrors
    // the registry's content-WC focus fallback).
    if (kind === 'page-host' && rendererWC) {
      rendererWC.on('focus', () => {
        this.cancelBlurSettle();
        this.pump({ type: 'OS_FOCUS_GAINED', id, lastHttpUrl: this.readHttpUrl(id) });
      });
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Dispatch pump: one path for every event. Reads before/after snapshots so it
  // can emit the transition log (§5.3) and reconcile the derived Esc grab.
  // ───────────────────────────────────────────────────────────────────────────

  private pump(event: WindowEvent): void {
    const before = this.owner.snapshot();
    const effects = this.owner.dispatch(event);
    const after = this.owner.snapshot();
    this.logTransition(event, before, after);
    this.runEffects(effects);
    this.reconcileEscGrab(this.owner.snapshot());
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Effect executor (§2.6). The reducer describes; the adapter performs.
  // ───────────────────────────────────────────────────────────────────────────

  private runEffects(effects: Effect[]): void {
    for (const effect of effects) {
      try {
        this.runEffect(effect);
      } catch (err) {
        DEBUG && console.log('[window-state] effect failed:', effect.type, err);
      }
    }
  }

  private runEffect(effect: Effect): void {
    switch (effect.type) {
      case 'SET_FULLSCREEN': {
        // The SINGLE place `setFullScreen` is called for BOTH kinds (§2.4 — the
        // raw route in tile-ipc.ts is deleted in a later seam). NOT gated on
        // headless: the pre-machine owner (`setHybridHostFullScreen`) isn't
        // either, and the bridge-driven "disruptive fullscreen" spec (§5.4)
        // relies on a real transition. Focus/activation are what headless gates.
        const w = this.windows.get(effect.id)?.win;
        if (!w || w.isDestroyed()) return;
        w.setFullScreen(effect.on);
        // Arm the bounded settle timer so a transition that never emits its
        // native settled event self-corrects via RECONCILE_FULLSCREEN (§2.3).
        this.armFullscreenSettle(effect.id);
        return;
      }
      case 'RECONCILE_FULLSCREEN': {
        // The ONE sanctioned `isFullScreen()` poll (§2.5): read reality ONCE and
        // snap `fsMode` to it. No other code may read `isFullScreen()` for state.
        const w = this.windows.get(effect.id)?.win;
        if (!w || w.isDestroyed()) return;
        this.pump(
          w.isFullScreen()
            ? { type: 'OS_FULLSCREEN_ENTERED', id: effect.id }
            : { type: 'OS_FULLSCREEN_LEFT', id: effect.id },
        );
        return;
      }
      case 'RAISE_WINDOW': {
        this.raiseWindow(effect.id);
        return;
      }
      case 'FOCUS_CONTENT': {
        // Make a page-host's content WC the macOS first responder (the
        // `shouldFocusHybridContentOnHostFocus` invariant, now standard on any
        // front-change to a page-host). Focus-free under headless.
        if (isHeadless()) return;
        const wc = this.windows.get(effect.id)?.rendererWC;
        if (!wc || wc.isDestroyed()) return;
        wc.focus();
        return;
      }
      case 'ASK_RENDERER': {
        // The `escape-pressed` IPC, unchanged protocol. The renderer's answer
        // drives `decideEscape` step 6.
        const wc = this.windows.get(effect.id)?.rendererWC;
        // `effect.seq` is the ask's epoch — echo it back on BOTH answer paths so
        // the reducer can drop an answer whose question no longer stands.
        if (!wc || wc.isDestroyed()) {
          // No renderer to ask → treat as unhandled so ESC still resolves.
          this.pump({ type: 'ESC_RENDERER_ANSWER', id: effect.id, handled: false, seq: effect.seq });
          return;
        }
        void askWebContentsToHandleEscape(effect.id, wc).then((ans) => {
          this.pump({
            type: 'ESC_RENDERER_ANSWER',
            id: effect.id,
            handled: ans.handled,
            close: ans.close,
            seq: effect.seq,
          });
        });
        return;
      }
      case 'CLOSE_WINDOW': {
        // Route through the existing close/hide seam (honors keepLive, hybrid vs
        // browser). Fire-and-forget: it is async (its hybrid branch awaits a
        // fullscreen exit); the machine already recorded intent.
        void closeOrHideWindow(effect.id);
        return;
      }
      case 'OPEN_SWITCHER_WINDOW': {
        // The existing windows-feature tile renders the switcher; opening it is a
        // `cmd:execute:windows` publish (same trigger the deleted global-Esc
        // fallback used). `previousFront` is retained in machine state for the
        // restore-on-close, so nothing rides on the payload here.
        publish(getSystemAddress(), 'cmd:execute:windows', {});
        return;
      }
      case 'CLOSE_SWITCHER_WINDOW': {
        // Staged cutover: the switcher OVERLAY WINDOW lifecycle stays owned by
        // izui-state.ts + main.ts. This effect DELEGATES the teardown — it does
        // not itself destroy the overlay or restore focus.
        //   - ESC path (restoreFocus:true): the old escPolicy('overlay') route
        //     is deleted, so this is the SINGLE close path. `closeOrHideWindow`
        //     tears the overlay down; its 'closed' handler (main.ts) then runs
        //     `exitOverlay` + the focus restore + `popWindow`.
        //   - app-blur path (restoreFocus:false): `main.ts did-resign-active`
        //     owns the teardown (with its cooldown focus-dance protection), so
        //     this is a no-op — closing here would double-close and defeat the
        //     cooldown.
        if (effect.restoreFocus && effect.switcherWindowId != null) {
          void closeOrHideWindow(effect.switcherWindowId);
        }
        return;
      }
      case 'EXIT_FULLSCREEN': {
        // Semantic marker: "ESC was consumed by leaving fullscreen." The actual
        // toggle rides on the companion `SET_FULLSCREEN(id,false)` the reducer
        // emits in the SAME reduce when the window is settled `fullscreen`; when
        // it is mid-transition the reducer coalesces (pendingDesire) and emits NO
        // second setFullScreen — so this must stay a no-op to avoid double-toggle.
        return;
      }
      case 'PASS_THROUGH': {
        // ESC handed to the page (escapeMode 'ignore'). The synchronous "don't
        // preventDefault this keystroke" decision belongs to the before-input-event
        // seam (a later slice attaches it + consults `decideEscape`); nothing to
        // do post-dispatch here.
        return;
      }
      case 'NOTHING': {
        return;
      }
    }
  }

  /** Show + raise + activate a window (page-host via the shared show seam). */
  private raiseWindow(id: number): void {
    const entry = this.windows.get(id);
    if (!entry) return;
    const { win, kind, rendererWC } = entry;
    if (win.isDestroyed()) return;
    if (kind === 'page-host') {
      // Reuses `hybridShowIntent(isHeadless())` — headless → showInactive +
      // opacity-0, never activate/focus; non-headless → activate + first responder.
      showHybridHost(win as unknown as BaseWindow, rendererWC as unknown as WebContents);
      return;
    }
    // Browser window: headless-safe show (opacity-0 + inactive under headless),
    // activate + focus only when not headless.
    const bw = win as unknown as BrowserWindow;
    showWindowHeadlessSafe(bw, { active: !isHeadless() });
    if (!isHeadless()) {
      try {
        bw.focus();
      } catch {
        /* window gone mid-raise */
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Derived Escape grab (§2.4). Reconciled on EVERY transition — replaces
  // main.ts's 5 re-evaluation sites. Skipped under headless (no OS grab).
  // ───────────────────────────────────────────────────────────────────────────

  private reconcileEscGrab(snap: StateSnapshot): void {
    if (isHeadless()) return;
    const want = deriveEscGrabRegistered(snap);
    if (want === this.escGrabRegistered) return;
    if (want) {
      try {
        const ok = globalShortcut.register('Escape', this.escGrabHandler);
        this.escGrabRegistered = ok;
      } catch (err) {
        console.error('[window-state] Esc grab register failed:', err);
      }
    } else {
      try {
        globalShortcut.unregister('Escape');
      } catch {
        /* unregistering a hotkey not held is a no-op on some platforms */
      }
      this.escGrabRegistered = false;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // The ONE deferred-blur settle (§4.4). The lowest layer: the OS/Chromium
  // boundary where "focus left all Peek windows" is only knowable one tick after
  // a blur. The reducer itself has NO timers — this is the single sanctioned one
  // on the focus path.
  // ───────────────────────────────────────────────────────────────────────────

  private armBlurSettle(): void {
    if (this.pendingBlurSettle) return; // coalesce — at most one pending settle
    this.pendingBlurSettle = setImmediate(() => {
      this.pendingBlurSettle = null;
      // One tick later Electron has delivered any incoming `focus`. If some Peek
      // window now holds focus, focus stayed in-app — do nothing. Otherwise it
      // left the whole group → emit OS_FOCUS_SETTLED_NULL.
      if (this.anyWindowFocused()) return;
      this.pump({ type: 'OS_FOCUS_SETTLED_NULL' });
    });
  }

  private cancelBlurSettle(): void {
    if (!this.pendingBlurSettle) return;
    clearImmediate(this.pendingBlurSettle);
    this.pendingBlurSettle = null;
  }

  private anyWindowFocused(): boolean {
    for (const { win } of this.windows.values()) {
      if (this.isFocused(win)) return true;
    }
    return false;
  }

  private isFocused(win: NativeWindow): boolean {
    try {
      return !win.isDestroyed() && win.isFocused();
    } catch {
      return false;
    }
  }

  /**
   * The window's current http(s) URL (from its renderer WC), or undefined when
   * it is not on an http(s) page. Fed to `OS_FOCUS_GAINED` so the reducer can
   * track the devtools target (absorbs the old `lastContentWindowId`).
   */
  private readHttpUrl(id: number): string | undefined {
    const wc = this.windows.get(id)?.rendererWC;
    if (!wc || wc.isDestroyed()) return undefined;
    try {
      const url = wc.getURL();
      return url.startsWith('http://') || url.startsWith('https://') ? url : undefined;
    } catch {
      return undefined;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Bounded fullscreen settle timer (§2.3).
  // ───────────────────────────────────────────────────────────────────────────

  private armFullscreenSettle(id: number): void {
    this.clearFullscreenSettle(id);
    this.fullscreenSettleTimers.set(
      id,
      setTimeout(() => {
        this.fullscreenSettleTimers.delete(id);
        this.pump({ type: 'FULLSCREEN_SETTLE_TIMEOUT', id });
      }, FULLSCREEN_SETTLE_TIMEOUT_MS),
    );
  }

  private clearFullscreenSettle(id: number): void {
    const t = this.fullscreenSettleTimers.get(id);
    if (t) {
      clearTimeout(t);
      this.fullscreenSettleTimers.delete(id);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Transition log (§5.3) — one DEBUG-gated line per transition. The PERMANENT
  // replacement for the ad-hoc fsDiag / [esc] / [focus-tracker] traces (those old
  // traces are deleted in their own seam slices, not here).
  // Format: `[window-state] EVENT … front a→b mode(id) x→y`.
  // ───────────────────────────────────────────────────────────────────────────

  private logTransition(event: WindowEvent, before: StateSnapshot, after: StateSnapshot): void {
    if (!DEBUG) return;
    let line = `[window-state] ${event.type} front ${fmt(before.front)}→${fmt(after.front)}`;
    for (const part of modeDeltas(before, after)) line += ` ${part}`;
    console.log(line);
  }
}

/** Render a nullable id for the transition log. */
function fmt(id: number | null): string {
  return id == null ? 'none' : String(id);
}

/** `mode(id) x→y` fragments for every window whose fsMode name changed. */
function modeDeltas(before: StateSnapshot, after: StateSnapshot): string[] {
  const beforeById = new Map(before.windows.map((w) => [w.id, w.fsMode.name]));
  const parts: string[] = [];
  for (const w of after.windows) {
    const prev = beforeById.get(w.id);
    if (prev !== undefined && prev !== w.fsMode.name) {
      parts.push(`mode(${w.id}) ${prev}→${w.fsMode.name}`);
    }
  }
  return parts;
}
