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
    // Step 1: Upload each file as a blob
    progressLabel.textContent = 'Uploading files...';
    const fileEntries = [];

    for (let i = 0; i < totalFiles; i++) {
      const file = files[i];
      progressDetail.textContent = `${file.relativePath} (${i + 1}/${totalFiles})`;
      progressBar.style.width = `${((i) / (totalFiles + 1)) * 100}%`;

      const blobResult = await api.ipc.invoke('feature-publish:upload-blob', {
        pdsUrl: lexSession.pdsUrl,
        accessToken: lexSession.accessToken,
        dpopKeyPairJwk: lexSession.dpopKeyPairJwk,
        refreshToken: lexSession.refreshToken,
        did: lexSession.did,
        data: file.content,
        mimeType: file.mimeType,
      });

      if (blobResult.error) {
        throw new Error(`Failed to upload ${file.relativePath}: ${blobResult.error}`);
      }

      fileEntries.push({
        path: file.relativePath,
        blob: blobResult.blob,
      });
    }

    // Step 2: Upload manifest as a separate blob
    progressLabel.textContent = 'Uploading manifest...';
    progressBar.style.width = `${(totalFiles / (totalFiles + 1)) * 100}%`;

    const manifestFile = files.find(f => f.relativePath === 'manifest.json');
    let manifestBlob = null;

    if (manifestFile) {
      const manifestBlobResult = await api.ipc.invoke('feature-publish:upload-blob', {
        pdsUrl: lexSession.pdsUrl,
        accessToken: lexSession.accessToken,
        dpopKeyPairJwk: lexSession.dpopKeyPairJwk,
        refreshToken: lexSession.refreshToken,
        did: lexSession.did,
        data: manifestFile.content,
        mimeType: 'application/json',
      });

      if (manifestBlobResult.error) {
        throw new Error(`Failed to upload manifest: ${manifestBlobResult.error}`);
      }

      manifestBlob = manifestBlobResult.blob;
    } else {
      throw new Error('No manifest.json found in feature files');
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

    const createResult = await api.ipc.invoke('feature-publish:create-record', {
      pdsUrl: lexSession.pdsUrl,
      accessToken: lexSession.accessToken,
      did: lexSession.did,
      record,
    });

    if (createResult.error) {
      throw new Error(createResult.error);
    }

    // Success
    progressBar.style.width = '100%';
    publishProgress.style.display = 'none';
    publishSuccess.style.display = '';
    successUri.value = createResult.uri;

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

  // Try to get the session from lex settings
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
  api.subscribe('lex:session-changed', (msg) => {
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
}

init();
