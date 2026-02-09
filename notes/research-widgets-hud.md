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

### Integration with Peek Component Framework

Widgets should be built using the existing Lit component system in `app/components/`. This provides:

- **Base Classes**: `PeekElement` (base class with shared styles and utilities) and `DataBoundElement` (adds reactive data binding)
- **Available Components**: peek-card, peek-grid, peek-list, peek-button, peek-carousel, peek-details, peek-tabs, peek-dialog, peek-drawer, peek-dropdown, and more
- **Data Binding**: Reactive patterns via `data-binding.js` with support for signals, observables, and static data
- **Theme Integration**: Automatic via CSS custom properties (design tokens in `base.js`)
- **Schema Validation**: Built-in JSON Schema validation for widget data

**Widget Type to Component Mapping:**
- Scalar widget → `peek-card` with single value in body slot
- List widget → `peek-list` with items
- Table widget → `peek-grid` with data binding
- Timeline/Chart → custom `peek-card` with visualization in body
- Gauge → `peek-card` with progress indicator
- Carousel → `peek-carousel` with widget cards
- Stats → `peek-card` with key/value pairs in body

**Design Principle**: Widget API should extend/compose existing components rather than reinvent. Widgets inherit from `DataBoundElement` to get reactive data binding automatically.

**Example: Scalar Widget**
```javascript
import { html } from 'lit';
import { DataBoundElement } from './components/data-binding.js';

class ScalarWidget extends DataBoundElement {
  static properties = {
    label: { type: String }
  };

  static dataSchema = {
    type: 'object',
    properties: {
      value: { type: 'number' },
      unit: { type: 'string' }
    }
  };

  render() {
    return html`
      <peek-card>
        <div slot="header">${this.label}</div>
        <div slot="body" class="scalar-value">
          ${this.data.value}
          <span class="unit">${this.data.unit}</span>
        </div>
      </peek-card>
    `;
  }
}

// Usage with reactive data source
const windowCount = signal({ value: 5, unit: 'windows' });
const widget = document.createElement('scalar-widget');
widget.label = 'Open Windows';
widget.bindTo(windowCount);
```

### Widget API

- `api.widgets.register(type, componentClass)` — register a widget type with its Lit component class
- `api.widgets.create(type, config)` — instantiate a widget (creates component and configures data binding)
- `api.widgets.sheets` — manage widget sheets (collections of widgets)

Widget components extend `DataBoundElement` base class for automatic reactive updates via Lit's property/state system.

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

1. **Foundation** — Widget API, database storage for widget configs, basic scalar/list/table types using existing peek-card/peek-list/peek-grid
2. **Visualization** — Timeline, chart, gauge types using custom peek-card compositions, Lit template system
3. **Integration** — Extension API for publishing widgets, sheet management
4. **Polish** — No-code widget creation path, drag-and-drop layout

### Database Storage

Widget configurations stored in datastore — type, config JSON, position, sheet membership.

### Template System

Widgets use Lit's html tagged template literals for rendering. Reactive updates via Lit's property/state system and `DataBoundElement.bindTo()` method. Components support:

- **Slots**: Customization points (like peek-card's header/body/footer slots)
- **Data Binding**: `bindTo(source)` connects to signals, observables, or static data
- **Schema Validation**: Automatic via `dataSchema` property
- **Reactive Updates**: Lit handles DOM updates when data changes

**Example: List Widget**
```javascript
class ListWidget extends DataBoundElement {
  static dataSchema = {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: { type: 'string' }
      }
    }
  };

  render() {
    return html`
      <peek-list>
        ${this.data.items?.map(item => html`
          <div slot="item">${item}</div>
        `)}
      </peek-list>
    `;
  }
}
```

### Relationship to UI Componentry

The Widgets system builds directly on the component framework in `app/components/`. Widgets are the data-bound, reactive layer that composes existing peek-* primitives (cards, grids, lists, carousels, buttons) with schema-validated data sources.

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
