# macOS Spaces Switching: Root Cause Analysis

## Problem Statement

When the user is on macOS Desktop Space 2 (or any Space other than where the Peek app was
initially started) and triggers the cmd palette via the Alt+Space global shortcut, macOS switches
them back to the original Space where the app started.

A previous fix attempted to add `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`
to modal windows and reused keepLive windows, but this did NOT fix the issue.

---

## 1. Exact Call Chain from Alt+Space Keypress to Window Display

### Step 1: Global Shortcut Registration

In `/Users/dietrich/misc/mpeek/extensions/cmd/background.js`, the `initShortcut()` function
(line 396) registers a global shortcut via the extension API:

```js
api.shortcuts.register(prefs.shortcutKey, () => {
  openPanelWindow(prefs);
}, { global: true });
```

The default shortcut key is `Option+Space` (from `config.js` line 32).

This calls through to `/Users/dietrich/misc/mpeek/apps/desktop/main/shortcuts.ts` line 174:

```ts
const ret = globalShortcut.register(shortcut, () => {
  callback();
});
```

The callback is a plain function -- no `app.focus()` or `app.show()` is injected here. The
callback simply invokes `openPanelWindow(prefs)`.

### Step 2: openPanelWindow calls api.window.open

In `background.js` line 332-388, `openPanelWindow()` calls:

```js
api.window.open(panelAddress, params);
```

With these params:
- `key: panelAddress` (enables keepLive reuse)
- `keepLive: true`
- `modal: true`
- `type: 'panel'`
- `alwaysOnTop: true`
- `transparent: true`
- `frame: false`
- `center: true`
- `role: 'palette'`

### Step 3: IPC handler 'window-open' in main process

In `/Users/dietrich/misc/mpeek/apps/desktop/main/ipc.ts` line 2139, the `window-open` IPC
handler fires.

**FIRST INVOCATION (cold start -- window doesn't exist yet):**

The handler reaches line 2305-2310 which sets `type: 'panel'` for modal windows on macOS:

```ts
if (options.modal === true) {
  if (process.platform === 'darwin') {
    winOptions.type = 'panel';
  }
}
```

Then at line 2365, `new BrowserWindow(winOptions)` is called. After creation, at line 2371-2374:

```ts
if (options.modal === true && process.platform === 'darwin') {
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
}
```

The window is created with `show: true` (line 2234, since `options.show !== false` and not headless), so `BrowserWindow` constructor calls native `Show()`.

**SUBSEQUENT INVOCATIONS (keepLive reuse -- window already exists):**

The handler reaches line 2172-2198:

```ts
const existingWindow = findWindowByKey(msg.source, options.key);
if (existingWindow) {
  // ...
  if (process.platform === 'darwin' && (options.modal === true || options.alwaysOnTop === true)) {
    existingWindow.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  existingWindow.window.show();    // <--- LINE 2194
  existingWindow.window.focus();   // <--- LINE 2195
  return { success: true, id: existingWindow.id, reused: true };
}
```

---

## 2. Every show(), focus(), and app.focus() Call in the Chain

### Direct calls in the cmd palette flow:

| Call | Location | When |
|------|----------|------|
| `new BrowserWindow({ show: true })` | ipc.ts:2365 | First open (cold) |
| `win.setVisibleOnAllWorkspaces(true)` | ipc.ts:2372 | First open (cold) |
| `existingWindow.window.setVisibleOnAllWorkspaces(true)` | ipc.ts:2192 | Reuse (warm) |
| `existingWindow.window.show()` | ipc.ts:2194 | Reuse (warm) |
| `existingWindow.window.focus()` | ipc.ts:2195 | Reuse (warm) |

### Indirect calls triggered as a side effect:

| Call | Location | When |
|------|----------|------|
| `win.show()` for HUD windows | main.ts:199 | `did-become-active` handler shows HUD overlays |

There are **no** `app.focus()` or `app.show()` calls anywhere in the codebase.

---

## 3. Which Specific Call Triggers the Space Switch

### The Root Cause: `BrowserWindow.show()` and `BrowserWindow.focus()` call native macOS activation

Looking at Electron's native macOS implementation (`native_window_mac.mm`), the `Show()` and
`Focus()` methods behave differently for panel vs. non-panel windows:

**For NON-panel windows:**
```objc
// Show():
[[NSApplication sharedApplication] activateIgnoringOtherApps:YES];
[window_ makeKeyAndOrderFront:nil];

// Focus():
[[NSApplication sharedApplication] activateIgnoringOtherApps:NO];
[window_ makeKeyAndOrderFront:nil];
```

**For panel windows:**
```objc
// Show() and Focus():
[window_ makeKeyAndOrderFront:nil];
// NO activateIgnoringOtherApps call
```

The cmd palette IS created as a panel window (`type: 'panel'`), which means its `show()` and
`focus()` calls should NOT trigger `activateIgnoringOtherApps`. This is why the previous fix
of adding `setVisibleOnAllWorkspaces` did not work -- the problem is upstream of the cmd palette
window itself.

### The Actual Trigger: The `did-become-active` Handler

Here is the critical sequence of events:

1. User is on Space 2. Peek app's windows (background, extension host, etc.) are on Space 1.

2. User presses Alt+Space. The `globalShortcut` callback fires in the main process.

3. The callback calls `openPanelWindow()` which sends an IPC to `window-open`.

4. `window-open` calls `existingWindow.window.show()` on the cmd palette (a panel window).

5. **On Electron 40.x** (the version used: `"electron": "^40.0.0"`), the panel window's
   `show()` does NOT call `activateIgnoringOtherApps`. However, calling `show()` on
   ANY BrowserWindow still causes macOS to deliver an `NSApplicationDidBecomeActiveNotification`
   if the app was not already the active app, because ordering a window to front (`makeKeyAndOrderFront`)
   can trigger app activation at the macOS level.

6. The `did-become-active` handler in `main.ts` (line 193-202) fires:
   ```ts
   (app as any).on('did-become-active', () => {
     // ...
     for (const win of BrowserWindow.getAllWindows()) {
       if (!win.isDestroyed() && win.isAlwaysOnTop() && (win as any).__hudHidden) {
         win.show();  // <--- Shows HUD window!
         (win as any).__hudHidden = false;
       }
     }
   });
   ```

7. **This shows the HUD window, which is NOT a panel window** (it's created as a normal
   BrowserWindow with `alwaysOnTop: true, focusable: false`). Even though it's non-focusable,
   calling `show()` on a non-panel BrowserWindow triggers `activateIgnoringOtherApps:YES`
   in the native code, which forces macOS to switch to the Space where that window was created.

### BUT: Even without the HUD, there's a deeper issue

Even if the HUD window were not shown, there is a fundamental problem:

**`setVisibleOnAllWorkspaces(true)` uses `NSWindowCollectionBehaviorCanJoinAllSpaces`**, which
makes the window VISIBLE on all Spaces but does NOT prevent Space switching when the window
is activated. What is actually needed is **`NSWindowCollectionBehaviorMoveToActiveSpace`**, which
tells macOS: "when this window becomes active, move it to the currently active Space instead
of switching the user to the window's original Space."

Electron's `setVisibleOnAllWorkspaces(true)` does NOT set `NSWindowCollectionBehaviorMoveToActiveSpace`.
This is a known limitation documented in [Electron issue #8734](https://github.com/electron/electron/issues/8734).

### Summary of triggers (in order of severity):

1. **Primary trigger**: `existingWindow.window.show()` + `existingWindow.window.focus()` on
   the keepLive cmd palette window (ipc.ts lines 2194-2195). Even though it's a panel window
   and skips `activateIgnoringOtherApps`, `makeKeyAndOrderFront` can still trigger app activation
   at the macOS level, which causes Space switching.

2. **Secondary trigger**: The `did-become-active` handler calling `win.show()` on the HUD
   window (main.ts line 199). This is a non-panel window, so its `show()` calls
   `activateIgnoringOtherApps:YES`, which definitively forces a Space switch.

3. **Underlying issue**: `setVisibleOnAllWorkspaces` uses `CanJoinAllSpaces` but NOT
   `MoveToActiveSpace`. Even with `visibleOnAllWorkspaces: true`, showing/focusing a window
   can still cause macOS to switch to its original Space.

---

## 4. What the Internet Says About This Issue

### Electron Issue #8734: window.show() on current desktop
[https://github.com/electron/electron/issues/8734](https://github.com/electron/electron/issues/8734)

The canonical issue. Users report that `setVisibleOnAllWorkspaces` makes windows visible on
all desktops, but `window.show()` still switches to the desktop where the window was initially
created. The issue was closed as duplicate of #5362 (Add workspace API) which remains open.

**Key workaround discussed**: Use `NSWindowCollectionBehaviorMoveToActiveSpace` instead of (or
in addition to) `NSWindowCollectionBehaviorCanJoinAllSpaces`. Electron does not expose this
flag through its API.

### Electron Issue #29644: focusable:false BrowserWindow still makes macOS try to focus it
[https://github.com/electron/electron/issues/29644](https://github.com/electron/electron/issues/29644)

Confirms that even `focusable: false` windows cause Space switching on macOS. When the Electron
app gets focus and a window is not focusable, the focus is given to another Electron window,
causing a Space ping-pong effect.

### Electron PR #40307: Do not activate app when calling focus on inactive panel window
[https://github.com/electron/electron/pull/40307](https://github.com/electron/electron/pull/40307)

Fixed in Electron 28+. Panel windows no longer call `activateIgnoringOtherApps` when focused.
This is already in effect for this project (Electron 40). However, this only prevents the
panel's own `focus()` from activating the app -- it does NOT prevent app activation from other
sources (like `makeKeyAndOrderFront` or other non-panel windows being shown).

### Electron Issue #36364: setAlwaysOnTop + setVisibleOnAllWorkspaces + visibleOnFullScreen not working
[https://github.com/electron/electron/issues/36364](https://github.com/electron/electron/issues/36364)

The combination of `setAlwaysOnTop`, `setVisibleOnAllWorkspaces`, and `visibleOnFullScreen`
does not work reliably unless the window is manually focused by the user.

### VSCode Issue #90680: VSCode stealing focus / switching macOS spaces
[https://github.com/microsoft/vscode/issues/90680](https://github.com/microsoft/vscode/issues/90680)

The same problem affects VSCode, confirming this is a systemic Electron limitation on macOS.

### nswindow-napi package
[https://www.npmjs.com/package/nswindow-napi](https://www.npmjs.com/package/nswindow-napi)

A native Node.js addon that provides direct access to NSWindow's `collectionBehavior` property,
enabling setting of `NSWindowCollectionBehaviorMoveToActiveSpace` which Electron does not
expose through its JavaScript API.

---

## 5. Conclusion: Root Cause

The root cause is a combination of two factors:

**Factor A: Electron's `setVisibleOnAllWorkspaces` sets the wrong NSWindow collection behavior flag.**
It sets `NSWindowCollectionBehaviorCanJoinAllSpaces` (window appears on all Spaces) but does NOT
set `NSWindowCollectionBehaviorMoveToActiveSpace` (window moves to the active Space when
activated instead of switching the user). Electron does not expose any API to set
`MoveToActiveSpace`.

**Factor B: Calling `show()` or `focus()` on ANY BrowserWindow triggers macOS app activation.**
Even panel windows (which skip `activateIgnoringOtherApps`) still call `makeKeyAndOrderFront`,
which can trigger `NSApplicationDidBecomeActiveNotification`. Once the app becomes active, the
`did-become-active` handler in `main.ts` shows HUD overlay windows via `win.show()`, and THOSE
windows are non-panel types whose `show()` calls `activateIgnoringOtherApps:YES`, which
definitively forces a Space switch.

The previous fix of adding `setVisibleOnAllWorkspaces(true)` was addressing the wrong flag.
The window was already visible on all workspaces -- the problem is that activating it pulls
the user to the wrong Space, and the correct macOS behavior flag (`MoveToActiveSpace`) is not
available through Electron's API.
