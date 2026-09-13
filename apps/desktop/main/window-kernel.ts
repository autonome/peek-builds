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
  pendingProjectedBounds: Rectangle | null;

  overlayFor?: WindowId;

  overlayFrame?: Rectangle;

  lastOpSeq?: number;

  priorKey: WindowId | null;

  hiddenByAppBlur?: boolean;

  // DO NOT DELETE as unread: no rule here branches on it, but `window-escape.ts interpretEscape` reads it outside the kernel.
  escapeMode?: 'ignore';

  tracksBaseLayerTop?: boolean;

  selfClosesOnBlur?: boolean;

  // The `type: 'panel'` open declaration; takes key without activating the app.
  nonActivating?: boolean;

  appLifetime?: boolean;

  contentFocused?: boolean;
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
}

export interface SelectionFocus {
  armer: WindowId;
  target: WindowId;
}

export interface FocusAssertRequest {
  id: WindowId;
  seq: number;
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
      // See `WindowRecord.nonActivating` — declared here.
      nonActivating?: boolean;
      // See `WindowRecord.appLifetime` — declared here.
      appLifetime?: boolean;
    }
  | { type: 'WindowShown'; id: WindowId; opSeq?: number }
  | { type: 'WindowHidden'; id: WindowId; opSeq?: number }
  | { type: 'WindowClosed'; id: WindowId }
  | { type: 'OsFocusGained'; id: WindowId; cause?: FocusCause }
  | { type: 'OsFocusLost'; id: WindowId }
  | { type: 'AppResigned' }
  | { type: 'AppActivated' }
  | { type: 'AppResignSettled' }
  // The first-composited-frame report — flips `orderable` to `true`.
  | { type: 'WindowContentOrderable'; id: WindowId }
  | { type: 'ContentFirstResponderChanged'; id: WindowId; held: boolean }
  | { type: 'WindowAcceptsInputChanged'; id: WindowId; acceptsInput: boolean }
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
      // See `WindowRecord.nonActivating` — declared here.
      nonActivating?: boolean;
      // See `WindowRecord.appLifetime` — declared here.
      appLifetime?: boolean;
      expectedVersion: number;
    }
  | { type: 'SetFullscreen'; id: WindowId; desired: boolean; expectedVersion: number }
  | { type: 'SetBounds'; id: WindowId; bounds: Rectangle; expectedVersion: number }
  | { type: 'Maximize'; id: WindowId; workArea?: Rectangle; expectedVersion: number }
  | { type: 'SeedMaximized'; id: WindowId; preMaxBounds: Rectangle | null; expectedVersion: number }
  | { type: 'Unmaximize'; id: WindowId; expectedVersion: number }
  | { type: 'SetDesktopMembership'; id: WindowId; membership: DesktopMembership; expectedVersion: number }
  | { type: 'SetAcceptsInput'; id: WindowId; acceptsInput: boolean; expectedVersion: number }
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
  // Drive the OS into fullscreen — emitted only when a record freshly transitions INTO `entering`.
  | { type: 'SetFullscreen'; id: WindowId }
  // Drive the OS out of fullscreen — emitted only when a record freshly transitions INTO `leaving`.
  | { type: 'ExitFullscreen'; id: WindowId }
  | { type: 'ReconcileFullscreen'; id: WindowId }
  // Move the window's outer bounds — emitted by `react` as a structural diff of `bounds`, never from an event's own payload.
  | { type: 'SetBounds'; id: WindowId; bounds: Rectangle }
  | { type: 'SetDesktopMembership'; id: WindowId; membership: DesktopMembership }
  | { type: 'SetAcceptsInput'; id: WindowId; acceptsInput: boolean }
  | { type: 'DestroyWindow'; id: WindowId }
  // Tear down the window's content surface — the wedged-guest fallback (see the `CloseContent` command).
  | { type: 'CloseContent'; id: WindowId }
  // Guest-safe direct close: destroy and await the window's guests, then close the host.
  | { type: 'CloseWindowDirect'; id: WindowId }
  // Destroy every registered page-host guest WebContents, process-wide. The one effect that names no window.
  | { type: 'DestroyAllGuests' }
  | { type: 'HideApp' }
  | { type: 'FocusContent'; id: WindowId }
  | { type: 'AttachOverlayTo'; overlayId: WindowId; hostId: WindowId | null };

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
    lastRaiseRequest: null,
    lastAttention: null,
    pendingColdStartFocus: null,
    pendingSelectionFocus: null,
    // No windows yet, so no session — the first registration decides this.
    openedInBackground: false,
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
      // The OS won the race — fullscreen after all. Ported verbatim from
      // `window-state.ts`: a `pendingDesire` recorded here is dropped, not honored.
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
      // Aborted by the OS mid-enter. Ported verbatim: a `pendingDesire`
      // recorded here is dropped, not honored.
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
          // A lived fact (§ WindowRecord.priorKey's doc) — a re-registration
          // names no focus history at all, so it must not overwrite whatever
          // this window's own `OsFocusGained` already recorded.
          priorKey: existing.priorKey,
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
          // `WindowRecord.nonActivating`'s doc: a DECLARED fact, so an event
          // that names it overwrites, and an event that omits it keeps the
          // existing value rather than erasing it.
          ...(ev.nonActivating !== undefined
            ? { nonActivating: ev.nonActivating }
            : existing.nonActivating !== undefined
              ? { nonActivating: existing.nonActivating }
              : {}),
          // Intrinsic, same shape as `role`/`keepLive`/`escapeMode`/
          // `tracksBaseLayerTop`/`selfClosesOnBlur`/`nonActivating` above —
          // see `WindowRecord.appLifetime`'s doc: a DECLARED fact, so an
          // event that names it overwrites, and an event that omits it keeps
          // the existing value rather than erasing it.
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
        // § WindowRecord.priorKey's doc — registration is exactly the moment
        // nothing has taken key yet, so nothing held it before.
        priorKey: null,
        ...(ev.role !== undefined ? { role: ev.role } : {}),
        ...(ev.parentId !== undefined ? { parentId: ev.parentId } : {}),
        ...(ev.keepLive !== undefined ? { keepLive: ev.keepLive } : {}),
        ...(ev.escapeMode !== undefined ? { escapeMode: ev.escapeMode } : {}),
        ...(ev.tracksBaseLayerTop !== undefined ? { tracksBaseLayerTop: ev.tracksBaseLayerTop } : {}),
        ...(ev.selfClosesOnBlur !== undefined ? { selfClosesOnBlur: ev.selfClosesOnBlur } : {}),
        ...(ev.nonActivating !== undefined ? { nonActivating: ev.nonActivating } : {}),
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
      // `!visible`, so a `successorOnHide` fallback to the topmost content
      // window already skips the record being hidden without an explicit
      // exclusion.
      //
      // `successorOnHide` (F7 hide-returns-key) is what actually picks the
      // target, off the hiding record's own `priorKey` — see that helper's
      // doc. The topmost-content-window answer is now only its fallback, not
      // the rule.
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
          ? successorOnHide({ ...state, order }, target!)
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
      //
      // A record whose `priorKey` names the closed id is nulled in the SAME
      // pass, for the same class of reason: § WindowRecord.priorKey's doc —
      // `successorOnHide` must never consult a prior key holder that no
      // longer exists, and this is the one place membership shrinks (RULE 1).
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
      //
      // Gated on `admitsFocusAssert` exactly as `react`'s rule is: a report
      // naming a window whose record is hidden (or doomed) is recorded as
      // `key` — RULE 2 — but drives no raise, because a raise is an
      // activating show and would put that window back on screen. The
      // report is stale evidence of a raise that preceded the hide, not a
      // fact about what is on screen now.
      //
      // And not on a CONFIRMATION (`isOpConfirmation`): the echo of the
      // newest op issued to this window writes `key` and drives nothing —
      // `key` is written only here, so a raise issued by another transition
      // (a successor raise on hide, a parent refocus, a focus assert) is
      // still pending in `key` when its echo lands, and a plain diff would
      // raise the same window a second time.
      const issuesRaise = state.key !== ev.id && admitsFocusAssert(record, record.visible) && !isOpConfirmation(record, ev.cause);
      const opSeq = issuesRaise ? state.opSeqCounter + 1 : state.opSeqCounter;
      // § WindowRecord.priorKey's doc — written alongside `key` itself
      // (RULE 2's neighbor), only when this report genuinely hands key to a
      // DIFFERENT window than whoever held it: a report re-confirming the
      // window that already holds key names nothing new to remember.
      const takesKey = state.key !== ev.id;
      const movedRecord = {
        ...record,
        ...(issuesRaise ? { lastOpSeq: opSeq } : {}),
        ...(takesKey ? { priorKey: state.key } : {}),
      };
      const order = [...withoutRecord, movedRecord];
      // Mark this transition's own sweep victims `pendingHidden` (S3, fixed
      // 2026-09-05 — see `WindowRecord.pendingHidden`'s doc): the choice is
      // made HERE, off the state this same write is about to produce, so
      // `react`'s dismissal diff only ever OBSERVES it, never re-derives it —
      // which is what stops a second `OsFocusGained` queued behind the
      // first's own `DismissWindow`/`WindowHidden` pair from re-selecting a
      // window this transition already chose.
      const sweepVictims = new Set(selectTransientAutoclose({ ...state, order }, ev.id, attention.cause));
      return {
        ...state,
        order: sweepVictims.size > 0 ? order.map((w) => (sweepVictims.has(w.id) ? { ...w, pendingHidden: true } : w)) : order,
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
      //
      // `!w.pendingHidden` catches the other half, now that the mark
      // persists (S3, fixed 2026-09-05): a transient some EARLIER sweep
      // already chose is `pendingHidden` but no longer a `dismissVictims`
      // member — `isTransientAutocloseCandidate` excludes a marked record
      // from the law's own consideration set, so a fresh call here cannot
      // re-name it. Without this clause a window awaiting its `WindowHidden`
      // confirmation would fall through to `isAppResignSweepEligible` and
      // get the reversible treatment instead, resurrecting on the next
      // activation a window the machine already decided to dismiss.
      const dismissVictims = new Set(selectTransientAutoclose(state, null));
      const hidesImmediately = (w: WindowRecord): boolean =>
        !w.pendingHidden && !dismissVictims.has(w.id) && w.visible && (w.overlayFor !== undefined || isAppResignSweepEligible(w));
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
      // Marked `pendingHidden` here in the same map, not just excluded from
      // the reversible hide below (S3, fixed 2026-09-05 — see
      // `WindowRecord.pendingHidden`'s doc): the choice is made off `state`
      // now, so `react`'s dismissal diff only observes it. `!w.pendingHidden`
      // guards the reversible branch too, for a record ALREADY marked by an
      // earlier sweep and still awaiting its `WindowHidden` confirmation —
      // such a record is no longer a `dismissVictims` member (the mark took
      // it out of the law's own consideration set), so without this clause
      // it would fall through to `isAppResignSweepEligible` and be resurrected
      // by the next activation instead of staying dismissed.
      const dismissVictims = attentionLost ? new Set(selectTransientAutoclose(state, null)) : null;
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
      // The paint-flip sweep (S3, fixed 2026-09-05 — see
      // `WindowRecord.pendingHidden`'s doc and `react`'s dismissal diff): this
      // arm is what admits a just-painted record to candidacy
      // (`isTransientAutocloseCandidate`'s `orderable` clause), so it is also
      // where the law gets to ask about it, against whatever `lastAttention`
      // already stands — not a fresh report, the standing one, exactly
      // `selectTransientAutoclose`'s arguments in the `OsFocusGained` arm
      // above. An event names at most one record, so at most one id can flip
      // here; the mark lands only if THAT id is the law's answer.
      const attention = state.lastAttention;
      const isVictim =
        flipsToOrderable &&
        attention !== null &&
        order.some((w) => w.id === attention.holder) &&
        selectTransientAutoclose({ ...state, order }, attention.holder, attention.cause).includes(ev.id);
      return {
        ...state,
        order: isVictim ? order.map((w) => (w.id === ev.id ? { ...w, pendingHidden: true } : w)) : order,
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

    case 'FocusRaiseRequested': {
      // Stamps `lastOpSeq` without touching `key`, `order` or `lastAttention`; `key` moves only on the backend's confirming `OsFocusGained`.
      const targetRecord = state.order.find((w) => w.id === ev.id);
      const issuesRaiseRequest =
        state.key !== ev.id && targetRecord !== undefined && admitsFocusAssert(targetRecord, targetRecord.visible);
      const requestOpSeq = issuesRaiseRequest ? state.opSeqCounter + 1 : state.opSeqCounter;
      return {
        ...state,
        order: state.order.map((w) => (w.id === ev.id ? { ...w, lastOpSeq: requestOpSeq } : w)),
        opSeqCounter: requestOpSeq,
        lastRaiseRequest: { id: ev.id, seq: nextRaiseRequestSeq(state), ...(ev.intent === 'user' ? { intent: 'user' as const } : {}) },
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

// react(prev, ev, next) is a pure diff of `prev` against `next` and never branches on `ev.type`.
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
      effects.push({ type: 'CloseWindow', id: prevRecord.id, maximized: prevRecord.maximized, preMaxBounds: prevRecord.preMaxBounds });
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
  // hands the raise to `successorOnHide`'s answer (F7 hide-returns-key — the
  // window that was key before THIS one took it, if that window is still a
  // legitimate raise target, else the topmost content window, else nothing),
  // exactly mirroring `evolve`'s `WindowHidden` arm — which stamps
  // `lastOpSeq` on that same successor under this identical condition — so
  // this reads as a pure structural diff and never re-derives the guard from
  // `ev`.
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
    const successor = successorOnHide(next, nextRecord);
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
  // one in use, and `key` IS that fact: `OsFocusGained` is its only writer.
  // A `RaiseWindow` COMMAND no longer becomes one directly (`decide` turns it
  // into `FocusRaiseRequested` instead — see `State.lastRaiseRequest` and the
  // react rule that diffs it, right after this one) — but its eventual
  // confirmation, the backend's real `OsFocusGained` echo, still lands here
  // like any other focus report, so this rule still carries the command raise
  // through to `key` once the OS actually grants it. Diffing the top of
  // `order` instead answered the question only indirectly, and needed a
  // length-equality trick to do it — `order` moves for reasons that are not a
  // focus change, so the rule had to exclude every membership change to keep
  // registration and close from raising.
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
  //  1. It is the confirmation route every raise eventually needs. §0.1.10
  //     makes use-order and z-order one order, and `OsFocusGained` is `key`'s
  //     only writer, so whatever asked for the raise — a successor raise on
  //     hide, a parent refocus, a focus assert, or the backend's own echo of a
  //     `RaiseWindow` COMMAND (via `FocusRaiseRequested` — see
  //     `State.lastRaiseRequest`) — has no OTHER route to actually taking key.
  //     Drop this emission and the OS's grant of a raise would move `key` in
  //     the model and never re-assert the fact at the OS that caused it in the
  //     first place, on the rare disagreement (§0.1.6) that calls for it.
  //
  //  2. The feedback loop a naive version of this rule invites closes in one
  //     step because a CONFIRMATION is not a diff. `key` is written ONLY by
  //     the `OsFocusGained` evolve arm above, so when a raise was issued by
  //     some other transition (a successor raise on hide, a parent refocus, a
  //     focus assert, a `RaiseWindow` command's `FocusRaiseRequested`)
  //     `prev.key` still names the old holder when the raise's own echo
  //     lands — and a plain key diff fired again on that echo, minting
  //     another token and emitting another `RaiseWindow` for the same target
  //     (measured: two `raise-realized` records 1ms apart on every keepLive
  //     hide of the palette). The rule therefore reads the provenance `evolve`
  //     recorded in `next.lastAttention`: an echo carrying the token of the
  //     newest op issued to its window (`isOpConfirmation`) is that op's
  //     confirmation, written as `key` and driving nothing. (A LATE self-echo
  //     with an OLDER token is a different case handled at a different site:
  //     `isStaleSelfEcho` drops it BEFORE it reaches `evolve`.)
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
  //
  // GATED ON `admitsFocusAssert`, like the focus-assert rule below and
  // `FocusAssertRequested`: the target must be visible and not doomed. A
  // focus report can name a window whose record already reads hidden — a
  // hide is asynchronous at the OS, and the echo of the raise that preceded
  // a keepLive hide lands after it, once somebody else holds key. `key` is
  // still written (RULE 2), but an activating raise realized against a hidden
  // window re-shows it, the world focus that follows sweeps it, the sweep's
  // hide echoes, and around — the command-palette show/dismiss loop of
  // 2026-09-04. `evolve`'s `OsFocusGained` arm mirrors this gate in its
  // `issuesRaise`, which is what keeps the op-counter biconditional true.
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
    admitsFocusAssert(raiseTarget, raiseTarget.visible) &&
    !keyMoveConfirmsIssuedOp
  ) {
    // No `intent` here: a `RaiseWindow` COMMAND's own "the user asked for
    // this" fact is read off `State.lastRaiseRequest` by the react rule that
    // diffs it, not off this one — this rule only ever fires for a raise the
    // machine DERIVED (a successor, a parent refocus, a focus assert) or for
    // the OS's own reconciling report (§0.1.6), and neither carries intent.
    effects.push({ type: 'RaiseWindow', id: nextKey, opSeq: next.opSeqCounter });
  }

  // Transient autoclose (§0: "the machine applies the rule; no caller does").
  // Dismissal is now ONE structural diff, kept at this same slot —
  // immediately after the `RaiseWindow` rule and before `SetStacking` — so
  // emitted effect ordering is unchanged: the old machine's fixed effect
  // order was `[autoclose…, FOCUS_CONTENT]`, sweep before the trailing focus
  // re-assert, and this still rides right after the raise it is triggered
  // alongside.
  //
  // `selectTransientAutoclose` stays a pure QUERY, but `react` no longer
  // calls it (S3, fixed 2026-09-05 — the doubled-`DismissWindow` defect:
  // `window-rules.md` failure "Switcher's focus sweeps the palette twice for
  // one window"). The choice of WHICH record to dismiss is now made in
  // `evolve`, by the three sweep triggers themselves (`OsFocusGained`'s
  // focus-report sweep, `AppResignSettled`'s resign sweep,
  // `WindowContentOrderable`'s paint-flip sweep) — each calls
  // `selectTransientAutoclose` off the state it is about to produce and
  // marks its own victims `pendingHidden: true` in that SAME transition
  // (`WindowRecord.pendingHidden`'s doc). `react` only has to notice the mark
  // landing, as a structural diff like every other rule here: a record whose
  // `pendingHidden` reads not-true in `prev` and `true` in `next` yields one
  // `DismissWindow` — UNLESS that flip is explained by a teardown request
  // naming the same record instead of a sweep choosing it (the three
  // window-naming teardown arms mark the same field, but drive their own
  // effect through the Teardown rule below, not this one). "Explained by a
  // teardown" is the Teardown rule's own freshness test — `next.lastTeardown`
  // changing THIS transition — restated here to read the target it names;
  // `destroy-all-guests` names no window, so it can never explain a mark.
  //
  // Because the mark can only ever flip once per transition per record (it
  // is a boolean, and nothing un-marks it before `WindowHidden`/`WindowShown`
  // clears it), a record already marked in `prev` diffs to nothing here even
  // if some rule tried to mark it again — which is exactly what closes S3:
  // `isTransientAutocloseCandidate`'s `pendingHidden` clause keeps a marked
  // record out of `selectTransientAutoclose`'s own consideration set, so
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

  // Raise request: a structural diff of `State.lastRaiseRequest`, the sibling
  // of the focus-assert rule just above and `decide`'s translation of an
  // accepted `RaiseWindow` COMMAND (§0.1.10: use-order and z-order are one
  // order, so this — not the key-diff rule above — is the machine's route
  // from a raise ASK to the effect that realizes it; `key` itself moves only
  // later, off the backend's own confirming `OsFocusGained`, which the
  // key-diff rule above already carries through).
  //
  // GATED ON `next.key !== raiseRequest.id` IN ADDITION TO `admitsFocusAssert`
  // — the one place this rule diverges from the focus-assert rule's shape.
  // A `RaiseWindow` command on the window that already holds key is the
  // silent no-op `AssertFocus`/`FocusAssertRequested` exists to override (see
  // `window-kernel.test.ts` "a plain RaiseWindow command on the same window
  // drives NOTHING"); mirrors `evolve`'s own `issuesRaiseRequest` exactly, the
  // same one-token-per-op reason `admitsFocusAssert`'s doc gives for the other
  // three sites sharing it.
  const raiseRequest = next.lastRaiseRequest;
  if (raiseRequest !== null && raiseRequest.seq !== prev.lastRaiseRequest?.seq) {
    const record = next.order.find((w) => w.id === raiseRequest.id);
    if (record !== undefined && next.key !== raiseRequest.id && admitsFocusAssert(record, record.visible)) {
      effects.push({
        type: 'RaiseWindow',
        id: raiseRequest.id,
        opSeq: next.opSeqCounter,
        ...(raiseRequest.intent === 'user' ? { intent: 'user' as const } : {}),
      });
    }
  }

  return effects;
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
          ...(cmd.nonActivating !== undefined ? { nonActivating: cmd.nonActivating } : {}),
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
      // A raise is a focus REQUEST (§0.1.10: use-order and z-order are one
      // order, so raising a window is what will make it key) — not yet a
      // report that it is. `key` is a fact RULE 2 reserves for `OsFocusGained`
      // alone, so this arm must not manufacture one: doing so wrote `key`
      // (and reordered `order`, and stamped a fresh `lastAttention`) before
      // the OS had focused anything, which is how a backgrounded app — its
      // raise suppressed outright by `window-kernel-executor.ts planRaise` —
      // ended up with a model that believed a window was key the OS never
      // touched.
      //
      // So `decide` translates the command onto `FocusRaiseRequested`
      // instead: `evolve`'s arm for it stamps the target's `lastOpSeq` (the
      // same op-token machinery `FocusAssertRequested` uses) and records the
      // ask on `State.lastRaiseRequest`, and `react` diffs THAT fact into the
      // `RaiseWindow` effect — see both for the rest of the mechanism. `key`
      // moves only later, when the backend's own `OsFocusGained` echo arrives
      // carrying the stamped `opSeq` as its `cause`.
      //
      // `intent` rides the event straight from the command (see
      // `State.lastRaiseRequest`): this arm is the only producer that can say
      // a raise was asked for.
      return {
        events: [{ type: 'FocusRaiseRequested', id: cmd.id, ...(cmd.intent === 'user' ? { intent: 'user' } : {}) }],
      };
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
      // THE branch point (§0.1): keepLive === true hides, never closes, so
      // its content keeps running; otherwise it closes. This guard lives
      // here, never in `evolve`, and one closure (`dispose`) applies it to
      // `cmd.id` and to every id `descendantsToCascadeClose` returns alike —
      // a cascaded descendant gets the exact disposition a direct
      // `CloseOrHideWindow` on it would produce, never a forced close that
      // ignores its own keepLive (see `descendantsToCascadeClose`'s doc).
      const dispose = (id: WindowId): Event => {
        const target = state.order.find((w) => w.id === id)!;
        return target.keepLive ? { type: 'WindowHidden', id } : { type: 'WindowClosed', id };
      };
      // CASCADE: every window this one opened, transitively, over the
      // kernel's own `parentId` edges (`descendantsToCascadeClose`), deepest
      // first, before `cmd.id`'s own event.
      const cascade: Event[] = descendantsToCascadeClose(state, cmd.id).map(dispose);
      return { events: [...cascade, dispose(cmd.id)] };
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

export function windowById(state: State, id: WindowId): WindowRecord | null {
  return state.order.find((w) => w.id === id) ?? null;
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
  // `visible` ALONE, deliberately — no `pendingHidden` clause, unlike
  // `isContentWindow` above. A window on its way out is still on the screen,
  // and the app must not step aside while the user can still see it: gating on
  // the intent instead of the fact made every teardown REQUEST hide the app,
  // including requests that never complete. The real edge is the visibility
  // report that follows, and that is what this reads.
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

export function topmostBaseLayerPageHost(state: State): WindowRecord | null {
  const front = topmost(state, isBaseLayerFrontEligible);
  return front !== null && isBaseLayerPageHost(front) ? front : null;
}

export const TRANSIENT_ROLES: ReadonlySet<string> = new Set(['palette', 'quick-view', 'overlay', 'switcher']);

// Default provenance for a focus report that carries none — see `FocusCause`.
const WORLD_CAUSE: FocusCause = { kind: 'world' };

export function roleIn(set: ReadonlySet<string>, role: string | undefined): boolean {
  return role !== undefined && set.has(role);
}

export function isNonParentRole(role: string | undefined): boolean {
  return roleIn(TRANSIENT_ROLES, role);
}

// The `pendingHidden` clause keeps a chosen-for-dismissal window out of the next sweep until its hide confirms;
// the `orderable` clause keeps an unpainted window out of every sweep.
export function isTransientAutocloseCandidate(rec: WindowRecord): boolean {
  if (!rec.orderable) return false;
  if (rec.pendingHidden === true) return false;
  return roleIn(TRANSIENT_ROLES, rec.role) || rec.selfClosesOnBlur === true;
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
  // Policy, not derivation — see `selectTransientAutoclose`'s doc for why and
  // for the Space border / chrome overlay cases this spares and does not spare.
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
export function isAppResignSweepEligible(record: WindowRecord): boolean {
  return (
    record.visible &&
    record.layer > BASE_LAYER &&
    record.acceptsInput &&
    !record.selfClosesOnBlur &&
    !isContentWindow(record)
  );
}

export function admitsFocusAssert(record: WindowRecord, visible: boolean): boolean {
  return visible && !record.pendingHidden;
}

// Reads `priorKey`; both `evolve`'s `WindowHidden` arm and `react`'s successor loop must call this one helper.
function successorOnHide(state: State, hiddenRecord: WindowRecord): WindowRecord | null {
  if (hiddenRecord.priorKey === null) return null;
  const prior = state.order.find((w) => w.id === hiddenRecord.priorKey);
  if (prior !== undefined && admitsFocusAssert(prior, prior.visible)) return prior;
  return topmost(state, isContentWindow);
}
