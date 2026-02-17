/**
 * Pagestream - Vertical, chat-like navigational interface for web history
 *
 * Displays a vertical stream of page cards from visit history.
 * Newest at bottom (chat-like), keyboard navigable.
 * Click/Enter opens the URL in a page host window.
 */

const api = window.app;
const debug = api.debug;

const debounce = (fn, ms) => {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
};

const formatRelativeTime = (timestamp) => {
  if (!timestamp) return '';
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
};

const extractDomain = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

const isWebUrl = (url) => {
  if (!url) return false;
  return url.startsWith('http://') || url.startsWith('https://');
};

// ===== State =====

const ANIM_DURATION = '0.2s';
const ANIM_EASE = 'cubic-bezier(0.4, 0, 0.2, 1)';

let state = {
  visits: [],
  items: new Map(),
  selectedIndex: -1,
  filterTagId: null,
  filterTagName: null,
  isLoading: true,
  animating: false,
  openWindowId: null,
  openCardIndex: -1,
};

window._pagestreamState = state;

// ===== Data Loading =====

const loadVisits = async () => {
  state.isLoading = true;

  try {
    const visitsResult = await api.datastore.queryItemVisits({ limit: 100 });
    if (!visitsResult.success) {
      console.error('[pagestream] Failed to load visits:', visitsResult.error);
      state.visits = [];
      return;
    }

    const visits = visitsResult.data || [];

    const itemsResult = await api.datastore.queryItems({ type: 'url' });
    if (itemsResult.success && itemsResult.data) {
      state.items.clear();
      for (const item of itemsResult.data) {
        state.items.set(item.id, item);
      }
    }

    state.visits = visits
      .map(visit => {
        const item = state.items.get(visit.itemId);
        if (!item || !isWebUrl(item.content)) return null;
        return { visit, item };
      })
      .filter(Boolean)
      .reverse();

    debug && console.log('[pagestream] Loaded', state.visits.length, 'visits');
  } catch (err) {
    console.error('[pagestream] Error loading visits:', err);
    state.visits = [];
  } finally {
    state.isLoading = false;
  }
};

const loadItemTags = async (itemId) => {
  try {
    const result = await api.datastore.getItemTags(itemId);
    if (result.success) return result.data || [];
  } catch {
    // Ignore
  }
  return [];
};

// ===== Rendering =====

const getFilteredVisits = () => {
  let filtered = state.visits;

  filtered = filtered.filter(({ item }, i, arr) => {
    if (i === 0) return true;
    return item.content !== arr[i - 1].item.content;
  });

  return filtered;
};

const getCards = () => {
  return Array.from(document.querySelectorAll('#stream peek-card'));
};

const updateSelection = (animate = true) => {
  const cards = getCards();
  cards.forEach((card, i) => {
    const isActive = (i === state.selectedIndex);
    card.selected = false;
    card.elevated = false;
    if (isActive) {
      card.classList.add('active-card');
      const override = card.shadowRoot?.querySelector('.pagestream-override');
      if (override) {
        override.textContent = `
          .card, .card:hover, .card:active, .card:focus-visible {
            background: #3a3a3c !important;
            border: none !important;
            border-radius: 8px !important;
            outline: none !important;
            box-shadow: none !important;
            overflow: hidden !important;
          }
        `;
      }
    } else {
      card.classList.remove('active-card');
      const override = card.shadowRoot?.querySelector('.pagestream-override');
      if (override) {
        override.textContent = `
          .card, .card:hover, .card:active, .card:focus-visible {
            background: #2c2c2e !important;
            border: none !important;
            border-radius: 8px !important;
            outline: none !important;
            box-shadow: none !important;
            overflow: hidden !important;
          }
        `;
      }
    }
  });

  const selected = cards[state.selectedIndex];
  if (selected) {
    scrollCardToCenter(selected, animate);
  }
};

/** Scroll so that the given card is vertically centered in the stream */
const scrollCardToCenter = (card, animate = true) => {
  const container = document.getElementById('stream');
  const cardRect = card.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();

  // Card center relative to container's scroll position
  const cardCenterInContainer = (card.offsetTop + cardRect.height / 2);
  const targetScrollTop = cardCenterInContainer - container.clientHeight / 2;

  container.scrollTo({
    top: targetScrollTop,
    behavior: animate ? 'smooth' : 'instant'
  });
};

const render = (initialLoad = false) => {
  const container = document.getElementById('stream');
  const emptyState = document.getElementById('empty-state');
  const filtered = getFilteredVisits();

  // Remove old cards and spacers
  container.querySelectorAll('peek-card, .stream-spacer').forEach(el => el.remove());

  if (state.isLoading) {
    emptyState.textContent = 'Loading history...';
    emptyState.style.display = 'flex';
    return;
  }

  if (filtered.length === 0) {
    emptyState.textContent = 'No browsing history yet. Open a page to start your stream.';
    emptyState.style.display = 'flex';
    return;
  }

  emptyState.style.display = 'none';

  // Add top spacer — half viewport height so first card can be centered
  const spacerHeight = Math.floor(container.clientHeight / 2 - 60);
  const topSpacer = document.createElement('div');
  topSpacer.className = 'stream-spacer';
  topSpacer.style.height = spacerHeight + 'px';
  container.appendChild(topSpacer);

  filtered.forEach(({ visit, item }, index) => {
    const card = createVisitCard(visit, item, index);
    container.appendChild(card);
  });

  // Add bottom spacer
  const bottomSpacer = document.createElement('div');
  bottomSpacer.className = 'stream-spacer';
  bottomSpacer.style.height = spacerHeight + 'px';
  container.appendChild(bottomSpacer);

  if (state.selectedIndex < 0 || state.selectedIndex >= filtered.length) {
    state.selectedIndex = filtered.length - 1;
  }
  // On initial load, snap to center instantly (no smooth scroll)
  updateSelection(!initialLoad);
};

// ===== Open URL in Page Host (with animation) =====

// Default page host size — loaded from core prefs, with fallback
let PAGE_HOST_WIDTH = 800;
let PAGE_HOST_HEIGHT = 600;

const CORE_SETTINGS_ID = '8aadaae5-2594-4968-aba0-707f0d371cfb';

const loadPageHostDefaults = async () => {
  try {
    if (api?.settings?.getExtKey) {
      const result = await api.settings.getExtKey(CORE_SETTINGS_ID, 'prefs');
      if (result.success && result.data) {
        if (result.data.pageWidth) PAGE_HOST_WIDTH = result.data.pageWidth;
        if (result.data.pageHeight) PAGE_HOST_HEIGHT = result.data.pageHeight;
        debug && console.log('[pagestream] Loaded page defaults from core:', PAGE_HOST_WIDTH, 'x', PAGE_HOST_HEIGHT);
      }
    }
  } catch (err) {
    debug && console.log('[pagestream] Could not load core prefs, using defaults:', err);
  }
};

/**
 * @param {object} from - Start rect {top, left, width, height, borderRadius}
 * @param {object} to - End rect
 * @param {boolean} keepVisible - If true, don't hide ghost after animation (caller hides it)
 */
const animateGhost = (from, to, keepVisible = false) => {
  return new Promise((resolve) => {
    const ghost = document.getElementById('anim-ghost');

    // Position at start (no transition)
    ghost.style.transition = 'none';
    ghost.classList.remove('visible');
    ghost.style.top = from.top + 'px';
    ghost.style.left = from.left + 'px';
    ghost.style.width = from.width + 'px';
    ghost.style.height = from.height + 'px';
    ghost.style.borderRadius = from.borderRadius || '8px';
    ghost.offsetHeight; // force reflow

    ghost.classList.add('visible');

    // Next frame — animate to target
    requestAnimationFrame(() => {
      const t = `${ANIM_DURATION} ${ANIM_EASE}`;
      ghost.style.transition = `top ${t}, left ${t}, width ${t}, height ${t}, border-radius ${t}`;

      requestAnimationFrame(() => {
        ghost.style.top = to.top + 'px';
        ghost.style.left = to.left + 'px';
        ghost.style.width = to.width + 'px';
        ghost.style.height = to.height + 'px';
        ghost.style.borderRadius = to.borderRadius || '0px';

        const onDone = (e) => {
          if (e.target !== ghost || e.propertyName !== 'width') return;
          ghost.removeEventListener('transitionend', onDone);
          ghost.style.transition = '';
          if (!keepVisible) {
            ghost.classList.remove('visible');
          }
          resolve();
        };
        ghost.addEventListener('transitionend', onDone);
      });
    });
  });
};

const hideGhost = () => {
  const ghost = document.getElementById('anim-ghost');
  ghost.classList.remove('visible');
};

/**
 * Convert card's viewport-relative rect to a position within the pagestream
 * window, then compute what that would look like as a target for the ghost
 * that ends at the exact screen position of the page host window.
 *
 * Ghost coordinates are relative to the pagestream window viewport.
 * Page host opens at absolute screen coordinates.
 * We need: ghost target = pageHostScreen - pagestreamScreen
 */
const openInPageHost = async (url) => {
  if (state.animating) return;
  state.animating = true;

  const cards = getCards();
  const card = cards[state.selectedIndex];
  if (!card) { state.animating = false; return; }

  state.openCardIndex = state.selectedIndex;

  // Card position (viewport-relative, which is pagestream-window-relative)
  const cardRect = card.getBoundingClientRect();

  // Get pagestream window's screen position
  let psBounds;
  try {
    psBounds = await api.window.getBounds();
  } catch {
    psBounds = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
  }

  // Center page host on the pagestream window, capped at default page size
  const pageHostW = PAGE_HOST_WIDTH;
  const pageHostH = PAGE_HOST_HEIGHT;
  const pageHostX = Math.round(psBounds.x + (psBounds.width - pageHostW) / 2);
  const pageHostY = Math.round(psBounds.y + (psBounds.height - pageHostH) / 2);

  // Ghost target in viewport coords (centered within pagestream window)
  const ghostLeft = (psBounds.width - pageHostW) / 2;
  const ghostTop = (psBounds.height - pageHostH) / 2;

  // Ghost animates from card to page host size (centered in pagestream)
  await animateGhost(
    { top: cardRect.top, left: cardRect.left, width: cardRect.width, height: cardRect.height, borderRadius: '8px' },
    { top: ghostTop, left: ghostLeft, width: pageHostW, height: pageHostH, borderRadius: '10px' },
    true // keepVisible — ghost stays as backdrop until window renders
  );

  // Open the page host window at exact position ghost landed
  try {
    const result = await api.window.open(url, {
      role: 'content',
      key: url,
      width: pageHostW,
      height: pageHostH,
      x: pageHostX,
      y: pageHostY,
      trackingSource: 'pagestream',
    });
    if (result && result.id) {
      state.openWindowId = result.id;
    }
  } catch (err) {
    console.error('[pagestream] Failed to open page:', err);
    state.openCardIndex = -1;
  }

  // Give the window time to render on top of the ghost, then hide ghost
  setTimeout(() => {
    hideGhost();
    state.animating = false;
  }, 300);
};

// ===== Global navigation while page host is open =====

/** Move card selection and optionally navigate the open page host */
const moveSelection = (action) => {
  const cards = getCards();
  if (cards.length === 0) return;

  const prevIndex = state.selectedIndex;

  switch (action) {
    case 'down':
      if (state.selectedIndex < cards.length - 1) state.selectedIndex++;
      break;
    case 'up':
      if (state.selectedIndex > 0) state.selectedIndex--;
      break;
    case 'first':
      state.selectedIndex = 0;
      break;
    case 'last':
      state.selectedIndex = cards.length - 1;
      break;
  }

  if (state.selectedIndex === prevIndex) return;

  updateSelection();

  // If a page host is open, navigate it to the new card's URL
  if (state.openWindowId) {
    const filtered = getFilteredVisits();
    const entry = filtered[state.selectedIndex];
    if (entry) {
      state.openCardIndex = state.selectedIndex;
      api.publish('page:navigate', {
        windowId: state.openWindowId,
        url: entry.item.content
      }, api.scopes.GLOBAL);
    }
  }
};

// Listen for navigation keys forwarded from page host via pubsub
// (subscription lives for the lifetime of pagestream — moveSelection
// is safe to call any time, it just no-ops if nothing is open)
api.subscribe('pagestream:nav', (msg) => {
  if (msg.action) moveSelection(msg.action);
}, api.scopes.GLOBAL);

const onPageHostClosed = async (closedWindowId) => {
  if (closedWindowId !== state.openWindowId) return;
  state.openWindowId = null;

  const cards = getCards();
  const card = cards[state.openCardIndex];
  if (!card || state.animating) return;

  state.animating = true;

  // Get fresh card position and pagestream window size
  const cardRect = card.getBoundingClientRect();
  const ghostLeft = (window.innerWidth - PAGE_HOST_WIDTH) / 2;
  const ghostTop = (window.innerHeight - PAGE_HOST_HEIGHT) / 2;

  // Animate from page host size (centered) → card
  await animateGhost(
    { top: ghostTop, left: ghostLeft, width: PAGE_HOST_WIDTH, height: PAGE_HOST_HEIGHT, borderRadius: '10px' },
    { top: cardRect.top, left: cardRect.left, width: cardRect.width, height: cardRect.height, borderRadius: '8px' }
  );

  state.animating = false;
  state.openCardIndex = -1;
  state.pageHostBounds = null;
};

const createVisitCard = (visit, item, index) => {
  const card = document.createElement('peek-card');
  card.className = 'visit-card';
  card.interactive = true;
  card.bordered = false;
  card.dataset.visitId = visit.id;
  card.dataset.itemId = item.id;
  card.dataset.index = index;

  // Inject <style> into shadow DOM — permanent override for opaque bg and no borders
  card.updateComplete.then(() => {
    if (card.shadowRoot && !card.shadowRoot.querySelector('.pagestream-override')) {
      const style = document.createElement('style');
      style.className = 'pagestream-override';
      style.textContent = `
        .card, .card:hover, .card:active, .card:focus-visible {
          background: #2c2c2e !important;
          border: none !important;
          border-radius: 8px !important;
          outline: none !important;
          box-shadow: none !important;
          overflow: hidden !important;
        }
      `;
      card.shadowRoot.appendChild(style);
    }
  });

  const url = item.content;

  let displayTitle = item.title;
  if (!displayTitle && item.metadata) {
    try {
      const meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata;
      displayTitle = meta.title;
    } catch {
      // Ignore
    }
  }
  displayTitle = displayTitle || extractDomain(url);

  const domain = item.domain || extractDomain(url);

  const header = document.createElement('div');
  header.slot = 'header';
  header.className = 'card-header';

  const favicon = document.createElement('img');
  favicon.className = 'card-favicon';
  favicon.src = item.favicon || `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
  favicon.onerror = () => {
    favicon.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">.</text></svg>';
  };

  const title = document.createElement('h2');
  title.className = 'card-title';
  title.textContent = displayTitle;

  header.appendChild(favicon);
  header.appendChild(title);
  card.appendChild(header);

  const body = document.createElement('div');
  body.className = 'card-url';
  body.textContent = url;
  card.appendChild(body);

  const footer = document.createElement('div');
  footer.slot = 'footer';
  footer.className = 'card-footer';

  const time = document.createElement('span');
  time.className = 'card-time';
  time.textContent = formatRelativeTime(visit.timestamp);

  const domainBadge = document.createElement('span');
  domainBadge.className = 'card-domain';
  domainBadge.textContent = domain;

  footer.appendChild(time);
  footer.appendChild(domainBadge);
  card.appendChild(footer);

  loadItemTags(item.id).then(tags => {
    if (tags.length > 0) {
      const tagsContainer = document.createElement('div');
      tagsContainer.className = 'card-tags';
      tagsContainer.slot = 'footer';
      tags.forEach(tag => {
        const chip = document.createElement('span');
        chip.className = 'tag-chip';
        chip.textContent = tag.name;
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          filterByTag(tag.id, tag.name);
        });
        tagsContainer.appendChild(chip);
      });
      card.appendChild(tagsContainer);
    }
  });

  card.addEventListener('card-click', () => {
    state.selectedIndex = index;
    updateSelection();
    openInPageHost(url);
  });

  return card;
};

// ===== Filtering =====

const filterByTag = async (tagId, tagName) => {
  state.filterTagId = tagId;
  state.filterTagName = tagName;

  const result = await api.datastore.getItemsByTag(tagId);
  if (result.success && result.data) {
    const taggedItemIds = new Set(result.data.map(item => item.id));
    state.visits = state.visits.filter(({ item }) => taggedItemIds.has(item.id));
  }

  render();
};

const clearTagFilter = async () => {
  state.filterTagId = null;
  state.filterTagName = null;
  await loadVisits();
  render();
};

// ===== Keyboard Navigation =====

const handleEscape = () => {
  if (state.filterTagId) {
    clearTagFilter();
    return { handled: true };
  }
  return { handled: false };
};

const handleKeydown = (e) => {
  const cards = getCards();
  if (cards.length === 0) return;

  switch (e.key) {
    case 'j':
    case 'ArrowDown':
      e.preventDefault();
      moveSelection('down');
      break;
    case 'k':
    case 'ArrowUp':
      e.preventDefault();
      moveSelection('up');
      break;
    case 'Enter':
      e.preventDefault();
      {
        const filtered = getFilteredVisits();
        const entry = filtered[state.selectedIndex];
        if (entry) {
          openInPageHost(entry.item.content);
        }
      }
      break;
    case 'g':
    case 'Home':
      e.preventDefault();
      moveSelection('first');
      break;
    case 'G':
    case 'End':
      e.preventDefault();
      moveSelection('last');
      break;
  }
};

// ===== Initialization =====

const init = async () => {
  debug && console.log('[pagestream] init');

  await loadPageHostDefaults();

  api.escape.onEscape(handleEscape);

  document.addEventListener('keydown', handleKeydown);

  await loadVisits();
  render(true);

  const debouncedRefresh = debounce(async () => {
    debug && console.log('[pagestream] debounced refresh triggered');
    await loadVisits();
    render();
  }, 150);

  // Listen for page host window closing — trigger collapse animation
  api.subscribe('window:closed', (msg) => {
    const closedId = msg?.id;
    if (closedId) onPageHostClosed(closedId);
  }, api.scopes.GLOBAL);

  api.subscribe('item:created', () => debouncedRefresh(), api.scopes.GLOBAL);
  api.subscribe('item:deleted', () => debouncedRefresh(), api.scopes.GLOBAL);
  api.subscribe('tag:item-added', () => debouncedRefresh(), api.scopes.GLOBAL);
  api.subscribe('tag:item-removed', () => debouncedRefresh(), api.scopes.GLOBAL);
  api.subscribe('sync:pull-completed', () => debouncedRefresh(), api.scopes.GLOBAL);

  setInterval(() => {
    const timeElements = document.querySelectorAll('.card-time');
    const filtered = getFilteredVisits();
    timeElements.forEach((el, i) => {
      if (filtered[i]) {
        el.textContent = formatRelativeTime(filtered[i].visit.timestamp);
      }
    });
  }, 30000);
};

document.addEventListener('DOMContentLoaded', init);
