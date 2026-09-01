/**
 * electron-window-backend.ts — the Electron implementation of the
 * `WindowBackend` port (design §3, rule R3).
 *
 * Blueprint: `docs/design/window-manager.md`. THIS IS THE ONLY WINDOW-MANAGER
 * MODULE THAT IMPORTS ELECTRON. The executor (`window-kernel-executor.ts`)
 * issues port commands; this backend performs them against the native handles it
 * retains, and pushes native reality straight into the kernel
 * (`window-kernel-dispatch.ts kernel*`) at each native-event call site —
 * the only remaining machine. It never dispatches into a reducer itself.
 *
 * It is also the sole authority on window identity (§3): `registerWindow`
 * mints every `WindowId` ("wm-N", idempotent per native window), and the
 * private `idByOsWindowId` map is the only `WindowId` ↔ Electron translation
 * in the tree. The platform's numeric id space never crosses this file's
 * surface except through the comment-annotated migration shims below.
 *
 * Two OS/Chromium boundary workarounds live here (and NOWHERE else — the
 * reducer has no timers, and the executor no longer touches the boundary),
 * each commented at its site:
 *   - the ONE deferred-blur settle that emits `OS_FOCUS_SETTLED_NULL` (§4.4);
 *   - the bounded fullscreen settle timer that emits `FULLSCREEN_SETTLE_TIMEOUT`
 *     (§2.3) so a stuck `entering`/`leaving` mode self-corrects via `reconcile`.
 *
 * Headless gating: focus/activation side effects are gated on `isHeadless()` —
 * the SAME predicate `hybridShowIntent` (windows.ts) encodes — so an agent/CI
 * run never steals the user's OS focus (peek 2b55f3af). Since §5 step 6A-2
 * the SHOW policy itself (opacity-0-before-show, show() vs showInactive(),
 * the page-host headless/panel masks) lives HERE (`performOsShow` +
 * `showWindow`): the windows.ts show seams are thin dispatchers into the
 * machine, and this backend echoes `WINDOW_SHOWN` for the shows it performs
 * (`showInactive` emits no native `'show'` event, and headless runs take no
 * real OS focus by design). That echo carries the caller's UNMASKED activation
 * intent (`WINDOW_SHOWN {focused: activate}`), and the reducer routes a focused
 * `WINDOW_SHOWN` through the same `applyFocusGained` an `OS_FOCUS_GAINED` uses
 * — so `front` and `focusSeq` still move under headless without anyone
 * synthesizing a focus event.
 *
 * NEITHER `showWindow` NOR `raiseWindow` ever emits `OS_FOCUS_GAINED` for a
 * show it performed. That event means "the OS moved focus", and it is the ONLY
 * event that runs the transient-autoclose sweep (`window-kernel.ts
 * selectTransientAutoclose`). Emitting it for a show
 * this backend drove would feed the machine's own decision back in as fresh OS
 * evidence, and would sweep a live palette/quick-view out from under a show
 * that never meant to touch it — a headless show that arrives late enough
 * dismisses a palette opened AFTER the show was requested. `OS_FOCUS_GAINED`
 * has exactly two producers here, both genuine native reports: the host
 * window's `'focus'` and the page-host content WC's `'focus'`.
 *
 * Those two producers are also the sole source of focus PROVENANCE (peek
 * 7fffa286): a native focus report cannot say whether the user switched windows
 * or the OS is echoing a call this backend just made, but the backend itself
 * knows — so it arms `pendingSelfCausedFocus` before every focus-moving native
 * call and stamps the resulting event `cause: { kind: 'machine', opSeq }`.
 * Anything arriving unarmed is `world`. That per-window arming is executor
 * state, deliberately: the reducer may keep no such thing (it used to infer the
 * fact from record history and got the machine's own handoff-raise echo wrong).
 */

import { app, globalShortcut, screen, systemPreferences, webContents } from 'electron';
import type { BrowserWindow, WebContents } from 'electron';

import { isHeadless, DEBUG } from './config.js';
import {
  askWebContentsToHandleEscape,
  closeOrHideWindow,
  addEscHandler,
} from './windows.js';
// `window-machine.js` value-imports THIS file directly (for the default
// `ElectronWindowBackend` construction) — a real module cycle, already
// tolerated one hop over via the `windows.js` import just above (which
// imports `window-machine.js` itself). Safe here for the same reason it is
// safe there: `dispatchEscapePress` is called only from inside
// `escGrabHandler`'s closure body, never at this module's top level, so it
// is never read before the cycle finishes resolving.
import { dispatchEscapePress } from './window-machine.js';
import { getGuestsForWindow, getAllGuestWebContentsIds } from './webview-guest-registry.js';
import { getIzuiCoordinator } from './izui-state.js';
import {
  shouldCloseContentWCOnFinalize,
  decideWindowRegistration,
  type WindowClass,
  type StackingLevel,
  type WindowRegistrationDecision,
} from './izui-roles.js';
import type { DesktopMembership, FocusCause, WindowId, WindowKind, Rectangle } from './window-kernel.js';
import type { WindowBackend, WindowSpec } from './window-backend.js';
import {
  destroyGuestsAndWait,
  QUIT_GUEST_TEARDOWN_BUDGET_MS,
  type TeardownGuest,
} from './guest-teardown.js';
import { expandToOverlayFrame } from './overlay-frame.js';
import { wmLog } from './window-diag.js';
import { FULLSCREEN_SETTLE_TIMEOUT_MS } from './window-kernel.js';
import {
  getKernelExecutor,
  kernelOsFocusGained,
  kernelOsFocusSettled,
  kernelWindowClosed,
  kernelWindowShown,
  kernelWindowHidden,
  kernelAppActivated,
  kernelAppResigned,
  kernelAppResignSettled,
  kernelContentFirstResponderChanged,
  kernelOsFullscreenEntered,
  kernelOsFullscreenLeft,
  kernelFullscreenSettleTimeout,
  kernelBoundsChanged,
  kernelOverlayAttached,
  kernelCloseOrHideRequested,
} from './window-kernel-dispatch.js';

/**
 * The one place `webContents.destroy()` is actually called. `guest-teardown.ts`
 * owns the bounded WAIT and stays platform-free by taking this as a callback,
 * which also keeps the destroy inside the backend (rule R2).
 *
 * Forceful (immediate, skips beforeunload) is what both callers want — the
 * guarantee is "the guest is gone", not "the guest was asked nicely".
 * `destroy()` exists at runtime but isn't in the Electron type defs.
 */
function requestGuestDestroy(guest: TeardownGuest): void {
  (guest as unknown as { destroy(): void }).destroy();
}

// Bounded wait for the native fullscreen transition to settle, matching the
// pre-machine owner (`hybrid-page-host-registry.ts HYBRID_FULLSCREEN_SETTLE_TIMEOUT_MS`).
// The AppKit enter/leave-fullscreen animation runs ~600ms; this leaves margin so
// a destroyed / no-op window (which never emits the settled event) can't strand
// the machine in `entering`/`leaving` forever — the timer emits
// FULLSCREEN_SETTLE_TIMEOUT, whose reducer clause emits RECONCILE_FULLSCREEN.
// The bound itself lives in `window-kernel.ts FULLSCREEN_SETTLE_TIMEOUT_MS`
// (electron-free, shared with the kernel executor) since this file cannot be
// imported for its values without pulling `electron` into the executor.

/**
 * How long after a `did-resign-active` we declare the app switch REAL
 * (`APP_RESIGN_SETTLED`). Same 500ms the deleted `ipc.ts
 * HYBRID_APP_RESIGN_SETTLE_MS` used.
 *
 * macOS fires a brief `did-resign-active` → `did-become-active` DANCE (no real
 * app switch) during window restoration at startup and around overlay /
 * activation transitions, and there is NO deterministic OS signal for "the
 * dance is over" — the only in-process alternative, the deferred-blur settle
 * that emits `OS_FOCUS_SETTLED_NULL`, fires within a tick and so lands INSIDE
 * the dance. A settle interval is therefore irreducible, and per §3 it belongs
 * at the OS boundary (this file), alongside the other two boundary
 * workarounds. What is NOT here is the DECISION: the reducer's
 * `pendingAppResignSweep` (armed by `APP_RESIGNED`, disarmed by
 * `APP_ACTIVATED`) is the sole cancel authority, so this timer only says
 * "500ms elapsed", never "sweep".
 */
const APP_RESIGN_SETTLE_MS = 500;

/**
 * Whether this platform's z-raise primitive also moves OS focus.
 *
 * A stacking call declares NO intention about focus — `setStacking` asks for
 * relative z order and nothing else. But off darwin the primitives that realize
 * it (`moveTop()`, `setAlwaysOnTop(true, 'floating')`) activate the window as a
 * side effect, and that focus is THIS BACKEND'S OWN doing, not evidence about
 * the world — so it must not be fed back to the machine as an OS focus event
 * (see `raiseWindow`'s docblock for the principle, and the `'focus'` listener
 * for the suppression).
 *
 * On macOS `moveTop()` genuinely reorders without activating or taking key, so
 * the suppression is inert there and this stays `false`.
 */
const STACKING_TAKES_FOCUS = process.platform !== 'darwin';

/**
 * The structural minimum of a native window this backend drives. Both
 * `BaseWindow` (page-host) and `BrowserWindow` (browser) satisfy it — a
 * BaseWindow is NOT a BrowserWindow (no root `.webContents`), so we keep the
 * per-kind divergence (content WC, raise seam) explicit rather than casting one
 * to the other. Every method here exists on BOTH kinds in Electron 40.
 */
export interface NativeWindow {
  id: number;
  isDestroyed(): boolean;
  isFocused(): boolean;
  isVisible(): boolean;
  isFullScreen(): boolean;
  setFullScreen(flag: boolean): void;
  close(): void;
  destroy(): void;
  hide(): void;
  /** Show, activating (app frontmost + key window). */
  show(): void;
  /** Show without activating (focus-preserving). */
  showInactive(): void;
  /** Window opacity — the headless opacity-0-before-show trick (`performOsShow`). */
  setOpacity(opacity: number): void;
  setAlwaysOnTop(flag: boolean, level?: 'normal' | 'floating'): void;
  /** Relative z-raise without activation (the `setStacking` command). On both kinds in Electron 40. */
  moveTop(): void;
  /** Outer-bounds write (the `setWindowBounds` command — §5 step 7). On both kinds in Electron 40. */
  setBounds(bounds: Rectangle): void;
  /**
   * macOS Spaces pin (the `setDesktopMembership` command — §5 step 10).
   * On both kinds in Electron 40; a no-op off darwin, which is why the
   * backend guards the platform before calling it at all.
   */
  setVisibleOnAllWorkspaces(
    visible: boolean,
    options?: { visibleOnFullScreen?: boolean; skipTransformProcessType?: boolean },
  ): void;
  /** Click-through toggle (the `setAcceptsInput` command). On both kinds in Electron 40. */
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void;
  /**
   * Outer-bounds read — used ONLY inside the resize/move listeners to build
   * the `BOUNDS_CHANGED` emission (§2.5's sanctioned pattern: the backend
   * reads reality once, internally, and pushes it as an event; nothing else
   * may read it).
   */
  getBounds(): Rectangle;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

/**
 * The structural minimum of the renderer WebContents this backend drives
 * (same proto-abstraction move as `NativeWindow`, so `RegisterWindowSpec`
 * carries no Electron type). Cast back to the real `WebContents` only at the
 * windows.ts seam calls inside this file.
 */
export interface NativeWebContents {
  isDestroyed(): boolean;
  focus(): void;
  close(): void;
  getURL(): string;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

/**
 * A post-hoc registration spec: the platform-neutral `WindowSpec` plus the
 * native handles of a window that already exists. Input to the
 * `registerWindow` migration shim below — the eventual `create(spec)` port
 * command (§5 step 4) replaces the handle-carrying half.
 */
export interface RegisterWindowSpec extends WindowSpec {
  /** The native window handle (BaseWindow for page-host, BrowserWindow for browser). */
  win: NativeWindow;
  /**
   * The renderer WebContents: the content view's WC for a page-host, the root
   * WC for a browser. Used for `ASK_RENDERER` and (page-host only) `FOCUS_CONTENT`.
   */
  contentWC?: NativeWebContents | null;
}

/** What `registerWindow` hands back to the executor: the (minted or existing) id plus the registration decision whose pump/esc-attach halves the EXECUTOR performs. */
export interface BackendRegistration {
  id: WindowId;
  decision: WindowRegistrationDecision;
  /**
   * The window's outer bounds, read ONCE at registration (§5 step 7B) — the
   * executor carries it on the pumped `WINDOW_REGISTERED` to seed the
   * reducer's bounds mirror (a ctor-placed window fires no native
   * resize/move, so `BOUNDS_CHANGED` alone leaves the mirror empty until the
   * first gesture). `null` when the read failed (window destroyed mid-call).
   */
  initialBounds: Rectangle | null;
}

/**
 * MIGRATION SHIMS — the handle-speaking surface that exists only until later
 * migration steps absorb its callers. Deliberately OUTSIDE `WindowBackend`:
 * no port method may accept or return a platform handle (§3), so the executor
 * types its backend as `WindowBackend & BackendMigrationShims` and the
 * intersection is exactly what future steps delete.
 *
 *   - `registerWindow` (post-hoc join of an already-created native window):
 *     absorbed when window CREATION moves behind the port — §5 step 4
 *     (special window classes + registry unification) introduces
 *     `create(spec)` and retires handle-carrying registration. Callers today:
 *     `window-machine.ts registerWindowWithMachine` (ipc.ts /
 *     tile-launcher / hybrid-overlay open sites).
 *   - `getWindowIdFor` / `getNativeWindowFor` (the numeric-id ↔ handle seam):
 *     absorbed when the renderer-facing id economy flips to `WindowId` — the
 *     session/context-store step (§5 step 11, per the §3 scope decision) —
 *     and the legacy Electron-keyed registries they join against are re-keyed
 *     (§5 steps 4–8). Callers today: `window-machine.ts` only.
 */
export interface BackendMigrationShims {
  registerWindow(spec: RegisterWindowSpec): BackendRegistration;
  getWindowIdFor(winOrOsId: NativeWindow | number): WindowId | null;
  getNativeWindowFor(id: WindowId): NativeWindow | null;
}

/** What the backend retains per registered window to execute commands against it. */
interface BackendWindow {
  win: NativeWindow;
  kind: WindowKind;
  /**
   * The window's declared class (§4.3 dim 8b), retained for the show policy:
   * a `quick-view`-class page-host is a `type:'panel'` NSPanel that must
   * NEVER activate the app on show (regression 524f7aba) — see `showWindow`.
   */
  windowClass: WindowClass;
  /**
   * The renderer WebContents that answers the `escape-pressed` IPC and is the
   * macOS first responder: the content `WebContentsView`'s WC for a page-host,
   * the root WC for a browser window. `null` if the caller supplied none.
   */
  rendererWC: NativeWebContents | null;
}

/**
 * The Electron backend. Holds native handles + the WindowId mint, performs
 * port commands, feeds native events straight to the kernel.
 */
export class ElectronWindowBackend implements WindowBackend, BackendMigrationShims {

  /** Native handles + renderer WC per registered WM WindowId (for command execution). */
  private readonly windows = new Map<WindowId, BackendWindow>();

  /**
   * Reverse lookup: platform (Electron) window id → WM WindowId. PRIVATE — the
   * platform's numeric ids exist only inside this file's maps and never cross
   * its surface (design §3: the backend maps `WindowId -> platform handle`
   * internally and never leaks the handle's id space).
   */
  private readonly idByOsWindowId = new Map<number, WindowId>();

  /** WM-internal mint counter for `WindowId` ("wm-1", "wm-2", …). */
  private windowIdCounter = 0;

  /** The ONE deferred-blur settle handle (§4.4) — coalesced, at most one pending. */
  private pendingBlurSettle: ReturnType<typeof setImmediate> | null = null;

  /**
   * "I am expecting a self-caused focus on this window, from op N" — the op
   * token (`window-kernel.ts Effect.opSeq`) of the last focus-family command this
   * backend performed on each window, still awaiting its native `'focus'`.
   *
   * This is the ONLY honest source of focus provenance (`FocusCause`), and it
   * belongs HERE: the executor knows which native call it just made; the reducer
   * cannot know and must not guess (it used to guess, from a pair of per-record
   * booleans, and got the machine's own handoff-raise echo wrong — peek
   * 7fffa286). State in the backend, never in the reducer.
   *
   * Lifecycle, all three edges deliberate:
   *   - ARMED by `armSelfCausedFocus`, immediately before a native call that can
   *     move OS focus (an ACTIVATING show, a raise, a content focus). A second
   *     op on the same window overwrites the token — the latest op is the one
   *     whose echo is in flight, and an older token surviving would label that
   *     echo stale.
   *   - CONSUMED (one shot) by `takeFocusCause` in the `'focus'` listeners.
   *   - DROPPED on the window's own `blur` and `closed`: focus went somewhere
   *     else, so whatever arrives next is a NEW event and not our echo. Without
   *     this a never-echoed arming (a `focus()` on a window that already held
   *     first responder emits no event) would sit there and mislabel the user's
   *     next genuine focus as machine-caused — the exact failure mode that makes
   *     a token safer than a bare boolean.
   */
  private readonly pendingSelfCausedFocus = new Map<WindowId, number>();

  /**
   * Windows whose next native `'focus'` is the side effect of a stacking call
   * this backend just made, on a platform where the z-raise primitive takes
   * focus (`STACKING_TAKES_FOCUS`). Such a focus is not evidence about the
   * world and is DROPPED rather than translated into an event.
   *
   * A Set, not a Map: a stacking call carries no op token to label the focus
   * with, because it never asked for focus at all.
   *
   * Lifecycle, all four edges deliberate:
   *   - ARMED per window by `setStacking`, immediately before the native
   *     z-raise, and only where that primitive actually takes focus.
   *   - CONSUMED in the window's `'focus'` listener, which suppresses the event
   *     unless `pendingSelfCausedFocus` also armed it — a focus-family command
   *     genuinely asked for that one, so it still reports. The WHOLE set is then
   *     dropped, by the first native `'focus'` on ANY window and whether or not
   *     that focus was suppressed: a stacking batch re-asserts the order by
   *     calling `setStacking` for every window in it, but the platform provokes
   *     AT MOST ONE focus for the batch, so once any focus has arrived the
   *     remaining armings are stale. Leaving them would swallow the next genuine
   *     focus on each of those windows.
   *   - DROPPED on the window's own `blur` and `closed`, for the same reason
   *     `pendingSelfCausedFocus` is: focus went elsewhere, so whatever arrives
   *     next is a new event and not our side effect.
   *   - DROPPED by `armSelfCausedFocus`: a real focus-family command supersedes
   *     an outstanding stacking arming, so a never-consumed one cannot swallow
   *     the focus that command is about to provoke.
   *
   * Residual risk, stated plainly: if the platform provokes NO focus at all for
   * a batch, the armings survive until the next focus of ANY kind, and that one
   * focus is suppressed even if it was genuine.
   */
  private readonly pendingStackingFocus = new Set<WindowId>();
  /**
   * Armed by `hideWindow`, consumed by the next `'focus'` — the hide half of the
   * same principle `pendingStackingFocus` states for stacking: hiding the window
   * that holds focus makes the platform hand focus to SOME other window, and the
   * machine asked to hide, never to focus. Unlike stacking, the platform picks
   * the recipient, so there is no id to arm — the arming is the ACT, and the one
   * focus the platform provokes for it consumes it. A machine-armed focus still
   * reports (`cause.kind === 'machine'`): a focus-family command asked for that
   * one.
   */
  private pendingHideProvokedFocus = false;

  /**
   * "I am expecting this window's next native `'show'`/`'hide'` to be MY
   * doing, from op N" — the visibility-echo counterpart of
   * `pendingSelfCausedFocus`, one map per direction because a show and a hide
   * are never the same op and must never label each other's echo.
   *
   * ARMED immediately before the native call that can provoke it
   * (`performOsShow` for `pendingShowOpSeq`, `hideWindow` for
   * `pendingHideOpSeq`), CONSUMED (one shot) by the matching `win.on('show')`
   * / `win.on('hide')` listener once its own ground-truth check passes, and
   * threaded onto the `WINDOW_SHOWN`/`WINDOW_HIDDEN` echo those listeners
   * emit so `window-kernel.ts isStaleWindowEcho` can tell a stale echo of a
   * superseded op apart from a genuine one.
   *
   * WHY THE EAGER SYNTHETIC ECHO (`performOsShow`'s and `hideWindow`'s own
   * `kernelWindowShown`/`kernelWindowHidden` calls) is not enough
   * on its own: on this backend a `BaseWindow`'s native `'show'`/`'hide'` can
   * fire before the call that provoked it even returns — same tick, ahead of
   * the synchronous echo below it in program order — so an
   * `AttachOverlayTo`/`HideWindow` pair racing for the same window (the
   * overlay-retarget hang, `hybrid-close-two-hosts-hang.spec.ts`) queues an
   * UNLABELLED native echo before the labelled synthetic one, and an
   * unlabelled event can never be judged stale (`opSeq === undefined` always
   * passes `isStaleWindowEcho`). Without this arming that native echo is what
   * kept the ping-pong fed even after the synthetic echo alone was tagged.
   */
  private readonly pendingShowOpSeq = new Map<WindowId, number>();
  private readonly pendingHideOpSeq = new Map<WindowId, number>();

  /**
   * "My own `closeWindow` is mid-call on this window and its `win.close()`
   * is about to fire" — the close-family counterpart of `pendingShowOpSeq`.
   * A native `'close'` normally means the OS or the user asked to close the
   * window (a red-button click, an OS-level Cmd+W), and the `'close'`
   * listener vetoes it and hands the decision to the kernel
   * (`kernelCloseOrHideRequested`) so `decide()` can resolve keepLive to a
   * hide. But the kernel's OWN `CloseWindow`/`CloseWindowDirect` effects are
   * realized by THIS backend calling `win.close()` right back (`closeWindow`
   * below) — without a way to tell that apart, the listener would veto its
   * own close and hand it back to the kernel forever.
   *
   * No token needed (unlike `pendingShowOpSeq`): a close is terminal, so
   * there is nothing later to distinguish a stale arming from a fresh one —
   * only HOW MANY are outstanding. A count, not a one-shot flag: `closeWindow`
   * has two suspension points ahead of its `win.close()` call
   * (`exitFullscreenBeforeClose`, and `destroyGuestsAndWait` inside
   * `destroyGuestsThenClose`), and two distinct commands reach it
   * (`CloseWindow` from the membership diff, `CloseWindowDirect` from
   * `windows.ts closeHostWindow` / `ipc.ts`'s content-`destroyed` handler) —
   * so two overlapping `closeWindow` calls for the SAME window are a real
   * shape, each arming independently and each expecting its own `win.close()`
   * to be recognized as its own. A one-shot Set collapses two overlapping
   * armings into one: if the first `win.close()` is then vetoed downstream
   * (e.g. by the OS), the second's `'close'` arrives with nothing armed, is
   * read as fresh evidence, and gets handed to a kernel record that may
   * already be gone. A counter fixes this by construction: each arm
   * increments, each native `'close'` this triggers decrements one (deleting
   * the entry at zero) — so N overlapping arms always consume exactly N
   * native closes, with no way for a count to go negative or for one arm to
   * leak into unrelated close traffic.
   *
   * ARMED immediately before each `win.close()` call `closeWindow` makes,
   * CONSUMED one increment per native `'close'` on that window — see
   * `armMachineClose` / `consumeMachineCloseArm`. Cleared entirely (whatever
   * the remaining count) on `win.on('closed')`, same as before: an arm
   * cannot outlive its window.
   */
  private readonly pendingMachineClose = new Map<WindowId, number>();

  /** ARM one outstanding machine-initiated close for `id` — see `pendingMachineClose`. */
  private armMachineClose(id: WindowId): void {
    this.pendingMachineClose.set(id, (this.pendingMachineClose.get(id) ?? 0) + 1);
  }

  /**
   * CONSUME one outstanding machine-initiated close for `id`, if any —
   * `true` when a native `'close'` should be treated as this backend's own
   * doing (the caller then skips the veto), `false` when none was armed and
   * the close is genuine OS/user evidence. See `pendingMachineClose`.
   */
  private consumeMachineCloseArm(id: WindowId): boolean {
    const count = this.pendingMachineClose.get(id);
    if (!count) return false;
    if (count > 1) this.pendingMachineClose.set(id, count - 1);
    else this.pendingMachineClose.delete(id);
    return true;
  }

  /**
   * True while a quit attempt is genuinely under way. Every window the OS is
   * about to tear down as part of quit fires a native `'close'` exactly like
   * a user-initiated one, and that close must reach `win.close()` for real —
   * vetoing it and asking the kernel would leave `entry.ts`'s deferred
   * quit-cleanup sequence (`izui-roles.ts planBeforeQuit`) waiting on windows
   * that never finish closing, hanging the quit.
   *
   * SET by `before-quit`, which always fires — vetoed or not — strictly
   * before Electron ever begins closing windows for that attempt, so by the
   * time any window's `'close'` fires as part of an actual (non-vetoed) quit
   * pass this is already true.
   *
   * CLEARED by `will-quit` and (belt-and-suspenders) `quit`: `will-quit`
   * fires only once every window is ALREADY closed for that attempt (Electron
   * docs), so no window can still be mid-close when this flips back to
   * false — clearing here can never unveto a close that quit itself is
   * driving. A `before-quit` vetoed immediately (nothing closed yet, the
   * `entry.ts` deferred-cleanup-and-requeue dance) never reaches `will-quit`
   * either, so the flag simply stays latched true across that gap, exactly
   * as harmless as before — the requeued `app.quit()` fires `before-quit`
   * again before anything relies on the flag being false.
   *
   * ALSO CLEARED on a quit cancelled at a `beforeunload` prompt, via
   * `quitPromptPending` — see that field. Electron fires no app-level event
   * for that outcome, so without it this flag latched true for the rest of
   * the session and every later native close bypassed the kernel.
   */
  private quitting = false;

  /**
   * Windows whose content is showing a `beforeunload` prompt raised by a quit
   * that is already under way (`quitting === true`).
   *
   * The gap this closes: a window can cancel `app.quit()` from its own
   * `beforeunload` handler, and Electron reports that outcome with NO event.
   * `will-quit` and `quit` never fire, and the cancelling window's `'close'`
   * does not either — the cancellation happens inside `win.close()`, ahead of
   * the native event. So a quit that got past `before-quit` and into actually
   * closing windows, then died at one prompt, stranded `quitting` true with no
   * remaining edge to clear it.
   *
   * `will-prevent-unload` IS the edge that exists (`entry.ts`'s headless guard
   * uses the same hook for the opposite purpose — suppressing the prompt
   * outright). It fires before the prompt is shown, which is one step too
   * early to know the answer, so this records the question and the answer is
   * read off the two native edges that distinguish the outcomes:
   *
   *   - the window CLOSES (`'closed'`) — the user chose to leave, the quit is
   *     proceeding, and the latch must stay exactly as it is. Just drop the
   *     record.
   *   - the window takes FOCUS (`'focus'`) while still recorded — the prompt
   *     was dismissed and key status went back to the window rather than the
   *     window going away, which is the cancel. Drop the record AND clear the
   *     latch, so the next native close reaches the kernel again.
   *
   * Deliberately never calls `preventDefault()`: the prompt belongs to the
   * page and the answer to the user. This only watches.
   *
   * UNVERIFIED — needs a real prompt, a display and a person to answer it.
   * The close arm is the ordinary path; the focus arm rests on macOS
   * returning key status to the window when the sheet dismisses.
   */
  private readonly quitPromptPending = new Set<WindowId>();

  /** Per-window bounded fullscreen settle timers (§2.3). */
  private readonly fullscreenSettleTimers = new Map<WindowId, ReturnType<typeof setTimeout>>();

  /** The app-resign settle handle (§5 step 9) — at most one, restarted per resign edge. */
  private appResignSettleTimer: ReturnType<typeof setTimeout> | null = null;

  /** Whether we currently hold the OS Escape grab (real state incl. failed register — see `setEscGrab`). */
  private escGrabRegistered = false;

  /** Stable handler reference so register/unregister target the same closure. */
  private readonly escGrabHandler = (): void => {
    // The grab reaches the SAME decision (`window-escape.ts interpretEscape`,
    // via `dispatchEscapePress`) the before-input-event path does — a stale
    // grab is harmless (defense by shared decision, not by registration
    // timing, §4.2).
    //
    // No `rendererHandled` fact to read here (window-escape-renderer-handled.ts
    // / peek 7fffa286 companion): `globalShortcut` firing at all means
    // `before-input-event` did NOT — no window's WebContents ever saw this
    // keystroke, so no renderer could have consumed it. Absent is the
    // structurally correct answer at this ONE of the four dispatch sites, not
    // a gap in the producer.
    dispatchEscapePress('global', 'electron-window-backend.escGrabHandler');
  };


  // ───────────────────────────────────────────────────────────────────────────
  // Port: app-level listeners.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * App-level focus listeners → `APP_ACTIVATED`/`APP_RESIGNED`, plus the
   * `APP_RESIGN_SETTLED` edge the transient app-switch sweep runs on (§5 step
   * 9). `APP_ACTIVATED` makes the reducer emit `RECONCILE_FULLSCREEN` for any
   * in-flight transition (§2.5).
   *
   * The settle timer is restarted on every resign edge (so only the LATEST
   * resign can settle) and is deliberately NOT cancelled on `did-become-active`:
   * cancelling would put a second copy of the dance-cancel decision here, and
   * the reducer's `pendingAppResignSweep` disarm already makes a late
   * `APP_RESIGN_SETTLED` inert.
   *
   * Also the macOS Space-change subscription → `SPACE_CHANGED` (§4.2 dim 7c,
   * §5 step 10): the workspace notification is the only signal that the user
   * moved to another Space. Like the two `app` listeners it is attached once
   * at boot and never removed — the app-level listener set lives as long as
   * the process.
   */
  attachAppListeners(): void {
    // Latches `quitting` true (see that field's doc for the full set/clear
    // story, including what a beforeunload-cancelled quit still misses).
    (app as unknown as { on(e: string, l: () => void): void }).on('before-quit', () => {
      this.quitting = true;
      // A fresh attempt: no prompt of this one is outstanding yet, and a
      // record left over from a previous attempt would answer for it.
      this.quitPromptPending.clear();
    });
    // `will-quit` fires only once every window this attempt was closing is
    // already gone — see `quitting`'s doc for why that makes clearing here
    // safe. `quit` is a belt-and-suspenders second clear on the same field
    // for the same reason, in case something one day vetoes `will-quit`.
    (app as unknown as { on(e: string, l: () => void): void }).on('will-quit', () => {
      this.quitting = false;
      this.quitPromptPending.clear();
    });
    (app as unknown as { on(e: string, l: () => void): void }).on('quit', () => {
      this.quitting = false;
      this.quitPromptPending.clear();
    });
    (app as unknown as { on(e: string, l: () => void): void }).on('did-become-active', () => {
      // Feeds the kernel (window-kernel-dispatch.ts), which drives the real
      // window operations post-cutover — see that module's header.
      kernelAppActivated();
    });
    (app as unknown as { on(e: string, l: () => void): void }).on('did-resign-active', () => {
      // Feeds the kernel (window-kernel-dispatch.ts), which drives the real
      // window operations post-cutover — see that module's header.
      kernelAppResigned();
      if (this.appResignSettleTimer) clearTimeout(this.appResignSettleTimer);
      this.appResignSettleTimer = setTimeout(() => {
        this.appResignSettleTimer = null;
        // Carried over VERBATIM from the deleted `ipc.ts
        // doCloseTransientHybridWindows` head: a resign fired by an izui
        // overlay entry/exit transition is activation churn, not an app
        // switch, so the settle point never arrives for it. The coordinator's
        // cooldowns are the only signal for that churn and the reducer does
        // not model them (§5 step 9 explicitly left them unmodelled), so the
        // read stays at the producer — suppressing the EDGE, never deciding
        // the sweep. Re-home it when the overlay cooldown becomes machine
        // state.
        const coordinator = getIzuiCoordinator();
        if (coordinator.isWithinOverlayExitCooldown() || coordinator.isWithinOverlayEntryCooldown()) {
          DEBUG && console.log('[wm-backend] app-resign settle suppressed (izui overlay cooldown)');
          return;
        }
        // Feeds the kernel — same containment as above. The cooldown read
        // itself stays at the producer (see `window-kernel-dispatch.ts
        // kernelAppResignSettled` for the backstop this settle now
        // performs — the primary hide already ran on the raw `AppResigned`
        // edge).
        kernelAppResignSettled();
      }, APP_RESIGN_SETTLE_MS);
    });
    this.attachSpaceChangeListener();
  }

  /**
   * The macOS Space switch → `SPACE_CHANGED`. Darwin-only: Spaces exist
   * nowhere else and `subscribeWorkspaceNotification` is a macOS-only method,
   * so this is a no-op on every other platform.
   *
   * The notification's `userInfo` is EMPTY — verified live on this app — so
   * there is nothing to put on the event and no way to name the Space we
   * moved to. No machine consumes this today (the old reducer's own
   * `SPACE_CHANGED` clause was a documented no-op, and the kernel has no
   * counterpart), but the transition is real and can move or hide windows on
   * its own, so it is logged rather than dropped silently — the always-on
   * `wmLog` line is where a consumer would attach if one is ever needed, and
   * in the meantime it keeps the signal readable when a window's movement on
   * a Space switch needs investigating.
   */
  private attachSpaceChangeListener(): void {
    if (process.platform !== 'darwin') return;
    systemPreferences.subscribeWorkspaceNotification(
      'NSWorkspaceActiveSpaceDidChangeNotification',
      () => {
        wmLog('space-changed');
      },
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Migration shims (see `BackendMigrationShims` for the absorption plan).
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * MIGRATION SHIM — post-hoc join (see `BackendMigrationShims`): mint (or
   * resolve) the `WindowId` for an already-created native window, retain its
   * handles, and attach the per-window native listeners exactly once.
   *
   * IDEMPOTENT per underlying native window (the WindowId is MINTED here, so
   * idempotency is keyed by the platform window handle), and that is
   * load-bearing: more than one call site registers the same BrowserWindow
   * (the tile-launcher hook inside `createTileBrowserWindow`, then the
   * `ipc.ts` window-open site for the same window). Re-attaching would give
   * one physical Escape TWO `ESC_PRESSED` dispatches — and the second one,
   * arriving after the switcher already closed, re-opened it 500ms later in
   * an unbreakable loop. So a repeat registration MERGES the (richer) spec
   * and leaves listeners alone.
   *
   * The branch itself is NOT decided here: `decideWindowRegistration`
   * (`izui-roles.ts`) owns it, so it stays unit-testable away from this
   * file's value-side `electron` import (unloadable under the unit gate's
   * `ELECTRON_RUN_AS_NODE=1`). This method executes the decision's
   * BACKEND half (merge + native-listener attach) and returns the decision;
   * the caller (`window-machine.ts registerWindowWithMachine`) performs the
   * pump + Esc-attach half — it stays the one dispatch owner.
   */
  registerWindow(spec: RegisterWindowSpec): BackendRegistration {
    const { kind, win } = spec;
    const rendererWC = spec.contentWC ?? null;

    // The WM MINTS the id — it never arrives from outside. Idempotency is
    // therefore keyed by the UNDERLYING platform window: the same
    // BrowserWindow/BaseWindow registered twice resolves to the SAME WindowId,
    // with the later (richer) spec merged in.
    const osWindowId = win.id;
    const existingId = this.idByOsWindowId.get(osWindowId);
    const existing = existingId === undefined ? undefined : this.windows.get(existingId);
    const decision = decideWindowRegistration({
      alreadyRegistered: existing !== undefined,
      kind,
      hasContentWC: spec.contentWC !== undefined,
      attachEscHandlerRequested: spec.attachEscHandler,
      nativeVisible: this.isVisibleSafe(win),
    });

    let id: WindowId;
    if (existing !== undefined && existingId !== undefined) {
      id = existingId;
      existing.win = win;
      existing.kind = kind;
      existing.windowClass = spec.class;
      if (decision.adoptRendererWC) existing.rendererWC = rendererWC;
    } else {
      this.windowIdCounter += 1;
      id = `wm-${this.windowIdCounter}` as WindowId;
      this.idByOsWindowId.set(osWindowId, id);
      this.windows.set(id, { win, kind, windowClass: spec.class, rendererWC });
    }

    if (decision.attachNativeListeners) {
      this.attachNativeListeners(id, osWindowId, win, kind, rendererWC);
    }

    // One boundary read (same pattern as `nativeVisible` above) — seeds the
    // reducer's bounds mirror via the executor's WINDOW_REGISTERED pump.
    let initialBounds: Rectangle | null = null;
    try {
      if (!win.isDestroyed()) initialBounds = win.getBounds();
    } catch {
      /* window gone mid-registration — no rect to seed */
    }

    // Identity log: ties this wm-N to the platform window + a best-effort URL
    // so a later log line naming only `id` can be read as evidence about
    // WHICH window did something. Fires on both the mint and merge branches —
    // registration is idempotent and the second call (richer spec) is often
    // where a real URL first becomes available (the first may still be
    // about:blank pre-`loadURL`).
    DEBUG &&
      console.log(
        '[window-backend] registerWindow',
        id,
        'osWindowId',
        osWindowId,
        'kind',
        kind,
        'class',
        spec.class,
        'url',
        this.urlSafe(rendererWC),
      );

    return { id, decision, initialBounds };
  }

  /**
   * MIGRATION SHIM (see `BackendMigrationShims`): the WM WindowId for a
   * registered native window (or a platform window id a legacy Electron-keyed
   * registry still holds). `null` when the window was never registered or is
   * already gone.
   */
  getWindowIdFor(winOrOsId: NativeWindow | number): WindowId | null {
    let osId: number;
    if (typeof winOrOsId === 'number') {
      osId = winOrOsId;
    } else {
      try {
        osId = winOrOsId.id;
      } catch {
        return null; // destroyed native window — reading .id throws
      }
    }
    return this.idByOsWindowId.get(osId) ?? null;
  }

  /**
   * MIGRATION SHIM (see `BackendMigrationShims`): the live native window
   * handle for a WM WindowId, or `null` when unregistered/destroyed. The
   * HANDLE crosses (legacy consumers still need to join against
   * Electron-id-keyed registries until later migration steps); the backend's
   * numeric maps do not.
   */
  getNativeWindowFor(id: WindowId): NativeWindow | null {
    const entry = this.windows.get(id);
    if (!entry) return null;
    try {
      if (entry.win.isDestroyed()) return null;
    } catch {
      return null;
    }
    return entry.win;
  }

  /**
   * PRIVATE: the platform window id for a WindowId — used only where this
   * backend must call into a legacy Electron-id-keyed seam (windows.ts
   * `closeOrHideWindow` / `askWebContentsToHandleEscape`) until those seams
   * are re-keyed. Never exposed.
   */
  private osWindowIdOf(id: WindowId): number | null {
    const win = this.getNativeWindowFor(id);
    if (!win) return null;
    try {
      return win.id;
    } catch {
      return null;
    }
  }

  /**
   * The work area of the display nearest a window's current bounds, or `null`
   * when unavailable (some test envs) — mirrors `hybrid-overlay.ts
   * workAreaNearest`. Used only to compute `BOUNDS_CHANGED.overlayFrame` for
   * page-hosts (§5 step 9).
   */
  private workAreaNearest(content: Rectangle): Rectangle | null {
    try {
      return screen.getDisplayNearestPoint({
        x: content.x + Math.floor(content.width / 2),
        y: content.y + Math.floor(content.height / 2),
      }).workArea;
    } catch {
      return null;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Native listeners (§2.6): each is a one-line event translation — the two
  // exceptions are `blur`, which arms the ONE deferred-blur settle instead of
  // emitting (§4.4), and `close`, which vetoes and redirects into the kernel
  // instead of reporting (see the listener's own doc below).
  // ───────────────────────────────────────────────────────────────────────────

  private attachNativeListeners(
    id: WindowId,
    osWindowId: number,
    win: NativeWindow,
    kind: WindowKind,
    rendererWC: NativeWebContents | null,
  ): void {
    win.on('focus', () => {
      // Unconditional: focus landed in-app, so the app did not resign — that is
      // true however the focus got here.
      this.cancelBlurSettle();
      // The cancel arm of the beforeunload-prompt outcome (see
      // `quitPromptPending`): this window was asked to unload as part of a
      // quit and has taken focus instead of closing, so the prompt was
      // answered "stay" and the quit is dead. Unlatch, or every later native
      // close on any window skips the kernel for the rest of the session.
      if (this.quitPromptPending.delete(id)) this.quitting = false;
      const stackingProvoked = this.pendingStackingFocus.delete(id);
      // A stacking batch arms every window it reorders, but the platform
      // provokes at most ONE focus for the batch — so this focus, suppressed or
      // not, voids the rest. See `pendingStackingFocus`.
      this.pendingStackingFocus.clear();
      const cause = this.takeFocusCause(id);
      const suppressed = stackingProvoked && cause.kind !== 'machine';
      // A focus provoked by `setStacking` is this backend's own side effect on
      // platforms whose z-raise primitive activates: the machine asked for z
      // order, never for focus. Reporting it would feed a machine-initiated
      // operation back in as fresh OS evidence — the principle `raiseWindow`
      // states and honors by echoing `WINDOW_SHOWN` instead — and here it
      // closes a cycle (stacking → focus → raise → stacking) that sustains
      // itself. A machine-armed focus still reports: a focus-family command
      // genuinely asked for that one.
      if (suppressed) {
        // A suppressed focus is invisible to the transition timeline — it never
        // becomes an event — so the timeline records the suppression itself.
        // An absent `OsFocusGained` is exactly the signature to look for when a
        // window the test focused is not the window the machine ends up on.
        getKernelExecutor().markTimeline(`focus suppressed stacking-provoked ${String(id)} cause=${cause.kind}`);
        wmLog('os-focus-suppressed', { id, reason: 'stacking-provoked', causeKind: cause.kind });
        return;
      }
      // The hide half of the same principle, one arming consumed by the one
      // focus the platform provokes for it. See `pendingHideProvokedFocus`.
      const hideProvoked = this.pendingHideProvokedFocus;
      this.pendingHideProvokedFocus = false;
      if (hideProvoked && cause.kind !== 'machine') {
        getKernelExecutor().markTimeline(`focus suppressed hide-provoked ${String(id)} cause=${cause.kind}`);
        wmLog('os-focus-suppressed', { id, reason: 'hide-provoked', causeKind: cause.kind });
        return;
      }
      // Feeds the kernel (window-kernel-dispatch.ts), which drives the real
      // window operations post-cutover — see that module's header.
      kernelOsFocusGained(id, cause);
    });
    // The ONE deferred-blur settle: blur alone can't tell "focus left Peek" from
    // "focus is moving to the next Peek window" — Electron fires the old window's
    // `blur` BEFORE the new window's `focus` (§4.4). So arm a one-tick settle; a
    // focus that lands in-app cancels it before it runs.
    win.on('blur', () => {
      // Focus left this window, so any self-caused-focus arming for it is void —
      // whatever focuses it next is a fresh event, not our echo (see
      // `pendingSelfCausedFocus`, `pendingStackingFocus`).
      this.pendingSelfCausedFocus.delete(id);
      this.pendingStackingFocus.delete(id);
      this.armBlurSettle();
    });
    win.on('show', () => {
      // OS boundary workaround, the exact mirror of the `'hide'` guard below
      // (the peek 71cfde09 lag class, show half): AppKit delivers a
      // BaseWindow's 'show' notification asynchronously, so it can arrive after
      // the machine has already hidden that same window again — and the machine
      // then reads a stale echo as a fresh reveal, flipping `visible` back to
      // true and re-emitting the whole show-shaped effect set (`ShowWindow`,
      // `SetStacking`, and — for a base-layer page host — `AttachOverlayTo`).
      // That is the overlay-deactivation failure: the chrome re-attached to a
      // host the drain had just cleared and never detached again. Validate the
      // signal against native ground truth, exactly as the hide side does: only
      // a window that is really on screen echoes WINDOW_SHOWN. A destroyed
      // window is never shown, so it is excluded here (the hide side's
      // `isDestroyed` arm reads the other way for the same reason — a destroyed
      // window IS hidden).
      // One-shot, taken regardless of what happens next — see
      // `pendingShowOpSeq`'s doc. A show this native event turns out NOT to
      // confirm (the ground-truth check just below fails) spends the token
      // either way: a rejected native 'show' is not evidence a LATER,
      // unrelated show should be mislabelled with.
      const opSeq = this.pendingShowOpSeq.get(id);
      this.pendingShowOpSeq.delete(id);
      if (win.isDestroyed() || !win.isVisible()) return;
      const focused = this.isFocused(win);
      // Feeds the kernel (window-kernel-dispatch.ts), which drives the real
      // window operations post-cutover — see that module's header.
      kernelWindowShown(id, focused, opSeq);
    });
    win.on('hide', () => {
      // OS boundary workaround (macOS, lowest layer — this backend): AppKit
      // delivers stale/lagged 'hide' notifications for BaseWindows (the peek
      // 71cfde09 lag class). During session restore one arrives for the
      // just-activated host with the window still on screen, and echoing it
      // would yank the machine's `front` off the restored window. Validate
      // the signal against native ground truth: only a window that is
      // actually not visible echoes WINDOW_HIDDEN.
      // One-shot, taken regardless of outcome — the `'show'` listener's
      // `pendingShowOpSeq` doc explains why a rejected native event still
      // spends its token.
      const opSeq = this.pendingHideOpSeq.get(id);
      this.pendingHideOpSeq.delete(id);
      if (!win.isDestroyed() && win.isVisible()) return;
      kernelWindowHidden(id, opSeq);
    });
    // THE GAP THIS CLOSES: previously the only listener here was `'closed'`
    // (below), fired AFTER the fact — nothing asked the kernel BEFORE a
    // native close happened, so its `decide()`'s `CloseOrHideWindow` rule
    // (`record.keepLive ? WindowHidden : WindowClosed`) never ran for an
    // OS-initiated close, and a keepLive tile was destroyed instead of
    // hidden the moment the user closed it by any native means (red button,
    // an OS-level Cmd+W, a window-manager close) rather than through a
    // command this app already routed through `windows.ts
    // closeOrHideWindow` (cmd+W, the switcher, etc). `tile-launcher.ts` used
    // to paper over exactly this gap with its own `win.on('close')` veto;
    // that veto is deleted as a rival decider (§0: the kernel is the only
    // one now), so this listener is what replaces it — for every registered
    // window, not only the tiles the old veto singled out.
    //
    // Two escapes, checked in order, both load-bearing:
    //   - `quitting`: the OS is tearing every window down as part of a real
    //     app quit — see that field's doc for why letting it through here is
    //     what keeps `entry.ts`'s deferred quit-cleanup sequence from hanging
    //     on a window this listener vetoed forever.
    //   - `pendingMachineClose`: THIS backend's own `closeWindow` is the one
    //     calling `win.close()` right now, realizing the kernel's own
    //     `CloseWindow`/`CloseWindowDirect` effect — the answer to the very
    //     `kernelCloseOrHideRequested` a prior native close attempt on this
    //     window issued. Reporting that as fresh evidence would ask the
    //     kernel the same question forever: veto, ask, decide "close", close,
    //     veto again. See `pendingMachineClose`'s own doc for why a counting
    //     arm (no token) is enough here, unlike the show/hide echo guards.
    //
    // Neither armed: a genuine, not-yet-decided native close attempt. Veto it
    // and let the kernel answer — its `CloseWindow` effect (non-keepLive) or
    // `HideWindow` effect (keepLive) is the only thing that decides what
    // actually happens to this window next.
    win.on('close', (...args: unknown[]) => {
      if (this.quitting) return;
      if (this.consumeMachineCloseArm(id)) return;
      const event = args[0] as { preventDefault(): void } | undefined;
      event?.preventDefault();
      kernelCloseOrHideRequested(id);
    });
    win.on('closed', () => {
      this.clearFullscreenSettle(id);
      // The proceed arm of the beforeunload-prompt outcome (see
      // `quitPromptPending`): the window went away, so the prompt was answered
      // "leave" and the quit is still running. Drop the record and leave
      // `quitting` alone — `will-quit` clears it when the attempt finishes.
      this.quitPromptPending.delete(id);
      this.pendingSelfCausedFocus.delete(id);
      this.pendingStackingFocus.delete(id);
      this.pendingShowOpSeq.delete(id);
      this.pendingHideOpSeq.delete(id);
      this.pendingMachineClose.delete(id);
      this.windows.delete(id);
      // `osWindowId` was captured at registration — reading `win.id` here would
      // throw on the already-destroyed native window.
      this.idByOsWindowId.delete(osWindowId);
      // Feeds the kernel (window-kernel-dispatch.ts) — RULE 1 makes this the
      // only event that shrinks its `order`.
      kernelWindowClosed(id);
    });
    win.on('enter-full-screen', () => {
      this.clearFullscreenSettle(id);
      // Feeds the kernel (window-kernel-dispatch.ts), which drives the real
      // window operations post-cutover — see that module's header.
      kernelOsFullscreenEntered(id);
    });
    win.on('leave-full-screen', () => {
      this.clearFullscreenSettle(id);
      kernelOsFullscreenLeft(id);
    });
    // Geometry mirror (§5 step 7): every native resize/move lands in the
    // machine as BOUNDS_CHANGED — the SOLE writer of the record's `bounds`.
    // Three native names, one translation: `resize` + the continuous `move`
    // fire on both kinds; macOS additionally fires `moved` once at
    // gesture-end. A duplicate emission re-merges the same rect in the
    // reducer, structurally inert.
    const emitBounds = (): void => {
      // Read ONCE, inside the backend, and push — never a query across the
      // port (§3). A window can be destroyed between the native event firing
      // and this microtask; reading bounds then throws, and there is nothing
      // left to report.
      try {
        if (win.isDestroyed()) return;
        const bounds = win.getBounds();
        // Only a page-host can host the chrome overlay (§5 step 9) — skip the
        // frame math for every other window kind.
        const overlayFrame =
          kind === 'page-host' ? expandToOverlayFrame(bounds, this.workAreaNearest(bounds)) : undefined;
        // Feeds the kernel (window-kernel-dispatch.ts), which drives the real
        // window operations post-cutover — see that module's header.
        kernelBoundsChanged(id, bounds, overlayFrame);
      } catch {
        /* window gone mid-event */
      }
    };
    win.on('resize', emitBounds);
    win.on('move', emitBounds);
    win.on('moved', emitBounds);
    // Records a beforeunload prompt raised by an in-flight quit, so the
    // `'focus'` and `'closed'` listeners above can tell a cancelled quit from
    // one that is proceeding — see `quitPromptPending`. Every kind of window,
    // not only page-hosts: any renderer can register a beforeunload handler,
    // and one cancel is enough to strand the latch. Never `preventDefault()`s
    // — the prompt is the page's and the answer is the user's; this watches.
    // A prompt raised outside a quit is irrelevant here and goes unrecorded.
    if (rendererWC) {
      rendererWC.on('will-prevent-unload', () => {
        if (this.quitting) this.quitPromptPending.add(id);
      });
    }
    // Page-host: clicking directly into the page focuses the content WC even when
    // the host BaseWindow's own `focus` is missed (belt-and-suspenders, mirrors
    // the registry's content-WC focus fallback).
    if (kind === 'page-host' && rendererWC) {
      rendererWC.on('focus', () => {
        this.cancelBlurSettle();
        // One shot (`takeFocusCause`), read once and fed to the kernel below.
        const cause = this.takeFocusCause(id);
        // Feeds the kernel — see the `win.on('focus')` listener above.
        kernelOsFocusGained(id, cause);
        // Feeds the kernel (window-kernel-dispatch.ts) — the sole writer of its
        // `contentFocused`.
        kernelContentFirstResponderChanged(id, true);
      });
      // Mirrors the content WC's first-responder status (§5 step 11).
      rendererWC.on('blur', () => {
        // Feeds the kernel (window-kernel-dispatch.ts) — the sole writer of its
        // `contentFocused`.
        kernelContentFirstResponderChanged(id, false);
      });
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Focus provenance (peek 7fffa286) — see `pendingSelfCausedFocus`.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Declare, immediately before a native call that can move OS focus onto `id`,
   * that the focus it provokes is the machine's own — carrying `opSeq`, the
   * token of the effect that asked for it.
   *
   * Call sites are exactly the focus-family commands, and ONLY where the native
   * call really can take focus: an activating `performOsShow`, `raiseWindow`'s
   * content focus, `focusContent`. A `showInactive()` takes no focus and arms
   * nothing — arming it would leave a token nothing consumes.
   *
   * A command from this family also VOIDS any outstanding stacking arming for
   * the window: that arming exists to swallow a focus nobody asked for, and a
   * stale one (the z-raise took no focus after all) would otherwise swallow the
   * focus this command is about to provoke.
   */
  private armSelfCausedFocus(id: WindowId, opSeq: number): void {
    this.pendingSelfCausedFocus.set(id, opSeq);
    this.pendingStackingFocus.delete(id);
  }

  /**
   * Consume the arming for `id` and report the provenance of the focus that just
   * arrived: `machine` (with the op token) when this backend was expecting it,
   * `world` otherwise. One shot — a second focus with nothing armed is `world`,
   * which is what makes a self-caused echo unable to spend a window's "first real
   * focus".
   */
  private takeFocusCause(id: WindowId): FocusCause {
    const opSeq = this.pendingSelfCausedFocus.get(id);
    if (opSeq === undefined) {
      wmLog('focus-cause-taken', { id, kind: 'world' });
      return { kind: 'world' };
    }
    this.pendingSelfCausedFocus.delete(id);
    wmLog('focus-cause-taken', { id, kind: 'machine', opSeq });
    return { kind: 'machine', opSeq };
  }

  /**
   * Realize a raise on a window this backend already sees on screen: `moveTop()`
   * alone, the same non-activating z-raise `setStacking` uses for its
   * `stacked`/`excluded` branch — never `performOsShow`. See `raiseWindow`'s
   * docblock for why a raise must stop short of a show once the target is
   * already visible.
   *
   * `moveTop()` has crashed historically and is guarded accordingly. Off
   * darwin it can itself take focus (`STACKING_TAKES_FOCUS`), so this reuses
   * `pendingStackingFocus` — the SAME arming `setStacking` carries for the
   * SAME primitive — rather than inventing a second suppression mechanism for
   * one native call.
   */
  private reorderToTop(id: WindowId, win: NativeWindow): void {
    try {
      if (STACKING_TAKES_FOCUS) this.pendingStackingFocus.add(id);
      win.moveTop();
    } catch {
      /* moveTop unsupported on some platforms, or torn down mid-raise — a no-op */
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Port: commands.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Show + raise + activate a window, kind-appropriately (headless stays
   * focus-free). `raiseWindow` is reachable from the `RAISE_WINDOW` effect,
   * whose sole emitter is `window-kernel.ts react` — a raise at a
   * target something named (switcher selection, Escape closing the switcher,
   * devtools, parent handoff on close, the successor after the front hid),
   * never a re-drive of the machine's own belief. A raise is an activating show, so its
   * truthful echo is `WINDOW_SHOWN {focused:true}` — `front` moves and
   * `applyFocusGained` runs, but the transient-autoclose sweep does NOT
   * (`selectTransientAutoclose` runs only off `OS_FOCUS_GAINED`). Echoing
   * `OS_FOCUS_GAINED` instead would both feed the machine's own belief back in
   * as fresh OS evidence and sweep a live palette/quick-view out from under a
   * raise that never meant to touch it — see the module header for the shape
   * of that feedback loop. The same holds for `showWindow`; see the module
   * header.
   *
   * ONE OF THESE RAISES IS ALSO WHAT A FOCUS REPORT DRIVES BACK AT THE OS
   * (`applyRaiseRequest`, called off `OS_FOCUS_GAINED` for a window that was
   * not already `front`): the OS already moved key onto the target, and this
   * call exists only to make z-order agree with that fact. A raise realized
   * as `performOsShow`'s activating `win.show()` (`makeKeyAndOrderFront:`)
   * asks the OS for a show it doesn't need — the window is already on
   * screen — and buys nothing but a fresh focus re-pick for the whole stack,
   * which is exactly the ping-pong `docs/design/window-manager.md` §4.3 item
   * 3 measures (a raise re-granting the focus it was only supposed to
   * reflect). So: **when this backend's own `isVisible()` ground truth says
   * the target is already on screen, realize the raise as a pure reorder —
   * `moveTop()`, never a show.** A target that genuinely is not visible
   * still needs the real show; nothing else will map it. This is not
   * platform-scoped: a raise consequent on a focus report should not
   * re-grant focus anywhere, and a window already on screen needs no show
   * anywhere — the platform divergence (`STACKING_TAKES_FOCUS`) is only in
   * how `moveTop()` itself behaves, reusing the SAME arming `setStacking`
   * already carries for that primitive.
   *
   * Two rules this derives from: (1) a platform's workaround shape belongs
   * in the backend, and the machine emits ONE effect for ONE intention —
   * "bring this window to the front" is one intention, and which native
   * primitive expresses it without extra side effects is this backend's
   * business, not the reducer's. (2) a machine-initiated operation must not
   * feed its own side effect back in as fresh OS evidence (see this file's
   * header) — a raise that re-grants focus manufactures exactly such
   * evidence.
   */
  raiseWindow(id: WindowId, opSeq: number): void {
    const entry = this.windows.get(id);
    if (!entry) return;
    const { win, kind, rendererWC } = entry;
    if (win.isDestroyed()) return;
    const alreadyVisible = this.isVisibleSafe(win);
    if (kind === 'page-host') {
      // Non-headless, not yet on screen: activating show + content first
      // responder (the `hybridShowIntent` invariant — the R4/R5/R7
      // dead-focus cluster). Headless: opacity-0 + showInactive, never
      // activate/focus. Already on screen: reorder only — see docblock above.
      if (alreadyVisible) this.reorderToTop(id, win);
      else this.performOsShow(id, win, !isHeadless(), opSeq);
      if (!isHeadless() && rendererWC && !rendererWC.isDestroyed()) {
        try {
          // The raise's content-focus half provokes `rendererWC 'focus'` — the
          // producer that carried the peek 7fffa286 sweep. Label it.
          this.armSelfCausedFocus(id, opSeq);
          rendererWC.focus();
        } catch {
          /* wc gone mid-raise */
        }
      }
      kernelWindowShown(id, true, opSeq);
      return;
    }
    // Browser window: headless-safe show (opacity-0 + inactive under headless),
    // activate + focus only when not headless — unless already on screen, in
    // which case a reorder is all the raise means (see docblock above), and
    // neither the show nor the trailing explicit focus below run.
    if (alreadyVisible) {
      this.reorderToTop(id, win);
    } else {
      this.performOsShow(id, win, !isHeadless(), opSeq);
      if (!isHeadless()) {
        try {
          this.armSelfCausedFocus(id, opSeq);
          (win as unknown as BrowserWindow).focus();
        } catch {
          /* window gone mid-raise */
        }
      }
    }
    kernelWindowShown(id, true, opSeq);
  }

  /** Make a page-host's content WC the macOS first responder. */
  focusContent(id: WindowId, opSeq: number): void {
    const wc = this.windows.get(id)?.rendererWC;
    if (!wc || wc.isDestroyed()) return;
    // The focus this call provokes is the machine's own, not a user gesture.
    this.armSelfCausedFocus(id, opSeq);
    wc.focus();
  }

  /**
   * Drive native fullscreen (the SINGLE place the platform fullscreen toggle
   * is called for BOTH kinds — §2.4). NOT gated on headless: the pre-machine
   * owner (`setHybridHostFullScreen`) wasn't either, and the bridge-driven
   * "disruptive fullscreen" spec (§5.4) relies on a real transition.
   * Focus/activation are what headless gates.
   */
  setFullscreen(id: WindowId, on: boolean): void {
    const w = this.windows.get(id)?.win;
    if (!w || w.isDestroyed()) return;
    w.setFullScreen(on);
    // Arm the bounded settle timer so a transition that never emits its
    // native settled event self-corrects via RECONCILE_FULLSCREEN (§2.3).
    this.armFullscreenSettle(id);
  }

  /**
   * The ONE sanctioned `isFullScreen()` read (§2.5): read reality ONCE and
   * feed the settled fact to the kernel so `fsMode` snaps to it. Command in,
   * event out — no other code may read `isFullScreen()` for state.
   */
  reconcileFullscreen(id: WindowId): void {
    const w = this.windows.get(id)?.win;
    if (!w || w.isDestroyed()) return;
    const entered = w.isFullScreen();
    // Feeds the kernel (window-kernel-dispatch.ts), which drives the real
    // window operations post-cutover — see that module's header.
    if (entered) {
      kernelOsFullscreenEntered(id);
    } else {
      kernelOsFullscreenLeft(id);
    }
  }

  /**
   * Route through the existing close/hide seam (honors keepLive, hybrid vs
   * browser). The seam is still Electron-id-keyed; the backend resolves the
   * native id (the one place allowed to). The returned promise is test-bridge
   * settlement only — nothing in the machine waits on it.
   */
  closeOrHide(id: WindowId): Promise<void> {
    const osId = this.osWindowIdOf(id);
    if (osId == null) return Promise.resolve();
    return closeOrHideWindow(osId);
  }

  /**
   * The `escape-pressed` IPC, unchanged protocol. Resolves to the renderer's
   * own `handled` verdict — the caller (`window-escape-runtime.ts
   * handleEscapePress`) re-reads state and re-runs `interpretEscape` with
   * the answer; this method never touches the reducer.
   */
  askRendererHandledEscape(id: WindowId): Promise<boolean> {
    const wc = this.windows.get(id)?.rendererWC;
    if (!wc || wc.isDestroyed()) {
      // No renderer to ask → unhandled, so ESC still resolves.
      return Promise.resolve(false);
    }
    // `askWebContentsToHandleEscape` (windows.ts) still speaks Electron ids;
    // resolve the native id INSIDE the backend (the one place allowed to).
    return askWebContentsToHandleEscape(this.osWindowIdOf(id) ?? -1, wc as unknown as WebContents).then(
      (ans) => ans.handled,
    );
  }

  /**
   * The SINGLE owner of the `before-input-event` Esc attach for browser
   * windows (see `WindowSpec.attachEscHandler`). Issued by the executor
   * exactly when `decideWindowRegistration` says so — one attach per window,
   * so one keypress can only ever produce one `ESC_PRESSED`.
   */
  attachEscHandler(id: WindowId): void {
    const win = this.getNativeWindowFor(id);
    if (!win) return;
    try {
      addEscHandler(win as unknown as BrowserWindow);
    } catch (err) {
      DEBUG && console.log('[window-state] esc handler attach failed for', id, err);
    }
  }

  /**
   * Derived Escape grab (§2.4), OS half. The executor re-asserts the desired
   * state on EVERY transition; this method owns the real registration state —
   * including a FAILED register (stays false so the next assert retries) —
   * and no-ops when already matching.
   */
  setEscGrab(on: boolean): void {
    if (on === this.escGrabRegistered) return;
    if (on) {
      try {
        this.escGrabRegistered = globalShortcut.register('Escape', this.escGrabHandler);
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
  // §5 step 4 commands — close/destroy/show/hide/pin + guest teardown.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Guest-safe direct close (the absorbed `windows.ts closeHostWindow` /
   * `destroyGuestsThenClose` pair — see `WindowBackend.closeWindow` and the
   * d1cf0b9a use-after-free history on the old function): exit native
   * fullscreen FIRST if the window is in it (`exitFullscreenBeforeClose`
   * below), destroy the window's registered page-host guests, wait for them
   * to actually go away (bounded), then close the host. Guestless windows
   * still take the synchronous-native-call fast path, just after the
   * preamble. `PEEK_DISABLE_PAGEHOST_CLOSE_GUARD=1` reverts to the raw close
   * (guest pass skipped) — the pre-fix behavior, a test/diagnostic seam only;
   * the fullscreen preamble still runs even with the guard set, since it
   * guards a different hazard.
   *
   * This is the SOLE terminal-close path the kernel drives now: the old
   * adapter's `CLOSE_WINDOW`/`CLOSE_WINDOW_DIRECT` effects were labelled
   * no-ops (`window-os-adapter.ts runEffect`, before that module was
   * deleted), and the kernel's `CloseWindow`
   * (`react`'s membership-shrink diff) and `CloseWindowDirect`
   * (`windows.ts closeHostWindow`'s feed) effects both call this method — so
   * the preamble belongs HERE rather than above the port (design §"Electron
   * is ONE backend"): every route that terminates a window through this
   * method gets it, and no caller has to know the workaround exists. Mirrors
   * `closeOrHide`'s existing `windows.ts closeOrHideWindow` preamble for its
   * OWN hybrid branch — this one covers the routes that preamble doesn't
   * reach (a plain `CloseWindow` from the membership-shrink diff, and the
   * non-hybrid `closeOrHideWindow` branch, neither of which ever ran it).
   */
  async closeWindow(id: WindowId): Promise<void> {
    const win = this.windows.get(id)?.win;
    if (!win) return;
    try {
      if (win.isDestroyed()) return;
    } catch {
      return;
    }
    // Ordered before the guest pass, matching the preamble's one prior home
    // (`windows.ts closeOrHideWindow`'s hybrid branch ran it before ANY
    // other close/hide work): the AppKit exit-fullscreen animation should be
    // settled before content teardown and the terminal close run, not
    // interleaved with them.
    await this.exitFullscreenBeforeClose(win);
    try {
      if (win.isDestroyed()) return;
    } catch {
      return;
    }
    const guestIds = getGuestsForWindow(id);
    if (guestIds.length === 0 || process.env.PEEK_DISABLE_PAGEHOST_CLOSE_GUARD === '1') {
      // Arm immediately before the native call it labels — see
      // `pendingMachineClose`'s doc: the `'close'` this provokes is the
      // kernel's own decision being realized, not fresh OS evidence.
      this.armMachineClose(id);
      try {
        win.close();
      } catch {
        /* closing a torn-down window is a no-op */
      }
      return;
    }
    await this.destroyGuestsThenClose(id, win, guestIds);
  }

  /**
   * Black-window fix (macOS): exit native fullscreen and AWAIT the exit
   * before the terminal close — closing (or hiding) a window mid the AppKit
   * exit-fullscreen animation strands an empty Space. Ported intent from the
   * deleted-here `windows.ts closeOrHideWindow` hybrid preamble, expressed as
   * a raw native call pair rather than a machine round trip: this backend
   * already holds the native handle and already owns the ONE `setFullScreen`
   * call site (§2.4), so there is no reason to route an internal ordering
   * decision back out through a dispatch. No-op when the window is not
   * fullscreen (the common case) or is already gone.
   *
   * Bounded by the SAME timeout the fullscreen-settle timer uses
   * (`FULLSCREEN_SETTLE_TIMEOUT_MS`, §2.3) so a destroyed / no-op window that
   * never fires `leave-full-screen` cannot hang the close forever — it just
   * proceeds once the bound elapses, same self-correction shape as
   * `armFullscreenSettle`/`FULLSCREEN_SETTLE_TIMEOUT`.
   *
   * Deliberately NOT `this.setFullscreen(id, false)`: that public command
   * exists to service the kernel's OWN `SetFullscreen`/`ExitFullscreen`
   * effects (an intentional fullscreen toggle) and arms its own settle timer
   * that reports back into the machine — engaging it here would race this
   * wait and double-report the same exit. This is a different concern, an
   * ordered pair of native calls that only makes sense as one step inside
   * ONE `closeWindow` intention, so it stays self-contained and reports
   * nothing itself; the ALREADY-attached `leave-full-screen` listener
   * (`attachNativeListeners`) still fires and still emits `OS_FULLSCREEN_LEFT`
   * — this method only waits for that native fact to land.
   */
  private exitFullscreenBeforeClose(win: NativeWindow): Promise<void> {
    let fullscreen: boolean;
    try {
      fullscreen = !win.isDestroyed() && win.isFullScreen();
    } catch {
      return Promise.resolve();
    }
    if (!fullscreen) return Promise.resolve();
    try {
      win.setFullScreen(false);
    } catch {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      win.on('leave-full-screen', finish);
      const timer = setTimeout(finish, FULLSCREEN_SETTLE_TIMEOUT_MS);
    });
  }

  private async destroyGuestsThenClose(id: WindowId, win: NativeWindow, guestIds: number[]): Promise<void> {
    DEBUG && console.log('[window-backend] destroying', guestIds.length, 'guest(s) before closing host');
    await destroyGuestsAndWait(this.resolveLiveGuests(guestIds), requestGuestDestroy);
    try {
      if (!win.isDestroyed()) {
        // Arm immediately before the native call it labels — see
        // `pendingMachineClose`'s doc.
        this.armMachineClose(id);
        win.close();
      }
    } catch {
      /* torn down while guests settled */
    }
  }

  /** Guest ids → live WebContents. Ids with no live wc need no wait at all. */
  private resolveLiveGuests(guestIds: readonly number[]): WebContents[] {
    const live: WebContents[] = [];
    for (const gid of guestIds) {
      try {
        const wc = webContents.fromId(gid);
        if (wc && !wc.isDestroyed()) live.push(wc);
      } catch {
        /* an id whose wc can't be resolved is already gone */
      }
    }
    return live;
  }

  /** Forceful native destroy — synchronous (before-quit teardown depends on it). */
  destroyWindow(id: WindowId): void {
    const win = this.windows.get(id)?.win;
    if (!win) return;
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch {
      /* destroying a torn-down window is a no-op */
    }
  }

  /**
   * Tear down the retained content surface (the hybrid finalize's documented
   * `webContents.close()` teardown — no beforeunload wait; the host is
   * already gone). Gated on the same pure guard the old call site used
   * (`shouldCloseContentWCOnFinalize`, peek 9a591551: an already-natively-
   * gone wc resolves to undefined and must be a clean no-op).
   */
  closeContent(id: WindowId): void {
    const wc = this.windows.get(id)?.rendererWC;
    if (!shouldCloseContentWCOnFinalize(wc)) return;
    try {
      wc!.close();
    } catch (e) {
      DEBUG && console.log('[window-backend] content wc close failed for', id, e);
    }
  }

  /**
   * The ONE show implementation (§5 step 6A-2 — the `SHOW_WINDOW` effect).
   * Owns the whole policy the windows.ts seams used to perform:
   *   - headless → `setOpacity(0)` BEFORE the show (nothing paints on the
   *     real display; `isVisible()` stays true for tests);
   *   - `activate` → `show()` (activates the app + key window), else
   *     `showInactive()`;
   *   - page-host OS masks: never activate under headless (focus-free runs),
   *     and a `quick-view`-class host (a `type:'panel'` NSPanel) NEVER
   *     activates the app (regression 524f7aba) — its key input rides the
   *     content-focus half, which stays with the windows.ts caller until the
   *     focus-rivals step (§5 step 8). A browser window ALSO masks activate
   *     under headless — matching the `raiseWindow` browser branch. `opacity(0)`
   *     hides pixels but does NOT stop an activating `win.show()` from doing
   *     `makeKeyAndOrderFront:` and stealing the macOS key window; only
   *     `showInactive()` avoids the grab. (Prior comment wrongly claimed
   *     opacity-0 covered headless — it was the test focus-theft root cause.)
   *   - feeds the kernel a `WindowShown` fact with the caller's UNMASKED
   *     `activate` intent: `showInactive()` emits no native `'show'` event and
   *     headless runs are focus-free, so this feed is what keeps the kernel's
   *     visibility + `front` truthful. The native `'show'` listener still
   *     feeds the kernel for activating shows too — the merge is idempotent.
   *     `front`/`focusSeq` move under headless off this fact alone — nothing
   *     here synthesizes an `OS_FOCUS_GAINED` to stand in for the activation
   *     the headless mask declined. See the module header for why not.
   */
  showWindow(id: WindowId, opts: { activate: boolean; opSeq: number }): void {
    const entry = this.windows.get(id);
    if (!entry) return;
    const { win, kind, windowClass } = entry;
    try {
      if (win.isDestroyed()) return;
    } catch {
      return;
    }
    // Two masks on the caller's activation intent, both narrowing what the OS
    // is asked for: headless never activates (focus-free runs, peek 2b55f3af),
    // and a quick-view page-host (a `type:'panel'` NSPanel) never activates the
    // app on ANY display (regression 524f7aba). The echo below still reports the
    // caller's UNMASKED intent — that is what keeps `front` moving under
    // headless.
    const osActivate =
      (kind === 'page-host' ? opts.activate && windowClass !== 'quick-view' : opts.activate) &&
      !isHeadless();
    this.performOsShow(id, win, osActivate, opts.opSeq);
    kernelWindowShown(id, opts.activate, opts.opSeq);
  }

  /**
   * The single native show call pair (+ the headless opacity-0 trick): every
   * show this backend performs — `showWindow`, `raiseWindow` — funnels here.
   * Opacity is zeroed BEFORE the show; the entry.ts headless prototype guard
   * enforces exactly that order.
   */
  private performOsShow(id: WindowId, win: NativeWindow, activate: boolean, opSeq: number): void {
    // Arm BEFORE either native call below — see `pendingShowOpSeq`'s doc:
    // the native `'show'` this provokes can land ahead of this method's own
    // synthetic echo, so the listener needs the token armed first.
    this.pendingShowOpSeq.set(id, opSeq);
    if (isHeadless()) {
      try {
        win.setOpacity(0);
      } catch {
        /* setOpacity unsupported on some platforms */
      }
    }
    if (activate) {
      try {
        // An activating show is `makeKeyAndOrderFront:` — it takes the macOS key
        // window, so the `'focus'` it provokes is self-caused. Armed only on this
        // branch: `showInactive()` below takes no focus at all (see
        // `pendingSelfCausedFocus`).
        this.armSelfCausedFocus(id, opSeq);
        win.show();
      } catch {
        /* show unsupported in some envs */
      }
    } else {
      try {
        win.showInactive();
      } catch {
        /* showInactive unsupported in some envs */
      }
    }
  }

  /**
   * Hide, keep alive (the HUD app-blur sweep). `opSeq`, when the caller has
   * one (the kernel's `HideWindow` effect always does), rides along on the
   * confirming echo below — see `WindowBackend.hideWindow`'s doc.
   */
  hideWindow(id: WindowId, opSeq?: number): void {
    const win = this.windows.get(id)?.win;
    if (!win) return;
    // Arm BEFORE `win.hide()` below — see `pendingHideOpSeq`'s doc: the
    // native `'hide'` it provokes can land ahead of this method's own
    // synthetic echo. A caller with no token (none exists today) clears any
    // stale arm rather than leaving a PREVIOUS hide's token to mislabel this
    // one's native echo.
    if (opSeq !== undefined) this.pendingHideOpSeq.set(id, opSeq);
    else this.pendingHideOpSeq.delete(id);
    try {
      if (win.isDestroyed()) return;
      // Hiding the focused window makes the platform reassign focus to a window
      // the machine never named — arm the attribution so the `'focus'` handler
      // does not read this backend's own side effect as fresh OS evidence. See
      // `pendingHideProvokedFocus`.
      //
      // GATED ON THE WINDOW ACTUALLY HOLDING FOCUS, because that is the whole
      // mechanism: hiding a window nothing is focused on reassigns nothing, so
      // there is no provoked focus to attribute. Arming unconditionally made
      // this a latch with no expiry and no owner — it survived until SOME focus
      // arrived, and the next focus to arrive was usually a genuine one, which
      // it then swallowed. Measured: hiding the unfocused chrome overlay on an
      // overlay retarget armed it, and the user's next focus on another page
      // host was dropped with `cause=world`, leaving `key` on the wrong window
      // and the session snapshot naming the wrong focused page
      // (`session-restore-hybrid-focus.spec.ts` "two hybrid pages: the page
      // focused at save is the one restore raises").
      this.pendingHideProvokedFocus = this.isFocused(win);
      win.hide();
    } catch {
      /* hiding a torn-down window is a no-op */
      return;
    }
    // Feed WINDOW_HIDDEN for the hide this backend just performed — the exact
    // mirror of `showWindow`'s WINDOW_SHOWN feed. The native `'hide'` event
    // fires a tick LATE on macOS BaseWindows (the documented peek 71cfde09
    // lag), so without this feed every consumer that reads kernel state right
    // after a hide intent — the overlay's host-visibility gate, `front`
    // successor promotion — sees stale `visible:true` for a tick. The late
    // native event still arrives and re-merges idempotently.
    kernelWindowHidden(id, opSeq);
  }

  /** Pin above regular windows. 'floating' matches the old post-ctor reinforcement (`setAlwaysOnTop(true,'floating')`). */
  pinAlwaysOnTop(id: WindowId, on: boolean): void {
    const win = this.windows.get(id)?.win;
    if (!win) return;
    try {
      if (!win.isDestroyed()) win.setAlwaysOnTop(on, on ? 'floating' : undefined);
    } catch {
      /* pinning a torn-down window is a no-op */
    }
  }

  /**
   * Relative raise — order only (the `SET_STACKING` effect, §5 step 5).
   * Regular (`stacked`/`excluded`) kinds route through the native `moveTop`:
   * it reorders z within the window's level WITHOUT activating or taking key
   * (the property the legacy restore pass relied on). The two caveats — macOS
   * no-ops it for a non-frontmost app, and a page-host's NSWindow no-ops it
   * until first composited frame — are modeled in the MACHINE
   * (`window-kernel.ts` appActive gate + `WindowContentOrderable`), not
   * worked around here.
   *
   * A `pinned` window (the chrome overlay) is a DIFFERENT native operation:
   * `moveTop()` only reorders within the current level, so it cannot lift the
   * overlay back above the regular stack once anything raises over it — the
   * original `frameBounds()` re-assert used `setAlwaysOnTop(true, 'floating')`
   * instead, and that's what this branch realizes. Not headless-gated: the
   * original ran it under headless too (opacity-0 overlay).
   */
  setStacking(id: WindowId, level: StackingLevel): void {
    const win = this.windows.get(id)?.win;
    if (!win) return;
    try {
      if (win.isDestroyed()) return;
      if (STACKING_TAKES_FOCUS) this.pendingStackingFocus.add(id);
      if (level === 'pinned') win.setAlwaysOnTop(true, 'floating');
      else win.moveTop();
    } catch {
      /* moveTop/setAlwaysOnTop unsupported on some platforms / torn-down window — a no-op */
    }
  }

  /**
   * Position and size the window (the `SET_BOUNDS` effect — §5 step 7). The
   * SINGLE place the platform bounds write happens for BOTH kinds; the
   * native `resize`/`move` listeners echo the settled rect back as
   * `BOUNDS_CHANGED` (command in, event out — no `getBounds()` answer here).
   */
  setWindowBounds(id: WindowId, rect: Rectangle): void {
    const win = this.windows.get(id)?.win;
    if (!win) return;
    try {
      if (!win.isDestroyed()) win.setBounds(rect);
    } catch {
      /* torn-down window mid-command — the machine already recorded intent */
    }
  }

  /**
   * Realize the window's declared desktop membership (the platform-neutral
   * `SetDesktopMembership` effect from the rewritten kernel,
   * `window-kernel.ts DesktopMembership`) as native macOS Spaces calls. Named
   * off the intention, deliberately NOT the platform method
   * `setVisibleOnAllWorkspaces`: same convention as `pinAlwaysOnTop` /
   * `setStacking` / `setWindowBounds` — the R2 mechanical check
   * (`scripts/check-r2-window-ops.mjs`) greps platform call names verbatim.
   *
   * darwin-only, and non-darwin's answer is "zero native calls, done": Spaces
   * don't exist elsewhere, so satisfying either intention costs nothing
   * there — a platform fact this backend owns, never one the kernel or the
   * port sees.
   *
   * No `isHeadless()` gate HERE, same convention as `pinAlwaysOnTop` /
   * `setStacking` / `setWindowBounds`: the executor owns the headless
   * decision for this family (`window-kernel-executor.ts` skips the effect
   * under headless).
   *
   * `skipTransformProcessType: true` rides EVERY call this method makes:
   * without it macOS toggles the app's activation policy (Accessory <->
   * Foreground) mid-call and every OTHER Peek window flashes out for a
   * frame. `visibleOnFullScreen: true` only ever belongs on an `on:true`
   * call — a bare unpin never needs it.
   *
   * `'follow'` (ride along to whichever Space the user is on) is ONE native
   * call: `on:true` with both options.
   *
   * `'anchor'` (stay on the Space it was opened on) is the ORDERED PAIR —
   * `true` then `false`, synchronously, with DIFFERENT options — ported
   * verbatim from the old reducer's `SPACES_POLICY_REQUESTED` `'anchor'` arm
   * (`window-state.ts`), because the MECHANISM has to survive the port, not
   * just the intent: a bare `false` call leaves the window on whichever
   * Space the app happened to be created from, not the user's active one.
   * The first call (`on:true`, both options) lands the window on the active
   * Space; the second (`on:false`, `skipTransformProcessType` only) then
   * pins it there. The two calls carry different options, which is why they
   * cannot collapse into one.
   */
  setDesktopMembership(id: WindowId, membership: DesktopMembership): void {
    if (process.platform !== 'darwin') return;
    const win = this.windows.get(id)?.win;
    if (!win) return;
    try {
      if (win.isDestroyed()) return;
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      if (membership === 'anchor' && !win.isDestroyed()) {
        win.setVisibleOnAllWorkspaces(false, { skipTransformProcessType: true });
      }
    } catch {
      /* Spaces write against a torn-down window — the machine already recorded intent */
    }
  }

  /**
   * Realize the window's click-through state (the platform-neutral
   * `SetAcceptsInput` effect, `window-kernel.ts WindowRecord.acceptsInput`) as
   * the native `setIgnoreMouseEvents` call. Named off the intention,
   * deliberately NOT the platform method name: same convention as
   * `setFullscreen` / `pinAlwaysOnTop` / `setWindowBounds` /
   * `setDesktopMembership` — the R2 mechanical check
   * (`scripts/check-r2-window-ops.mjs`) greps platform call names verbatim.
   *
   * `forward: true` rides every click-through (`acceptsInput: false`) call —
   * ONE fixed realization of the one intention this port exposes, not a
   * second knob threaded through from the caller: it is what lets a
   * click-through window's own renderer keep seeing pointer-move, which the
   * chrome overlay's reveal/hover UI (`hybrid-overlay.ts
   * wireClickCapture`/`wireAppActiveGate`) depends on, and Electron simply
   * ignores the options object on an `acceptsInput: true` call.
   */
  setAcceptsInput(id: WindowId, acceptsInput: boolean): void {
    const win = this.windows.get(id)?.win;
    if (!win) return;
    try {
      if (win.isDestroyed()) return;
      win.setIgnoreMouseEvents(!acceptsInput, { forward: true });
    } catch {
      /* torn-down window mid-command — the machine already recorded intent */
    }
  }

  /**
   * Realize an `AttachOverlayTo` effect (`window-kernel.ts Effect`) — a second
   * call site of the SAME frame math `emitBounds` above already uses for
   * `BOUNDS_CHANGED.overlayFrame`, not new capability: resolve `hostId`
   * through the hybrid registry, read its live outer bounds, and expand them
   * (`expandToOverlayFrame` + `workAreaNearest`) into the frame the overlay
   * should occupy.
   *
   * Reports through `kernelOverlayAttached` — the `OverlayAttached`
   * EVENT, never the `AttachOverlay` COMMAND — because this call runs from
   * inside the executor's `performEffect`, mid-`pump()`, against a state that
   * may not yet contain events the same transition already queued; a command
   * decided there is the exact re-entrancy this effect exists to remove (see
   * that helper's doc). Never fed the old `window-state.ts` machine: that
   * machine was on the deletion path, gained no new call sites, and has
   * since been deleted.
   *
   * Reports an attach to `null` (detach) on every failure path — a missing
   * `hostId`, a host not resolvable through the registry, or anything
   * throwing (the window torn down mid-call) — same try/catch discipline as
   * `emitBounds`: read once, report what actually happened, never leave the
   * kernel's belief stuck on a request it cannot honor.
   */
  attachOverlayTo(overlayId: WindowId, hostId: WindowId | null): void {
    if (hostId === null) {
      kernelOverlayAttached(overlayId, null);
      return;
    }
    const win = this.getNativeWindowFor(hostId);
    if (!win) {
      kernelOverlayAttached(overlayId, null);
      return;
    }
    try {
      const bounds = win.getBounds();
      const frame = expandToOverlayFrame(bounds, this.workAreaNearest(bounds));
      kernelOverlayAttached(overlayId, hostId, frame);
    } catch {
      /* host torn down mid-call — nothing left to attach to */
      kernelOverlayAttached(overlayId, null);
    }
  }

  /**
   * Destroy every registered page-host guest WC and resolve once they are
   * actually gone — the quit teardown that used to live in
   * `webview-guest-registry.ts destroyAllPageHostGuests` (peek d1cf0b9a: a
   * guest with an in-flight relay invoke torn down inside `-[NSWindow __close]`
   * → EXC_BAD_ACCESS).
   *
   * The RESOLUTION is the whole point, and it is why this is async. Issuing the
   * `destroy()` calls is not the teardown: `webContents.destroy()` returns
   * without throwing while `isDestroyed()` still reads `false`, so a caller that
   * only called it went on to let Electron close the host windows over six live
   * content WebContents — measured, the exact ordering d1cf0b9a is about. The
   * caller must await this before the quit proceeds; `guest-teardown.ts` bounds
   * the wait per guest AND over the batch so a wedged renderer cannot turn a
   * quit into a hang.
   */
  destroyAllContentGuests(): Promise<void> {
    const guests = this.resolveLiveGuests(getAllGuestWebContentsIds());
    DEBUG && console.log('[window-backend] quit teardown: destroying', guests.length, 'guest(s)');
    return destroyGuestsAndWait(guests, requestGuestDestroy, {
      overallMs: QUIT_GUEST_TEARDOWN_BUDGET_MS,
    });
  }

  /**
   * Hand the user back to whatever they were in before (the `HideApp` effect).
   *
   * macOS ONLY, and that gate is this backend's to hold rather than the
   * kernel's: `app.hide()` is the AppKit notion of an application stepping out
   * of the way, and no other platform this backend runs on has one. A platform
   * without the concept answers with nothing, which is the correct answer — the
   * kernel does not need to know which platforms have it. The previous owner
   * (`windows.ts maybeHideApp`) held the same guard at the same layer.
   *
   * The app coming back is reported through the ordinary activation edge, so
   * there is nothing to echo here.
   */
  hideApp(): void {
    if (process.platform !== 'darwin') return;
    DEBUG && console.log('[window-backend] hiding the app — nothing left holding it on screen');
    app.hide();
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
      // left the whole group → feed the kernel OS_FOCUS_SETTLED_NULL.
      if (this.anyWindowFocused()) return;
      // Feed the kernel — see `window-kernel-dispatch.ts
      // kernelOsFocusSettled` for the shape mismatch this translates
      // (this event carries no id; the kernel's `OsFocusLost` names one).
      kernelOsFocusSettled();
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

  private isVisibleSafe(win: NativeWindow): boolean {
    try {
      return !win.isDestroyed() && win.isVisible();
    } catch {
      return false;
    }
  }

  /**
   * Best-effort URL read for diagnostic logging (`registerWindow`'s identity
   * log) — never throws. Returns '' when the WC is absent, destroyed, or the
   * read otherwise fails (e.g. not yet navigated).
   */
  private urlSafe(wc: NativeWebContents | null): string {
    if (!wc || wc.isDestroyed()) return '';
    try {
      return wc.getURL();
    } catch {
      return '';
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Bounded fullscreen settle timer (§2.3).
  // ───────────────────────────────────────────────────────────────────────────

  private armFullscreenSettle(id: WindowId): void {
    this.clearFullscreenSettle(id);
    this.fullscreenSettleTimers.set(
      id,
      setTimeout(() => {
        this.fullscreenSettleTimers.delete(id);
        kernelFullscreenSettleTimeout(id);
      }, FULLSCREEN_SETTLE_TIMEOUT_MS),
    );
  }

  private clearFullscreenSettle(id: WindowId): void {
    const t = this.fullscreenSettleTimers.get(id);
    if (t) {
      clearTimeout(t);
      this.fullscreenSettleTimers.delete(id);
    }
  }
}
