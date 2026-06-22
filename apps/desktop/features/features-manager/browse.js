/**
 * Features Manager — Browse page
 *
 * Search for features by publisher handle or DID.
 * Lists published space.peek.feature.release records.
 * Supports installing features directly from browse results.
 */

import { compareSemver } from './updater.js';

const api = window.app;
const hasPeekAPI = !!api;

/**
 * Well-known curated publisher DID for the Peek team's featured directory.
 * When the browse page opens with no query, this publisher is auto-loaded
 * to show a default set of featured/curated features.
 *
 * TODO: Replace with the actual Peek team DID once the AT Protocol account
 * is set up and features are published. Set to null to disable auto-load.
 */
const CURATED_PUBLISHER_DID = null; // e.g. 'did:plc:xxxxxxxxxxxxxxxxxxxxxxxx'

// ─── DOM refs ───────────────────────────────────────────────────────

const publisherInput = document.getElementById('publisher-input');
const searchBtn = document.getElementById('search-btn');
const manageBtn = document.getElementById('manage-btn');
const statusBar = document.getElementById('status-bar');
const statusText = document.getElementById('status-text');
const publisherInfo = document.getElementById('publisher-info');
const publisherHandleEl = document.getElementById('publisher-handle');
const publisherDidEl = document.getElementById('publisher-did');
const resultCount = document.getElementById('result-count');
const contentEl = document.getElementById('content');
const installPreview = document.getElementById('install-preview');
const previewTitle = document.getElementById('preview-title');
const previewIcon = document.getElementById('preview-icon');
const previewMeta = document.getElementById('preview-meta');
const previewScreenshots = document.getElementById('preview-screenshots');
const previewCapabilities = document.getElementById('preview-capabilities');
const previewCloseBtn = document.getElementById('preview-close');
const previewCancelBtn = document.getElementById('preview-cancel');
const previewInstallBtn = document.getElementById('preview-install');

// ─── State ──────────────────────────────────────────────────────────

let currentPublisher = null; // { did, handle, pdsUrl }
let featureRecords = [];     // latest release per featureId
let installedFeatures = {};  // id -> registry entry, for badge display
let pendingInstallUri = null;

// ─── Status helpers ─────────────────────────────────────────────────

function showStatus(message, type = 'info') {
  statusBar.style.display = '';
  statusBar.className = 'status-bar' + (type !== 'info' ? ` ${type}` : '');
  statusText.textContent = message;
}

function hideStatus() {
  statusBar.style.display = 'none';
}

// ─── Publisher info display ─────────────────────────────────────────

function showPublisher(publisher) {
  const isCurated = CURATED_PUBLISHER_DID && publisher.did === CURATED_PUBLISHER_DID;
  publisherHandleEl.textContent = (isCurated ? 'Featured: ' : '') + '@' + publisher.handle;
  // Abbreviate DID for display
  const did = publisher.did;
  const abbrev = did.length > 32
    ? did.slice(0, 16) + '...' + did.slice(-8)
    : did;
  publisherDidEl.textContent = abbrev;
  publisherDidEl.title = did;
  publisherInfo.style.display = '';
}

function hidePublisher() {
  publisherInfo.style.display = 'none';
}

// ─── Install preview ────────────────────────────────────────────────

function hidePreview() {
  installPreview.style.display = 'none';
  pendingInstallUri = null;
}

function renderCapabilityList(capabilities) {
  const items = [];

  if (capabilities.pubsub) {
    items.push(`PubSub (scopes: ${capabilities.pubsub.scopes.join(', ')})`);
    if (capabilities.pubsub.topics) {
      items.push(`Topics: ${capabilities.pubsub.topics.join(', ')}`);
    }
  }
  if (capabilities.datastore) {
    items.push(`Datastore (tables: ${capabilities.datastore.tables.join(', ')})`);
  }
  if (capabilities.network) {
    items.push(`Network (domains: ${capabilities.network.domains.join(', ')})`);
  }
  if (capabilities.window) {
    const perms = [];
    if (capabilities.window.create) perms.push('create');
    if (capabilities.window.query) perms.push('query');
    if (capabilities.window.manage) perms.push('manage');
    items.push(`Window (${perms.join(', ')})`);
  }
  if (capabilities.filesystem) items.push('Filesystem access');
  if (capabilities.commands) items.push('Commands');
  if (capabilities.shortcuts) items.push('Shortcuts');
  if (capabilities.sync) items.push('Sync');
  if (capabilities.theme) items.push('Theme');
  if (capabilities.settings) items.push('Settings');

  return items;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Build a feature-icon element. When `iconUrl` is present, render the real
 * image (a resolvable PDS blob URL, loaded directly via <img src>); on load
 * error, fall back to the letter avatar. With no icon, render the letter
 * avatar directly. `name` supplies the fallback letter.
 */
function buildFeatureIcon(name, iconUrl) {
  const icon = document.createElement('div');
  icon.className = 'feature-icon';

  const letter = (name || '?').charAt(0).toUpperCase();

  if (iconUrl) {
    const img = document.createElement('img');
    img.className = 'feature-icon-img';
    img.alt = '';
    img.src = iconUrl;
    // Graceful fallback: if the blob fails to load, show the letter avatar.
    img.addEventListener('error', () => {
      icon.classList.remove('has-image');
      icon.textContent = letter;
    });
    icon.classList.add('has-image');
    icon.appendChild(img);
  } else {
    icon.textContent = letter;
  }

  return icon;
}

async function showInstallPreview(atUri) {
  if (!hasPeekAPI) return;

  showStatus('Resolving feature...');

  try {
    const result = await api.features.installResolve(atUri);

    if (result.error) {
      showStatus(result.error, 'error');
      return;
    }

    const { manifest, source, iconUrl, screenshotUrls } = result;

    // Get capability preview
    const capResult = await api.features.previewCapabilities(
      manifest.capabilities,
      manifest.id,
    );

    hideStatus();

    pendingInstallUri = atUri;
    previewTitle.textContent = manifest.name || manifest.id;

    // Icon — real image when published, else letter avatar
    previewIcon.innerHTML = '';
    previewIcon.appendChild(buildFeatureIcon(manifest.name || manifest.id, iconUrl));

    // Screenshots gallery — render a strip when present, else hide
    previewScreenshots.innerHTML = '';
    if (Array.isArray(screenshotUrls) && screenshotUrls.length > 0) {
      previewScreenshots.style.display = '';
      for (const url of screenshotUrls) {
        const shot = document.createElement('img');
        shot.className = 'preview-screenshot';
        shot.alt = '';
        shot.loading = 'lazy';
        shot.src = url;
        // Drop any screenshot that fails to load (no broken-image icon).
        shot.addEventListener('error', () => shot.remove());
        previewScreenshots.appendChild(shot);
      }
    } else {
      previewScreenshots.style.display = 'none';
    }

    // Meta info
    previewMeta.innerHTML = '';
    const metaRows = [
      ['ID', manifest.id],
      ['Version', source.version || manifest.version || 'unknown'],
      ['Publisher', source.publisherName || source.publisher || 'unknown'],
      ['DID', source.publisher || 'unknown'],
    ];

    if (manifest.description) {
      metaRows.push(['Description', manifest.description]);
    }

    for (const [label, value] of metaRows) {
      const row = document.createElement('div');
      row.className = 'preview-meta-row';
      row.innerHTML = `<span class="preview-meta-label">${label}</span><span class="preview-meta-value">${escapeHtml(value)}</span>`;
      previewMeta.appendChild(row);
    }

    // Capabilities
    previewCapabilities.innerHTML = '';

    if (capResult && !capResult.error) {
      const grantedItems = renderCapabilityList(capResult.granted);
      const deniedItems = capResult.denied || [];

      if (grantedItems.length > 0 || deniedItems.length > 0) {
        const heading = document.createElement('h3');
        heading.textContent = 'Capabilities';
        previewCapabilities.appendChild(heading);

        const list = document.createElement('ul');
        list.className = 'capability-list';

        for (const item of grantedItems) {
          const li = document.createElement('li');
          li.className = 'capability-item granted';
          li.textContent = item;
          list.appendChild(li);
        }

        for (const item of deniedItems) {
          const li = document.createElement('li');
          li.className = 'capability-item denied';
          li.textContent = `${item} (denied)`;
          list.appendChild(li);
        }

        previewCapabilities.appendChild(list);
      }
    }

    installPreview.style.display = '';
  } catch (err) {
    console.error('[features-manager:browse] resolve error:', err);
    showStatus(`Error: ${err.message}`, 'error');
  }
}

async function confirmInstall() {
  if (!hasPeekAPI || !pendingInstallUri) return;

  const atUri = pendingInstallUri;
  hidePreview();
  showStatus('Installing feature...');

  try {
    const result = await api.features.install(atUri, true);

    if (result.error) {
      showStatus(`Install failed: ${result.error}`, 'error');
      return;
    }

    showStatus(`Installed "${result.entry.name}" successfully`, 'success');

    // Refresh installed features map and re-render cards
    await loadInstalledFeatures();
    renderResults();

    setTimeout(hideStatus, 3000);
  } catch (err) {
    console.error('[features-manager:browse] install error:', err);
    showStatus(`Error: ${err.message}`, 'error');
  }
}

// ─── Data loading ───────────────────────────────────────────────────

async function loadInstalledFeatures() {
  if (!hasPeekAPI) return;

  try {
    const result = await api.features.list();
    if (result.entries) {
      installedFeatures = {};
      for (const entry of result.entries) {
        installedFeatures[entry.id] = entry;
      }
    }
  } catch (err) {
    console.error('[features-manager:browse] Failed to load installed features:', err);
  }
}

async function searchPublisher(query) {
  if (!hasPeekAPI || !query) return;

  hidePreview();
  hidePublisher();
  featureRecords = [];
  resultCount.textContent = '';
  contentEl.innerHTML = '<div class="loading">Searching...</div>';
  showStatus('Resolving publisher...');

  try {
    // Step 1: Resolve publisher identity
    const pubResult = await api.features.resolvePublisher(query);

    if (pubResult.error) {
      showStatus(pubResult.error, 'error');
      contentEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-title">Could not resolve publisher</div>
          <div class="empty-state-hint">${escapeHtml(pubResult.error)}</div>
        </div>
      `;
      return;
    }

    currentPublisher = pubResult;
    showPublisher(pubResult);
    showStatus('Listing published features...');

    // Step 2: List feature records from publisher's PDS (strict path —
    // gated on `features.browse` capability, defaults to `read`).
    const listResult = await api.features.browseListByPublisher({
      did: pubResult.did,
      pdsUrl: pubResult.pdsUrl,
    });

    hideStatus();

    if (listResult.error) {
      showStatus(listResult.error, 'error');
      contentEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-title">Error loading features</div>
          <div class="empty-state-hint">${escapeHtml(listResult.error)}</div>
        </div>
      `;
      return;
    }

    featureRecords = listResult.records || [];

    // Load installed features for badge comparison
    await loadInstalledFeatures();

    renderResults();
  } catch (err) {
    console.error('[features-manager:browse] search error:', err);
    showStatus(`Error: ${err.message}`, 'error');
    contentEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-title">Search failed</div>
        <div class="empty-state-hint">${escapeHtml(err.message)}</div>
      </div>
    `;
  }
}

// ─── Rendering ──────────────────────────────────────────────────────

function renderResults() {
  if (featureRecords.length === 0) {
    resultCount.textContent = '';
    contentEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-title">No features published</div>
        <div class="empty-state-hint">This account has not published any features.</div>
      </div>
    `;
    return;
  }

  resultCount.textContent = `(${featureRecords.length})`;
  contentEl.innerHTML = '';

  const list = document.createElement('div');
  list.className = 'feature-list';

  for (const record of featureRecords) {
    list.appendChild(createFeatureCard(record));
  }

  contentEl.appendChild(list);
}

function createFeatureCard(record) {
  const card = document.createElement('div');
  card.className = 'feature-card';
  card.dataset.featureId = record.featureId;

  // Icon — real image when published, else letter avatar
  card.appendChild(buildFeatureIcon(record.name, record.iconUrl));

  // Info
  const info = document.createElement('div');
  info.className = 'feature-info';

  const name = document.createElement('div');
  name.className = 'feature-name';
  name.textContent = record.name;
  info.appendChild(name);

  // Description
  if (record.description) {
    const desc = document.createElement('div');
    desc.className = 'feature-description';
    desc.textContent = record.description;
    info.appendChild(desc);
  }

  // Meta row: version + badges
  const meta = document.createElement('div');
  meta.className = 'feature-meta';

  const versionEl = document.createElement('span');
  versionEl.className = 'feature-version';
  versionEl.textContent = 'v' + record.version;
  meta.appendChild(versionEl);

  // Installed / update badge
  const installed = installedFeatures[record.featureId];
  if (installed) {
    const installedVersion = installed.source?.version;
    const hasUpdate = installedVersion && compareSemver(record.version, installedVersion) > 0;
    if (hasUpdate) {
      const updateBadge = document.createElement('span');
      updateBadge.className = 'feature-badge update';
      updateBadge.textContent = 'Update Available';
      meta.appendChild(updateBadge);
    } else {
      const installedBadge = document.createElement('span');
      installedBadge.className = 'feature-badge installed';
      installedBadge.textContent = 'Installed';
      meta.appendChild(installedBadge);
    }
  }

  // Categories
  if (record.categories && record.categories.length > 0) {
    for (const cat of record.categories) {
      const catBadge = document.createElement('span');
      catBadge.className = 'feature-badge category';
      catBadge.textContent = cat;
      meta.appendChild(catBadge);
    }
  }

  info.appendChild(meta);

  // Capabilities tags
  if (record.capabilities && record.capabilities.length > 0) {
    const capsEl = document.createElement('div');
    capsEl.className = 'feature-capabilities';

    for (const cap of record.capabilities) {
      const tag = document.createElement('span');
      tag.className = 'capability-tag';
      tag.textContent = cap;
      capsEl.appendChild(tag);
    }

    info.appendChild(capsEl);
  }

  card.appendChild(info);

  // Actions — ALWAYS visible
  const actions = document.createElement('div');
  actions.className = 'feature-actions';

  if (installed) {
    const installedVersion = installed.source?.version;
    if (installedVersion && compareSemver(record.version, installedVersion) > 0) {
      // Update button
      const updateBtn = document.createElement('button');
      updateBtn.className = 'action-btn primary';
      updateBtn.textContent = 'Update';
      updateBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        showInstallPreview(record.uri);
      });
      actions.appendChild(updateBtn);
    } else {
      // Already installed indicator
      const badge = document.createElement('button');
      badge.className = 'action-btn';
      badge.textContent = 'Installed';
      badge.disabled = true;
      actions.appendChild(badge);
    }
  } else {
    // Install button
    const installBtn = document.createElement('button');
    installBtn.className = 'action-btn primary';
    installBtn.textContent = 'Install';
    installBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showInstallPreview(record.uri);
    });
    actions.appendChild(installBtn);
  }

  card.appendChild(actions);

  return card;
}

// ─── Event listeners ────────────────────────────────────────────────

searchBtn.addEventListener('click', () => {
  const query = publisherInput.value.trim();
  if (!query) return;
  searchPublisher(query);
});

publisherInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const query = publisherInput.value.trim();
    if (!query) return;
    searchPublisher(query);
  }
});

manageBtn.addEventListener('click', () => {
  if (hasPeekAPI) {
    api.window.open('peek://features-manager/manage.html', {
      role: 'workspace',
      key: 'features-manage',
      width: 900,
      height: 650,
      title: 'Features',
    });
  }
});

previewCloseBtn.addEventListener('click', hidePreview);
previewCancelBtn.addEventListener('click', () => {
  hidePreview();
  hideStatus();
});
previewInstallBtn.addEventListener('click', confirmInstall);

// ─── PubSub listeners ──────────────────────────────────────────────

if (hasPeekAPI) {
  api.pubsub.subscribe('feature:installed', async () => {
    await loadInstalledFeatures();
    renderResults();
  });
}

// ─── Init ───────────────────────────────────────────────────────────

async function init() {
  await loadInstalledFeatures();

  // Auto-load curated directory if configured and no query in URL
  const urlParams = new URLSearchParams(window.location.search);
  const initialQuery = urlParams.get('publisher') || '';

  if (initialQuery) {
    publisherInput.value = initialQuery;
    searchPublisher(initialQuery);
  } else if (CURATED_PUBLISHER_DID) {
    // Show curated directory with a label
    publisherInput.placeholder = 'Enter handle or DID, or browse featured below';
    searchPublisher(CURATED_PUBLISHER_DID);
  }
}

init();
