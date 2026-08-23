/**
 * window-escape.ts — the Escape interpreter.
 *
 * Blueprint: `docs/design/window-manager.md` §0.1.3 ("Input interpretation
 * moves out — the dependency arrow points one way"). A pure
 * `(keyEvent, snapshot) -> EscapeOutcome`, where the outcome carries at most
 * ONE `Command` stamped with `expectedVersion`. It reads an immutable kernel
 * snapshot, never queries the kernel mid-decision, and never writes to it.
 * X11/Wayland/Android all put the boundary here: the dispatcher does not ask
 * the window manager "who is focused?" — focus is pushed out to it.
 *
 * This file is the replacement for `window-state.ts`'s `decideEscape`,
 * `applyEscape`, `decideEscapeUnhandled`, `escPolicy`, `escUnhandledPolicy`,
 * `applyUnhandledEscape` and `deriveEscGrabRegistered`. Wired through
 * `window-escape-runtime.ts handleEscapePress`, reached via
 * `window-machine.ts dispatchEscapePress`; the old reducer arm is gone.
 *
 * ─── THE BUG THIS EXISTS TO FIX ──────────────────────────────────────────────
 *
 * `window-state.ts`'s `ESC_PRESSED` arm called `applyEscape(state, effects)` and
 * never read `event.landedId`, which the event type declares. `decideEscape`
 * always targeted `state.front`, and `front` was deliberately satellite-excluding
 * — so a palette holding key was never a possible target, and Escape asked an
 * unrelated content window what to do. Reproduced live, twelve consecutive
 * presses on a command palette with nothing closing. All four dispatch sites
 * resolved `landedId` correctly; the reducer discarded it.
 *
 * Here the target is derived from the two facts that actually describe where
 * the keystroke went — the kernel's `key` and the keypress's own `landedId` —
 * reconciled by `resolveEscapeTarget` below. `topmost(state, isContentWindow)`
 * (the honest mapping of the retired `front`) is used for exactly one thing:
 * naming the window to restore when the switcher closes. It is never the
 * target. `targeting reverts to the topmost content window` in the test file
 * is the regression guard for that.
 *
 * ─── IMPORTS ────────────────────────────────────────────────────────────────
 *
 * `window-kernel.ts` keeps ZERO value imports (the same rule `window-state.ts`
 * followed before it was deleted) so the unit runner can parse it under
 * `ELECTRON_RUN_AS_NODE=1` (no transitive `electron`). This file keeps that
 * property with exactly one permitted value
 * import — `./window-kernel.js` itself, which imports nothing at all, so the
 * load still terminates without touching `electron`. Re-implementing
 * `keyWindow` / `topmost` / `isContentWindow` / `roleIn` locally would satisfy
 * the letter of the rule and recreate precisely the two-list divergence the
 * one-order rule (§0.1.4) exists to delete.
 *
 * ─── WHAT IS NOT MODELLED, AND WHY ──────────────────────────────────────────
 *
 * Each of these is a live arm of the old code that has no counterpart here.
 * They are absent by decision, not by oversight.
 *
 *  1. `escPolicy`'s `'overlay'` arm (`-> 'close-and-restore'`). Unreachable in
 *     the old reducer because the shared chrome overlay registers
 *     `satellite: true` and a satellite can never be `front`. Still unreachable
 *     here, for two independent reasons that both have to fail before it
 *     matters: the shared chrome overlay opts OUT of the machine's Escape
 *     attach entirely (`hybrid-overlay.ts ensureOverlay` — "the overlay owns
 *     Escape in its own renderer"), so it never produces a keypress; and the
 *     OTHER `role: 'overlay'` window, the switcher, is decided by
 *     `switcherWindow` above the policy table and never reaches it.
 *  2. `escPolicy`'s `'close-and-restore'` outcome. It differed from `'close'`
 *     only in name — `decideEscapeUnhandled` collapsed both to
 *     `{ kind: 'close-window' }`. The policy here returns `'close'` for both
 *     situations, so the distinction disappears rather than being carried as a
 *     value nothing branches on.
 *  3. `escUnhandledPolicy`'s `'overlay'` SESSION arm. `window-machine.ts
 *     clampSession` maps the coordinator's `'overlay'` to `'active'` before
 *     dispatch, so it was already dead. `EscapeSession` below is the clamped
 *     vocabulary, which makes it unrepresentable rather than merely unreached.
 *  4. `EscapeMode`'s `'close'` / `'navigate'` / `'auto'`. The kernel record
 *     carries `escapeMode?: 'ignore'` and nothing else — see
 *     `WindowRecord.escapeMode`, which documents why the other three were never
 *     decision inputs (`'navigate'` became `role: 'workspace'` at registration;
 *     the other two reached no branch).
 *  5. `decideEscape`'s "front record missing" arm. `keyWindow` resolves
 *     `state.key` against `order` and returns null on a miss, so a dangling id
 *     reads as "nobody holds key". The arm is unrepresentable, not merely dead.
 *  6. The renderer answer's `close` payload field. `ESC_RENDERER_ANSWER` carried
 *     it; nothing ever read it. The answer this file takes instead
 *     (`EscapeKeyPress.rendererHandled`, below) is a single boolean.
 *
 * ─── THE ROUND TRIP LEAVES THE REDUCER; THE ASK ITSELF STAYS ────────────────
 *
 * What this file deletes is the reducer's two-phase shape: `ASK_RENDERER` /
 * `ESC_RENDERER_ANSWER` / `escSeq` / `escAsk`, the event pair that made one
 * keypress two transitions. "Did the renderer consume this Escape?" is an INPUT
 * here (`EscapeKeyPress.rendererHandled`), so `interpretEscape` decides in one
 * pass over one state.
 *
 * THE ASK IS NOT DELETED, and neither is its 500ms timeout — an earlier version
 * of this note claimed both, and the claim was wrong in a way that would break
 * the wiring built on it. The mirrored fact
 * (`window-escape-renderer-handled.ts`) has exactly ONE writer: the renderer's
 * `escape-pressed` handler in `renderer/tile-preload.cts`, which fires only
 * BECAUSE an ask was sent. Remove the ask and the cache does not go empty, it
 * goes STALE — frozen at whatever the tile answered to the previous press — so
 * a window that opens a dialog decides its first Escape against the answer to
 * an unrelated one. The ask therefore moves OUT of the reducer and into the
 * caller, which asks and then re-enters `interpretEscape` with the answer.
 * `windows.ts askWebContentsToHandleEscape` is that ask, unchanged.
 *
 * The precedents this note used to cite for a proactively-published fact —
 * `CONTENT_FIRST_RESPONDER_CHANGED` -> `WindowRecord.contentFocused`, and
 * `hybrid-editable-focus.ts isEditableFocusedForWc(...)` — are real, and are
 * what a future producer would look like. They are not what exists today.
 *
 * Until such a producer lands, a caller that passes no `rendererHandled` gets a
 * decision in which the "renderer handled it" outcome is not expressible, and
 * the policy table fires for every non-fullscreen Escape.
 */

import {
  keyWindow,
  topmost,
  isContentWindow,
  roleIn,
  type Command,
  type State,
  type WindowId,
  type WindowRecord,
} from './window-kernel.js';

// ─────────────────────────────────────────────────────────────────────────────
// Inputs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The app's session mode. Mirrors `window-state.ts IzuiSession` — deliberately
 * re-declared rather than imported, because it is the CLAMPED vocabulary
 * (`window-machine.ts clampSession` folds the coordinator's `'overlay'`
 * into `'active'`), and because this file's only import is the kernel.
 *
 * It stays an interpreter-side input rather than becoming a kernel field: it is
 * an app mode, not a window fact, and the kernel models window facts only.
 */
export type EscapeSession = 'idle' | 'transient' | 'active';

/** One Escape keystroke, as the dispatch sites already describe it. */
export interface EscapeKeyPress {
  /**
   * The window whose web contents the keystroke was delivered to, or `'global'`
   * when it came from the OS-level grab (`electron-window-backend.ts`) or from a
   * window that has no kernel registration — the three live `before-input-event`
   * sites already degrade an unregistered window to `'global'`.
   */
  readonly landedId: WindowId | 'global';
  /** App session mode at keypress time. */
  readonly session: EscapeSession;
  /**
   * The mirrored "the renderer already consumed this Escape" fact, read
   * synchronously at keypress time — the replacement for the `ASK_RENDERER`
   * round trip (see the file docblock). ABSENT means no such fact was published,
   * which is the state of the world until the producer is wired: the policy
   * table then fires for every non-fullscreen Escape.
   */
  readonly rendererHandled?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Outcome
// ─────────────────────────────────────────────────────────────────────────────

type CloseOrHideCommand = Extract<Command, { type: 'CloseOrHideWindow' }>;
type SetFullscreenCommand = Extract<Command, { type: 'SetFullscreen' }>;

/** Why an Escape produced no outcome at all — carried for logs and tests. */
export type EscapeNothingReason =
  /** The delivery record named a window that no longer holds key (see `resolveEscapeTarget`). */
  | 'stale-landing'
  /** The mirrored renderer fact says the page consumed it. */
  | 'renderer-handled'
  /** Both policy phases said "nothing". */
  | 'policy-nothing';

/**
 * WHY FOUR OF THESE CARRY `command: null`.
 *
 * `open-switcher`, `close-switcher`'s restore, `pass-through` and "do nothing"
 * have no kernel `Command`, and none of them should GET one:
 *
 *   - `pass-through` and `nothing` ask the window manager for exactly nothing.
 *     A `Command` variant meaning "no operation" would be a guard-free no-op in
 *     `decide` and an empty arm in `evolve` — surface with no transition behind
 *     it.
 *   - `open-switcher` CREATES a window. The kernel never creates windows; a
 *     window enters `order` only when something outside registers one
 *     (`RegisterWindow` carries a `WindowId` the caller already minted). Opening
 *     the switcher is `cmd:execute:windows` — an app action whose eventual
 *     `WindowRegistered` is a separate, later step.
 *   - `close-switcher` DOES have a kernel command (`CloseOrHideWindow` on the
 *     switcher's own record — it is an ordinary window). Its restore-raise does
 *     not travel with it, and cannot: every `Command` carries `expectedVersion`,
 *     and accepting the close bumps `State.version`, so a second command emitted
 *     in the same breath would be guaranteed `'stale-version'`. **At most one
 *     command per outcome is a consequence of the version token, not a style
 *     choice.** The restore target travels as a FACT (`restoreTargetId`) for the
 *     caller to raise once the close is accepted and a fresh version is in hand.
 *
 * So the kernel's `Command` surface gains nothing. Everything that is genuinely
 * a window-manager operation already has a variant.
 */
export type EscapeOutcome =
  | { readonly kind: 'nothing'; readonly reason: EscapeNothingReason; readonly command: null }
  /** Hand the keystroke to the page untouched — the window declared `escapeMode: 'ignore'`. */
  | { readonly kind: 'pass-through'; readonly id: WindowId; readonly command: null }
  /** No target at all: Escape falls back to the global switcher (old `decideEscape` step 2). */
  | { readonly kind: 'open-switcher'; readonly command: null }
  | {
      readonly kind: 'close-switcher';
      readonly command: CloseOrHideCommand;
      /**
       * The window to raise once the close is accepted, or null. Derived from
       * `topmost(state, isContentWindow)` — NOT from a captured `previousFront`.
       * A captured value is a second list that can disagree with `order`; the
       * derived one cannot.
       */
      readonly restoreTargetId: WindowId | null;
    }
  | { readonly kind: 'exit-fullscreen'; readonly command: SetFullscreenCommand }
  | { readonly kind: 'close-window'; readonly command: CloseOrHideCommand };

// ─────────────────────────────────────────────────────────────────────────────
// The switcher, as an ordinary window record
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The role the window switcher registers under. `features/windows/background.js
 * openWindowsView` opens it with `role: 'switcher'`, which
 * `classifyWindowRegistration` still turns into `class: 'overlay'`.
 *
 * It is a SET rather than a bare string, kept around from when the switcher
 * shared `role: 'overlay'` with the chrome overlay — see the ambiguity
 * `switcherWindow` has to work around.
 */
export const SWITCHER_ROLES: ReadonlySet<string> = new Set(['switcher']);

/**
 * The open switcher window, or null.
 *
 * The switcher is an ORDINARY window record found by scanning `order` — not a
 * `switcher: SwitcherState` blob beside the snapshot. The old blob carried
 * `open`, `windowId` and `previousFront`, each of which could disagree with the
 * window list (`SWITCHER_OPENED` existed to "fix up the sentinel windowId to the
 * real overlay id" after the fact). All three are derivable: open-ness is the
 * record's `visible`, the id is the record's `id`, and the restore target is
 * `topmost(state, isContentWindow)`.
 *
 * DISAMBIGUATION, and the one soft spot here. Two windows register
 * `role: 'overlay'`: the switcher, and the shared chrome overlay
 * (`hybrid-overlay.ts ensureOverlay`). They are told apart by the attachment
 * relation — `WindowRecord.overlayFor` documents that an overlay with no host
 * "belongs to nothing and must not be on screen", so a VISIBLE role-`'overlay'`
 * window carrying no attachment is the switcher. That derivation is sound
 * against the documented invariant but leans on it: an unattached chrome overlay
 * that is momentarily visible would read as a switcher. Giving the switcher its
 * own role at registration removes the inference entirely, and is the reason
 * `SWITCHER_ROLES` is a set.
 */
export function switcherWindow(state: State): WindowRecord | null {
  return topmost(
    state,
    (r) => r.visible && r.overlayFor === undefined && roleIn(SWITCHER_ROLES, r.role),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Target resolution — the landed-vs-key reconciliation
// ─────────────────────────────────────────────────────────────────────────────

/** What `resolveEscapeTarget` concluded. */
export type EscapeTarget =
  /** Act on this window. */
  | { readonly kind: 'window'; readonly record: WindowRecord }
  /** Nobody can be named: no key window and no usable delivery record. */
  | { readonly kind: 'none' }
  /** The delivery record and `key` disagree — this keystroke is stale. */
  | { readonly kind: 'stale' };

/**
 * THE RECONCILIATION RULE. `landedId` is a delivery record ("this keystroke was
 * handed to window X's web contents"); `state.key` is the OS's own answer to
 * "who holds keyboard focus", written only from OS reports. They can legitimately
 * disagree — a keystroke queued while focus moved, or a grab that fired because
 * no window could deliver — so neither is silently preferred:
 *
 *   1. NO KEY WINDOW (`key` null, or dangling so `keyWindow` resolves to null).
 *      The delivery record is the only fact there is, so it wins: the landed
 *      window is the target. A landed `'global'` (or an id no longer in `order`)
 *      leaves nothing to name -> `none`, which is the old `front == null ->
 *      open-switcher` fallback.
 *
 *   2. GRAB DELIVERY (`landedId === 'global'` with a key window present). There
 *      is no delivery record to reconcile — the OS grab pre-empts
 *      `before-input-event` precisely when no window's own handler could fire —
 *      so the key window is the target. This is the `7c61e917` shape: a page-host
 *      that holds key while its content view is not first responder is deaf to
 *      `before-input-event`, the grab delivers instead, and the target is still
 *      that host. Preferring the (absent) landing here would fall through to
 *      `open-switcher` — which IS the `ebb10894` bug.
 *
 *   3. AGREEMENT (`landedId === state.key`). The ordinary case; the target is
 *      that window. This is what fixes the palette: the palette both receives the
 *      keystroke and holds key, so it is the target — where the old reducer,
 *      reading neither fact, asked `front`.
 *
 *   4. DISAGREEMENT (a live delivery record naming a window that is not the key
 *      window). The keystroke was aimed at a window that has since lost focus.
 *      Acting on the CURRENT key window would apply a keystroke meant for A to
 *      B — closing a window the user never pressed Escape in. So the keystroke is
 *      dropped (`stale`), and the user's next press decides against a settled
 *      world. This is the structural replacement for the `escSeq` epoch check,
 *      which existed for exactly this hazard ("Esc reopens the switcher 500ms
 *      after closing it") and needed a round trip to express it.
 *
 * Dropping is the conservative half of a genuine choice: the alternative —
 * retarget to the key window and act anyway — never loses a keystroke but can
 * act on the wrong window, and a lost Escape costs one more press while a wrong
 * close costs the user's work.
 */
export function resolveEscapeTarget(key: EscapeKeyPress, state: State): EscapeTarget {
  const holder = keyWindow(state);
  const landed =
    key.landedId === 'global' ? null : (state.order.find((w) => w.id === key.landedId) ?? null);

  if (holder === null) {
    return landed === null ? { kind: 'none' } : { kind: 'window', record: landed };
  }
  if (key.landedId === 'global') return { kind: 'window', record: holder };
  if (key.landedId === holder.id) return { kind: 'window', record: holder };
  return { kind: 'stale' };
}

// ─────────────────────────────────────────────────────────────────────────────
// The policy table (ported from `izui-state.ts` via `window-state.ts`)
// ─────────────────────────────────────────────────────────────────────────────

/** The roles Escape closes outright, whatever the session. Ported from `escPolicy`. */
export const ESC_CLOSE_ROLES: ReadonlySet<string> = new Set(['quick-view', 'palette', 'utility']);

/**
 * The roles whose Escape falls through to the switcher. Ported from
 * `escUnhandledPolicy`; the same three roles as the kernel's `CONTENT_ROLES`,
 * re-declared rather than aliased because they answer a different question and
 * are free to diverge — `CONTENT_ROLES` says "a window the user works in",
 * this says "a window whose Escape means: show me everything".
 */
export const ESC_FALLBACK_ROLES: ReadonlySet<string> = new Set(['workspace', 'content', 'child-content']);

/**
 * Phase one: given the session mode and the target's role, does Escape close the
 * window? Ported from `window-state.ts escPolicy`, minus the two dead outcomes
 * (items 1 and 2 of the file docblock): the `'overlay'` arm is gone, and
 * `'close-and-restore'` collapses into `'close'`.
 */
export function escapeClosePolicy(session: EscapeSession, role: string | undefined): 'close' | 'nothing' {
  if (roleIn(ESC_CLOSE_ROLES, role)) return 'close';
  if (role === 'workspace') return 'nothing';
  if (session === 'transient') return 'close';
  return 'nothing';
}

/**
 * Phase two: Escape had nowhere to navigate — does it fall back to the switcher?
 * Ported from `window-state.ts escUnhandledPolicy`, minus its `'overlay'` session
 * arm (item 3 of the file docblock: `EscapeSession` cannot hold that value).
 */
export function escapeFallbackPolicy(
  session: EscapeSession,
  role: string | undefined,
): 'open-switcher' | 'nothing' {
  if (session === 'transient') return 'nothing';
  if (roleIn(ESC_FALLBACK_ROLES, role)) return 'open-switcher';
  return 'nothing';
}

// ─────────────────────────────────────────────────────────────────────────────
// The interpreter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `(keyEvent, snapshot) -> EscapeOutcome`. Pure: reads `state`, writes nothing,
 * asks the kernel nothing it was not handed.
 *
 * Step order, preserving `decideEscape`'s (steps 1, 2, 3, 4, 5, 6) with the
 * reconciliation in front of all of it:
 *
 *   0. reconcile landed vs key                      -> `stale` ends here
 *   1. the switcher is open                         -> close-switcher
 *   2. no target                                    -> open-switcher
 *   3. target declared `escapeMode: 'ignore'`       -> pass-through
 *   4. target is not `fsMode: 'normal'`             -> exit-fullscreen
 *   5. the renderer consumed it (mirrored fact)     -> nothing
 *   6. the role x session policy table              -> close / open-switcher / nothing
 *
 * Step 4 sits ahead of every switcher-OPENING outcome on every entry path — the
 * `before-input-event` sites and the OS grab produce the same keypress — so
 * "the switcher opened on top of a fullscreen window" stays structurally
 * impossible. Step 1 stays ahead of step 4 because dismissing an open switcher
 * is what Escape means while it is up, fullscreen or not.
 */
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

  if (target.kind === 'none') return { kind: 'open-switcher', command: null };

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

  if (escapeClosePolicy(key.session, record.role) === 'close') {
    return {
      kind: 'close-window',
      command: { type: 'CloseOrHideWindow', id: record.id, expectedVersion: state.version },
    };
  }
  if (escapeFallbackPolicy(key.session, record.role) === 'open-switcher') {
    return { kind: 'open-switcher', command: null };
  }
  return { kind: 'nothing', reason: 'policy-nothing', command: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// The OS-level Escape grab
// ─────────────────────────────────────────────────────────────────────────────

/**
 * OPEN POLICY QUESTION — NEEDS A HUMAN DECISION. See `shouldArmEscapeGrab`.
 *
 * Whether a window that holds key but reports nothing about its content's first
 * responder status (a palette, a plain `browser` window) should arm the grab.
 *
 * `true` here means "the key holder delivers its own Escape, so stay out of the
 * way"; flipping it to a role/kind test would arm the grab whenever the key
 * holder is not a content window — which is what the old truth table's
 * `{appActive: true, front: content, contentFocused: false} -> grab` row
 * effectively did, because `front` stayed pinned to the content window while the
 * palette took key, and `contentFocused: false` was a PROXY for "someone else
 * holds key" that the old state could not say directly.
 *
 * The behaviour chosen (do NOT arm) is defensible from the code: `windows.ts
 * addEscHandler` attaches a `before-input-event` Escape listener to every
 * `BrowserWindow`'s web contents AND to each `<webview>` guest, so a
 * key-holding BrowserWindow — palette included — already delivers Escape. An OS
 * `globalShortcut` PRE-EMPTS `before-input-event` (the mechanism behind both
 * `ebb10894` and the `7fffa286` switcher-reopen loop), so arming it over a
 * window that would have handled the keystroke eats that window's own Escape.
 * The three-valued `contentFocused` does the work by itself: a browser window
 * never reports, so it reads `undefined`, and `undefined !== false`.
 *
 * The alternative is not absurd: it keeps the old truth table literally, and it
 * would cover a hypothetical key holder with no `before-input-event` attach at
 * all. Nothing in the tree is such a window today.
 */
const ARM_GRAB_FOR_UNREPORTED_KEY_HOLDER = false;

/**
 * Should the OS-level Escape grab be registered right now? The port of
 * `window-state.ts deriveEscGrabRegistered`, as this subsystem querying a
 * snapshot (§0.1.3) rather than a reducer selector.
 *
 * The grab is a net for the ONE case where Escape has no handler at all: the
 * `before-input-event` route is deaf and nothing else would fire. It must stay
 * OFF whenever some window would handle the keystroke itself, because
 * `globalShortcut` pre-empts `before-input-event` rather than backing it up.
 *
 *   - app not active                  -> off. Not our keystroke.
 *   - the switcher is open            -> off. It handles Escape in its own
 *                                        renderer; a grab would eat it, and a
 *                                        second `ESC_PRESSED` per keypress is
 *                                        the `7fffa286` reopen loop.
 *   - nobody holds key                -> ON. No window can receive
 *                                        `before-input-event`, so the grab is
 *                                        the only route. (Old: `front === null`.)
 *   - key holder reported a LOST      -> ON. `7c61e917`: the host is key but its
 *     content first responder            content view is not first responder, so
 *                                        its handler never fires.
 *   - key holder reported nothing     -> see `ARM_GRAB_FOR_UNREPORTED_KEY_HOLDER`.
 *
 * The `=== false` test is exact and load-bearing, unchanged from the original:
 * ABSENT is NOT unfocused. A `kind: 'browser'` window never reports at all, and
 * a page-host in the gap between a driven content focus and the async native
 * `'focus'` event has not reported YET — reading either as a loss would arm the
 * grab permanently for browser windows and flap it after every fresh show.
 *
 * Reads the snapshot ONLY. Widening this back into live Electron/OS reads is
 * explicitly rejected (design §2 / §7): it reintroduces the rival-authority
 * pattern the machine exists to delete, and papers over a wrong answer instead
 * of surfacing it.
 */
export function shouldArmEscapeGrab(state: State): boolean {
  if (!state.appActive) return false;
  if (switcherWindow(state) !== null) return false;
  const holder = keyWindow(state);
  if (holder === null) return true;
  if (holder.contentFocused === false) return true;
  return ARM_GRAB_FOR_UNREPORTED_KEY_HOLDER;
}
