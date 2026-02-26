/**
 * Search - Unified search across items, history, tags, and groups
 *
 * Searches across:
 * - Items (URLs, notes, tagsets)
 * - Tags
 * - Addresses/history
 *
 * Results are grouped by type with relevance-based ordering.
 */

const api = window.app;
const debug = api.debug;

// ===== Utilities =====

/**
 * Simple debounce helper
 */
const debounce = (fn, ms) => {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
};

/**
 * Escape HTML to prevent XSS
 */
const escapeHtml = (str) => {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
};

/**
 * Highlight matching text in a string
 */
const highlightMatch = (text, query) => {
  if (!text || !query) return escapeHtml(text);
  const escaped = escapeHtml(text);
  const escapedQuery = escapeHtml(query);
  // Case-insensitive highlight
  const regex = new RegExp(`(${escapedQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return escaped.replace(regex, '<mark>$1</mark>');
};

/**
 * Format a timestamp into a relative or absolute date string
 */
const formatDate = (timestamp) => {
  if (!timestamp) return '';
  const date = new Date(typeof timestamp === 'number' ? timestamp : Date.parse(timestamp));
  if (isNaN(date.getTime())) return '';
  const now = new Date();
  const diff = now - date;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
};

/**
 * Get title from item metadata
 */
const getItemTitle = (item) => {
  if (item.title) return item.title;
  if (item.metadata) {
    try {
      const meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata;
      if (meta.title) return meta.title;
    } catch (e) {
      // Ignore parse errors
    }
  }
  return null;
};

/**
 * Check if a URL is a navigable web URL
 */
const isWebUrl = (url) => {
  if (!url) return false;
  return url.startsWith('http://') || url.startsWith('https://');
};

// ===== State =====

let state = {
  query: '',
  results: [],      // Flat list of result objects
  selectedIndex: 0,
  totalCount: 0
};

// Expose state for testing
window._searchState = state;

// ===== Data fetching =====

/**
 * Search across all data sources
 * Returns grouped results: { urls: [], notes: [], tags: [], tagsets: [] }
 */
const performSearch = async (query) => {
  if (!query || query.trim().length === 0) {
    return { urls: [], notes: [], tags: [], tagsets: [] };
  }

  const q = query.toLowerCase().trim();

  // Fetch all data sources in parallel
  const [itemsResult, tagsResult, historyResult] = await Promise.all([
    api.datastore.queryItems({}),
    api.datastore.getTagsByFrecency(),
    api.datastore.getHistory({})
  ]);

  const results = { urls: [], notes: [], tags: [], tagsets: [] };

  // Search items
  if (itemsResult.success && itemsResult.data) {
    for (const item of itemsResult.data) {
      // Skip deleted items
      if (item.deleted) continue;

      const title = getItemTitle(item) || '';
      const content = item.content || '';
      const titleMatch = title.toLowerCase().includes(q);
      const contentMatch = content.toLowerCase().includes(q);

      if (!titleMatch && !contentMatch) continue;

      // Calculate relevance score (title match scores higher)
      const relevance = (titleMatch ? 10 : 0) + (contentMatch ? 5 : 0);

      const resultItem = {
        id: item.id,
        type: item.type,
        title: title || content,
        content: content,
        preview: item.type === 'url' ? content : (content.length > 100 ? content.substring(0, 100) + '...' : content),
        updatedAt: item.updatedAt,
        relevance,
        tags: [] // Will be populated below
      };

      // Get tags for this item
      try {
        const itemTagsResult = await api.datastore.getItemTags(item.id);
        if (itemTagsResult.success) {
          resultItem.tags = itemTagsResult.data.map(t => t.name);
        }
      } catch (e) {
        // Ignore tag fetch errors
      }

      if (item.type === 'url') {
        results.urls.push(resultItem);
      } else if (item.type === 'text') {
        results.notes.push(resultItem);
      } else if (item.type === 'tagset') {
        results.tagsets.push(resultItem);
      }
    }
  }

  // Search tags
  if (tagsResult.success && tagsResult.data) {
    for (const tag of tagsResult.data) {
      const nameMatch = tag.name.toLowerCase().includes(q);
      if (!nameMatch) continue;

      results.tags.push({
        id: tag.id,
        type: 'tag',
        title: tag.name,
        content: '',
        preview: `Tag (used ${tag.frequency || 0}x)`,
        color: tag.color,
        frequency: tag.frequency || 0,
        relevance: 8, // Tags have moderate relevance
        tags: []
      });
    }
  }

  // Also check history/addresses for additional title/URL matches not already in items
  if (historyResult.success && historyResult.data) {
    const existingUrls = new Set(results.urls.map(r => r.content));

    for (const entry of historyResult.data) {
      const url = entry.uri || entry.url || '';
      if (!isWebUrl(url)) continue;
      if (existingUrls.has(url)) continue;

      const title = entry.title || '';
      const titleMatch = title.toLowerCase().includes(q);
      const urlMatch = url.toLowerCase().includes(q);

      if (!titleMatch && !urlMatch) continue;

      const relevance = (titleMatch ? 10 : 0) + (urlMatch ? 5 : 0);

      results.urls.push({
        id: entry.id || url,
        type: 'url',
        title: title || url,
        content: url,
        preview: url,
        updatedAt: entry.lastVisit || entry.updatedAt,
        visitCount: entry.visitCount || 0,
        relevance,
        tags: [],
        fromHistory: true
      });
    }
  }

  // Sort each group by relevance then recency
  const sortByRelevance = (a, b) => {
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    // Then by recency
    const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return bTime - aTime;
  };

  results.urls.sort(sortByRelevance);
  results.notes.sort(sortByRelevance);
  results.tags.sort(sortByRelevance);
  results.tagsets.sort(sortByRelevance);

  return results;
};

// ===== Rendering =====

/**
 * Render all results grouped by type
 */
const renderResults = (grouped, query) => {
  const container = document.getElementById('results');
  const emptyState = document.getElementById('empty-state');
  const resultCount = document.getElementById('result-count');

  container.innerHTML = '';

  // Flatten results into ordered groups
  const groups = [
    { label: 'URLs', items: grouped.urls, icon: 'link' },
    { label: 'Notes', items: grouped.notes, icon: 'note' },
    { label: 'Tags', items: grouped.tags, icon: 'tag' },
    { label: 'Tagsets', items: grouped.tagsets, icon: 'tagset' }
  ];

  // Build flat list for keyboard navigation
  state.results = [];
  let totalCount = 0;

  for (const group of groups) {
    if (group.items.length === 0) continue;
    totalCount += group.items.length;
    for (const item of group.items) {
      state.results.push({ ...item, groupLabel: group.label });
    }
  }

  state.totalCount = totalCount;

  // Update result count
  if (totalCount > 0) {
    resultCount.textContent = `${totalCount} result${totalCount !== 1 ? 's' : ''}`;
  } else {
    resultCount.textContent = '';
  }

  // Show/hide empty state
  if (!query || query.trim().length === 0) {
    emptyState.style.display = '';
    container.style.display = 'none';
    resultCount.textContent = '';
    return;
  }

  emptyState.style.display = 'none';
  container.style.display = '';

  if (totalCount === 0) {
    container.innerHTML = '<div class="no-results">No results found.</div>';
    return;
  }

  // Render groups
  let flatIndex = 0;
  for (const group of groups) {
    if (group.items.length === 0) continue;

    const groupEl = document.createElement('div');
    groupEl.className = 'result-group';

    const header = document.createElement('div');
    header.className = 'result-group-header';
    header.textContent = `${group.label} (${group.items.length})`;
    groupEl.appendChild(header);

    for (const item of group.items) {
      const el = createResultElement(item, query, flatIndex);
      groupEl.appendChild(el);
      flatIndex++;
    }

    container.appendChild(groupEl);
  }

  // Reset selection
  state.selectedIndex = 0;
  updateSelection();
};

/**
 * Create a single result item element
 */
const createResultElement = (item, query, index) => {
  const el = document.createElement('div');
  el.className = 'result-item';
  el.dataset.index = index;
  el.dataset.type = item.type;
  el.dataset.id = item.id;

  // Icon
  const icon = document.createElement('div');
  icon.className = 'result-icon';
  icon.innerHTML = getTypeIcon(item.type);
  el.appendChild(icon);

  // Content
  const content = document.createElement('div');
  content.className = 'result-content';

  // Title
  const title = document.createElement('div');
  title.className = 'result-title';
  title.innerHTML = highlightMatch(item.title || item.content, query);
  content.appendChild(title);

  // Preview (for URLs show the URL below title, for notes show content preview)
  if (item.preview && item.preview !== item.title) {
    const preview = document.createElement('div');
    preview.className = 'result-preview';
    preview.innerHTML = highlightMatch(item.preview, query);
    content.appendChild(preview);
  }

  // Meta (tags + date)
  const meta = document.createElement('div');
  meta.className = 'result-meta';

  // Tags
  if (item.tags && item.tags.length > 0) {
    const displayTags = item.tags.slice(0, 3); // Show max 3 tags
    for (const tagName of displayTags) {
      const tagEl = document.createElement('span');
      tagEl.className = 'result-tag';
      tagEl.textContent = tagName;
      meta.appendChild(tagEl);
    }
    if (item.tags.length > 3) {
      const more = document.createElement('span');
      more.className = 'result-tag';
      more.textContent = `+${item.tags.length - 3}`;
      meta.appendChild(more);
    }
  }

  // Date
  if (item.updatedAt) {
    const date = document.createElement('span');
    date.className = 'result-date';
    date.textContent = formatDate(item.updatedAt);
    meta.appendChild(date);
  }

  if (meta.children.length > 0) {
    content.appendChild(meta);
  }

  el.appendChild(content);

  // Click handler
  el.addEventListener('click', () => {
    state.selectedIndex = index;
    updateSelection();
    activateResult(item);
  });

  return el;
};

/**
 * Get icon HTML for a result type
 */
const getTypeIcon = (type) => {
  switch (type) {
    case 'url':
      return '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6.5 11.5L4 14a2.12 2.12 0 01-3-3l2.5-2.5M9.5 4.5L12 2a2.12 2.12 0 013 3l-2.5 2.5M5.5 10.5l5-5"/></svg>';
    case 'text':
      return '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 3h10M3 6.5h7M3 10h9M3 13.5h5"/></svg>';
    case 'tag':
      return '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 2h5.5l6.5 6.5-5.5 5.5L2 7.5V2z"/><circle cx="5.5" cy="5.5" r="1" fill="currentColor"/></svg>';
    case 'tagset':
      return '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 3h5l5.5 5.5-5 5L1 8V3z"/><path d="M5 1h5l5.5 5.5-5 5" opacity="0.5"/></svg>';
    default:
      return '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/></svg>';
  }
};

/**
 * Activate (open) a result
 */
const activateResult = async (item) => {
  debug && console.log('[search] Activating result:', item.type, item.id);

  if (item.type === 'url') {
    // Open URL in content window
    const url = item.content;
    if (isWebUrl(url)) {
      await api.window.open(url, {
        role: 'content',
        key: url,
        width: 1024,
        height: 768
      });
    }
  } else if (item.type === 'tag') {
    // Open the tags view filtered to this tag
    api.publish('editor:open', { itemId: item.id }, api.scopes.GLOBAL);
  } else if (item.type === 'text' || item.type === 'tagset') {
    // Open in editor
    api.publish('editor:open', { itemId: item.id }, api.scopes.GLOBAL);
  }
};

// ===== Keyboard navigation =====

/**
 * Get all result item elements
 */
const getResultElements = () => {
  return Array.from(document.querySelectorAll('.result-item'));
};

/**
 * Update visual selection
 */
const updateSelection = () => {
  const elements = getResultElements();
  elements.forEach((el, i) => {
    el.classList.toggle('selected', i === state.selectedIndex);
  });

  // Scroll selected into view
  const selected = elements[state.selectedIndex];
  if (selected) {
    selected.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
};

/**
 * Handle escape for internal navigation
 */
const handleEscape = () => {
  const searchInput = document.getElementById('search-input');

  // If search has content, clear it
  if (state.query) {
    state.query = '';
    searchInput.value = '';
    state.results = [];
    state.selectedIndex = 0;
    renderResults({ urls: [], notes: [], tags: [], tagsets: [] }, '');
    return { handled: true };
  }

  // Otherwise let the window close
  return { handled: false };
};

/**
 * Handle keyboard events
 */
const handleKeydown = (e) => {
  const searchInput = document.getElementById('search-input');
  const isSearchFocused = document.activeElement === searchInput ||
    (searchInput && searchInput.shadowRoot?.activeElement);

  // Don't intercept regular typing in search input
  if (isSearchFocused && !['ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(e.key)) {
    return;
  }

  const elements = getResultElements();
  if (elements.length === 0 && !['Escape'].includes(e.key)) return;

  switch (e.key) {
    case 'ArrowDown':
    case 'j':
      if (isSearchFocused && e.key === 'j') return; // Let j through in search
      e.preventDefault();
      if (state.selectedIndex < elements.length - 1) {
        state.selectedIndex++;
        updateSelection();
      }
      break;
    case 'ArrowUp':
    case 'k':
      if (isSearchFocused && e.key === 'k') return; // Let k through in search
      e.preventDefault();
      if (state.selectedIndex > 0) {
        state.selectedIndex--;
        updateSelection();
      }
      break;
    case 'Enter':
      e.preventDefault();
      if (state.results[state.selectedIndex]) {
        activateResult(state.results[state.selectedIndex]);
      }
      break;
  }
};

// ===== Initialization =====

const init = async () => {
  debug && console.log('[search] init');

  // Register escape handler
  api.escape.onEscape(handleEscape);

  // Set up search input
  const searchInput = document.getElementById('search-input');

  // Auto-focus search input
  setTimeout(() => {
    searchInput.focus();
  }, 100);

  // Debounced search
  const debouncedSearch = debounce(async (query) => {
    state.query = query;
    if (!query || query.trim().length === 0) {
      state.results = [];
      state.selectedIndex = 0;
      renderResults({ urls: [], notes: [], tags: [], tagsets: [] }, '');
      return;
    }

    const results = await performSearch(query);
    renderResults(results, query);
  }, 200);

  searchInput.addEventListener('input', (e) => {
    debouncedSearch(e.target.value);
  });

  // Keyboard navigation
  document.addEventListener('keydown', handleKeydown);

  // Re-focus search input on window focus
  window.addEventListener('focus', () => {
    searchInput.focus();
  });
};

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', init);
