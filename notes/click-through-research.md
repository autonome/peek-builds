# Canvas Page Click-Through Research

## Problem Statement

Peek's canvas pages use a fullscreen transparent `BrowserWindow` covering the entire display. A webview and UI elements (navbar, resize handles, widgets) are positioned at specific coordinates on the transparent surface via JS. Clicks on transparent areas outside these elements should "pass through" to whatever is behind -- other Peek windows, other apps, the desktop.

The current implementation uses Electron's `setIgnoreMouseEvents(true, { forward: true })` with coordinate-based hit testing to toggle between click-through and normal mode. **This is broken**: when `setIgnoreMouseEvents(true)` is active and the user clicks on a transparent area, the OS passes that click to whatever window is directly behind. This activates/focuses unrelated windows (from other apps, the desktop, etc.), which is extremely disruptive.

## Current Implementation Analysis

In `/Users/dietrich/misc/mpeek/app/page/page.js` (lines 1138-1258), the `initClickThrough()` IIFE:

1. Gets the window ID, then calls `setIgnore(true)` to start in click-through mode
2. On every `mousemove`, checks if the cursor is over a "content" element (webview bounds, navbar, trigger zone, resize handles, widgets) via `isOverContent()`
3. When cursor enters content: `setIgnoreMouseEvents(false)` -- window captures events
4. When cursor leaves content: `setIgnoreMouseEvents(true, { forward: true })` -- OS passes through

The IPC path: `page.js` -> `api.window.setIgnoreMouseEvents()` -> preload `window-set-ignore-mouse-events` -> `ipc.ts` line 2770 -> `win.setIgnoreMouseEvents(msg.ignore, msg.forward ? { forward: true } : undefined)`

### Why It Fails

The fundamental issue is that `setIgnoreMouseEvents(true)` is an OS-level passthrough. On macOS, when a window ignores mouse events, those events are forwarded by the window server to the next window in the z-order. A click on the transparent area does not just "disappear" -- it reaches the window behind, which may be a Finder window, a browser, Terminal, or any other app. That window then gets focused/activated by macOS, pulling it to the front and switching focus away from Peek.

This is the documented Electron behavior: "All mouse events happened in this window will be passed to the window below this window." The OS has no concept of "ignore this click entirely" -- it only knows "this window doesn't want it, so give it to the next one."

## Electron API Deep Dive

### setIgnoreMouseEvents(ignore, { forward })

- **`ignore: true`**: The OS treats the window as non-existent for mouse events. Clicks, scrolls, and hovers pass through to whatever window is below in the z-order. This *activates* windows behind.
- **`forward: true`** (macOS/Windows only): While ignoring, the OS still forwards *mouse move* events to the renderer. This is how the toggle pattern works -- you get `mousemove` to detect when the cursor is over content, then switch `ignore` back to `false`. But clicks still go through to the window behind.
- **`forward: false`** (default): No mouse events at all reach the renderer when ignoring. The window is completely invisible to the mouse. This would be worse -- you can't even detect when to re-enable.

### setShape(rects) -- NOT available on macOS

`win.setShape(rects)` is marked **Windows/Linux only** (Experimental). It binds Chromium's `Widget::SetShape`, which defines clickable regions at the OS level. Mouse events outside the shape fall through. This would be the perfect solution if it were available on macOS, but it is not.

### @loomhq/electron-click-through-workaround

A native addon that patches `setIgnoreMouseEvents` to be a no-op for all NSWindows, restoring the *original* macOS behavior where borderless NSWindows naturally click through on transparent pixels and register clicks on opaque pixels. This was broken in Electron 7 when `new BrowserWindow()` started calling `setIgnoreMouseEvents: NO` on the underlying NSWindow.

**Trade-offs:**
- Globally disables `setIgnoreMouseEvents` for ALL windows (indiscriminate)
- Restores native macOS transparent-pixel-passthrough behavior
- Requires a native Node addon (build complexity, architecture-specific binaries)
- May conflict with other Peek windows that intentionally use `setIgnoreMouseEvents`

### app.disableHardwareAcceleration()

Historically, disabling GPU acceleration caused Chromium to use GDI/software rendering, which preserved transparent pixel click-through. **This broke in Electron ~38 nightly** (Chromium 139, June 2025). A workaround exists (`disable-direct-composition` switch) but it's Windows-specific and trades performance for click-through.

### setFocusable(focusable)

`win.setFocusable(false)` prevents the window from receiving focus. On macOS, "it does not remove focus from an already-focused window." This doesn't help -- the problem is that *other* windows get activated when clicks pass through, not that the transparent window gets focus.

### type: 'panel' (macOS)

Sets the NSWindow to use `NSWindowStyleMaskNonactivatingPanel`. The window floats on top, joins all spaces, and does not activate the app when focused. Potentially useful for the canvas window, but does not solve the click-through problem -- it only controls whether the *panel itself* activates the app, not what happens when clicks pass through to other windows.

## Alternative Approaches Evaluated

### Approach 1: Do Nothing on Transparent Areas (Recommended)

**Concept**: Remove `setIgnoreMouseEvents` entirely. The fullscreen transparent BrowserWindow always captures all mouse events. In the renderer (`page.js`), detect clicks on transparent areas and simply ignore them -- don't process them, don't propagate them to any UI element.

**How it works:**
- The BrowserWindow never enters `ignoreMouseEvents` mode
- All mouse events (clicks, moves, scrolls) are received by the renderer
- `page.js` already knows the bounds of all content elements (webview, navbar, resize handles, widgets) via the `isOverContent()` function
- Clicks outside content areas: swallow them (no action)
- Clicks inside content areas: process normally

**Pros:**
- Zero OS-level side effects -- no other windows get activated
- No native addons needed
- No IPC calls for every mouse move
- Simplest implementation (remove code, don't add)
- The existing `isOverContent()` hit-test logic already works

**Cons:**
- The transparent window "absorbs" all clicks -- users cannot click through to windows behind. They would need to Cmd+Tab or click on visible windows in the Dock to switch focus.
- The cursor won't change to indicate "this area is not interactive" (though on a fully transparent surface this is arguably fine -- the user sees through to the desktop but must use keyboard/Dock to interact with it)
- Scrolling over transparent areas would be captured too (not forwarded to windows behind)

**Severity of cons:**
The biggest downside is that users can't click through the transparent area to interact with windows behind. But the current broken behavior (activating random windows) is *worse* than not clicking through at all. This approach is a safe, immediately shippable fix.

### Approach 2: Shrink the BrowserWindow to Content Bounds (Recommended Hybrid)

**Concept**: Instead of a fullscreen transparent window, resize the BrowserWindow to tightly fit the content area (webview + navbar + resize handles). The transparent canvas model is replaced by a standard window that is exactly the size of the visible content.

**How it works:**
- When `updatePositions()` runs, also call `win.setBounds()` via IPC to resize/reposition the BrowserWindow to encompass all visible elements
- The window is no longer fullscreen -- it's just big enough for the webview + navbar + handles
- Areas outside the window are truly not covered by any window, so clicks naturally go to whatever is there

**Implementation sketch:**
```
// After updating element positions in page.js:
const windowBounds = computeWindowBounds(bounds, navbarVisible);
api.window.setBounds(windowId, windowBounds);
```

Where `computeWindowBounds` calculates a bounding box that includes the webview, visible navbar (if shown), trigger zone, and resize handles.

**Pros:**
- True click-through -- areas outside the content aren't covered by any window
- No `setIgnoreMouseEvents` needed at all
- No native addons
- Standard Electron window behavior

**Cons:**
- Moving the native window on every drag/resize adds IPC overhead and potential visual lag
- The window resize itself could cause visual flicker/jitter
- `transparent: true` windows on macOS cannot be resized (Electron limitation: "setting resizable to true may make a transparent window stop working")
- Complex to implement -- must account for navbar show/hide animation, resize handles extending beyond webview, widget container on the right, etc.
- Breaks the architectural elegance of the current model (position-anything-on-canvas)

**Severity of cons:**
The "transparent windows are not resizable" limitation is a hard blocker for this approach as-is. You would need to create a non-transparent, frameless window with a transparent-looking background, which introduces its own complications.

### Approach 3: Multiple Small Windows

**Concept**: Instead of one fullscreen transparent window, create separate BrowserWindows for each UI element: one for the webview content, one for the navbar, etc.

**How it works:**
- Main content window: opaque, frameless, positioned at webview bounds
- Navbar window: small frameless window positioned above content window, shown/hidden as needed
- Resize handles: invisible tiny windows at corners

**Pros:**
- No transparency needed for the main content
- Each window naturally handles its own mouse events
- Empty screen areas have no window covering them

**Cons:**
- Extremely complex coordination between multiple windows
- Cross-window drag requires IPC for every mouse event
- Navbar show/hide, resize handle positioning, widget panels all need separate window management
- Performance overhead of multiple BrowserWindows
- The webview content must be in a window, but the navbar, trigger zone, and resize handles are currently simple DOM elements -- they'd need to become separate windows with separate renderers

**Verdict:** This approach is far too complex for the benefit. It would require a complete rewrite of the canvas page system.

### Approach 4: Loom Native Addon (@loomhq/electron-click-through-workaround)

**Concept**: Use the Loom native addon to restore macOS's default NSWindow behavior where transparent pixels naturally pass clicks through.

**How it works:**
- The addon patches `setIgnoreMouseEvents` on all NSWindows to be a no-op
- This undoes Electron 7+'s call to `setIgnoreMouseEvents: NO` on window creation
- The default macOS behavior resumes: borderless NSWindows pass clicks through on transparent pixels and capture clicks on opaque pixels

**Pros:**
- Pixel-perfect click-through -- only truly transparent areas pass through
- No coordinate-based hit testing needed
- Most "correct" behavior from the user's perspective

**Cons:**
- Adds a native Node addon dependency (build complexity, arm64/x64 binaries, potential breakage on Electron upgrades)
- Globally disables `setIgnoreMouseEvents` for ALL windows in the process -- no other Peek window can use it
- The addon is from 2020 and may not be maintained for current Electron/macOS versions
- May not work correctly with `transparent: true` + Chromium compositing -- the "opaque pixel" detection depends on the rendering pipeline
- If webview content has transparent areas, clicks would pass through those too (undesirable)

**Verdict:** Promising conceptually but risky in practice. The global nature and maintenance burden are concerns. Could be explored as a Phase 2 optimization if Approach 1 is insufficient.

### Approach 5: CSS pointer-events: none + setIgnoreMouseEvents Toggle (electron-transparency-mouse-fix approach)

**Concept**: Set `pointer-events: none` on the `<html>` element by default, with `pointer-events: auto` only on interactive elements. Use `document.elementFromPoint()` on mousemove to detect if the cursor is over an interactive element, and toggle `setIgnoreMouseEvents` accordingly.

**How it works:**
- With `setIgnoreMouseEvents(true, { forward: true })`, mousemove events still arrive
- On each mousemove, check `document.elementFromPoint(e.clientX, e.clientY)`
- If the element is `<html>` or `<body>` (the transparent background): stay in ignore mode
- If it's a real UI element: switch to `setIgnoreMouseEvents(false)`

**This is essentially what the current implementation already does**, just using `isOverContent()` with coordinate checks instead of `elementFromPoint()`. It has the exact same fundamental problem: when in ignore mode and the user clicks, the click activates the window behind.

**Verdict:** Same problem as the current implementation. The detection mechanism differs, but the OS-level passthrough behavior is identical.

### Approach 6: Hybrid -- Do Nothing + Keyboard Escape Hatch

**Concept**: Use Approach 1 (no OS passthrough), but add a keyboard shortcut or gesture that makes the canvas window temporarily step aside to let the user interact with windows behind.

**How it works:**
- Canvas window always captures all events (no `setIgnoreMouseEvents`)
- A keyboard shortcut (e.g., Cmd+\ or holding Option) temporarily hides the canvas window or moves it to the back
- User clicks on whatever they need behind the canvas
- Canvas window comes back when the shortcut is released or after a short delay

**Pros:**
- All the benefits of Approach 1
- Still allows interacting with windows behind, just via a deliberate gesture
- No accidental activation of random windows

**Cons:**
- Discoverability -- users need to learn the gesture
- Less seamless than true pixel-level click-through

## Recommendation

### Phase 1 (Immediate fix -- ship now)

**Approach 1: Remove `setIgnoreMouseEvents`, swallow clicks on transparent areas.**

Implementation:
1. Delete the entire `initClickThrough()` IIFE (lines 1138-1258 of page.js)
2. Remove the `setIgnoreMouseEvents` IPC handler usage (leave the handler in ipc.ts for other potential uses)
3. The existing `isOverContent()` function can remain as documentation or be removed
4. Add a document-level click handler that prevents any unintended behavior when clicking on the transparent background (the current mousedown handler on document already hides the navbar on outside clicks -- that's fine)

The transparent background will simply be inert. The user sees through it to the desktop/other windows but clicks do nothing there. This is the expected behavior for a canvas/overlay app -- you interact with the content, and you use standard OS mechanisms (Cmd+Tab, Mission Control, Dock) to switch to other apps.

**This is the correct fix because:**
- The transparent area is the canvas "surface" -- it's Peek's window, just invisible
- Users don't expect to click through a window to reach another window; they expect to switch apps
- The current broken behavior (activating random windows) is far worse than "clicks do nothing"
- It requires removing code, not adding complexity

### Phase 2 (Future improvement, if needed)

If users genuinely need to click through to windows behind the canvas:

1. **Investigate the Loom native addon** or a custom Objective-C addon that restores macOS NSWindow transparent-pixel click-through behavior, but scoped to canvas windows only (not global)
2. **Explore `type: 'panel'`** for canvas windows -- while it doesn't solve click-through directly, the non-activating behavior might reduce the disruption when combined with other techniques
3. **Consider Approach 2 (shrink window to content)** if transparent window resizing limitations can be worked around (e.g., by destroying and recreating the window on resize, or using a non-transparent window with a fully-transparent rendered background)

### Phase 3 (Aspirational)

Watch for Electron/Chromium to add `setShape` support on macOS, or for a proper per-region click-through API. Electron issue #1335 and #38396 track this long-standing request.

## References

- [Electron setIgnoreMouseEvents documentation](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions)
- [Electron issue #1335: Support click-through of transparency](https://github.com/electron/electron/issues/1335)
- [Electron issue #23042: Click-through broken in Electron >6.1.9](https://github.com/electron/electron/issues/23042)
- [Electron issue #38396: Feature request for per-region mouse event control](https://github.com/electron/electron/issues/38396)
- [Loom macOS click-through workaround](https://github.com/loomhq/ElectronMacOSClickThrough)
- [electron-transparency-mouse-fix](https://github.com/toonvanvr/electron-transparency-mouse-fix)
- [Electron issue #48064: disableHardwareAcceleration click-through broken in Electron 38](https://github.com/electron/electron/issues/48064)
- [BrowserWindow API: setShape (Windows/Linux only)](https://www.electronjs.org/docs/latest/api/browser-window)
- [Electron issue #35815: NSWindow nonactivating panel styleMask](https://github.com/electron/electron/issues/35815)
- [Apple NSWindow.ignoresMouseEvents documentation](https://developer.apple.com/documentation/appkit/nswindow/ignoresmouseevents?language=objc)
