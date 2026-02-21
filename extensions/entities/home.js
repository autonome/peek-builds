/**
 * Entities Browser UI
 *
 * Card grid showing all extracted entities with type filtering and search.
 * Includes detail pane showing full entity metadata and all source pages.
 */

import { getEntities, getObservations, extractCurrentPage, setEntityFeedback } from './background.js';

const api = window.app;

// View states
const VIEW_LIST = 'list';
const VIEW_DETAIL = 'detail';

let currentView = VIEW_LIST;
let currentTypeFilter = '';
let currentSearch = '';
let selectedEntity = null; // Entity being viewed in detail

// View preferences (persisted)
let viewPrefs = {
  viewMode: 'columns',
  sortBy: 'frequency',
  sortDirection: 'desc'
};

const SORT_OPTIONS = [
  { value: 'frequency', label: 'Frequency' },
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
    const stored = localStorage.getItem('viewPrefs');
    if (stored) {
      viewPrefs = { ...viewPrefs, ...JSON.parse(stored) };
    }
  } catch (err) {
    // ignore
  }
}

async function saveViewPrefs() {
  try {
    localStorage.setItem('viewPrefs', JSON.stringify(viewPrefs));
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
      case 'frequency': {
        const fa = a.visitCount || 0;
        const fb = b.visitCount || 0;
        if (fa !== fb) return dir * (fa - fb);
        // Tiebreak by frecencyScore
        return dir * ((a.frecencyScore || 0) - (b.frecencyScore || 0));
      }
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

/**
 * Open a URL in a new content window
 */
async function openSourceUrl(url) {
  try {
    await api.window.open(url, {
      role: 'content',
      width: 800,
      height: 600,
      trackingSource: 'entities',
      trackingSourceId: 'source-page'
    });
  } catch (err) {
    console.error('[entities:ui] Failed to open URL:', err);
  }
}

/**
 * Show the list view, hide detail view
 */
function showList() {
  currentView = VIEW_LIST;
  selectedEntity = null;
  document.getElementById('entityGrid').style.display = '';
  document.getElementById('gridToolbar').style.display = '';
  document.getElementById('detailView').style.display = 'none';
  renderEntities();
}

/**
 * Show the detail view for an entity
 */
async function showDetailView(entity) {
  currentView = VIEW_DETAIL;
  selectedEntity = entity;

  let meta = {};
  try { meta = JSON.parse(entity.metadata || '{}'); } catch {}

  const entityType = meta.entityType || 'unknown';
  const icon = TYPE_ICONS[entityType] || '?';
  const confidence = meta.confidence ? Math.round(meta.confidence * 100) : 0;
  const extractor = meta.extractor || 'unknown';
  const attrs = meta.attributes || {};
  const aliases = meta.aliases || [];

  // Hide grid, show detail
  document.getElementById('entityGrid').style.display = 'none';
  document.getElementById('gridToolbar').style.display = 'none';
  const detailView = document.getElementById('detailView');
  detailView.style.display = '';

  // Header
  const typeIconEl = document.getElementById('detailTypeIcon');
  typeIconEl.className = `detail-type-icon entity-type-icon type-${entityType}`;
  typeIconEl.textContent = icon;
  document.getElementById('detailTitle').textContent = entity.content || entity.name || '';
  document.getElementById('detailSubtitle').textContent = entityType.replace('_', ' ');

  // Attributes
  const attrsEl = document.getElementById('detailAttributes');
  const attrEntries = Object.entries(attrs).filter(([, v]) => v && String(v).length > 0);
  if (attrEntries.length > 0) {
    attrsEl.innerHTML = attrEntries.map(([key, value]) => {
      const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
      const isUrl = typeof value === 'string' && (value.startsWith('http://') || value.startsWith('https://'));
      const displayValue = isUrl
        ? `<a class="detail-link" href="#" data-url="${escapeHtml(value)}">${escapeHtml(truncate(value, 60))}</a>`
        : escapeHtml(truncate(String(value), 120));
      return `<div class="detail-attr-row"><span class="detail-attr-label">${escapeHtml(label)}</span><span class="detail-attr-value">${displayValue}</span></div>`;
    }).join('');
  } else {
    attrsEl.innerHTML = '<span class="detail-empty">No attributes</span>';
  }

  // Aliases
  const aliasesSection = document.getElementById('detailAliasesSection');
  const aliasesEl = document.getElementById('detailAliases');
  if (aliases.length > 0) {
    aliasesSection.style.display = '';
    aliasesEl.innerHTML = aliases.map(a => `<span class="detail-alias">${escapeHtml(a)}</span>`).join('');
  } else {
    aliasesSection.style.display = 'none';
  }

  // Extraction info
  const infoEl = document.getElementById('detailExtractionInfo');
  const detailPageCount = entity.visitCount || 0;
  infoEl.innerHTML = `
    <div class="detail-attr-row"><span class="detail-attr-label">Confidence</span><span class="detail-attr-value">${confidence}%</span></div>
    <div class="detail-attr-row"><span class="detail-attr-label">Observed On</span><span class="detail-attr-value">${detailPageCount} page${detailPageCount !== 1 ? 's' : ''}</span></div>
    <div class="detail-attr-row"><span class="detail-attr-label">Extractor</span><span class="detail-attr-value">${escapeHtml(extractor)}</span></div>
    <div class="detail-attr-row"><span class="detail-attr-label">First Seen</span><span class="detail-attr-value">${entity.createdAt ? new Date(entity.createdAt).toLocaleString() : 'Unknown'}</span></div>
    <div class="detail-attr-row"><span class="detail-attr-label">Last Updated</span><span class="detail-attr-value">${entity.updatedAt ? new Date(entity.updatedAt).toLocaleString() : 'Unknown'}</span></div>
  `;

  // Feedback section
  const feedbackEl = document.getElementById('detailFeedback');
  if (feedbackEl) {
    const feedbackScore = meta.feedback?.score ?? 0;
    feedbackEl.innerHTML = `
      <div class="detail-feedback-buttons">
        <button class="detail-feedback-btn feedback-down ${feedbackScore === -1 ? 'active' : ''}" data-score="-1">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>
          <span>Hide</span>
        </button>
        <button class="detail-feedback-btn feedback-up ${feedbackScore === 1 ? 'active' : ''}" data-score="1">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>
          <span>Correct</span>
        </button>
      </div>
    `;
    feedbackEl.querySelectorAll('.detail-feedback-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const newScore = parseInt(btn.dataset.score);
        const currentScore = meta.feedback?.score ?? 0;
        const score = currentScore === newScore ? 0 : newScore;
        await setEntityFeedback(entity.id, score);
        if (score === -1) {
          showList();
        } else {
          showDetailView(entity);
        }
      });
    });
  }

  // Source pages
  const sourcesEl = document.getElementById('detailSources');
  sourcesEl.innerHTML = '<span class="detail-empty">Loading sources...</span>';

  try {
    const observations = await getObservations(entity.id);
    if (observations.length > 0) {
      // Deduplicate by URL, keeping most recent
      const byUrl = new Map();
      for (const obs of observations) {
        if (!obs.url) continue;
        if (!byUrl.has(obs.url) || obs.occurredAt > byUrl.get(obs.url).occurredAt) {
          byUrl.set(obs.url, obs);
        }
      }

      const uniqueObs = Array.from(byUrl.values()).sort((a, b) => (b.occurredAt || 0) - (a.occurredAt || 0));

      sourcesEl.innerHTML = uniqueObs.map(obs => {
        const title = obs.pageTitle || truncate(obs.url, 60);
        const displayUrl = truncate(obs.url, 80);
        return `
          <div class="detail-source-row">
            <a class="detail-source-link" href="#" data-url="${escapeHtml(obs.url)}">
              <span class="detail-source-title">${escapeHtml(title)}</span>
              <span class="detail-source-url">${escapeHtml(displayUrl)}</span>
            </a>
            <span class="detail-source-meta">
              ${obs.extractor ? escapeHtml(obs.extractor) : ''}
              ${obs.occurredAt ? ' \u00B7 ' + formatDate(obs.occurredAt) : ''}
            </span>
          </div>
        `;
      }).join('');
    } else {
      sourcesEl.innerHTML = '<span class="detail-empty">No source pages recorded</span>';
    }
  } catch (err) {
    console.error('[entities:ui] Failed to load observations:', err);
    sourcesEl.innerHTML = '<span class="detail-empty">Failed to load sources</span>';
  }

  // Wire up all clickable links in detail view
  detailView.querySelectorAll('[data-url]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      openSourceUrl(el.dataset.url);
    });
  });
}

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

  // Fetch first observation for each entity (batch)
  const observationMap = new Map();
  await Promise.all(entities.map(async (entity) => {
    try {
      const obs = await getObservations(entity.id, { limit: 5 });
      if (obs.length > 0) {
        // Deduplicate by URL, keep most recent
        const byUrl = new Map();
        for (const o of obs) {
          if (!o.url) continue;
          if (!byUrl.has(o.url) || o.occurredAt > byUrl.get(o.url).occurredAt) {
            byUrl.set(o.url, o);
          }
        }
        observationMap.set(entity.id, Array.from(byUrl.values()));
      }
    } catch { /* ignore */ }
  }));

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

    // Source page (first observation)
    const observations = observationMap.get(entity.id) || [];
    let sourceHtml = '';
    if (observations.length > 0) {
      const firstObs = observations[0];
      const sourceTitle = firstObs.pageTitle || '';
      const displayUrl = truncate(firstObs.url, 50);
      const sourceCount = observations.length;
      sourceHtml = `<div class="entity-source">
        <div class="source-info">
          ${sourceTitle ? `<span class="source-page-title">${escapeHtml(truncate(sourceTitle, 40))}</span>` : ''}
          <span class="source-url">${escapeHtml(displayUrl)}</span>
        </div>
        <button class="source-open-btn" data-url="${escapeHtml(firstObs.url)}" title="Open source page">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
            <polyline points="15 3 21 3 21 9"></polyline>
            <line x1="10" y1="14" x2="21" y2="3"></line>
          </svg>
        </button>
        ${sourceCount > 1 ? `<span class="source-count">+${sourceCount - 1} more</span>` : ''}
      </div>`;
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
      ${sourceHtml}
    `;
    card.appendChild(bodyDiv);

    const footerDiv = document.createElement('div');
    footerDiv.slot = 'footer';
    const pageCount = entity.visitCount || 0;
    const pageCountText = pageCount > 0 ? `Seen on ${pageCount} page${pageCount !== 1 ? 's' : ''}` : '';
    const footerParts = [`${confidence}% confidence`];
    if (pageCountText) footerParts.push(pageCountText);
    footerParts.push(formatDate(entity.createdAt));
    const feedbackScore = meta.feedback?.score ?? 0;
    footerDiv.innerHTML = `
      <div class="card-footer">
        <span class="entity-confidence">${footerParts.filter(Boolean).join(' \u00B7 ')}</span>
        <span class="feedback-buttons">
          <button class="feedback-btn feedback-down ${feedbackScore === -1 ? 'active' : ''}" data-score="-1" title="Hide noisy extraction">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>
          </button>
          <button class="feedback-btn feedback-up ${feedbackScore === 1 ? 'active' : ''}" data-score="1" title="Mark as correct">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>
          </button>
        </span>
      </div>
    `;
    card.appendChild(footerDiv);

    // Click on source link opens the page directly
    card.addEventListener('click', async (e) => {
      // Feedback buttons
      const feedbackBtn = e.target.closest('.feedback-btn');
      if (feedbackBtn) {
        e.stopPropagation();
        const newScore = parseInt(feedbackBtn.dataset.score);
        const currentScore = meta.feedback?.score ?? 0;
        // Toggle off if clicking the same score
        const score = currentScore === newScore ? 0 : newScore;
        await setEntityFeedback(entity.id, score);
        // If thumbs down, remove card with animation; otherwise re-render
        if (score === -1) {
          card.style.transition = 'opacity 0.3s, transform 0.3s';
          card.style.opacity = '0';
          card.style.transform = 'scale(0.95)';
          setTimeout(() => renderEntities(), 300);
        } else {
          renderEntities();
        }
        return;
      }

      const sourceBtn = e.target.closest('.source-open-btn[data-url]');
      if (sourceBtn) {
        e.stopPropagation();
        openSourceUrl(sourceBtn.dataset.url);
        return;
      }
      // Otherwise open detail view
      showDetailView(entity);
    });

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
    if (currentView === VIEW_LIST) renderEntities();
  }, api.scopes.GLOBAL);

  // Also listen for editor changes that might affect entities
  api.subscribe('editor:changed', () => {
    if (currentView === VIEW_LIST) renderEntities();
  }, api.scopes.GLOBAL);

  // Register escape handler for back-navigation from detail view
  if (api.escape) {
    api.escape.onEscape(() => {
      if (currentView === VIEW_DETAIL) {
        setTimeout(() => showList(), 0);
        return { handled: true };
      }
      return { handled: false };
    });
  }
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
