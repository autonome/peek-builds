// window-kernel.ts — the window-manager kernel: state shape, `decide`/`evolve`/`react`.
// Zero value imports — must stay loadable under `node --test`/`electron --test` with no display.
// Design and reasoning: `docs/design/window-manager.md`.

// State shape

export type WindowId = string & { readonly __brand: 'WindowId' };

export type WindowKind = 'page-host' | 'browser';

// Minimal outer-bounds rectangle — enough to stash/restore a pre-fullscreen frame.
export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type FsMode =
  | { name: 'normal' }
  | { name: 'entering'; preBounds: Rectangle | null; pendingDesire?: boolean; unverified?: true }
  | { name: 'fullscreen'; preBounds: Rectangle | null }
  | { name: 'leaving'; preBounds: Rectangle | null; pendingDesire?: boolean; unverified?: true };

export const FULLSCREEN_SETTLE_TIMEOUT_MS = 1500;

export const BASE_LAYER = 0;

export type DesktopMembership = 'follow' | 'anchor';

// A screen and a desktop, opaque: chosen below the backend port, stable while
// the thing exists, and only ever compared. Design: `specs/kernel-desktops.md`
// → "Model".
export type ScreenId = string;
export type DesktopId = string;

// One screen and the desktop it currently shows.
export interface ScreenState {
  readonly id: ScreenId;
  readonly current: DesktopId;
}

// One desktop and the screen it belongs to; `null` = shared by every screen.
export interface DesktopState {
  readonly id: DesktopId;
  readonly screen: ScreenId | null;
}

export interface WindowRecord {
  id: WindowId;
  kind: WindowKind;

  // Index into a fixed ordered layer array. Higher = above.
  layer: number;
  // Electron `focusable` — lets a HUD never hold key with no special case.
  canBecomeKey: boolean;
  acceptsInput: boolean;

  // Creation-time shorthand for logs and singleton lookups. Nothing branches on it.
  class: string;

  role?: string;

  visible: boolean;
  pendingHidden?: boolean;
  // Open order (not use order) — assigned once at registration, never re-derived.
  openSeq: number;
  parentId?: WindowId;

  keepLive?: boolean;

  orderable: boolean;

  // Fullscreen region — orthogonal to `key` and to `order`. See `FsMode`.
  fsMode: FsMode;

  bounds?: Rectangle;
  maximized: boolean;
  preMaxBounds: Rectangle | null;
  desktopMembership?: DesktopMembership;
  // The screen this window was last reported on; absent until a placement report.
  screen?: ScreenId;
  // The desktop this window was last known to be on — a lived fact, absent
  // until the window is first shown or reported. A placement report is
  // authoritative; a genuine show stamps it provisionally; focus never does.
  // A window on every desktop keeps the desktop it was first shown on. Read
  // through `onCurrentDesktop`.
  desktop?: DesktopId;
  // Declared at registration: the backend reports that its platform keeps this
  // window on every desktop whatever is asked. The other source, a role that
  // asks to follow the user, is `desktopMembership === 'follow'`; read both
  // through `isOnEveryDesktop`.
  onEveryDesktop?: boolean;
  pendingProjectedBounds: Rectangle | null;

  overlayFor?: WindowId;

  overlayFrame?: Rectangle;

  lastOpSeq?: number;

  priorKey: WindowId | null;

  // A lived fact, written with `priorKey` each time this window takes key: it
  // is non-activating and took key while the app was inactive — from another
  // app directly, or through a transient Peek window (the palette) that did
  // the same. Its hide or close raises no successor (F7); the user goes back
  // to the other app.
  tookKeyFromAnotherApp?: boolean;

  hiddenByAppBlur?: boolean;

  // DO NOT DELETE as unread: no rule here branches on it, but `window-escape.ts interpretEscape` reads it outside the kernel.
  escapeMode?: 'ignore';

  tracksBaseLayerTop?: boolean;

  selfClosesOnBlur?: boolean;

  // Declared at registration (`izui-roles.ts windowIsTransient`): this window
  // ends when the user leaves it (specs/kernel-desktops.md "Transient
  // window"). Decided from the window-open options and whether the app was
  // focused at open, never from role or feature; every transient rule reads
  // this field and nothing else.
  transient?: boolean;

  // The `type: 'panel'` open declaration; takes key without activating the app.
  nonActivating?: boolean;

  appLifetime?: boolean;

  contentFocused?: boolean;

  // A lived fact, orthogonal to the declared `layer`: this window was asked
  // forward while the app was inactive, so it sits above other applications'
  // windows — without activation and without content focus — until the app
  // becomes active. Written by `withHeldAboveOtherApps` / cleared by
  // `withoutHeldAboveOtherApps` only; see `admitsHoldAboveOtherApps`.
  heldAboveOtherApps?: boolean;
}

export type FocusCause = { kind: 'machine'; opSeq: number } | { kind: 'world' };

export interface State {
  readonly order: readonly WindowRecord[];
  readonly key: WindowId | null;
  // Stale-intent rejection compares against this; bumped by every accepted event.
  readonly version: number;
  readonly opSeqCounter: number;
  readonly appActive: boolean;
  readonly openSeqCounter: number;
  readonly pendingAppResignSweep: boolean;
  readonly lastTeardown: TeardownRequest | null;
  readonly lastFocusAssert: FocusAssertRequest | null;
  readonly lastRaiseRequest: FocusRaiseRequest | null;
  readonly lastAttention: Attention | null;
  readonly pendingColdStartFocus: WindowId | null;
  readonly pendingSelectionFocus: SelectionFocus | null;
  readonly openedInBackground: boolean;
  // The screens and desktops the backend last reported; empty until the first
  // layout report, and then every window counts as on a current desktop.
  readonly screens: readonly ScreenState[];
  readonly desktops: readonly DesktopState[];
  // Switch notices seen, and how many of them a finished desktop read covers.
  // While the first is ahead, `screens[].current` still names the desktop the
  // user left, so no window counts as on a current desktop (`desktopUnread`).
  readonly desktopSwitchCount: number;
  readonly desktopSwitchesRead: number;
  // Focus the platform is expected to hand out by itself after an effect this
  // kernel emitted; a world-caused report matching it is the platform's
  // choice, not the user's (`platformChoseFocus`).
  readonly expectedPlatformFocus: PlatformFocusExpectation;
  // An overlay opened or closed since the app last resigned. That resign is
  // then the platform's churn around the overlay, not the user leaving, so
  // its settle sweeps nothing.
  readonly overlayTransitionSinceResign: boolean;
}

export interface PlatformFocusExpectation {
  // Windows restacked on a platform where restacking hands a window focus.
  // The platform provokes at most one focus for a whole restacking batch.
  readonly stacking: readonly WindowId[];
  // The key window was hidden while the app was active, so the platform
  // hands key to another of the app's windows.
  readonly hide: boolean;
  // The window an activation was asked to put in front. On activation the
  // platform hands key to the app's main window by itself; when a different
  // window was asked for, that focus is the platform's choice, and reporting
  // it would raise the main window back over the one asked for. Spent by the
  // first such focus, by the asked-for window's own focus, or by the app
  // resigning, so it swallows at most one focus.
  readonly activation: WindowId | null;
}

const NO_PLATFORM_FOCUS_EXPECTED: PlatformFocusExpectation = { stacking: [], hide: false, activation: null };

export interface SelectionFocus {
  armer: WindowId;
  target: WindowId;
}

export interface FocusAssertRequest {
  id: WindowId;
  seq: number;
  // Set only by a switcher pick: an explicit choice, so its raise is not held
  // to the current desktop (every other assert is a machine raise).
  switcherPick?: true;
}

export interface FocusRaiseRequest {
  id: WindowId;
  seq: number;
  intent?: 'user';
}

export interface Attention {
  holder: WindowId;
  cause: FocusCause;
  seq: number;
}

export type TeardownRequest =
  | { kind: 'destroy-window'; id: WindowId; seq: number }
  | { kind: 'close-content'; id: WindowId; seq: number }
  | { kind: 'close-window-direct'; id: WindowId; seq: number }
  | { kind: 'destroy-all-guests'; seq: number };

// Events — past-tense facts already happened; `evolve` cannot reject them.

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
      // See `WindowRecord.escapeMode` — one live value, absent is meaningful.
      escapeMode?: 'ignore';
      // Carried through to `WindowRecord.bounds` unchanged by `decide`.
      bounds?: Rectangle;
      // See `WindowRecord.tracksBaseLayerTop` — declared here, nothing reads it yet.
      tracksBaseLayerTop?: boolean;
      // See `WindowRecord.selfClosesOnBlur` — declared here.
      selfClosesOnBlur?: boolean;
      // See `WindowRecord.transient` — declared here.
      transient?: boolean;
      // See `WindowRecord.nonActivating` — declared here.
      nonActivating?: boolean;
      // See `WindowRecord.appLifetime` — declared here.
      appLifetime?: boolean;
      // See `WindowRecord.onEveryDesktop` — declared here, by the backend.
      onEveryDesktop?: boolean;
    }
  | { type: 'WindowShown'; id: WindowId; opSeq?: number }
  // The full screen and desktop layout; replaces `screens` and `desktops`.
  | { type: 'DesktopLayoutReported'; screens: readonly ScreenState[]; desktops: readonly DesktopState[] }
  // One screen now shows `desktop`; an unknown screen is added. Never writes `key`.
  | { type: 'CurrentDesktopChanged'; screen: ScreenId; desktop: DesktopId }
  // The user switched desktop, reported the moment the platform says so and
  // before the backend has read which desktop is now current; carries nothing.
  | { type: 'DesktopSwitchObserved' }
  // The backend finished a desktop read that began after `switchesSeen`
  // switch notices; any `CurrentDesktopChanged` it produced came first.
  | { type: 'DesktopsRead'; switchesSeen: number }
  // Where a registered window is; `null` leaves that field unchanged.
  | { type: 'WindowPlacementReported'; id: WindowId; screen: ScreenId | null; desktop: DesktopId | null; onEveryDesktop: boolean }
  | { type: 'WindowHidden'; id: WindowId; opSeq?: number }
  | { type: 'WindowClosed'; id: WindowId }
  | { type: 'OsFocusGained'; id: WindowId; cause?: FocusCause }
  | { type: 'OsFocusLost'; id: WindowId }
  | { type: 'AppResigned' }
  | { type: 'AppActivated' }
  | { type: 'AppResignSettled' }
  // An overlay (the switcher) opened or closed. Either can make the platform
  // resign and re-activate the app on its own.
  | { type: 'OverlayTransitionObserved' }
  // The first-composited-frame report — flips `orderable` to `true`.
  | { type: 'WindowContentOrderable'; id: WindowId }
  | { type: 'ContentFirstResponderChanged'; id: WindowId; held: boolean }
  | { type: 'WindowAcceptsInputChanged'; id: WindowId; acceptsInput: boolean }
  | { type: 'WindowLayerChanged'; id: WindowId; layer: number }
  | { type: 'FullscreenTransitionStarted'; id: WindowId; entering: boolean; preBounds: Rectangle | null }
  | { type: 'FullscreenDesireRecorded'; id: WindowId; desired: boolean }
  // OS report: the window IS fullscreen now. Settles `entering`/`leaving`/`normal`.
  | { type: 'OsFullscreenEntered'; id: WindowId }
  // OS report: the window is NOT fullscreen now. Settles `leaving`/`entering`/`fullscreen`.
  | { type: 'OsFullscreenLeft'; id: WindowId }
  // The OS never reported a settle for this transition — force it out of `entering`/`leaving`.
  | { type: 'FullscreenSettleTimeout'; id: WindowId }
  | { type: 'BoundsChanged'; id: WindowId; bounds: Rectangle; overlayFrame?: Rectangle }
  | { type: 'DisplayChanged'; projections: ReadonlyArray<{ id: WindowId; bounds: Rectangle }> }
  | { type: 'MaximizeExitedByResize'; id: WindowId }
  | { type: 'Maximized'; id: WindowId; preMaxBounds: Rectangle | null }
  // `decide`'s translation of an accepted `Unmaximize` command — clears `maximized` + `preMaxBounds`.
  | { type: 'Unmaximized'; id: WindowId }
  | { type: 'PendingProjectionDiscarded'; id: WindowId }
  // `decide`'s translation of an accepted `SetDesktopMembership` command.
  | { type: 'DesktopMembershipSet'; id: WindowId; membership: DesktopMembership }
  | { type: 'OverlayAttached'; overlayId: WindowId; hostId: WindowId | null; frame?: Rectangle }
  | { type: 'StackOrderImported'; order: readonly WindowId[] }
  | { type: 'WindowDestroyRequested'; id: WindowId }
  | { type: 'WindowContentCloseRequested'; id: WindowId }
  // The guest-safe direct close — destroy registered guests, await them, then close the host. No keepLive policy.
  | { type: 'WindowDirectCloseRequested'; id: WindowId }
  // Quit teardown: destroy every registered page-host guest WC, process-wide. Names no window.
  | { type: 'GuestTeardownRequested' }
  | { type: 'FocusAssertRequested'; id: WindowId }
  | { type: 'FocusRaiseRequested'; id: WindowId; intent?: 'user' }
  | { type: 'ColdStartFocusArmed'; id: WindowId | null }
  | { type: 'SelectionFocusArmed'; armer: WindowId; target: WindowId | null };

// Commands — rejectable requests; every variant carries `expectedVersion`, and `decide` rejects on a mismatch.

export type Command =
  | { type: 'RaiseWindow'; id: WindowId; expectedVersion: number; intent?: 'user' }
  | { type: 'ShowWindow'; id: WindowId; expectedVersion: number }
  | { type: 'HideWindow'; id: WindowId; expectedVersion: number }
  // The keepLive branch point: hide if keepLive, else close. Decided in `decide`, never `evolve`.
  | { type: 'CloseOrHideWindow'; id: WindowId; expectedVersion: number }
  // Carries the intrinsic properties; `decide` produces a `WindowRegistered` event.
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
      // See `WindowRecord.escapeMode` — one live value, absent is meaningful.
      escapeMode?: 'ignore';
      bounds?: Rectangle;
      // See `WindowRecord.tracksBaseLayerTop` — declared here, nothing reads it yet.
      tracksBaseLayerTop?: boolean;
      // See `WindowRecord.selfClosesOnBlur` — declared here.
      selfClosesOnBlur?: boolean;
      // See `WindowRecord.transient` — declared here.
      transient?: boolean;
      // See `WindowRecord.nonActivating` — declared here.
      nonActivating?: boolean;
      // See `WindowRecord.appLifetime` — declared here.
      appLifetime?: boolean;
      // See `WindowRecord.onEveryDesktop` — declared here, by the backend.
      onEveryDesktop?: boolean;
      expectedVersion: number;
    }
  | { type: 'SetFullscreen'; id: WindowId; desired: boolean; expectedVersion: number }
  | { type: 'SetBounds'; id: WindowId; bounds: Rectangle; expectedVersion: number }
  | { type: 'Maximize'; id: WindowId; workArea?: Rectangle; expectedVersion: number }
  | { type: 'SeedMaximized'; id: WindowId; preMaxBounds: Rectangle | null; expectedVersion: number }
  | { type: 'Unmaximize'; id: WindowId; expectedVersion: number }
  | { type: 'SetDesktopMembership'; id: WindowId; membership: DesktopMembership; expectedVersion: number }
  | { type: 'SetAcceptsInput'; id: WindowId; acceptsInput: boolean; expectedVersion: number }
  // Moves an already-open window between the pinned band (`layer > BASE_LAYER`)
  // and the base band — see docs/design/window-rules.md "Persistent windows:
  // workspace-pinned and global HUD". A fresh, non-registration entry point for
  // the same field `WindowRegistered` sets once at open time.
  | { type: 'SetLayer'; id: WindowId; layer: number; expectedVersion: number }
  | { type: 'AttachOverlay'; overlayId: WindowId; hostId: WindowId | null; frame?: Rectangle; expectedVersion: number }
  | { type: 'ImportStackOrder'; order: readonly WindowId[]; expectedVersion: number }
  | { type: 'DestroyWindow'; id: WindowId; expectedVersion: number }
  | { type: 'CloseContent'; id: WindowId; expectedVersion: number }
  | { type: 'CloseWindowDirect'; id: WindowId; expectedVersion: number }
  | { type: 'DestroyAllGuests'; expectedVersion: number }
  | { type: 'AssertFocus'; id: WindowId; expectedVersion: number }
  | { type: 'ArmColdStartFocus'; id: WindowId | null; expectedVersion: number }
  | { type: 'ArmSelectionFocus'; armer: WindowId; target: WindowId | null; expectedVersion: number };

export type Rejection = 'stale-version' | 'no-such-window' | 'app-lifetime-window';

// Effects — executed by an OS adapter; `ShowWindow`/`RaiseWindow`/`HideWindow` carry `opSeq` for echo provenance, `SetStacking` does not.

export type Effect =
  | { type: 'SetStacking'; id: WindowId; layer: number }
  | { type: 'ShowWindow'; id: WindowId; opSeq: number }
  | { type: 'HideWindow'; id: WindowId; opSeq: number }
  | { type: 'CloseWindow'; id: WindowId; maximized: boolean; preMaxBounds: Rectangle | null }
  | { type: 'DismissWindow'; id: WindowId }
  | { type: 'RaiseWindow'; id: WindowId; opSeq: number; intent?: 'user' }
  // Make `desktop` current on its screen; emitted only just before the raise of a window the user
  // named on a desktop no screen shows. A backend that cannot switch desktops ignores it.
  | { type: 'ShowDesktop'; desktop: DesktopId }
  // Drive the OS into fullscreen — emitted only when a record freshly transitions INTO `entering`.
  | { type: 'SetFullscreen'; id: WindowId }
  // Drive the OS out of fullscreen — emitted only when a record freshly transitions INTO `leaving`.
  | { type: 'ExitFullscreen'; id: WindowId }
  | { type: 'ReconcileFullscreen'; id: WindowId }
  // Move the window's outer bounds — emitted by `react` as a structural diff of `bounds`, never from an event's own payload.
  | { type: 'SetBounds'; id: WindowId; bounds: Rectangle }
  | { type: 'SetDesktopMembership'; id: WindowId; membership: DesktopMembership }
  | { type: 'SetAcceptsInput'; id: WindowId; acceptsInput: boolean }
  // Emitted by `react` as a structural diff of the pinned-band membership
  // `layer` implies — independent of `SetStacking`'s z-order replay below, so
  // an unpin reliably clears the native always-on-top flag rather than
  // depending on a z-order-only effect that never touches it.
  | { type: 'SetPinned'; id: WindowId; pinned: boolean }
  | { type: 'DestroyWindow'; id: WindowId }
  // Tear down the window's content surface — the wedged-guest fallback (see the `CloseContent` command).
  | { type: 'CloseContent'; id: WindowId }
  // Guest-safe direct close: destroy and await the window's guests, then close the host.
  | { type: 'CloseWindowDirect'; id: WindowId }
  // Destroy every registered page-host guest WebContents, process-wide. The one effect that names no window.
  | { type: 'DestroyAllGuests' }
  | { type: 'HideApp' }
  // Keep this window above other applications' windows without activating the
  // app or focusing the window — emitted when `heldAboveOtherApps` goes true.
  | { type: 'HoldAboveOtherApps'; id: WindowId }
  // Return a held window to ordinary stacking — the same window, only its
  // stacking changes. Emitted when `heldAboveOtherApps` goes from true to not-true.
  | { type: 'ReleaseFromAboveOtherApps'; id: WindowId }
  | { type: 'FocusContent'; id: WindowId }
  | { type: 'AttachOverlayTo'; overlayId: WindowId; hostId: WindowId | null };

export function initialState(): State {
  return {
    order: [],
    key: null,
    version: 0,
    opSeqCounter: 0,
    // Launching an app activates it, so this starts true rather than waiting
    // for a first activation report a backend may never send.
    appActive: true,
    openSeqCounter: 0,
    pendingAppResignSweep: false,
    lastTeardown: null,
    lastFocusAssert: null,
    lastRaiseRequest: null,
    lastAttention: null,
    pendingColdStartFocus: null,
    pendingSelectionFocus: null,
    // No windows yet, so no session — the first registration decides this.
    openedInBackground: false,
    screens: [],
    desktops: [],
    desktopSwitchCount: 0,
    desktopSwitchesRead: 0,
    expectedPlatformFocus: NO_PLATFORM_FOCUS_EXPECTED,
    overlayTransitionSinceResign: false,
  };
}

// The next `TeardownRequest.seq` — one per teardown event, monotone, never reused.
function nextTeardownSeq(state: State): number {
  return (state.lastTeardown?.seq ?? 0) + 1;
}

function nextAttentionSeq(state: State): number {
  return (state.lastAttention?.seq ?? 0) + 1;
}

function nextFocusAssertSeq(state: State): number {
  return (state.lastFocusAssert?.seq ?? 0) + 1;
}

function nextRaiseRequestSeq(state: State): number {
  return (state.lastRaiseRequest?.seq ?? 0) + 1;
}

// `OsFullscreenEntered` settles `entering` -> `fullscreen` (or straight through to `leaving` on a coalesced cancel).
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
      // The OS won the race — fullscreen after all; a pendingDesire recorded here is dropped, not honored.
      return { name: 'fullscreen', preBounds: mode.preBounds };
    case 'fullscreen':
      return mode;
  }
}

// `OsFullscreenLeft` settles `leaving` -> `normal` (or straight through to `entering` on a coalesced re-enter).
function nextFsModeForOsLeft(mode: FsMode): FsMode {
  switch (mode.name) {
    case 'fullscreen':
      // Green-button/OS-initiated leave — clears the stash.
      return { name: 'normal' };
    case 'leaving':
      // Honor a coalesced "actually, re-enter" desire; no captured bounds here.
      return mode.pendingDesire === true ? { name: 'entering', preBounds: null } : { name: 'normal' };
    case 'entering':
      // Aborted by the OS mid-enter; a pendingDesire recorded here is dropped, not honored.
      return { name: 'normal' };
    case 'normal':
      return mode;
  }
}

function markFsModeUnverified(mode: FsMode): FsMode {
  if (mode.name !== 'entering' && mode.name !== 'leaving') return mode;
  return { ...mode, unverified: true };
}

// Whether a mode is a still-in-flight transition the machine has flagged unverified.
function isFsModeUnverified(mode: FsMode): boolean {
  return (mode.name === 'entering' || mode.name === 'leaving') && mode.unverified === true;
}

// Field-wise `Rectangle` equality — `bounds` diffs by value, never by reference.
function boundsEqual(a: Rectangle | undefined, b: Rectangle | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function withPendingProjectionFlushed(record: WindowRecord): WindowRecord {
  if (record.pendingProjectedBounds === null) return record;
  if (record.fsMode.name !== 'normal' || !record.visible) return record;
  return { ...record, bounds: record.pendingProjectedBounds, pendingProjectedBounds: null };
}

// The record patch `overlayFollowPatch` can produce — see that function.
type OverlayFollowPatch = Partial<Pick<WindowRecord, 'overlayFrame' | 'visible' | 'hiddenByAppBlur'>>;

function overlayFollowPatch(overlay: WindowRecord, hostNormal: boolean, appActive: boolean, frame: Rectangle | undefined): OverlayFollowPatch {
  if (!hostNormal) {
    // A non-normal host hides and returns — no frame write, even when one was given, and no reveal.
    return overlay.visible ? { visible: false } : {};
  }
  const patch: OverlayFollowPatch = {};
  if (frame !== undefined) patch.overlayFrame = frame;
  if (appActive && !overlay.visible) {
    patch.visible = true;
    // `hiddenByAppBlur` can never be true on a visible window — cleared here the same way `WindowShown` clears it on a genuine show.
    if (overlay.hiddenByAppBlur === true) patch.hiddenByAppBlur = false;
  }
  return patch;
}

export function evolve(state: State, ev: Event): State {
  return followHeldHostOverlay(state, markEndedKeyTakenFromAnotherApp(state, evolveEvent(state, ev)));
}

// The page chrome overlay over a page opened while another app is active: a
// structural diff, like `markEndedKeyTakenFromAnotherApp`. With the app
// inactive, an overlay starts to be over a host for which
// `holdsKeyTakenFromAnotherApp` holds → shown; it stops (the page ended, key
// went elsewhere, the overlay moved to another host) → hidden, marked
// `hiddenByAppBlur` so `AppActivated` reveals it the same way it does after a
// resign. Only the flip acts, so an OS report of the overlay's own show or
// hide is never overruled. With the app active, `overlayFollowPatch` and
// `AppActivated` own the overlay's visibility.
function overlayOverHeldHost(state: State, overlay: WindowRecord): boolean {
  if (state.appActive || overlay.overlayFor === undefined || overlay.pendingHidden === true) return false;
  const host = state.order.find((h) => h.id === overlay.overlayFor);
  return host !== undefined && host.fsMode.name === 'normal' && host.pendingHidden !== true && holdsKeyTakenFromAnotherApp(state, host);
}

function followHeldHostOverlay(prev: State, next: State): State {
  const flip = (w: WindowRecord): 'show' | 'hide' | null => {
    const before = prev.order.find((p) => p.id === w.id);
    const was = before !== undefined && overlayOverHeldHost(prev, before);
    const is = overlayOverHeldHost(next, w);
    if (is && !was && !w.visible) return 'show';
    if (was && !is && w.visible && !next.appActive) return 'hide';
    return null;
  };
  if (!next.order.some((w) => flip(w) !== null)) return next;
  // A show is stamped like every other: one counter step per transition,
  // shared with any show or raise the event itself issued.
  const issuesShow = next.order.some((w) => flip(w) === 'show' && prev.order.some((p) => p.id === w.id && !p.visible));
  const opSeq = issuesShow && next.opSeqCounter === prev.opSeqCounter ? next.opSeqCounter + 1 : next.opSeqCounter;
  return {
    ...next,
    order: next.order.map((w) => {
      const f = flip(w);
      if (f === 'hide') return { ...w, visible: false, hiddenByAppBlur: true };
      if (f !== 'show') return w;
      const shown = { ...w, visible: true, ...(w.hiddenByAppBlur === true ? { hiddenByAppBlur: false } : {}), lastOpSeq: opSeq };
      return withShownDesktop(next, w, shown);
    }),
    opSeqCounter: opSeq,
  };
}

// A transient window that held key taken from another app ended in this
// transition: a structural diff of `holdsKeyTakenFromAnotherApp` per record.
// Every way it can stop holding that key ends it, including the app coming
// forward while it holds key (5e): it was asked for while Peek was not
// focused, so it ends when that moment ends, and a page stays reachable from
// history. Marked `pendingHidden`, so `react`'s dismissal diff closes or hides
// it once and a later rule (a desktop read) does not end it again. A window
// that hid or closed in this very transition (Escape, a close request) or is
// already marked needs nothing.
function markEndedKeyTakenFromAnotherApp(prev: State, next: State): State {
  const ended = (w: WindowRecord): boolean => {
    if (!w.visible || w.pendingHidden === true) return false;
    const before = prev.order.find((p) => p.id === w.id);
    return before !== undefined && holdsKeyTakenFromAnotherApp(prev, before) && !holdsKeyTakenFromAnotherApp(next, w);
  };
  if (!next.order.some(ended)) return next;
  return { ...next, order: next.order.map((w) => (ended(w) ? { ...w, pendingHidden: true } : w)) };
}

function evolveEvent(state: State, ev: Event): State {
  switch (ev.type) {
    case 'WindowRegistered': {
      // Re-registration of a still-live id is real, expected traffic (e.g. a
      // tile-launch path can register the same window twice) — a merge, not
      // a rejection: declared-at-registration properties overwrite the
      // existing record, but LIVED facts (`visible`, `openSeq`, position in
      // `order`) are preserved. Re-registration is not a raise.
      const existingIdx = state.order.findIndex((w) => w.id === ev.id);
      if (existingIdx !== -1) {
        const existing = state.order[existingIdx];
        const merged: WindowRecord = {
          id: existing.id,
          kind: ev.kind,
          layer: ev.layer,
          canBecomeKey: ev.canBecomeKey,
          // A lived fact, never taken from a re-registration event — a producer
          // can re-derive click-through state without seeing an out-of-band
          // toggle, and taking the event's value would silently undo it.
          acceptsInput: existing.acceptsInput,
          class: ev.class,
          visible: existing.visible,
          openSeq: existing.openSeq,
          // Never reset once true: a re-registration that names 'browser' also sets it true; it cannot flip back off.
          orderable: existing.orderable || ev.kind === 'browser',
          // Lived facts — preserved across a re-registration merge, never reset.
          fsMode: existing.fsMode,
          maximized: existing.maximized,
          preMaxBounds: existing.preMaxBounds,
          pendingProjectedBounds: existing.pendingProjectedBounds,
          // A lived fact once the OS has reported one, so a re-registration must
          // not clobber it — the event's `bounds` seed only fills an EMPTY
          // mirror, exactly like the fresh-record branch below.
          ...(existing.bounds !== undefined ? { bounds: existing.bounds } : ev.bounds !== undefined ? { bounds: ev.bounds } : {}),
          // Lived facts — re-registration must not forget an answer already given.
          ...(existing.desktopMembership !== undefined ? { desktopMembership: existing.desktopMembership } : {}),
          ...(existing.desktop !== undefined ? { desktop: existing.desktop } : {}),
          ...(existing.screen !== undefined ? { screen: existing.screen } : {}),
          ...(existing.overlayFor !== undefined ? { overlayFor: existing.overlayFor } : {}),
          ...(existing.overlayFrame !== undefined ? { overlayFrame: existing.overlayFrame } : {}),
          ...(existing.lastOpSeq !== undefined ? { lastOpSeq: existing.lastOpSeq } : {}),
          // A re-registration names no focus history, so it must not overwrite
          // whatever this window's own `OsFocusGained` already recorded.
          priorKey: existing.priorKey,
          ...(existing.tookKeyFromAnotherApp !== undefined ? { tookKeyFromAnotherApp: existing.tookKeyFromAnotherApp } : {}),
          ...(existing.hiddenByAppBlur !== undefined ? { hiddenByAppBlur: existing.hiddenByAppBlur } : {}),
          ...(existing.pendingHidden !== undefined ? { pendingHidden: existing.pendingHidden } : {}),
          // Dropping this would silently turn an observed `false` back into "nothing reported yet", a different answer.
          ...(existing.contentFocused !== undefined ? { contentFocused: existing.contentFocused } : {}),
          // A lived fact too: dropping it would strand the window above other apps with no release ever issued.
          ...(existing.heldAboveOtherApps !== undefined ? { heldAboveOtherApps: existing.heldAboveOtherApps } : {}),
          // Intrinsic, declared-at-registration properties — an event that
          // names one overwrites; an event that omits one keeps the existing
          // value rather than erasing it.
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
          // Declared facts: an event that names one overwrites, an event that
          // omits one keeps the existing value — absent means "this producer
          // did not report an override", not "clear the override".
          ...(ev.escapeMode !== undefined
            ? { escapeMode: ev.escapeMode }
            : existing.escapeMode !== undefined
              ? { escapeMode: existing.escapeMode }
              : {}),
          ...(ev.tracksBaseLayerTop !== undefined
            ? { tracksBaseLayerTop: ev.tracksBaseLayerTop }
            : existing.tracksBaseLayerTop !== undefined
              ? { tracksBaseLayerTop: existing.tracksBaseLayerTop }
              : {}),
          ...(ev.selfClosesOnBlur !== undefined
            ? { selfClosesOnBlur: ev.selfClosesOnBlur }
            : existing.selfClosesOnBlur !== undefined
              ? { selfClosesOnBlur: existing.selfClosesOnBlur }
              : {}),
          ...(ev.transient !== undefined
            ? { transient: ev.transient }
            : existing.transient !== undefined
              ? { transient: existing.transient }
              : {}),
          ...(ev.nonActivating !== undefined
            ? { nonActivating: ev.nonActivating }
            : existing.nonActivating !== undefined
              ? { nonActivating: existing.nonActivating }
              : {}),
          ...(ev.appLifetime !== undefined
            ? { appLifetime: ev.appLifetime }
            : existing.appLifetime !== undefined
              ? { appLifetime: existing.appLifetime }
              : {}),
          ...(ev.onEveryDesktop !== undefined
            ? { onEveryDesktop: ev.onEveryDesktop }
            : existing.onEveryDesktop !== undefined
              ? { onEveryDesktop: existing.onEveryDesktop }
              : {}),
        };
        // A reversible hide must never survive into a transient identity it
        // would not have been given: if this merge is what makes the record
        // transient, ask `transientAutocloseExemption` directly against the
        // post-merge identity rather than the stale pre-merge one, with no
        // focuser (a re-registration names none) — and reveal it now rather
        // than leave it for `AppActivated` to resurrect later.
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
        // `orderable` starts true only for 'browser'; a 'page-host' starts false and flips via `WindowContentOrderable`.
        orderable: ev.kind === 'browser',
        fsMode: { name: 'normal' },
        // Seeded from the caller's construction-time rect when supplied — the
        // sole other writer of this mirror is the backend's native resize/move
        // echo, and a window placed at construction fires neither until its first gesture.
        ...(ev.bounds !== undefined ? { bounds: ev.bounds } : {}),
        maximized: false,
        preMaxBounds: null,
        // `desktopMembership` is deliberately NOT seeded — registration is exactly the moment nobody has asked yet.
        pendingProjectedBounds: null,
        // Registration is exactly the moment nothing has taken key yet, so nothing held it before.
        priorKey: null,
        ...(ev.role !== undefined ? { role: ev.role } : {}),
        ...(ev.parentId !== undefined ? { parentId: ev.parentId } : {}),
        ...(ev.keepLive !== undefined ? { keepLive: ev.keepLive } : {}),
        ...(ev.escapeMode !== undefined ? { escapeMode: ev.escapeMode } : {}),
        ...(ev.tracksBaseLayerTop !== undefined ? { tracksBaseLayerTop: ev.tracksBaseLayerTop } : {}),
        ...(ev.selfClosesOnBlur !== undefined ? { selfClosesOnBlur: ev.selfClosesOnBlur } : {}),
        ...(ev.transient !== undefined ? { transient: ev.transient } : {}),
        ...(ev.nonActivating !== undefined ? { nonActivating: ev.nonActivating } : {}),
        ...(ev.appLifetime !== undefined ? { appLifetime: ev.appLifetime } : {}),
        ...(ev.onEveryDesktop !== undefined ? { onEveryDesktop: ev.onEveryDesktop } : {}),
        // `desktop` is deliberately NOT seeded: a window is on no desktop until it is first shown.
        // `contentFocused` is deliberately NOT seeded: registration is the moment nothing has been reported yet.
      };
      // Nothing else orders windows. A fresh registration is placed BELOW the
      // last-focused window, never on top — a background-opened window does
      // not appear above the window being worked in. Taking focus
      // (`OsFocusGained`) is the only other event that moves anything, and it
      // raises its target on its own, so the two rules stay complete and disjoint.
      //
      // The insertion index is the key window's own: a focus gain always moves
      // its target to the end, so the key window is the last element of
      // `order` whenever it resolves, and inserting just before it reads as
      // "directly under the window in use". With no key window, the record appends on top.
      const keyIdx = state.key === null ? -1 : state.order.findIndex((w) => w.id === state.key);
      const insertAt = keyIdx === -1 ? state.order.length : keyIdx;
      // Whether Peek's windows came up while the user was in another app: the
      // first window decides the answer from `appActive`; a later window
      // opening while the app is active clears it (the user has arrived); a
      // later window opening while inactive changes nothing (one-way ratchet).
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
      // Never reorders: a show states that a window became visible, not that
      // it became the one in use — where it sits changes only on focus.
      //
      // `lastOpSeq` is stamped only when this genuinely flips `visible` (the
      // same condition `react` uses to emit `ShowWindow`); an already-visible
      // window re-shown issues no op, so the counter does not move either.
      const issuesShow = state.order.some((w) => w.id === ev.id && !w.visible);
      const opSeq = issuesShow ? state.opSeqCounter + 1 : state.opSeqCounter;
      return {
        ...state,
        order: state.order.map((w) => {
          if (w.id !== ev.id) return w;
          // Any `WindowShown` makes the window visible, so a stale sweep mark
          // is cleared here too — `hiddenByAppBlur` can never be true on a
          // visible window. A window never swept keeps the field absent.
          const flushed = withPendingProjectionFlushed({
            ...w,
            visible: true,
            ...(w.hiddenByAppBlur === true ? { hiddenByAppBlur: false } : {}),
            // A genuine show clears a doomed mark too — the OS put the window back, so the teardown did not (yet) happen.
            ...(w.pendingHidden === true ? { pendingHidden: false } : {}),
          });
          // A genuine show stamps the current desktop of the window's screen,
          // provisionally until a placement report; a window on every desktop
          // that is not transient keeps the one it was first shown on.
          if (w.visible) return flushed;
          return { ...withShownDesktop(state, w, flushed), lastOpSeq: opSeq };
        }),
        opSeqCounter: opSeq,
        version: state.version + 1,
      };
    }

    case 'WindowHidden': {
      // Successor raise: when the window going off screen is the one holding
      // key, hiding it must not leave nothing focused. `key` and `order` are
      // left untouched here — the successor is asked for on `lastRaiseRequest`,
      // the same fact a `RaiseWindow` command leaves, and the OS's echo of the
      // raise `react` diffs from it writes `key`. `isContentWindow` already
      // excludes the hidden record from `successorOnHide`'s fallback.
      //
      // A duplicate hide (the backend echo plus the lagged native event) must
      // stay inert — `hidesGenuinely` gates the whole rule on the record
      // existing and currently `visible === true`. The `appActive` test
      // excludes `AppResignSettled`'s reversible hide.
      const target = state.order.find((w) => w.id === ev.id);
      const hidesGenuinely = target !== undefined && target.visible === true;
      // The confirming echo clears a doomed mark, genuine or not — this is the report a teardown was waiting for.
      // A hold ends with the window leaving the screen — `heldAboveOtherApps`
      // can never be true on a hidden window, so a later show (a keepLive
      // reuse, a restore-style show) starts from ordinary stacking.
      const order = state.order.map((w) =>
        w.id === ev.id
          ? {
              ...w,
              visible: false,
              ...(w.pendingHidden === true ? { pendingHidden: false } : {}),
              ...(w.heldAboveOtherApps === true ? { heldAboveOtherApps: false } : {}),
            }
          : w,
      );
      const successor =
        hidesGenuinely && state.key === ev.id && state.appActive === true
          ? successorOnHide({ ...state, order }, target!)
          : null;
      const opSeq = successor !== null ? state.opSeqCounter + 1 : state.opSeqCounter;
      return {
        ...state,
        order: successor !== null ? order.map((w) => (w.id === successor.id ? { ...w, lastOpSeq: opSeq } : w)) : order,
        opSeqCounter: opSeq,
        ...(successor !== null ? { lastRaiseRequest: { id: successor.id, seq: nextRaiseRequestSeq(state) } } : {}),
        version: state.version + 1,
      };
    }

    case 'WindowClosed': {
      // Removal is the only way membership shrinks. `key`, even naming this
      // id, is left untouched — a dangling key id is unobservable rather than
      // repaired here. A record whose `overlayFor` names the closed id is
      // detached in the same pass, clearing `visible`/`pendingHidden` too so a
      // queued sweep never acts on a stale fact ahead of the native-hide echo.
      // A record whose `priorKey` names the closed id is nulled here too —
      // `successorOnHide` must never consult a prior key holder that no longer exists.
      const closedRec = state.order.find((w) => w.id === ev.id);
      const filtered = state.order
        .filter((w) => w.id !== ev.id)
        .map((w) => {
          const detached =
            w.overlayFor === ev.id
              ? {
                  ...w,
                  overlayFor: undefined,
                  ...(w.visible ? { visible: false } : {}),
                  ...(w.pendingHidden === true ? { pendingHidden: false } : {}),
                }
              : w;
          return w.priorKey === ev.id ? { ...detached, priorKey: null } : detached;
        });
      // Parent refocus: a closing window that held key while the app was
      // active hands the raise to its parent, when `refocusesParent` admits
      // it; `react` diffs the same answer into a `RaiseWindow` effect below.
      // A child closing without key, or with the app inactive, raises nothing.
      //
      // `key` is left untouched — the OS's echo of the raise will write it —
      // but the parent's `lastOpSeq` is stamped and the parent moved to the
      // top of `order` whenever the raise fires, matching `react`'s emission.
      const parent = closedRec?.parentId !== undefined ? filtered.find((w) => w.id === closedRec.parentId) : undefined;
      const raisesParent = closedRec !== undefined && parent !== undefined && refocusesParent(state, closedRec, parent);
      // `pendingSelectionFocus` names a switcher and the window the user
      // picked; this close is the spend when it is that switcher going away.
      // One-shot — cleared below regardless of whether the target survives.
      // A pick names its window, so it may be on another desktop (rule 1).
      //
      // The raise goes through `lastFocusAssert`: `react` is a pure structural
      // diff that may not branch on `ev.type`, so the request must become a
      // fact it can diff, emitted last so an explicit selection lands on top
      // of a structural parent handoff.
      const spentSelection = state.pendingSelectionFocus?.armer === ev.id
        ? state.pendingSelectionFocus
        : null;
      const selectionTarget = spentSelection !== null
        ? filtered.find((w) => w.id === spentSelection.target && admitsFocus(state, w, SWITCHER_PICK))
        : undefined;
      // Successor raise: a closed key holder that neither hands off to a
      // parent nor spends a selection asks for `successorOnHide`'s answer on
      // `lastRaiseRequest`, exactly as the `WindowHidden` arm does — a
      // parentless transient (the switcher) closes rather than hides, and its
      // prior key holder gets key back the same way. Read off `filtered`, so a
      // `priorKey` naming the closed record itself is already nulled.
      const successor =
        closedRec !== undefined && closedRec.id === state.key && state.appActive === true && !raisesParent && selectionTarget === undefined
          ? successorOnHide({ ...state, order: filtered }, closedRec)
          : null;
      // One token for the transition, not one per effect: this arm can issue
      // two focus-family ops (parent handoff, selection raise), and both get
      // stamped with the same `next.opSeqCounter`.
      const opSeq = raisesParent || selectionTarget !== undefined || successor !== null
        ? state.opSeqCounter + 1
        : state.opSeqCounter;
      const withParent = raisesParent
        ? [...filtered.filter((w) => w.id !== parent!.id), { ...parent!, lastOpSeq: opSeq }]
        : filtered;
      // The selection target is stamped but never reordered — `key` and the
      // stack position it implies are the OS echo's to write, same as every
      // other raise. Applied after the parent map so a window that is both the
      // parent and the selection target is stamped once either way.
      const order = selectionTarget !== undefined
        ? withParent.map((w) => (w.id === selectionTarget.id ? { ...w, lastOpSeq: opSeq } : w))
        : successor !== null
          ? withParent.map((w) => (w.id === successor.id ? { ...w, lastOpSeq: opSeq } : w))
          : withParent;
      return {
        ...state,
        order,
        opSeqCounter: opSeq,
        ...(spentSelection !== null
          ? {
              pendingSelectionFocus: null,
              lastFocusAssert: { id: spentSelection.target, seq: nextFocusAssertSeq(state), switcherPick: true },
            }
          : {}),
        ...(successor !== null ? { lastRaiseRequest: { id: successor.id, seq: nextRaiseRequestSeq(state) } } : {}),
        // The session ends when its window stack empties — reset here so the next session answers from its own first window.
        ...(order.length === 0 ? { openedInBackground: false } : {}),
        expectedPlatformFocus: withoutStackingExpectation(state.expectedPlatformFocus, ev.id),
        version: state.version + 1,
      };
    }

    case 'OsFocusGained': {
      // `key` is a reported fact, written only here. A raise moves the
      // focused window to the top of `order`; a window not currently
      // registered still gets recorded as `key` (resolves to null via `keyWindow`).
      //
      // `lastAttention` is written alongside `key` in both branches below,
      // unconditionally — every report, including one that re-confirms the
      // window already holding key, needs a fresh distinct `seq` for `react`
      // to diff against.
      //
      // A focus the platform handed out by itself, after an effect this
      // kernel emitted, is recorded as spent and otherwise ignored.
      const provoked = platformChoseFocus(state, ev.id, ev.cause ?? WORLD_CAUSE);
      const expectedPlatformFocus = spendPlatformFocusExpectation(state.expectedPlatformFocus, ev.id, provoked);
      if (provoked !== null) {
        return { ...state, expectedPlatformFocus, version: state.version + 1 };
      }
      const idx = state.order.findIndex((w) => w.id === ev.id);
      if (idx === -1) {
        const attention: Attention = { holder: ev.id, cause: ev.cause ?? { kind: 'world' }, seq: nextAttentionSeq(state) };
        return { ...state, key: ev.id, lastAttention: attention, expectedPlatformFocus, version: state.version + 1 };
      }
      const record = state.order[idx];
      // A raise echo for the window already holding key re-confirms the standing attention:
      // fresh `seq`, same cause, so the echo never arms a machine floor over a world report.
      const reconfirmsStanding =
        state.key === ev.id && state.lastAttention !== null && state.lastAttention.holder === ev.id && isOpConfirmation(record, ev.cause);
      const attention: Attention =
        reconfirmsStanding && state.lastAttention !== null
          ? { ...state.lastAttention, seq: nextAttentionSeq(state) }
          : { holder: ev.id, cause: ev.cause ?? { kind: 'world' }, seq: nextAttentionSeq(state) };
      const withoutRecord = [...state.order.slice(0, idx), ...state.order.slice(idx + 1)];
      // `lastOpSeq` is stamped only when this genuinely takes key — same
      // condition `react` uses to emit `RaiseWindow`. Gated on
      // `admitsFocus` (a hidden or doomed target drives no raise — the
      // report is stale evidence of a raise that preceded the hide) and not on
      // a confirmation (`isOpConfirmation`): the echo of an op issued by
      // another transition (a successor raise, a parent refocus, a focus
      // assert) must not raise the same window a second time.
      // Gated on the desktop too: a late report for a window on a desktop the
      // user just left must not pull the user back to it.
      const issuesRaise = state.key !== ev.id && admitsFocus(state, record, MACHINE_REQUEST) && !isOpConfirmation(record, ev.cause);
      const opSeq = issuesRaise ? state.opSeqCounter + 1 : state.opSeqCounter;
      // Written alongside `key`, only when this report hands key to a different window than whoever held it.
      const takesKey = state.key !== ev.id;
      // Focus never stamps `desktop`: a placement report or a genuine show does.
      const movedRecord = {
        ...record,
        ...(issuesRaise ? { lastOpSeq: opSeq } : {}),
        ...(takesKey ? { priorKey: state.key, tookKeyFromAnotherApp: !state.appActive && record.nonActivating === true } : {}),
      };
      const order = [...withoutRecord, movedRecord];
      // Mark this transition's own sweep victims `pendingHidden` here, off the
      // state this write is about to produce, so `react`'s dismissal diff only
      // observes the mark rather than re-deriving it.
      const sweepVictims = new Set(selectTransientAutoclose({ ...state, order }, ev.id, attention.cause));
      return {
        ...state,
        order: sweepVictims.size > 0 ? order.map((w) => (sweepVictims.has(w.id) ? { ...w, pendingHidden: true } : w)) : order,
        key: ev.id,
        opSeqCounter: opSeq,
        lastAttention: attention,
        expectedPlatformFocus,
        version: state.version + 1,
      };
    }

    case 'OsFocusLost': {
      // Only clears `key` if this id is the one currently holding it — a
      // stale/duplicate report about a window that isn't key is a no-op, not
      // a repair. A window that lost focus is no longer about to be handed it
      // by a restack.
      return {
        ...state,
        key: state.key === ev.id ? null : state.key,
        expectedPlatformFocus: withoutStackingExpectation(state.expectedPlatformFocus, ev.id),
        version: state.version + 1,
      };
    }

    case 'AppResigned': {
      // Arms the sweep — hides nothing yet, since this may be the resign half
      // of a dance an `AppActivated` is about to cancel.
      //
      // Attached overlays and sweep-eligible floaters hide here, on the raw
      // edge, rather than waiting for the settle: `layer > BASE_LAYER` means a
      // window sits above other applications' windows too, and waiting out the
      // settle delay would leave it floating over the app the user switched
      // to. The hide is reversible and `AppActivated` reverses it.
      //
      // Attachment and `layer`, never role, select the victims — an attached
      // overlay's visibility belongs to its attachment and is never dismissed;
      // `isAppResignSweepEligible` also excludes transient windows, which the
      // settle dismisses rather than hides. An already-hidden window is
      // left alone, so a fullscreen host's overlay stays off screen.
      //
      // No `opSeq` is stamped — `HideWindow` carries no token. `key`/`order` untouched.
      //
      // A reversible hide must never claim a dismissal victim: `dismissVictims`
      // is `selectTransientAutoclose`'s answer with no focuser (an app resign
      // names none). `!w.pendingHidden` excludes a transient an earlier sweep
      // already marked, so this cannot resurrect a window already committed to dismissal.
      const dismissVictims = new Set(selectTransientAutoclose(state, null));
      const hidesImmediately = (w: WindowRecord): boolean =>
        !w.pendingHidden && !dismissVictims.has(w.id) && w.visible && (w.overlayFor !== undefined || isAppResignSweepEligible(w));
      const hidesSomething = state.order.some(hidesImmediately);
      // Every expectation ends here: the activation's with it, and focus has
      // left every window, so nothing the platform was about to hand out
      // after a restack or a hide is still coming. A hide the platform made
      // itself (the app hidden) is recorded like the kernel's own, and this
      // resign is what clears it before the user's next click.
      return {
        ...state,
        appActive: false,
        pendingAppResignSweep: true,
        expectedPlatformFocus: NO_PLATFORM_FOCUS_EXPECTED,
        overlayTransitionSinceResign: false,
        order: hidesSomething
          ? state.order.map((w) => (hidesImmediately(w) ? { ...w, visible: false, hiddenByAppBlur: true } : w))
          : state.order,
        version: state.version + 1,
      };
    }

    case 'AppActivated': {
      // Disarm — the dance cancel. Re-show exactly the windows a prior
      // `AppResignSettled` sweep hid, clearing the mark; anything hidden for
      // another reason is untouched. `key`/`order` are never touched here.
      const reshown = state.order.some((w) => appBlurRevealAdmits(state, w) && !w.visible);

      // `pendingColdStartFocus` names the window a restore asked a later
      // activation to put back in front; the latch is spent unconditionally
      // here — one-shot, and only a fresh arm ever refills it.
      //
      // Spent as an assert fact, not a move in `order`: the latch covers the
      // case where the model already believes the armed window is on top and
      // only the OS disagrees, which a reorder would diff to nothing.
      // `react`'s assert rule is the last rule it runs, so the raise lands
      // after this transition's re-show work regardless of field order here.
      // `key` is not written — the focus echo the raise provokes moves it.
      const latched = state.pendingColdStartFocus;
      // A token is minted for a transition that issues at least one op; a latch that raises nothing issues none.
      //
      // Visibility is tested POST-re-show, not `state`'s: `react` runs its
      // assert rule against `next`, so a latch naming a window this very
      // activation is about to re-show is raise-eligible even though `state`
      // still has it hidden — `appBlurRevealAdmits` is reused, not restated,
      // so the two can never drift apart.
      // A latched window that holds key taken from another app ends in this
      // very transition (5e, `markEndedKeyTakenFromAnotherApp`), so the latch is
      // spent on nothing: no stamp, and no focus assert names it.
      const latchedCandidate = latched !== null ? state.order.find((w) => w.id === latched) : undefined;
      const latchEnds = latchedCandidate !== undefined && holdsKeyTakenFromAnotherApp(state, latchedCandidate);
      const latchedRecord = latchEnds ? undefined : latchedCandidate;
      const assertsFocus =
        latchedRecord !== undefined &&
        admitsFocus({ ...state, appActive: true }, latchedRecord, MACHINE_REQUEST, latchedRecord.visible === true || appBlurRevealAdmits(state, latchedRecord));

      // Fullscreen reconcile sweep: macOS can enter or leave fullscreen while
      // Peek is backgrounded, so a transition still marked `entering`/`leaving`
      // here may have completed unobserved — mark it `unverified` rather than
      // trust it as-is; `react`'s reconcile rule turns the mark into one
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
          // Every window held above other apps returns to ordinary stacking:
          // the app is the active one now, so its windows stack as its own.
          const released = w.heldAboveOtherApps === true;
          if (!reshow && !stamped && !released && unverifiedMode === w.fsMode) {
            return w;
          }
          const next = {
            ...w,
            ...(released ? { heldAboveOtherApps: false } : {}),
            ...(reshow ? { visible: true, hiddenByAppBlur: false } : {}),
            ...(stamped ? { lastOpSeq: opSeq } : {}),
            fsMode: unverifiedMode,
          };
          return reshow ? withShownDesktop(state, w, next) : next;
        }),
        opSeqCounter: opSeq,
        pendingColdStartFocus: null,
        // Expected only for a window this activation leaves on screen.
        expectedPlatformFocus: {
          ...state.expectedPlatformFocus,
          activation:
            latchedCandidate !== undefined && (latchedCandidate.visible || appBlurRevealAdmits(state, latchedCandidate))
              ? latchedCandidate.id
              : null,
        },
        // The other half of the ratchet: the user has come to Peek, so
        // whatever is on screen is somewhere they are now. Unconditional and one-way.
        openedInBackground: false,
        // Untouched when no latch was held — an activation that was not asked
        // to re-raise anything must not bump the assert `seq`.
        lastFocusAssert:
          latched !== null && !latchEnds ? { id: latched, seq: nextFocusAssertSeq(state) } : state.lastFocusAssert,
        version: state.version + 1,
      };
    }

    case 'OverlayTransitionObserved': {
      // A fact about the resign now pending, if any; `AppResigned` resets it.
      return { ...state, overlayTransitionSinceResign: true, version: state.version + 1 };
    }

    case 'AppResignSettled': {
      // Inert unless still armed — an AppActivated in between (the dance) already disarmed this.
      //
      // The sweep-eligible hide itself already ran, on the raw `AppResigned`
      // edge above. Re-running `isAppResignSweepEligible` here is a backstop:
      // it only catches a window that became sweep-eligible after the raw
      // edge and before this settle, which the raw edge had no chance to see.
      //
      // Also inert after an overlay opened or closed since the resign: the
      // platform resigns the app around an overlay's entry and exit, and
      // re-activates it on its own. The sweep stays armed, as the next resign
      // re-arms it anyway.
      if (!state.pendingAppResignSweep || state.overlayTransitionSinceResign) {
        return { ...state, version: state.version + 1 };
      }
      // Defensive: the app came back active without an `AppActivated`
      // reaching the machine. This arm never touches `appActive`, so
      // `react`'s resign-sweep rule reads `!next.appActive` off the state
      // this write produces with no separate signal needed.
      const attentionLost = !state.appActive;
      // A reversible hide must never claim a dismissal victim — computed only
      // when `react`'s resign-sweep rule will actually fire. `!w.pendingHidden`
      // guards the reversible branch too, so a record an earlier sweep already
      // marked (still awaiting its `WindowHidden` confirmation) is not resurrected.
      // A transient window holding key taken from another app is spared: the
      // user opened it after the resign (the palette, asked for just after a
      // desktop switch resigned the app), and it ends by its own rule,
      // `holdsKeyTakenFromAnotherApp`, not by a settle armed before it existed.
      const dismissVictims = attentionLost
        ? new Set(
            selectTransientAutoclose(state, null).filter((id) => {
              const rec = state.order.find((w) => w.id === id);
              return rec === undefined || !holdsKeyTakenFromAnotherApp(state, rec);
            }),
          )
        : null;
      return {
        ...state,
        pendingAppResignSweep: false,
        order: state.order.map((w) => {
          if (dismissVictims?.has(w.id)) return { ...w, pendingHidden: true };
          return !w.pendingHidden && isAppResignSweepEligible(w) ? { ...w, visible: false, hiddenByAppBlur: true } : w;
        }),
        version: state.version + 1,
      };
    }

    case 'WindowContentOrderable': {
      // Never resets to false — a miss (unregistered id) or a window already
      // orderable is a harmless no-op, not a repair.
      const record = state.order.find((w) => w.id === ev.id);
      const flipsToOrderable = record !== undefined && !record.orderable;
      const order = state.order.map((w) => (w.id === ev.id ? { ...w, orderable: true } : w));
      // This arm is what admits a just-painted record to
      // `isTransientAutocloseCandidate`, so it is also where the law asks
      // about it, against whatever `lastAttention` already stands rather than a fresh report.
      // Only while that holder still holds key: once key has left it (another
      // app came forward), no Peek window holds the focus a newly painted
      // window would have lost to. A peek opened over another app paints
      // before its raise gives it key, and must not be ended by the window
      // that held key before the user left Peek.
      const attention = state.lastAttention;
      const isVictim =
        flipsToOrderable &&
        attention !== null &&
        state.key === attention.holder &&
        order.some((w) => w.id === attention.holder) &&
        selectTransientAutoclose({ ...state, order }, attention.holder, attention.cause).includes(ev.id);
      return {
        ...state,
        order: isVictim ? order.map((w) => (w.id === ev.id ? { ...w, pendingHidden: true } : w)) : order,
        version: state.version + 1,
      };
    }

    case 'ContentFirstResponderChanged': {
      // Mechanical mirror write: an unregistered id is a no-op, `held` is
      // stored as reported. The only writer of `contentFocused`.
      return {
        ...state,
        order: state.order.map((w) => (w.id === ev.id ? { ...w, contentFocused: ev.held } : w)),
        version: state.version + 1,
      };
    }

    case 'WindowAcceptsInputChanged': {
      // Mechanical mirror write, same shape as `ContentFirstResponderChanged` above.
      return {
        ...state,
        order: state.order.map((w) => (w.id === ev.id ? { ...w, acceptsInput: ev.acceptsInput } : w)),
        version: state.version + 1,
      };
    }

    case 'WindowLayerChanged': {
      // Mechanical mirror write, same shape as `WindowAcceptsInputChanged` above.
      return {
        ...state,
        order: state.order.map((w) => (w.id === ev.id ? { ...w, layer: ev.layer } : w)),
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
      // Overlay follow: `nextFsModeForOsEntered` never settles a host back to
      // `normal`, so a host entering fullscreen always takes its attached
      // overlay off screen. No opSeq stamp: a hide is never a focus-family effect.
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
      // Can newly clear the fsMode axis of a held DisplayChanged projection — flush if visible too.
      //
      // Overlay follow, the reverse of `OsFullscreenEntered` above: settling
      // back to `normal` re-reveals the attached overlay while the app is
      // active, at its last frame. `settlesNormal` reads the host's prior
      // (`state`) record, since `evolve` may read only its own two arguments.
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
            const patched = { ...w, ...patch, ...(issuesShow ? { lastOpSeq: opSeq } : {}) };
            return issuesShow ? withShownDesktop(state, w, patched) : patched;
          }
          return w;
        }),
        opSeqCounter: opSeq,
        version: state.version + 1,
      };
    }

    case 'FullscreenSettleTimeout': {
      // Does not force-settle `fsMode` — a wrong guess is not harmless
      // (guessing `fullscreen` on a really-`normal` window strands its
      // `preBounds`; guessing `normal` on a really-fullscreen one leaves a
      // black Space behind). Instead the record is marked `unverified` for
      // `react` to turn into a `ReconcileFullscreen` request, only when still genuinely in flight.
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
      // `decide`'s translation of SetBounds/Maximize/Unmaximize. Mirror only —
      // effects are `react`'s job, from the diff.
      //
      // Overlay follow: the host's own bounds write is untouched by this —
      // only its attached overlay (if any) reframes, off `ev.overlayFrame`,
      // and reveals when the host is normal and the app is active.
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
            const patched = { ...w, ...patch, ...(issuesShow ? { lastOpSeq: opSeq } : {}) };
            return issuesShow ? withShownDesktop(state, w, patched) : patched;
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

    case 'DesktopLayoutReported': {
      // A fact, never rejected. A window whose desktop no longer exists keeps
      // the stale id, off every current desktop, until its next placement report.
      return { ...state, screens: ev.screens, desktops: ev.desktops, version: state.version + 1 };
    }

    case 'CurrentDesktopChanged': {
      // A fact, never rejected. `key` is not written: key moves only on the
      // backend's focus reports.
      const known = state.screens.some((s) => s.id === ev.screen);
      return {
        ...state,
        screens: known
          ? state.screens.map((s) => (s.id === ev.screen ? { ...s, current: ev.desktop } : s))
          : [...state.screens, { id: ev.screen, current: ev.desktop }],
        version: state.version + 1,
      };
    }

    case 'DesktopSwitchObserved': {
      // Marks the current desktop unread until the read that follows. It ends
      // nothing: macOS sends it after the switch animation, so a transient
      // window the user opened on the new desktop in the meantime would be
      // ended by it. The read decides (`DesktopsRead`).
      return { ...state, desktopSwitchCount: state.desktopSwitchCount + 1, version: state.version + 1 };
    }

    case 'DesktopsRead': {
      // A fact, never rejected. A read covering no new switch changes nothing,
      // so every routine read does not bump `version`.
      if (ev.switchesSeen <= state.desktopSwitchesRead) return state;
      const read = { ...state, desktopSwitchesRead: ev.switchesSeen, version: state.version + 1 };
      // A switch ends every visible transient window that is not on a current
      // desktop (specs/kernel-desktops.md rule 2): marked `pendingHidden`, so
      // `react`'s dismissal diff closes or hides it once. The read sends every
      // placement before this event, so a desktop here is the platform's. A
      // transient window shown while the desktop was unread has none; it was
      // shown on the desktop just read, and takes that one. A switch on another
      // screen leaves the window's desktop current, so it changes nothing.
      if (read.screens.length === 0) return read;
      const shownTransient = (w: WindowRecord): boolean =>
        w.transient === true && w.visible && w.pendingHidden !== true && w.overlayFor === undefined;
      if (!read.order.some(shownTransient)) return read;
      return {
        ...read,
        order: read.order.map((w) => {
          if (!shownTransient(w)) return w;
          if (w.desktop === undefined) {
            const desktop = desktopOnShow(read, w);
            return desktop === undefined ? w : { ...w, desktop };
          }
          return isCurrentDesktop(read, w.desktop) ? w : { ...w, pendingHidden: true };
        }),
      };
    }

    case 'WindowPlacementReported': {
      // Authoritative for `screen` and `desktop`; `null` leaves a field as it
      // is. A window on every desktop keeps the desktop it was first shown on.
      return {
        ...state,
        order: state.order.map((w) => {
          if (w.id !== ev.id) return w;
          const placed = { ...w, onEveryDesktop: ev.onEveryDesktop };
          const keepsDesktop = isOnEveryDesktop(placed) && w.desktop !== undefined;
          return {
            ...placed,
            ...(ev.screen !== null ? { screen: ev.screen } : {}),
            ...(ev.desktop !== null && !keepsDesktop ? { desktop: ev.desktop } : {}),
          };
        }),
        version: state.version + 1,
      };
    }

    case 'OverlayAttached': {
      // Mechanical write — attach, retarget, and detach are this one case.
      // `hostId: null` clears the relation; a `hostId` absent from `order`, or
      // equal to `ev.overlayId`, is normalized to a detach, keeping the two
      // `overlayFor` invariants (never dangling, never self) true by construction.
      const resolvedHostId: WindowId | undefined =
        ev.hostId !== null && ev.hostId !== ev.overlayId && state.order.some((w) => w.id === ev.hostId) ? ev.hostId : undefined;
      // Overlay follow: attach and retarget drive the same reveal/reframe
      // decision the bounds- and fullscreen-driven follow rules elsewhere in
      // this switch drive. Detach writes `visible: false` directly, same as
      // the reveal side writes `visible: true` — the overlay's visibility is a
      // stored fact this arm owns on both sides, not left for the backend's
      // native-hide echo to report back later.
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
        order: state.order.map((w) => {
          if (w.id !== ev.overlayId) return w;
          const patched = { ...w, overlayFor: resolvedHostId, ...patch, ...(issuesShow ? { lastOpSeq: opSeq } : {}) };
          return issuesShow ? withShownDesktop(state, w, patched) : patched;
        }),
        opSeqCounter: opSeq,
        version: state.version + 1,
      };
    }

    case 'StackOrderImported': {
      // Membership is preserved by construction, not by a check: the result
      // is assembled out of `state.order`'s own records and nothing else. An
      // id the payload names that is absent from `order` contributes nothing,
      // and a repeated id is collapsed by `seen`.
      //
      // A window the import does not name keeps its slot — `order` holds
      // every registered window (command panel, HUD, peeks/slides, the chrome
      // overlay), so demoting all of them beneath every restored page would
      // corrupt every `topmost(...)`-based query. The import permutes only
      // within the array slots the named ids already occupy.
      //
      // An empty or identity payload is the identity permutation, so `react`'s
      // order-changed rule emits nothing — that falls out of the construction.
      const seen = new Set<WindowId>();
      const namedRecords: WindowRecord[] = [];
      for (const id of ev.order) {
        if (seen.has(id)) continue;
        seen.add(id);
        const record = state.order.find((w) => w.id === id);
        if (record !== undefined) namedRecords.push(record);
      }
      const namedIds = new Set<WindowId>(namedRecords.map((w) => w.id));
      // One slot per named record, by construction — `namedIds` is exactly the
      // set `namedRecords` carries and an id occurs at most once in `order`.
      let cursor = 0;
      const permuted = state.order.map((w) => (namedIds.has(w.id) ? namedRecords[cursor++] : w));
      // The key window never leaves the top: a slot-preserving permutation
      // could otherwise write the key window's record back below some other
      // named window. `key` itself is never written here — only its current
      // record is lifted, the same move `WindowClosed`'s parent refocus uses.
      const keyRecord = permuted.find((w) => w.id === state.key);
      const order = keyRecord === undefined ? permuted : [...permuted.filter((w) => w.id !== keyRecord.id), keyRecord];
      return {
        ...state,
        order,
        version: state.version + 1,
      };
    }

    // Teardown — four arms, one shape: record the request on `lastTeardown`
    // (the fact `react` diffs) and change nothing else, with one addition on
    // the three arms that name a window: mark that record `pendingHidden` —
    // the machine has decided the window is going away, ahead of the OS's own
    // confirming report. `GuestTeardownRequested` marks no record: it names no
    // window at all (process-wide).
    //
    // Membership is deliberately untouched — `WindowClosed` is the sole event
    // that shrinks `order`, and it arrives on its own as the native report the
    // teardown causes; retiring the record here would close the same window
    // twice through two different effects.
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
      // No `id` to store — the request is process-wide, so no record can be marked `pendingHidden` either.
      return {
        ...state,
        lastTeardown: { kind: 'destroy-all-guests', seq: nextTeardownSeq(state) },
        version: state.version + 1,
      };
    }

    case 'FocusAssertRequested': {
      // Records the request on `lastFocusAssert` and touches nothing about the
      // window model — `key`/`order` are untouched because the target is
      // already topmost and already key, the entire reason this event exists.
      //
      // The one record write is the focus-op stamp: `react` turns this
      // transition into a `RaiseWindow`, so the stamp must require the same
      // `admitsFocus` condition `react` does, or the two would disagree
      // about whether this transition issued an op at all. No op, no stamp:
      // restamping an old token could make the echo of an op still in flight
      // on this window read as stale.
      const issuesRaise = state.order.some((w) => w.id === ev.id && admitsFocus(state, w, MACHINE_REQUEST));
      const opSeq = issuesRaise ? state.opSeqCounter + 1 : state.opSeqCounter;
      return {
        ...state,
        order: issuesRaise ? state.order.map((w) => (w.id === ev.id ? { ...w, lastOpSeq: opSeq } : w)) : state.order,
        opSeqCounter: opSeq,
        lastFocusAssert: { id: ev.id, seq: nextFocusAssertSeq(state) },
        version: state.version + 1,
      };
    }

    case 'FocusRaiseRequested': {
      // Stamps `lastOpSeq` without touching `key`, `order` or `lastAttention`; `key` moves only on the backend's confirming `OsFocusGained`.
      const targetRecord = state.order.find((w) => w.id === ev.id);
      // Same "already key is not evidence the ask was honoured" exception
      // `react`'s raise-request diff applies below — kept in sync with it so
      // an op this arm decides to issue also gets a fresh `opSeq` to stamp,
      // rather than colliding with whichever op last touched the counter.
      const alreadyKeyButUnhonoured = state.key === ev.id && ev.intent === 'user' && !state.appActive;
      const issuesRaiseRequest =
        (state.key !== ev.id || alreadyKeyButUnhonoured) &&
        targetRecord !== undefined &&
        admitsFocus(state, targetRecord, ev.intent === 'user' ? USER_REQUEST : MACHINE_REQUEST);
      const requestOpSeq = issuesRaiseRequest ? state.opSeqCounter + 1 : state.opSeqCounter;
      // An inactive app cannot honour a raise by coming forward unless the
      // raise carries user intent, and an ordinary-level window of an inactive
      // app is restacked behind the active app's windows by the OS. So a raise
      // request that will not activate the app holds its target above other
      // apps instead. A show with no raise request — session restore, any
      // `show: false` open — never reaches this arm, so it never holds.
      // A user-intent raise of a non-activating window does not bring the app
      // forward either — it takes key over the other app — so it holds too,
      // and the app activating later returns it to ordinary stacking like any
      // other held window rather than leaving it above every app for good.
      const raiseLeavesAppInactive = ev.intent !== 'user' || targetRecord?.nonActivating === true;
      // A window on another desktop is not held: holding stands in for a raise, and the raise could not reach it.
      const holds =
        !state.appActive &&
        raiseLeavesAppInactive &&
        targetRecord !== undefined &&
        admitsHoldAboveOtherApps(targetRecord) &&
        withinReach(state, targetRecord, ev.intent === 'user' ? USER_REQUEST : MACHINE_REQUEST);
      return {
        ...state,
        order: state.order.map((w) =>
          w.id === ev.id && (issuesRaiseRequest || holds)
            ? { ...w, ...(issuesRaiseRequest ? { lastOpSeq: requestOpSeq } : {}), ...(holds ? { heldAboveOtherApps: true } : {}) }
            : w,
        ),
        opSeqCounter: requestOpSeq,
        // A held window is what the user was last given over the other app. The
        // platform hands key to the app's main window on activation, which a
        // non-activating window never is, so the next activation is asked to
        // put the held window in front — the same one-shot latch a restore arms.
        ...(holds ? { pendingColdStartFocus: ev.id } : {}),
        lastRaiseRequest: { id: ev.id, seq: nextRaiseRequestSeq(state), ...(ev.intent === 'user' ? { intent: 'user' as const } : {}) },
        version: state.version + 1,
      };
    }

    case 'ColdStartFocusArmed': {
      // Latch only: `pendingColdStartFocus` and nothing else. `key`/`order`
      // untouched — arming is a note about a future activation, not a focus
      // report. `null` clears a latch an earlier arm left behind — there is no
      // separate clear event. Emits nothing: nothing in `react` reads this field.
      return { ...state, pendingColdStartFocus: ev.id, version: state.version + 1 };
    }

    case 'SelectionFocusArmed': {
      // Latch only, same shape as `ColdStartFocusArmed` above:
      // `pendingSelectionFocus` and nothing else. `target: null` clears a
      // selection an earlier arm left behind — the switcher re-arms as the
      // highlight moves. Liveness is a question for the spend, asked by `WindowClosed`.
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

// react(prev, ev, next) is a pure diff of `prev` against `next` and never branches on `ev.type`.
export function react(prev: State, ev: Event, next: State): Effect[] {
  const effects: Effect[] = [];

  // Overlay attach target: a structural diff of `topmostBaseLayerPageHost`
  // across the transition — never a comparison against the stored `overlayFor`
  // relation, which would be a repair loop; attachment and stacking order are
  // allowed to diverge, and nothing here re-emits, so a legitimate divergence survives.
  //
  // Placed first, ahead of the overlay-frame loop just below: the attach
  // decides the frame, and a reveal must never paint at a stale one.
  //
  // The `isNew` arm is the boot seed: the overlay singleton is minted after
  // windows may already be registered, so this catches the steady-state
  // divergence that would otherwise persist forever.
  const prevTarget = topmostBaseLayerPageHost(prev)?.id ?? null;
  const nextTarget = topmostBaseLayerPageHost(next)?.id ?? null;
  for (const r of next.order) {
    if (!r.tracksBaseLayerTop) continue;
    const isNew = !prev.order.some((w) => w.id === r.id);
    if (prevTarget !== nextTarget || isNew) {
      effects.push({ type: 'AttachOverlayTo', overlayId: r.id, hostId: nextTarget });
    }
  }

  // Overlay follow — frame: a structural diff of the stored target frame
  // `evolve` writes (via `overlayFollowPatch`). Placed first, ahead of the
  // visibility loop just below, so a reveal never paints the overlay at a stale frame.
  for (const nextRecord of next.order) {
    const prevRecord = prev.order.find((w) => w.id === nextRecord.id);
    if (prevRecord === undefined) continue;
    if (nextRecord.overlayFrame !== undefined && !boundsEqual(prevRecord.overlayFrame, nextRecord.overlayFrame)) {
      effects.push({ type: 'SetBounds', id: nextRecord.id, bounds: nextRecord.overlayFrame });
    }
  }

  // Visibility: a record present in both states whose `visible` flipped. (A
  // closed window vanishes from `next.order` entirely — its dismissal is the
  // CloseWindow diff below instead.) Also the only rule that drives a visible
  // overlay off screen when it detaches, since `evolve` already wrote `visible: false` on it.
  for (const nextRecord of next.order) {
    const prevRecord = prev.order.find((w) => w.id === nextRecord.id);
    if (prevRecord === undefined) {
      continue;
    }
    if (!prevRecord.visible && nextRecord.visible) {
      effects.push({ type: 'ShowWindow', id: nextRecord.id, opSeq: next.opSeqCounter });
    } else if (prevRecord.visible && !nextRecord.visible) {
      // Same token source as the `ShowWindow` arm above.
      effects.push({ type: 'HideWindow', id: nextRecord.id, opSeq: next.opSeqCounter });
    }
  }

  // Close: a record present in `prev.order` and absent from `next.order` —
  // `WindowClosed` is the only event that shrinks membership, so this
  // membership diff is exactly "this window was closed". Mirrors the
  // visibility loop above, one level up.
  for (const prevRecord of prev.order) {
    if (!next.order.some((w) => w.id === prevRecord.id)) {
      effects.push({ type: 'CloseWindow', id: prevRecord.id, maximized: prevRecord.maximized, preMaxBounds: prevRecord.preMaxBounds });
    }
  }

  // Parent refocus: the same membership-shrink diff as the `CloseWindow` loop
  // just above, read a second time for the removed record's `parentId`.
  // Eligibility is `refocusesParent` on the state the close arrived in — the
  // same question `evolve` asked when it stamped and reordered the parent.
  //
  // Placed here, before `SetStacking` further down: `evolve` already moved
  // the eligible parent to the top of `order` in the same transition, so this
  // raise must reach the executor before the trailing `SetStacking` sweep
  // replays that new position.
  for (const prevRecord of prev.order) {
    if (next.order.some((w) => w.id === prevRecord.id)) continue;
    if (prevRecord.parentId === undefined) continue;
    const parent = prev.order.find((w) => w.id === prevRecord.parentId);
    if (parent !== undefined && next.order.some((w) => w.id === parent.id) && refocusesParent(prev, prevRecord, parent)) {
      effects.push({ type: 'RaiseWindow', id: parent.id, opSeq: next.opSeqCounter });
    }
  }

  // Successor raise on hide or close of the key holder: `evolve` records the
  // successor on `lastRaiseRequest`, so the raise-request diff at the end of
  // this function emits it — no separate loop here.

  // Fullscreen: a pure structural diff of `fsMode.name`, same pattern as the
  // visibility loop above. A record whose `fsMode.name` doesn't change emits nothing.
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

  // Geometry: `bounds` — a pure structural diff of the mirror, same pattern as
  // visibility/fullscreen above. Re-requesting the current bounds emits no effect.
  for (const nextRecord of next.order) {
    const prevRecord = prev.order.find((w) => w.id === nextRecord.id);
    if (prevRecord === undefined) {
      continue;
    }
    if (nextRecord.bounds !== undefined && !boundsEqual(prevRecord.bounds, nextRecord.bounds)) {
      effects.push({ type: 'SetBounds', id: nextRecord.id, bounds: nextRecord.bounds });
    }
  }

  // Desktop membership — same diff pattern as bounds above. `undefined` is a
  // real state (nobody has asked), so the guard also excludes the defined -> undefined direction.
  for (const nextRecord of next.order) {
    const prevRecord = prev.order.find((w) => w.id === nextRecord.id);
    if (prevRecord === undefined) {
      continue;
    }
    if (prevRecord.desktopMembership !== nextRecord.desktopMembership && nextRecord.desktopMembership !== undefined) {
      effects.push({ type: 'SetDesktopMembership', id: nextRecord.id, membership: nextRecord.desktopMembership });
    }
  }

  // Click-through — same diff pattern as bounds/desktop-membership above.
  for (const nextRecord of next.order) {
    const prevRecord = prev.order.find((w) => w.id === nextRecord.id);
    if (prevRecord === undefined) {
      continue;
    }
    if (prevRecord.acceptsInput !== nextRecord.acceptsInput) {
      effects.push({ type: 'SetAcceptsInput', id: nextRecord.id, acceptsInput: nextRecord.acceptsInput });
    }
  }

  // Pinned band — a structural diff of `layer > BASE_LAYER`, same pattern as
  // click-through above. Deliberately separate from the `SetStacking` replay
  // below: that replay's `stacked` branch only reorders (`moveTop()`), so it
  // alone would never clear a real always-on-top flag on unpin.
  for (const nextRecord of next.order) {
    const prevRecord = prev.order.find((w) => w.id === nextRecord.id);
    if (prevRecord === undefined) {
      continue;
    }
    const wasPinned = prevRecord.layer > BASE_LAYER;
    const isPinned = nextRecord.layer > BASE_LAYER;
    if (wasPinned !== isPinned) {
      effects.push({ type: 'SetPinned', id: nextRecord.id, pinned: isPinned });
    }
  }

  // RaiseWindow: `State.key` changed — diffed rather than the top of `order`,
  // so a pure reorder never raises but an already-topmost window taking key
  // from someone else still does; gated on `admitsFocus` and on
  // `isOpConfirmation` so a raise's own OS echo cannot re-fire itself.
  const nextKey = next.key;
  const raiseTarget = nextKey === null ? undefined : next.order.find((w) => w.id === nextKey);
  // The confirmation test reads the PRE-transition record: a command's own
  // token is stamped on the record during this transition, so `next` would
  // make every command look like its own confirmation.
  const keyMoveConfirmsIssuedOp =
    nextKey !== null &&
    next.lastAttention !== null &&
    next.lastAttention.holder === nextKey &&
    isOpConfirmation(prev.order.find((w) => w.id === nextKey), next.lastAttention.cause);
  if (
    nextKey !== null &&
    nextKey !== prev.key &&
    raiseTarget !== undefined &&
    admitsFocus(next, raiseTarget, MACHINE_REQUEST) &&
    !keyMoveConfirmsIssuedOp
  ) {
    // No `intent` here — a `RaiseWindow` command's own "user asked for this"
    // fact is read off `State.lastRaiseRequest` by the rule below, not this one.
    effects.push({ type: 'RaiseWindow', id: nextKey, opSeq: next.opSeqCounter });
  }

  // Transient autoclose: dismissal is one structural diff, kept right after
  // the `RaiseWindow` rule and before `SetStacking` to preserve emission order.
  //
  // The choice of which record to dismiss is made in `evolve`, by the sweep
  // triggers, the end of a key taken from another app
  // (`markEndedKeyTakenFromAnotherApp`) and a desktop read (`DesktopsRead`);
  // each marks its own victims `pendingHidden: true` in that same transition. `react` only has to notice the mark landing: a
  // record whose `pendingHidden` reads not-true in `prev` and `true` in `next`
  // yields one `DismissWindow` — unless that flip is explained by a teardown
  // request naming the same record instead of a sweep choosing it.
  //
  // A record already marked in `prev` diffs to nothing here even if some rule
  // tried to mark it again, since `isTransientAutocloseCandidate`'s
  // `pendingHidden` clause keeps a marked record out of the consideration set, so
  // there is no second choice for this diff to even observe.
  const freshTeardown = next.lastTeardown !== null && next.lastTeardown.seq !== prev.lastTeardown?.seq ? next.lastTeardown : null;
  const teardownTargetId = freshTeardown !== null && freshTeardown.kind !== 'destroy-all-guests' ? freshTeardown.id : undefined;
  for (const nextRecord of next.order) {
    if (nextRecord.pendingHidden !== true) continue;
    if (nextRecord.id === teardownTargetId) continue;
    const prevRecord = prev.order.find((w) => w.id === nextRecord.id);
    if (prevRecord?.pendingHidden === true) continue;
    effects.push({ type: 'DismissWindow', id: nextRecord.id });
  }

  // Hold above other apps: a per-record structural diff of
  // `heldAboveOtherApps`, written only by `evolve` (`FocusRaiseRequested`
  // sets it; `AppActivated` and `WindowHidden` clear it). A record that left
  // `next.order` yields no release — there is no window left to restack.
  // Ahead of `SetStacking` on purpose: a released window re-enters ordinary
  // stacking first, and the replay below then orders it among its peers.
  for (const nextRecord of next.order) {
    const wasHeld = prev.order.find((w) => w.id === nextRecord.id)?.heldAboveOtherApps === true;
    const isHeld = nextRecord.heldAboveOtherApps === true;
    if (isHeld && !wasHeld) effects.push({ type: 'HoldAboveOtherApps', id: nextRecord.id });
    else if (!isHeld && wasHeld) effects.push({ type: 'ReleaseFromAboveOtherApps', id: nextRecord.id });
  }

  // SetStacking: a minimal replay, not a re-assert of everything eligible. The
  // native primitive is move-to-top, so a window whose index didn't change can
  // still end up wrong once a different window moves past it — the unit that
  // must be re-announced is the smallest trailing run of the band's new order
  // that, replayed bottom -> top, reproduces the whole band.
  //
  // Computed independently per band (pinned vs. stacked), since a native
  // move-to-top only reorders within its own level. A window is forced into
  // the suffix regardless of the minimal-diff search when it is new, or its
  // `visible`/`orderable` just flipped true — the OS has never placed it.
  for (const pinnedBand of [false, true] as const) {
    const inBand = (w: WindowRecord) => (w.layer > BASE_LAYER) === pinnedBand;
    const eligible = (w: WindowRecord) => w.visible && w.orderable && inBand(w);

    const N = next.order.filter(eligible).sort((a, b) => a.layer - b.layer);
    const nIds = new Set(N.map((w) => w.id));
    const P = prev.order
      .filter(eligible)
      .sort((a, b) => a.layer - b.layer)
      .filter((w) => nIds.has(w.id));

    // Smallest `k` such that dropping N's last `k` ids from both N and P leaves the two sequences equal.
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

  // Teardown: a structural diff of `State.lastTeardown`. The `seq` comparison
  // makes two identical requests for the same window count as two teardowns
  // rather than one no-op. `destroy-all-guests` names no window — it is process-wide by construction.
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
  // — one `ReconcileFullscreen` for every record whose mark newly went
  // false -> true. A record already unverified in `prev` emits nothing a second time.
  for (const record of next.order) {
    if (!isFsModeUnverified(record.fsMode)) continue;
    const prevRecord = prev.order.find((w) => w.id === record.id);
    if (prevRecord !== undefined && isFsModeUnverified(prevRecord.fsMode)) continue;
    effects.push({ type: 'ReconcileFullscreen', id: record.id });
  }

  // App hide: the last window that was keeping Peek on screen has gone away,
  // so hand the user back to whatever they were in before. A structural diff —
  // hides only when this transition took the count of app-holding windows
  // from some to none, so a close that leaves other windows up never hides
  // the app out from under them. A hide, not a quit: Peek's own windows are untouched.
  const heldBefore = prev.order.some(holdsAppOnScreen);
  const heldAfter = next.order.some(holdsAppOnScreen);
  if (heldBefore && !heldAfter) {
    effects.push({ type: 'HideApp' });
  }

  // Focus assert: a structural diff of `State.lastFocusAssert`, same shape as
  // the teardown rule above. The `seq` comparison matters more here than for
  // teardown, since the payload is identical every time (open devtools, close,
  // open again) — `seq` is the only thing distinguishing them.
  //
  // Last, deliberately: the assert must land after the re-show / overlay-reveal
  // / stacking work above, or it would drive first responder before a re-show lands on top of it.
  //
  // Gated on `admitsFocus`, not merely present in `next.order` — without
  // it an assert naming an off-screen or doomed window would pull it onto screen and take key —
  // under the same requester `evolve` stamped its token with.
  const focusAssert = next.lastFocusAssert;
  if (focusAssert !== null && focusAssert.seq !== prev.lastFocusAssert?.seq) {
    const record = next.order.find((w) => w.id === focusAssert.id);
    const requester = focusAssert.switcherPick === true ? SWITCHER_PICK : MACHINE_REQUEST;
    if (record !== undefined && admitsFocus(next, record, requester)) {
      pushRaise(effects, next, record, requester);
      // `isContentWindow` earns its keep for an assert dispatched as a raw event, bypassing `decide`'s own gate.
      // Only a switcher pick carries user intent, so the
      // content focus paired with the raise above must follow F6 the same way the raise itself does:
      // the executor's `planRaise` answers `suppressed` for this raise while the app is inactive, and a
      // content focus that still reached the backend would take first responder and activate the app
      // out from under the suppressed raise. Emitting it only while the app is active keeps the
      // suppression decision in this one place instead of adding a second gate in the executor.
      if (isContentWindow(record) && next.appActive) {
        effects.push({ type: 'FocusContent', id: focusAssert.id });
      }
    }
  }

  // Raise request: a structural diff of `State.lastRaiseRequest` — `decide`'s
  // translation of an accepted `RaiseWindow` command, or the successor a
  // hidden/closed key holder hands key back to; `key` itself moves only
  // later, off the backend's own confirming `OsFocusGained`.
  //
  // Gated on `next.key !== raiseRequest.id` in addition to `admitsFocus`:
  // a `RaiseWindow` command on the window that already holds key is the
  // silent no-op `AssertFocus` exists to override — EXCEPT while the app is
  // inactive and the request carries user intent. `key` only ever names which
  // window the OS treats as the input target; an inactive app can already
  // have handed a window key (a plain `OsFocusGained` echo, no intent) without
  // the app itself ever coming forward, so "already key" is not evidence the
  // user's request was already honoured. Dropping it there is exactly the gap
  // a fresh window-open's automatic shown/focused report opened: it hands the
  // fresh window key before the user-intent raise this open also issues ever
  // reaches this diff, and the diff's own no-op guard swallowed the raise. A
  // user-intent raise while inactive is never redundant.
  const raiseRequest = next.lastRaiseRequest;
  if (raiseRequest !== null && raiseRequest.seq !== prev.lastRaiseRequest?.seq) {
    const record = next.order.find((w) => w.id === raiseRequest.id);
    const alreadyKeyButUnhonoured = next.key === raiseRequest.id && raiseRequest.intent === 'user' && !next.appActive;
    const requester = raiseRequest.intent === 'user' ? USER_REQUEST : MACHINE_REQUEST;
    if (record !== undefined && (next.key !== raiseRequest.id || alreadyKeyButUnhonoured) && admitsFocus(next, record, requester)) {
      pushRaise(effects, next, record, requester);
    }
  }

  return effects;
}

// A raise, carrying user intent when the requester has it, and preceded by
// `ShowDesktop` when a named window is on a desktop no screen shows (rule 1).
function pushRaise(effects: Effect[], next: State, record: WindowRecord, requester: FocusRequester): void {
  if (requester.named && !onCurrentDesktop(next, record) && record.desktop !== undefined) {
    effects.push({ type: 'ShowDesktop', desktop: record.desktop });
  }
  effects.push({
    type: 'RaiseWindow',
    id: record.id,
    opSeq: next.opSeqCounter,
    ...(requester.user ? { intent: 'user' as const } : {}),
  });
}

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
          ...(cmd.transient !== undefined ? { transient: cmd.transient } : {}),
          ...(cmd.nonActivating !== undefined ? { nonActivating: cmd.nonActivating } : {}),
          ...(cmd.appLifetime !== undefined ? { appLifetime: cmd.appLifetime } : {}),
          ...(cmd.onEveryDesktop !== undefined ? { onEveryDesktop: cmd.onEveryDesktop } : {}),
        },
      ],
    };
  }

  // AttachOverlay carries `overlayId`/`hostId`, not `id` — handled here, before the generic `cmd.id` guard below.
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
  // generic `cmd.id` guard below. Unknown ids are not rejected: a restore can
  // build the payload over windows that died mid-restore, so an id naming
  // nothing is expected traffic and is inert in `evolve` rather than fatal here.
  if (cmd.type === 'ImportStackOrder') {
    return { events: [{ type: 'StackOrderImported', order: cmd.order }] };
  }

  // ArmColdStartFocus carries an id that may be `null` and, when not, may name
  // a window that is not live yet. An existence guard would be wrong rather
  // than redundant: it would reject every clear, and a real id is a note read at a later activation.
  if (cmd.type === 'ArmColdStartFocus') {
    return { events: [{ type: 'ColdStartFocusArmed', id: cmd.id }] };
  }

  // ArmSelectionFocus carries `armer`/`target` rather than `id`. One guard of
  // its own, on the armer only: the latch is spent by that window's
  // `WindowClosed`, so arming against a window the kernel does not have would
  // leave a latch nothing can ever spend. The target is deliberately
  // unguarded — a target that dies before the spend makes it a no-op, not an error.
  if (cmd.type === 'ArmSelectionFocus') {
    if (!state.order.some((w) => w.id === cmd.armer)) {
      return { rejected: 'no-such-window' };
    }
    return { events: [{ type: 'SelectionFocusArmed', armer: cmd.armer, target: cmd.target }] };
  }

  // Teardown — handled before the existence guard below, and that ordering is
  // the point: these four are exempt from unknown-window rejection. A close
  // path can name a window retired microseconds earlier in the same
  // synchronous body, so a rejecting arm would silently drop its teardown.
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
      // A raise is a focus request, not yet a report that it is one — `key`
      // is a fact reserved for `OsFocusGained` alone, so this arm must not
      // manufacture it (doing so believed a window was key before the OS had
      // focused anything, on a backgrounded app whose raise was suppressed).
      // `decide` translates the command onto `FocusRaiseRequested` instead;
      // `key` moves only later, off the backend's own confirming echo.
      return {
        events: [{ type: 'FocusRaiseRequested', id: cmd.id, ...(cmd.intent === 'user' ? { intent: 'user' } : {}) }],
      };
    case 'ShowWindow':
      return { events: [{ type: 'WindowShown', id: cmd.id }] };
    case 'HideWindow':
      return { events: [{ type: 'WindowHidden', id: cmd.id }] };
    case 'CloseOrHideWindow': {
      // Refusal first: a record whose lifetime is the app's own rejects the
      // command outright — neither hidden nor closed, and no cascade runs.
      const record = state.order.find((w) => w.id === cmd.id)!;
      if (record.appLifetime === true) {
        return { rejected: 'app-lifetime-window' };
      }
      // The branch point: keepLive === true hides, never closes; otherwise it
      // closes. Applied via one closure to `cmd.id` and to every cascaded
      // descendant alike, so none gets a forced close that ignores its own keepLive.
      const dispose = (id: WindowId): Event => {
        const target = state.order.find((w) => w.id === id)!;
        return target.keepLive ? { type: 'WindowHidden', id } : { type: 'WindowClosed', id };
      };
      // Cascade: every window this one opened, transitively, over the
      // kernel's own `parentId` edges, deepest first, before `cmd.id`'s own event.
      const cascade: Event[] = descendantsToCascadeClose(state, cmd.id).map(dispose);
      return { events: [...cascade, dispose(cmd.id)] };
    }
    case 'SetFullscreen': {
      const rec = state.order.find((w) => w.id === cmd.id)!;
      const mode = rec.fsMode;
      // A request arriving while a transition is already in flight does not
      // start a second one — it coalesces into `pendingDesire`, applied when that transition settles.
      if (mode.name === 'entering' || mode.name === 'leaving') {
        return { events: [{ type: 'FullscreenDesireRecorded', id: cmd.id, desired: cmd.desired }] };
      }
      if (mode.name === 'normal') {
        if (!cmd.desired) return { events: [] }; // already normal -> no-op, no OS call
        // Stash the pre-fullscreen rect from the machine's own bounds mirror — never a live query.
        return { events: [{ type: 'FullscreenTransitionStarted', id: cmd.id, entering: true, preBounds: rec.bounds ?? null }] };
      }
      // mode.name === 'fullscreen'
      if (cmd.desired) return { events: [] }; // already fullscreen -> no-op, no OS call
      return { events: [{ type: 'FullscreenTransitionStarted', id: cmd.id, entering: false, preBounds: mode.preBounds }] };
    }
    case 'SetBounds': {
      const rec = state.order.find((w) => w.id === cmd.id)!;
      // Fullscreen owns the display: a mid-episode bounds write would corrupt the fullscreen geometry.
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
      // Same fullscreen guard as SetBounds.
      if (rec.fsMode.name !== 'normal') return { events: [] };
      // Already maximized: nothing new to snap to (the caller's `workArea`
      // is discarded) — a no-op rather than a re-snap.
      if (rec.maximized) return { events: [] };
      return {
        events: [
          { type: 'PendingProjectionDiscarded', id: cmd.id },
          // Stash the pre-maximize rect from the machine's own bounds mirror
          // — read from `rec` (pre-transition), never the paired BoundsChanged below. `null` = no stash was possible.
          { type: 'Maximized', id: cmd.id, preMaxBounds: rec.bounds ?? null },
          // Drive the actual snap, reusing BoundsChanged. Skipped when the caller had no rect to hand.
          ...(cmd.workArea !== undefined ? ([{ type: 'BoundsChanged', id: cmd.id, bounds: cmd.workArea }] as Event[]) : []),
        ],
      };
    }
    case 'SeedMaximized': {
      const rec = state.order.find((w) => w.id === cmd.id)!;
      // Same fullscreen guard as Maximize/SetBounds.
      if (rec.fsMode.name !== 'normal') return { events: [] };
      return {
        events: [
          // The stash comes from the command, never from `rec.bounds` the way
          // `Maximize` resolves it — at construction time those bounds are
          // already the maximized rect. No paired BoundsChanged or
          // PendingProjectionDiscarded: this seeds a record to match geometry that already exists.
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
    case 'SetLayer':
      return { events: [{ type: 'WindowLayerChanged', id: cmd.id, layer: cmd.layer }] };
    case 'AssertFocus': {
      // Reached only after the unknown-window guard above — this command is
      // not exempt from it, unlike the teardown arms.
      //
      // The remaining guard: a target that is not the kind of window the user
      // works in is accepted and drives nothing, rather than being raised.
      const rec = state.order.find((w) => w.id === cmd.id)!;
      if (!isContentWindow(rec)) return { events: [] };
      return { events: [{ type: 'FocusAssertRequested', id: cmd.id }] };
    }
  }
}

// Queries that replace `front`

export function topmost(state: State, pred: (r: WindowRecord) => boolean): WindowRecord | null {
  for (let i = state.order.length - 1; i >= 0; i--) {
    if (pred(state.order[i])) {
      return state.order[i];
    }
  }
  return null;
}

export function keyWindow(state: State): WindowRecord | null {
  if (state.key === null) {
    return null;
  }
  return state.order.find((w) => w.id === state.key) ?? null;
}

// The window the user is looking at (specs/kernel-desktops.md section 4
// "Queries"): the key window if it is on screen, passes `filter` and is on a
// current desktop, else the topmost on-screen window that does. Every "focused
// window" or "topmost content window" answer outside the kernel is this one,
// so an action never lands on a window on a desktop the user is not on.
export function frontWindowHere(state: State, filter: (r: WindowRecord) => boolean = () => true): WindowId | null {
  const here = (r: WindowRecord): boolean => r.visible && r.pendingHidden !== true && filter(r) && onCurrentDesktop(state, r);
  const key = keyWindow(state);
  if (key !== null && here(key)) return key.id;
  return topmost(state, here)?.id ?? null;
}

// A window is on every desktop when the backend declared it so, or when its
// role asks to follow the user across desktops.
export function isOnEveryDesktop(record: WindowRecord): boolean {
  return record.onEveryDesktop === true || record.desktopMembership === 'follow';
}

// True when some screen shows the desktop, and for every desktop before the
// first layout report.
export function isCurrentDesktop(state: State, desktop: DesktopId): boolean {
  return state.screens.length === 0 || state.screens.some((s) => s.current === desktop);
}

// True when the window is known to be on a desktop some screen shows. False
// covers both "known to be elsewhere" and "never shown"; the rules treat them
// alike, because a wrong guess either way switches the user's desktop. Before
// the first layout report every window counts as on a current desktop.
export function onCurrentDesktop(state: State, record: WindowRecord): boolean {
  if (isOnEveryDesktop(record) || state.screens.length === 0) return true;
  if (desktopUnread(state)) return false;
  return record.desktop !== undefined && isCurrentDesktop(state, record.desktop);
}

// True from a switch notice until a desktop read covering it: `current` still
// names the desktop the user left, so it is not trusted in either direction.
export function desktopUnread(state: State): boolean {
  return state.desktopSwitchCount > state.desktopSwitchesRead;
}

// The desktop a genuine show stamps: the current desktop of the window's
// screen, or of the first screen when its screen is unknown; nothing before the
// first layout report, or while the current desktop is unread. A transient
// window on every desktop is shown where the user is each time, so each show
// stamps afresh; any other window on every desktop keeps its first.
function desktopOnShow(state: State, record: WindowRecord): DesktopId | undefined {
  if (keepsFirstDesktop(record)) return record.desktop;
  if (desktopUnread(state)) return undefined;
  const screen = state.screens.find((s) => s.id === record.screen) ?? state.screens[0];
  return screen?.current;
}

// The one desktop stamp for a write that flips `visible` to true (a show, the
// re-show on app activation, the overlay reveal): `before` is the record as it
// was, `shown` the record with the write applied. A window already visible
// keeps its desktop. Shown while the current desktop is unread, the old stamp
// may name the desktop the user left, so the window waits for its placement
// report instead.
function withShownDesktop(state: State, before: WindowRecord, shown: WindowRecord): WindowRecord {
  if (before.visible) return shown;
  const desktop = desktopOnShow(state, before);
  if (desktop !== undefined) return { ...shown, desktop };
  if (desktopUnread(state) && !keepsFirstDesktop(before)) {
    const { desktop: _left, ...unplaced } = shown;
    return unplaced;
  }
  return shown;
}

function keepsFirstDesktop(record: WindowRecord): boolean {
  return isOnEveryDesktop(record) && record.desktop !== undefined && record.transient !== true;
}

export function windowById(state: State, id: WindowId): WindowRecord | null {
  return state.order.find((w) => w.id === id) ?? null;
}

export type PlatformChosenFocus = 'stacking' | 'hide' | 'activation';

// Which expectation, if any, a focus report answers: a world-caused report
// that follows an effect after which the platform hands out focus by itself.
// A machine-caused report is the kernel's own op and never the platform's choice.
export function platformChoseFocus(state: State, id: WindowId, cause: FocusCause): PlatformChosenFocus | null {
  if (cause.kind === 'machine') return null;
  const expected = state.expectedPlatformFocus;
  if (expected.stacking.includes(id)) return 'stacking';
  if (expected.hide) return 'hide';
  if (expected.activation !== null && expected.activation !== id) return 'activation';
  return null;
}

// Any focus report ends the restacking batch and the hide it follows; the
// activation expectation ends with the asked-for window's own focus or with
// the one focus it swallows. A report swallowed as a restack leaves the hide
// and activation expectations standing, as one swallowed as a hide leaves
// the activation one.
export function spendPlatformFocusExpectation(
  expected: PlatformFocusExpectation,
  id: WindowId,
  provoked: PlatformChosenFocus | null,
): PlatformFocusExpectation {
  if (provoked === 'stacking') return { ...expected, stacking: [] };
  if (provoked === 'hide') return { ...expected, stacking: [], hide: false };
  const activationSpent = expected.activation !== null && (expected.activation === id || provoked === 'activation');
  return { stacking: [], hide: false, activation: activationSpent ? null : expected.activation };
}

function withoutStackingExpectation(expected: PlatformFocusExpectation, id: WindowId): PlatformFocusExpectation {
  return expected.stacking.includes(id) ? { ...expected, stacking: expected.stacking.filter((w) => w !== id) } : expected;
}

// Whether hiding a window makes the platform hand focus to another of the
// app's windows, a focus the kernel never asked for and must not read as the
// user's. Only the key window's hide does, and only while the app is active:
// an inactive app's hide reassigns nothing, so expecting a focus there would
// leave the expectation standing until it swallowed the user's next real click.
export function hideProvokesFocusReassignment(windowFocused: boolean, appActive: boolean): boolean {
  return windowFocused && appActive;
}

export interface PlatformFocusFacts {
  // Restacking a window hands it focus on this platform.
  restackingTakesFocus: boolean;
  // Windows hold real focus (false when running focus-free, where a hide
  // reassigns nothing).
  holdsFocus: boolean;
}

// Records what focus the platform will hand out by itself as it realizes
// `effects`, emitted by `react` for `state`. A hide replaces the previous
// hide expectation (the last hide decides); a restack adds to the batch.
export function expectPlatformFocus(state: State, effects: readonly Effect[], facts: PlatformFocusFacts): State {
  let expected = state.expectedPlatformFocus;
  for (const effect of effects) {
    if (effect.type === 'HideWindow') {
      const hide = facts.holdsFocus && hideProvokesFocusReassignment(state.key === effect.id, state.appActive);
      if (hide !== expected.hide) expected = { ...expected, hide };
    } else if (effect.type === 'SetStacking' && facts.restackingTakesFocus && !expected.stacking.includes(effect.id)) {
      expected = { ...expected, stacking: [...expected.stacking, effect.id] };
    }
  }
  return expected === state.expectedPlatformFocus ? state : { ...state, expectedPlatformFocus: expected };
}

export function isStaleSelfEcho(state: State, id: WindowId, cause: FocusCause): boolean {
  if (cause.kind !== 'machine') return false;
  const record = state.order.find((w) => w.id === id);
  return record?.lastOpSeq !== undefined && cause.opSeq < record.lastOpSeq;
}

// isOpConfirmation compares `cause.opSeq === record.lastOpSeq`; `isStaleSelfEcho` compares `<`; the two are a pair.
export function isOpConfirmation(record: WindowRecord | undefined, cause: FocusCause | undefined): boolean {
  return cause?.kind === 'machine' && record?.lastOpSeq !== undefined && cause.opSeq === record.lastOpSeq;
}

export function isStaleWindowEcho(state: State, id: WindowId, opSeq: number | undefined): boolean {
  if (opSeq === undefined) return false;
  const record = state.order.find((w) => w.id === id);
  return record?.lastOpSeq !== undefined && opSeq < record.lastOpSeq;
}

export function overlayForHost(state: State, hostId: WindowId): WindowRecord | null {
  for (const w of state.order) {
    if (w.overlayFor === hostId) return w;
  }
  return null;
}

export function hostForOverlay(state: State, overlayId: WindowId): WindowRecord | null {
  const overlay = state.order.find((w) => w.id === overlayId);
  if (overlay === undefined || overlay.overlayFor === undefined) return null;
  return state.order.find((w) => w.id === overlay.overlayFor) ?? null;
}

export const CONTENT_ROLES: ReadonlySet<string> = new Set(['content', 'child-content', 'workspace']);

export const SATELLITE_ROLES: ReadonlySet<string> = new Set(['overlay', 'palette', 'switcher']);

export function isContentWindow(record: WindowRecord): boolean {
  if (!record.visible) return false;
  if (record.pendingHidden) return false;
  if (!record.canBecomeKey) return false;
  return roleIn(CONTENT_ROLES, record.role);
}

const APP_HOLD_EXCLUDED_CLASSES: ReadonlySet<string> = new Set([
  'background',
  'quick-view',
  'palette',
  'overlay',
  'hud',
]);

export function holdsAppOnScreen(record: WindowRecord): boolean {
  // `visible` alone, deliberately — no `pendingHidden` clause: a window on its
  // way out is still on the screen, and gating on the intent instead of the
  // fact would hide the app on every teardown request, including ones that never complete.
  if (!record.visible) return false;
  return !APP_HOLD_EXCLUDED_CLASSES.has(record.class);
}

export function isFrontEligibleWindow(record: WindowRecord): boolean {
  if (!record.visible) return false;
  if (!record.canBecomeKey) return false;
  return !roleIn(SATELLITE_ROLES, record.role);
}

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

function isBaseLayerFrontEligible(r: WindowRecord): boolean {
  return isFrontEligibleWindow(r) && !r.pendingHidden && r.layer === BASE_LAYER;
}

// The page chrome's host: the frontmost base-layer window on a current desktop,
// if it is a page-host window (specs/kernel-desktops.md section 4 "Page
// chrome"). A window on a desktop no screen shows is skipped, so the chrome is
// never shown over it and never takes the user there.
export function topmostBaseLayerPageHost(state: State): WindowRecord | null {
  const front = topmost(state, (r) => isBaseLayerFrontEligible(r) && onCurrentDesktop(state, r));
  return front !== null && isBaseLayerPageHost(front) ? front : null;
}

// Roles whose windows launch or overlay other windows rather than own them: a
// window opened from one is a top-level window, not its child. This asks what
// the opener is for, not how it ends, so it is not read from `transient` — a
// page opened over another app is transient and still owns what it opens.
export const LAUNCHER_ROLES: ReadonlySet<string> = new Set(['palette', 'quick-view', 'overlay', 'switcher']);

// Default provenance for a focus report that carries none — see `FocusCause`.
const WORLD_CAUSE: FocusCause = { kind: 'world' };

export function roleIn(set: ReadonlySet<string>, role: string | undefined): boolean {
  return role !== undefined && set.has(role);
}

export function isNonParentRole(role: string | undefined): boolean {
  return roleIn(LAUNCHER_ROLES, role);
}

// The `pendingHidden` clause keeps a chosen-for-dismissal window out of the next sweep until its hide confirms;
// the `orderable` clause keeps an unpainted window out of every sweep.
export function isTransientAutocloseCandidate(rec: WindowRecord): boolean {
  if (!rec.orderable) return false;
  if (rec.pendingHidden === true) return false;
  return rec.transient === true;
}

// Which of the four exemption clauses in the transient-dismissal law spared a candidate.
export type TransientAutocloseExemption = 'overlay-attached' | 'no-input' | 'focuser-relation' | 'newer-than-focuser';

// The one dismissal law; `selectTransientAutoclose`, `traceTransientAutoclose` and `evolve`'s merge arm all call it — its clauses are stated nowhere else.
export function transientAutocloseExemption(
  rec: WindowRecord,
  focuser: WindowRecord | undefined,
  orderingFloor: number | null,
): TransientAutocloseExemption | null {
  if (rec.overlayFor !== undefined) return 'overlay-attached';
  // Policy, not derivation — spares the Space border / chrome overlay cases, not every no-input window.
  if (!rec.acceptsInput) return 'no-input';
  if (focuser?.parentId === rec.id || focuser?.overlayFor === rec.id) return 'focuser-relation';
  if (orderingFloor !== null && rec.openSeq > orderingFloor) return 'newer-than-focuser';
  return null;
}

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

// One candidate's fate, as decided by `traceTransientAutoclose`.
export type TransientAutocloseTrace =
  | { id: WindowId; dismissed: true }
  | { id: WindowId; dismissed: false; exemption: TransientAutocloseExemption };

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

function appBlurRevealAdmits(state: State, record: WindowRecord): boolean {
  if (record.hiddenByAppBlur !== true) return false;
  if (record.pendingHidden) return false;
  if (record.overlayFor === undefined) return true;
  const host = state.order.find((w) => w.id === record.overlayFor);
  return host !== undefined && host.visible && !host.pendingHidden && host.fsMode.name === 'normal';
}

// Disjoint from `selectTransientAutoclose` by construction; asserted by a property test.
//
// A window held above other apps (`heldAboveOtherApps`) is never eligible: it
// keeps its declared `layer`, and it is on screen over another app on purpose —
// the clause states that outright rather than leaning on `isContentWindow`.
export function isAppResignSweepEligible(record: WindowRecord): boolean {
  return (
    record.visible &&
    record.layer > BASE_LAYER &&
    record.acceptsInput &&
    record.transient !== true &&
    record.heldAboveOtherApps !== true &&
    !isContentWindow(record)
  );
}

// Which window a non-activating raise request holds above other apps: a page
// the user works in, or a transient page-host window (a peek, a slide), on
// screen at the base layer. A window declared above the base layer already
// sits over other apps and needs no hold. Without it a page-host window built
// as a flagged ordinary window is restacked behind the frontmost app.
export function admitsHoldAboveOtherApps(record: WindowRecord): boolean {
  return (
    record.kind === 'page-host' &&
    record.layer === BASE_LAYER &&
    (isContentWindow(record) || record.transient === true)
  );
}

// A transient window holding key it took from another app, directly or
// through another transient window (window-rules.md G1, G13): whatever opened
// it, and whatever kind of window it is. It ends the moment it stops being key
// with the app still inactive, or the app becomes active; `react` diffs this
// predicate across the transition and emits one `DismissWindow`; nothing
// replaces it. Key passing to a transient window it opened (a page's popup) is
// not the end of it: it holds the key through that window, and the two end
// together.
export function holdsKeyTakenFromAnotherApp(state: State, record: WindowRecord): boolean {
  return (
    !state.appActive &&
    state.key !== null &&
    (state.key === record.id || overlayHoldsKeyFor(state, record.id) || transientDescendantHoldsKey(state, record.id)) &&
    record.visible &&
    record.transient === true &&
    record.tookKeyFromAnotherApp === true
  );
}

// Whether the key holder is the page chrome overlay attached to `hostId`: the
// user typing in the address bar of a held page is still using that page.
function overlayHoldsKeyFor(state: State, hostId: WindowId): boolean {
  const holder = state.order.find((w) => w.id === state.key);
  return holder !== undefined && holder.visible && holder.overlayFor === hostId;
}

// Whether the key holder is a visible transient window opened, directly or
// through other such windows, from `ancestorId`.
function transientDescendantHoldsKey(state: State, ancestorId: WindowId): boolean {
  let current = state.order.find((w) => w.id === state.key);
  const seen = new Set<WindowId>();
  while (current !== undefined && current.visible && current.transient === true && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.parentId === ancestorId) return true;
    const parentId = current.parentId;
    current = parentId == null ? undefined : state.order.find((w) => w.id === parentId);
  }
  return false;
}

// Who is asking for a window to come forward (specs/kernel-desktops.md,
// `admitsFocus`). `user`: the user acted. `named`: the user named this very
// window (a switcher pick), which may take the user to its desktop.
export interface FocusRequester {
  readonly user: boolean;
  readonly named: boolean;
}
export const MACHINE_REQUEST: FocusRequester = { user: false, named: false };
export const USER_REQUEST: FocusRequester = { user: true, named: false };
export const SWITCHER_PICK: FocusRequester = { user: true, named: true };

// F9 and rule 5: a window is within reach of a request if it is on a current
// desktop, or the request names it. Before the first layout report
// `onCurrentDesktop` is true for every window. The hold above other apps asks
// this alone, since it stands in for a raise an inactive app cannot make.
export function withinReach(state: State, record: WindowRecord, requester: FocusRequester): boolean {
  return requester.named || onCurrentDesktop(state, record);
}

// The one admission rule for bringing a window forward. Every raise, focus
// assert, successor and latch spend in `react` asks it, and so does every
// `evolve` stamp that pairs with one, so the two agree on whether a transition
// issued an op. `visible` defaults to the record's own; the `AppActivated`
// latch passes its post-re-show answer, and asks with the app active.
//
// While the app is inactive only a request with user intent is admitted: an
// inactive app cannot come forward on its own, so a machine raise there is one
// the platform would not honour. It is not emitted at all, rather than emitted
// and dropped by the executor (the hold above other apps asks `withinReach`
// alone, since it stands in for exactly that raise).
export function admitsFocus(
  state: State,
  record: WindowRecord,
  requester: FocusRequester,
  visible: boolean = record.visible,
): boolean {
  return visible && !record.pendingHidden && (state.appActive || requester.user) && withinReach(state, record, requester);
}

// Rule 5: a window may serve a request that would reuse it if it is hidden (a
// re-show lands on the current desktop of its screen) or visible on a current
// desktop. One being hidden counts as hidden.
export function admitsReuse(state: State, record: WindowRecord): boolean {
  return !record.visible || record.pendingHidden === true || onCurrentDesktop(state, record);
}

// The one answer to "which of these open windows can serve this request
// here?". Callers outside the kernel find candidates by their own criterion
// (URL, key, extension page) and never choose among them themselves. `null`:
// open a new window here.
export function reusableHere(state: State, candidates: readonly WindowId[]): WindowId | null {
  for (const id of candidates) {
    const record = state.order.find((w) => w.id === id);
    if (record !== undefined && admitsReuse(state, record)) return id;
  }
  return null;
}

// F7: nothing if the window took key from another app (the user goes back
// there); else the prior key holder if it is on screen and on a current
// desktop, else the topmost application window on a current desktop, else
// nothing.
// Reads `priorKey`; `evolve`'s `WindowHidden` and `WindowClosed` arms both call this one helper and record its answer on `lastRaiseRequest`.
// Parent refocus on a child's close, gated like the successor: only a child
// that held key while the app was active hands key to its parent, and never
// one that took key from another app. `state` is the state the close arrived
// in; `evolve`'s `WindowClosed` arm and `react`'s parent-refocus loop both ask.
function refocusesParent(state: State, closedRecord: WindowRecord, parent: WindowRecord): boolean {
  return (
    closedRecord.id === state.key &&
    state.appActive === true &&
    closedRecord.tookKeyFromAnotherApp !== true &&
    isContentWindow(parent) &&
    admitsFocus(state, parent, MACHINE_REQUEST)
  );
}

function successorOnHide(state: State, hiddenRecord: WindowRecord): WindowRecord | null {
  if (hiddenRecord.priorKey === null || hiddenRecord.tookKeyFromAnotherApp === true) return null;
  const prior = state.order.find((w) => w.id === hiddenRecord.priorKey);
  if (prior !== undefined && admitsFocus(state, prior, MACHINE_REQUEST)) return prior;
  return topmost(state, (w) => isContentWindow(w) && admitsFocus(state, w, MACHINE_REQUEST));
}
