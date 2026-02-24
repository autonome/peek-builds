# Navbar Hide Flash/Jump Analysis

## Overview

When the navbar hides in the page host, the user sees a brief visual flash or jump of the webview content. This document traces the exact sequence of operations that causes it.

## Architecture Context

The page host uses a three-column flexbox layout:

```
[ left-gutter (flex:1) ] [ center-column (flex:none) ] [ right-gutter (flex:1) ]
```

The `center-column` has a fixed pixel width set by `updatePositions()`. The gutters absorb any extra window width (`extraWidth`), keeping the center column visually centered. When `extraWidth > 0`, the window is wider than the center column needs, and the gutters fill the surplus symmetrically.

The variable `extraWidth` controls how much wider the window is than the core content. When panels (page info + entities) are visible, `extraWidth = PANEL_OVERHANG * 2 = 420px`. When hidden, `extraWidth = 0`.

`computeWindowBounds()` uses `extraWidth` to calculate the BrowserWindow position and size:

```js
winX = sb.x - MARGIN - extraWidth / 2
winW = sb.width + MARGIN * 2 + extraWidth
```

So when `extraWidth` changes, the window X shifts by half the delta, and the window width changes by the full delta — the center column stays at the same screen position because flexbox centers it.

## The Hide Sequence — Frame by Frame

### Starting State (navbar visible, panels visible)

- `extraWidth = 420` (PANEL_OVERHANG * 2)
- Window is 420px wider than the core content area
- Left and right gutters each absorb ~210px
- Center column is centered at the correct screen position
- Panels are positioned within center-column at negative left / overflowing right offsets, visible within the gutter space

### Frame 0: `hide()` is called

```js
async function hide() {
  if (isDragging || holdDragPending) return;
  if (loadingLifecycle.state === 'loading') return;
  // ... clear hideTimer ...
  const gen = ++navbarGeneration;

  // SYNCHRONOUS: setWindowPadding(0) is called
  await setWindowPadding(0);
  // ... post-await CSS cleanup ...
}
```

### Frame 0 (continued): Inside `setWindowPadding(0)`

```js
function setWindowPadding(width) {
  width = Math.max(0, width);       // width = 0
  if (width === extraWidth) return;  // 0 !== 420, continues
  extraWidth = width;                // *** SYNCHRONOUS: extraWidth = 0 ***
  if (pendingBoundsUpdate) {         // cancel any RAF-throttled update
    cancelAnimationFrame(pendingBoundsUpdate);
    pendingBoundsUpdate = null;
  }
  const p = api.window.setBounds(computeWindowBounds(screenBounds));  // IPC call
  return p;
}
```

**Critical moment**: `extraWidth` is set to 0 **synchronously**, but `setBounds` is an async IPC call (`ipcRenderer.invoke`). The function returns a promise.

At this point:
- `extraWidth = 0` (JS state updated)
- `computeWindowBounds(screenBounds)` now computes bounds with `extraWidth = 0`: window is 420px narrower and shifted 210px rightward
- The IPC message (`window-set-bounds`) has been **sent** to the main process but has not yet been **applied**

### Frame 0 (still): Microtask checkpoint

The `await` in `hide()` suspends execution. The promise from `setWindowPadding(0)` (which wraps `ipcRenderer.invoke`) is pending. Control returns to the event loop.

**No CSS classes have been changed yet.** The navbar still has class `visible`. The panels still have class `visible`. `updatePositions()` has NOT been called.

### Frame 1: The problematic render

Here is where the flash occurs. There are **two** things that can trigger a re-layout/repaint before the IPC resolves:

#### Scenario A: Nothing triggers a re-layout before setBounds resolves

In the best case, no re-layout occurs between `extraWidth = 0` and the main process applying the new bounds. The `setBounds` call in the main process (`win.setBounds(...)`) is synchronous from the main process perspective. It resizes and repositions the BrowserWindow immediately.

When the window shrinks from the main process side:
1. The BrowserWindow shrinks by 420px and shifts 210px rightward
2. The renderer's viewport shrinks
3. Flexbox recalculates: the center column width hasn't changed (still set by `updatePositions()` to `screenBounds.width + MARGIN * 2`), but the viewport is now only as wide as the center column
4. The gutters collapse to 0 width (they were `flex: 1, min-width: 0`)
5. **The panels, which are positioned at negative left offsets and overflowing right, are now clipped by the window edge** — the code comments describe this as the intended behavior: "the window shrinks while panels are still visible (they get clipped by the window edge)"

This is the designed behavior and should look clean.

#### Scenario B: Something forces a re-layout while IPC is in flight

If **any** code path triggers `updatePositions()` or the browser performs a style recalculation while `extraWidth = 0` but the window is still at its old (wide) size, the following happens:

- `computeWindowBounds()` would produce different values if called
- However, `updatePositions()` does NOT read `extraWidth` — it only reads `screenBounds` and the navbar visibility CSS class
- The center column width is unchanged (`screenBounds.width + MARGIN * 2`)
- So `updatePositions()` itself would not cause a jump

**This scenario is not the primary cause.**

#### Scenario C: The actual race condition (most likely cause)

The IPC round-trip has non-trivial latency. Here is the precise sequence:

1. **T=0ms (renderer)**: `extraWidth = 0`, `ipcRenderer.invoke('window-set-bounds', newBounds)` sent
2. **T=~0.5-2ms (main process)**: Main process receives message, calls `win.setBounds(narrowBounds)` — this is a synchronous Cocoa/AppKit call that immediately resizes the NSWindow
3. **T=~0.5-2ms (compositor)**: The window manager resizes the window on screen. The renderer's viewport is now smaller.
4. **T=~2-4ms (renderer)**: The renderer receives the resize event. Chromium re-layouts the page in the new viewport. Flexbox recalculates.

**Between T=2 (window shrinks on screen) and T=3 (renderer re-layouts), there is a frame where the OS has shrunk the window but the renderer has not yet re-drawn.** The OS compositor shows the old renderer content clipped to the new, smaller window bounds. Depending on timing, the content might appear to shift because the window's X position changed (moved 210px right) but the rendered pixels inside haven't been re-composited yet.

However, this is a standard window resize artifact and is usually imperceptible.

### The Real Root Cause: Post-await CSS changes trigger a second layout shift

After the `await setWindowPadding(0)` resolves (the IPC promise returns `{ success: true }`):

```js
  await setWindowPadding(0);
  if (navbarGeneration !== gen) return;  // generation check
  navbar.classList.remove('visible');     // *** CSS: navbar goes from display:block to display:none ***
  if (pageInfoPanel) pageInfoPanel.classList.remove('visible');  // *** panels hidden ***
  if (entitiesPanel) entitiesPanel.classList.remove('visible');
  updatePositions();                      // *** recalculates trigger zone, resize handles ***
  navbar.inputElement?.blur();
  showSource = null;
```

When the `await` resolves:

1. The window has **already** been resized to the narrow bounds (no extraWidth)
2. `navbar.classList.remove('visible')` sets navbar to `display: none`
3. `updatePositions()` is called, which updates the trigger zone position:
   - With `navVisible = false`: trigger zone top becomes `0px`, height becomes `navOffset + TRIGGER_ZONE_HEIGHT = 44px`
   - Navbar resize handles are hidden

**This is clean — no jump here** because the window is already the right size and the panels are already clipped.

### The ACTUAL Root Cause: `computeWindowBounds` includes navbar space unconditionally, but `setWindowPadding` changes happen in a different frame than the visual hide

Let me re-examine. The comment at line 115 says:

```
// NOTE: The window always includes navbar space (NAVBAR_HEIGHT) to avoid
// visual jumps on show/hide. Navbar visibility is CSS-only — no window resize.
```

This means the **Y-axis** is not the problem — the window height and Y-position never change when the navbar shows/hides. The navbar space is always allocated.

**The problem is the X-axis and width — the panel overhang.** Here is the exact cause:

### Root Cause: Two-frame transition

When `hide()` runs:

**Frame N (synchronous)**:
1. `extraWidth` is set to 0
2. `computeWindowBounds()` is called with `extraWidth = 0`, producing bounds 420px narrower and 210px shifted right
3. IPC message is dispatched (async)
4. Execution yields at `await`

**At this point, the renderer still shows the old layout.** The window is still wide. The panels and navbar are still visible. No visual change yet.

**Frame N+1 (main process applies setBounds)**:
1. The main process calls `win.setBounds()` — the window shrinks 420px and moves 210px right
2. The OS immediately resizes the NSWindow
3. The renderer receives a resize notification
4. **Flexbox recalculates**: center column stays at its fixed width, gutters collapse from ~210px each to 0
5. **The center column shifts leftward within the viewport** because:
   - Before: viewport was wide, gutters took 210px on each side, center was in the middle
   - After: viewport equals center column width, center is flush left
   - BUT the window also moved 210px right on screen
   - Net effect: the center column's **screen position** should be unchanged (210px less gutter offset + 210px rightward window shift = 0 net shift)

**In theory, this should be visually stable.** The flexbox centering math is designed so that shrinking the window while shifting it rightward keeps the center content at the same screen position.

### So Where Does the Flash Come From?

The flash comes from **timing jitter between the window position change and the window size change**. On macOS, `setBounds()` (which maps to `[NSWindow setFrame:display:]`) applies position and size atomically at the OS level. However, the Chromium compositor may take an extra frame to re-render content at the new size.

**The real culprit is this**: Between the OS resizing the window and Chromium re-rendering, there is exactly one frame where:

1. The window has moved 210px to the right (new X position)
2. The window has shrunk 420px
3. But the **rendered content** (the pixels in the compositor buffer) is still from the old layout (wide, with gutters)
4. The OS clips the old rendered content to the new, smaller window rect
5. Since the old content had 210px of left gutter, and the window moved right by 210px, **the left gutter is now clipped out** — but the old pixel content still shows the center column at its old position within the buffer
6. The visible result: **the center column appears to jump left by 210px for one frame**, because the old pixels (with left gutter) are being shown in a window that has shifted right

Then on the next frame, Chromium re-renders with the new viewport size, the gutters collapse, the center column is flush with the left edge of the (now-narrowed) viewport, and everything looks correct again.

**This one-frame discrepancy is the flash.**

### Secondary Contributor: Panel CSS transitions

The panels have CSS transitions:

```css
.page-info-panel {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
```

But the panels' CSS classes are only removed **after** the `await` — so by the time they animate out, the window is already narrow and they're clipped. The transitions don't contribute to the flash.

However, if the panels had been made invisible (CSS) **before** the window shrank, there would be a frame where the panels disappear but the window is still wide, and the empty gutter space would be visible. The code explicitly avoids this with the comment:

```js
// setBounds is async IPC — if we hide panels (CSS) before the window shrinks,
// there's a frame where panels are gone but the window is still wide, and
// flexbox re-centers the content in the oversized window, causing a visible jump.
```

This suggests the developer already identified one ordering problem but the remaining flash comes from the compositor timing issue described above.

## Summary of Root Cause

The visual flash when the navbar hides is caused by a **single-frame compositor desync** during the window bounds change:

1. `setWindowPadding(0)` sets `extraWidth = 0` and sends `setBounds` via IPC to shrink the window by 420px (210px from each side).
2. The main process applies `setBounds()` atomically — the window moves right by 210px and shrinks by 420px.
3. For exactly one compositor frame, the rendered pixel buffer still shows the old wide layout (with 210px gutters on each side), but the OS window has already moved and shrunk.
4. The OS clips the stale pixel buffer to the new window rect. Since the buffer had the center column at offset ~210px from the left, but the window has shifted right and the buffer is clipped from the right edge, **the user sees the content appear to jump or shift laterally for one frame**.
5. On the next frame, Chromium re-renders at the new size, gutters collapse, and the center column is correctly positioned.

The root issue is that **there is no way to atomically synchronize the BrowserWindow bounds change (main process, OS-level) with the renderer's composite buffer (renderer process, GPU-level)**. The IPC-based `setBounds` always has at least a one-frame gap between the window geometry change and the renderer catching up.
