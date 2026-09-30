// window-escape.ts — the Escape interpreter: a pure `(keyEvent, snapshot) ->
// EscapeOutcome` over an immutable kernel snapshot, emitting at most one
// `Command` stamped with `expectedVersion`, never querying or writing the
// kernel mid-decision. Design: `docs/design/window-manager.md`.

import {
  keyWindow,
  topmost,
  isContentWindow,
  isTransientAutocloseCandidate,
  roleIn,
  type Command,
  type State,
  type WindowId,
  type WindowRecord,
} from './window-kernel.js';

// ─────────────────────────────────────────────────────────────────────────────
// Inputs
// ─────────────────────────────────────────────────────────────────────────────

// One Escape keystroke, as the dispatch sites already describe it.
export interface EscapeKeyPress {
  // The window the keystroke was delivered to, or 'global' from the OS-level
  // grab or an unregistered window (all three `before-input-event` sites
  // degrade to 'global').
  readonly landedId: WindowId | 'global';
  // The mirrored "renderer already consumed this Escape" fact. ABSENT (not
  // yet published) makes the policy table below fire for every
  // non-fullscreen Escape — see the single writer in
  // `window-escape-renderer-handled.ts`.
  readonly rendererHandled?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Outcome
// ─────────────────────────────────────────────────────────────────────────────

type CloseOrHideCommand = Extract<Command, { type: 'CloseOrHideWindow' }>;
type SetFullscreenCommand = Extract<Command, { type: 'SetFullscreen' }>;

// Why an Escape produced no outcome at all — carried for logs and tests.
export type EscapeNothingReason =
  | 'stale-landing'
  | 'renderer-handled'
  | 'fullscreen-no-target'
  | 'policy-nothing'
  | 'target-changed';

// At most one `Command` per outcome: every `Command` stamps `expectedVersion`,
// and accepting it bumps `State.version`, so a second command in the same
// outcome would be stale by construction. `restoreTargetId` below therefore
// travels as a fact, not a command, for the caller to raise once the close is
// accepted and a fresh version is in hand.
export type EscapeOutcome =
  | { readonly kind: 'nothing'; readonly reason: EscapeNothingReason; readonly command: null }
  | { readonly kind: 'pass-through'; readonly id: WindowId; readonly command: null }
  | { readonly kind: 'open-switcher'; readonly command: null }
  | {
      readonly kind: 'close-switcher';
      readonly command: CloseOrHideCommand;
      readonly restoreTargetId: WindowId | null;
    }
  | { readonly kind: 'exit-fullscreen'; readonly command: SetFullscreenCommand }
  | { readonly kind: 'close-window'; readonly command: CloseOrHideCommand };

// ─────────────────────────────────────────────────────────────────────────────
// The switcher, as an ordinary window record
// ─────────────────────────────────────────────────────────────────────────────

export const SWITCHER_ROLES: ReadonlySet<string> = new Set(['switcher']);

// The switcher and the shared chrome overlay both register role:'overlay';
// told apart by attachment — an overlay with no host must never be visible
// (`WindowRecord.overlayFor`), so a visible role-'overlay' window with no
// `overlayFor` is the switcher.
export function switcherWindow(state: State): WindowRecord | null {
  return topmost(
    state,
    (r) => r.visible && r.overlayFor === undefined && roleIn(SWITCHER_ROLES, r.role),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Target resolution — the landed-vs-key reconciliation
// ─────────────────────────────────────────────────────────────────────────────

// What `resolveEscapeTarget` concluded.
export type EscapeTarget =
  | { readonly kind: 'window'; readonly record: WindowRecord }
  | { readonly kind: 'none' }
  | { readonly kind: 'stale' };

// `landedId` (a delivery record) and `state.key` (the OS's own key-holder
// answer) can legitimately disagree; neither is silently preferred.
export function resolveEscapeTarget(key: EscapeKeyPress, state: State): EscapeTarget {
  const holder = keyWindow(state);
  const landed =
    key.landedId === 'global' ? null : (state.order.find((w) => w.id === key.landedId) ?? null);

  if (holder === null) {
    if (landed !== null) return { kind: 'window', record: landed };
    // No key holder and no delivery record: a visible transient Escape closes
    // outright (`ESC_CLOSE_ROLES`) is still on screen and is what this Escape
    // acts on; the switcher is only for a press naming nothing at all.
    const transient = topmost(
      state,
      (r) => r.visible && isTransientAutocloseCandidate(r) && roleIn(ESC_CLOSE_ROLES, r.role),
    );
    return transient === null ? { kind: 'none' } : { kind: 'window', record: transient };
  }
  if (key.landedId === 'global') return { kind: 'window', record: holder };
  if (key.landedId === holder.id) return { kind: 'window', record: holder };
  // D2: key moved before this press was handled — drop it, never redirect
  // to the new holder, whatever its role.
  return { kind: 'stale' };
}

// ─────────────────────────────────────────────────────────────────────────────
// The policy table (ported from `izui-state.ts` via `window-state.ts`)
// ─────────────────────────────────────────────────────────────────────────────

// The roles Escape closes outright, whatever the session.
export const ESC_CLOSE_ROLES: ReadonlySet<string> = new Set(['quick-view', 'palette', 'utility']);

// The roles whose Escape falls through to the switcher — the same three
// roles as the kernel's `CONTENT_ROLES`, re-declared rather than aliased
// because they answer a different question and are free to diverge.
export const ESC_FALLBACK_ROLES: ReadonlySet<string> = new Set(['workspace', 'content', 'child-content']);

// Phase one: given the session and the target's role, does Escape close the window?
export function escapeClosePolicy(openedInBackground: boolean, role: string | undefined): 'close' | 'nothing' {
  if (roleIn(ESC_CLOSE_ROLES, role)) return 'close';
  if (role === 'workspace') return 'nothing';
  if (openedInBackground) return 'close';
  return 'nothing';
}

// Phase two: Escape had nowhere to navigate — does it fall back to the switcher?
export function escapeFallbackPolicy(
  openedInBackground: boolean,
  role: string | undefined,
): 'open-switcher' | 'nothing' {
  if (openedInBackground) return 'nothing';
  if (roleIn(ESC_FALLBACK_ROLES, role)) return 'open-switcher';
  return 'nothing';
}

// ─────────────────────────────────────────────────────────────────────────────
// The interpreter
// ─────────────────────────────────────────────────────────────────────────────

// Order matters: dismissing an open switcher is checked first, since that is
// what Escape means while one is showing, fullscreen or not; the fullscreen
// exit check runs ahead of every outcome that could open the switcher, so a
// switcher can never appear over a fullscreen window.
export function interpretEscape(key: EscapeKeyPress, state: State): EscapeOutcome {
  const target = resolveEscapeTarget(key, state);
  if (target.kind === 'stale') {
    return { kind: 'nothing', reason: 'stale-landing', command: null };
  }

  const switcher = switcherWindow(state);
  if (switcher !== null) {
    return {
      kind: 'close-switcher',
      command: { type: 'CloseOrHideWindow', id: switcher.id, expectedVersion: state.version },
      restoreTargetId: topmost(state, isContentWindow)?.id ?? null,
    };
  }

  if (target.kind === 'none') {
    // No target means no record for the fullscreen check below to run
    // against, so it runs here instead: otherwise the switcher opens over a
    // fullscreen window whenever nobody holds key.
    const fullscreenWindow = topmost(state, (r) => r.visible && r.fsMode.name !== 'normal');
    if (fullscreenWindow !== null) {
      return { kind: 'nothing', reason: 'fullscreen-no-target', command: null };
    }
    return { kind: 'open-switcher', command: null };
  }

  const record = target.record;
  if (record.escapeMode === 'ignore') return { kind: 'pass-through', id: record.id, command: null };

  if (record.fsMode.name !== 'normal') {
    return {
      kind: 'exit-fullscreen',
      command: { type: 'SetFullscreen', id: record.id, desired: false, expectedVersion: state.version },
    };
  }

  if (key.rendererHandled === true) {
    return { kind: 'nothing', reason: 'renderer-handled', command: null };
  }

  // Read off the kernel, not the keypress, so a caller cannot supply a
  // different session answer than the one the kernel has.
  if (escapeClosePolicy(state.openedInBackground, record.role) === 'close') {
    return {
      kind: 'close-window',
      command: { type: 'CloseOrHideWindow', id: record.id, expectedVersion: state.version },
    };
  }
  // A window that takes Escape while the app is inactive is a side task over
  // another app: Escape closes it and leaves the user where they were, whatever
  // its role. The switcher would bring the app forward over the task the user
  // never left. A workspace window is never closed by Escape, here included,
  // and a role Escape always closes keeps that answer below.
  if (!state.appActive && record.role !== 'workspace' && !roleIn(ESC_CLOSE_ROLES, record.role)) {
    return {
      kind: 'close-window',
      command: { type: 'CloseOrHideWindow', id: record.id, expectedVersion: state.version },
    };
  }
  if (escapeFallbackPolicy(state.openedInBackground, record.role) === 'open-switcher') {
    return { kind: 'open-switcher', command: null };
  }
  return { kind: 'nothing', reason: 'policy-nothing', command: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// The OS-level Escape grab
// ─────────────────────────────────────────────────────────────────────────────

// Off: an unreported key holder already handles Escape itself via
// `before-input-event`, which `globalShortcut` would pre-empt and eat.
const ARM_GRAB_FOR_UNREPORTED_KEY_HOLDER = false;

// `globalShortcut` pre-empts `before-input-event`, so the grab is armed only
// when no window would handle the keystroke itself; `=== false` is exact
// because `undefined` means "never reported", not "lost".
export function shouldArmEscapeGrab(state: State): boolean {
  if (!state.appActive) return false;
  if (switcherWindow(state) !== null) return false;
  const holder = keyWindow(state);
  if (holder === null) return true;
  if (holder.contentFocused === false) return true;
  return ARM_GRAB_FOR_UNREPORTED_KEY_HOLDER;
}
