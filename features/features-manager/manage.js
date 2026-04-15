/**
 * Features Manager — Manage page
 *
 * Shows installed non-built-in features with enable/disable/remove actions.
 * Fetches feature list from registry via IPC.
 */

const api = window.app;
const hasPeekAPI = !!api;

// ─── DOM refs ───────────────────────────────────────────────────────

const contentEl = document.getElementById('content');
const searchInput = document.getElementById('search-input');
const featureCountEl = document.querySelector('.feature-count');

// ─── State ──────────────────────────────────────────────────────────

let features = [];
let searchFilter = '';

// ─── Data loading ───────────────────────────────────────────────────

async function loadFeatures() {
  if (!hasPeekAPI) {
    showEmpty('Peek API not available');
    return;
  }

  try {
    const result = await api.ipc.invoke('feature-registry:list');
    if (result.error) {
      showEmpty(result.error);
      return;
    }

    features = result.entries || [];
    render();
  } catch (err) {
    console.error('[features-manager] Failed to load features:', err);
    showEmpty('Failed to load features');
  }
}

// ─── Rendering ──────────────────────────────────────────────────────

function render() {
  let filtered = features;

  if (searchFilter) {
    const q = searchFilter.toLowerCase();
    filtered = features.filter(f =>
      f.name.toLowerCase().includes(q) ||
      f.id.toLowerCase().includes(q) ||
      (f.source?.type || '').toLowerCase().includes(q)
    );
  }

  // Update count
  featureCountEl.textContent = filtered.length > 0
    ? `(${filtered.length})`
    : '';

  if (filtered.length === 0) {
    if (features.length === 0) {
      showEmpty();
    } else {
      contentEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-title">No matching features</div>
          <div class="empty-state-hint">Try a different search term.</div>
        </div>
      `;
    }
    return;
  }

  contentEl.innerHTML = '';
  const list = document.createElement('div');
  list.className = 'feature-list';

  for (const feature of filtered) {
    list.appendChild(createFeatureCard(feature));
  }

  contentEl.appendChild(list);
}

function showEmpty(errorMsg) {
  const hint = errorMsg
    ? errorMsg
    : 'No features installed. Features installed from AT Protocol URIs will appear here.';

  contentEl.innerHTML = `
    <div class="empty-state">
      <div class="empty-state-icon">\u2699</div>
      <div class="empty-state-title">No features installed</div>
      <div class="empty-state-hint">${hint}</div>
    </div>
  `;
}

function createFeatureCard(feature) {
  const card = document.createElement('div');
  card.className = 'feature-card' + (feature.disabled ? ' disabled' : '');
  card.dataset.featureId = feature.id;

  const sourceType = feature.source?.type || 'unknown';
  const version = feature.source?.version || '';
  const isDisabled = !!feature.disabled;

  // Icon
  const icon = document.createElement('div');
  icon.className = 'feature-icon';
  icon.textContent = feature.name.charAt(0).toUpperCase();
  card.appendChild(icon);

  // Info
  const info = document.createElement('div');
  info.className = 'feature-info';

  const name = document.createElement('div');
  name.className = 'feature-name';
  name.textContent = feature.name;
  info.appendChild(name);

  const meta = document.createElement('div');
  meta.className = 'feature-meta';

  if (version) {
    const versionEl = document.createElement('span');
    versionEl.className = 'feature-version';
    versionEl.textContent = 'v' + version;
    meta.appendChild(versionEl);
  }

  const sourceBadge = document.createElement('span');
  sourceBadge.className = `feature-source-badge ${sourceType}`;
  sourceBadge.textContent = sourceType;
  meta.appendChild(sourceBadge);

  const statusBadge = document.createElement('span');
  statusBadge.className = `feature-status-badge ${isDisabled ? 'disabled' : 'active'}`;
  statusBadge.textContent = isDisabled ? 'Disabled' : 'Active';
  meta.appendChild(statusBadge);

  info.appendChild(meta);
  card.appendChild(info);

  // Actions — ALWAYS visible
  const actions = document.createElement('div');
  actions.className = 'feature-actions';

  // Enable/Disable toggle
  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'action-btn' + (isDisabled ? ' primary' : '');
  toggleBtn.textContent = isDisabled ? 'Enable' : 'Disable';
  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFeature(feature.id, isDisabled);
  });
  actions.appendChild(toggleBtn);

  // Remove
  const removeBtn = document.createElement('button');
  removeBtn.className = 'action-btn danger';
  removeBtn.textContent = 'Remove';
  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    removeFeature(feature.id, feature.name);
  });
  actions.appendChild(removeBtn);

  card.appendChild(actions);

  return card;
}

// ─── Actions ────────────────────────────────────────────────────────

async function toggleFeature(id, currentlyDisabled) {
  if (!hasPeekAPI) return;

  const channel = currentlyDisabled ? 'feature-registry:enable' : 'feature-registry:disable';

  try {
    const result = await api.ipc.invoke(channel, { id });
    if (result.error) {
      console.error(`[features-manager] toggle error:`, result.error);
      return;
    }

    // Update local state and re-render
    const feature = features.find(f => f.id === id);
    if (feature) {
      feature.disabled = !currentlyDisabled;
      render();
    }
  } catch (err) {
    console.error('[features-manager] toggle error:', err);
  }
}

async function removeFeature(id, name) {
  if (!hasPeekAPI) return;

  // Simple confirmation
  const confirmed = confirm(`Remove feature "${name}"? This will delete all feature files.`);
  if (!confirmed) return;

  try {
    const result = await api.ipc.invoke('feature-registry:remove', { id });
    if (result.error) {
      console.error(`[features-manager] remove error:`, result.error);
      return;
    }

    // Remove from local state and re-render
    features = features.filter(f => f.id !== id);
    render();
  } catch (err) {
    console.error('[features-manager] remove error:', err);
  }
}

// ─── Search ─────────────────────────────────────────────────────────

searchInput.addEventListener('input', () => {
  searchFilter = searchInput.value.trim();
  render();
});

// ─── PubSub listeners for real-time updates ─────────────────────────

if (hasPeekAPI) {
  const refreshTopics = [
    'feature:disabled',
    'feature:enabled',
    'feature:removed',
    'feature:installed'
  ];

  for (const topic of refreshTopics) {
    api.subscribe(topic, () => {
      loadFeatures();
    }, api.scopes?.GLOBAL);
  }
}

// ─── Init ───────────────────────────────────────────────────────────

loadFeatures();
