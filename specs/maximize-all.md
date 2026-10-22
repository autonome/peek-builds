---
enabled: true
touches: [apps/desktop/main/window-kernel.ts, apps/desktop/main/window-kernel.test.ts, apps/desktop/main/window-kernel-properties.test.ts, apps/desktop/main/window-kernel-executor.ts, apps/desktop/main/session-projection.ts, apps/desktop/main/session-projection.test.ts, apps/desktop/main/session.ts, apps/desktop/main/ipc.ts, apps/desktop/main/tile-ipc.ts, apps/desktop/main/tile-preload.cts, apps/desktop/features/windows/background.js, apps/desktop/features/windows/manifest.json, apps/desktop/tests/desktop/maximize-all.spec.ts, docs/design/window-rules.md, docs/tile-api.md]
depends-on: []
---

# Maximize-all mode: every window maximized, each restored exactly on leaving

Peek item `35c2d773`. A mode for the desktop app: entering it maximizes every eligible window on
the screen and desktop the user is on; leaving it returns each window the mode maximized to the
exact size and position it had before. First of two app-wide window-mode features; the second
(a transparent, maximized treatment for card-grid views, Peek `a6dfd7fb`, `d5db359b`,
`d424e67c`) and Peek-wide fullscreen (`bb73035e`) are not part of this slice.

Decisions:

- **Eligible windows**: ordinary page and tile windows that are visible, on the current screen
  and current desktop. Excluded: peeks, slides, the palette, the switcher and every other
  transient window; hidden keep-alive windows; app chrome (the page overlay, markers, border);
  modal, `role: 'overlay'`, `role: 'signal'` and non-focusable utility windows.
- **Scope** is the screen and desktop current when the mode is entered (`State` current desktop
  per screen, `isCurrentDesktop()`), fixed for the life of the mode.
- **Entering**: each eligible window that is not maximized is maximized through the kernel's own
  `Maximize`, which stashes `preMaxBounds`, and is marked as maximized by the mode. A window
  already maximized before entry is not marked and stays maximized on leaving.
- **While on**: an eligible window opened or shown in the mode's scope is maximized and marked.
- **User changes win**: a marked window that leaves maximize while the mode is on (a resize,
  a drag, the `unmaximize window` command — `MaximizeExitedByResize` or `Unmaximized`) loses its
  mark, and leaving the mode leaves it where the user put it. Re-maximizing it by hand does not
  re-mark it.
- **Leaving**: each window still marked and still maximized is unmaximized through the kernel's
  `Unmaximize`, returning it to `preMaxBounds`. Closed windows simply drop out.
- **Survives a restart.** Session save records that the mode is on, its scope, and each window's
  mark. Restore already brings maximized windows back maximized with their pre-maximize bounds
  (`docs/design/window-rules.md` G12, `session-projection.ts maximizeRestoreDescriptor()`);
  restore then re-establishes the mode and the marks, so leaving it after a relaunch restores
  every marked window. A window that comes back without its mark (older data) is treated as
  maximized before entry.
- **One owner**: the mode and the marks are window-kernel state, changed only by kernel commands
  (for example `EnterMaximizeAll` / `LeaveMaximizeAll`) and by the existing maximize events —
  not a flag in a feature renderer or in `ipc.ts`. The kernel stays free of Electron vocabulary
  (`apps/desktop/CLAUDE.md` "Electron is ONE backend").
- **Trigger**: one command in the Windows feature, `maximize all windows`, that toggles the mode
  (declared in `features/windows/manifest.json` so it wakes the lazy tile). No keyboard shortcut
  in this slice. It reaches main through a new tile API, `api.window.maximizeAll()` (capability
  `manage`, IPC in `main/tile-ipc.ts`), documented in `docs/tile-api.md`.

## What the code does now

- `main/window-kernel.ts`: `WindowRecord` carries `maximized` and `preMaxBounds`; the `Maximize` /
  `Unmaximize` commands and the `Maximized`, `Unmaximized` and `MaximizeExitedByResize` events
  own maximize. `WindowRecord` also carries its screen and desktop
  (`WindowPlacementReported`), and `CurrentDesktopChanged` tracks the current desktop.
- `features/windows/background.js`: `maximize window` / `unmaximize window` act on
  `api.window.getFocusedVisibleWindowId()`.
- `main/session-projection.ts serializeSession()` writes `maximized: true` with the pre-maximize
  bounds; `ipc.ts assembleHybridPageHost()` maximizes a restored window through the kernel.

## Rule to add

Add a rule to `docs/design/window-rules.md` beside G12 stating the decisions above (eligible
windows, scope, user changes win, exact restore on leaving, survives a restart), and a row in its
failure table.

## Tests to change

- `main/window-kernel.test.ts`, a "maximize-all" suite: entering maximizes and marks only
  eligible, unmaximized windows in scope; an already maximized window is untouched on leaving; a
  window on another screen or desktop is untouched; a window opened in scope while on is
  maximized and marked; resize-exit or unmaximize during the mode clears the mark and leaving
  does not move that window; leaving restores each marked window to its `preMaxBounds`; a
  transient window is never maximized by the mode.
- `main/session-projection.test.ts`: the mode, scope and marks round-trip through save and
  restore; restored data without marks yields no marked windows.
- If `main/window-kernel-properties.test.ts` generates commands, add the two new ones to its roll.
- New `tests/desktop/maximize-all.spec.ts` on a test profile: open two page windows at known
  bounds and a third already maximized; run `maximize all windows`; all three are maximized;
  resize one by hand; run it again; the untouched one is back at its exact bounds, the resized
  one keeps its new bounds, the third is still maximized.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
yarn workspace @peek/desktop test:grep "maximize-all|session-restore|hybrid-overlay"
```

Done when the unit tallies report `fail 0`, the new tests pass, and the other collected specs show
no new failure compared with `apps/desktop/tests/gate-baseline.md`. Record the `test:grep`
pass/fail count under `**Result**` in the handoff. macOS is unverified by this run: maximize on
macOS uses explicit work-area bounds rather than native maximize, and the laptop must check
entering, leaving and a relaunch with the mode on before landing.

## Working rules

`apps/desktop/CLAUDE.md` governs the desktop app; read it before editing, especially "Electron is
ONE backend" (`scripts/check-platform-leak.mjs` enforces it). Open Peek bugs in the same code:
`55448e88` (two definitions of "maximized"), `c1d149db` (`maximize window` regressed) — if either
blocks this slice, record it in the handoff rather than widening scope. Run one command per Bash
call.
