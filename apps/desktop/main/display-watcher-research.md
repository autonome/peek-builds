# Display Watcher Research: Primary/Main Display Handling on macOS

Research for improving Peek's display-watcher to handle the "windows stay on laptop when external display is plugged in" problem.

---

## 1. macOS Display Concepts: "Primary" vs "Main"

macOS has **two distinct concepts** that are often confused:

### Primary Display (NSScreen.screens[0])
- The display at coordinate origin (0,0) in the global display coordinate space.
- This is the display that has the **menu bar** and **Dock** (by default).
- The user sets this in **System Settings > Displays > Arrangement** by dragging the white menu bar indicator to a display.
- The primary display does **NOT change automatically** when you plug in an external monitor. It stays wherever the user last set it.
- `NSScreen.screens[0]` always returns this display.
- In Electron: `screen.getPrimaryDisplay()` returns this display.

### Main Display (NSScreen.main)
- The display that contains the **currently focused window** (the key window).
- This changes dynamically as the user clicks on windows on different displays.
- There is **no Electron API** that directly exposes `NSScreen.main`. Electron only exposes `getPrimaryDisplay()` which maps to the menu-bar display.

### Key Insight
**Plugging in an external monitor does NOT change the primary display.** The laptop screen remains primary (has menu bar at 0,0) unless the user manually drags the white bar in System Settings > Displays. This means `screen.getPrimaryDisplay()` returns the laptop screen both before and after connecting an external monitor.

### What DOES change when you plug in a monitor:
- A `display-added` event fires in Electron.
- The coordinate space may shift (the new display gets positioned relative to the primary).
- The `bounds` and `workArea` of existing displays may change (e.g., if the arrangement shifts).
- `display-metrics-changed` events fire for affected displays.

---

## 2. Why Do Other Apps Move Windows to the External Display?

**Short answer: They mostly don't. macOS doesn't do this automatically either.**

### What actually happens:
1. **macOS does NOT auto-move windows to newly connected displays.** When you plug in an external monitor, all existing windows stay where they are.
2. **Window restore from sleep/wake**: When a MacBook is in clamshell mode (lid closed with external display), all windows are on the external. When you unplug and reopen, macOS moves them to the laptop screen. When you re-plug, macOS remembers and restores them to the external. This is **macOS window server behavior**, not individual app behavior.
3. **Some apps remember per-display positions**: Apps like Safari, Xcode, and Terminal remember which display their windows were last on and restore to that display when it reappears. This is standard `NSWindow` state restoration (`restorable` property + `NSWindowRestoration` protocol).
4. **The perception that "other apps move to the big screen"** likely comes from:
   - Clamshell mode wake/sleep cycling (macOS handles this at the window server level)
   - Apps that were previously used on that external display and have state restoration
   - The user manually having moved windows there in a previous session

### What macOS DOES do automatically:
- **Clamshell mode**: When MacBook lid closes with external display connected, all windows move to external. When external disconnects, they move to laptop screen. When external reconnects with lid closed, they move back. This is window server behavior.
- **Display removal**: Windows on a removed display get relocated to the nearest remaining display (shoved into top-left typically).
- **"Displays have separate Spaces"** (System Settings > Desktop & Dock): When enabled, each display has its own Space, and macOS manages window-to-Space assignment.

---

## 3. Electron Events When External Display is Plugged In

When an external display is connected, Electron fires these events (in approximate order):

1. **`display-added`** - with the new Display object
   - `display.id` - unique numeric ID
   - `display.bounds` - position in global coordinate space
   - `display.workArea` - usable area excluding dock/menu bar
   - `display.internal` - `false` for external displays, `true` for built-in
   - `display.label` - e.g., "LG UltraFine" (human-readable name)

2. **`display-metrics-changed`** - may fire for EXISTING displays
   - The laptop display's `workArea` might change (e.g., if arrangement shifts coordinate space)
   - `changedMetrics` array tells you what changed: `"bounds"`, `"workArea"`, `"scaleFactor"`, `"rotation"`

3. Multiple events may fire in rapid succession (hence the existing 500ms debounce).

### The `internal` property (key for our use case)
Electron's Display object has an `internal: boolean` property:
- `true` = built-in laptop display
- `false` = external display

This is **the critical signal** for detecting "user plugged in an external monitor" vs "display configuration changed for other reasons."

### What `getPrimaryDisplay()` returns:
- Before plugging in external: laptop display (assuming user hasn't changed primary)
- After plugging in external: **still the laptop display** (unchanged)
- Only changes if user manually sets a different primary in System Settings

---

## 4. System Settings > Displays > Arrangement

### The white menu bar indicator:
- Dragging it to a display makes that display the **primary display** (coordinate origin 0,0, gets the menu bar).
- This is a **manual user action**, not automatic.
- When changed, Electron fires `display-metrics-changed` for both the old and new primary displays (bounds change because coordinate origin moves).

### Display arrangement:
- Users can drag display thumbnails to set relative positioning (left/right/above/below).
- This affects the global coordinate space — display `bounds.x` and `bounds.y` reflect arrangement.
- New displays are initially placed to the right of existing displays by default.

### "Mirror Displays":
- When enabled, both displays show the same content.
- Electron sees this as a single display (the mirrored display disappears from `getAllDisplays()`).

---

## 5. How Other Electron Apps Handle This

### VS Code
- Does NOT auto-move windows to external displays on connect.
- Restores window positions from saved state on launch.
- Uses `screen.getDisplayMatching(bounds)` to validate saved positions.
- If a window's saved position is off-screen, it resets to a default position on the primary display.

### Slack, Discord
- Do NOT auto-move windows when displays change.
- Standard Electron behavior: windows stay where they are.

### General Electron ecosystem
- No mainstream Electron app automatically moves windows to a newly connected external display.
- The standard approach is: save window positions, restore on relaunch, reposition if off-screen.

---

## 6. Concrete Recommendations for Peek

### The Core Question
Should Peek move windows to a newly connected external display even when they weren't previously on that display?

**Recommendation: No, not by default.** This would be surprising behavior that no other app does. BUT there are several things Peek should do:

### Recommendation A: Improve Phase 2 Restore (already exists, verify it works)
The current Phase 2 already handles restoring displaced windows to a re-appearing display. This covers the most common real scenario:
1. User has windows on external display
2. User unplugs external (Phase 1 saves home, Phase 1b redistributes to laptop)
3. User re-plugs external (Phase 2 restores to external)

**Action**: Verify Phase 2 works reliably with the `internal` property as an additional matching signal. Currently matches by display ID then resolution. Could also match by `internal === false` when there was exactly one external display before.

### Recommendation B: Detect "primary display changed" scenario
When `display-metrics-changed` fires and the primary display ID changes (compare `screen.getPrimaryDisplay().id` against saved primary ID), this means the user manually changed their primary display in System Settings. In this case:
1. The menu bar and Dock have moved.
2. The user likely wants their "main" workspace on the new primary.
3. Consider offering to move windows, or at minimum re-run Phase 3 repositioning.

**Action**: Track `_previousPrimaryDisplayId` and detect when it changes.

### Recommendation C: Add a "Move to Display" command
Rather than auto-moving, give the user explicit control:
- Command palette action: "Move all windows to [display name]"
- Could use the `display.label` property for a human-readable display picker.
- This respects user intent while solving the "I want my windows on the big screen" problem.

### Recommendation D: Use `display.internal` for smarter defaults
When a new external display is added and there are windows on the internal display, Peek could:
- **Option 1 (Conservative)**: Do nothing extra beyond current Phase 2 restore. This is the safest.
- **Option 2 (Moderate)**: If the external display is significantly larger than the internal display (e.g., >1.5x work area), and there are displaced windows from a previous session, be more aggressive about matching them to the new external display.
- **Option 3 (Aggressive)**: Auto-move all windows to the largest external display. This matches the user's stated desire but is non-standard behavior.

**Recommended: Option 1 + Recommendation C.** Don't auto-move, but make it easy to move manually.

### Recommendation E: Handle the clamshell mode scenario
When the laptop display disappears (`internal: true` display removed) and an external display exists, all windows should already be on the external. When the laptop display reappears (lid opened), don't move windows off the external display back to the laptop. The current Phase 3 may inadvertently do this if it sees windows as being on a "changed" display.

**Action**: When a display is added and it's `internal: true`, be careful not to pull windows back to it from external displays where they're happily sitting.

### Recommendation F: Track and persist display topology
Save the last-known display configuration (display IDs, labels, internal/external, arrangement) to disk. On app launch, compare saved topology to current topology. If they match, restore windows to saved positions. If different (e.g., external display now present that wasn't before), use current Phase 2/3 logic.

This enables the scenario: User always docks at work with the same external monitor. Peek remembers "when this monitor is connected, windows go here."

---

## Summary of Key Technical Facts

| Question | Answer |
|----------|--------|
| Does primary display change on plug-in? | **No.** Only changes via manual System Settings action. |
| Does macOS auto-move windows to new display? | **No.** Only in clamshell wake/sleep scenarios. |
| What Electron events fire? | `display-added`, then `display-metrics-changed` for existing displays |
| Can we detect internal vs external? | **Yes.** `display.internal` property. |
| Can we get display name? | **Yes.** `display.label` property (e.g., "LG UltraFine"). |
| Do other Electron apps auto-move? | **No.** None do this. |
| Best approach for Peek? | Improve restore logic + add explicit "Move to Display" command. |

---

## Implementation Priority

1. **Verify Phase 2 restore works end-to-end** (unplug external, re-plug — windows should return). This is the highest-value fix because it covers the most common real-world scenario.
2. **Add `display.internal` to matching logic** in `findMatchingNewDisplay()` for better display identification.
3. **Add "Move all windows to [display]" command** to command palette.
4. **Track primary display ID changes** for the rare case where the user changes it manually.
5. **Persist display topology** for cross-session position memory (longer term).
