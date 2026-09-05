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
| F6 hotkey-is-intent | holds | `renderer/cmd/background.js openPanelWindow` (`activation: 'user'`), `ipc.ts` keyed reuse -> `windows.ts showWindowHeadlessSafe` -> `window-kernel-dispatch.ts kernelShowRequested` (`intent: 'user'` on the `RaiseWindow` command), `window-kernel.ts decide` / `FocusCause.intent` / `react` (onto the effect), `window-kernel-executor.ts planRaise` (`!appActive && intent !== 'user'`), `electron-window-backend.ts raiseWindow` (app activation) | One channel, one word: a raise the user asked for carries `intent: 'user'` end to end and is exempt from the app-inactive mask; every `react`-derived raise carries nothing and stays masked. The kernel never learns which gesture it was. Live gesture (Opt+Space from another app, packaged build) not yet re-checked by hand. |
| F7 hide-returns-key | contradicted | `window-kernel.ts react` successor loop, `evolve WindowHidden` | No record of the prior key holder exists; the raise goes to the topmost content window unconditionally. A null successor emits nothing rather than yielding to the other app. The non-key clause holds. |
| F8 land-somewhere | unimplemented | `react` successor loop, `holdsAppOnScreen` | Only the successor loop restores key, and only when the dismissed window was key and a content window survives. Dismissing a key palette with no content window up leaves `key` dangling. |
| V1 paint-before-dismiss | holds | `window-kernel.ts isTransientAutocloseCandidate`, ordering floor in `selectTransientAutoclose` | `if (!rec.orderable) return false` gates every reader. |
| V2 show-is-explicit | scattered | `evolve WindowShown`, `window-kernel-executor.ts isStaleWindowEcho`, `electron-window-backend.ts win.on('show')` | The kernel arm is unconditional; both guards live outside it. A producer emitting `WindowShown` without an `opSeq` bypasses the executor guard. |
| V3 keeplive-hides | holds | `decide CloseOrHideWindow`, `runEffect DismissWindow` | One closure decides hide vs close for the target and every cascaded descendant. |
| V4 reversible-is-not-final | holds | `evolve AppResigned`, `AppResignSettled`, `AppActivated`, `appBlurRevealAdmits` | Resign hides exclude every dismissal victim; activation refuses `pendingHidden`. |
| V5 late-ready-still-obeys | holds | `react` rule (c) | The `orderable` flip re-asks the law against the standing attention. This is also the mechanism of the D7 defect. |
| V6 one-close-per-gesture | holds (Escape), contradicted (sweeps) | `window-escape-runtime.ts handleEscapePress` pass B, `renderer/cmd/panel.js shutdown` | Escape path is exact. Blur sweeps double up, see S3. |
| S1 order-is-total | holds | `evolve RegisterWindow`, `WindowClosed`, `OsFocusGained` | The only `filter` that drops a member is in `WindowClosed`. |
| S2 fixed-point | scattered | `window-kernel-executor.ts pump`, `isStaleSelfEcho`, `isStaleWindowEcho`, `isOpConfirmation`, `planRaiseRealization` | `pump` is an unbounded FIFO with no depth limit; termination is the conjunction of four guards at four sites. |
| S3 one-raise-per-cause | contradicted | `evolve WindowClosed`, `react` parent-refocus and focus-assert rules, `selectTransientAutoclose` | One `WindowClosed` can emit two raises sharing one token. `selectTransientAutoclose` filters on `!visible` but never `pendingHidden`, so an already-dismissed window is selected again by the next sweep. A page host has two native focus producers (`win.on('focus')` and `rendererWC.on('focus')`), so one physical focus yields two attention seqs and two sweeps; `raiseWindow` arms between them, which is why the pair logs as `cause=world` then `cause=machine`. |
| S4 transient-above-origin | scattered, origin half unimplemented | `stackingLevelForLayer`, `overlayFollowPatch`, `evolve RegisterWindow` | The overlay half is single-sited and holds. Nothing relates a transient to its origin for stacking; registration inserts a transient below the key window. |
| S5 key-raise-reorders | scattered | `planRaiseRealization`, `raiseWindow`, `kernelWindowShown` | Native half holds. `raiseWindow` ends both branches with `kernelWindowShown(id, true, opSeq)`, so a pure reorder still lands a companion focus and a fresh attention seq. |
| D1 one-escape-rule | scattered, partial | `window-escape.ts resolveEscapeTarget`, `ESC_CLOSE_ROLES`, `escapeClosePolicy` | One role set, one policy, no per-kind arm. "Topmost visible closable" is implemented only in the no-key branch; with a content window key and a palette visible, Escape opens the switcher. |
| D2 escape-hits-its-window | contradicted | `resolveEscapeTarget` rule 4 | On a landed/key disagreement the press is redirected to the current key holder when its role is closable. The docblock states this as intent. |
| D3 escape-never-waits | holds | `electron-window-backend.ts askRendererHandledEscape` | Page hosts answer synchronously; browser windows still have the 500ms ask but carry a responder. |
| D4 close-before-open | scattered | `resolveEscapeTarget` no-key branch, `escapeFallbackPolicy`, `interpretEscape` | The switcher opens from three places; only the no-key branch scans for a visible closable transient first. Same gap as D1. |
| D5 escape-order | contradicted, one inversion | `interpretEscape` | `target none → open-switcher` sits ahead of the fullscreen check, so with no key holder and no closable transient the switcher can open over a fullscreen window. |
| D6 blur-dismissal | holds | `transientAutocloseExemption`, `selectTransientAutoclose`, `isTransientAutocloseCandidate` | The four exemptions map one-to-one and all three readers call the single function. |
| D7 no-self-dismissal | unimplemented | `transientAutocloseExemption` `focuser-relation`, `react` rule (c), `takeFocusCause` | Nothing expresses "the window I just took key from". `focuser-relation` is one-hop and points the other way (peek's `parentId` names the host). The host's reclaim is unarmed, reads `world`, disarms the floor, and rule (c) dismisses the peek on paint. |
| D8 resign-sweep-after-resign | holds | `evolve AppResigned`, `AppResignSettled`, `react` rule (b) | Victims only when `!state.appActive` at the settle. |
| D9 content-ignores-escape | contradicted | `escapeClosePolicy` | Only `workspace` is spared unconditionally; a `content` or `child-content` window opened in the background closes on Escape via the `openedInBackground` arm. |

## Tally

| Verdict | Count | Rules |
|---|---|---|
| holds | 10 | F6 V1 V3 V4 V5 S1 D3 D6 D8, V6 (Escape path) |
| scattered | 9 | F2 F4 F5 V2 S2 S4 S5 D1 D4 |
| contradicted | 8 | F1 F3 F7 S3 D2 D5 D9, V6 (sweeps) |
| unimplemented | 2 | F8 D7 |

Three structural facts recur under most of the contradicted and scattered rows:

- **A raise command writes `key` and lands attention by itself** (`decide RaiseWindow`, `kernelWindowShown`), so the model can believe a window is key that the OS never focused, and every raise or confirmation runs a dismissal sweep (F1, F3, F5, S5).
- **Focus cause is a per-window arming slot fed by seven producers, two of them for one page host** (`electron-window-backend.ts`), so one physical focus can arrive twice with two causes (F2, S3, D7).
- **No state names the prior key holder or the window a transient was opened over**, so hide-return, self-dismissal and origin stacking have nothing to consult (F7, F8, D7, S4).

## Two rule-text corrections made by this audit

- **F2** originally said a machine-caused focus "never counts as the user looking away". The kernel's deliberate, measured design (`window-manager.md` → "What was tried and rejected": deleting the ordering floor returns two live palette failures) is that a machine-caused focus dismisses only transients opened before the op that caused it. The rule now says that.
- **D6** originally scoped dismissal to world-caused focus only. It now includes the ordering-floor clause for machine-caused focus, matching F2.
