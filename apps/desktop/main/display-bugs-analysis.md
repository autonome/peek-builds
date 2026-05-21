# Display/Monitor Handling Bug Analysis

**Date:** 2026-02-16
**Symptoms reported:**
1. Plugging/unplugging/replugging external monitor: all other apps correctly move windows, but Peek windows stay on the wrong screen.
2. Super glitchy behavior when dragging windows between two screens.

---

## Bug 1: macOS Display IDs Are NOT Stable Across Unplug/Replug Cycles

**Files:** `/Users/dietrich/misc/mpeek/apps/desktop/main/display-watcher.ts` lines 373-403
**Severity:** HIGH -- This is likely the primary cause of symptom #1.

### Root Cause

The Phase 2 restore logic in `findMatchingNewDisplay()` tries to match a re-added display by `display.id` first (line 378), then falls back to resolution matching within 5% tolerance (lines 382-401).

On macOS (especially Apple Silicon), `CGDirectDisplayID` is **not stable** across unplug/replug cycles. Apple's own documentation and the BetterDisplay project confirm that the display ID is a transient identifier related to the connection's location in the IO registry. If you unplug and replug the same cable, the display **may** get a different ID.

This means:
- Phase 2 ID matching (`addedDisplays.find(d => d.id === home.displayId)`) will often **fail** for the same physical monitor.
- The resolution fallback at 5% tolerance may work for identical resolution re-plugs but will fail if the display negotiates a slightly different mode or if two displays have similar resolutions.

### Why Other Apps Work

Native macOS apps use `NSWindow`, which has built-in screen affinity managed by the window server. When a display disconnects, macOS remembers which windows were on it (using stable display UUIDs, not `CGDirectDisplayID`). When the display reconnects, macOS moves those windows back automatically. Peek's `display-watcher.ts` is fighting this native behavior by implementing its own three-phase algorithm that relies on the unstable `CGDirectDisplayID`.

### Recommended Fix

**Option A (Preferred -- Less Code):** Remove the custom display-change repositioning entirely for the unplug/replug case. macOS already handles window migration correctly for normal `NSWindow`s. The problem is that Peek's `display-watcher` is **overriding** macOS's native behavior. If the display-watcher is doing more harm than good for the standard case, disable Phase 1b and Phase 2 and let macOS handle it natively.

**Option B:** Use display UUIDs instead of display IDs. Electron exposes `display.id` which maps to `CGDirectDisplayID`. To get stable identification, use `CGDisplayCreateUUIDFromDisplayID()` via native module or match on a combination of display serial number + vendor ID + model (if Electron exposes these through `Display` object properties).

**Option C:** Make the resolution fallback smarter -- instead of 5% tolerance on resolution alone, also factor in display physical arrangement position (which side of the primary display is it on). This would reduce false matches between two similar-resolution displays.

---

## Bug 2: Popup Windows and Background-Window Children Are NOT Tracked by Display Watcher

**Files:**
- `/Users/dietrich/misc/mpeek/apps/desktop/main/ipc.ts` lines 2604-2617 (popup window creation -- NO `trackWindow()` call)
- `/Users/dietrich/misc/mpeek/apps/desktop/main/main.ts` lines 985-1064 (background window child creation -- NO `trackWindow()` call)
**Severity:** HIGH

### Root Cause

`trackWindow()` is only called in one place: the `window-open` IPC handler at `ipc.ts` line 2206. Two other window creation paths never call it:

1. **Popup windows** created from webview `window.open()` (ipc.ts line 2604): `popupWin = new BrowserWindow(...)` is created but `trackWindow(popupWin)` is never called.

2. **Background window children** created via `setWindowOpenHandler` in `main.ts` (line 985-1064): Windows created through `createBackgroundWindow()` are registered in the window registry but never passed to `trackWindow()`.

This means these windows:
- Have no entries in `_trackedPositions`
- Cannot be saved in Phase 1 (their tracked position is `undefined`, so they fall through to `preDebBounds` or `currentBounds`, both of which are post-macOS-relocation)
- Will not be properly repositioned on display changes

### Recommended Fix

Add `trackWindow(win)` calls after window creation in both paths:
- `ipc.ts` after line 2639 (popup window): add `trackWindow(popupWin);`
- `main.ts` inside the `did-finish-load` callback around line 1047: add `trackWindow(newWin);` (requires importing `trackWindow` from `display-watcher.js`)

---

## Bug 3: Phase 1b Redistribution Fights macOS Native Window Migration

**File:** `/Users/dietrich/misc/mpeek/apps/desktop/main/display-watcher.ts` lines 574-598
**Severity:** HIGH -- This is likely the second major contributor to symptom #1.

### Root Cause

When a display is removed:
1. macOS **immediately** moves windows from the disconnected display to the remaining display(s). This happens BEFORE Electron's `display-removed` event fires.
2. The display-watcher's Phase 1b then **also** tries to redistribute these windows, using the tracked pre-disconnection positions.
3. Phase 1b calls `repositionWindowGroup()` which calls `win.setBounds()` to move windows to calculated positions on the remaining display.

The result is a **double move**: macOS moves the window first, then Phase 1b moves it again (to a potentially different position). This overrides macOS's placement and can put windows in unexpected positions.

Then when the display is re-added:
4. Phase 2 tries to restore windows to their "home display" but fails because display IDs changed (Bug 1).
5. Windows remain where Phase 1b put them, which may not be where the user expects.

### Why Other Apps Work

Other apps don't have a Phase 1b. They let macOS handle the migration when a display disconnects. When the display reconnects, macOS moves the windows back (using its own stable display UUID tracking). Peek's Phase 1b breaks this by moving windows to custom-calculated positions that macOS doesn't know about.

### Recommended Fix

Remove Phase 1b entirely, or make it opt-in only for cases where macOS's native migration clearly fails (e.g., windows ending up completely off-screen). The `isWindowAccessible()` check in Phase 3 already handles the "window is off-screen" case.

---

## Bug 4: Custom Drag via `setBounds()` IPC Causes Cross-Monitor Glitchiness

**Files:**
- `/Users/dietrich/misc/mpeek/app/page/page.js` lines 246-252, 610-628
- `/Users/dietrich/misc/mpeek/apps/desktop/main/ipc.ts` lines 3194-3205
- `/Users/dietrich/misc/mpeek/apps/desktop/main/display-watcher.ts` lines 840-865
**Severity:** HIGH -- This is the primary cause of symptom #2 (drag glitchiness).

### Root Cause

Peek's page canvas uses a custom drag implementation that calls `setBounds()` via IPC on every `mousemove` event (throttled to ~60fps via `requestAnimationFrame`). This has multiple problems when dragging across monitors:

**Problem A: `setBounds()` is async IPC, causing drag lag.** The drag handler in `page.js` (line 620-627) calculates the new window position from `screenX/screenY` deltas and calls `setWindowBounds()`, which does `requestAnimationFrame` -> `api.window.setBounds()` -> IPC to main process -> `win.setBounds()`. This round-trip takes time, during which the mouse has already moved further, creating a rubber-banding/lag effect. This is inherently worse than native `NSWindow` dragging which happens at the window server level with zero IPC overhead.

**Problem B: Transparent frameless windows have known Electron bugs when dragged across monitors.** Electron issue #23215 documents that frameless transparent windows dragged across screen boundaries produce visual artifacts (transparent areas turn black). Electron issue #31058 documents that cross-monitor drag behavior is inconsistent with no semi-transparency preview. These are known Electron limitations with transparent windows.

**Problem C: `win.on('moved', updateTracking)` in display-watcher fires during drag.** Each `setBounds()` call triggers the `moved` event listener (display-watcher.ts line 857), which calls `updateTracking()`, which does `findDisplayForPoint()` using `_previousDisplays`. During a cross-monitor drag, the window is momentarily "between" displays. If `findDisplayForPoint()` returns `null` (the window center is in the gap between displays or outside any display), the tracked position is NOT updated. When `findDisplayForPoint()` finds a display, it updates `_trackedPositions` to point to the new display. This rapid switching of the tracked display during drag is not harmful per se, but creates unnecessary computation during what should be a smooth drag operation.

**Problem D: Pointer coordinate system mismatch across monitors with different scale factors.** If the two monitors have different DPI/scale factors, `screenX`/`screenY` in the renderer may not map linearly to the physical pixel grid across the monitor boundary. The `setBounds()` call uses logical coordinates, but Electron's coordinate handling across monitors with different scale factors has been inconsistent.

### Recommended Fix

**Short-term:** Use Electron's native `-webkit-app-region: drag` for the navbar instead of custom `setBounds()` dragging. Native drag uses the window server directly and handles cross-monitor transitions correctly. The hold-to-drag-from-webview feature would still need the custom bridge, but at least navbar drags would be smooth.

**Long-term:** Investigate whether the canvas model (transparent frameless window + custom drag/resize) can be replaced with a more standard window model that uses native window chrome, at least for the drag operation. The canvas model was chosen for visual reasons (borderless content display), but it comes with significant cross-monitor drag penalties.

---

## Bug 5: `isWindowAccessible()` Check Is Too Lenient for Canvas Windows

**File:** `/Users/dietrich/misc/mpeek/apps/desktop/main/display-watcher.ts` lines 155-158
**Severity:** MEDIUM

### Root Cause

`isWindowAccessible()` checks if the window's center-top (title bar area, y + 15px) is on a display. For canvas/transparent windows that are frameless with no OS title bar, checking y + 15 is checking an arbitrary point near the top of the transparent window. Since the actual content (webview) is offset by margins and trigger zone, the "accessible" check might pass even when the visible content is partially off-screen.

More importantly, when Phase 3 runs, accessible windows on unchanged displays are **skipped entirely** (lines 695-710). This means if a window was on a display that changed position (e.g., macOS rearranged displays after plug/unplug), but the window's center-top still falls on a valid display, it won't be repositioned. This could leave windows stranded at coordinates that are technically "on a display" but visually wrong.

### Recommended Fix

For the display-change use case, `isWindowAccessible()` should also verify that a meaningful portion (e.g., 30%+) of the window area overlaps with a display, not just a single point.

---

## Bug 6: 500ms Debounce May Miss the Window for Pre-Debounce Capture

**File:** `/Users/dietrich/misc/mpeek/apps/desktop/main/display-watcher.ts` lines 776-797
**Severity:** MEDIUM

### Root Cause

The `onDisplayChange()` function captures pre-debounce window bounds on the FIRST `display-removed` event (line 780-786). However, macOS fires multiple events rapidly during a display change. The pre-debounce capture happens immediately on the first event, which is correct in theory. But the comment at line 71 acknowledges that macOS relocates windows BEFORE the `display-removed` event fires, making the pre-debounce capture "already too late."

The code works around this with `_trackedPositions` (continuously updated on `win.on('moved')`), which is the correct approach. But the pre-debounce capture path is still used as a fallback (line 538: `const bounds = tracked?.bounds ?? preDebBounds ?? currentBounds`). If a window is not tracked (Bug 2), it falls back to `preDebBounds`, which are already post-macOS-relocation and therefore **wrong**.

### Recommended Fix

This is largely mitigated by fixing Bug 2 (ensuring all windows are tracked). The pre-debounce capture path can be kept as a defense-in-depth fallback but should not be relied upon.

---

## Bug 7: `display-metrics-changed` Does Not Pass `isRemoval=true`

**File:** `/Users/dietrich/misc/mpeek/apps/desktop/main/display-watcher.ts` lines 823-831
**Severity:** LOW

### Root Cause

The `display-metrics-changed` handler calls `onDisplayChange()` without `isRemoval=true` (line 829). This means if macOS fires a metrics-changed event instead of (or in addition to) a display-removed event, no pre-debounce window bounds capture will occur. In practice, macOS usually fires `display-removed` for actual disconnections, so this is unlikely to cause real issues. But it's a gap in the defensive coding.

### Recommended Fix

Check if `changedMetrics` includes `'bounds'` and `screen.getAllDisplays().length < _previousDisplays.length` to detect a "virtual removal" and pass `isRemoval=true`.

---

## Priority Ordering

1. **Bug 1 + Bug 3** (HIGH): macOS display IDs unstable + Phase 1b fighting macOS. These together are the root cause of symptom #1 (windows staying on wrong screen after plug/unplug). The simplest fix is to remove Phase 1b and Phase 2 entirely and let macOS handle window migration natively, since macOS already does this correctly for all other apps.

2. **Bug 4** (HIGH): Custom `setBounds()` drag is the root cause of symptom #2 (glitchy cross-monitor drag). Fix by using native drag for the navbar.

3. **Bug 2** (HIGH): Missing `trackWindow()` calls for popup and background-created windows. Easy fix -- just add the calls.

4. **Bug 5** (MEDIUM): `isWindowAccessible()` too lenient for transparent/canvas windows.

5. **Bug 6** (MEDIUM): Pre-debounce capture fallback is unreliable. Mitigated by fixing Bug 2.

6. **Bug 7** (LOW): `display-metrics-changed` doesn't capture pre-debounce bounds.

---

## Key Insight: The Display Watcher May Be Doing More Harm Than Good

The fundamental architectural issue is that Peek's `display-watcher.ts` implements a complex three-phase algorithm to handle something that macOS already handles natively for NSWindows. Electron's `BrowserWindow` is an NSWindow under the hood. When other apps "just work" with monitor plug/unplug, it's because they let macOS's window server handle the migration using stable display UUIDs.

Peek's display-watcher overrides this native behavior with its own algorithm that:
- Uses unstable `CGDirectDisplayID` for display matching (fails on Apple Silicon)
- Moves windows during Phase 1b (overriding macOS's native migration)
- Calls `win.setBounds()` which may interfere with macOS's own window placement
- Adds complexity (debouncing, pre-debounce capture, suppress mechanism) to work around timing issues that wouldn't exist if the native behavior were used

**Recommendation:** Consider making the display-watcher a safety net rather than the primary mechanism. Let macOS handle the standard plug/unplug case natively. Only intervene (Phase 3 style) when a window is truly inaccessible (completely off-screen with no display under its title bar). This would fix both symptom #1 and simplify the codebase significantly.

---

## References

- [Apple CGDirectDisplayID documentation](https://developer.apple.com/documentation/coregraphics/cgdirectdisplayid)
- [BetterDisplay discussion on display ID instability](https://github.com/waydabber/BetterDisplay/discussions/3628)
- [MonitorControl issue on CGDirectDisplayID vs serial number](https://github.com/MonitorControl/MonitorControl/issues/961)
- [Nonstrict blog: Display reconfigurations on macOS](https://nonstrict.eu/blog/2023/display-reconfigurations-on-macos/)
- [Electron #23215: Transparent window drag artifacts](https://github.com/electron/electron/issues/23215)
- [Electron #31058: Cross-monitor drag inconsistency](https://github.com/electron/electron/issues/31058)
- [Electron #46352: Transparent window flickering/ghosting](https://github.com/electron/electron/issues/46352)
