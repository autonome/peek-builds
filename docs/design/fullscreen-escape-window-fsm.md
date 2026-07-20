# One deterministic owner for window front / focus / Escape / fullscreen

Design blueprint. Status: **approved direction, not yet implemented.** Supersedes the
earlier revision of this file, which documented a staged seam (the machine decides,
`izui-state.ts` executes the switcher overlay lifecycle). That seam is **rejected** — the
bug this design exists to close lives precisely in it.

Directive: ONE deterministic system. Named states, one transition owner, illegal states
unrepresentable, no event-listener backdoors.

---

## 1. The actual defect: `front` is remembered, never asserted

The reducer in `window-state.ts` holds `front` — the window the user is working in. It is
a **belief**. Nothing in the system continuously drives the OS to match it, and nothing
detects when the OS has drifted away from it.

That is survivable for a `BrowserWindow`, because a `BrowserWindow`'s root `webContents`
IS its first responder whenever the window is key. Keyboard focus is not a separate piece
of state; getting the window key gets you the keyboard.

It is **not** survivable for a hybrid page host. A page host is a `BaseWindow` with a
`WebContentsView` child and no root `webContents`. Its keyboard focus is a *second,
independently-losable* piece of state: which child view is the macOS first responder. A
page host can be key, visible, and frontmost while its content view is not first
responder — in which case its `before-input-event` handler in `ipc.ts
wireHybridContentEvents` is **deaf**, and Escape reaches nothing at all.

Every bug in this family is that same wound:

| peek item | Surface symptom |
|---|---|
| `ebb10894` | Escape opened the switcher instead of closing a focused slide |
| `7c61e917` | Focused page host where Escape (and every key) is dead until you click the page |
| `9d50ea29` | Cmd+W closed only the chrome overlay, leaving the page visible |
| `ca4ee5e6` | Cmd+W no-op'd entirely with a hybrid host frontmost |
| `7fffa286` (this one) | Third Escape does nothing, ever again, for that page host |

The pre-cutover code carried two ad-hoc safety nets for this, and the cutover deleted both:

1. **Unconditional first-responder restore.** `ipc.ts onHybridHostFocus` used to call
   `contentWC.focus()` on every host focus (the `7c61e917` fix). It was replaced by a
   `FOCUS_CONTENT` effect emitted only from `window-state.ts frontChangeEffects`, which
   returns `[]` when `state.front === prevFront`. A host that re-gains OS focus without
   moving `front` now gets no restore.
2. **The global Escape grab.** `main.ts updateEscGlobalRegistration` computed its predicate
   from LIVE OS reads at five sites. It was replaced by `window-os-adapter.ts
   deriveEscGrabRegistered` = `appActive && front === null && !switcher.open` — a
   remembered belief. Since `OS_FOCUS_SETTLED_NULL` deliberately never clears `front`, a
   wrong `front` suppresses the safety net permanently.

Both deletions were *correct in direction* — they removed rival authorities. The mistake
was deleting the nets without giving the machine the one capability that made them
unnecessary: **the machine must assert `front` onto the OS, not merely remember it.**

---

## 2. The model: intent plus assertion

Two fields, with distinct meanings that must never be conflated.

- **`front: number | null`** — the *intent*. The window the user is working in. Unchanged
  from today.
- **`frontAsserted: boolean`** — the *claim that the OS currently matches that intent*: the
  window is raised, and if it is a page host, its content view is first responder.

The reducer gains one closing step, applied after every transition, alongside the existing
`enforceFrontInvariant`:

```
if (appActive && front != null && !frontAsserted) {
    emit RAISE_WINDOW(front)
    emit FOCUS_CONTENT(front)   // page-host only
    frontAsserted = true
}
```

And a set of events that **invalidate** the assertion, because each is a moment where the
OS can plausibly have taken first responder away:

| Event | Why it invalidates |
|---|---|
| `APP_RESIGNED` | The user left Peek; on return, first responder is not guaranteed |
| `WINDOW_HIDDEN` where `id === front` | The asserted window is gone from screen |
| `SWITCHER_OPENED` | The overlay took key from the front window |
| `OS_FOCUS_GAINED` on a satellite | A palette / modal / chrome overlay took key |
| `front` changes to a different id | Trivially, the old assertion is about a different window |

`frontChangeEffects` and its `front === prevFront` early-out are **deleted**. That early-out
is the literal bug: it conflates "the target didn't change" with "the OS still matches the
target", which is exactly the conflation `7c61e917` proved fatal.

### What this derives for free

Each of these was previously going to be a hand-added special case. Under the assertion
model they all fall out of the single closing step:

- **Switcher dismiss re-raises the restore target.** `applyEscape` case `'close-switcher'`
  needs no `RAISE_WINDOW` of its own; `SWITCHER_OPENED` cleared the assertion, so closing
  re-asserts. This also removes the asymmetry with `SWITCHER_SELECTED`, which today is the
  only path that emits `RAISE_WINDOW`.
- **Return-from-app-switch restores first responder.** `APP_RESIGNED` cleared it;
  `APP_ACTIVATED` re-asserts. This is the "app resigned, came back, Escape still dead" case.
- **A satellite stealing key is self-healing.** When it goes away, the next transition
  re-asserts the real front.

### The Escape grab becomes honest

```
deriveEscGrabRegistered = appActive && (front === null || !frontAsserted)
```

The safety net returns, but expressed as **reducer state** rather than a live OS read. It
is on exactly when the machine cannot vouch that some window is positioned to receive
Escape — which is the true precondition, and the one the old live-read version was
approximating. Widening it back into live OS reads is explicitly **rejected**: that
reintroduces the rival-authority pattern this design exists to delete, and papers over a
wrong `front` instead of surfacing it.

---

## 3. One decider is not enough — the two rules

An assertion model is only sound if the assertion cannot be silently falsified. If any code
outside the machine moves OS focus, `frontAsserted` becomes a lie the moment it is set, and
we have rebuilt the exact failure mode of `deriveEscGrabRegistered`.

So the design is two rules, and the second is the load-bearing one:

> **Rule 1 — one decider.** All decisions about front, focus, Escape routing, and
> fullscreen come from `reduce()` in `window-state.ts`, which emits effects. Largely built.
>
> **Rule 2 — one executor.** No code outside `WindowOsAdapter.runEffect` may call
> `focus()`, `show()`, `moveTop()`, `showHybridHost()`, or `contentWC.focus()`. Code that
> wants focus to move **dispatches an event** and lets the reducer decide.

Rule 2 is enforceable by grep, which is the property worth having — it does not depend on
anyone remembering this document.

The z-order-only calls (`moveTop` used purely for stacking, never for key) are the one
carve-out, and they must be named as such at the call site.

---

## 4. Inventory: every OS focus assertion, and its disposition

Surveyed across `apps/desktop/main/`. Roughly thirty sites; four dispositions.

### 4.1 Route through the reducer (delete the direct call)

| Site | Today | Becomes |
|---|---|---|
| `main.ts` `browser-window-created` → `window.on('closed')` — `parentWin.focus()` | Focus parent after a child closes | `WINDOW_CLOSED` already runs `successorFront`; delete. Parent-preference, if wanted, belongs in `successorFront` |
| same listener — overlay explicit-selection restore (`targetWin.focus()` / `hybrid.baseWin.focus()`) | Focus switcher-selected window after teardown | Dispatch `SWITCHER_SELECTED`, which finally becomes reachable |
| same listener — fallback overlay branch (`overlayFocusTarget` / `getPreOverlayFocusTarget`) | Focus restore on dismiss | `switcher.previousFront` already holds this; delete |
| `ipc.ts` window-open — hybrid keepLive reuse (`show()`+`focus()`+`contentWC.focus()`) | Raise an existing host on key reuse | Dispatch a raise-intent event |
| `ipc.ts` window-open — hybrid URL-dedup reuse | same | same |
| `ipc.ts` window-open — BrowserWindow keepLive reuse | same | same |
| `ipc.ts` window-open — BrowserWindow URL-dedup reuse | same | same |
| `session.ts reassertColdStartFocusOnce` | One-shot cold-start re-raise | Set `front` at restore; the assertion step does the raise |
| `session.ts restoreSessionSnapshot` focus block | Activate the saved focused descriptor | same |
| `tile-ipc.ts` `tile:window:focus` / `:show` / `:show-self` | Renderer asks to focus/show | Dispatch; reducer decides |
| `chrome-extensions.ts openChromeExtensionPage` | Reuse-raise an extension window | Dispatch a raise-intent event |
| `windows.ts` + `ipc.ts` `devtools-opened` handlers | Restore first responder after devtools steals it | Invalidate the assertion; the closing step re-asserts |
| `hybrid-overlay.ts wireShowNavbarFocus` | Overlay takes key for Cmd+L | Dispatch; this is a satellite deliberately taking key, and the reducer must know so it clears `frontAsserted` |

### 4.2 Primitives — keep, but make adapter-private

`windows.ts showHybridHost`, `windows.ts showWindowHeadlessSafe`. These are *how* the
adapter asserts. They remain, but the only permitted caller is `runEffect`.

### 4.3 Not focus assertions — leave alone

`session.ts reassertStackingOrder` / `moveTopById`, `hybrid-overlay.ts frameBounds`
(`showInactive`/`moveTop` to keep chrome above content), `main.ts did-become-active`
`__hudHidden` `showInactive`, `session-partition.ts` `Notification.show`.

### 4.4 Genuine OS-boundary workaround — keep, comment which boundary

`ipc.ts` modal `blur` handler, the `__lastShowTime < 200ms` re-focus branch. This suppresses
the macOS NSPanel spurious-blur dance. It is a real Chromium/AppKit boundary quirk, it is at
the lowest layer, and nothing is stacked on top of it. It must carry a comment naming the
boundary, per the standing rule.

---

## 5. What `izui-state.ts` becomes

The survey found `izui-state.ts` is **not a rival executor** — it is a rival *memory*. Only
`exitOverlay` and `exitOverlayForAppBlur` touch the OS at all (`showInactive()` over
`hiddenWindowIds`), and both are inert today because the no-hide overlay model always passes
an empty list. Everything else records or computes.

That makes it far cheaper to collapse than previously assumed. It keeps exactly one job:

- **Session tri-state** (`idle`/`transient`/`active`) and its one-way mirror into the reducer
  via `onSessionChange` → `SESSION_CHANGED`. The reducer never derives session itself.

Everything overlay-shaped moves to the machine and is deleted here: `enterOverlay`,
`exitOverlay`, `exitOverlayForAppBlur`, `setOverlayFocusTarget`, `getPreOverlayFocusTarget`,
`isOverlay`, both cooldown predicates, and the `setFocusedWindow`/`clearFocusedWindow`
bookkeeping that shadows the reducer's `front`.

The two macOS focus-dance cooldowns (`isWithinOverlayExitCooldown`,
`isWithinOverlayEntryCooldown`) deserve a note: they are time-based guards, i.e. exactly the
shape this codebase's standing rule tells us not to add. They exist because overlay
teardown raced app-blur. Under one executor that race is structural rather than temporal —
`SWITCHER_OPENED`/`APP_RESIGNED` ordering is explicit in the reducer — so they should be
**deleted, not ported**. If a repro shows they were load-bearing, the replacement is a
reducer state, never a timer.

---

## 6. Implementation sequence

Ordered so the highest-regression-risk area lands last, behind the gate.

1. **Reducer model.** Add `frontAsserted`, the invalidation set, the closing assertion step.
   Delete `frontChangeEffects` and its early-out. Rewrite `deriveEscGrabRegistered`. Pure,
   fully unit-testable in `window-state.test.ts` — no Electron, no live app.
2. **`main.ts` closed-listener demolition.** Delete the parent-focus and both overlay-restore
   branches; dispatch `SWITCHER_SELECTED` from the real selection path so it stops being
   dead code.
3. **`ipc.ts` reuse-raise + `tile-ipc.ts` + `chrome-extensions.ts`.** Convert direct raises to
   dispatched intents.
4. **`izui-state.ts` reduction** to session tri-state only; delete the overlay surface and
   the cooldowns.
5. **`session.ts` restore.** Last. This area owns the worst regression history in the app
   (`4f1a974a`, the cold-start focus dance) and it is the one place doing bulk z-order plus
   focus as a single sweep.
6. **Enforcement.** A grep-based check that the forbidden calls appear nowhere outside
   `runEffect` and the named carve-outs.

Live verification is required at steps 2 and 5 — the macOS first-responder interaction is
**unobservable in headless**, and a green headless suite has given false confidence on this
exact bug twice already. Instrument, have the operator perform only the reproduction
gesture, read the log.

---

## 7. Decisions locked — do not re-litigate

- **Satellite rule** is owned solely by `window-state.ts isSatelliteRegistration`: role
  `overlay`/`palette`, OR modal, OR `focusable === false`. Peeks/slides (`role:'quick-view'`)
  stay front-eligible.
- **Every window registers** with the machine; some registrations no-op.
- **Accepted behavior change:** the switcher's "first Escape clears search, second closes"
  became "first Escape closes". Do not restore.
- **Peeks/slides never native-fullscreen** — enforced at the OS boundary, not by a reducer
  gate.
- **Duplicate registration re-pumps `WINDOW_REGISTERED` on purpose** — it is an idempotent
  merge, and the later spec is the richer one.
- **Rejected: widening `deriveEscGrabRegistered` to read live OS state.** See §2.
- **Rejected: the staged switcher seam.** See the header.
