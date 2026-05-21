# Widgets Research & Architecture

Status: **Architecture Decided** | Feb 2026

## Core Insight

**A widget is just a URL.** A `peek://ext/{ext}/widget-name.html` page, or even a plain web URL. No special widget registration API, no widget item types, no schema migration. Extensions serve widget pages like they serve any other page.

**A widget sheet is a layout container.** One BrowserWindow that arranges multiple widget URLs in a grid of cards. Each card hosts a webview. Sheets can mix widgets from different extensions and web pages.

**The layout engine is `peek-grid` with a new "freeform" mode.** Alongside the existing `columns`, `list`, and `masonry` modes, a new `freeform` mode enables drag-and-drop positioning and resizing of cards. Widget sheets are the first customer of this mode.

---

## Architecture

### What Already Exists

| Component | Location | Role |
|-----------|----------|------|
| `peek-grid` | `app/components/peek-grid.js` | Grid layout with columns/list/masonry modes |
| `peek-card` | `app/components/peek-card.js` | Card container with slots (header, body, media, footer) |
| `peek-grid-toolbar` | `app/components/peek-grid-toolbar.js` | View mode switcher + sort controls |
| `peek-grid-item` | `app/components/peek-grid.js` | Optional wrapper with col/row span |
| Windows extension | `extensions/windows/` | Full reference implementation: search + toolbar + grid of cards |
| HUD extension | `extensions/hud/` | Always-on-top overlay (first customer for widget migration) |
| `DataBoundElement` | `app/components/data-binding.js` | Reactive data binding base class |
| `item_events` table | `apps/desktop/main/datastore.ts` | Time-series data (feeds, series) — widget data source |
| Extension page model | `peek://ext/{id}/page.html` | Extensions serve visible pages via URL |

### What Needs to Be Built

1. **`freeform` layout mode for peek-grid** — drag, drop, resize cards with persisted positions
2. **Widget sheet extension** — uses peek-grid in freeform mode, each card hosts a URL via webview
3. **Sheet persistence** — save/load layout configs (extension_settings or items)

### What Does NOT Need to Be Built

- ~~`api.widgets.register()`~~ — extensions just serve HTML pages
- ~~Widget item types (`widget-type`, `widget`, `widget-sheet`)~~ — no schema migration
- ~~Widget template engine~~ — each extension renders its own HTML
- ~~`app/widgets/` directory~~ — no core widget system code needed

---

## Architectural Decisions (Resolved)

### 1. Rendering Context
**Widgets are URLs rendered as webviews inside card containers.** A widget sheet is a single BrowserWindow. Each card in the grid hosts a webview pointing to a `peek://ext/...` URL or web URL. This allows diverse sources — multiple extensions and web pages in one sheet.

### 2. Shared Code (Lit, Components)
**Orthogonal to widgets.** Extensions already import components via `peek://app/components/` and Lit via `peek://node_modules/lit/`. This pattern works. If we need to formalize shared code loading, that's a separate initiative.

### 3. Widget Sheet = Single Window
**One BrowserWindow per sheet, multiple cards inside.** Cards can host pages (webviews). This is the same model as the Windows extension — one window, grid of cards — just with webviews inside cards and a freeform layout mode.

### 4. Scoping
**Global by default.** Modes/scoping still being worked out across the app. Widget sheets are global for now. Per-group scoping can be added later when mode system matures.

### 5. Storage
**No new item types.** Widget/sheet configs stored in `extension_settings` (like group workspace persistence). A sheet config is just a list of URLs with position/size data.

### 6. HUD Migration
**HUD is the first customer.** The existing HUD extension (`extensions/hud/`) will be migrated to use widget sheets once the system is ready. Validates the architecture end-to-end.

### 7. Pagestream
**Stays separate.** Pagestream has its own complex interaction model. Not part of the widget system.

---

## Freeform Layout Mode

The key new primitive. Added to `peek-grid` alongside existing modes.

### Existing Modes
- **columns** — auto-fit CSS Grid (responsive)
- **list** — single column, full width
- **masonry** — CSS columns, Pinterest-style

### New: freeform
- Cards have absolute positions (x, y, width, height)
- Drag to reposition, handles to resize
- Positions stored per-card in a layout config
- Grid container uses `position: relative`, cards use `position: absolute`
- Snap-to-grid optional
- Cards without saved positions get auto-placed (fallback to columns flow)

### Layout Config Shape
```javascript
{
  version: 1,
  items: [
    { id: 'card-1', url: 'peek://ext/worklog/timer.html', x: 0, y: 0, width: 300, height: 200 },
    { id: 'card-2', url: 'peek://ext/hud/mode.html', x: 320, y: 0, width: 200, height: 150 },
    { id: 'card-3', url: 'https://example.com/status', x: 0, y: 220, width: 520, height: 300 }
  ]
}
```

### Interaction Model
- **Normal mode**: cards display content, clicking interacts with the webview
- **Edit mode** (toggle via toolbar button or shortcut): cards become draggable/resizable, webview interactions disabled
- Edit mode shows drag handles, resize corners, add/remove buttons
- Exiting edit mode persists the layout

---

## Widget Sheet Extension

The first customer of freeform layout mode.

### Structure
```
extensions/sheets/
├── manifest.json
├── background.js          # Noun registration, sheet management
├── background.html
├── sheet.html             # Sheet page — peek-grid in freeform mode
├── sheet.js               # Sheet logic — load config, manage webviews
├── sheet.css
└── settings-schema.json
```

### How It Works
1. User creates a sheet via cmd palette: `new sheet "Morning Dashboard"`
2. Sheet opens as a window with peek-grid in freeform + edit mode
3. User adds widgets: `+ Add` button → pick from extension-provided URLs or enter a web URL
4. User drags/resizes cards to desired layout
5. Exit edit mode → layout persisted to extension_settings
6. Opening the sheet again restores all cards in their saved positions

### Sheet Config Storage
```javascript
// extension_settings row:
extensionId: 'sheets'
key: 'sheet:<sheetId>'
value: {
  version: 1,
  name: 'Morning Dashboard',
  createdAt: 1708000000,
  items: [
    { id: 'abc', url: 'peek://ext/worklog/timer.html', x: 0, y: 0, width: 300, height: 200 },
    { id: 'def', url: 'peek://ext/hud/mode.html', x: 320, y: 0, width: 200, height: 150 }
  ]
}
```

### Cmd Palette Integration (Noun Registration)
- `sheets` — list all sheets
- `new sheet <name>` — create and open a new sheet
- `open sheet <name>` — open existing sheet

---

## Implementation Phases

### Phase 1: Freeform Layout Mode
- Add `freeform` to peek-grid's viewMode options
- Implement absolute positioning with drag and resize
- Edit mode toggle (drag handles, resize corners)
- Layout config save/load API on peek-grid
- Works with any content (not just webviews)

### Phase 2: Widget Sheet Extension
- Extension scaffold with noun registration
- Sheet page using peek-grid freeform mode
- Cards host webviews (peek:// and web URLs)
- Sheet config persistence via extension_settings
- Add/remove cards in edit mode

### Phase 3: HUD Migration
- Migrate HUD extension to use a widget sheet
- HUD widgets as individual extension pages (mode display, window count, IZUI state, etc.)
- Sheet positioned as always-on-top overlay

### Phase 4: Ecosystem
- Extensions publish widget pages (worklog timer, feed reader, etc.)
- Widget discovery (browse available widgets from installed extensions)
- Sheet templates (pre-configured layouts)
- Worklog integration (time dashboard as a sheet)

---

## Reference: Windows Extension Pattern

The Windows extension (`extensions/windows/`) is the closest existing analog. It uses:

```html
<peek-input class="search-input" placeholder="Search windows..."></peek-input>
<peek-grid-toolbar class="grid-toolbar" view-mode="columns"></peek-grid-toolbar>
<peek-grid class="cards" min-item-width="200" gap="12"></peek-grid>
```

With JS wiring:
- Loads data via `api.window.list()`
- Creates `peek-card` elements dynamically
- Toolbar events update grid viewMode
- Keyboard navigation (vim keys + arrows)
- View preferences persisted via `api.settings`

Widget sheets follow this exact same pattern, replacing window data with URL configs and adding freeform layout mode.

---

## Existing Infrastructure for Widget Data

Extensions that serve widget pages have full access to:

| API | Use |
|-----|-----|
| `api.datastore.queryItemEvents()` | Time-series data (feeds, series, worklog) |
| `api.datastore.getItems()` | Items by type, tag, search |
| `api.context.watch()` | Mode, IZUI state, group context |
| `api.window.list()` | Window metadata |
| `api.subscribe()` | Real-time pubsub events |
| `api.settings.get/set()` | Extension preferences |
| `fetch()` | External APIs |

No new API surface needed. Widget pages are just extension pages with full API access.

---

## Previous Research (Archived)

Earlier research explored a more complex architecture with:
- `api.widgets.register()` / `api.widgets.create()` APIs
- Widget item types in the datastore (`widget-type`, `widget`, `widget-sheet`)
- Widget template engine and type registry
- `app/widgets/` directory with system.js, api.js, data-source.js, types/

This was superseded by the URL-based approach (Feb 2026) which achieves the same goals with far less infrastructure by treating widgets as regular extension pages and sheets as peek-grid in freeform layout mode.

See also:
- `notes/research-widgets-hud.md` — HUD infrastructure research (IZUI, context, window APIs)
- `TODO.md` (Widgets section) — original brainstorming
