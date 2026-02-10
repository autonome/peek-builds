# Pagestream Implementation Plan

## 1. Feature Description

Pagestream is a vertical, chat-like navigational interface for web history. Instead of tabs or a traditional history list, the user sees a vertical stream of floating cards representing pages they have visited, with the most recent at the bottom. It reimagines browsing history as a living, scrollable conversation between the user and the web.

### User perspective

- Opening Pagestream shows a vertical scroll of page cards, newest at the bottom (like a chat where you read upward for older content).
- The **active card** (focused item) is visually prominent -- "popped up" or expanded compared to its neighbors.
- Scrolling to the very bottom reveals a "new tab" area: a command/URL input for opening a new page, which appends a new card to the stream.
- `Cmd+L` focuses the URL input at the bottom, like opening a new tab.
- **Vertical navigation** (up/down, j/k) moves between cards in the stream.
- **Horizontal navigation** (left/right, h/l) on an active card reveals page-specific metadata/actions in a lateral drawer or panel (e.g., tags, visit count, screenshot, page info, actions).
- Clicking or pressing Enter on an active card opens that page in a full content window.
- Screenshots/favicons are displayed on cards when available.
- The stream is filterable by search query, tags, or time range.

### What it is not

- Not a replacement for the cmd palette. It is a standalone browsing surface.
- Not a tab strip. There is one stream per session/profile, not per window.
- Not a full history viewer (though it draws from history). It is optimized for recency and flow.

## 2. Architecture

Pagestream is implemented as a Peek extension, following the same structural pattern as `groups`, `tags`, and `windows`.

### Extension file structure

```
extensions/pagestream/
  manifest.json        # Extension metadata
  config.js            # ID, labels, schemas, defaults (same pattern as groups/config.js)
  background.html      # Boots background.js (same boilerplate as groups/background.html)
  background.js        # Registers commands, shortcuts, opens the pagestream window
  home.html            # The pagestream UI page (loaded via peek://ext/pagestream/home.html)
  home.css             # Styles for the pagestream UI
  home.js              # UI logic: data loading, rendering, keyboard handling
```

### Data flow

```
┌──────────────────────────────────────────────────────────────┐
│                       Pagestream UI (home.js)                │
│                                                              │
│  1. On init, calls api.datastore.getHistory() or             │
│     api.datastore.queryItemVisits() to get recent visits     │
│  2. Joins with item data via api.datastore.queryItems()      │
│  3. Renders visit chain as vertical carousel of peek-cards   │
│  4. Subscribes to events for live updates                    │
│  5. On card activate, calls api.window.open() to open page   │
│  6. On new URL input, calls api.window.open() which also     │
│     triggers trackWindowLoad, adding to the stream           │
└──────────────────────────────────────────────────────────────┘
        │                                      ▲
        ▼                                      │
┌──────────────┐                    ┌──────────────────────┐
│ Datastore    │                    │ Event Bus            │
│ (IPC)        │                    │ (api.subscribe)      │
│              │                    │                      │
│ getHistory() │                    │ item:created         │
│ queryItems() │                    │ window:load          │
│ queryItemVisits()│                │ tag:item-added       │
│ getItemTags()│                    │ tag:item-removed     │
└──────────────┘                    └──────────────────────┘
```

## 3. UI Design

### Layout

The pagestream window is a single full-height view using `peek-carousel` in **vertical** mode as the central structural element.

```
┌────────────────────────────────────────────┐
│  [Search/Filter bar]                       │
│                                            │
│  ┌──────────────────────────────────────┐  │
│  │                                      │  │
│  │   ┌─────────────────────┐            │  │
│  │   │  Page Card (older)  │   ← faded  │  │
│  │   └─────────────────────┘            │  │
│  │                                      │  │
│  │   ┌─────────────────────┐            │  │
│  │   │  Page Card          │            │  │
│  │   └─────────────────────┘            │  │
│  │                                      │  │
│  │  ┌───────────────────────────┐       │  │
│  │  │                           │       │  │
│  │  │   ACTIVE CARD (expanded)  │ ← big │  │
│  │  │   screenshot / details    │       │  │
│  │  │                           │       │  │
│  │  └───────────────────────────┘       │  │
│  │                                      │  │
│  │   ┌─────────────────────┐            │  │
│  │   │  Page Card (newer)  │            │  │
│  │   └─────────────────────┘            │  │
│  │                                      │  │
│  └──────────── peek-carousel ───────────┘  │
│                                            │
│  ┌──────────────────────────────────────┐  │
│  │  [URL input / new page] (Cmd+L)     │  │
│  └──────────────────────────────────────┘  │
└────────────────────────────────────────────┘
```

### Card design

Each card in the stream is a `peek-card` with:
- **media slot**: page screenshot thumbnail (when available) or favicon fallback
- **header slot**: page title + domain badge
- **default slot (body)**: URL, visit timestamp ("2 minutes ago"), visit count
- **footer slot**: tag chips (clickable to filter stream by tag)

The **active card** (determined by `peek-carousel`'s `slide-change` event) gets:
- `selected` attribute set to true
- `elevated` attribute set to true
- Additional CSS scaling/shadow via a class (e.g., `.active-card`)
- Optionally expanded content (larger screenshot, more metadata)

### Horizontal swiping / lateral panels

When the user presses left/right (h/l) on the active card, a side panel slides in:
- **Left panel**: Page metadata (full title, description, OG data, domain info, visit history for this page)
- **Right panel**: Actions (open, tag, star, archive, copy URL, open in external browser)

This can be implemented with a horizontal `peek-carousel` nested inside the active card's expanded view, or as a `peek-drawer` component. Initial implementation should use a simple CSS transform slide, not requiring a nested carousel.

### Keyboard navigation

| Key | Action |
|-----|--------|
| `j` / `ArrowDown` | Move to next (newer) card |
| `k` / `ArrowUp` | Move to previous (older) card |
| `h` / `ArrowLeft` | Show left metadata panel on active card |
| `l` / `ArrowRight` | Show right actions panel on active card |
| `Enter` | Open the active card's URL in a content window |
| `Cmd+L` / `/` | Focus the URL input at the bottom |
| `Escape` | Close lateral panel -> clear search -> close pagestream |
| `g` / `Home` | Jump to oldest card (top) |
| `G` / `End` | Jump to newest card (bottom) |

### Search and filtering

A `peek-input` search bar at the top filters the stream:
- Searches page titles, URLs, and domains
- Can be combined with tag filtering (clicking a tag chip on a card)
- Filter results update the carousel contents in real time

## 4. Data Model

### Primary data source: item_visits + items

The stream is built from the `item_visits` table joined with `items`. This gives us:

**item_visits** (the visit chain):
- `id` - visit ID
- `itemId` - references items.id
- `timestamp` - when the visit occurred
- `duration` - how long the page was viewed
- `source` - how the visit was initiated (e.g., 'window', 'cmd', 'direct')
- `sourceId` - additional source context
- `windowType` - type of window
- `prevId` / `nextId` - doubly-linked list forming the navigation chain
- `scrollDepth` - how far the user scrolled
- `interacted` - whether the user interacted with the page

**items** (the page data):
- `id` - item ID
- `type` - 'url' for web pages
- `content` - the URL
- `title` - page title
- `domain` - extracted domain
- `favicon` - favicon URL/data
- `metadata` - JSON blob with additional data
- `visitCount` - total visits
- `lastVisitAt` - most recent visit
- `frecencyScore` - frecency ranking
- `starred` / `archived` - user flags

The `prevId`/`nextId` chain in `item_visits` is architecturally perfect for pagestream: it forms the exact chronological chain of navigations the user performed.

### Queries needed

1. **Load recent stream** (initial view):
   ```
   api.datastore.queryItemVisits({ limit: 50 })
   ```
   Returns the 50 most recent visits. For each visit, look up the item data to get title, URL, favicon, etc.

2. **Load more (scroll up to load older)**:
   ```
   api.datastore.queryItemVisits({ until: oldestTimestamp, limit: 50 })
   ```

3. **Get item details for each visit**:
   ```
   api.datastore.queryItems({ type: 'url' })
   ```
   Build a local Map of itemId -> item for efficient lookup. Or fetch individually as needed.

4. **Get tags for display on cards**:
   ```
   api.datastore.getItemTags(itemId)
   ```
   Called per-item (or batched if an API is added).

5. **Filter by tag**:
   ```
   api.datastore.getItemsByTag(tagId)
   ```
   Then intersect with the visit stream.

6. **Search within stream**:
   Client-side filtering on loaded data (title, URL, domain), consistent with how groups/tags do it.

7. **Follow the navigation chain** (for "session" view):
   Walk `prevId`/`nextId` links to show a connected session of navigations.

### Deduplication strategy

The raw visit stream will have many visits to the same page. Options:
- **Default: show all visits** (pure chronological stream, like chat history)
- **Collapsed mode**: group consecutive visits to the same URL, show count badge
- **Unique mode**: show only the most recent visit per URL (like a "recent pages" list)

Start with the default (all visits), and add collapsed/unique as filter options later.

## 5. Integration Points

### Commands (cmd extension)

Register in `background.js`:
- `open pagestream` / `pagestream` -- opens the pagestream window
- `pagestream search <query>` -- opens pagestream with pre-filled search (stretch goal)

### Keyboard shortcut

Register a global shortcut (configurable via settings, e.g., `Option+p`) to open/toggle pagestream.

### Context/mode

When pagestream is open and the user is browsing within it:
- Set mode to `'pagestream'` via `api.context.setMode('pagestream', {})`
- Pages opened from pagestream carry the pagestream context (like group mode)
- When the pagestream window closes, reset mode to default

### Groups

Pages opened from pagestream can be tagged into groups. The card footer shows existing tags. In the lateral actions panel, the user can add/remove tags, which also adds the page to a group.

### Tags

Tag chips on cards are clickable and filter the stream. This uses the same `getItemsByTag` / `getItemTags` APIs that tags and groups use.

### Window system

Opening a page from pagestream uses `api.window.open(url, { role: 'content', ... })`, the same pattern used by groups and tags.

### Event subscriptions (reactive updates)

Subscribe to these events to keep the stream live:
- `item:created` -- new item saved, may need to add to stream
- `window:load` -- a window loaded a page (triggers trackWindowLoad, which creates an item_visit)
- `tag:item-added` / `tag:item-removed` -- update tag chips on cards
- `window:closed` -- could update duration or mark visit as ended

### Screenshot / favicon cache (future dependency)

The todo references screenshots for pages. Currently there is no screenshot cache system (it is listed as a future TODO in peek-todo.md under "Media: images/videos, favicon/screenshot cache"). The initial implementation should:
- Use favicons from the `items.favicon` field (already populated by trackWindowLoad)
- Reserve the `media` slot in cards for screenshots but fill it with a domain-colored placeholder initially
- When the screenshot cache system is built, cards can start displaying actual screenshots

## 6. Implementation Phases

### Phase 1: Extension skeleton

**Goal**: A working extension that opens an empty pagestream window via command and shortcut.

Files to create:
- `extensions/pagestream/manifest.json` -- following groups manifest pattern
- `extensions/pagestream/config.js` -- ID (UUID), labels, schemas, defaults (shortcut key)
- `extensions/pagestream/background.html` -- standard boilerplate (same as groups)
- `extensions/pagestream/background.js` -- init/uninit, register shortcut, register `open pagestream` command, open window function
- `extensions/pagestream/home.html` -- basic HTML with importmap, imports for peek-carousel, peek-card, peek-input
- `extensions/pagestream/home.css` -- minimal styles
- `extensions/pagestream/home.js` -- init function, empty state

**Verification**: Run Peek, type "open pagestream" in cmd, see an empty window.

### Phase 2: Data loading and basic card rendering

**Goal**: Load visit history and render as vertical carousel of cards.

In `home.js`:
- Load recent visits via `api.datastore.queryItemVisits({ limit: 50 })`
- For each visit, fetch the item data via `api.datastore.queryItems({ type: 'url' })`
- Build a card per visit using `peek-card` (favicon, title, URL, timestamp)
- Render inside `peek-carousel` with `direction="vertical"` and `snap="center"`
- Set `--peek-carousel-height: 100vh` so the carousel fills the window
- Auto-scroll to the bottom (newest) on initial load

**Verification**: Open pagestream, see cards for recently visited pages.

### Phase 3: Active card behavior and keyboard navigation

**Goal**: The focused card is visually distinct, and vim keys navigate the stream.

- Listen to `peek-carousel`'s `slide-change` event to track active index
- Apply `selected` and `elevated` attributes to the active card
- Add CSS for active card scaling/glow effect
- Implement keyboard handler: j/k for up/down, Enter to open page
- Implement Escape handler: layered (clear search -> close window)
- Implement `api.escape.onEscape()` callback per the groups pattern

**Verification**: Navigate stream with j/k, see active card highlight, press Enter to open a page.

### Phase 4: URL input ("new tab" at bottom)

**Goal**: Cmd+L or `/` focuses a URL input at the bottom, typing a URL and pressing Enter opens it and adds to stream.

- Add `peek-input` at the bottom of the layout, below the carousel
- Cmd+L and `/` keydown handlers focus this input
- On Enter in the input, validate URL (reuse `getValidURL` pattern from page extension), call `api.window.open(url, { role: 'content' })`
- Subscribe to events so the new visit appears in the stream automatically
- After opening, clear the input and refocus the carousel

**Verification**: Press Cmd+L, type a URL, press Enter, see the page open and a new card appear.

### Phase 5: Search and tag filtering

**Goal**: Filter the stream by text search and by tag.

- Add search input at the top (peek-input, same as groups)
- Client-side filter on title, URL, domain
- Load tags per item via `api.datastore.getItemTags()`, display as chips in card footer
- Clicking a tag chip filters the stream to only visits of items with that tag
- Support clearing tag filter via Escape or a clear button

**Verification**: Search for a domain, see only matching cards. Click a tag, see filtered results.

### Phase 6: Lateral panels (left/right on active card)

**Goal**: Press h/l to reveal metadata/actions panels on the active card.

- Track lateral state: `null`, `'metadata'`, `'actions'`
- On h press: show metadata panel (slide in from left or expand card)
- On l press: show actions panel (slide in from right or expand card)
- Metadata panel: full page title, description, visit history for this page, domain info
- Actions panel: buttons for open, star, archive, copy URL, add tag
- Pressing Escape or the opposite direction key closes the lateral panel
- Implementation: CSS transforms or a simple slide-panel div inside the card, not a nested carousel

**Verification**: Focus a card, press l, see action buttons. Press h, see metadata.

### Phase 7: Live updates and polish

**Goal**: The stream updates in real time as browsing happens.

- Subscribe to relevant events: `item:created`, `window:load` (if available), etc.
- Debounce refreshes (same pattern as groups: 150ms debounce)
- When a new visit is detected, prepend/append card to carousel and auto-scroll to bottom if already at bottom
- Add relative time display on cards ("2m ago", "1h ago", "yesterday") with periodic refresh
- Add empty state messaging ("No browsing history yet. Open a page to start your stream.")
- Add loading state while data loads

**Verification**: Open pagestream, then open a new page from cmd, see the card appear in the stream.

### Phase 8: Scroll-to-load and deduplication (stretch)

**Goal**: Handle large histories efficiently and offer view modes.

- Implement infinite scroll: when scrolling near the top, load older visits
- Add view mode toggle: "all visits" vs "unique pages" vs "collapsed consecutive"
- Consider virtualized rendering if performance becomes an issue (only render visible cards)

## 7. Open Questions

1. **Window role**: Should the pagestream window use `role: 'workspace'` (like groups) or a new role? Workspace makes sense since it is a browsing surface, not content.

2. **Shortcut key**: What global shortcut should open pagestream? Suggestion: `Option+p` (p for pagestream). Needs to not conflict with existing shortcuts (`Option+Space` for cmd, `Option+g` for groups).

3. **Relationship to history viewer**: The todo has a separate "History" section. Should pagestream subsume the history viewer, or are they separate features? Pagestream is opinionated (chat-like, navigation-focused) while a history viewer might be more traditional (searchable list, date grouping).

4. **Session boundaries**: Should the stream show all visits across all time, or have session boundaries? The `item_visits` chain has `prevId`/`nextId` which could define session segments. A session might be defined as a continuous chain of visits, broken by a gap of N minutes of inactivity.

5. **Multi-window visits**: When the user has multiple content windows open, visits interleave across windows. Should the stream show all visits in one timeline, or allow filtering by window/source?

6. **Pagestream as default new-tab surface**: Should pagestream eventually become the "home" view -- what you see when you open a new empty window or "new tab"? This would replace the need for a separate new-tab page.

7. **Screenshot integration**: The feature spec mentions screenshots. This depends on the screenshot cache system (not yet built). Should Phase 1-7 proceed with favicon-only cards, or should a minimal screenshot capture be built as part of this feature?

8. **Horizontal cards for left/right metadata**: The spec says "left/right for page-specific metadata/actions". Is this a horizontal carousel nested per-card, or a slide-in panel? The plan proposes slide-in panels as simpler. Confirm this approach.

9. **Deduplication default**: The spec describes a "chat-like" view, which implies showing every visit (including revisits to the same page). Should the default really show duplicates, or deduplicate by default and show "visited 3 times" badges?

10. **Relationship to groups mode**: When pagestream is active and the user opens a page, should that page automatically be in "pagestream mode"? Or is pagestream purely a viewer that does not impose a mode on child windows?
