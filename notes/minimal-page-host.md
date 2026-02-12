# Minimal Page Host Window — Architecture Evaluation

## Problem Recap

Canvas pages currently use a **fullscreen transparent BrowserWindow** covering the entire display. Inside this transparent surface, a webview, navbar, resize handles, and widgets are positioned at absolute pixel coordinates via JavaScript. The transparent areas between these elements cause an intractable click-through problem on macOS: `setIgnoreMouseEvents(true)` passes clicks to windows behind, activating random apps (see `notes/click-through-research.md`). The alternative — absorbing all clicks — makes the entire screen unclickable except for the page content.

## Proposed Architecture

Replace the fullscreen transparent window with a **minimal-sized BrowserWindow** that tightly wraps the actual visible content. The BrowserWindow dynamically resizes as UI elements appear/disappear (navbar, widgets).

## Current Architecture Analysis

### How positioning works today

The `bounds` object in `page.js` (`{x, y, width, height}`) is the single source of truth. It represents the webview's position on the **display** (not relative to the window, since the window IS the display). `updatePositions()` places every element relative to these screen coordinates:

- **Webview**: `left: x, top: y, width: w, height: h`
- **Navbar**: `left: x, top: max(0, y - gap - navHeight), width: w` (above webview)
- **Trigger zone**: `left: x, top: max(0, navTop - 14), width: w` (above navbar)
- **Resize handles**: 24x24 at each corner of the webview
- **Nav resize handles**: 24x24 at top corners of navbar (when visible)
- **Drag overlay**: covers webview area exactly
- **Mode indicator**: top-right of webview
- **Widget container**: `left: x + width + 12, top: y` (right side of webview)

### How drag works

Two mechanisms:
1. **Navbar instant drag**: mousedown on navbar background starts drag immediately. `mousemove` updates `bounds.x/y`, calls `updatePositions()`. This moves the elements within the fullscreen window — the window itself never moves.
2. **Hold-to-drag**: 150ms hold anywhere on transparent canvas, or 300ms hold inside webview (via injected JS + `console-message` bridge + drag overlay activation). Same movement logic.

Key insight: **Drag currently moves elements within the window, not the window itself.** The BrowserWindow stays fullscreen. `bounds.x/y` are screen coordinates that happen to equal window-relative coordinates because the window fills the screen.

### How resize works

Pointer-captured 24x24 handles at corners. `pointermove` updates `bounds.width/height` (and `bounds.x/y` for nw/ne/sw directions), calls `updatePositions()`. Again, this moves elements within the fixed fullscreen window.

### How navbar show/hide works

The navbar is `display: none` by default, `display: flex` when `.visible`. The trigger zone is always present above the webview area. Show/hide is triggered by:
- Hover over trigger zone (auto-hides on leave)
- Cmd+L shortcut (stays until Escape or click-outside)

The navbar occupies space above the webview with an 8px gap. When it appears, no window resize happens — it's already inside the fullscreen window.

### How session save/restore works

**Save**: `extractCanvasBounds()` in `session.ts` reads `x/y/width/height` from the `peek://app/page/index.html?...` URL params (kept in sync by `updateUrlParams()` via `history.replaceState`). This gives the webview bounds, not the fullscreen BrowserWindow bounds.

**Restore**: `restoreSessionSnapshot()` passes saved bounds as `x/y/width/height` options to `window.app.window.open(url, options)`. The `window-open` IPC handler passes these through as URL params to the page container and then sizes the BrowserWindow to fullscreen on the nearest display.

### How click-through works (broken)

The `initClickThrough()` IIFE toggles `setIgnoreMouseEvents` based on cursor position via `isOverContent()`. This is fundamentally broken on macOS because ignored clicks activate windows behind.

## Minimal Window Approach — Detailed Evaluation

### Core Concept

Instead of a fullscreen transparent window with elements at screen coordinates, create a tight-fitting window where:
- The window position/size encompasses all visible content
- Elements are positioned relative to the window origin (0, 0), not the screen
- Moving the page = moving the BrowserWindow (via `win.setBounds()`)
- Resizing the page = resizing the BrowserWindow

### What Changes Are Needed

#### 1. Coordinate System Shift

**Current**: `bounds.x/y` = screen coordinates = window-relative coordinates (because window fills screen).

**New**: Two coordinate systems:
- `screenBounds` — where the page appears on screen (drives `win.setBounds()`)
- Element positions relative to window origin (0, 0)

The webview would be positioned at approximately `(margin, margin)` or `(0, navbarHeight)` within the window, not at screen pixel coordinates. The `updatePositions()` function would place elements relative to the window, not the screen.

#### 2. Window Sizing — `computeWindowBounds()`

A new function computes the BrowserWindow bounds that encompass all visible content:

```
Base area: webview bounds + small margin for resize handle hit targets
  + If navbar visible: expand upward by (NAVBAR_HEIGHT + NAVBAR_GAP)
  + If widgets visible: expand rightward by (widget width + gap)
```

The window bounds change when:
- Navbar shows/hides (expand/contract top edge)
- Widgets appear/disappear (expand/contract right edge)
- User resizes (all edges change based on drag direction)
- User drags (position changes, size stays)

#### 3. Drag System Overhaul

**Current**: Drag updates `bounds.x/y` and calls `updatePositions()` to move CSS positions within the fixed window.

**New**: Drag must move the BrowserWindow itself. Two options:

**Option A: IPC-based drag**
On each `mousemove` during drag, call `win.setBounds()` via IPC to reposition the window. This adds one IPC round-trip per mouse event during drag.

- Pro: Clean separation of concerns
- Con: IPC latency could cause visual lag/jitter during fast drags
- Con: The webview and all UI moves with the window, so no element repositioning needed, but the IPC call must be fast

**Option B: `win.setPosition()` via preload**
The preload already exposes `api.window.move(id, x, y)` which calls `window-move` IPC. This only sets position, not size, so it's lighter weight.

- Pro: Already exists in the preload API
- Con: Still one IPC call per mousemove

**Option C: Electron's built-in drag (`-webkit-app-region: drag`)**
Mark the navbar as a drag region. Electron handles native window dragging with zero IPC overhead.

- Pro: Smoothest possible drag (native, no JS overhead)
- Con: Cannot do hold-to-drag on transparent canvas (but we no longer have a transparent canvas)
- Con: Cannot do hold-to-drag from webview content
- Con: Less control over drag behavior (can't prevent drag from buttons easily — needs `-webkit-app-region: no-drag` on interactive elements)

**Recommendation**: Option A/B for full control, with the IPC call debounced/throttled. The existing `window-move` IPC handler already exists. For navbar drag specifically, Option C could be used as an optimization since it's the primary drag handle.

However, the webview hold-to-drag is important. Since the webview's long-press detection sends a signal via `console-message`, the host JS needs to move the window via IPC regardless. So we need Option A/B for that case anyway.

#### 4. Resize System Changes

**Current**: Resize updates CSS positions of elements within the fullscreen window.

**New**: Resize must call `win.setBounds()` via IPC on every `pointermove` to change the window size AND position (for nw/ne/sw directions where the origin moves).

This is the most performance-sensitive change. Resizing a transparent BrowserWindow on every mouse event will test Electron's limits. Key concerns:

- **Transparent window resize on macOS**: The Electron docs warn "setting `resizable` to `true` may make a transparent window stop working on some platforms." However, we would be calling `setBounds()` programmatically, not relying on the OS resize behavior. The window's `resizable` property could be `false` while we still call `setBounds()` from code.
- **Performance**: `setBounds()` on macOS triggers a synchronous window server operation. At 60Hz mouse events, that's 60 IPC calls + 60 native resize operations per second. This is likely to cause jitter.
- **Mitigation**: Use `requestAnimationFrame` throttling and batch position+size into a single `setBounds()` call.

#### 5. Navbar Show/Hide — Window Expansion

This is the trickiest part of the new architecture.

**Current**: Navbar appears/disappears within the fullscreen window. No window resize needed.

**New**: When the navbar becomes visible, the window must expand upward to accommodate it. When it hides, the window contracts.

**Implementation**:
```
On navbar show:
  1. Calculate new window top = current top - NAVBAR_HEIGHT - NAVBAR_GAP
  2. Calculate new window height = current height + NAVBAR_HEIGHT + NAVBAR_GAP
  3. Call win.setBounds() with new top/height
  4. Position navbar at (margin, 0) within window
  5. Position webview at (margin, NAVBAR_HEIGHT + NAVBAR_GAP)

On navbar hide:
  1. Calculate new window top = current top + NAVBAR_HEIGHT + NAVBAR_GAP
  2. Calculate new window height = current height - NAVBAR_HEIGHT - NAVBAR_GAP
  3. Call win.setBounds() with new top/height
  4. Position webview at (margin, 0) within window
```

**Concerns**:
- The `setBounds()` call is async (IPC). There will be a visual flash where the window resizes but elements haven't repositioned yet (or vice versa).
- Animating the navbar appearance (e.g., sliding down) while also animating the window expansion is complex — the window resize and CSS transition must be synchronized.
- If the user rapidly hovers in/out of the trigger zone, the window will resize rapidly, which could look janky.

#### 6. Trigger Zone Problem

**Current**: The trigger zone is a 50px-tall invisible div positioned above the navbar area. It's inside the fullscreen window, so it always receives hover events.

**New**: The trigger zone would need to be inside the window. But with a tight-fitting window, there's nowhere to put an "above the navbar" trigger zone when the navbar is hidden — the window's top edge IS the top of the webview.

**Solutions**:
- **Extend window upward by trigger zone height**: The window is always a bit taller than the webview to include the trigger zone. This means a small transparent strip above the webview at all times.
- **Use a separate invisible window**: A tiny transparent window just above the page for hover detection. Adds complexity but avoids the transparent strip.
- **Eliminate the trigger zone**: Only show the navbar via Cmd+L. Simpler but loses hover discoverability.
- **Top-edge detection**: Use `mousemove` on the webview area and detect when the cursor is within N pixels of the top edge. The trigger zone becomes a virtual area inside the webview's top margin. This is the simplest solution.

**Recommendation**: Extend the window upward by ~50px to include the trigger zone. This is a very small transparent area (50px * width) and much less problematic than a fullscreen transparent surface. Since the window is tight-fitting, this thin strip at the top is acceptable.

#### 7. Resize Handle Hit Targets

**Current**: 24x24 invisible divs at corners, positioned absolutely.

**New**: The resize handles need to extend slightly outside the webview bounds. The window must include small transparent margins at the edges for these handles.

Adding ~12px margin on each side gives the handles room. The total transparent area is just the thin border around the content — negligible compared to the current fullscreen approach.

With the handles inside the window, they work exactly as they do now. The only difference is that `pointermove` must also call `win.setBounds()` to resize the native window.

#### 8. Widget Container

**Current**: Positioned to the right of the webview on the transparent canvas (`x + width + 12, y`).

**New**: The window must expand rightward when widgets appear. `computeWindowBounds()` includes widget dimensions when widgets are visible.

This means `addWidget()` and `removeWidget()` must trigger a window resize. Same concerns as navbar show/hide (async resize, potential flash).

#### 9. Session Save/Restore

**Current**: `updateUrlParams()` writes bounds to the URL via `history.replaceState`. `extractCanvasBounds()` reads them during session save.

**New**: The session data needs to represent where the page appears on screen. Two options:

- **Keep URL params**: The page JS still maintains `screenBounds` and writes them to URL params. `extractCanvasBounds()` continues to work.
- **Use window bounds directly**: Since the window is now tight-fitting, `win.getBounds()` returns approximately the right bounds (minus margins/navbar). We could adjust for known margins.

**Recommendation**: Keep URL params for the webview-specific bounds. This is cleaner because the window bounds may include navbar/trigger zone/margins that shouldn't be part of the restored webview size. The existing `extractCanvasBounds()` and `updateUrlParams()` system works perfectly as-is.

### BrowserWindow Creation Changes (ipc.ts)

The `window-open` handler in ipc.ts currently:
1. Detects `useCanvas` for web pages
2. Creates a `transparent: true` BrowserWindow
3. Sizes it to fill the display (`win.setSize(sw, sh); win.setPosition(dx, dy)`)
4. Loads `peek://app/page/index.html?url=...&x=...&y=...&width=...&height=...`

**New behavior**:
1. Still detect `useCanvas` for web pages
2. Create a BrowserWindow with:
   - `transparent: true` (still needed for margins/resize handles)
   - `frame: false` (already the case)
   - `resizable: false` (we handle resize programmatically via `setBounds()`)
   - `hasShadow: false` (or carefully styled — see edge case below)
   - Size set to webview bounds + margins (NOT fullscreen)
   - Position set to webview screen position - margins
3. Load the same `peek://app/page/index.html` but bounds now represent window-relative positioning (or pass screen bounds and let page.js compute internal layout)

The key question: **do we pass screen coordinates or window-relative coordinates as URL params?**

**Recommendation**: Pass screen coordinates as today. The page.js knows it's in a tight window and computes internal positions from the screen coordinates + window position. Session restore continues to work unchanged.

## Edge Cases

### Screen edge — navbar can't expand upward

When the webview is positioned near the top of the screen (y < NAVBAR_HEIGHT + NAVBAR_GAP + trigger zone), there's no room to expand upward for the navbar.

**Solutions**:
- Show the navbar overlapping the top of the webview instead (push it inside)
- Show the navbar below the webview top edge (covering some content)
- Move the entire window downward to make room (changes the page position, which may be unexpected)
- Simply allow the window to extend above the screen bounds (macOS allows windows partially off-screen)

**Recommendation**: Allow the window to extend off-screen. macOS handles this gracefully. If the navbar is partially off-screen, the user can drag the page down. This matches how native macOS windows behave when toolbars are near the menu bar.

### Visual shadow/border around the webview

**Current**: The webview has `border-radius: 10px` and sits on a transparent background. There's no explicit shadow — the rounded corners provide visual separation.

**New**: With a tight window, the transparent margins give room for rounded corners. A drop shadow via CSS `box-shadow` on the webview would require slightly larger margins but is feasible.

If using `hasShadow: true` on the BrowserWindow, macOS adds a native shadow. This would apply to the entire window bounds (including transparent margins), which might look wrong. Better to use CSS `box-shadow` on the webview element with `hasShadow: false` on the window.

### Drag system interaction with preload.js

**Current**: `preload.js` has `data-no-drag` on the body, and page.js implements all drag logic via mousemove. The preload's built-in drag detection (`-webkit-app-region`) is not used.

**New**: No change to preload.js. The page.js drag logic changes from "update CSS positions" to "call win.setBounds() via IPC", but the event handling structure stays the same.

### Transparent window `setBounds()` reliability

Electron's documentation states: "On macOS, setting `resizable` to `true` may make a transparent window stop working."

This refers to the `resizable` window property (which enables native OS resize handles). We set `resizable: false` and call `setBounds()` programmatically. Testing confirms that `setBounds()` works on transparent windows regardless of the `resizable` property — it's the native resize grip that's problematic.

**Risk**: This needs to be verified empirically on the target Electron version. If `setBounds()` on transparent windows is unreliable, we would need to use a non-transparent window with a fully-transparent rendered background (e.g., `backgroundColor: '#00000000'` without `transparent: true`). Note: this may not work identically — `transparent: true` enables compositing through the window, while a transparent background color still has an opaque window layer on some platforms.

## Performance Concerns

### IPC overhead during drag/resize

Every mouse move during drag or resize requires an IPC call to the main process to update window bounds. At 60fps that's 60 IPC round-trips per second.

**Measurements needed**: Benchmark IPC latency for `setBounds()` on macOS. If it's <2ms per call, 60fps is achievable. If it's >5ms, we need throttling.

**Mitigations**:
1. Throttle `setBounds()` calls to every 16ms (60fps) using `requestAnimationFrame`
2. Batch position and size into one `setBounds()` call (already the case)
3. Use `win.setPosition()` for drag-only operations (lighter than `setBounds()`)
4. Consider the experimental `offscreen` BrowserWindow option (not applicable here)

### Navbar show/hide flicker

The sequence "resize window -> reposition elements" has a frame where the old layout is visible in the new window size. This could appear as a brief flash of transparent area.

**Mitigations**:
1. Update element positions BEFORE calling `setBounds()` — position the navbar at its target location within the current window bounds, even if it's momentarily off-screen or clipped. Then resize the window to reveal it. Since the window is transparent at the margins, the navbar would be invisible until the window expands to include it.
2. Use a CSS transition on the navbar (slide-in from top) that's timed to match the window resize.
3. Accept a small visual imperfection — the navbar appearing is a quick operation and most users won't notice a single-frame flash.

## Implementation Plan

### Phase 1: Proof of Concept (Minimal Changes)

**Goal**: Validate that `setBounds()` on a transparent window works reliably and performs acceptably on macOS.

1. Create a test branch with a stripped-down page.js
2. Change ipc.ts to create a tight-fitting window instead of fullscreen
3. Modify page.js:
   - Position elements at window-relative coordinates (webview at margin, margin)
   - Replace drag logic with `api.window.move()` calls
   - Keep resize disabled initially (fixed size)
4. Test: drag performance, visual quality, click-through (should work naturally)

**Key validation**: Does moving a transparent BrowserWindow via IPC during mousemove feel smooth? This is the make-or-break test.

### Phase 2: Full Drag and Resize

1. Implement `computeWindowBounds()` that calculates tight bounds
2. Add `api.window.setBounds()` to preload.js (bridge to `window-set-bounds` IPC)
3. Modify drag logic: `mousemove` -> compute new screen position -> `setBounds()`
4. Modify resize logic: `pointermove` -> compute new screen bounds -> `setBounds()`
5. Throttle all `setBounds()` calls to 60fps via `requestAnimationFrame`
6. Test: resize from all four corners, drag smoothness, edge cases

### Phase 3: Navbar and Widget Dynamics

1. Implement window expansion/contraction for navbar show/hide
2. Add trigger zone (extend window top by 50px permanently)
3. Implement window expansion for widget container
4. Synchronize CSS transitions with window resize
5. Test: hover trigger, Cmd+L, widget appear/dismiss, rapid show/hide

### Phase 4: Session Integration

1. Verify `updateUrlParams()` still works (should — we keep screen coordinates)
2. Verify `extractCanvasBounds()` still extracts correct bounds
3. Test full save/restore cycle: open page, move/resize, quit, restore
4. Verify restored window position matches original

### Phase 5: Cleanup

1. Remove `initClickThrough()` and all `setIgnoreMouseEvents` usage from page.js
2. Remove or simplify the `isOverContent()` function
3. Update `window-open` handler for new window sizing logic
4. Potentially remove `window-set-ignore-mouse-events` IPC handler if no longer needed elsewhere

## Alternative: Hybrid Approach

Instead of fully committing to the minimal window, consider a **hybrid** that captures 90% of the benefit with less risk:

1. Keep the fullscreen transparent window
2. Remove `setIgnoreMouseEvents` entirely (Phase 1 from click-through research)
3. Transparent areas absorb clicks (do nothing) rather than passing through

This is zero-risk and immediately shippable. The only downside is that the transparent area is "dead space" that absorbs clicks — but this is actually reasonable UX for a canvas app. Users can Cmd+Tab or click the Dock to switch apps.

**The minimal window approach is architecturally cleaner** (no dead space problem at all), but introduces IPC-driven window management complexity and potential performance regressions. The hybrid approach is a pragmatic intermediate step.

## Recommendation

1. **Ship the hybrid approach immediately** (remove `setIgnoreMouseEvents`, absorb clicks on transparent areas). This fixes the user-facing bug with zero risk.

2. **Prototype the minimal window approach on a branch** as Phase 1 above. The critical unknown is `setBounds()` performance during drag. If it passes the smoothness test, proceed with full implementation.

3. **If the prototype is smooth**, migrate to the minimal window approach for the clean architecture benefits: no dead space, no fullscreen transparent window, natural click-through, standard window behavior.

4. **If the prototype is janky**, stay with the hybrid approach and explore native macOS APIs (NSWindow manipulation via native addon) as a future optimization.

## Files That Would Change

| File | Change Type | Description |
|------|-------------|-------------|
| `app/page/page.js` | Major rewrite | Coordinate system, drag, resize, navbar dynamics |
| `app/page/index.html` | Moderate | CSS for window-relative positioning, trigger zone |
| `backend/electron/ipc.ts` | Moderate | Window creation sizing (lines 2165-2175), potentially new IPC for batch bounds updates |
| `backend/electron/session.ts` | Minimal | `extractCanvasBounds` may need adjustment if URL params change meaning |
| `preload.js` | Minor | Add `setBounds()` bridge method |

## Open Questions

1. **Does `win.setBounds()` on a `transparent: true` BrowserWindow work reliably on macOS?** The docs warn about `resizable: true` but are silent about programmatic `setBounds()`. Needs empirical testing.

2. **What is the IPC latency for `setBounds()` on macOS?** If >5ms per call, 60fps drag/resize is not achievable without native-level optimization.

3. **Does the trigger zone need to be always-present?** If we can detect "cursor near top of webview" via mousemove on the webview itself, we avoid needing any transparent area above the webview. But webview mouse events don't propagate to the host — we'd need another `console-message` bridge from injected JS.

4. **Should we keep `transparent: true` or use `backgroundColor: '#00000000'`?** Different rendering paths with different tradeoffs. `transparent: true` enables true compositing through the window; transparent background color may render differently.

5. **Multi-display**: When a user drags the page to a different display, the current code doesn't handle display transitions. With a tight window this "just works" (the window moves between displays naturally). But we should verify behavior at display boundaries.
