# Desktops and transient pages: working cheatsheet

Facts to hold while changing how Peek's windows behave across macOS desktops. Requirements live in
`specs/kernel-desktops.md`; history and research in `docs/design/kernel-desktops-implementation.md`;
rules in `docs/design/window-rules.md`. Anchors are `file` + symbol.

## The pipeline, one sentence each

- Native events become kernel events in `electron-window-backend.ts attachNativeListeners` (window
  focus, blur, show, hide, close) and `attachAppListeners` (app activate / resign, desktop switch).
- `window-kernel.ts evolve` folds events into `State`; `react` diffs old and new state into effects.
- `window-kernel-executor.ts` realizes effects through the `WindowBackend` port; the Electron
  realization is `ElectronWindowBackend` (`raiseWindow`, `showWindow`, `hideWindow`,
  `pinAlwaysOnTop`, `setDesktopMembership`, `closeWindow`).
- Tiles open windows through `ipc.ts windowOpenHandler`; web URLs become page-host windows (a
  `BaseWindow` plus one `WebContentsView`), built by `createHybridHostBaseWindow` and registered in
  the same handler's hybrid branch with `registerWindowWithMachine`.
- Only `electron-window-backend.ts` (and the provider files) may name Electron or AppKit;
  `scripts/check-platform-leak.mjs` and `scripts/check-r2-window-ops.mjs` enforce it.

## Transient page (a page opened from the palette over another app)

- Decided at open: `izui-roles.ts pageOpensTransient(isKeyHeldWhileAppInactive(), options)` in
  `ipc.ts windowOpenHandler`; it sets `options.activation = 'user'` and logs
  `page-opens-transient`. It never reuses an existing window.
- Built as an ordinary window flagged non-activating (`nonactivating-window.ts flagNonActivating`,
  addon `apps/desktop/native/nonactivating-window/nonactivating_window.mm`), `options.nonActivating = true`.
  It belongs to the desktop it opened on. Without the addon it is a panel (`options.type =
  'panel'`); the log line's `ordinary=` says which.
- Recorded as `WindowRecord.nonActivating` (`izui-roles.ts windowNonActivating`: a panel, or
  `options.nonActivating`).
- `ElectronWindowBackend.registerWindow` declares a non-activating window `onEveryDesktop` on
  macOS only when it is a panel, because Electron's panel re-adds join-all-Spaces on every
  collection-behaviour change (`electron_ns_panel.mm setCollectionBehavior:`).
  `setVisibleOnAllWorkspaces(false)` cannot undo it.
- While any transient window holds key taken from another app,
  `window-kernel.ts holdsKeyTakenFromAnotherApp` holds; when that stops (click-away, Peek brought
  forward) `evolve` (`markEndedKeyTakenFromAnotherApp`) marks it `pendingHidden` and `react` emits
  one `DismissWindow`. A desktop switch ends it on the read, not the notice: `DesktopsRead` marks
  every visible transient window whose desktop is not current.
- Its raise is held above other apps: `FocusRaiseRequested` in `evolve` sets `heldAboveOtherApps`
  (`admitsHoldAboveOtherApps`), realized by `pinAlwaysOnTop` at the floating level. Without the
  floating level, macOS restacks an inactive app's ordinary window behind the active app's windows
  about 20 ms after it shows.
- Key comes from `ElectronWindowBackend.raiseWindow`: page-host `take-key` goes through
  `takeKey`, then `focusRendererContent` for content focus. For a flagged window both use the
  addon (`makeKey`, `focusContent`), since Electron's `focus()` activates the app for a non-panel.

## Electron 43 facts that decide the transient-page design (checked in source)

- `NativeWindowMac::Focus(true)` calls `[NSApp activateIgnoringOtherApps:NO]` unless the window is a
  panel, then `makeKeyAndOrderFront:`. So `win.focus()` on any non-panel activates Peek.
- `WebContents::Focus()` on macOS calls `owner_window()->Focus(true)` first, then focuses the web
  contents. So `webContents.focus()` on a non-panel activates Peek too.
- A panel is on every desktop whatever is asked; an ordinary (managed) window stays on the desktop
  it was first ordered on. Shown on the other desktop, it takes the user back there.
- No Electron API changes a window's type after creation.

## Desktop reads

- The macOS switch notice (`NSWorkspaceActiveSpaceDidChangeNotification`) arrives after the
  switch animation and names no desktop. `attachSpaceChangeListener` sends
  `DesktopSwitchObserved`, then `onDesktopTrigger('space-changed')` queues `syncDesktops`.
- `syncDesktops` reads the helper (`apps/desktop/native/desktop-helper/main.swift`, through
  `desktop-provider-mac.ts` and `FailSafeDesktopProvider`), sends `DesktopLayoutReported` /
  `CurrentDesktopChanged`, then `WindowPlacementReported` per changed window, then `DesktopsRead`.
- Between the notice and the read (5–30 ms) `desktopUnread` holds, and only on-every-desktop
  windows count as on a current desktop.
- `space-changed screensBefore=` in the log is the desktop left. `desktop-provider started
  name=mac` with no `desktop-provider fallback` line means the helper is in use; nothing logs
  its per-window placements since the `PEEK_DESKTOP_PROBE` mode was removed (reverting that
  removal commit brings back its `desktop-read` line).

## Automation (no person needed)

- `osascript -e 'tell application "Finder" to activate'` puts another app in front.
- `osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`
  reads the active app (works from this terminal).
- Keystrokes and desktop switches through System Events (`keystroke`, `key code 123/124 using
  control down`) need Accessibility permission for the terminal; *unverified* whether granted.
- The desktop helper can read any window's desktop given its window number
  (`getMediaSourceId()` → `windowNumberFromSourceId`).
- A probe never waits on a person: it starts its show from a trigger the agent controls (a file,
  a signal, stdin), not a countdown.

## Running the app from this worktree

- Build: `yarn workspace @peek/desktop build` (also builds the desktop helper).
- Start: `PROFILE=kernel-desktops PEEK_PROFILE=kernel-desktops
  TMPDIR=<worktree>/.tmp yarn start`, stdout to `<worktree>/.tmp/<name>.log`.
- Stop: kill the `Electron.app` process under this worktree's `node_modules/electron`
  (`pgrep -f`), then confirm no `peek-desktop-helper` is left. Never `pkill -f electron`.
- Escape reaches the switcher fallback only when no text field has focus (Peek task `69098f7c`).
- Never drive a live check through a global hotkey (Cmd+Shift+W or any other): a production Peek
  running alongside registers the same accelerators, and the keystroke can open its window
  instead, which takes key from the one under test. Open the switcher through the profile's own
  socket: `peek-cli debug-eval 'peek://app/background.html'
  "window.app.pubsub.publish('cmd:execute:windows', {})"` with the launch's `PEEK_PROFILE` and
  `TMPDIR`; the palette with `peek-cli cmd-open`.
- A flagged window takes key only through `ElectronWindowBackend.takeKey`; any direct Electron
  `focus()` on it activates Peek, and the activation can land hundreds of milliseconds later.
