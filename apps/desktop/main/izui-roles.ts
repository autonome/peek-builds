// IZUI roles: maps `api.window.open` params (role, options) to the derived per-window role,
// class, and the kernel's declared layer/canBecomeKey/acceptsInput attributes. Reasoning for
// the derivations lives in docs/design/window-manager.md, "Window attribute derivation";
// role-set-to-declaration mappings live in docs/design/window-rules-audit.md's role-sets table.
// Pure and Electron-free so it stays unit-testable under ELECTRON_RUN_AS_NODE=1.

import { BASE_LAYER, type WindowKind } from './window-kernel.js';

// The roles whose windows follow the user across desktops. None today: every
// window, transient ones and the page chrome overlay included, belongs to the
// desktop it is shown on (specs/kernel-desktops.md "A transient window never
// follows the user to another desktop"). A window that is on every desktop
// is drawn there during a switch animation, before the kernel hears of the
// switch, so a role only joins this set when that flash is acceptable.
export const FOLLOWING_ROLES: ReadonlySet<string> = new Set();

export interface IzuiRoleContext {
  isWebPage: boolean;
  parentWindowId: number | null;
}

export interface IzuiRoleOptions {
  role?: string;
  overlay?: boolean;
  modal?: boolean;
  keepLive?: boolean;
}

export function inferIzuiRole(
  options: IzuiRoleOptions,
  ctx: IzuiRoleContext,
): string {
  let role = options.role;
  if (!role) {
    if (options.overlay === true) {
      role = 'overlay';
    } else if (options.modal === true && options.keepLive === true) {
      role = 'palette';
    } else if (options.modal === true) {
      role = 'quick-view';
    } else if (ctx.parentWindowId != null && ctx.isWebPage) {
      role = 'child-content';
    } else if (ctx.isWebPage) {
      role = 'content';
    } else {
      role = 'workspace';
    }
  }
  if (role === 'content' && ctx.parentWindowId != null) {
    role = 'child-content';
  }
  return role;
}

// Allow-list, not a deny-list: only these two roles mean "showing a real web page" — an unknown
// or absent role is never treated as one (window-kernel.ts CONTENT_ROLES mirrors this).
export function isWebPageRole(role: string | undefined): boolean {
  return role === 'content' || role === 'child-content';
}

// `modal: true` wires close-on-blur, not an OS-modal dialog — a window that must survive an
// app-switch (any OAuth flow) must not be modal.
export function windowSelfClosesOnBlur(options: { modal?: boolean }): boolean {
  return options.modal === true;
}

// A panel, or an ordinary window the open declared non-activating (a page
// opened over another app where the platform supports that; see `ipc.ts
// windowOpenHandler`).
export function windowNonActivating(options: { type?: string; nonActivating?: boolean }): boolean {
  return options.type === 'panel' || options.nonActivating === true;
}

// Whether an open made while another app is focused (a Peek panel holding key
// over it) is transient. Switched off until the switch-to-page flow (the
// command panel's "Switch to" button, `tile-ipc.ts findOpenWindowIdForUrl()`)
// is settled: while off, a page opened that way opens as an ordinary window
// and brings Peek forward (`pageActivatesFromOtherApp()`), so the user can
// jump from another app straight into an already-open page. Setting this back
// to true restores the transient behaviour and its tests' expectations.
export const TRANSIENT_FROM_OTHER_APP: boolean = false;

// A page opened to show while the user is typing into one of the app's panels
// over another app is a transient page-host window: it takes key and content focus without the
// app coming forward, so the user can use it at once and return to the other
// app by closing it. Only a non-activating window can hold key in an inactive
// app, and that is fixed when the window is built, so the declaration is made
// at open time. A caller's own window type is never overridden, and a window
// opened not to show (session restore) is never a transient page-host window.
export function pageOpensTransient(
  keyHeldWhileAppInactive: boolean,
  options: { show?: boolean; type?: string; regular?: boolean },
): boolean {
  if (!TRANSIENT_FROM_OTHER_APP) return false;
  return pageOpenedFromOtherApp(keyHeldWhileAppInactive, options);
}

// The open `pageOpensTransient()` describes, whatever the switch says.
function pageOpenedFromOtherApp(
  keyHeldWhileAppInactive: boolean,
  options: { show?: boolean; type?: string; regular?: boolean },
): boolean {
  if (options.regular === true) return false;
  return keyHeldWhileAppInactive && options.show !== false && options.type === undefined;
}

// With transience from another app switched off, that same open is an
// ordinary window carrying the user's intent, so its raise is admitted while
// another app is frontmost and Peek comes forward with it.
export function pageActivatesFromOtherApp(
  keyHeldWhileAppInactive: boolean,
  options: { show?: boolean; type?: string; regular?: boolean },
): boolean {
  if (TRANSIENT_FROM_OTHER_APP) return false;
  return pageOpenedFromOtherApp(keyHeldWhileAppInactive, options);
}

// The show option a reuse of an already-open window carries: a user gesture
// (`activation: 'user'`, or a regular open, which is the command line's) asks
// the kernel to raise even while another app is frontmost, so the reused page
// comes forward and activates the app as a fresh open does.
//
// A quick-view surface (a peek or slide: modal, a panel) is re-opened by the
// keystroke that asked for it, the same user intent its fresh open is given
// (`ipc.ts` page-host and browser-window branches). Its reuse carries that
// intent too: without it the raise is not admitted while another app is
// frontmost, so the kept window is shown but never takes key and keystrokes
// reach the app behind it. A window that takes no input is never raised for
// the user.
export function reuseShowActivation(options: {
  activation?: string;
  regular?: boolean;
  modal?: boolean;
  type?: string;
  focusable?: boolean;
  clickThrough?: boolean;
}): { activation?: 'user' } {
  if (options.activation === 'user' || options.regular === true) return { activation: 'user' };
  const takesInput = options.focusable !== false && options.clickThrough !== true;
  const quickView = options.modal === true || options.type === 'panel';
  return takesInput && quickView ? { activation: 'user' } : {};
}

// The one transience decision (specs/kernel-desktops.md "Transient window"),
// recorded as `WindowRecord.transient`. From the open options and whether a
// Peek window holds key while another app is focused, never from role: while
// Peek is focused only a window opened as transient is transient; while
// another app is focused, anything opened to show is, when
// `TRANSIENT_FROM_OTHER_APP` is on. A window that takes no input never is; one
// opened not to show (session restore) is only if it asked to be.
export function windowIsTransient(
  keyHeldWhileAppInactive: boolean,
  options: { modal?: boolean; overlay?: boolean; show?: boolean; focusable?: boolean; clickThrough?: boolean; regular?: boolean },
): boolean {
  if (options.focusable === false || options.clickThrough === true) return false;
  if (options.modal === true || options.overlay === true) return true;
  // An open that declares itself regular (a command-line open: nobody is
  // typing into a Peek panel, whatever stale key the kernel still holds) is
  // never transient by focus.
  if (options.regular === true) return false;
  return TRANSIENT_FROM_OTHER_APP && keyHeldWhileAppInactive && options.show !== false;
}

export function spacesPolicyForRole(
  role: string,
  platform: NodeJS.Platform,
): 'follow' | 'anchor' | 'none' {
  if (platform !== 'darwin') return 'none';
  return FOLLOWING_ROLES.has(role) ? 'follow' : 'anchor';
}

export function desktopMembershipForRole(role: string): 'follow' | 'anchor' {
  return FOLLOWING_ROLES.has(role) ? 'follow' : 'anchor';
}

// Check existence AND destroyed: at quit teardown the WC getter can already be undefined, and
// calling isDestroyed() straight off that throws mid-finalize.
export function shouldCloseContentWCOnFinalize(
  contentWC: { isDestroyed(): boolean } | null | undefined,
): boolean {
  return !!contentWC && !contentWC.isDestroyed();
}

export type QuitCleanupPhase = 'idle' | 'deferred' | 'done';

export interface BeforeQuitDecision {
  preventDefault: boolean;
  scheduleCleanup: boolean;
  nextPhase: QuitCleanupPhase;
}

// Must veto the first quit and defer cleanup off AppKit's synchronous quit dispatch — freeing
// page-host NSViews mid-dispatch is EXC_BAD_ACCESS; `done` must never veto or a missed re-quit hangs forever.
export function planBeforeQuit(phase: QuitCleanupPhase): BeforeQuitDecision {
  switch (phase) {
    case 'idle':
      // First quit: veto it and get the teardown off the AppKit key-event stack.
      return { preventDefault: true, scheduleCleanup: true, nextPhase: 'deferred' };
    case 'deferred':
      // Another quit arrived before the scheduled cleanup ran. Keep vetoing —
      // the queued macrotask still owns the re-quit, so this cannot strand us.
      return { preventDefault: true, scheduleCleanup: false, nextPhase: 'deferred' };
    case 'done':
      // Our own re-quit (or any later one). Let it through, or we never exit.
      return { preventDefault: false, scheduleCleanup: false, nextPhase: 'done' };
  }
}

// The await is load-bearing: re-quitting before guest teardown resolves hands Electron host
// windows to close over live content; requestQuit() runs in `finally`.
export async function runDeferredQuitCleanup(
  cleanup: () => void | Promise<void>,
  requestQuit: () => void,
  onError?: (err: unknown) => void,
): Promise<void> {
  try {
    await cleanup();
  } catch (err) {
    onError?.(err);
  } finally {
    requestQuit();
  }
}

export const RESIZE_EDGE_PX = 8;
export const RESIZE_CORNER_PX = 16;

export type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

// `slack` widens the band for hysteresis: pass a small enter slack while outside the band and a
// wider exit slack once engaged, so boundary jitter can't oscillate the resize cursor.
export function hybridResizeDirAt(
  gx: number,
  gy: number,
  bounds: { x: number; y: number; width: number; height: number },
  edgePx: number,
  cornerPx: number,
  slack: number,
): ResizeDir | null {
  const dl = gx - bounds.x;
  const dr = bounds.x + bounds.width - gx;
  const dt = gy - bounds.y;
  const db = bounds.y + bounds.height - gy;
  // Beyond a little slack outside the frame → not a resize hover.
  if (dl < -slack || dr < -slack || dt < -slack || db < -slack) return null;
  const edge = edgePx + slack;
  const corner = cornerPx + slack;
  const cL = dl <= corner, cR = dr <= corner, cT = dt <= corner, cB = db <= corner;
  // Corners first (a corner is within cornerPx of TWO adjacent edges → diagonal).
  if (cT && cL) return 'nw';
  if (cT && cR) return 'ne';
  if (cB && cL) return 'sw';
  if (cB && cR) return 'se';
  // Then the straight edge strips.
  if (dt <= edge) return 'n';
  if (db <= edge) return 's';
  if (dl <= edge) return 'w';
  if (dr <= edge) return 'e';
  return null;
}

export type DownloadCloseTarget = 'hybrid-host' | 'browser-window' | 'none';

// Hybrid-host must be checked before BrowserWindow — fromWebContents() resolves hybrid content
// to its owning BaseWindow instead of null.
export function downloadCloseTarget(o: {
  isHybridContent: boolean;
  hybridPainted: boolean;
  hasBrowserWindow: boolean;
}): DownloadCloseTarget {
  if (o.isHybridContent) {
    // Painted → a real page the user is browsing. Never close it.
    return o.hybridPainted ? 'none' : 'hybrid-host';
  }
  return o.hasBrowserWindow ? 'browser-window' : 'none';
}

// ─────────────────────────────────────────────────────────────────────────────
// Window surface properties — registration facts → the kernel's three
// orthogonal per-window fields
// ─────────────────────────────────────────────────────────────────────────────

export const FLOATING_LAYER = BASE_LAYER + 1;

export interface WindowSurfaceFacts {
  focusable?: boolean;
  alwaysOnTop?: boolean;
  clickThrough?: boolean;
}

export interface WindowSurfaceProperties {
  layer: number;
  canBecomeKey: boolean;
  acceptsInput: boolean;
}

// Keys on the declared alwaysOnTop, never on role or class.
export function deriveWindowLayer(facts: Pick<WindowSurfaceFacts, 'alwaysOnTop'>): number {
  return facts.alwaysOnTop === true ? FLOATING_LAYER : BASE_LAYER;
}

// Keys on the declared focusable, never on role or class.
export function deriveCanBecomeKey(facts: Pick<WindowSurfaceFacts, 'focusable'>): boolean {
  return facts.focusable !== false;
}

// Keys on the declared clickThrough, never on role or class.
export function deriveAcceptsInput(facts: Pick<WindowSurfaceFacts, 'clickThrough'>): boolean {
  return facts.clickThrough !== true;
}

export function deriveWindowSurface(facts: WindowSurfaceFacts): WindowSurfaceProperties {
  return {
    layer: deriveWindowLayer(facts),
    canBecomeKey: deriveCanBecomeKey(facts),
    acceptsInput: deriveAcceptsInput(facts),
  };
}

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

export type StackingLevel = 'stacked' | 'pinned' | 'excluded';

const SATELLITE_CLASSES: ReadonlySet<WindowClass> = new Set<WindowClass>([
  'hud',
  'background',
  'bridge',
  'offscreen',
  'test-fixture',
  'devtools',
]);

// focusable === false must count as satellite: otherwise the derived Esc grab suppresses while
// the window still can't receive before-input-event either, leaving Esc dead.
export function isSatelliteRegistration(
  role: string,
  opts: { modal?: boolean; focusable?: boolean; windowClass?: WindowClass } = {},
): boolean {
  if (opts.windowClass !== undefined && SATELLITE_CLASSES.has(opts.windowClass)) return true;
  if (role === 'overlay' || role === 'palette' || role === 'switcher') return true;
  if (opts.modal === true) return true;
  if (opts.focusable === false) return true;
  return false;
}

export function classifyWindowRegistration(
  role: string,
  opts: { alwaysOnTop?: boolean; focusable?: boolean } = {},
): WindowClass {
  if (role === 'overlay' || role === 'switcher') return 'overlay';
  if (role === 'palette') return 'palette';
  if (role === 'quick-view') return 'quick-view';
  if (opts.alwaysOnTop === true && opts.focusable === false) return 'hud';
  return 'primary';
}

export interface WindowRegistrationDecision {
  reRegistration: boolean;
  // False on a re-registration — attaching a second listener set would double every event.
  attachNativeListeners: boolean;
  // False on a re-registration, for a page-host, or on caller opt-out: a second Esc interceptor
  // turns one physical Escape into two dispatches.
  attachEscHandler: boolean;
  // Only overwritten on re-registration when the caller actually passed the field, so a later,
  // thinner spec can't blank out a WC the first registration established.
  adoptRendererWC: boolean;
  // Always true, even on a duplicate: the later spec is the richer one, and the pump is an
  // idempotent merge (`reduce`), so re-pumping only refreshes the declared fields.
  pumpRegisteredEvent: boolean;
  // True only because callers register at open time, when an already-visible window is the one
  // just targeted; a re-registration of an already-visible background window must not reuse this.
  pumpShownEvent: boolean;
}

export function decideWindowRegistration(input: {
  alreadyRegistered: boolean;
  kind: WindowKind;
  hasContentWC: boolean;
  attachEscHandlerRequested?: boolean;
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
    pumpShownEvent: nativeVisible === true,
  };
}
