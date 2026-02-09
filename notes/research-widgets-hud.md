# Widgets System & HUD

Research note capturing prior session plans for the Widgets system and HUD.

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

### Status

- Basic HUD: completed (standalone implementation)
- Full HUD (widget-based): blocked on Widgets system
