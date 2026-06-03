# focus-probes

Manual, opt-in diagnostic instruments for the **macOS headless focus** issue —
the bug where a packaged test run leaves the user's foreground app
frontmost-but-not-key (input dead until a cmd-tab cycle). Tracked as peek task
`2b55f3af`.

These are Playwright specs that reuse the desktop app fixture, kept here
(outside `apps/desktop/tests/`) so **the desktop gate never runs them**. Each is
gated behind its own `PEEK_FOCUS_*` env var and skips unless set.

## Running

From the repo **root**. Build the desktop app first so the source launch has
`dist/` (or add `PACKAGED=1` to reuse `out/mac-arm64/Peek.app`):

```bash
yarn build   # once, if running source
```

| Probe | Env var | What it isolates |
|---|---|---|
| `focus-steal-repro.spec.ts` | `PEEK_FOCUS_STEAL_REPRO=1` | Loud A/B: alternates `prohibited` vs `regular` policy, maximizes + steals focus. **Run visible** (`HEADLESS=0 --headed`). |
| `focus-probe.spec.ts` | `PEEK_FOCUS_PROBE=1` | Single instance, steps through each in-app focus op (policy transitions, dock, `app.focus`, `showInactive`) with labeled pauses. |
| `focus-launch-churn.spec.ts` | `PEEK_FOCUS_CHURN=1` | Pure process launch/teardown churn (8 cold launches, 4 workers), NO window ops. |
| `focus-probe-window.spec.ts` | `PEEK_FOCUS_WINPROBE=1` (+ `PEEK_WINPROBE_KIND=content\|peek`) | Repeated window-open via the app path: content (page-host canvas) vs peek (workspace). |
| `focus-probe-overlay.spec.ts` | `PEEK_FOCUS_OVERLAY=1` | Repeated open/close of the `alwaysOnTop` windows switcher overlay. |

Example (headless single-instance step probe):

```bash
PEEK_FOCUS_PROBE=1 PEEK_TEST_WORKERS=1 HEADLESS=1 BACKEND=electron \
  npx playwright test --config tools/focus-probes/playwright.config.ts \
  focus-probe.spec.ts --workers=1
```

Example (visible loud A/B repro — grabs your screen focus):

```bash
PEEK_FOCUS_STEAL_REPRO=1 HEADLESS=0 BACKEND=electron \
  npx playwright test --config tools/focus-probes/playwright.config.ts \
  focus-steal-repro.spec.ts --workers=1 --headed
```

You are the oracle: macOS active-app / key-window state is not observable from
Playwright (which is why `apps/desktop/tests/desktop/headless-no-focus-theft.spec.ts`
passes while the bug exists). Type in another app during the run and note
whether input blips.

## What these established (2026-06-03)

- **Stuck focus** (input dead until cmd-tab) = `app.setActivationPolicy('prohibited')`
  under `PEEK_HEADLESS` (the 2026-06-01 experiment, commit `c9e892fa`). Fixed by
  reverting to `'accessory'` (landed). A `'prohibited'` app can never own the
  macOS key window; `'accessory'` can be activated by clicking a window, so
  key-window handoff works.
- **Residual blip** (focus briefly drops, then returns): NOT reproducible in any
  single instance — launch/teardown churn, in-app policy/dock/`app.focus`,
  content (canvas) window-open, and the `alwaysOnTop` overlay open were ALL
  smooth solo. It only surfaced under 4-worker concurrency, i.e. a cross-instance
  OS focus race. Still open; if it needs killing, the lever is `LSUIElement` on
  the **test** build's `Info.plist` (never production) — see task `2b55f3af`.
