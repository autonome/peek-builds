# Widgets System & HUD

Research note capturing prior session plans for the Widgets system and HUD.

**Last Updated:** 2026-02-09
**Status:** Basic HUD in progress, full widget system not yet started

---

## Current State (2026-02-09)

### Available Infrastructure for HUD/Widgets

**IZUI State System** (`backend/electron/izui-state.ts`):
- States: `idle`, `transient`, `active`, `overlay`
- Uses OS-level app focus (not window-specific)
- New `IzuiSession` model tracks window stack and focus
- Frontend API:
  - `api.izui.isTransient()` - Re-evaluates on each call (fixes keepLive stale state)
  - `api.izui.getEffectiveMode()` - Returns 'default' for transient, 'active' for focused
  - `api.izui.getState()` - Current state string
  - `api.izui.closeSelf()` - Request window closure

**Context & Modes API** (`preload.js`):
- General-purpose key-value store with history tracking
- Modes built on context as first-class keys
- Available operations:
  - `api.context.get(key, windowId)` - Get current value
  - `api.context.set(key, value, options)` - Set with metadata
  - `api.context.watch(key, callback)` - Subscribe to changes
  - `api.context.watchMode(callback)` - Watch mode changes specifically
  - `api.context.setMode(mode, options)` - Set mode with metadata (groupId, groupName, etc.)
  - `api.context.getHistory(key, options)` - Query history with timestamps
  - `api.context.getWindowsWithValue(key, value)` - Find windows by context
  - `api.context.getWindowsInGroup(groupId)` - Group queries

**Window Management** (`preload.js`):
- `api.window.open(url, options)` - Opens window
- `api.window.list(options)` - List windows
- `api.window.getFocusedVisibleWindowId()` - Active window
- Window options support: `parentWindowId`, `modal`, `keepLive`, `overlayHiddenWindows`, `escapeMode`
- Backend auto-handles parent centering

**Pubsub System**:
- `api.publish(topic, msg, scope)` - Broadcast
- `api.subscribe(topic, callback, scope)` - Listen
- System topics: `context:changed`, `modes:changed`, `window:closed`

### HUD Integration Points

**For Basic HUD:**
1. **Mode Tracking**: `api.context.watch('mode', callback)` - Real-time mode changes
2. **IZUI State**: `api.izui.getState()` - Current state display
3. **Active Window**: `api.window.getFocusedVisibleWindowId()` - Which window is active
4. **Mode Metadata**: Context entries include metadata (groupId, groupName for group mode)
5. **Pubsub Updates**: Subscribe to system events for real-time refresh

**Window Configuration for HUD:**
- Always-on-top: Use standard BrowserWindow `alwaysOnTop: true`
- Non-focusable: May need `focusable: false` or `skipTaskbar: true`
- Transparent: `transparent: true`, `frame: false`

---

## Widgets System

Full widget infrastructure for Peek. Widgets are the building blocks for HUDs, dashboards, page metadata panels, command previews, and observability displays.

### Widget API

- `api.widgets.register(type, renderer)` — register a widget type with its renderer
- `api.widgets.create(type, config)` — instantiate a widget
- `api.widgets.sheets` — manage widget sheets (collections of widgets)

### Widget Types

1. **Scalar** — single value display (e.g. window count, datastore size)
2. **List** — ordered items (e.g. recent URLs, active extensions)
3. **Table** — tabular data (e.g. extension stats, sync status)
4. **Stats** — key/value pairs with formatting (e.g. session info)
5. **Timeline** — time-series data points (e.g. page loads over time)
6. **Chart** — graphical data visualization
7. **Carousel** — horizontal/vertical scrollable cards
8. **Gauge** — progress/threshold indicators

### Implementation Phases

1. **Foundation** — Widget API, database storage for widget configs, basic scalar/list/table types
2. **Visualization** — Timeline, chart, gauge types, template system
3. **Integration** — Extension API for publishing widgets, sheet management
4. **Polish** — No-code widget creation path, drag-and-drop layout

### Database Storage

Widget configurations stored in datastore — type, config JSON, position, sheet membership.

### Template System

Widgets bind to data sources and re-render reactively. Callers provide schema + data, widget has default template that can be overridden.

### Relationship to UI Componentry

The Widgets system builds on the UI Componentry work outlined in TODO.md (cards, grids, carousels, button sets). Widgets are the data-bound, reactive layer on top of those primitives.

## HUD (Always-On-Top Overlay)

An always-on-top overlay showing Peek context and state. A basic version was implemented independently, but the full version depends on the Widgets system.

### What it shows

- IZUI state (idle, transient, active, overlay)
- Current mode (default, page, settings, group)
- Active window info
- Session info (entry mode, window stack depth)
- System metrics (window count, extension count, datastore stats)

### Implementation

- Transparent, always-on-top BrowserWindow
- Positioned at screen edge (configurable)
- Updates reactively from IZUI state changes and system events
- Full version: composed of Widgets, so each panel is a widget instance in a HUD sheet

### Implementation Details (Updated)

**Data Sources:**
- Mode: `api.context.watch('mode', callback)` with metadata (groupId, groupName)
- IZUI state: `api.izui.getState()` returns current state string
- Active window: `api.window.getFocusedVisibleWindowId()` + `api.window.list()` for details
- Window count: `api.window.list().length`
- Extension info: Via pubsub or extension registry if exposed

**Window Setup:**
```javascript
api.window.open('peek://ext/hud/hud.html', {
  alwaysOnTop: true,
  transparent: true,
  frame: false,
  skipTaskbar: true,  // May make non-focusable
  width: 200,
  height: 100,
  x: 0,  // Screen corner
  y: 0
});
```

**Reactive Updates:**
```javascript
// Watch mode changes
api.context.watch('mode', (mode, entry) => {
  updateDisplay({
    mode: mode,
    groupName: entry?.metadata?.groupName
  });
});

// Watch IZUI state
api.subscribe('izui:state-changed', (msg) => {
  updateDisplay({ izuiState: msg.state });
});

// Periodic refresh for window info
setInterval(() => {
  const activeId = api.window.getFocusedVisibleWindowId();
  // Update active window display
}, 1000);
```

### Status

- Basic HUD: **In Progress** (agent implementing now)
- Full HUD (widget-based): blocked on Widgets system
