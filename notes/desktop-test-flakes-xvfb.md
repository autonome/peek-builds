# Desktop Test Suite — Xvfb Timing Flakes

Status as of 2026-05-11. Captures the 5 desktop test failures observed after
rebasing onto `a4895639` (window-placement refactor) and the investigation
that ruled out a clean fix.

## The Five Failing Tests

Observed in a single full-suite run after the rebase:

| # | File | Test | Symptom |
|---|------|------|---------|
| 138 | `page-layout.spec.ts:142` | `navbar show/hide does not change window height` | `waitForFunction` timeout on `.visible` class change (5s) |
| 159 | `page-navbar.spec.ts:148` | `Cmd+L navbar auto-hides on mouseleave like hover` | Same `.visible` class timeout |
| 180 | `peeks.spec.ts:86` | `peek opens centered on the cursor display` | `peek open failed: ERR_FAILED (-2) loading 'about:blank'` in ~32ms |
| 255 | `transient-on-blur.spec.ts:198` | `palette closes when another palette opens` | `isVisible(b)` returns false / `fireWindowFocus returned false` |
| 259 | `transient-on-blur.spec.ts:234` | `overlay is exempt from auto-close when a palette focuses` | Same |

`desktop-serial` project — 37/37 pass, no issues.

## They Are Flaky, Not Deterministic

The same suite re-run (full project, `--repeat-each=2`) showed the second
iteration of every originally-failing test **passing**. Across 572 test runs:
4 failed (overlapping but not identical with the first sample), 542 passed.
Identifying these as deterministic regressions from the rebase is wrong —
the rebase shifted window-placement enough to change the flake distribution,
but the underlying timing dependence was already there.

## Diagnosed Mechanism

The bug exists in the autoclose loop at `backend/electron/ipc.ts:2166` (added
in commit `091e2a43 fix(izui): restore window-level transient-on-blur auto-
hide regressed by panel-type focus events`):

```ts
const focusedRole = winInfo?.params?.role as string | undefined;
if (focusedRole !== 'utility') {
  for (const other of BrowserWindow.getAllWindows()) {
    if (other.id === win.id) continue;
    if (!other.isVisible()) continue;
    // ...close transient siblings
  }
}
```

The self-skip (`other.id === win.id`) prevents *direct* self-close. The
**cascade** is what fails:

1. New transient X opens, fires `focus`.
2. Autoclose loop closes transient sibling Y.
3. Closing Y causes WM focus to shift somewhere (bgWindow, anchor, or the
   *other* transient that's still around).
4. That new focus fires the same handler, with `focusedRole` ∈ `{undefined,
   'workspace', 'palette'}` — none of which equal `'utility'`. Loop runs again.
5. The fresh transient X is now a "transient sibling" to whoever is focused,
   and gets closed.

By the time the test calls `fireFocus(target)`, `BrowserWindow.fromId(target)`
returns null → `fireWindowFocus returned false`.

For the peek test (#180), the cascade fires *during* `loadURL('about:blank')`,
so the window is destroyed mid-navigation and Chromium reports `ERR_FAILED -2`.

For the navbar tests (#138, #159), the canvas page's main window is
indirectly disturbed by display-watcher synchronous projection or by some
other side-effect — less certain, low evidence.

## Why It's Linux/Xvfb-Specific

`showInactive()` on macOS does not fire a focus event for type:'panel'
windows under HEADLESS Electron. The test fixture
(`backend/electron/entry.ts::__peek_test.showWindow`) relies on this contract
explicitly. Under Linux/Xvfb a "visible" window can receive natural WM focus
during or shortly after `showInactive()`, which is the trigger for the
cascade described above. The `7ceb91da test(linux): unbreak desktop suite
under Xvfb (265→271 pass)` commit improved coverage but didn't fully tame
this — it just got the right race outcome more often.

## Fix Attempts Tried — None Were Net Wins

### Attempt 1: skip autoclose when focuser is transient

```ts
if (focusedRole !== 'utility' && !TRANSIENT_ROLES.has(focusedRole)) {
```

Regressed the passing tests (`palette → quick-view`, `qv → qv`): a new
transient gaining focus is the *intended* trigger for closing old transients.
Don't do this.

### Attempt 2: skip autoclose when focuser is hidden or non-focusable

```ts
if (focusedRole !== 'utility' && win.isVisible() && win.isFocusable()) {
```

Tried and reverted. Fixed `#159` and `#259` deterministically. Did not fix
`#138`, `#180`, `#255`. Exposed new failure `#146` (`Page Layout Maximize
@desktop › panels clamped to screen edges when maximized`) likely via state
leak from a different test that the changed cascade no longer cleaned up.

The narrowed guard helps when the cascade target is `bgWindow` (hidden) or
the workspace anchor (`focusable: false`). It does not help when the cascade
shifts focus between two visible+focusable transient windows themselves —
which is what happens in `qv → qv` and remains the residual flake.

### Approaches not tried

- **`__shownAt` timestamp + cascade-suppression window**: stamp on every show
  path (or via `win.on('show')`), skip autoclose targets whose age is
  < ~10ms. Threshold has to be small enough not to interfere with explicit
  `fireFocus` after window creation (~20ms inter-call latency in these
  tests) but large enough to cover the synchronous WM focus delivery.
  Fragile.
- **Re-entrancy guard**: module-level `autocloseRunning` flag set inside the
  loop. Won't work because the cascade focus events fire on the next event
  loop tick, not synchronously.
- **Test fixture fix**: in `__peek_test.showWindow`, after `showInactive()`,
  call `win.blur()` or post a no-op event to drain WM focus state. Test-only
  change, doesn't touch product code, may not even be possible to do
  reliably under Xvfb.
- **Drop the focus-event-driven autoclose entirely**: revert `091e2a43` and
  put the autoclose back on the renderer side (cmd-panel subscribes to
  `window:focused` and hides itself). The original 091e2a43 motivation was
  panel-type NSPanels on macOS not firing reliable blur — but that's a
  macOS-specific problem, and the current Linux behavior is the cost of the
  generalization.

## Recommendation

Leave as-is. These are flaky-on-Xvfb known issues, not regressions from the
window-placement refactor. A real fix is a focused effort, not a one-line
change. If pursuing it, the most promising approach is the `__shownAt`
timestamp combined with the Attempt 2 hidden/non-focusable guard, plus a
fixture-level forced blur after `showInactive` to remove the Xvfb-specific
trigger.

## Reproducing

```
yarn test:electron:bg                      # full chain (desktop + serial)
tail -F /tmp/test-electron.log

# or isolated:
HEADLESS=1 BACKEND=electron ./scripts/playwright-with-display.sh \
  test tests/desktop/transient-on-blur.spec.ts --workers=1 --repeat-each=5
```

Expect 0–3 failures out of the same 5 tests across repeated runs. No
specific test fails every time.
