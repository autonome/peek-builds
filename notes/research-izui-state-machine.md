# IZUI State Machine: Architectural Research

Deep analysis of the IZUI (Invocable Zoom User Interface) system, its current state, and a proposed redesign where window behaviors derive from a unified state machine rather than per-case patches.

---

## 1. Current State: Complete Map

### 1.1 App-Level States (IzuiStateCoordinator)

The coordinator (`backend/electron/izui-state.ts`) defines four states:

| State | Meaning | Entry Condition |
|-------|---------|-----------------|
| `idle` | No session, no visible windows | Session ends (last window closes) |
| `transient` | User invoked from background app | `evaluateOnShow()` sees `appFocused === false` |
| `active` | User working within Peek windows | `evaluateOnShow()` sees `appFocused === true` |
| `overlay` | Full-screen overlay active | `enterOverlay()` called |

**Session model:** A session (`IzuiSession`) wraps all four states and tracks:
- `entryMode`: 'active' or 'transient' -- how the session began
- `windowStack`: array of window IDs in the session
- `overlayWindowId` / `hiddenWindowIds`: overlay state
- `focusedWindowId`: last focused window in session

**App focus tracking:** `appFocused` is updated by `browser-window-focus` and `browser-window-blur` events in `main.ts`. The blur handler only marks unfocused if `BrowserWindow.getFocusedWindow()` returns null (all Peek windows lost focus, meaning user switched to another app).

### 1.2 State Transitions

```
                  evaluateOnShow()           evaluateOnShow()
    IDLE -----> TRANSIENT             IDLE -----> ACTIVE
                  |                                 |
                  | enterOverlay()                  | enterOverlay()
                  v                                 v
               OVERLAY                           OVERLAY
                  |                                 |
                  | exitOverlay()                   | exitOverlay()
                  v                                 v
               TRANSIENT                          ACTIVE
                  |                                 |
                  | last window closes              | last window closes
                  v                                 v
                IDLE                              IDLE
```

Critical flaw: **`evaluateOnShow()` both queries AND mutates state.** It checks `appFocused`, then starts/updates the session. This conflates evaluation with transition. When called from the keepLive reuse path, it overwrites the session's `entryMode`, which means a transient session can silently become active (or vice versa) when a second window is shown.

### 1.3 Per-Window State (windowRegistry params)

Each window in `windowRegistry` (Map<number, {source, params}>) carries IZUI-relevant params:

| Param | Type | Set by | Meaning |
|-------|------|--------|---------|
| `transient` | boolean | window-open handler | Was app unfocused when this window opened? |
| `escapeMode` | string | opener or self-declaration | 'auto', 'close', 'navigate', 'ignore' |
| `modal` | boolean | opener | Close on blur, panel type on macOS |
| `keepLive` | boolean | opener | Hide instead of close |
| `overlay` | boolean | opener | Full-screen overlay behavior |
| `parentWindowId` | number/null | window-open handler | Auto-set from ev.sender (if real parent) |
| `overlayHiddenWindows` | number[] | window-open handler | Windows hidden by overlay |
| `key` | string | opener | Enables window reuse |

### 1.4 ESC Handling Chain

The current escape flow is a five-layer decision tree:

1. **`before-input-event` on BrowserWindow webContents** (`windows.ts:addEscHandler`): Catches ESC keyDown, calls `e.preventDefault()`, invokes `handleEscapeForWindow(bw, 'host')`
2. **`did-attach-webview` listener** (`windows.ts:addEscHandler`): Also attaches ESC interception to webview guest webContents, routing to the same `handleEscapeForWindow(bw, 'webview')`
3. **`handleEscapeForWindow()`** (`windows.ts`): Reads `escapeMode` from window params, then:
   - `'ignore'`: return, do nothing
   - `'navigate'`: ask renderer, then apply IZUI close policy (child/transient closes, active root does not)
   - `'auto'`: complex branching on isChild, isTransient, isOverlay, isCoordinatorOverlay
   - Fallthrough reaches `closeOrHideWindow()`
4. **`askRendererToHandleEscape()`** (`windows.ts`): Sends `escape-pressed` IPC to renderer, waits 500ms timeout for response
5. **Preload `escape-pressed` handler** (`preload.js:1637`): Three-priority cascade:
   - Open `peek-dialog` or `peek-drawer` -- close topmost one, return `{handled: true}`
   - Extension's `_escapeCallback` (registered via `api.escape.onEscape()`) -- call it, return its response
   - No handler -- return `{handled: false}`

**The self-declaration side-channel:** When a renderer calls `api.escape.onEscape()`, the preload also invokes `ipcRenderer.invoke('izui-set-escape-mode', 'navigate')`. This overwrites whatever `escapeMode` the opener set, creating a second path for escape mode to be established.

### 1.5 Where State Is Split Across Systems

State relevant to ESC/lifecycle behavior is scattered across:

1. **IzuiStateCoordinator** -- app-level session state (transient/active/overlay)
2. **windowRegistry params** -- per-window configuration (escapeMode, modal, keepLive, transient, parentWindowId)
3. **Preload escape callback** -- renderer-side state (`_escapeCallback`)
4. **closeOrHideWindow()** -- additional behavior switches on `keepLive`, `modal`, `SETTINGS_ADDRESS`
5. **main.ts closed handler** -- overlay restore logic, parent focus restoration
6. **modal blur handler** -- registered conditionally in window-open and background window code

No single place can answer: "What will happen when ESC is pressed in this window?" You must trace through all five layers to determine the outcome.

---

## 2. Window Taxonomy

### 2.1 Complete Window Type Inventory

| Window Type | Example | escapeMode | modal | keepLive | overlay | transient | parentWindowId |
|-------------|---------|------------|-------|----------|---------|-----------|----------------|
| **Background** | `peek://app/background.html` | N/A (no ESC handler) | false | false | false | N/A | null |
| **Extension Host** | `peek://app/extension-host.html` | N/A (no ESC handler) | false | false | false | N/A | null |
| **Command Palette** | `peek://ext/cmd/panel.html` | auto (default) | true | true | false | varies | null (bg is sender) |
| **Web Page** | via `peek://app/page/index.html` | auto -> navigate (self-declared) | false | false | false | varies | set if real parent |
| **Extension UI (Groups)** | `peek://ext/groups/home.html` | navigate (explicit) | false | false | false | varies | null (bg is sender) |
| **Extension UI (Tags)** | `peek://ext/tags/home.html` | auto -> navigate (self-declared) | false | false | false | varies | null (bg is sender) |
| **Overlay (Windows)** | `peek://windows/windows.html` | auto -> navigate (self-declared) | false | false | true | varies | null (bg is sender) |
| **Peek** | user URL | auto (default) | true | optional | false | varies | null (bg is sender) |
| **Slide** | user URL | auto (default) | true | optional | false | varies | null (bg is sender) |
| **Child Web Page** | opened from page.js `new-window` | auto -> navigate (self-declared) | false | false | false | varies | set to opener |
| **Settings** | `peek://app/settings/settings.html` | auto (default) | varies | false | false | varies | varies |
| **Download** | `peek://ext/cmd/download.html` | auto (default) | false | false | false | varies | null |
| **Diagnostic** | `peek://app/diagnostic.html` | auto (default) | false | false | false | varies | null |

### 2.2 Distinguishing Properties

What makes each window type behave differently:

- **Who created it:** Background extension windows have `source` = extension URL, but `parentWindowId = null` because background/extension-host are filtered as "not real parents". This means extensions cannot create true child windows -- all their windows look like root windows.
- **How it closes:** `closeOrHideWindow()` branches on `keepLive || modal` (hide instead of close), `SETTINGS_ADDRESS` (always close + maybeHideApp), and default (close + close children + maybeHideApp).
- **How ESC behaves:** Depends on the intersection of `escapeMode`, `isTransient`, `isChild`, `isOverlay`, and whether the renderer has a callback.
- **Self-declaration vs opener declaration:** `escapeMode` can be set by the opener (groups background sets `escapeMode: 'navigate'`) OR by the renderer (preload's `onEscape` auto-sets 'navigate'). The self-declaration always wins because it runs after window creation.

### 2.3 The parentWindowId Problem

The `parentWindowId` mechanism has a fundamental blind spot: **extension background windows are not considered real parents.** The check in `ipc.ts:1770-1772`:

```typescript
const INTERNAL_URLS = ['peek://app/background.html', 'peek://app/extension-host.html'];
const isRealParent = openerWindow && !openerWindow.isDestroyed() && !INTERNAL_URLS.some(u => openerUrl === u);
```

This means when the groups extension opens a web page via `api.window.open(url)`, the IPC sender is the extension-host iframe. The extension-host URL matches `INTERNAL_URLS`, so `isRealParent = false`. The web page window gets `parentWindowId = null`.

However, when the groups *home.html* UI (a visible window) opens a web page, the sender IS a real parent. So the same action (opening a URL from groups) produces different parent relationships depending on whether it's triggered from the background or the UI.

---

## 3. Every api.window.open() Call

### 3.1 Extension Background Openers (from invisible processes)

| Extension | File | URL Opened | Key Params | Intent |
|-----------|------|------------|------------|--------|
| **peeks** | `extensions/peeks/background.js:83` | `item.address` (user URL) | `modal: true, type: 'panel', key: 'peek:...'` | Transient quick-view panel |
| **slides** | `extensions/slides/background.js:150` | `item.address` (user URL) | `modal: true, type: 'panel', key: '...:edge'` | Edge-anchored transient panel |
| **cmd** | `extensions/cmd/background.js:303` | `peek://ext/cmd/panel.html` | `modal: true, keepLive: true, transparent: true, type: 'panel'` | Persistent command palette |
| **cmd** | `extensions/cmd/background.js:468` | download page URL | `width: 400, height: 200, alwaysOnTop: true` | Ephemeral download window |
| **windows** | `extensions/windows/background.js:56` | `peek://windows/windows.html` | `overlay: true, maximize: true, transparent: true, type: 'panel'` | Full-screen overlay switcher |
| **groups** | `extensions/groups/background.js:70` | `peek://ext/groups/home.html` | `escapeMode: 'navigate', key: address` | Persistent groups browser |
| **groups** | `extensions/groups/background.js:246` | user URL | `groupMode: {...}` | Content page in group context |
| **tags** | `extensions/tags/background.js:21` | `peek://ext/tags/home.html` | `key: 'tags-home'` | Tags browser |
| **editor** | `extensions/editor/background.js:26` | editor URL | `key: ..., escapeMode: 'navigate'` | Note editor |
| **hud** | `extensions/hud/background.js:70` | HUD URL | various | HUD overlay |
| **scripts** | `extensions/scripts/background.js:71` | script URL | various | Script runner |

### 3.2 Extension UI Openers (from visible windows)

| Extension | File | URL Opened | Key Params | Intent |
|-----------|------|------------|------------|--------|
| **groups home** | `extensions/groups/home.js:626` | user URL | `width: 800, height: 600` | Open grouped page (child of groups UI) |
| **tags home** | `extensions/tags/home.js:43` | user URL | `width: 800, height: 600, trackingSource: 'tags'` | Open tagged page |
| **page container** | `app/page/page.js:213` | `e.url` (new-window from webview) | `width: 1024, height: 768` via `izui.openChildWindow()` | Child page from link click |
| **cmd panel** | `extensions/cmd/panel.js:493` | URL | various | Open URL from command result |

### 3.3 Core App Openers

| Module | File | URL Opened | Key Params | Intent |
|--------|------|------------|------------|--------|
| **index.js** | `app/index.js:251` | `peek://app/datastore/viewer.html` | diagnostic | Datastore viewer |
| **index.js** | `app/index.js:263` | `peek://app/diagnostic.html` | diagnostic | App diagnostic |
| **windows.js** | `app/windows.js:46,77` | address param | various | Generic window open helper |

### 3.4 IZUI Intent Communication Gaps

The fundamental problem: **openers declare mechanism, not intent.** `modal: true` means "close on blur" but is used as a proxy for "this is a transient panel." `keepLive: true` means "hide instead of close" but is used as a proxy for "this window persists across invocations." Neither communicates the actual IZUI intent.

Missing intents that have no first-class representation:
- "This is a quick-view that should close when the user is done glancing" (peeks/slides)
- "This is a workspace browser that should support internal navigation" (groups/tags)
- "This is a command interface that should close after command execution" (cmd)
- "This is an overlay that replaces the current view temporarily" (windows switcher)
- "This is a content window opened in the context of a parent" (child pages)

---

## 4. ESC Behavior: Expected vs Actual

### 4.1 Expected Behavior Matrix

| Window Type | ESC with internal state | ESC at root (transient) | ESC at root (active) |
|-------------|------------------------|------------------------|---------------------|
| Web page with history | Go back | Close | Do NOT close |
| Web page at root | N/A | Close | Do NOT close |
| Groups (viewing addresses) | Navigate to groups list | Close | Do NOT close |
| Groups (at groups list) | N/A | Close | Do NOT close |
| Tags (with search/filter) | Clear search/filter | Close | Do NOT close |
| Tags (with dialog open) | Close dialog | Close | Do NOT close |
| Tags (at root) | N/A | Close | Do NOT close |
| Peek (modal web page) | Go back (if navigated) | Close | Close (modal always closes) |
| Slide (modal web page) | Go back (if navigated) | Close | Close (modal always closes) |
| Cmd palette | N/A | Close | Close (modal always closes) |
| Windows overlay | Clear search | Close + restore windows | Close + restore windows |
| Child web page | Go back | Close (return to parent) | Close (return to parent) |

### 4.2 Current Behavioral Issues

**Issue 1: Modal windows don't respect internal navigation.** Peeks and slides set `modal: true` but not `escapeMode: 'navigate'`. When a user navigates within a peek (clicks a link), ESC should go back before closing. But with `escapeMode: 'auto'` and `modal: true`, the transient/overlay path fires immediately without asking the renderer.

**Issue 2: Active root windows with no handler.** If a web page doesn't register an escape handler (the page container's izui.init hasn't run yet, or the handler returns `{handled: false}`), the 'auto' mode falls through to "NOT closing (IZUI policy)". But the only feedback is a console log -- the user sees nothing happen.

**Issue 3: Overlay restoration in transient mode.** When the windows overlay closes in transient mode, it does NOT restore hidden windows (`main.ts:182-194`). This is intentional (you don't want to show windows when returning to another app), but there's no way for the overlay to know whether the user selected a window (should restore) or just pressed ESC (should not restore).

**Issue 4: Self-declared escapeMode race.** The preload's `onEscape()` calls `izui-set-escape-mode` to set 'navigate'. But this IPC is asynchronous. If ESC is pressed before the IPC completes (window just opened), the window may still have `escapeMode: 'auto'` and take the wrong path.

**Issue 5: Dialog closing is preload-global, not window-type-aware.** The preload's topmost-dialog detection (`_findTopmostOpenDialog`) works the same for all window types. But a peek-dialog in a modal window (peek/slide) should probably close the entire window after the dialog closes, while a peek-dialog in an active workspace browser should just close the dialog.

---

## 5. App Focus States

### 5.1 Focus State Tracking

- **`appFocused`** (IzuiStateCoordinator): Updated by `browser-window-focus`/`browser-window-blur` on the `app` object. True when any Peek window has OS focus.
- **`lastFocusedVisibleWindowId`** (ipc.ts): Updated on window focus, excludes modal windows. Used for command targeting.
- **`lastContentWindowId`** (ipc.ts): Updated when http/https page gains focus. Used for devtools command.
- **`focusedWindowId`** (IzuiSession): Updated via `setFocusedWindow()`, cleared on close/blur.

### 5.2 Focus Transitions and IZUI State

The transient detection is evaluated at window-show time, not continuously. Once a session starts as transient, it stays transient for its duration. This creates a problem:

1. User is in another app (appFocused = false)
2. User presses global hotkey -> window opens, session starts as transient
3. Peek window gains focus -> `browser-window-focus` fires -> `appFocused = true`
4. User clicks on another Peek window -> still transient because session.entryMode wasn't updated
5. User opens a new window from within Peek -> `evaluateOnShow()` sees `appFocused = true` but session already exists, so it UPDATES entryMode to 'active'

Step 5 is the key flaw: **opening a second window from within a transient session silently converts it to active.** The `evaluateOnShow()` function in `izui-state.ts:186-197` always updates `session.entryMode` to the current evaluation result.

### 5.3 Focus and Modal Windows

Modal windows (`type: 'panel'`, close-on-blur) interact poorly with IZUI focus tracking. When a cmd palette opens:
1. It gets focus, fires `browser-window-focus` -> `appFocused = true`
2. It's excluded from `lastFocusedVisibleWindowId` tracking (correct)
3. But it's NOT excluded from IZUI focus -- opening a window from cmd would evaluate as 'active'

This is actually the correct behavior most of the time (user is actively working in Peek), but it means **the distinction between "user invoked from another app" and "user is working in Peek" is only reliable for the very first window of a session.**

---

## 6. Proposed State Machine Design

### 6.1 Core Principle: Intent Declaration, Not Mechanism Configuration

Instead of openers specifying `modal: true, keepLive: true, escapeMode: 'navigate'` and having the backend infer behavior, openers should declare **what kind of window this is** and **what IZUI role it plays**. The backend derives all mechanism from intent.

### 6.2 Window Roles (replacing ad-hoc params)

```
windowRole: 'workspace' | 'quick-view' | 'overlay' | 'palette' | 'content' | 'child-content' | 'utility'
```

| Role | Description | Current Equivalent | Derived Behavior |
|------|-------------|-------------------|------------------|
| `workspace` | Long-lived browser/manager UI | groups, tags with `escapeMode: 'navigate'` | ESC navigates internally, never closes in active mode. Close only in transient mode at root. |
| `quick-view` | Ephemeral view triggered by hotkey | peeks, slides with `modal: true` | ESC always closes (after internal nav). Close on blur. May be keepLive. |
| `overlay` | Full-screen takeover | windows switcher with `overlay: true` | ESC closes and restores hidden windows. Hides all other windows on open. |
| `palette` | Command/search input | cmd with `modal: true, keepLive: true` | ESC closes. Close on blur. Always keepLive. |
| `content` | Web page opened by user action | web pages from groups, tags, cmd | ESC navigates back. Close in transient at root. Parent-aware. |
| `child-content` | Content opened from another content window | links from page.js | Same as content but always closes on ESC at root (to return to parent). |
| `utility` | Small helper window | download, diagnostic | ESC closes. No special behavior. |

### 6.3 App-Level State Machine (Refined)

```
States: IDLE, TRANSIENT, ACTIVE, OVERLAY

Transitions:
  IDLE -> TRANSIENT:    window opens while app unfocused
  IDLE -> ACTIVE:       window opens while app focused
  TRANSIENT -> ACTIVE:  user explicitly focuses Peek (not just opening a window)
  ACTIVE -> TRANSIENT:  [should not happen - active sessions stay active]
  ANY -> OVERLAY:       overlay window opens
  OVERLAY -> previous:  overlay window closes
  ANY -> IDLE:          last window closes
```

Key change: **Once a session becomes ACTIVE, it stays ACTIVE.** The current bug where `evaluateOnShow()` can flip a transient session to active should be the one-way ratchet: transient-to-active is allowed, active-to-transient is not. This matches user intent -- if you were in another app and then started interacting with Peek, you've committed to an active session.

### 6.4 ESC as Derived Behavior

Given `(appState, windowRole, rendererState)`, ESC behavior is a pure function:

```
escAction(appState, windowRole, rendererState) =
  -- Step 1: Renderer-internal actions always take priority
  if rendererState.hasOpenDialog:
    return CLOSE_DIALOG

  if rendererState.hasInternalNavigation:
    return NAVIGATE_INTERNAL  -- ask renderer to handle

  -- Step 2: Window role determines root behavior
  match windowRole:
    'quick-view', 'palette', 'utility':
      return CLOSE  -- these always close at root regardless of app state

    'overlay':
      return CLOSE_AND_RESTORE

    'child-content':
      return CLOSE  -- always close to return to parent

    'workspace':
      if appState == TRANSIENT:
        return CLOSE
      else:
        return NOTHING  -- active workspace at root: ESC does nothing

    'content':
      if appState == TRANSIENT:
        return CLOSE
      else:
        return NOTHING  -- active content at root: ESC does nothing
```

This eliminates all the special-casing in `handleEscapeForWindow()`. The function becomes:

1. Check renderer for internal actions (dialog, navigation)
2. Look up `(appState, windowRole)` in the policy table
3. Execute the action

### 6.5 How Openers Declare Intent

```javascript
// Peek (quick-view)
api.window.open(url, {
  role: 'quick-view',
  keepLive: true,  // mechanism, not intent -- still useful
  width: 800, height: 600
});

// Groups UI (workspace)
api.window.open('peek://ext/groups/home.html', {
  role: 'workspace',
  key: 'groups-home'
});

// Web page from groups (content)
api.window.open(url, {
  role: 'content'
  // parentWindowId auto-set by backend
});

// Windows switcher (overlay)
api.window.open(url, {
  role: 'overlay'
});

// Cmd palette
api.window.open(url, {
  role: 'palette',
  keepLive: true
});
```

Defaults based on context:
- If URL is `http://` or `https://` and no role specified: `'content'`
- If URL is `peek://` and no role specified: `'utility'`
- If `modal: true` and no role specified: `'quick-view'`
- If `overlay: true` and no role specified: `'overlay'`

### 6.6 Renderer Contract

The renderer's escape handler contract becomes simpler:

```javascript
api.escape.onEscape(() => {
  // Return what YOU handled internally:
  //   { handled: true } -- I navigated/closed something, no further action
  //   { handled: false } -- I have nothing to do, let the state machine decide
  //
  // You NEVER need to know about transient/active/window role.
  // The backend will decide whether to close based on the state machine.
});
```

The preload's dialog auto-close remains as-is (it's a renderer-internal concern). The renderer never needs to call `izui-close-self` or check `isTransient` -- those decisions belong to the backend.

---

## 7. Window Lifecycle Within the State Machine

### 7.1 Creation

```
opener calls api.window.open(url, { role, ...mechanism })
  |
  v
backend evaluates: appFocused? -> determine session state
  |
  v
backend resolves role (explicit > inferred from params > inferred from URL)
  |
  v
backend creates BrowserWindow with mechanism params (size, position, transparency, etc.)
  |
  v
backend registers in windowRegistry with { role, sessionState }
  |
  v
backend derives mechanism from role:
  role == 'quick-view' -> close-on-blur handler, panel type
  role == 'overlay' -> hide other windows, maximize
  role == 'palette' -> panel type, alwaysOnTop, close-on-blur
  role == 'workspace' -> standard window
  role == 'content' -> standard window, parent tracking
  role == 'child-content' -> standard window, parent tracking
  role == 'utility' -> standard window
  |
  v
backend pushes window to session stack
```

### 7.2 ESC Processing

```
ESC keyDown intercepted (before-input-event or webview guest)
  |
  v
handleEscapeForWindow(bw)
  |
  v
look up window role from registry
  |
  v
askRendererToHandleEscape(bw)
  |
  v
preload checks:
  1. open dialog/drawer -> close it, return { handled: true }
  2. _escapeCallback -> call it, return result
  3. no handler -> return { handled: false }
  |
  v
if renderer handled: done
  |
  v
escAction(coordinator.getState(), window.role, rendererResponse)
  -> CLOSE: closeOrHideWindow(bw.id)
  -> CLOSE_AND_RESTORE: closeOrHideWindow(bw.id) [overlay restore in close handler]
  -> NOTHING: do nothing
```

### 7.3 Close/Hide

```
closeOrHideWindow(id)
  |
  v
look up window role and params from registry
  |
  v
if keepLive: hide (same as current)
if not keepLive: close (same as current)
  |
  v
close handler in main.ts:
  - clear IZUI coordinator state
  - if child: focus parent
  - if overlay: restore hidden windows (unless transient session AND user didn't select a window)
  - publish window:closed
  - if last window: end session -> IDLE
```

### 7.4 Destruction

Same as current: `window.close()` triggers the 'closed' handler which cleans up the registry and coordinator.

---

## 8. Cross-Window Effects

### 8.1 Current Cross-Window Behaviors

| Action | Effect | Driven by |
|--------|--------|-----------|
| Overlay opens | All visible windows hidden | `window-open` handler checks `overlay: true` |
| Overlay closes (active) | Hidden windows restored | `main.ts` closed handler |
| Overlay closes (transient) | Hidden windows NOT restored | `main.ts` closed handler checks `transient` |
| Child closes | Parent gets focus | `main.ts` closed handler checks `parentWindowId` |
| Last window closes | Session ends, app hides | `popWindow()` -> `endSession()`, `maybeHideApp()` |
| Modal loses focus | Modal closes/hides | blur handler registered in `window-open` |

### 8.2 State-Machine-Driven Cross-Window Rules

In the proposed model, cross-window effects derive from the combination of window role and session state:

**Rule 1: Overlay lifecycle**
- On open: hide all non-background windows (same as current)
- On close in ACTIVE session: restore all hidden windows
- On close in TRANSIENT session with selection: restore selected window, close others
- On close in TRANSIENT session without selection: restore nothing, app hides

**Rule 2: Parent-child lifecycle**
- `child-content` windows always have a `parentWindowId`
- On child close: focus parent (same as current)
- On parent close: close all children (same as current via `closeChildWindows`)

**Rule 3: Session lifecycle**
- Transient session: when last visible window closes, hide app
- Active session: when last visible window closes, session ends, may hide app based on dock pref
- Overlay doesn't count as "last window" for session ending

**Rule 4: Focus effects**
- Modal roles (`quick-view`, `palette`) don't update `lastFocusedVisibleWindowId`
- All focus changes update `appFocused` through existing browser-window-focus/blur
- First window gaining focus in a transient session can ratchet session to active

---

## 9. Migration Path

### Phase 1: Add `role` param without changing behavior

1. Add `role` field to `windowRegistry` params
2. In `window-open` handler, compute role from existing params if not provided:
   - `overlay: true` -> `'overlay'`
   - `modal: true && keepLive: true` -> `'palette'`
   - `modal: true` -> `'quick-view'`
   - `escapeMode: 'navigate'` -> `'workspace'`
   - `parentWindowId != null && url is http/https` -> `'child-content'`
   - `url is http/https` -> `'content'`
   - else -> `'utility'`
3. Log computed role alongside existing params for comparison
4. No behavior change -- existing code paths still execute

### Phase 2: Rewrite `handleEscapeForWindow()` using role

1. Replace the nested if/else tree with the policy table lookup
2. Keep `askRendererToHandleEscape()` as-is (renderer contract unchanged)
3. Remove `escapeMode` from the decision path -- role determines everything
4. Keep `escapeMode: 'ignore'` as an override (some windows truly need ESC passthrough)
5. Unit test each `(sessionState, role)` combination

### Phase 3: Update openers to declare role

1. Update each extension's `api.window.open()` calls to pass `role` explicitly
2. Remove `escapeMode: 'navigate'` from openers (derived from role now)
3. Remove `modal: true` as an IZUI signal (keep it only for actual BrowserWindow behavior)
4. Remove `self-declaration` in preload's `onEscape()` -- the role already determines behavior

### Phase 4: Fix session state management

1. Make transient-to-active a one-way ratchet in `evaluateOnShow()`
2. Remove the `evaluateOnShow()` call from the keepLive reuse path -- session state shouldn't change just because a hidden window was re-shown
3. Add a dedicated `promoteToActive()` method that only fires when the user deliberately focuses Peek (not just because a new window opened)

### Phase 5: Remove self-declaration mechanism

1. Remove `izui-set-escape-mode` IPC handler
2. Remove the auto-set in preload's `onEscape()` registration
3. The renderer's `onEscape` callback becomes purely informational: "I have internal navigation to handle." The backend no longer needs to know that the renderer registered a handler -- it just asks, and handles the response according to role policy.

### Phase 6: Clean up `app/` frontend IZUI layer

1. **Delete `app/izui.js`** entirely -- it's already a deprecated shim where every method delegates to the backend. No frontend IZUI module needed.
2. **Update `app/page/page.js`** -- replace `izui.init({ onEscape: ... })` with direct `api.escape.onEscape()` call. Remove `import izui from '../izui.js'`. Replace `izui.openChildWindow()` with `api.window.open()`.
3. **Remove any other `izui.js` imports** across `app/` -- search for all consumers and replace with direct `api` calls.
4. The frontend API surface for IZUI becomes just `api.escape.onEscape(callback)` -- one function. Everything else is backend policy.
5. This simplifies the contract: **frontend reports state** ("I have a dialog open", "I navigated back", "nothing to do"), **backend makes decisions** (close, hide, nothing).

Note: This clean split will make the Tauri desktop implementation straightforward -- the backend role/policy system ports directly, and the frontend contract (`api.escape.onEscape`) is platform-agnostic.

---

## 10. Key Insights

### 10.1 The Fundamental Confusion

The current system conflates three orthogonal concerns:

1. **Window mechanism** (how the window behaves at the OS level): frame, transparency, position, alwaysOnTop, panel type
2. **Window role** (what the window IS in the IZUI model): workspace, quick-view, overlay, content
3. **Session context** (the circumstances of invocation): transient vs active

These three concerns should be independent. Currently, `modal: true` is used to mean both "close on blur" (mechanism) and "this is a transient quick-view" (role). `escapeMode: 'navigate'` is used to mean both "ask renderer before closing" (mechanism) and "this is a workspace with internal navigation" (role).

### 10.2 Why Per-Extension Hacks Keep Appearing

Each new extension encounters the same problem: the default ESC behavior doesn't match their intent, so they add workarounds:
- Groups sets `escapeMode: 'navigate'` to prevent closing at root
- Tags registers `onEscape` with `{handled: true}` for search/filter clearing
- The preload detects `peek-dialog` elements to auto-close them
- Page.js uses `izui.init()` to register a webview back-navigation handler

Each is correct for its window, but each is a local fix to a systemic problem. With roles, each extension just declares what it is, and correct behavior falls out of the state machine.

### 10.3 The Self-Declaration Anti-Pattern

The `izui-set-escape-mode` mechanism (renderer self-declares its escape mode) is backwards. It says: "I'm telling you what I am after you've already created me." This creates race conditions and makes it impossible to know a window's behavior at creation time. In the role-based model, the opener declares intent at creation time, and the renderer's escape handler is just a callback that the state machine consults -- it doesn't change the state machine's policy.

### 10.4 Modal As Role vs Modal As Mechanism

`modal: true` currently does two things: sets BrowserWindow type to 'panel' on macOS, and registers a blur handler that closes the window. The first is mechanism (useful for OS window management). The second is a role behavior (quick-views should close on blur, workspaces should not). These need to be separated:

- `type: 'panel'` -- mechanism, keep as BrowserWindow option
- Close-on-blur -- derived from role: `quick-view` and `palette` close on blur; others don't

### 10.5 The keepLive Orthogonality

`keepLive` is genuinely orthogonal to role -- any role can be keepLive. A `quick-view` peek may be keepLive (hide on ESC, re-show on hotkey) or not (destroy on ESC). A `palette` is always keepLive (cmd palette persists). This should remain as a separate mechanism param, not folded into role.
