# IZUI (Invocable Zoom User Interface)

IZUI is a state machine that manages how Peek windows behave based on how they were invoked. It ensures consistent UX whether the user invokes Peek from within the app or from another application.

## Core Concept

The key question IZUI answers: **Was the app focused when the user invoked a command?**

- **Active mode**: User was working in Peek when they opened a window
- **Transient mode**: User invoked Peek from another app (e.g., global hotkey)

This distinction affects:
1. What mode the cmd bar displays
2. How ESC key behaves
3. Whether hidden windows are restored when overlays close

## States

| State | Description | Mode Display | ESC Behavior |
|-------|-------------|--------------|--------------|
| `idle` | No visible windows, app in background | N/A | N/A |
| `transient` | Invoked via global hotkey while unfocused | Always "default" | Close immediately, return to previous app |
| `active` | User working within focused Peek windows | Target window's mode | Internal navigation only, never closes |
| `overlay` | Full-screen overlay (e.g., windows picker) | Inherit from previous | Always close, restore hidden windows (if active) |

## Session Tracking

IZUI uses sessions to track state across multiple windows opened in a single interaction.

```
User in Safari → Global hotkey → Cmd opens (transient session starts)
                              → User runs "windows" command
                              → Windows overlay opens (inherits transient)
                              → User hits ESC
                              → Everything closes, back to Safari
```

Key behaviors:
- **Session persists** until all windows in the interaction are closed
- **Child windows inherit** transient state from their parent session
- **KeepLive windows** re-evaluate transient state each time they're shown

## Implementation

### State Coordinator

The `IzuiStateCoordinator` class (`apps/desktop/main/izui-state.ts`) is the central manager:

```typescript
class IzuiStateCoordinator {
  // Query current state
  isTransient(): boolean;
  getState(): IzuiState;
  isOverlay(): boolean;

  // Evaluate focus state (excludes requesting window)
  evaluateOnShow(excludeWindowId?: number): 'active' | 'transient';

  // Session lifecycle
  startSession(entryMode: 'active' | 'transient'): void;
  endSession(): void;

  // Window stack (auto-ends session when empty)
  pushWindow(windowId: number): void;
  popWindow(windowId: number): void;

  // Overlay mode
  enterOverlay(windowId: number, hiddenIds: number[]): void;
  exitOverlay(): void;

  // Focus tracking cleanup
  setFocusedWindow(windowId: number): void;
  clearFocusedWindow(windowId: number): void;
}
```

### Focus Detection

Transient detection uses `BrowserWindow.isFocused()` (not `getFocusedWindow()`) to check actual system focus:

```typescript
evaluateOnShow(excludeWindowId?: number): 'active' | 'transient' {
  const allWindows = BrowserWindow.getAllWindows();
  const focusedWindow = allWindows.find(win =>
    !win.isDestroyed() &&
    win.isFocused() &&
    win.id !== excludeWindowId  // Exclude the window asking the question
  );
  return focusedWindow ? 'active' : 'transient';
}
```

**Why exclude the requesting window?** When the cmd panel asks "am I transient?", it already has focus. We need to check if any *other* window had focus before cmd opened.

### Transient Propagation

Opening a window updates the session's own transient/active state, but stamps nothing onto
the window itself:

```typescript
// In window-open IPC handler
coordinator.evaluateOnShow();
```

There is no per-window transient flag: a window's real transience is its `role`, checked
against `window-kernel.ts TRANSIENT_ROLES`. The session-level state is what "windows opened
FROM a transient session are also transient" refers to.

### Overlay Close Behavior

When an overlay closes, it only restores hidden windows if the session is NOT in transient
mode, read straight off the coordinator rather than off the window:

```typescript
// In window 'closed' handler
const isTransient = coordinator.isTransient();
if (hiddenWindowIds && hiddenWindowIds.length > 0 && !isTransient) {
  // Active mode: restore hidden windows
  for (const id of hiddenWindowIds) {
    BrowserWindow.fromId(id)?.show();
  }
}
// Transient mode: don't restore, just close and return to previous app
```

## Renderer API

Extensions can query IZUI state via the preload API:

```javascript
// Check if current session is transient
const isTransient = await api.izui.isTransient();

// Get the effective mode ('default' for transient, 'active' otherwise)
const effectiveMode = await api.izui.getEffectiveMode();

// Get current IZUI state ('idle', 'transient', 'active', 'overlay')
const state = await api.izui.getState();
```

### Usage in Cmd Panel

The cmd panel uses `api.izui.isTransient()` to determine what mode to display:

```javascript
const loadCommandContext = async () => {
  const isTransient = await api.izui.isTransient();
  if (isTransient) {
    // Don't show target window's mode, show "default"
    currentMode = 'default';
    updateModeIndicator();
    return;
  }
  // Active mode: show target window's actual mode
  // ...
};
```

## ESC Key Handling

ESC behavior is determined by `escapeMode` parameter and transient state:

| escapeMode | Transient | Behavior |
|------------|-----------|----------|
| `auto` | Yes | Close immediately |
| `auto` | No | Ask renderer to handle (internal nav), never close |
| `close` | Any | Always close |
| `navigate` | Any | Ask renderer first, close if not handled |
| `ignore` | Any | Do nothing |

See `apps/desktop/main/windows.ts` `addEscHandler()` for implementation.

## Testing

The IZUI state coordinator has comprehensive unit tests in `apps/desktop/main/izui-state.test.ts`:

```bash
# Run IZUI tests
yarn build && node --test dist/apps/desktop/main/izui-state.test.js
```

Tests cover:
- Transient detection with various focus states
- Session lifecycle and persistence
- Window exclusion in focus checks
- Overlay mode and window restoration
- Complex multi-window workflows
- ESC policy for all role/session-state combinations
- Regression: child-content windows not closing in active sessions

## Files

| File | Purpose |
|------|---------|
| `apps/desktop/main/izui-state.ts` | State coordinator singleton |
| `apps/desktop/main/izui-state.test.ts` | Unit tests (54 test cases) |
| `apps/desktop/main/ipc.ts` | IZUI IPC handlers, transient propagation |
| `apps/desktop/main/main.ts` | Window lifecycle hooks, overlay close |
| `apps/desktop/main/windows.ts` | ESC handler with IZUI integration |
| `preload.js` | `api.izui.*` namespace for renderers |
| `extensions/cmd/panel.js` | Mode display based on transient state |

## Common Scenarios

### Scenario 1: Transient Cmd Invocation
1. User is in Safari
2. Presses global hotkey to open cmd
3. Cmd opens, session starts as `transient`
4. Cmd shows "default" mode (not target window's mode)
5. User types command and presses Enter
6. User presses ESC
7. Everything closes, focus returns to Safari

### Scenario 2: Active Cmd Invocation
1. User is working in Peek (Groups window focused)
2. Presses Cmd+K to open cmd
3. Cmd opens, session starts as `active`
4. Cmd shows "group" mode (target window's mode)
5. User runs command
6. User presses ESC
7. Cmd closes, Groups window remains focused

### Scenario 3: Transient with Overlay
1. User is in Safari
2. Presses global hotkey, runs "windows" command
3. Windows overlay opens, hides other Peek windows
4. User presses ESC
5. Overlay closes, hidden windows NOT restored (transient mode)
6. Focus returns to Safari
