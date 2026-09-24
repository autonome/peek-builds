---
enabled: true
touches: [apps/desktop/main/hybrid-page-host-registry.ts, apps/desktop/main/hybrid-overlay.ts, apps/desktop/main/hybrid-page-host-registry.test.ts]
depends-on: []
---

# Make the hybrid window closed-listener a fan-out list, not a single slot

Peek item `04f7b7be`. Latent fragility, no live bug: `apps/desktop/main/hybrid-page-host-registry.ts`
keeps exactly one closed-listener in a module-scoped variable, so any second registrant would
silently replace the permission-deny wiring the seam exists for.

## What the code does now

`hybrid-page-host-registry.ts`, the "Hybrid window closed-listener seam" block:

- `let windowClosedListener: ((windowId: number) => void) | null = null;`
- `registerHybridWindowClosedListener(fn | null): void` assigns the slot; `null` clears it.
- private `notifyWindowClosed(windowId)` calls the one listener inside a `try {} catch {}`.

`notifyWindowClosed` is called from two places and both must keep firing: the `cleanup` closure
in `registerHybridWindow` (baseWin `'closed'` / contentWC `'destroyed'`, guarded so a
re-registered id doesn't double-fire) and `unregisterHybridWindow` (the explicit close-finalize
path). `_resetForTests` clears `entries` and `perHostPainted` only.

The single registrant is `apps/desktop/main/hybrid-overlay.ts` `initHybridOverlay`:
`registerHybridWindowClosedListener((windowId) => denyPendingRequestsForWindow(windowId));`.
Nothing passes `null`; `initHybridOverlay` has no teardown.

## What changes

`hybrid-page-host-registry.ts`:

- Replace the slot with `const windowClosedListeners = new Set<(windowId: number) => void>()`.
- `registerHybridWindowClosedListener(fn: (windowId: number) => void): () => void` adds `fn` and
  returns an unsubscribe that deletes it. The `null` parameter form goes away. Decisions:
  registering the same function twice is a no-op (Set semantics, fires once, one unsubscribe
  removes it); calling an unsubscribe twice is a no-op.
- `notifyWindowClosed` iterates a snapshot (`[...windowClosedListeners]`, so a listener that
  unsubscribes during fan-out doesn't disturb iteration) and wraps each call in its own
  `try/catch`, so a throwing listener never stops later ones and never breaks teardown. Keep the
  catch silent as today; no logging.
- `_resetForTests` also clears `windowClosedListeners`.
- Update the seam's block comment and the `registerHybridWindowClosedListener` JSDoc (drop the
  "Pass null to unregister" sentence; describe the returned unsubscribe; keep the "may fire more
  than once per windowId, consumers must be idempotent" note) and the `cleanup` comment in
  `registerHybridWindow` that says "the listener is idempotent anyway" (plural).

`hybrid-overlay.ts` `initHybridOverlay`: the call stays as is; discard the returned unsubscribe.
Do not add an overlay teardown. `permission-handler.ts`'s comments about the seam remain true;
leave that file untouched.

## Tests to change

`apps/desktop/main/hybrid-page-host-registry.test.ts`: add a `describe` block (e.g.
`'hybrid-page-host-registry: closed-listener fan-out'`) using the existing `mk()` helper and
`_resetForTests()` in `beforeEach`, with cases asserting:

1. A registered listener receives the windowId on `unregisterHybridWindow(id)` AND on
   `f.baseWin.emit('closed')` (two windows or two `it`s; either is fine).
2. Two registered listeners both receive the closed windowId.
3. Calling one listener's returned unsubscribe stops only that listener; the other still fires.
4. A listener registered first that throws does not prevent a listener registered after it from
   running.

Existing cases must be untouched; none of them registers a listener today.

## Verify

The repo gate covers this fully (the test file compiles into `dist/main/` and runs under the
electron runner):

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
```

Done when both tallies report `fail 0` and the four new cases pass. The live overlay wiring is
covered only by the Playwright case `'window close auto-denies'` in
`apps/desktop/tests/desktop/permission-prompt.spec.ts`; also run
`yarn workspace @peek/desktop test:grep "window close auto-denies"` and record its pass/fail
count under `**Result**` in the handoff.

## Working rules

`apps/desktop/CLAUDE.md` governs the desktop app. Read it before editing. Run one command per
Bash call.
