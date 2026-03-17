# Group Screen Border Specification

## Overview
The group screen border is a colored overlay around the screen edges that indicates the currently focused window belongs to a group. It includes a 4px solid border in the group's color with rounded corners, and a label showing the group name in the bottom-right corner.

## Visibility Rule
The border is visible **if and only if** the currently focused visible window has `context.mode = 'group'`.

### Border is VISIBLE when focused window is:
- The groups home window in address view (viewing a specific group's contents)
- A content page opened from within a group (inherited group mode from opener)
- A content page opened from another group content page (lineage inheritance)
- A popup window from a group content page (inherited from parent)

### Border is HIDDEN when focused window is:
- The groups list view (groups home navigated back, mode reset to 'default')
- Any non-group content window (opened from cmd palette, external app, etc.)
- A slide, peek, or non-modal window without group mode
- No window is focused (app in background)

### Border is UNCHANGED (transparent) when focused window is:
- The cmd palette or any other modal/transient window
- These windows don't affect border state — opening cmd while in a group keeps the border visible, opening cmd while not in a group keeps it hidden

## Color and Label
- Color: the group's assigned color (vivid colors assigned at group creation)
- Label: the group name, shown in bottom-right corner
- Both update immediately when switching between groups

## Transitions
- **Show**: immediate (no delay)
- **Hide**: debounced by 600ms to prevent flicker during window transitions
- **Focus change**: re-evaluates on every `window:focused` event
- **Mode change**: re-evaluates when any window's mode changes via context API
- **Window close**: re-evaluates (focus shifts to next window)
- **App focus lost**: debounced hide (via `app:focus-changed` event)
- **App focus regained**: re-evaluates based on which window is focused

## Implementation

### Decision function
`updateGroupScreenBorder()` in `backend/electron/ipc.ts` checks `lastFocusedVisibleWindowId`:
1. If no focused visible window exists, schedule hide
2. If focused window is destroyed, schedule hide
3. If focused window's `context.mode === 'group'` with a valid `groupId`, show border with group's color and name
4. Otherwise, schedule hide

### Trigger points
- `window:focused` pubsub event (focus changes between windows)
- `window:closed` pubsub event (focused window may have closed)
- `context-set` IPC when `key === 'mode'` (mode changed on any window)
- `app:focus-changed` pubsub event (app gains/loses OS-level focus)
- After `loadURL` in window open flow (new window may be in group mode)

### `scheduleHideGroupScreenBorder()`
Debounced hide helper. Starts a 600ms timer. If `updateGroupScreenBorder()` finds a group-mode focused window before the timer fires, the timer is cancelled. Prevents flicker during rapid focus transitions.

## Non-goals
- The border does NOT indicate that group windows exist somewhere in the background
- The border does NOT persist when switching to non-group work
- The border is NOT a global ambient state indicator

## Shutdown
- `cleanupGroupScreenBorder()` destroys the overlay window during app quit
- A `groupScreenBorderShuttingDown` flag prevents recreation during shutdown
