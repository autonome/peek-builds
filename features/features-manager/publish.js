/**
 * Features Manager — Publish page
 *
 * Multi-step wizard for publishing local features to AT Protocol.
 * Step 1: Select a local feature
 * Step 2: Preview files and add metadata
 * Step 3: Confirm and publish (upload blobs + create record)
 */

import { uploadBlob, xrpcPost } from 'peek://ext/lex/atproto.js';

const api = window.app;
const hasPeekAPI = !!api;

// ─── Known categories ──────────────────────────────────────────────

const CATEGORIES = [
  'productivity', 'developer', 'social', 'media',
  'search', 'privacy', 'theme', 'utility', 'fun',
];

// Media limits (must match space.peek.feature.release lexicon)
const ICON_MAX_BYTES = 262144;              // 256 KB
const ICON_ACCEPT = ['image/png', 'image/svg+xml'];
const SCREENSHOT_MAX_BYTES = 2097152;        // 2 MB
const SCREENSHOT_ACCEPT = ['image/png', 'image/jpeg'];
const SCREENSHOTS_MAX_COUNT = 5;

// ─── DOM refs ──────────────────────────────────────────────────────

const stepIndicator = document.getElementById('step-indicator');
const statusBar = document.getElementById('status-bar');
const statusText = document.getElementById('status-text');

// Step 1
const step1 = document.getElementById('step-1');
const featureListContent = document.getElementById('feature-list-content');

// Step 2
const step2 = document.getElementById('step-2');
const previewFeatureName = document.getElementById('preview-feature-name');
const previewMeta = document.getElementById('preview-meta');
const fileList = document.getElementById('file-list');
const totalSizeEl = document.getElementById('total-size');
const descriptionInput = document.getElementById('pub-description');
const categoryGrid = document.getElementById('category-grid');
const readmeInput = document.getElementById('pub-readme');
const licenseInput = document.getElementById('pub-license');
const homepageInput = document.getElementById('pub-homepage');
const iconInput = document.getElementById('pub-icon-input');
const iconPickBtn = document.getElementById('pub-icon-pick-btn');
const iconPreview = document.getElementById('pub-icon-preview');
const iconError = document.getElementById('pub-icon-error');
const screenshotsInput = document.getElementById('pub-screenshots-input');
const screenshotsPickBtn = document.getElementById('pub-screenshots-pick-btn');
const screenshotsPreview = document.getElementById('pub-screenshots-preview');
const screenshotsError = document.getElementById('pub-screenshots-error');
const backToStep1 = document.getElementById('back-to-step-1');
const nextToStep3 = document.getElementById('next-to-step-3');

// Step 3
const step3 = document.getElementById('step-3');
const noSessionPanel = document.getElementById('no-session');
const publishPanel = document.getElementById('publish-panel');
const pubHandle = document.getElementById('pub-handle');
const pubDid = document.getElementById('pub-did');
const publishSummary = document.getElementById('publish-summary');
const publishBtn = document.getElementById('publish-btn');
const publishProgress = document.getElementById('publish-progress');
const progressLabel = document.getElementById('progress-label');
const progressBar = document.getElementById('progress-bar');
const progressDetail = document.getElementById('progress-detail');
const publishSuccess = document.getElementById('publish-success');
const successUri = document.getElementById('success-uri');
const copyUriBtn = document.getElementById('copy-uri-btn');
const publishError = document.getElementById('publish-error');
const errorMessage = document.getElementById('error-message');
const retryBtn = document.getElementById('retry-btn');
const backToStep2 = document.getElementById('back-to-step-2');

// ─── State ─────────────────────────────────────────────────────────

let currentStep = 1;
let localFeatures = [];
let selectedFeature = null;       // { id, name, version, path, sourceType }
let featureFiles = null;          // result from read-feature-files IPC
let selectedCategories = new Set();
let lexSession = null;            // AT Protocol session from lex feature
let isPublishing = false;

// Media selections. Each entry: { file: File, mimeType: string, size: number, previewUrl: string }
let iconSelection = null;
let screenshotSelections = [];

// ─── Status helpers ────────────────────────────────────────────────

function showStatus(message, type = 'info') {
  statusBar.style.display = '';
  statusBar.className = 'status-bar' + (type !== 'info' ? ` ${type}` : '');
  statusText.textContent = message;
}

function hideStatus() {
  statusBar.style.display = 'none';
}

// ─── Step navigation ───────────────────────────────────────────────

function goToStep(step) {
  currentStep = step;

  step1.style.display = step === 1 ? '' : 'none';
  step2.style.display = step === 2 ? '' : 'none';
  step3.style.display = step === 3 ? '' : 'none';

  // Update step indicators
  const steps = stepIndicator.querySelectorAll('.step');
  steps.forEach(el => {
    const s = parseInt(el.dataset.step, 10);
    el.classList.remove('active', 'done');
    if (s === step) el.classList.add('active');
    else if (s < step) el.classList.add('done');
  });

  hideStatus();

  if (step === 3) {
    renderStep3();
  }
}

// ─── Step 1: Select Feature ────────────────────────────────────────

async function loadLocalFeatures() {
  if (!hasPeekAPI) {
    featureListContent.innerHTML = '<div class="empty-state"><div class="empty-state-title">Peek API not available</div></div>';
    return;
  }

  try {
    // NOTE: `feature-publish:*` not yet covered by strict `api.features.*`.
    const result = await api.ipc.invoke('feature-publish:list-local');

    if (result.error) {
      featureListContent.innerHTML = `<div class="empty-state"><div class="empty-state-title">${escapeHtml(result.error)}</div></div>`;
      return;
    }

    localFeatures = result.features || [];

    if (localFeatures.length === 0) {
      featureListContent.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon" style="font-family: system-ui;">&#128230;</div>
          <div class="empty-state-title">No local features</div>
          <div class="empty-state-hint">This publishes locally installed features to AT Protocol. Install a feature from a local directory first.</div>
        </div>
      `;
      return;
    }

    renderFeatureList();
  } catch (err) {
    console.error('[features-manager:publish] Failed to load features:', err);
    featureListContent.innerHTML = `<div class="empty-state"><div class="empty-state-title">Failed to load features</div></div>`;
  }
}

function renderFeatureList() {
  featureListContent.innerHTML = '';
  const list = document.createElement('div');
  list.className = 'feature-select-list';

  for (const feature of localFeatures) {
    const card = document.createElement('div');
    card.className = 'feature-select-card';

    const icon = document.createElement('div');
    icon.className = 'feature-icon';
    icon.textContent = feature.name.charAt(0).toUpperCase();
    card.appendChild(icon);

    const info = document.createElement('div');
    info.className = 'feature-info';

    const name = document.createElement('div');
    name.className = 'feature-name';
    name.textContent = feature.name;
    info.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'feature-meta';

    const version = document.createElement('span');
    version.className = 'feature-version';
    version.textContent = 'v' + feature.version;
    meta.appendChild(version);

    const badge = document.createElement('span');
    badge.className = `feature-source-badge ${feature.sourceType}`;
    badge.textContent = feature.sourceType;
    meta.appendChild(badge);

    info.appendChild(meta);

    const pathEl = document.createElement('div');
    pathEl.className = 'feature-path';
    pathEl.textContent = feature.path;
    info.appendChild(pathEl);

    card.appendChild(info);

    card.addEventListener('click', () => selectFeature(feature));

    list.appendChild(card);
  }

  featureListContent.appendChild(list);
}

async function selectFeature(feature) {
  selectedFeature = feature;
  showStatus('Reading feature files...');

  try {
    // NOTE: `feature-publish:*` not yet covered by strict `api.features.*`.
    const result = await api.ipc.invoke('feature-publish:read-feature-files', {
      featureId: feature.id,
    });

    if (result.error) {
      showStatus(result.error, 'error');
      return;
    }

    featureFiles = result;
    hideStatus();
    renderStep2();
    goToStep(2);
  } catch (err) {
    console.error('[features-manager:publish] Failed to read files:', err);
    showStatus(`Error: ${err.message}`, 'error');
  }
}

// ─── Step 2: Preview ───────────────────────────────────────────────

function renderStep2() {
  if (!selectedFeature || !featureFiles) return;

  previewFeatureName.textContent = selectedFeature.name;

  // Meta info
  previewMeta.innerHTML = '';
  const rows = [
    ['ID', selectedFeature.id],
    ['Version', selectedFeature.version],
    ['Source', selectedFeature.sourceType],
    ['Files', featureFiles.files.length.toString()],
  ];

  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'preview-meta-row';
    row.innerHTML = `<span class="preview-meta-label">${label}</span><span class="preview-meta-value">${escapeHtml(value)}</span>`;
    previewMeta.appendChild(row);
  }

  // File list
  fileList.innerHTML = '';
  for (const file of featureFiles.files) {
    const entry = document.createElement('div');
    entry.className = 'file-entry';

    const nameEl = document.createElement('span');
    nameEl.className = 'file-name';
    nameEl.textContent = file.relativePath;

    const sizeEl = document.createElement('span');
    sizeEl.className = 'file-size';
    sizeEl.textContent = formatSize(file.size);

    entry.appendChild(nameEl);
    entry.appendChild(sizeEl);
    fileList.appendChild(entry);
  }

  totalSizeEl.textContent = `Total: ${formatSize(featureFiles.totalSize)} (${featureFiles.files.length} files)`;

  // Pre-fill description from manifest if we find it
  const manifestFile = featureFiles.files.find(f => f.relativePath === 'manifest.json');
  if (manifestFile) {
    try {
      const manifestContent = JSON.parse(atob(manifestFile.content));
      if (manifestContent.description && !descriptionInput.value) {
        descriptionInput.value = manifestContent.description;
      }
    } catch (e) {
      // Ignore parse errors
    }
  }

  // Category chips
  categoryGrid.innerHTML = '';
  for (const cat of CATEGORIES) {
    const chip = document.createElement('button');
    chip.className = 'category-chip' + (selectedCategories.has(cat) ? ' selected' : '');
    chip.textContent = cat;
    chip.addEventListener('click', () => {
      if (selectedCategories.has(cat)) {
        selectedCategories.delete(cat);
        chip.classList.remove('selected');
      } else {
        if (selectedCategories.size < 10) {
          selectedCategories.add(cat);
          chip.classList.add('selected');
        }
      }
    });
    categoryGrid.appendChild(chip);
  }
}

// ─── Step 3: Confirm & Publish ─────────────────────────────────────

function renderStep3() {
  // Check session
  if (!lexSession) {
    noSessionPanel.style.display = '';
    publishPanel.style.display = 'none';
    return;
  }

  noSessionPanel.style.display = 'none';
  publishPanel.style.display = '';

  // Publisher identity
  pubHandle.textContent = '@' + lexSession.handle;
  const did = lexSession.did;
  pubDid.textContent = did.length > 40
    ? did.slice(0, 16) + '...' + did.slice(-8)
    : did;
  pubDid.title = did;

  // Summary
  publishSummary.innerHTML = '';
  const summaryRows = [
    ['Feature', selectedFeature.name],
    ['Version', selectedFeature.version],
    ['Files', `${featureFiles.files.length} (${formatSize(featureFiles.totalSize)})`],
  ];

  if (descriptionInput.value.trim()) {
    summaryRows.push(['Description', descriptionInput.value.trim().slice(0, 100) + (descriptionInput.value.trim().length > 100 ? '...' : '')]);
  }

  if (iconSelection) {
    summaryRows.push(['Icon', `${iconSelection.name} (${formatSize(iconSelection.size)})`]);
  }

  if (screenshotSelections.length > 0) {
    const totalSize = screenshotSelections.reduce((n, s) => n + s.size, 0);
    summaryRows.push(['Screenshots', `${screenshotSelections.length} (${formatSize(totalSize)})`]);
  }

  for (const [label, value] of summaryRows) {
    const row = document.createElement('div');
    row.className = 'summary-row';
    row.innerHTML = `<span class="summary-label">${label}</span><span class="summary-value">${escapeHtml(value)}</span>`;
    publishSummary.appendChild(row);
  }

  if (selectedCategories.size > 0) {
    const row = document.createElement('div');
    row.className = 'summary-row';
    row.innerHTML = `<span class="summary-label">Categories</span>`;
    const cats = document.createElement('span');
    cats.className = 'summary-categories';
    for (const cat of selectedCategories) {
      const span = document.createElement('span');
      span.className = 'summary-category';
      span.textContent = cat;
      cats.appendChild(span);
    }
    row.appendChild(cats);
    publishSummary.appendChild(row);
  }

  // Reset publish state
  publishProgress.style.display = 'none';
  publishSuccess.style.display = 'none';
  publishError.style.display = 'none';
  publishBtn.disabled = false;
}

/**
 * Decode a base64-encoded string (from IPC) into a Uint8Array for blob upload.
 */
function base64ToBytes(b64) {
  const binStr = atob(b64);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
  return bytes;
}

/**
 * Handle a refreshed lex session so future calls within this flow pick up the
 * rotated tokens. Persistence of the refreshed session is owned by the lex
 * feature; we just update our in-memory copy and publish an event so other
 * listeners (including lex's background) can refresh their own state.
 */
function onLexSessionRefreshed(updated) {
  lexSession = updated;
  try {
    api.pubsub.publish('lex:session-changed', { session: updated }, api.scopes?.GLOBAL);
  } catch {}
}

async function doPublish() {
  if (isPublishing || !lexSession || !featureFiles) return;
  isPublishing = true;
  publishBtn.disabled = true;

  publishProgress.style.display = '';
  publishSuccess.style.display = 'none';
  publishError.style.display = 'none';

  const files = featureFiles.files;
  const totalFiles = files.length;

  try {
    // Step 1: Upload each file as a blob (renderer-side DPoP via lex's helpers)
    progressLabel.textContent = 'Uploading files...';
    const fileEntries = [];

    for (let i = 0; i < totalFiles; i++) {
      const file = files[i];
      progressDetail.textContent = `${file.relativePath} (${i + 1}/${totalFiles})`;
      progressBar.style.width = `${((i) / (totalFiles + 1)) * 100}%`;

      const bytes = base64ToBytes(file.content);
      let blobResp;
      try {
        blobResp = await uploadBlob(lexSession, bytes, file.mimeType, onLexSessionRefreshed);
      } catch (err) {
        throw new Error(`Failed to upload ${file.relativePath}: ${err.message}`);
      }

      fileEntries.push({
        path: file.relativePath,
        blob: blobResp.blob,
      });
    }

    // Step 2: Upload manifest as a separate blob
    progressLabel.textContent = 'Uploading manifest...';
    progressBar.style.width = `${(totalFiles / (totalFiles + 1)) * 100}%`;

    const manifestFile = files.find(f => f.relativePath === 'manifest.json');
    if (!manifestFile) {
      throw new Error('No manifest.json found in feature files');
    }

    let manifestBlob;
    try {
      const manifestBytes = base64ToBytes(manifestFile.content);
      const manifestResp = await uploadBlob(
        lexSession,
        manifestBytes,
        'application/json',
        onLexSessionRefreshed
      );
      manifestBlob = manifestResp.blob;
    } catch (err) {
      throw new Error(`Failed to upload manifest: ${err.message}`);
    }

    // Step 3: Build capabilities list from manifest
    let capabilities = [];
    try {
      const manifestContent = JSON.parse(atob(manifestFile.content));
      if (manifestContent.capabilities) {
        capabilities = Object.keys(manifestContent.capabilities);
      }
    } catch (e) {
      // Ignore
    }

    // Step 4: Create the record
    progressLabel.textContent = 'Creating record...';
    progressBar.style.width = '95%';

    const record = {
      $type: 'space.peek.feature.release',
      featureId: selectedFeature.id,
      name: selectedFeature.name,
      version: selectedFeature.version,
      manifest: manifestBlob,
      bundle: {
        files: fileEntries,
        totalSize: featureFiles.totalSize,
      },
      capabilities,
      createdAt: new Date().toISOString(),
    };

    // Optional fields
    const desc = descriptionInput.value.trim();
    if (desc) record.description = desc;

    if (selectedCategories.size > 0) {
      record.categories = Array.from(selectedCategories);
    }

    const readme = readmeInput.value.trim();
    if (readme) record.readme = readme;

    const license = licenseInput.value.trim();
    if (license) record.license = license;

    const homepage = homepageInput.value.trim();
    if (homepage) record.homepage = homepage;

    let createResp;
    try {
      createResp = await xrpcPost(
        lexSession,
        'com.atproto.repo.createRecord',
        {
          repo: lexSession.did,
          collection: 'space.peek.feature.release',
          record,
        },
        onLexSessionRefreshed
      );
    } catch (err) {
      throw new Error(`Record creation failed: ${err.message}`);
    }

    // Success
    progressBar.style.width = '100%';
    publishProgress.style.display = 'none';
    publishSuccess.style.display = '';
    successUri.value = createResp.uri;

  } catch (err) {
    console.error('[features-manager:publish] Publish error:', err);
    publishProgress.style.display = 'none';
    publishError.style.display = '';
    errorMessage.textContent = err.message;
  } finally {
    isPublishing = false;
  }
}

// ─── Session management ────────────────────────────────────────────

async function loadLexSession() {
  if (!hasPeekAPI) return;

  // Try to get the session from lex settings.
  // NOTE: `api.settings.getExtKey` is not part of the strict tile-preload API;
  // cross-tile settings access is pending a pubsub-based replacement
  // (docs `lex:get-session` / `lex:session-state`). Until implemented, we rely
  // on the `lex:session-changed` pubsub broadcast (subscribed below) to
  // populate `lexSession` after any lex login/logout.
  if (typeof api.settings.getExtKey === 'function') {
    try {
      const result = await api.settings.getExtKey('lex', 'session');
      if (result && result.success && result.data) {
        lexSession = result.data;
        console.log('[features-manager:publish] Loaded lex session for', lexSession.handle);
      }
    } catch (err) {
      console.warn('[features-manager:publish] Could not load lex session:', err);
    }
  }
}

// ─── Media picker (icon + screenshots) ────────────────────────────

function createSelection(file) {
  return {
    file,
    mimeType: file.type,
    size: file.size,
    name: file.name,
    previewUrl: URL.createObjectURL(file),
  };
}

function revokeSelection(sel) {
  if (sel && sel.previewUrl) {
    try { URL.revokeObjectURL(sel.previewUrl); } catch {}
  }
}

function showMediaError(el, message) {
  el.textContent = message || '';
}

function validateMediaFile(file, { accept, maxBytes, kind }) {
  if (!accept.includes(file.type)) {
    return `${kind} "${file.name}": unsupported type (${file.type || 'unknown'}). Allowed: ${accept.join(', ')}.`;
  }
  if (file.size > maxBytes) {
    return `${kind} "${file.name}": ${formatSize(file.size)} exceeds max ${formatSize(maxBytes)}.`;
  }
  return null;
}

function renderIconPreview() {
  iconPreview.innerHTML = '';
  if (!iconSelection) {
    iconPickBtn.textContent = 'Choose icon\u2026';
    return;
  }

  iconPickBtn.textContent = 'Replace icon\u2026';

  const item = document.createElement('div');
  item.className = 'media-preview-item';

  const img = document.createElement('img');
  img.className = 'media-preview-thumb';
  img.alt = iconSelection.name;
  img.src = iconSelection.previewUrl;
  item.appendChild(img);

  const meta = document.createElement('div');
  meta.className = 'media-preview-meta';
  meta.textContent = formatSize(iconSelection.size);
  meta.title = `${iconSelection.name} (${iconSelection.mimeType})`;
  item.appendChild(meta);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'media-preview-remove';
  removeBtn.setAttribute('aria-label', 'Remove icon');
  removeBtn.textContent = '\u00d7';
  removeBtn.addEventListener('click', () => {
    revokeSelection(iconSelection);
    iconSelection = null;
    showMediaError(iconError, '');
    renderIconPreview();
  });
  item.appendChild(removeBtn);

  iconPreview.appendChild(item);
}

function renderScreenshotsPreview() {
  screenshotsPreview.innerHTML = '';

  const atLimit = screenshotSelections.length >= SCREENSHOTS_MAX_COUNT;
  screenshotsPickBtn.disabled = atLimit;
  screenshotsPickBtn.textContent = atLimit
    ? `Screenshots (${screenshotSelections.length}/${SCREENSHOTS_MAX_COUNT})`
    : `Add screenshots\u2026 (${screenshotSelections.length}/${SCREENSHOTS_MAX_COUNT})`;

  screenshotSelections.forEach((sel, idx) => {
    const item = document.createElement('div');
    item.className = 'media-preview-item';

    const img = document.createElement('img');
    img.className = 'media-preview-thumb';
    img.alt = sel.name;
    img.src = sel.previewUrl;
    item.appendChild(img);

    const meta = document.createElement('div');
    meta.className = 'media-preview-meta';
    meta.textContent = formatSize(sel.size);
    meta.title = `${sel.name} (${sel.mimeType})`;
    item.appendChild(meta);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'media-preview-remove';
    removeBtn.setAttribute('aria-label', `Remove screenshot ${idx + 1}`);
    removeBtn.textContent = '\u00d7';
    removeBtn.addEventListener('click', () => {
      const [removed] = screenshotSelections.splice(idx, 1);
      revokeSelection(removed);
      showMediaError(screenshotsError, '');
      renderScreenshotsPreview();
    });
    item.appendChild(removeBtn);

    screenshotsPreview.appendChild(item);
  });
}

function handleIconFileChange(e) {
  showMediaError(iconError, '');
  const file = e.target.files && e.target.files[0];
  // Reset the input so selecting the same file again still fires change
  e.target.value = '';
  if (!file) return;

  const err = validateMediaFile(file, {
    accept: ICON_ACCEPT,
    maxBytes: ICON_MAX_BYTES,
    kind: 'Icon',
  });
  if (err) {
    showMediaError(iconError, err);
    return;
  }

  if (iconSelection) revokeSelection(iconSelection);
  iconSelection = createSelection(file);
  renderIconPreview();
}

function handleScreenshotsFileChange(e) {
  showMediaError(screenshotsError, '');
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (files.length === 0) return;

  const remainingSlots = SCREENSHOTS_MAX_COUNT - screenshotSelections.length;
  const errors = [];

  if (files.length > remainingSlots) {
    errors.push(`Only ${remainingSlots} more screenshot(s) allowed (max ${SCREENSHOTS_MAX_COUNT}).`);
  }

  const toAdd = files.slice(0, remainingSlots);
  for (const file of toAdd) {
    const err = validateMediaFile(file, {
      accept: SCREENSHOT_ACCEPT,
      maxBytes: SCREENSHOT_MAX_BYTES,
      kind: 'Screenshot',
    });
    if (err) {
      errors.push(err);
      continue;
    }
    screenshotSelections.push(createSelection(file));
  }

  if (errors.length > 0) {
    showMediaError(screenshotsError, errors.join(' '));
  }
  renderScreenshotsPreview();
}

// ─── Helpers ───────────────────────────────────────────────────────

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── Event listeners ───────────────────────────────────────────────

backToStep1.addEventListener('click', () => goToStep(1));
nextToStep3.addEventListener('click', () => goToStep(3));
backToStep2.addEventListener('click', () => goToStep(2));

iconPickBtn.addEventListener('click', () => iconInput.click());
iconInput.addEventListener('change', handleIconFileChange);

screenshotsPickBtn.addEventListener('click', () => screenshotsInput.click());
screenshotsInput.addEventListener('change', handleScreenshotsFileChange);

publishBtn.addEventListener('click', doPublish);

copyUriBtn.addEventListener('click', () => {
  successUri.select();
  navigator.clipboard.writeText(successUri.value).then(() => {
    copyUriBtn.textContent = 'Copied!';
    setTimeout(() => { copyUriBtn.textContent = 'Copy URI'; }, 2000);
  });
});

retryBtn.addEventListener('click', () => {
  publishError.style.display = 'none';
  publishBtn.disabled = false;
});

// PubSub: listen for session changes from lex feature
if (hasPeekAPI) {
  api.pubsub.subscribe('lex:session-changed', (msg) => {
    if (msg.session) {
      lexSession = msg.session;
      console.log('[features-manager:publish] Session updated for', lexSession.handle);
    } else {
      lexSession = null;
      console.log('[features-manager:publish] Session cleared');
    }
    // Re-render step 3 if currently showing
    if (currentStep === 3) {
      renderStep3();
    }
  }, api.scopes?.GLOBAL);
}

// ─── Init ──────────────────────────────────────────────────────────

async function init() {
  await loadLexSession();
  await loadLocalFeatures();

  // Check for featureId query param (pre-selection from dev card "Publish" button)
  const urlParams = new URLSearchParams(window.location.search);
  const preSelectId = urlParams.get('featureId');
  if (preSelectId && localFeatures.length > 0) {
    const feature = localFeatures.find(f => f.id === preSelectId);
    if (feature) {
      // Auto-select this feature and skip to step 2
      await selectFeature(feature);
    }
  }
}

init();
