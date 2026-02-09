# UI Component Migration Plan

## Executive Summary

This document provides a detailed plan for migrating the Groups, Tags, and Windows extensions from manual innerHTML rendering to using the existing Lit-based component library in `app/components/`. This migration will unify UI patterns, reduce code duplication, improve maintainability, and provide consistent styling and behavior across all extensions.

---

## Current State Analysis

### Available Lit Components

The `app/components/` directory provides a comprehensive Lit-based component library:

**Layout Components:**
- `peek-grid` - Responsive CSS Grid with auto-fit columns
- `peek-card` - Flexible card container with header/body/footer slots
- `peek-list` / `peek-list-item` - Keyboard-navigable lists with selection

**Form Components:**
- `peek-input` - Input field with autocomplete suggestions
- `peek-button` - Themeable button with variants
- `peek-button-group` - Segmented controls and tag sets

**Interactive Components:**
- `peek-dialog` - Modal/non-modal dialogs
- `peek-drawer` - Slide-out panels
- `peek-popover` - Tooltips and floating content
- `peek-tabs` - Tab navigation

**Design System:**
- Shared theme tokens from `peek://theme/variables.css`
- Built-in accessibility (ARIA patterns, keyboard navigation)
- Consistent styling via CSS custom properties
- Event system with composed events

### Extension Current Implementations

#### 1. Groups Extension (`extensions/groups/`)

**Current Rendering Approach:**
- Manual DOM creation using `document.createElement()`
- Cards rendered in `.cards` container with CSS Grid
- Two card types: group cards and address cards
- Hand-rolled keyboard navigation (vim-style hjkl)
- Manual selection state management

**Current HTML Structure:**
```html
<div class="search-container">
  <input type="text" class="search-input" placeholder="Search groups...">
</div>
<main class="cards"></main>
```

**Current Card Creation (Manual):**
```javascript
const createGroupCard = (tag) => {
  const card = document.createElement('div');
  card.className = 'card group-card';

  const colorDot = document.createElement('div');
  colorDot.className = 'color-dot';
  colorDot.style.backgroundColor = tag.color || '#999';

  const content = document.createElement('div');
  content.className = 'card-content';

  const title = document.createElement('h2');
  title.className = 'card-title';
  title.textContent = tag.name;

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  meta.textContent = `${count} pages`;

  content.appendChild(title);
  content.appendChild(meta);
  card.appendChild(colorDot);
  card.appendChild(content);

  card.addEventListener('click', () => showAddresses(tag));
  return card;
};
```

**Current CSS:**
- Custom grid layout: `grid-template-columns: repeat(auto-fill, minmax(200px, 1fr))`
- Custom card styling with hover effects
- Theme tokens from `peek://theme/variables.css`

**Key Features:**
- Two-view navigation (groups list → addresses list)
- Vim-style keyboard navigation (hjkl)
- Search filtering
- Grid-based card layout
- Selection highlighting
- Escape key navigation back

#### 2. Tags Extension (`extensions/tags/`)

**Current Rendering Approach:**
- Manual DOM creation with innerHTML for cards
- Sidebar with tag chips
- Modal overlay for tag editing
- Similar manual keyboard navigation

**Current HTML Structure:**
```html
<header class="header">
  <!-- Filter buttons, add item button -->
</header>
<div class="search-container">
  <input type="text" class="search-input" placeholder="Search items and tags...">
</div>
<div class="content-wrapper">
  <aside class="tag-sidebar">
    <div class="tag-list"></div>
  </aside>
  <main class="items-container">
    <div class="cards"></div>
  </main>
</div>
<div class="modal-overlay" id="editModal">
  <!-- Edit modal structure -->
</div>
```

**Current Card Creation (innerHTML):**
```javascript
const createItemCard = (item) => {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="card-header">
      <img class="card-favicon" src="${faviconUrl}">
      <div class="card-content">
        <div class="card-title">${escapeHtml(title)}</div>
        <div class="card-url">${escapeHtml(subtitle)}</div>
      </div>
    </div>
    <div class="card-tags">
      ${tags.map(tag => `<span class="card-tag">${escapeHtml(tag.name)}</span>`).join('')}
    </div>
  `;
  card.addEventListener('click', (e) => {
    if (e.target.classList.contains('card-tag')) {
      // Handle tag filter
    } else {
      openEditModal(item);
    }
  });
  return card;
};
```

**Key Features:**
- Sidebar with tag filtering
- Multiple item types (pages, texts, tagsets, images)
- Type filters with icons
- Tag editing modal
- Multi-tag filtering (AND logic)
- Grid-based card layout

#### 3. Windows Extension (`extensions/windows/`)

**Current Rendering Approach:**
- Simplest implementation - just cards in grid
- Manual DOM creation for window cards
- Similar keyboard navigation pattern

**Current HTML Structure:**
```html
<div class="search-container">
  <input type="text" class="search-input" placeholder="Search windows...">
</div>
<main class="cards"></main>
```

**Current Card Creation:**
```javascript
const createWindowCard = (win) => {
  const card = document.createElement('div');
  card.className = 'card';

  if (faviconUrl) {
    const favicon = document.createElement('img');
    favicon.className = 'card-favicon';
    favicon.src = faviconUrl;
    card.appendChild(favicon);
  }

  const content = document.createElement('div');
  content.className = 'card-content';

  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = win.title || 'Untitled';

  const url = document.createElement('div');
  url.className = 'card-url';
  url.textContent = win.url || '';

  content.appendChild(title);
  content.appendChild(url);
  card.appendChild(content);

  card.addEventListener('click', async () => {
    await api.window.focus(win.id);
    closeWindowsView();
  });

  return card;
};
```

**Key Features:**
- Full-screen overlay mode
- Window list with favicons
- Click to focus window
- Search filtering

### Common Patterns Across Extensions

All three extensions share:
1. **Grid-based card layouts** - Auto-fill grids with responsive columns
2. **Card components** - Title, subtitle/URL, metadata, optional favicon
3. **Search filtering** - Input field with filtering logic
4. **Keyboard navigation** - Vim-style hjkl + arrow keys, grid-aware navigation
5. **Selection state** - Visual highlighting of selected card
6. **Empty states** - Messages when no results
7. **Theme tokens** - Using `peek://theme/variables.css`

### Current Rendering Logic Flow

**Groups:**
```
loadTags() → renderGroups() → createGroupCard() × N → appendChild to .cards
showAddresses() → renderAddresses() → createAddressCard() × N → appendChild to .cards
```

**Tags:**
```
loadData() → render() → renderCards() → createItemCard() × N → appendChild to .cards
               ↓
          renderTagSidebar() → tag chips
               ↓
          openEditModal() → modal with tag editing
```

**Windows:**
```
loadWindows() → renderWindows() → createWindowCard() × N → appendChild to .cards
```

---

## Component Mapping

### How peek-card Works

`peek-card` is a Lit web component that provides:
- **Slots:** `header`, default (body), `footer`, `media`
- **Properties:** `interactive`, `selected`, `elevated`, `bordered`, `glass`
- **Events:** `card-click` when interactive
- **Styling:** CSS custom properties for theming
- **Accessibility:** Proper ARIA roles when interactive

**Example Usage:**
```html
<peek-card interactive elevated selected>
  <span slot="header">Card Title</span>
  <p>Body content</p>
  <span slot="footer">Footer text</span>
</peek-card>
```

**Shadow DOM Structure:**
```html
<div class="card" role="button" tabindex="0">
  <div class="media"><slot name="media"></slot></div>
  <div class="header"><slot name="header"></slot></div>
  <div class="body"><slot></slot></div>
  <div class="footer"><slot name="footer"></slot></div>
</div>
```

### How peek-grid Works

`peek-grid` provides responsive CSS Grid:
- **Properties:** `min-item-width` (default 250px), `gap` (default 16px), `columns`, `align`, `dense`, `overlay`
- **Auto-fit behavior:** `repeat(auto-fit, minmax(min(250px, 100%), 1fr))`
- **Overlay mode:** Adds padding and max-width for full-screen overlays

**Example Usage:**
```html
<peek-grid min-item-width="200" gap="12">
  <peek-card>Card 1</peek-card>
  <peek-card>Card 2</peek-card>
</peek-grid>
```

### How peek-input Works

`peek-input` provides:
- **Properties:** `value`, `placeholder`, `type`, `suggestions`, `autofocus`
- **Autocomplete:** Dropdown with keyboard navigation
- **Events:** `input`, `change`, `suggestion-select`
- **Slots:** `prefix`, `suffix` for icons

**Example Usage:**
```html
<peek-input
  placeholder="Search..."
  .suggestions=${['tag1', 'tag2']}
  @input=${handleInput}
></peek-input>
```

### Mapping Current Patterns to Components

| Current Pattern | Component Solution | Benefits |
|----------------|-------------------|----------|
| Manual card creation | `<peek-card>` | Consistent styling, built-in interactivity, slots for flexibility |
| CSS Grid layout | `<peek-grid>` | Responsive auto-fit, configurable gap/columns, overlay mode |
| Search input | `<peek-input>` | Built-in suggestions, consistent styling, keyboard navigation |
| Tag chips | `<peek-button-group>` | Selection state, keyboard navigation, variant styles |
| Edit modal | `<peek-dialog>` | Native `<dialog>`, backdrop, Escape handling, slots |
| Sidebar tags | `<peek-list>` | Keyboard navigation, selection state, accessibility |
| Filter buttons | `<peek-button-group>` | Single/multiple selection modes, active state styling |

---

## Migration Steps

### Phase 1: Groups Extension

**Goal:** Replace manual card creation with peek-card + peek-grid

#### Step 1.1: Update HTML

**Before:**
```html
<div class="search-container">
  <input type="text" class="search-input" placeholder="Search groups...">
</div>
<main class="cards"></main>
```

**After:**
```html
<script type="module">
  import 'peek://app/components/peek-card.js';
  import 'peek://app/components/peek-grid.js';
  import 'peek://app/components/peek-input.js';
</script>

<div class="search-container">
  <peek-input
    class="search-input"
    placeholder="Search groups..."
    type="search"
  ></peek-input>
</div>

<peek-grid class="cards" min-item-width="200" gap="12"></peek-grid>
```

#### Step 1.2: Update JavaScript Card Creation

**Before:**
```javascript
const createGroupCard = (tag) => {
  const card = document.createElement('div');
  card.className = 'card group-card';

  const colorDot = document.createElement('div');
  colorDot.className = 'color-dot';
  colorDot.style.backgroundColor = tag.color || '#999';

  const content = document.createElement('div');
  content.className = 'card-content';

  const title = document.createElement('h2');
  title.className = 'card-title';
  title.textContent = tag.name;

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  meta.textContent = `${count} pages`;

  content.appendChild(title);
  content.appendChild(meta);
  card.appendChild(colorDot);
  card.appendChild(content);

  card.addEventListener('click', () => showAddresses(tag));
  return card;
};
```

**After:**
```javascript
const createGroupCard = (tag) => {
  const card = document.createElement('peek-card');
  card.interactive = true;
  card.elevated = true;
  card.dataset.tagId = tag.id;

  // Create header with color dot and title
  const header = document.createElement('div');
  header.slot = 'header';
  header.style.display = 'flex';
  header.style.alignItems = 'center';
  header.style.gap = '12px';

  const colorDot = document.createElement('div');
  colorDot.style.width = '12px';
  colorDot.style.height = '12px';
  colorDot.style.borderRadius = '50%';
  colorDot.style.backgroundColor = tag.color || '#999';

  const title = document.createElement('span');
  title.textContent = tag.name;

  header.appendChild(colorDot);
  header.appendChild(title);
  card.appendChild(header);

  // Create footer with count
  const footer = document.createElement('span');
  footer.slot = 'footer';
  const count = tag.isSpecial ? (tag.frequency || 0) : (tag.addressCount || 0);
  footer.textContent = `${count} ${count === 1 ? 'page' : 'pages'}`;
  card.appendChild(footer);

  // Add click handler
  card.addEventListener('card-click', () => showAddresses(tag));

  return card;
};
```

**Alternative (more idiomatic):**
```javascript
const createGroupCard = (tag) => {
  const card = document.createElement('peek-card');
  card.interactive = true;
  card.elevated = true;

  const count = tag.isSpecial ? (tag.frequency || 0) : (tag.addressCount || 0);

  card.innerHTML = `
    <div slot="header" style="display: flex; align-items: center; gap: 12px;">
      <div style="width: 12px; height: 12px; border-radius: 50%; background: ${tag.color || '#999'};"></div>
      <span>${tag.name}</span>
    </div>
    <span slot="footer">${count} ${count === 1 ? 'page' : 'pages'}</span>
  `;

  card.addEventListener('card-click', () => showAddresses(tag));

  return card;
};
```

#### Step 1.3: Update Address Card Creation

**Before:**
```javascript
const createAddressCard = (address) => {
  const card = document.createElement('div');
  card.className = 'card address-card';

  const favicon = document.createElement('img');
  favicon.className = 'card-favicon';
  favicon.src = address.favicon || 'data:image/svg+xml,...';

  const content = document.createElement('div');
  content.className = 'card-content';

  const title = document.createElement('h2');
  title.className = 'card-title';
  title.textContent = displayTitle;

  const url = document.createElement('div');
  url.className = 'card-url';
  url.textContent = addressUrl;

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  meta.textContent = `${address.visitCount || 0} visits · Last: ${lastVisit}`;

  content.appendChild(title);
  content.appendChild(url);
  content.appendChild(meta);
  card.appendChild(favicon);
  card.appendChild(content);

  card.addEventListener('click', async () => {
    await api.window.open(addressUrl, { width: 800, height: 600 });
  });

  return card;
};
```

**After:**
```javascript
const createAddressCard = (address) => {
  const card = document.createElement('peek-card');
  card.interactive = true;
  card.elevated = true;

  const addressUrl = address.uri || address.content;
  const displayTitle = address.title || addressUrl;
  const lastVisit = address.lastVisitAt
    ? new Date(address.lastVisitAt).toLocaleDateString()
    : 'Never';

  // Add favicon to media slot
  const favicon = document.createElement('img');
  favicon.slot = 'media';
  favicon.src = address.favicon || 'data:image/svg+xml,...';
  favicon.alt = '';
  favicon.style.width = '48px';
  favicon.style.height = '48px';
  favicon.style.objectFit = 'contain';
  card.appendChild(favicon);

  // Add content via innerHTML
  card.innerHTML += `
    <div slot="header">${escapeHtml(displayTitle)}</div>
    <div style="font-size: 12px; color: var(--base04);">${escapeHtml(addressUrl)}</div>
    <span slot="footer">${address.visitCount || 0} visits · Last: ${lastVisit}</span>
  `;

  card.addEventListener('card-click', async () => {
    await api.window.open(addressUrl, { width: 800, height: 600 });
  });

  return card;
};
```

#### Step 1.4: Update Search Input

**Before:**
```javascript
const searchInput = document.querySelector('.search-input');
searchInput.addEventListener('input', (e) => {
  state.searchQuery = e.target.value;
  renderCurrentView();
});
```

**After:**
```javascript
const searchInput = document.querySelector('peek-input');
searchInput.addEventListener('input', (e) => {
  state.searchQuery = searchInput.value;
  renderCurrentView();
});
```

#### Step 1.5: Update Selection State Management

**Before:**
```javascript
const updateSelection = () => {
  const cards = getCards();
  cards.forEach((card, i) => {
    card.classList.toggle('selected', i === state.selectedIndex);
  });

  const selected = cards[state.selectedIndex];
  if (selected) {
    selected.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
};
```

**After:**
```javascript
const updateSelection = () => {
  const cards = getCards();
  cards.forEach((card, i) => {
    // peek-card has built-in selected property
    card.selected = i === state.selectedIndex;
  });

  const selected = cards[state.selectedIndex];
  if (selected) {
    selected.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
};
```

#### Step 1.6: Update CSS

**Remove:**
- `.cards` grid layout (now handled by peek-grid)
- `.card` styles (now handled by peek-card)
- `.card:hover` and `.card.selected` (built-in)

**Keep:**
- Body/html base styles
- Any custom styling for color dots, favicons in slots

**Add CSS custom properties for customization:**
```css
peek-grid {
  --peek-grid-min-item-width: 200px;
  --peek-grid-gap: 12px;
}

peek-card {
  --peek-card-bg: var(--base01);
  --peek-card-border: transparent;
  --peek-card-radius: 8px;
  --peek-card-padding: 16px;
}

peek-card[selected] {
  --peek-card-border: var(--base0D);
}

peek-input {
  --peek-input-bg: var(--base01);
  --peek-input-border: var(--base02);
}
```

### Phase 2: Tags Extension

**Goal:** Replace cards + modal + sidebar with component equivalents

#### Step 2.1: Update HTML

**Before:**
```html
<div class="search-container">
  <input type="text" class="search-input" placeholder="Search items and tags...">
</div>
<div class="content-wrapper">
  <aside class="tag-sidebar">
    <div class="tag-list"></div>
  </aside>
  <main class="items-container">
    <div class="cards"></div>
  </main>
</div>
<div class="modal-overlay" id="editModal">
  <!-- Modal structure -->
</div>
```

**After:**
```html
<script type="module">
  import 'peek://app/components/peek-card.js';
  import 'peek://app/components/peek-grid.js';
  import 'peek://app/components/peek-input.js';
  import 'peek://app/components/peek-dialog.js';
  import 'peek://app/components/peek-list.js';
  import 'peek://app/components/peek-button.js';
  import 'peek://app/components/peek-button-group.js';
</script>

<header class="header">
  <!-- Keep existing header with filter buttons -->
</header>

<div class="search-container">
  <peek-input
    class="search-input"
    placeholder="Search items and tags..."
    type="search"
  ></peek-input>
</div>

<div class="content-wrapper">
  <aside class="tag-sidebar">
    <h2 class="sidebar-title">Tags</h2>
    <peek-list class="tag-list" selection="multiple"></peek-list>
  </aside>
  <main class="items-container">
    <peek-grid class="cards" min-item-width="200" gap="12"></peek-grid>
  </main>
</div>

<peek-dialog id="editModal" size="md" close-on-backdrop>
  <span slot="header">Edit Tags</span>
  <div class="modal-body">
    <!-- Modal content -->
  </div>
  <div slot="footer">
    <peek-button variant="ghost" onclick="editModal.close()">Close</peek-button>
  </div>
</peek-dialog>
```

#### Step 2.2: Update Tag Sidebar Rendering

**Before:**
```javascript
const renderTagSidebar = () => {
  const tags = getFilteredTags();
  tagList.innerHTML = '';

  tags.forEach(tag => {
    const chip = document.createElement('div');
    chip.className = 'tag-chip';
    if (state.activeTags.some(t => t.id === tag.id)) {
      chip.classList.add('selected');
    }
    chip.innerHTML = `
      <span class="tag-name">${escapeHtml(tag.name)}</span>
      <span class="tag-count">${count}</span>
    `;
    chip.addEventListener('click', () => {
      // Toggle tag in activeTags
    });
    tagList.appendChild(chip);
  });
};
```

**After:**
```javascript
const renderTagSidebar = () => {
  const tags = getFilteredTags();
  const tagList = document.querySelector('.tag-list');

  // Clear and rebuild
  tagList.innerHTML = '';

  tags.forEach(tag => {
    let count = 0;
    state.itemTags.forEach(itemTags => {
      if (itemTags.some(t => t.id === tag.id)) count++;
    });

    const item = document.createElement('peek-list-item');
    item.value = tag.id;

    // Tag name in main slot
    const name = document.createElement('span');
    name.textContent = tag.name;
    item.appendChild(name);

    // Count in suffix slot
    const badge = document.createElement('span');
    badge.slot = 'suffix';
    badge.textContent = count;
    badge.style.fontSize = '12px';
    badge.style.color = 'var(--base03)';
    item.appendChild(badge);

    tagList.appendChild(item);
  });

  // Update selection
  const selectedIndices = [];
  tags.forEach((tag, i) => {
    if (state.activeTags.some(t => t.id === tag.id)) {
      selectedIndices.push(i);
    }
  });
  tagList.selectedIndices = selectedIndices;

  // Handle selection changes
  tagList.addEventListener('selection-change', (e) => {
    // Update activeTags based on e.detail.selectedIndices
    state.activeTags = e.detail.selectedIndices.map(i => tags[i]);
    render();
  });
};
```

#### Step 2.3: Update Item Card Creation

**Before:**
```javascript
const createItemCard = (item) => {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="card-header">
      <img class="card-favicon" src="${faviconUrl}">
      <div class="card-content">
        <div class="card-title">${escapeHtml(title)}</div>
        <div class="card-url">${escapeHtml(subtitle)}</div>
      </div>
    </div>
    <div class="card-tags">
      ${tags.map(tag => `<span class="card-tag">${tag.name}</span>`).join('')}
    </div>
  `;
  card.addEventListener('click', (e) => {
    if (e.target.classList.contains('card-tag')) {
      // Handle tag click
    } else {
      openEditModal(item);
    }
  });
  return card;
};
```

**After:**
```javascript
const createItemCard = (item) => {
  const card = document.createElement('peek-card');
  card.interactive = true;
  card.elevated = true;

  const tags = state.itemTags.get(item.id) || [];
  const { title, subtitle, faviconUrl } = getItemDisplayInfo(item);

  // Header with favicon + title
  const header = document.createElement('div');
  header.slot = 'header';
  header.style.display = 'flex';
  header.style.alignItems = 'center';
  header.style.gap = '12px';

  const favicon = document.createElement('img');
  favicon.src = faviconUrl;
  favicon.alt = '';
  favicon.style.width = '32px';
  favicon.style.height = '32px';
  favicon.style.borderRadius = '4px';

  const titleSpan = document.createElement('span');
  titleSpan.textContent = title;
  titleSpan.style.flex = '1';
  titleSpan.style.overflow = 'hidden';
  titleSpan.style.textOverflow = 'ellipsis';

  header.appendChild(favicon);
  header.appendChild(titleSpan);
  card.appendChild(header);

  // Subtitle in body
  const subtitleDiv = document.createElement('div');
  subtitleDiv.textContent = subtitle;
  subtitleDiv.style.fontSize = '12px';
  subtitleDiv.style.color = 'var(--base04)';
  card.appendChild(subtitleDiv);

  // Tags in footer using peek-button-group
  if (tags.length > 0) {
    const footer = document.createElement('div');
    footer.slot = 'footer';
    footer.style.display = 'flex';
    footer.style.flexWrap = 'wrap';
    footer.style.gap = '4px';

    tags.forEach(tag => {
      const tagChip = document.createElement('span');
      tagChip.className = 'card-tag';
      tagChip.textContent = tag.name;
      tagChip.style.padding = '2px 8px';
      tagChip.style.fontSize = '11px';
      tagChip.style.background = 'var(--base02)';
      tagChip.style.borderRadius = '4px';
      tagChip.style.cursor = 'pointer';
      tagChip.dataset.tagId = tag.id;

      tagChip.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleTagFilter(tag);
      });

      footer.appendChild(tagChip);
    });

    card.appendChild(footer);
  }

  card.addEventListener('card-click', () => openEditModal(item));

  return card;
};
```

#### Step 2.4: Update Edit Modal

**Before:**
```javascript
const openEditModal = (item) => {
  modalOverlay.classList.add('visible');
  // Populate modal with innerHTML
};

const closeModal = () => {
  modalOverlay.classList.remove('visible');
};
```

**After:**
```javascript
const openEditModal = (item) => {
  state.editingItem = item;

  const modal = document.querySelector('#editModal');
  const tags = state.itemTags.get(item.id) || [];
  const { title, subtitle, faviconUrl } = getItemDisplayInfo(item);

  // Populate modal body (keep existing structure)
  const modalBody = modal.querySelector('.modal-body');
  modalBody.innerHTML = `
    <div class="modal-item-info">
      <img class="modal-favicon" src="${faviconUrl}" alt="">
      <div class="modal-item-details">
        <div class="modal-item-title">${escapeHtml(title)}</div>
        <div class="modal-item-url">${escapeHtml(subtitle)}</div>
      </div>
    </div>
    <!-- Rest of modal content -->
  `;

  renderCurrentTags(tags);
  renderAvailableTags(tags);

  modal.show(); // or modal.showModal() for modal mode
};
```

#### Step 2.5: Update Filter Buttons

Consider using `<peek-button-group>`:

**Before:**
```javascript
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const filter = btn.dataset.filter;
    state.activeFilter = state.activeFilter === filter ? 'all' : filter;
    render();
  });
});
```

**After (optional enhancement):**
```html
<peek-button-group class="filter-icons" selection="single" variant="ghost">
  <peek-button-group-item value="page">
    <svg slot="prefix">...</svg>
    <span slot="suffix" class="filter-count">0</span>
  </peek-button-group-item>
  <!-- More items -->
</peek-button-group>
```

```javascript
const filterGroup = document.querySelector('.filter-icons');
filterGroup.addEventListener('change', (e) => {
  state.activeFilter = e.detail.value || 'all';
  render();
});
```

### Phase 3: Windows Extension

**Goal:** Simplest migration - just cards and grid

#### Step 3.1: Update HTML

**Before:**
```html
<div class="search-container">
  <input type="text" class="search-input" placeholder="Search windows...">
</div>
<main class="cards"></main>
```

**After:**
```html
<script type="module">
  import 'peek://app/components/peek-card.js';
  import 'peek://app/components/peek-grid.js';
  import 'peek://app/components/peek-input.js';
</script>

<div class="search-container">
  <peek-input
    class="search-input"
    placeholder="Search windows..."
    type="search"
  ></peek-input>
</div>

<peek-grid class="cards" min-item-width="200" gap="12" overlay></peek-grid>
```

Note: `overlay` attribute adds optimal spacing for full-screen overlays.

#### Step 3.2: Update Window Card Creation

**Before:**
```javascript
const createWindowCard = (win) => {
  const card = document.createElement('div');
  card.className = 'card';

  if (faviconUrl) {
    const favicon = document.createElement('img');
    favicon.className = 'card-favicon';
    favicon.src = faviconUrl;
    card.appendChild(favicon);
  }

  const content = document.createElement('div');
  content.className = 'card-content';

  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = win.title || 'Untitled';

  const url = document.createElement('div');
  url.className = 'card-url';
  url.textContent = win.url || '';

  content.appendChild(title);
  content.appendChild(url);
  card.appendChild(content);

  card.addEventListener('click', async () => {
    await api.window.focus(win.id);
    closeWindowsView();
  });

  return card;
};
```

**After:**
```javascript
const createWindowCard = (win) => {
  const card = document.createElement('peek-card');
  card.interactive = true;
  card.elevated = true;
  card.glass = true; // Use glass-morphism for overlay

  // Optional favicon
  if (win.url && !win.url.startsWith('peek://')) {
    try {
      const url = new URL(win.url);
      const favicon = document.createElement('img');
      favicon.slot = 'media';
      favicon.src = `${url.origin}/favicon.ico`;
      favicon.alt = '';
      favicon.style.width = '48px';
      favicon.style.height = '48px';
      favicon.onerror = () => favicon.remove();
      card.appendChild(favicon);
    } catch (e) {
      // Invalid URL, skip favicon
    }
  }

  card.innerHTML += `
    <div slot="header">${escapeHtml(win.title || 'Untitled')}</div>
    <div style="font-size: 12px; color: var(--peek-glass-text-secondary);">
      ${escapeHtml(win.url || '')}
    </div>
  `;

  card.addEventListener('card-click', async () => {
    await api.window.focus(win.id);
    closeWindowsView();
  });

  return card;
};
```

---

## Code Examples

### Complete Before/After: Groups Extension renderGroups()

**Before:**
```javascript
const renderGroups = () => {
  const container = document.querySelector('.cards');
  container.innerHTML = '';

  let allGroups = [];
  if (state.untaggedCount > 0) {
    allGroups.push({ ...UNTAGGED_GROUP, frequency: state.untaggedCount });
  }
  const nonEmptyTags = state.tags.filter(tag => tag.addressCount > 0);
  allGroups = allGroups.concat(nonEmptyTags);

  const filteredGroups = filterGroups(allGroups);

  if (filteredGroups.length === 0) {
    const message = state.searchQuery
      ? 'No groups match your search.'
      : 'No groups yet. Tag some pages to create groups.';
    container.innerHTML = `<div class="empty-state">${message}</div>`;
    return;
  }

  filteredGroups.forEach(tag => {
    const card = createGroupCard(tag);
    container.appendChild(card);
  });

  state.selectedIndex = 0;
  updateSelection();
};
```

**After:**
```javascript
const renderGroups = () => {
  const container = document.querySelector('peek-grid.cards');
  container.innerHTML = '';

  let allGroups = [];
  if (state.untaggedCount > 0) {
    allGroups.push({ ...UNTAGGED_GROUP, frequency: state.untaggedCount });
  }
  const nonEmptyTags = state.tags.filter(tag => tag.addressCount > 0);
  allGroups = allGroups.concat(nonEmptyTags);

  const filteredGroups = filterGroups(allGroups);

  if (filteredGroups.length === 0) {
    const message = state.searchQuery
      ? 'No groups match your search.'
      : 'No groups yet. Tag some pages to create groups.';
    // Empty state can still be a regular div
    const emptyState = document.createElement('div');
    emptyState.className = 'empty-state';
    emptyState.textContent = message;
    emptyState.style.gridColumn = '1 / -1';
    container.appendChild(emptyState);
    return;
  }

  filteredGroups.forEach(tag => {
    const card = createGroupCard(tag);
    container.appendChild(card);
  });

  state.selectedIndex = 0;
  updateSelection();
};
```

### Complete Before/After: Tags Extension Modal

**Before:**
```javascript
const openEditModal = (item) => {
  state.editingItem = item;

  const modal = document.querySelector('.modal');
  const tags = state.itemTags.get(item.id) || [];

  // Set item info
  modal.querySelector('.modal-favicon').src = faviconUrl;
  modal.querySelector('.modal-item-title').textContent = title;
  modal.querySelector('.modal-item-url').textContent = subtitle;

  renderCurrentTags(tags);
  renderAvailableTags(tags);

  document.querySelector('.new-tag-input').value = '';

  modalOverlay.classList.add('visible');
};

const closeModal = () => {
  modalOverlay.classList.remove('visible');
  state.editingItem = null;
};
```

**After:**
```javascript
const openEditModal = (item) => {
  state.editingItem = item;

  const modal = document.querySelector('#editModal');
  const tags = state.itemTags.get(item.id) || [];
  const { title, subtitle, faviconUrl } = getItemDisplayInfo(item);

  // Update modal body
  const body = modal.querySelector('.modal-body');
  body.querySelector('.modal-favicon').src = faviconUrl;
  body.querySelector('.modal-item-title').textContent = title;
  body.querySelector('.modal-item-url').textContent = subtitle;

  renderCurrentTags(tags);
  renderAvailableTags(tags);

  body.querySelector('.new-tag-input').value = '';

  modal.show(); // Use native dialog API
};

const closeModal = () => {
  const modal = document.querySelector('#editModal');
  modal.close();
  state.editingItem = null;
};
```

### Complete Example: New peek-card with All Features

```javascript
const createFullFeaturedCard = (item) => {
  const card = document.createElement('peek-card');

  // Properties
  card.interactive = true;   // Clickable
  card.elevated = true;      // Shadow
  card.selected = false;     // Selection state
  card.glass = false;        // Glass-morphism (for overlays)

  // Media slot (optional)
  const media = document.createElement('img');
  media.slot = 'media';
  media.src = item.image;
  media.alt = item.title;
  card.appendChild(media);

  // Header slot
  const header = document.createElement('div');
  header.slot = 'header';
  header.innerHTML = `
    <div style="display: flex; align-items: center; gap: 12px;">
      <img src="${item.favicon}" style="width: 24px; height: 24px;">
      <span>${escapeHtml(item.title)}</span>
    </div>
  `;
  card.appendChild(header);

  // Body (default slot)
  const body = document.createElement('div');
  body.innerHTML = `<p>${escapeHtml(item.description)}</p>`;
  card.appendChild(body);

  // Footer slot
  const footer = document.createElement('div');
  footer.slot = 'footer';
  footer.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center;">
      <span>${item.date}</span>
      <div class="tags">
        ${item.tags.map(tag => `<span class="tag">${tag}</span>`).join('')}
      </div>
    </div>
  `;
  card.appendChild(footer);

  // Event handler
  card.addEventListener('card-click', (e) => {
    console.log('Card clicked:', item);
    // e.detail.originalEvent contains the native click event
  });

  return card;
};
```

---

## Missing Components & Feature Gaps

### Current Gaps

1. **No dedicated tag chip component** - Tags extension uses custom tag chips
   - **Workaround:** Use `peek-button-group` with variant="ghost" for tag sets
   - **Alternative:** Style `<span>` elements as chips with CSS

2. **No built-in empty state component** - All extensions show empty messages
   - **Solution:** Create a simple div with `.empty-state` class
   - **Future enhancement:** Add `peek-empty-state` component

3. **Grid keyboard navigation not built-in** - Manual hjkl navigation logic
   - **Workaround:** Keep existing keyboard navigation code
   - **Future enhancement:** Add grid navigation to `peek-grid`

4. **No favicon helper component** - Repetitive favicon creation
   - **Solution:** Create a helper function or small component
   - **Example:**
     ```javascript
     const createFavicon = (url, size = 32) => {
       const img = document.createElement('img');
       img.src = url || 'data:image/svg+xml,...';
       img.alt = '';
       img.style.width = `${size}px`;
       img.style.height = `${size}px`;
       img.onerror = () => img.src = 'data:image/svg+xml,...';
       return img;
     };
     ```

5. **Modal footer actions not standardized** - Each extension handles differently
   - **Solution:** Use `peek-dialog` with footer slot + `peek-button`
   - **Pattern:**
     ```html
     <peek-dialog id="myDialog">
       <span slot="header">Title</span>
       <div>Content</div>
       <div slot="footer">
         <peek-button variant="ghost" onclick="myDialog.close()">Cancel</peek-button>
         <peek-button variant="primary" onclick="save()">Save</peek-button>
       </div>
     </peek-dialog>
     ```

### Recommended New Components (Future)

1. **`peek-tag-chip`** - Reusable tag display with optional remove button
   ```html
   <peek-tag-chip removable @remove=${handleRemove}>work</peek-tag-chip>
   ```

2. **`peek-empty-state`** - Standardized empty state messaging
   ```html
   <peek-empty-state
     icon="search"
     message="No results found"
     action="Clear search"
     @action-click=${clearSearch}
   ></peek-empty-state>
   ```

3. **`peek-grid` enhancements** - Add keyboard navigation prop
   ```html
   <peek-grid keyboard-nav="vim">
     <!-- Automatic hjkl navigation -->
   </peek-grid>
   ```

---

## Testing Approach

### Test Plan Per Extension

#### Groups Extension Tests

1. **Card Rendering**
   - [ ] Group cards render with color dot, title, count
   - [ ] Address cards render with favicon, title, URL, metadata
   - [ ] Empty state shows when no groups
   - [ ] Search filtering works

2. **Interactivity**
   - [ ] Clicking group card navigates to addresses
   - [ ] Clicking address card opens window
   - [ ] peek-card `selected` state highlights correctly
   - [ ] `card-click` event fires on interaction

3. **Layout**
   - [ ] peek-grid renders responsive columns
   - [ ] Gap and min-width respect properties
   - [ ] Cards wrap correctly on resize

4. **Keyboard Navigation**
   - [ ] hjkl navigation works
   - [ ] Selection state updates
   - [ ] Enter activates selected card
   - [ ] Escape navigates back

5. **Search**
   - [ ] peek-input value binding works
   - [ ] Input events trigger filtering
   - [ ] Placeholder text displays

#### Tags Extension Tests

1. **Card Rendering**
   - [ ] Item cards render with favicons and tags
   - [ ] Tag chips in footer are clickable
   - [ ] Different item types (page, text, tagset, image) render correctly

2. **Sidebar**
   - [ ] peek-list renders tags with counts
   - [ ] Multiple selection works
   - [ ] Selection state persists

3. **Modal**
   - [ ] peek-dialog opens with correct content
   - [ ] Escape closes modal
   - [ ] Backdrop click closes modal
   - [ ] Tag editing works

4. **Filters**
   - [ ] Type filter buttons work
   - [ ] Active tag indicator shows selected tags
   - [ ] Clearing filters works

#### Windows Extension Tests

1. **Card Rendering**
   - [ ] Window cards render with title and URL
   - [ ] Optional favicons display
   - [ ] Glass effect applies in overlay mode

2. **Interactivity**
   - [ ] Clicking window card focuses window
   - [ ] Window view closes after focus

3. **Layout**
   - [ ] peek-grid overlay mode applies correct spacing
   - [ ] Cards fill screen appropriately

### Visual Regression Tests

Use Playwright or similar to capture screenshots:

1. **Baseline Screenshots**
   - Capture current manual rendering
   - Capture new peek-component rendering
   - Compare for visual parity

2. **Test Scenarios**
   - Empty state
   - Single card
   - Full grid
   - Selected state
   - Hover state (if testable)
   - Search filtering results

### Manual Testing Checklist

- [ ] All existing keyboard shortcuts work
- [ ] Performance is similar or better (card creation time)
- [ ] Memory usage is acceptable (check with DevTools)
- [ ] Theme tokens apply correctly
- [ ] Dark mode works
- [ ] Responsive behavior on small screens
- [ ] Accessibility: screen reader announces correctly
- [ ] Accessibility: keyboard focus indicators visible

---

## Rollout Strategy

### Phase 1: Proof of Concept (Week 1)

1. **Start with Windows Extension** (simplest)
   - Migrate windows.html + windows.js
   - Test thoroughly
   - Validate approach

2. **Document Learnings**
   - What worked well?
   - What was harder than expected?
   - Update migration plan accordingly

### Phase 2: Groups Extension (Week 2)

1. **Migrate Groups**
   - Follow learnings from Windows
   - Handle two-view navigation
   - Test keyboard navigation thoroughly

2. **Refine Patterns**
   - Create helper functions for common patterns
   - Document best practices

### Phase 3: Tags Extension (Week 3)

1. **Migrate Tags** (most complex)
   - Sidebar with peek-list
   - Modal with peek-dialog
   - Tag filtering

2. **Create Reusable Components**
   - Extract tag chip pattern
   - Extract favicon helper

### Phase 4: Polish & Optimization (Week 4)

1. **Performance Tuning**
   - Profile card creation
   - Optimize rendering
   - Reduce re-renders

2. **Accessibility Audit**
   - Test with screen readers
   - Verify keyboard navigation
   - Check ARIA labels

3. **Documentation**
   - Update extension README files
   - Document component usage patterns
   - Create examples for future extensions

### Rollback Plan

Each extension keeps existing code in commented-out form:

```javascript
// MIGRATION: Old manual rendering (for rollback)
/*
const createGroupCard_OLD = (tag) => {
  // ... old code
};
*/

// New peek-component rendering
const createGroupCard = (tag) => {
  // ... new code
};
```

To rollback:
1. Rename new function to `_NEW`
2. Uncomment old function
3. Update callers
4. Revert HTML changes

---

## Performance Considerations

### Potential Performance Impact

1. **Shadow DOM Overhead**
   - Each peek-card creates a shadow root
   - Mitigated by: Modern browsers optimize shadow DOM well

2. **Component Creation Cost**
   - `customElements.define()` has initial cost
   - Mitigated by: Lazy loading components only when needed

3. **Event Delegation**
   - Custom events may have slight overhead
   - Mitigated by: Minimal - composed events are efficient

### Optimizations

1. **Batch DOM Updates**
   ```javascript
   const fragment = document.createDocumentFragment();
   items.forEach(item => {
     fragment.appendChild(createItemCard(item));
   });
   container.appendChild(fragment);
   ```

2. **Reuse Cards (Virtual Scrolling for Large Lists)**
   - If rendering >100 cards, consider virtual scrolling
   - peek-grid could be enhanced to support this

3. **Lazy Load Components**
   ```javascript
   // Only load when needed
   if (!customElements.get('peek-dialog')) {
     await import('peek://app/components/peek-dialog.js');
   }
   ```

4. **CSS Custom Properties Instead of Inline Styles**
   ```javascript
   // Instead of:
   element.style.color = 'red';

   // Use:
   element.style.setProperty('--custom-color', 'red');
   ```

### Performance Testing

1. **Measure Card Creation Time**
   ```javascript
   console.time('createCards');
   for (let i = 0; i < 100; i++) {
     createGroupCard(mockTag);
   }
   console.timeEnd('createCards');
   ```

2. **Memory Profiling**
   - Use Chrome DevTools Memory Profiler
   - Compare before/after heap snapshots
   - Look for memory leaks

3. **Frame Rate Monitoring**
   - Use Performance panel in DevTools
   - Ensure scrolling stays at 60fps
   - Profile during keyboard navigation

---

## Migration Checklist

### Groups Extension

- [ ] Update HTML with component imports
- [ ] Replace `.cards` div with `peek-grid`
- [ ] Replace `.search-input` with `peek-input`
- [ ] Update `createGroupCard()` to use `peek-card`
- [ ] Update `createAddressCard()` to use `peek-card`
- [ ] Update `updateSelection()` to use card.selected property
- [ ] Update CSS to use component custom properties
- [ ] Remove obsolete CSS rules
- [ ] Test keyboard navigation
- [ ] Test two-view navigation
- [ ] Test search filtering
- [ ] Test escape key handling
- [ ] Visual regression test
- [ ] Accessibility test

### Tags Extension

- [ ] Update HTML with component imports
- [ ] Replace `.cards` with `peek-grid`
- [ ] Replace `.search-input` with `peek-input`
- [ ] Replace `.tag-list` with `peek-list`
- [ ] Replace `.modal-overlay` with `peek-dialog`
- [ ] Update `createItemCard()` to use `peek-card`
- [ ] Update `renderTagSidebar()` to use `peek-list`
- [ ] Update `openEditModal()` to use dialog API
- [ ] Update filter buttons (optional: use `peek-button-group`)
- [ ] Update CSS for components
- [ ] Test sidebar tag selection
- [ ] Test modal open/close
- [ ] Test tag filtering
- [ ] Test item card rendering for all types
- [ ] Visual regression test
- [ ] Accessibility test

### Windows Extension

- [ ] Update HTML with component imports
- [ ] Replace `.cards` div with `peek-grid overlay`
- [ ] Replace `.search-input` with `peek-input`
- [ ] Update `createWindowCard()` to use `peek-card glass`
- [ ] Update CSS for glass-morphism
- [ ] Test window focus behavior
- [ ] Test overlay mode layout
- [ ] Visual regression test
- [ ] Accessibility test

---

## Example: Complete Migrated Groups Extension

### groups/home.html

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-inline';">
    <meta name="viewport" content="width=device-width,user-scalable=no,initial-scale=1">
    <title>Groups</title>
    <link rel="stylesheet" type="text/css" href="home.css">

    <script type="module">
      import 'peek://app/components/peek-card.js';
      import 'peek://app/components/peek-grid.js';
      import 'peek://app/components/peek-input.js';
    </script>
  </head>
  <body>
    <div class="search-container">
      <peek-input
        class="search-input"
        placeholder="Search groups..."
        type="search"
      ></peek-input>
    </div>

    <peek-grid class="cards" min-item-width="200" gap="12"></peek-grid>

    <script type="module" src="home.js"></script>
  </body>
</html>
```

### groups/home.css (Updated)

```css
/* Import theme variables */
@import url('peek://theme/variables.css');

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html {
  font-family: var(--theme-font-sans);
  -webkit-font-smoothing: antialiased;
  font-size: 14px;
  line-height: 1.5;
}

body {
  background: var(--base00);
  color: var(--base05);
  min-height: 100vh;
}

/* Search */
.search-container {
  padding: 24px 24px 0 24px;
}

/* Component customization */
peek-input {
  width: 100%;
  --peek-input-bg: var(--base01);
  --peek-input-border: var(--base02);
  --peek-input-height: 44px;
}

peek-input:focus-within {
  --peek-input-border: var(--base0D);
}

peek-grid {
  padding: 24px;
  --peek-grid-min-item-width: 200px;
  --peek-grid-gap: 12px;
}

peek-card {
  --peek-card-bg: var(--base01);
  --peek-card-border: transparent;
  --peek-card-radius: 8px;
  --peek-card-padding: 16px;
}

peek-card[selected] {
  --peek-card-bg: var(--base02);
  --peek-card-border: var(--base0D);
}

/* Empty state */
.empty-state {
  grid-column: 1 / -1;
  text-align: center;
  padding: 48px 24px;
  color: var(--base03);
  font-size: 15px;
}

/* Custom styles for card content */
.color-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  flex-shrink: 0;
}

.card-favicon {
  width: 32px;
  height: 32px;
  border-radius: 4px;
  flex-shrink: 0;
  background: var(--base02);
  object-fit: contain;
}
```

### groups/home.js (Key Changes)

```javascript
/**
 * Groups - Tag-based grouping of addresses
 * Now using peek-component library for UI
 */

const api = window.app;
const debug = api.debug;

// ... (state, helpers unchanged) ...

/**
 * Create a card element for a group (tag)
 * MIGRATED to use peek-card component
 */
const createGroupCard = (tag) => {
  const card = document.createElement('peek-card');
  card.interactive = true;
  card.elevated = true;
  if (tag.isSpecial) {
    card.classList.add('special-group');
  }
  card.dataset.tagId = tag.id;

  // Header with color dot and name
  const header = document.createElement('div');
  header.slot = 'header';
  header.style.display = 'flex';
  header.style.alignItems = 'center';
  header.style.gap = '12px';

  const colorDot = document.createElement('div');
  colorDot.className = 'color-dot';
  colorDot.style.backgroundColor = tag.color || '#999';

  const name = document.createElement('span');
  name.textContent = tag.name;

  header.appendChild(colorDot);
  header.appendChild(name);
  card.appendChild(header);

  // Footer with count
  const footer = document.createElement('span');
  footer.slot = 'footer';
  const count = tag.isSpecial ? (tag.frequency || 0) : (tag.addressCount || 0);
  footer.textContent = `${count} ${count === 1 ? 'page' : 'pages'}`;
  card.appendChild(footer);

  // Click to view addresses in this group
  card.addEventListener('card-click', () => showAddresses(tag));

  return card;
};

/**
 * Create a card element for an address
 * MIGRATED to use peek-card component
 */
const createAddressCard = (address) => {
  const card = document.createElement('peek-card');
  card.interactive = true;
  card.elevated = true;
  card.dataset.addressId = address.id;

  const addressUrl = address.uri || address.content;

  let displayTitle = address.title;
  if (!displayTitle && address.metadata) {
    try {
      const meta = typeof address.metadata === 'string' ? JSON.parse(address.metadata) : address.metadata;
      displayTitle = meta.title;
    } catch (e) {
      // Ignore parse errors
    }
  }
  displayTitle = displayTitle || addressUrl;

  // Favicon in media slot
  const favicon = document.createElement('img');
  favicon.slot = 'media';
  favicon.className = 'card-favicon';
  favicon.src = address.favicon || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🌐</text></svg>';
  favicon.alt = '';
  favicon.onerror = () => {
    favicon.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🌐</text></svg>';
  };
  card.appendChild(favicon);

  // Header with title
  const header = document.createElement('div');
  header.slot = 'header';
  header.textContent = displayTitle;
  card.appendChild(header);

  // Body with URL
  const url = document.createElement('div');
  url.textContent = addressUrl;
  url.style.fontSize = '12px';
  url.style.color = 'var(--base04)';
  url.style.overflow = 'hidden';
  url.style.textOverflow = 'ellipsis';
  url.style.whiteSpace = 'nowrap';
  card.appendChild(url);

  // Footer with metadata
  const footer = document.createElement('span');
  footer.slot = 'footer';
  const lastVisit = address.lastVisitAt ? new Date(address.lastVisitAt).toLocaleDateString() : 'Never';
  footer.textContent = `${address.visitCount || 0} visits · Last: ${lastVisit}`;
  card.appendChild(footer);

  // Click to open address
  card.addEventListener('card-click', async () => {
    debug && console.log('Opening address:', addressUrl);
    const result = await api.window.open(addressUrl, {
      width: 800,
      height: 600
    });
    debug && console.log('Window opened:', result);
  });

  return card;
};

/**
 * Update visual selection on cards
 * UPDATED to use peek-card selected property
 */
const updateSelection = () => {
  const cards = getCards();
  cards.forEach((card, i) => {
    card.selected = i === state.selectedIndex;
  });

  const selected = cards[state.selectedIndex];
  if (selected) {
    selected.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
};

/**
 * Render groups cards
 * UPDATED to use peek-grid
 */
const renderGroups = () => {
  const container = document.querySelector('peek-grid.cards');
  container.innerHTML = '';

  let allGroups = [];
  if (state.untaggedCount > 0) {
    allGroups.push({ ...UNTAGGED_GROUP, frequency: state.untaggedCount });
  }

  const nonEmptyTags = state.tags.filter(tag => tag.addressCount > 0);
  allGroups = allGroups.concat(nonEmptyTags);

  const filteredGroups = filterGroups(allGroups);

  if (filteredGroups.length === 0) {
    const message = state.searchQuery
      ? 'No groups match your search.'
      : 'No groups yet. Tag some pages to create groups.';
    const emptyState = document.createElement('div');
    emptyState.className = 'empty-state';
    emptyState.textContent = message;
    container.appendChild(emptyState);
    return;
  }

  filteredGroups.forEach(tag => {
    const card = createGroupCard(tag);
    container.appendChild(card);
  });

  state.selectedIndex = 0;
  updateSelection();
};

// ... rest of code similar, with peek-input handling ...

const init = async () => {
  debug && console.log('Groups init');

  api.escape.onEscape(handleEscape);
  await loadTags();

  // Set up search input (UPDATED for peek-input)
  const searchInput = document.querySelector('peek-input.search-input');
  searchInput.addEventListener('input', (e) => {
    state.searchQuery = searchInput.value;
    renderCurrentView();
  });

  // ... rest of init unchanged ...

  showGroups();
};

document.addEventListener('DOMContentLoaded', init);
```

---

## Conclusion

This migration plan provides a comprehensive roadmap for converting the Groups, Tags, and Windows extensions from manual DOM manipulation to using the Lit-based component library. The migration will:

1. **Reduce code duplication** - Shared card, grid, and input components
2. **Improve maintainability** - Declarative component usage vs imperative DOM creation
3. **Ensure consistency** - All extensions use same UI patterns
4. **Enhance accessibility** - Built-in ARIA patterns and keyboard navigation
5. **Simplify theming** - CSS custom properties for easy customization
6. **Future-proof** - Easier to add new features and extensions

The phased approach (Windows → Groups → Tags) allows for learning and refinement at each step, with clear rollback options if needed. The detailed code examples provide concrete guidance for implementation.
