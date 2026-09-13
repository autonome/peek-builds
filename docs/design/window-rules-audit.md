# Window rules audit

The kernel at `dc3febab` read against `window-rules.md`, one line per rule. Verdicts: **holds**
(one site, agrees), **scattered** (3+ sites must agree for the rule to hold; they do today unless
noted), **contradicted** (a site does the opposite), **unimplemented** (nothing expresses it).
Gestures G1–G13 are composites of the rules below and are not audited separately.

| Rule | Verdict | Sites | Finding |
|---|---|---|---|
| F1 one-key | holds (fixed 2026-09-13) | `window-kernel.ts evolve OsFocusGained`, `evolve FocusRaiseRequested`, `decide RaiseWindow` | `key` now has exactly one writer arm. `decide`'s raise arm no longer manufactures an `OsFocusGained` — it translates onto `FocusRaiseRequested` (`State.lastRaiseRequest`), which stamps the target's `lastOpSeq` and drives `react`'s `RaiseWindow` effect without touching `key`. The model no longer believes a window is key until the backend's own `OsFocusGained` echo, carrying that stamped opSeq, actually arrives — an app-inactive raise the executor suppresses (`planRaise`) never gets one. |
| F2 machine-labelled | scattered | `electron-window-backend.ts armSelfCausedFocus`, `takeFocusCause`, `raiseWindow`, `performOsShow`, `focusContent`, `win.on('focus'/'blur')` | Every native call that moves focus arms a token, seven sites. Provenance is right only while all seven agree. |
| F3 confirmation-drives-nothing | contradicted (narrowed 2026-09-13) | `window-kernel.ts evolve OsFocusGained`, `react` sweep (a) | The raise half holds via `isOpConfirmation`. The dismissal half does not: the arm writes a fresh `lastAttention.seq` unconditionally, so a raise's own confirmation still runs the autoclose sweep. What's closed: a `RaiseWindow` COMMAND no longer manufactures its own `OsFocusGained`, so it no longer runs the sweep TWICE (once on the manufactured report, again on the real OS confirmation) — there is only the one real report now. What stands: that one confirmation, for every raise source (command, successor, parent refocus, focus assert), still runs the sweep once, unconditionally. |
| F4 raise-means-key | scattered | `window-kernel-executor.ts planRaise`, `planRaiseRealization`, `electron-window-backend.ts raiseWindow` | `planRaiseRealization` is exact. The `suppressed` mask above it now applies to machine raises only (`Effect.RaiseWindow.intent` exempts a user-intended one); `show-and-focus-content` still produces a visible window that accepts no input. `raiseWindow` activates the app on a user-intended raise (darwin, `take-key` and `show-and-take-key`); no other site does. |
| F5 raise-needs-a-surface | scattered (one bypass closed 2026-09-13) | `window-kernel.ts admitsFocusAssert` and its ~8 callers, `evolve FocusRaiseRequested`, `react` raise-request rule, `planRaise` | One predicate, consulted independently at ~8 sites. `decide`'s raise arm no longer bypasses it: `evolve`'s `FocusRaiseRequested` arm and `react`'s raise-request rule both gate on `admitsFocusAssert`, and since `key` no longer moves until the backend's confirmation lands, a target that fails it is never asked for at all — the OS is never even told to raise it. `planRaise` remains a separate bypass, so the rule still does not hold everywhere. |
| F6 intent-beats-inactive | holds (fixed 2026-09-05) | `renderer/cmd/background.js openPanelWindow`, `features/peeks/background.js`, `features/slides/background.js`, `features/windows/background.js` (`type: 'panel'` at open), `izui-roles.ts windowNonActivating`, `ipc.ts` window-open handler (both the hybrid page-host branch and the browser branch) -> `window-machine.ts registerWindowWithMachine` -> `window-kernel-dispatch.ts kernelRegisterWindow` -> `window-kernel.ts WindowRecord.nonActivating`, `window-kernel-executor.ts planRaise` (the panel arm, keyed on `nonActivating`), `electron-window-backend.ts showWindow`/`raiseWindow` | The `type: 'panel'` open-time declaration is now stored on the record (`WindowRecord.nonActivating`, the same DECLARED-at-registration shape as `selfClosesOnBlur`) instead of being read back off `windowClass`/`role`. `showWindow`'s page-host mask reads `record.nonActivating` in place of `windowClass !== 'quick-view'`; `raiseWindow` no longer calls `app.focus({ steal: true })` for a panel's user-intended raise — only for a non-panel's, where AppKit's ordinary `win.focus()` does not activate the app on its own. `planRaise`'s page-host arm reads `record.nonActivating` in place of `role === 'quick-view'`. One channel, one word, for BOTH halves of the rule now: `intent: 'user'` still exempts a user-asked-for raise from the app-inactive mask, and `nonActivating` decides whether that raise is allowed to bring the app forward at all. |
| F7 hide-returns-key | holds | `window-kernel.ts successorOnHide`, consulted by `react`'s successor loop and `evolve WindowHidden` | `WindowRecord.priorKey` records who held key immediately before the hiding window took it, written by `OsFocusGained` and cleared by `WindowClosed`. `successorOnHide` reads it: a live, admitting prior key holder gets key back; a missing/hidden/doomed one falls back to the topmost content window; `null` (nothing in Peek was key before) raises nothing, rather than the topmost content window unconditionally. |
| F8 dismissal-keeps-the-app | holds (rule rewritten 2026-09-13) | `react` successor loop, `holdsAppOnScreen` | The rule used to demand that something visible be key after every dismissal; the code never did that, and the code was right. Dismissing a key palette with no content window up leaves `key` empty while the app stays frontmost, which is what the rule now says. Nothing hands focus to another app. |
| V1 paint-before-dismiss | holds | `window-kernel.ts isTransientAutocloseCandidate`, ordering floor in `selectTransientAutoclose` | `if (!rec.orderable) return false` gates every reader. |
| V2 show-is-explicit | scattered | `evolve WindowShown`, `window-kernel-executor.ts isStaleWindowEcho`, `electron-window-backend.ts win.on('show')` | The kernel arm is unconditional; both guards live outside it. A producer emitting `WindowShown` without an `opSeq` bypasses the executor guard. |
| V3 keeplive-hides | holds | `decide CloseOrHideWindow`, `runEffect DismissWindow` | One closure decides hide vs close for the target and every cascaded descendant. |
| V4 reversible-is-not-final | holds | `evolve AppResigned`, `AppResignSettled`, `AppActivated`, `appBlurRevealAdmits` | Resign hides exclude every dismissal victim; activation refuses `pendingHidden`. |
| V5 late-paint-still-obeys | holds | `react` rule (c) | The `orderable` flip re-asks the law against the standing attention. |
| V6 one-close-per-input | holds | `window-escape-runtime.ts handleEscapePress` pass B, `renderer/cmd/panel.js shutdown`, `isTransientAutocloseCandidate` | Escape path is exact. Blur sweeps no longer double up since `b7e685e6`, see S3. |
| S1 order-is-total | holds | `evolve RegisterWindow`, `WindowClosed`, `OsFocusGained` | The only `filter` that drops a member is in `WindowClosed`. |
| S2 fixed-point | scattered | `window-kernel-executor.ts pump`, `isStaleSelfEcho`, `isStaleWindowEcho`, `isOpConfirmation`, `planRaiseRealization` | `pump` is an unbounded FIFO with no depth limit; termination is the conjunction of four guards at four sites. |
| S3 one-raise-per-cause | contradicted (raise half), holds (dismissal half, fixed 2026-09-05) | `evolve WindowClosed`, `react` parent-refocus and focus-assert rules, `evolve OsFocusGained`/`AppResignSettled`/`WindowContentOrderable`, `selectTransientAutoclose`, `isTransientAutocloseCandidate` | The raise half is unchanged: one `WindowClosed` can emit two raises sharing one token. The dismissal half (select a window for dismissal at most once until its hide is confirmed) now holds: the three `react` rules that used to re-query `selectTransientAutoclose` off `next` were collapsed into `evolve` marking its own chosen victims `pendingHidden` in the SAME transition that selects them, and `isTransientAutocloseCandidate` now excludes a marked record from the law's own consideration set, so a later sweep cannot choose it again before `WindowHidden`/`WindowShown` clears the mark. `react` no longer calls the selector at all — it diffs the mark landing into one `DismissWindow`. The two-native-focus-producer shape (`win.on('focus')` and `rendererWC.on('focus')`, one physical focus yielding two attention seqs and two sweeps queued behind one FIFO pump) still occurs, but the second report now selects nothing new instead of re-dismissing the same window. |
| S4 transient-above-origin | scattered, origin half unimplemented | `stackingLevelForLayer`, `overlayFollowPatch`, `evolve RegisterWindow` | The overlay half is single-sited and holds. Nothing relates a transient to its origin for stacking; registration inserts a transient below the key window. |
| S5 key-raise-reorders | scattered | `planRaiseRealization`, `raiseWindow`, `kernelWindowShown` | Native half holds. `raiseWindow` ends both branches with `kernelWindowShown(id, true, opSeq)`, so a pure reorder still lands a companion focus and a fresh attention seq. |
| D1 one-escape-rule | scattered, partial | `window-escape.ts resolveEscapeTarget`, `ESC_CLOSE_ROLES`, `escapeClosePolicy` | One role set standing in for the "Escape closes this window" declaration, one policy, no per-kind arm. "Topmost visible Escape-closable" is implemented only in the no-key branch; with a content window key and an Escape-closable transient visible, Escape opens the fallback window. |
| D2 escape-hits-its-window | holds (fixed 2026-09-13) | `resolveEscapeTarget` rule 4 | On a landed/key disagreement the press is dropped (`stale`), whatever the current key holder's role. The redirect-to-holder branch the docblock used to state as intent is gone. |
| D3 escape-never-waits | holds | `electron-window-backend.ts askRendererHandledEscape` | Page hosts answer synchronously; browser windows still have the 500ms ask but carry a responder. |
| D4 close-before-open | scattered | `resolveEscapeTarget` no-key branch, `escapeFallbackPolicy`, `interpretEscape` | The switcher opens from three places; only the no-key branch scans for a visible closable transient first. Same gap as D1. |
| D5 escape-order | holds | `interpretEscape` | The no-target branch now scans for a visible fullscreen window before falling back to `open-switcher`; with none it opens the switcher as before, with one it answers `nothing` (`fullscreen-no-target`) instead of exiting fullscreen on a window Escape was never pressed on. |
| D6 blur-dismissal | holds | `transientAutocloseExemption`, `selectTransientAutoclose`, `isTransientAutocloseCandidate` | The four exemptions map one-to-one onto the record's own facts (`overlayFor` set, `acceptsInput` false, the focuser's `parentId`/`overlayFor` naming the victim, `openSeq` above the ordering floor) and all three readers call the single function. |
| D8 resign-sweep-after-resign | holds | `evolve AppResigned`, `AppResignSettled`, `react` rule (b) | Victims only when `!state.appActive` at the settle. |
| D9 escape-closes-a-background-page | holds (rule corrected 2026-09-13) | `escapeClosePolicy`, `escapeFallbackPolicy` | The rule used to say an application window never closes on Escape; that was wrong, and the code was right: a page opened while another app was frontmost (`openedInBackground`) closes on Escape because the user is going back to that app, and any other application window falls through to the fallback window. `workspace` is spared in both sessions. |

## Tally

| Verdict | Count | Rules |
|---|---|---|
| holds | 18 | F1 F6 F7 F8 V1 V3 V4 V5 V6 S1 D2 D3 D5 D6 D8 D9, S3 (dismissal half) |
| scattered | 9 | F2 F4 F5 V2 S2 S4 S5 D1 D4 |
| contradicted | 3 | F3, S3 (raise half) |
| unimplemented | 0 | |

D7 was deleted from the rules on 2026-09-13: a transient that loses focus is dismissed by D6 with
no exemption for being new, and the one failure filed under it did not reproduce.

S3 now splits like V6: the dismissal half moved to holds (fixed 2026-09-05); `S3` in the
contradicted row above names only the raise half (one `WindowClosed` can still emit two raises).

Three structural facts recurred under most of the contradicted and scattered rows; the first is now
closed:

- **CLOSED (2026-09-13): a raise command used to write `key` and land attention by itself**
  (`decide RaiseWindow`), so the model could believe a window was key that the OS never focused,
  and every command-driven raise or its confirmation ran a dismissal sweep (F1, F3, F5, S5). `decide`
  now translates the command onto `FocusRaiseRequested` (`State.lastRaiseRequest`) instead of
  manufacturing an `OsFocusGained`; `key` moves only off the backend's own confirming report.
  `kernelWindowShown` is unaffected by this fix — it is a companion-focus feed for a native show
  event, not a raise command.
- **Focus cause is a per-window arming slot fed by seven producers, two of them for one page host** (`electron-window-backend.ts`), so one physical focus can arrive twice with two causes (F2, S3).
- **No state names the window a transient was opened over**, so origin stacking has nothing to consult (S4). Hide-return no longer shares this gap: `WindowRecord.priorKey` now names the prior key holder (F7), and is the natural origin for S4 to read too.

## Role sets are feature names standing in for declarations

The rules speak of declared attributes; the manager still answers several of those questions by
looking a window's `role` up in a set. Each set below is a feature vocabulary (`izui-roles.ts
inferIzuiRole` derives the role from open-time options and page context) standing in for one
per-window declaration the opener could make directly. A later commit can replace each role check
with the attribute check without changing a rule.

| Role set | Members | Declaration it stands for | Readers today |
|---|---|---|---|
| `window-kernel.ts TRANSIENT_ROLES` (duplicated in `izui-roles.ts`) | palette, quick-view, overlay, switcher | "dismiss me when key lands on another window" — `selfClosesOnBlur` already declares exactly this, and `isTransientAutocloseCandidate` already accepts either | `isTransientAutocloseCandidate`, `spacesPolicyForRole` / `desktopMembershipForRole` (the Spaces half is a second declaration, "follow the user across desktops", that `DesktopMembership` already carries per record) |
| `window-kernel.ts CONTENT_ROLES` | workspace, content, child-content | "the user works in me": a default key holder, a hide-successor candidate, never a dismissal victim | `isContentWindow`, `successorOnHide`, `isAppResignSweepEligible`, `topmost(state, isContentWindow)` |
| `window-escape.ts ESC_CLOSE_ROLES` | quick-view, palette, utility | "Escape closes me" — a per-window declaration the opener should make; `escapeMode` is already the same shape for the pass-through half | `resolveEscapeTarget`, `escapeClosePolicy` |
| `window-escape.ts ESC_FALLBACK_ROLES` | workspace, content, child-content | "Escape with nothing to close opens the fallback window from me" — the same three roles as `CONTENT_ROLES`, so a content-window attribute covers it | `escapeFallbackPolicy` |
| `window-escape.ts SWITCHER_ROLES` | switcher | "I am the window Escape opens when it has nothing to close" — a singleton the opener declares, the same shape as `tracksBaseLayerTop` | `switcherWindow`, `interpretEscape` step 1 |
| `izui-roles.ts classifyWindowRegistration` → `windowClass` | overlay, palette, quick-view, hud, primary | a second derivative of `role` (itself derived from `modal`/`keepLive`/`overlay`). `WindowRecord.class` documents itself as a lookup shorthand nothing branches on — and, as of 2026-09-05, `showWindow` no longer branches on it either: the "never activates the app" declaration is `type: 'panel'` at open (`izui-roles.ts windowNonActivating`), now stored as `WindowRecord.nonActivating` and read directly | `deriveStackingLevel` |
| `izui-roles.ts inferIzuiRole` | maps `overlay` / `modal` / `keepLive` / page-ness / parent to a role | the inverse of the table: the open-time options ARE the declarations (`modal` → `selfClosesOnBlur`, `overlay` → `overlayFor`, `keepLive` → `keepLive`), and the role is derived from them; `utility`, `switcher` and `workspace` are the roles no option produces, so each needs an explicit attribute of its own | `ipc.ts` window-open handler |

`role` itself stays as a log shorthand once every reader above consults an attribute instead; the
kernel already treats `class` that way.

## Two rule-text corrections made by this audit

- **F2** originally said a machine-caused focus "never counts as the user looking away". The kernel's deliberate, measured design (`window-manager.md` → "What was tried and rejected": deleting the ordering floor returns two live palette failures) is that a machine-caused focus dismisses only transients opened before the op that caused it. The rule now says that.
- **D6** originally scoped dismissal to world-caused focus only. It now includes the ordering-floor clause for machine-caused focus, matching F2.
