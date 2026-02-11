/**
 * Entities Browser UI
 *
 * Card grid showing all extracted entities with type filtering and search.
 */

import { getEntities, getObservations, extractCurrentPage } from './background.js';

const api = window.app;

let currentTypeFilter = '';
let currentSearch = '';

// View preferences (persisted)
let viewPrefs = {
  viewMode: 'columns',
  sortBy: 'name',
  sortDirection: 'asc'
};

const SORT_OPTIONS = [
  { value: 'name', label: 'Name' },
  { value: 'type', label: 'Type' },
  { value: 'confidence', label: 'Confidence' },
  { value: 'date', label: 'Date' }
];

// Type icons mapping
const TYPE_ICONS = {
  person: '\u{1F464}',       // bust in silhouette
  organization: '\u{1F3E2}', // office building
  place: '\u{1F4CD}',        // round pushpin
  event: '\u{1F4C5}',        // calendar
  email: '\u{2709}',         // envelope
  phone: '\u{260E}',         // telephone
  date: '\u{1F4C6}',         // tear-off calendar
  product: '\u{1F4E6}',      // package
  creative_work: '\u{1F4D6}',// open book
  price: '\u{1F4B0}',        // money bag
  tracking_number: '\u{1F4E6}' // package
};

// ==================== View Preferences ====================

async function loadViewPrefs() {
  try {
    if (api?.settings?.getKey) {
      const result = await api.settings.getKey('viewPrefs');
      if (result.success && result.data) {
        viewPrefs = { ...viewPrefs, ...result.data };
      }
    }
  } catch (err) {
    // ignore
  }
}

async function saveViewPrefs() {
  try {
    if (api?.settings?.setKey) {
      await api.settings.setKey('viewPrefs', viewPrefs);
    }
  } catch (err) {
    // ignore
  }
}

function sortEntities(entities) {
  const dir = viewPrefs.sortDirection === 'asc' ? 1 : -1;
  return entities.sort((a, b) => {
    let metaA = {};
    let metaB = {};
    try { metaA = JSON.parse(a.metadata || '{}'); } catch {}
    try { metaB = JSON.parse(b.metadata || '{}'); } catch {}

    switch (viewPrefs.sortBy) {
      case 'name': {
        const na = (a.content || a.name || '').toLowerCase();
        const nb = (b.content || b.name || '').toLowerCase();
        return dir * na.localeCompare(nb);
      }
      case 'type': {
        const ta = (metaA.entityType || '').toLowerCase();
        const tb = (metaB.entityType || '').toLowerCase();
        return dir * ta.localeCompare(tb);
      }
      case 'confidence': {
        const ca = metaA.confidence || 0;
        const cb = metaB.confidence || 0;
        return dir * (ca - cb);
      }
      case 'date': {
        const da = a.createdAt || 0;
        const db = b.createdAt || 0;
        return dir * (da - db);
      }
      default:
        return 0;
    }
  });
}

function setupToolbar() {
  const toolbar = document.getElementById('gridToolbar');
  const grid = document.getElementById('entityGrid');
  if (!toolbar) return;

  toolbar.sortOptions = SORT_OPTIONS;
  toolbar.sortBy = viewPrefs.sortBy;
  toolbar.sortDirection = viewPrefs.sortDirection;
  toolbar.viewMode = viewPrefs.viewMode;
  grid.viewMode = viewPrefs.viewMode;

  toolbar.addEventListener('sort-change', (e) => {
    viewPrefs.sortBy = e.detail.sortBy;
    viewPrefs.sortDirection = e.detail.sortDirection;
    saveViewPrefs();
    renderEntities();
  });

  toolbar.addEventListener('view-mode-change', (e) => {
    viewPrefs.viewMode = e.detail.mode;
    grid.viewMode = e.detail.mode;
    saveViewPrefs();
    renderEntities();
  });
}

// ==================== Rendering ====================

async function renderEntities() {
  const grid = document.getElementById('entityGrid');
  const countEl = document.getElementById('entityCount');

  const entities = await getEntities({
    entityType: currentTypeFilter || undefined,
    search: currentSearch || undefined
  });

  countEl.textContent = `(${entities.length})`;

  if (entities.length === 0) {
    grid.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `
      <h2>No entities found</h2>
      <p>${currentTypeFilter || currentSearch
        ? 'Try adjusting your filters or search.'
        : 'Browse some web pages and entities will be extracted automatically.'}</p>
    `;
    // Place empty state outside grid
    const content = grid.parentElement;
    const existingEmpty = content.querySelector('.empty-state');
    if (existingEmpty) existingEmpty.remove();
    content.appendChild(empty);
    return;
  }

  // Remove any existing empty state
  const content = grid.parentElement;
  const existingEmpty = content.querySelector('.empty-state');
  if (existingEmpty) existingEmpty.remove();

  grid.innerHTML = '';

  // Apply sorting
  sortEntities(entities);

  for (const entity of entities) {
    let meta = {};
    try { meta = JSON.parse(entity.metadata || '{}'); } catch {}

    const card = document.createElement('peek-card');
    card.interactive = true;

    const entityType = meta.entityType || 'unknown';
    const icon = TYPE_ICONS[entityType] || '?';
    const confidence = meta.confidence ? Math.round(meta.confidence * 100) : 0;

    // Build attributes display
    const attrs = meta.attributes || {};
    let attrHtml = '';
    const attrParts = [];
    if (attrs.email) attrParts.push(escapeHtml(attrs.email));
    if (attrs.phone) attrParts.push(escapeHtml(attrs.phone));
    if (attrs.homepage) attrParts.push(escapeHtml(truncate(attrs.homepage, 40)));
    if (attrs.location) attrParts.push(escapeHtml(attrs.location));
    if (attrs.organization) attrParts.push(escapeHtml(attrs.organization));
    if (attrs.role || attrs.jobTitle) attrParts.push(escapeHtml(attrs.role || attrs.jobTitle));
    if (attrs.startDate) attrParts.push(escapeHtml(attrs.startDate));
    if (attrs.address) attrParts.push(escapeHtml(truncate(String(attrs.address), 50)));
    if (attrs.description) attrParts.push(escapeHtml(truncate(attrs.description, 60)));

    if (attrParts.length > 0) {
      attrHtml = `<div class="entity-attrs">${attrParts.map(a => `<span>${a}</span>`).join('')}</div>`;
    }

    // Aliases
    const aliases = meta.aliases || [];
    let aliasHtml = '';
    if (aliases.length > 0) {
      aliasHtml = `<div class="entity-meta">aka: ${aliases.map(a => escapeHtml(a)).join(', ')}</div>`;
    }

    const headerDiv = document.createElement('div');
    headerDiv.slot = 'header';
    headerDiv.innerHTML = `
      <div class="card-header">
        <span class="entity-type-icon type-${entityType}">${icon}</span>
        <span class="entity-name">${escapeHtml(entity.content || entity.name || '')}</span>
      </div>
    `;
    card.appendChild(headerDiv);

    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'card-body';
    bodyDiv.innerHTML = `
      <div class="entity-type">${escapeHtml(entityType.replace('_', ' '))}</div>
      ${attrHtml}
      ${aliasHtml}
    `;
    card.appendChild(bodyDiv);

    const footerDiv = document.createElement('div');
    footerDiv.slot = 'footer';
    footerDiv.innerHTML = `
      <div class="card-footer">
        <span class="entity-confidence">${confidence}% confidence</span>
        <span>${formatDate(entity.createdAt)}</span>
      </div>
    `;
    card.appendChild(footerDiv);

    grid.appendChild(card);
  }
}

// ==================== Event Handlers ====================

// Filter buttons
document.getElementById('filters').addEventListener('click', (e) => {
  const btn = e.target.closest('.filter-btn');
  if (!btn) return;

  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  currentTypeFilter = btn.dataset.type || '';
  renderEntities();
});

// Search input
const searchInput = document.getElementById('searchInput');
let searchTimeout = null;
searchInput.addEventListener('input', (e) => {
  if (searchTimeout) clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    currentSearch = e.target.value || '';
    renderEntities();
  }, 300);
});

// Extract button
document.getElementById('extractBtn').addEventListener('click', async () => {
  const btn = document.getElementById('extractBtn');
  btn.disabled = true;
  btn.textContent = 'Extracting...';

  try {
    await extractCurrentPage();
    // Re-render after extraction
    await renderEntities();
  } catch (err) {
    console.error('[entities:ui] Extraction failed:', err);
  }

  btn.disabled = false;
  btn.textContent = 'Extract Current Page';
});

// Listen for new entity extractions
if (api) {
  api.subscribe('entities:extracted', () => {
    renderEntities();
  }, api.scopes.GLOBAL);

  // Also listen for editor changes that might affect entities
  api.subscribe('editor:changed', () => {
    renderEntities();
  }, api.scopes.GLOBAL);
}

// ==================== Utilities ====================

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
}

function formatDate(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;

  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;

  return date.toLocaleDateString();
}

// ==================== Init ====================

async function init() {
  await loadViewPrefs();
  setupToolbar();
  await renderEntities();
}

init();
