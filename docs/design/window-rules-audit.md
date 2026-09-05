# Window rules audit

The kernel at `dc3febab` read against `window-rules.md`, one line per rule. Verdicts: **holds**
(one site, agrees), **scattered** (3+ sites must agree for the rule to hold; they do today unless
noted), **contradicted** (a site does the opposite), **unimplemented** (nothing expresses it).
Gestures G1–G13 are composites of the rules below and are not audited separately.

| Rule | Verdict | Sites | Finding |
|---|---|---|---|
| F1 one-key | contradicted | `window-kernel.ts evolve OsFocusGained`, `decide RaiseWindow` | Two writer arms, so "at most one" holds. But `decide`'s raise arm manufactures an `OsFocusGained` and writes `key` synchronously with no gate, so with Peek inactive the model believes the palette is key while the OS has it dead. |
| F2 machine-labelled | scattered | `electron-window-backend.ts armSelfCausedFocus`, `takeFocusCause`, `raiseWindow`, `performOsShow`, `focusContent`, `win.on('focus'/'blur')` | Every native call that moves focus arms a token, seven sites. Provenance is right only while all seven agree. |
| F3 confirmation-drives-nothing | contradicted | `window-kernel.ts evolve OsFocusGained`, `react` sweep (a) | The raise half holds via `isOpConfirmation`. The dismissal half does not: the arm writes a fresh `lastAttention.seq` unconditionally, so a raise's own confirmation still runs the autoclose sweep. |
| F4 raise-means-key | scattered | `window-kernel-executor.ts planRaise`, `planRaiseRealization`, `electron-window-backend.ts raiseWindow` | `planRaiseRealization` is exact. The `suppressed` mask above it now applies to machine raises only (`Effect.RaiseWindow.intent` exempts a user-intended one); `show-and-focus-content` still produces a visible window that accepts no input. `raiseWindow` activates the app on a user-intended raise (darwin, `take-key` and `show-and-take-key`); no other site does. |
| F5 raise-needs-a-surface | scattered | `window-kernel.ts admitsFocusAssert` and its ~8 callers, `decide RaiseWindow`, `planRaise` | One predicate, consulted independently at ~8 sites; two paths bypass it (`decide`'s raise arm, `planRaise`). |
| F6 intent-beats-inactive | contradicted (since 2026-09-05, rule rewritten) | `renderer/cmd/background.js openPanelWindow` (`activation: 'user'`), `ipc.ts` keyed reuse -> `windows.ts showWindowHeadlessSafe` -> `window-kernel-dispatch.ts kernelShowRequested` (`intent: 'user'` on the `RaiseWindow` command), `window-kernel.ts decide` / `FocusCause.intent` / `react` (onto the effect), `window-kernel-executor.ts planRaise` (`!appActive && intent !== 'user'`), `electron-window-backend.ts raiseWindow` (app activation) | One channel, one word: a raise the user asked for carries `intent: 'user'` end to end and is exempt from the app-inactive mask; every `react`-derived raise carries nothing and stays masked. The kernel never learns which gesture it was. But the rule now says a panel takes key WITHOUT activating the app, and `raiseWindow` does the opposite: `app.focus({ steal: true })` on darwin for every user-intended, non-reorder raise. The panel declaration (`type: 'panel'` at open) is never stored on the record; `showWindow` keys "never activates" to `windowClass === 'quick-view'` instead, so peeks and slides get the panel behavior by feature class and the command window does not. Fix: store the declaration on the record, read it in `showWindow` and `raiseWindow`, delete the class check and the steal. |
| F7 hide-returns-key | holds | `window-kernel.ts successorOnHide`, consulted by `react`'s successor loop and `evolve WindowHidden` | `WindowRecord.priorKey` records who held key immediately before the hiding window took it, written by `OsFocusGained` and cleared by `WindowClosed`. `successorOnHide` reads it: a live, admitting prior key holder gets key back; a missing/hidden/doomed one falls back to the topmost content window; `null` (nothing in Peek was key before) raises nothing, rather than the topmost content window unconditionally. |
| F8 land-somewhere | unimplemented | `react` successor loop, `holdsAppOnScreen` | Only the successor loop restores key, and only when the dismissed window was key and a content window survives. Dismissing a key palette with no content window up leaves `key` dangling. |
| V1 paint-before-dismiss | holds | `window-kernel.ts isTransientAutocloseCandidate`, ordering floor in `selectTransientAutoclose` | `if (!rec.orderable) return false` gates every reader. |
| V2 show-is-explicit | scattered | `evolve WindowShown`, `window-kernel-executor.ts isStaleWindowEcho`, `electron-window-backend.ts win.on('show')` | The kernel arm is unconditional; both guards live outside it. A producer emitting `WindowShown` without an `opSeq` bypasses the executor guard. |
| V3 keeplive-hides | holds | `decide CloseOrHideWindow`, `runEffect DismissWindow` | One closure decides hide vs close for the target and every cascaded descendant. |
| V4 reversible-is-not-final | holds | `evolve AppResigned`, `AppResignSettled`, `AppActivated`, `appBlurRevealAdmits` | Resign hides exclude every dismissal victim; activation refuses `pendingHidden`. |
| V5 late-paint-still-obeys | holds | `react` rule (c) | The `orderable` flip re-asks the law against the standing attention. This is also the mechanism of the D7 defect. |
| V6 one-close-per-input | holds | `window-escape-runtime.ts handleEscapePress` pass B, `renderer/cmd/panel.js shutdown`, `isTransientAutocloseCandidate` | Escape path is exact. Blur sweeps no longer double up since `b7e685e6`, see S3. |
| S1 order-is-total | holds | `evolve RegisterWindow`, `WindowClosed`, `OsFocusGained` | The only `filter` that drops a member is in `WindowClosed`. |
| S2 fixed-point | scattered | `window-kernel-executor.ts pump`, `isStaleSelfEcho`, `isStaleWindowEcho`, `isOpConfirmation`, `planRaiseRealization` | `pump` is an unbounded FIFO with no depth limit; termination is the conjunction of four guards at four sites. |
| S3 one-raise-per-cause | contradicted (raise half), holds (dismissal half, fixed 2026-09-05) | `evolve WindowClosed`, `react` parent-refocus and focus-assert rules, `evolve OsFocusGained`/`AppResignSettled`/`WindowContentOrderable`, `selectTransientAutoclose`, `isTransientAutocloseCandidate` | The raise half is unchanged: one `WindowClosed` can emit two raises sharing one token. The dismissal half (select a window for dismissal at most once until its hide is confirmed) now holds: the three `react` rules that used to re-query `selectTransientAutoclose` off `next` were collapsed into `evolve` marking its own chosen victims `pendingHidden` in the SAME transition that selects them, and `isTransientAutocloseCandidate` now excludes a marked record from the law's own consideration set, so a later sweep cannot choose it again before `WindowHidden`/`WindowShown` clears the mark. `react` no longer calls the selector at all — it diffs the mark landing into one `DismissWindow`. The two-native-focus-producer shape (`win.on('focus')` and `rendererWC.on('focus')`, one physical focus yielding two attention seqs and two sweeps queued behind one FIFO pump) still occurs, but the second report now selects nothing new instead of re-dismissing the same window. |
| S4 transient-above-origin | scattered, origin half unimplemented | `stackingLevelForLayer`, `overlayFollowPatch`, `evolve RegisterWindow` | The overlay half is single-sited and holds. Nothing relates a transient to its origin for stacking; registration inserts a transient below the key window. |
| S5 key-raise-reorders | scattered | `planRaiseRealization`, `raiseWindow`, `kernelWindowShown` | Native half holds. `raiseWindow` ends both branches with `kernelWindowShown(id, true, opSeq)`, so a pure reorder still lands a companion focus and a fresh attention seq. |
| D1 one-escape-rule | scattered, partial | `window-escape.ts resolveEscapeTarget`, `ESC_CLOSE_ROLES`, `escapeClosePolicy` | One role set standing in for the "Escape closes this window" declaration, one policy, no per-kind arm. "Topmost visible Escape-closable" is implemented only in the no-key branch; with a content window key and an Escape-closable transient visible, Escape opens the fallback window. |
| D2 escape-hits-its-window | contradicted | `resolveEscapeTarget` rule 4 | On a landed/key disagreement the press is redirected to the current key holder when its role is closable. The docblock states this as intent. |
| D3 escape-never-waits | holds | `electron-window-backend.ts askRendererHandledEscape` | Page hosts answer synchronously; browser windows still have the 500ms ask but carry a responder. |
| D4 close-before-open | scattered | `resolveEscapeTarget` no-key branch, `escapeFallbackPolicy`, `interpretEscape` | The switcher opens from three places; only the no-key branch scans for a visible closable transient first. Same gap as D1. |
| D5 escape-order | contradicted, one inversion | `interpretEscape` | `target none → open-switcher` sits ahead of the fullscreen check, so with no key holder and no closable transient the switcher can open over a fullscreen window. |
| D6 blur-dismissal | holds | `transientAutocloseExemption`, `selectTransientAutoclose`, `isTransientAutocloseCandidate` | The four exemptions map one-to-one onto the record's own facts (`overlayFor` set, `acceptsInput` false, the focuser's `parentId`/`overlayFor` naming the victim, `openSeq` above the ordering floor) and all three readers call the single function. |
| D7 no-self-dismissal | unimplemented | `transientAutocloseExemption` `focuser-relation`, `react` rule (c), `takeFocusCause` | Nothing expresses "the window I just took key from". `focuser-relation` is one-hop and points the other way (peek's `parentId` names the host). The host's reclaim is unarmed, reads `world`, disarms the floor, and rule (c) dismisses the peek on paint. |
| D8 resign-sweep-after-resign | holds | `evolve AppResigned`, `AppResignSettled`, `react` rule (b) | Victims only when `!state.appActive` at the settle. |
| D9 content-ignores-escape | contradicted | `escapeClosePolicy` | Only `workspace` is spared unconditionally; a `content` or `child-content` window closes on Escape in an incidental session via the `openedInBackground` arm. The rule now says "incidental session or not" so the arm is the contradiction, not a loophole. |

## Tally

| Verdict | Count | Rules |
|---|---|---|
| holds | 12 | F7 V1 V3 V4 V5 V6 S1 D3 D6 D8, S3 (dismissal half) |
| scattered | 9 | F2 F4 F5 V2 S2 S4 S5 D1 D4 |
| contradicted | 8 | F1 F3 F6 D2 D5 D9, S3 (raise half) |
| unimplemented | 2 | F8 D7 |

S3 now splits like V6: the dismissal half moved to holds (fixed 2026-09-05); `S3` in the
contradicted row above names only the raise half (one `WindowClosed` can still emit two raises).

Three structural facts recur under most of the contradicted and scattered rows:

- **A raise command writes `key` and lands attention by itself** (`decide RaiseWindow`, `kernelWindowShown`), so the model can believe a window is key that the OS never focused, and every raise or confirmation runs a dismissal sweep (F1, F3, F5, S5).
- **Focus cause is a per-window arming slot fed by seven producers, two of them for one page host** (`electron-window-backend.ts`), so one physical focus can arrive twice with two causes (F2, S3, D7).
- **No state names the window a transient was opened over**, so self-dismissal and origin stacking have nothing to consult (F8, D7, S4). Hide-return no longer shares this gap: `WindowRecord.priorKey` now names the prior key holder (F7), and is the natural origin for D7 and S4 to read too.

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
| `izui-roles.ts classifyWindowRegistration` → `windowClass` | overlay, palette, quick-view, hud, primary | a second derivative of `role` (itself derived from `modal`/`keepLive`/`overlay`). `WindowRecord.class` documents itself as a lookup shorthand nothing branches on, yet `electron-window-backend.ts showWindow` branches on `windowClass !== 'quick-view'` to decide "never activates the app" — the declaration that is really `type: 'panel'` at open, which no record field carries | `showWindow` (the quick-view mask), `deriveStackingLevel` |
| `izui-roles.ts inferIzuiRole` | maps `overlay` / `modal` / `keepLive` / page-ness / parent to a role | the inverse of the table: the open-time options ARE the declarations (`modal` → `selfClosesOnBlur`, `overlay` → `overlayFor`, `keepLive` → `keepLive`), and the role is derived from them; `utility`, `switcher` and `workspace` are the roles no option produces, so each needs an explicit attribute of its own | `ipc.ts` window-open handler |

`role` itself stays as a log shorthand once every reader above consults an attribute instead; the
kernel already treats `class` that way.

## Two rule-text corrections made by this audit

- **F2** originally said a machine-caused focus "never counts as the user looking away". The kernel's deliberate, measured design (`window-manager.md` → "What was tried and rejected": deleting the ordering floor returns two live palette failures) is that a machine-caused focus dismisses only transients opened before the op that caused it. The rule now says that.
- **D6** originally scoped dismissal to world-caused focus only. It now includes the ordering-floor clause for machine-caused focus, matching F2.
