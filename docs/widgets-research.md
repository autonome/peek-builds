# Widgets Research & Implementation Plan

Status: **Research Complete** | Priority: Future

## Overview

Widgets are reusable, data-bound UI components for displaying feeds, metrics, and custom data. They leverage the existing feeds system (series/feed items) and card grid components to create composable, template-driven visualization panels.

## Core Concept

Widgets are **views** on feeds/series data. The system separates:
- **Data** (feeds, series, item_events)
- **Visualization** (widget types, templates)
- **Layout** (widget sheets, dashboards)

---

## Widget API

```javascript
// Register a widget type (extensions or core)
api.widgets.register({
  name: 'stock-price',
  type: 'scalar',
  dataSchema: { /* JSON Schema */ },
  templates: { default: '...' }
});

// Create a widget instance
const widget = await api.widgets.create({
  type: 'stock-price',
  dataSource: {
    type: 'series',
    itemId: 'series_123',
    query: { since: '7d' },
    transform: (events) => events[0].value,
    aggregate: 'sum' | 'avg' | 'min' | 'max' | 'streak'
  }
});

// Widget sheets (dashboards)
await api.widgets.sheets.save('my-dashboard', { widgets: [...] });
const dashboard = await api.widgets.sheets.load('my-dashboard');

// Custom data fetchers (for non-feed data)
api.widgets.registerDataFetcher('weather:forecast', async (config) => {
  return fetch(`https://api.weather.service/forecast?lat=${config.lat}`).then(r => r.json());
});
```

---

## Widget Types

| Category | Types | Description |
|----------|-------|-------------|
| **Data Display** | scalar, list, table, stats, timeline, gauge | Show values, lists, aggregates |
| **Visualization** | chart, graph, media, badge | Charts, sparklines, images |
| **Interactive** | button-set, form, carousel | User input, actions |
| **Utility** | empty, loading, error, container | States, composition |

---

## Database Storage

Widget definitions use existing datastore tables:

| What | Storage | Description |
|------|---------|-------------|
| Widget types | `items` type=`widget-type` | Template definitions |
| Widget instances | `items` type=`widget` | Configured widget + dataSource |
| Widget sheets | `items` type=`widget-sheet` | Dashboard layouts |
| Widget data | `item_events` | Series/feed data displayed |

```sql
-- Widget type definition
INSERT INTO items (type, content, metadata) VALUES (
  'widget-type',
  'stock-price',
  '{"templates":{"default":"..."},"dataSchema":{...}}'
);

-- Widget instance
INSERT INTO items (type, content, metadata) VALUES (
  'widget',
  'My AAPL Tracker',
  '{"widgetType":"stock-price","dataSource":{"type":"series","itemId":"series_123"}}'
);

-- Widget sheet (dashboard)
INSERT INTO items (type, content, metadata) VALUES (
  'widget-sheet',
  'Trading Dashboard',
  '{"layout":{"columns":3},"widgetIds":["widget_1","widget_2","widget_3"]}'
);
```

---

## Examples

### Scalar Widget (Latest Value)
```javascript
{
  type: 'scalar',
  dataSource: { type: 'series', itemId: 'series_mood' },
  template: 'emoji-display'
}
// Renders: 😊 7/10
```

### Stats Widget (Aggregated)
```javascript
{
  type: 'stats',
  dataSource: {
    type: 'series',
    itemId: 'series_pushups',
    query: { since: '7d' },
    aggregate: 'summary'
  }
}
// Renders: Total: 245 | Avg: 35/day | 🔥 7-day streak
```

### Feed List Widget
```javascript
{
  type: 'list',
  dataSource: {
    type: 'feed',
    itemIds: ['feed_hackernews', 'feed_techcrunch'],
    query: { limit: 10 }
  }
}
```

### Dashboard Sheet
```javascript
{
  name: 'Morning HUD',
  layout: { columns: 2, gap: 16 },
  widgets: [
    { type: 'scalar', dataSource: { type: 'custom', fetcher: 'weather' } },
    { type: 'stats', dataSource: { type: 'series', itemId: 'series_sleep' } },
    { type: 'list', dataSource: { type: 'feed', itemId: 'feed_calendar' } },
    { type: 'timeline', dataSource: { type: 'series', itemId: 'series_weight', query: { since: '30d' } } }
  ]
}
```

---

## No-Code Usage Path

### Phase 1: Guided Creation
```
Cmd bar → "new widget" → prompts:
  1. What to track? [number/text/choice]
  2. Name it: "Daily Pushups"
  3. How to display? [latest value / chart / list]
  → Creates series + widget automatically
```

### Phase 2: Visual Dashboard Builder
```
Widget Sheet Editor:
┌─────────────────────────────────────┐
│ [+ Add Widget]  [Layout: 2 cols ▼]  │
├─────────────────────────────────────┤
│ ┌─────────┐  ┌─────────┐            │
│ │ Pushups │  │ Weight  │  ← drag    │
│ │   45    │  │  📈     │    to      │
│ └─────────┘  └─────────┘   reorder  │
│ ┌───────────────────────┐           │
│ │ Sleep (7-day trend)   │  ← resize │
│ └───────────────────────┘           │
└─────────────────────────────────────┘
```

### Phase 3: Template Gallery
```
"Add Widget" → Browse templates:
  📊 Habit Tracker     - daily check-ins with streaks
  💰 Budget Tracker    - spending categories
  📰 Feed Reader       - RSS/news aggregation
  🏃 Fitness Dashboard - steps, calories, workouts
  ⏱️ Time Tracker      - pomodoro / deep work hours
```

### Phase 4: Natural Language
```
"track my daily water intake"
→ Creates: series + scalar widget + input form

"show me a chart of my weight over 30 days"
→ Creates: timeline widget bound to existing weight series
```

---

## File Structure

```
app/widgets/
├── index.js              # Entry point
├── system.js             # Core registration & lifecycle
├── api.js                # window.app.widgets API
├── data-source.js        # Query and data fetching
├── template-engine.js    # Template compilation
├── types/
│   ├── base.js           # Base widget class
│   ├── scalar.js         # Single value
│   ├── list.js           # Scrollable list
│   ├── table.js          # Tabular data
│   ├── stats.js          # KPI cards
│   ├── timeline.js       # Event timeline
│   ├── chart.js          # Charts/graphs
│   ├── carousel.js       # Item carousel
│   └── gauge.js          # Progress/gauge
├── templates/
│   ├── registry.js       # Template registration
│   └── builtins.js       # Built-in templates
└── sheets/
    ├── manager.js        # Persistence
    └── definitions.js    # Pre-built dashboards
```

---

## Implementation Phases

### Phase 1: Foundation (2-3 weeks)
- Widget system API (register, create, list)
- `peek-widget` base component
- 3 basic types: scalar, list, stats
- Widget container/sheet support
- Tests and docs

### Phase 2: Visualization (2-3 weeks)
- Table, timeline, chart, carousel widgets
- Template system with registration
- Template examples library
- Developer guide

### Phase 3: Integration (1-2 weeks)
- Extension widget registration
- Custom data fetchers
- Widget sheet persistence
- Observable/signal support

### Phase 4: Polish (1-2 weeks)
- Performance (virtual scrolling, caching)
- Accessibility (ARIA, keyboard nav)
- Template gallery
- Mobile responsive

---

## Integration Points

### With Feeds
- Series data → scalar, stats, timeline, chart widgets
- Feed items → list, table, carousel widgets
- Query abstraction over `item_events` table

### With Components
- `peek-grid` + `peek-grid-item` for layout
- `peek-card` for widget frame
- `peek-list`, `peek-button`, etc. for content

### With Extensions
- Extensions register custom widget types
- Extensions provide custom data fetchers
- Widget types stored as items in datastore

---

## Related TODO.md Items

- Widgets (primary)
- Metadata QS Reflection (widgets display metrics)
- Window Templates (widgets as template components)
- Observability HUD (widget dashboard use case)
- Daytum-style tracking (series + widgets)

---

## Open Questions

1. **Refresh strategy**: Poll vs push for real-time updates?
2. **Template syntax**: Plain literals vs lightweight template language?
3. **Widget sizing**: Fixed sizes vs fluid/responsive?
4. **Persistence**: Per-profile widget sheets or global?
5. **Migration**: How to upgrade widget definitions across versions?
