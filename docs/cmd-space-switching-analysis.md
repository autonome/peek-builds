# Cmd Palette macOS Space Switching Analysis

## Problem

When the user is on macOS Desktop Space 2 (or any non-primary Space) and opens the cmd palette via Alt+Space, macOS switches them back to the Space where the Peek app was initially started.

## Root Cause

The cmd palette window is created as a `keepLive` window with `modal: true`, `type: 'panel'`, and `alwaysOnTop: true`. When a keepLive window is reused (shown after being hidden), the `show()` + `focus()` calls on the BrowserWindow cause macOS to switch to the Space where the window was originally created.

macOS treats BrowserWindow display Spaces based on the `visibleOnAllWorkspaces` property. Without this property set, a window is bound to the Space where it was first created. When `show()` is called, macOS brings the user to that Space.

## Architecture

### Cmd Panel Window Lifecycle

1. **First open**: `openPanelWindow()` in `extensions/cmd/background.js` calls `api.window.open()` with `keepLive: true`, `modal: true`, `type: 'panel'`, `alwaysOnTop: true`.
2. **IPC handler**: `window-open` in `backend/electron/ipc.ts` creates a BrowserWindow with `type: 'panel'` (macOS) and `alwaysOnTop` set.
3. **Subsequent opens**: When the global shortcut is triggered again, the keepLive window is found by key and reused via `existingWindow.window.show()` + `.focus()` (ipc.ts lines ~2187-2195).
4. **Dismiss**: ESC or blur hides the window via `closeOrHideWindow()` which calls `win.hide()` for keepLive windows.

### Key Files

- `/Users/dietrich/misc/mpeek/extensions/cmd/background.js` - `openPanelWindow()` defines the window params
- `/Users/dietrich/misc/mpeek/extensions/cmd/config.js` - Global shortcut default (Option+Space)
- `/Users/dietrich/misc/mpeek/backend/electron/ipc.ts` - `window-open` IPC handler creates/reuses windows
- `/Users/dietrich/misc/mpeek/backend/electron/shortcuts.ts` - Global shortcut registration (no app.focus())
- `/Users/dietrich/misc/mpeek/backend/electron/windows.ts` - `closeOrHideWindow()` handles keepLive hide

### What Was NOT the Cause

- No `app.focus()` or `app.show()` calls in the shortcut path
- The `type: 'panel'` is already correct (panel-type windows don't activate the app's main window)
- The shortcut handler simply calls `openPanelWindow()` which calls `api.window.open()`

## Fix Applied

Two changes in `/Users/dietrich/misc/mpeek/backend/electron/ipc.ts`:

### 1. New modal window creation

After creating a new BrowserWindow for a modal window, call `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`. This ensures the window is not bound to a specific Space.

### 2. keepLive window reuse

Before calling `show()` + `focus()` on a reused keepLive window, reinforce `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`. This handles the case where the property might have been lost or needs reinforcement.

### Why `setVisibleOnAllWorkspaces()` and not constructor option

The `visibleOnAllWorkspaces` property is not available in Electron's `BrowserWindowConstructorOptions` TypeScript type -- it's only available as an instance property and via the `setVisibleOnAllWorkspaces()` method. The method also accepts a `visibleOnFullScreen` option which ensures correct behavior in fullscreen Spaces.

## Scope of Impact

The fix applies to all windows opened with `modal: true`, which includes:
- Cmd palette (the primary use case)
- Any other modal/palette windows that might be opened via the same code path

The HUD window is NOT affected because it uses `focusable: false` and has separate hide/show logic via `did-resign-active`/`did-become-active`.

Regular content windows (web pages) are NOT affected -- they remain bound to their creation Space, which is the expected macOS behavior.
