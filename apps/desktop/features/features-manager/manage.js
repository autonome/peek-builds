/**
 * Features Manager — Manage page
 *
 * Shows installed non-built-in features with enable/disable/remove actions.
 * Fetches feature list from registry via IPC.
 */

import { buildHistoryRows } from './history-format.js';

const api = window.app;
const hasPeekAPI = !!api;

// ─── Builtin feature state ──────────────────────────────────────────
//
// Builtin enable/disable persistence still rides the legacy core-store
// ITEMS list (feature_settings featureId='core', key='items') and the
// `core:feature:toggle` publish, mirroring the contract Settings used to
// own. The bgWindow orchestrator (renderer/index.js) subscribes to that
// topic and routes tile-backed builtins through api.features.enable /
// disable; the core-store write keeps the legacy `enabled` flag in sync
// for entries that exist there. cmd is required infrastructure — never
// disablable.
const CORE_STORE_NAMESPACE = 'core';
const CORE_STORE_ITEMS_KEY = 'items';
const FEATURE_TOGGLE_TOPIC = 'core:feature:toggle';
const LOCKED_BUILTIN_IDS = new Set(['cmd']);

// ─── feature_settings store helper ──────────────────────────────────
//
// Minimal async datastore-backed store, ported from renderer/utils.js
// createDatastoreStore. Each namespace maps to feature_settings rows with
// featureId=namespace. Used for (a) the core-store ITEMS list that drives
// builtin enable/disable persistence and (b) per-feature Options that
// read/write a feature's own prefs/items rows.
async function createFeatureSettingsStore(namespace, defaults = {}) {
  const table = 'feature_settings';
  const cache = {};

  try {
    const result = await api.datastore.getTable(table);
    if (result?.success && result.data) {
      for (const row of Object.values(result.data)) {
        if (row.featureId === namespace && row.value) {
          try {
            cache[row.key] = JSON.parse(row.value);
          } catch (e) {
            console.warn(`[features-manager] Failed to parse ${namespace}:${row.key}`, e);
          }
        }
      }
    }
  } catch (e) {
    console.warn(`[features-manager] Failed to load store ${namespace}`, e);
  }

  for (const key of Object.keys(defaults)) {
    if (cache[key] === undefined) cache[key] = defaults[key];
  }

  return {
    get(key) {
      return cache[key] !== undefined ? cache[key] : defaults[key];
    },
    async set(key, value) {
      cache[key] = value;
      const rowId = `${namespace}:${key}`;
      try {
        await api.datastore.setRow(table, rowId, {
          featureId: namespace,
          key,
          value: JSON.stringify(value),
          updatedAt: Date.now(),
        });
      } catch (e) {
        console.error(`[features-manager] Failed to save ${namespace}:${key}`, e);
      }
    },
  };
}

// ─── Options form-control builders ──────────────────────────────────
//
// Ported (trimmed) from renderer/settings/settings.js so the per-feature
// Options UI renders identically inside a Features Manager card. They use
// the same .form-group / .form-group-inline / .form-section / .item-card
// class names — manage.css adds matching styles.

function camelToLabel(str) {
  const result = str.replace(/([A-Z])/g, ' $1').toLowerCase();
  return result.charAt(0).toUpperCase() + result.slice(1);
}

function optInput(label, value, onChange, options = {}) {
  const group = document.createElement('div');
  group.className = 'form-group';

  const labelEl = document.createElement('label');
  labelEl.textContent = label;

  const input = document.createElement('input');
  input.type = options.type || 'text';
  const isMissing = (v) => v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v));
  const renderValue = isMissing(value) && options.default !== undefined ? options.default : value;
  input.value = (renderValue === null || renderValue === undefined) ? '' : renderValue;
  input.disabled = options.disabled || false;
  if (options.placeholder) input.placeholder = options.placeholder;
  if (options.type === 'number' && options.step) input.step = options.step;

  input.addEventListener('change', (e) => {
    let val = options.type === 'number' ? parseFloat(e.target.value) : e.target.value;
    if (options.type === 'number' && Number.isNaN(val) && options.default !== undefined) {
      val = options.default;
      input.value = val;
    }
    onChange(val);
  });

  group.appendChild(labelEl);
  group.appendChild(input);

  if (options.helpText) {
    const help = document.createElement('div');
    help.className = 'help-text';
    help.textContent = options.helpText;
    group.appendChild(help);
  }
  return group;
}

function optCheckbox(label, value, onChange, options = {}) {
  const group = document.createElement('div');
  group.className = 'form-group-inline';

  const labelEl = document.createElement('label');
  labelEl.textContent = label;

  const wrapper = document.createElement('div');
  wrapper.className = 'checkbox-wrapper';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = value || false;
  input.disabled = options.disabled || false;
  input.addEventListener('change', (e) => onChange(e.target.checked));
  wrapper.appendChild(input);

  const textDiv = document.createElement('div');
  textDiv.className = 'form-group-inline-text';
  textDiv.appendChild(labelEl);
  if (options.helpText) {
    const help = document.createElement('div');
    help.className = 'help-text';
    help.textContent = options.helpText;
    textDiv.appendChild(help);
  }

  group.appendChild(textDiv);
  group.appendChild(wrapper);
  return group;
}

function optSelect(label, value, selectOptions, onChange, extra = {}) {
  const group = document.createElement('div');
  group.className = 'form-group';

  const labelEl = document.createElement('label');
  labelEl.textContent = label;

  const select = document.createElement('select');
  for (const opt of selectOptions) {
    const optionEl = document.createElement('option');
    optionEl.value = opt.value;
    optionEl.textContent = opt.label;
    if (opt.value === value) optionEl.selected = true;
    select.appendChild(optionEl);
  }
  select.addEventListener('change', (e) => onChange(e.target.value));

  group.appendChild(labelEl);
  group.appendChild(select);
  if (extra.helpText) {
    const help = document.createElement('div');
    help.className = 'help-text';
    help.textContent = extra.helpText;
    group.appendChild(help);
  }
  return group;
}

// ─── Per-feature Options renderer ───────────────────────────────────
//
// Ported from renderer/settings/settings.js::renderFeatureSettings.
// Reads/writes the feature's own feature_settings namespace (keyed by the
// feature's shortname == registry entry id) and publishes
// `<shortname>:settings-changed` (GLOBAL) on every save so the live
// feature hot-reloads. The keying + topic MUST match exactly or the
// running feature stops picking up config changes.
async function renderFeatureOptions(feature) {
  const { id, labels, schemas, storageKeys, defaults } = feature;

  // Shortname-keyed namespace — same derivation Settings used.
  const featureId = feature.shortname || labels.name.toLowerCase();
  const store = await createFeatureSettingsStore(featureId, defaults);

  let prefs = store.get(storageKeys.PREFS);
  let items = store.get(storageKeys.ITEMS);

  const container = document.createElement('div');
  const settingsChangedTopic = `${featureId}:settings-changed`;

  const save = async () => {
    await store.set(storageKeys.PREFS, prefs);
    if (items) await store.set(storageKeys.ITEMS, items);
    // GLOBAL/cross-process so the live feature hot-reloads.
    api.publish(settingsChangedTopic, {});
  };

  // Preferences
  if (schemas.prefs && schemas.prefs.properties && Object.keys(schemas.prefs.properties).length > 0) {
    const prefsSection = document.createElement('div');
    prefsSection.className = 'form-section';
    const pProps = schemas.prefs.properties;

    if (!prefs) prefs = {};

    Object.keys(pProps).forEach(k => {
      const s = pProps[k];
      const v = (prefs && Object.prototype.hasOwnProperty.call(prefs, k)) ? prefs[k] : s.default;
      const displayLabel = (labels.prefs && labels.prefs[k]) || camelToLabel(k);

      if (s.type === 'boolean') {
        prefsSection.appendChild(optCheckbox(displayLabel, v, (nv) => { prefs[k] = nv; save(); }, { helpText: s.description }));
      } else if (s.type === 'integer' || s.type === 'number') {
        prefsSection.appendChild(optInput(displayLabel, v, (nv) => { prefs[k] = nv; save(); }, {
          type: 'number', step: s.type === 'integer' ? 1 : 0.1, helpText: s.description,
        }));
      } else if (s.enum && Array.isArray(s.enum)) {
        const selectOptions = s.enum.map(val => ({ value: val, label: (s.enumLabels && s.enumLabels[val]) || val }));
        prefsSection.appendChild(optSelect(displayLabel, v, selectOptions, (nv) => { prefs[k] = nv; save(); }, { helpText: s.description }));
      } else {
        prefsSection.appendChild(optInput(displayLabel, v, (nv) => { prefs[k] = nv; save(); }, { helpText: s.description }));
      }
    });

    container.appendChild(prefsSection);
  }

  // Items
  if (items && items.length > 0) {
    const itemsSection = document.createElement('div');
    itemsSection.className = 'form-section';

    const title = document.createElement('h3');
    title.className = 'form-section-title';
    title.textContent = schemas.item?.title || 'Items';
    itemsSection.appendChild(title);

    items.forEach((item, i) => {
      const card = document.createElement('div');
      card.className = 'item-card collapsed';

      const header = document.createElement('div');
      header.className = 'item-card-header';

      const cardTitle = document.createElement('div');
      cardTitle.className = 'item-card-title';
      cardTitle.textContent = item.title || item.name || `Item ${i + 1}`;
      header.appendChild(cardTitle);

      const wrapper = document.createElement('div');
      wrapper.className = 'checkbox-wrapper';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = item.enabled || false;
      checkbox.addEventListener('change', (e) => {
        e.stopPropagation();
        items[i].enabled = e.target.checked;
        save();
      });

      wrapper.appendChild(checkbox);
      header.appendChild(wrapper);
      card.appendChild(header);

      header.addEventListener('click', (e) => {
        if (e.target === checkbox) return;
        card.classList.toggle('collapsed');
      });

      const body = document.createElement('div');
      body.className = 'item-card-body';

      const itemProps = schemas.item?.properties || {};
      Object.keys(itemProps).forEach(k => {
        if (k === 'enabled' || k === 'id' || k === 'version') return;
        const s = itemProps[k];
        const v = item[k];

        if (s.type === 'boolean') {
          body.appendChild(optCheckbox(k, v, (nv) => { items[i][k] = nv; save(); }));
        } else if (s.type === 'integer' || s.type === 'number') {
          body.appendChild(optInput(k, v, (nv) => { items[i][k] = nv; save(); }, {
            type: 'number', step: s.type === 'integer' ? 1 : 0.1, helpText: s.description, disabled: s.readOnly,
          }));
        } else {
          body.appendChild(optInput(k, v, (nv) => { items[i][k] = nv; save(); }, {
            type: k.includes('address') || k.includes('url') ? 'url' : 'text',
            helpText: s.description, disabled: s.readOnly,
          }));
        }
      });

      card.appendChild(body);
      itemsSection.appendChild(card);
    });

    container.appendChild(itemsSection);
  }

  if (!container.firstChild) {
    const empty = document.createElement('div');
    empty.className = 'help-text';
    empty.textContent = 'This feature has no configurable options.';
    container.appendChild(empty);
  }

  return container;
}

// ─── DOM refs ───────────────────────────────────────────────────────

const contentEl = document.getElementById('content');
const searchInput = document.getElementById('search-input');
const featureCountEl = document.querySelector('.feature-count');
const installUriInput = document.getElementById('install-uri-input');
const installBtn = document.getElementById('install-btn');
const installPreview = document.getElementById('install-preview');
const previewTitle = document.getElementById('preview-title');
const previewMeta = document.getElementById('preview-meta');
const previewCapabilities = document.getElementById('preview-capabilities');
const previewCloseBtn = document.getElementById('preview-close');
const previewCancelBtn = document.getElementById('preview-cancel');
const previewInstallBtn = document.getElementById('preview-install');
const installStatus = document.getElementById('install-status');
const installStatusText = document.getElementById('install-status-text');
const checkUpdatesBtn = document.getElementById('check-updates-btn');
const updateFooter = document.getElementById('update-footer');
const updateFooterText = document.getElementById('update-footer-text');
const capReviewOverlay = document.getElementById('cap-review-overlay');
const capReviewTitle = document.getElementById('cap-review-title');
const capReviewDesc = document.getElementById('cap-review-desc');
const capReviewChanges = document.getElementById('cap-review-changes');
const capReviewDismiss = document.getElementById('cap-review-dismiss');
const capReviewApprove = document.getElementById('cap-review-approve');

// Create Feature form
const createFeatureBtn = document.getElementById('create-feature-btn');
const createFeatureForm = document.getElementById('create-feature-form');
const createCancelBtn = document.getElementById('create-cancel-btn');
const createPickDirBtn = document.getElementById('create-pick-dir-btn');
const createDirPath = document.getElementById('create-dir-path');
const createFeatureId = document.getElementById('create-feature-id');
const createFeatureName = document.getElementById('create-feature-name');
const createSubmitBtn = document.getElementById('create-submit-btn');

// ─── State ──────────────────────────────────────────────────────────

let features = [];
let searchFilter = '';
let pendingInstallUri = null;  // AT URI currently being previewed
let pendingCapReviewId = null; // Feature ID pending capability review
let createDirSelected = null;  // Selected directory for feature creation

// ─── Data loading ───────────────────────────────────────────────────

async function loadFeatures() {
  if (!hasPeekAPI) {
    showEmpty('Peek API not available');
    return;
  }

  try {
    // tile:features:list hides builtins from the no-arg (default) response,
    // so issue a second call with sourceType: 'builtin' and merge. The two
    // responses are disjoint by source type (non-builtin vs builtin), but
    // dedupe by feature id defensively in case that ever changes.
    const [nonBuiltinResult, builtinResult] = await Promise.all([
      api.features.list(),
      api.features.list('builtin'),
    ]);

    if (nonBuiltinResult?.error) {
      showEmpty(nonBuiltinResult.error);
      return;
    }

    const merged = [];
    const seen = new Set();
    for (const entry of [
      ...(nonBuiltinResult?.entries || []),
      ...(builtinResult?.entries || []),
    ]) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      merged.push(entry);
    }

    // Fetch each feature's settings-schema JSON in parallel so the
    // per-feature Options affordance can render. The registry's flat
    // entry shape doesn't carry the schema, so without this round-trip the
    // Options gate is always false and config never appears.
    const schemaResults = await Promise.all(
      merged.map(entry =>
        api.features.settingsSchema(entry.id)
          .then(r => (r?.success ? r.data : null))
          .catch(() => null)
      )
    );
    merged.forEach((entry, i) => { entry.settingsSchema = schemaResults[i]; });

    features = merged;
    render();
    updateLastCheckedFooter();
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
    : 'Install a feature from an AT URI above, browse publishers, or create a new dev feature. Built-in features always appear here once loaded.';

  const title = errorMsg ? 'Could not load features' : 'No features yet';

  contentEl.innerHTML = `
    <div class="empty-state">
      <div class="empty-state-icon">\u2699</div>
      <div class="empty-state-title">${title}</div>
      <div class="empty-state-hint">${hint}</div>
    </div>
  `;
}

function createFeatureCard(feature) {
  const isDev = feature.source?.type === 'dev';
  const isBuiltin = feature.source?.type === 'builtin';
  const card = document.createElement('div');
  card.className = 'feature-card' + (feature.disabled ? ' disabled' : '') + (isDev ? ' dev' : '');
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

  // Update available badge
  if (feature.availableVersion) {
    const updateBadge = document.createElement('span');
    updateBadge.className = 'feature-update-badge';
    updateBadge.textContent = `Update: v${feature.availableVersion}`;
    meta.appendChild(updateBadge);
  }

  info.appendChild(meta);

  // Update policy selector (only for atproto-sourced features)
  if (sourceType === 'atproto') {
    const policyRow = document.createElement('div');
    policyRow.className = 'feature-policy-row';

    const policyLabel = document.createElement('span');
    policyLabel.className = 'feature-policy-label';
    policyLabel.textContent = 'Updates:';
    policyRow.appendChild(policyLabel);

    const policySelect = document.createElement('select');
    policySelect.className = 'feature-policy-select';
    const policies = [
      { value: 'auto', label: 'Auto' },
      { value: 'notify', label: 'Notify' },
      { value: 'pinned', label: 'Pinned' },
    ];
    for (const p of policies) {
      const opt = document.createElement('option');
      opt.value = p.value;
      opt.textContent = p.label;
      if ((feature.updatePolicy || 'auto') === p.value) {
        opt.selected = true;
      }
      policySelect.appendChild(opt);
    }
    policySelect.addEventListener('change', (e) => {
      e.stopPropagation();
      setUpdatePolicy(feature.id, policySelect.value);
    });
    policyRow.appendChild(policySelect);

    if (feature.updatePolicy === 'pinned' && feature.pinnedVersion) {
      const pinned = document.createElement('span');
      pinned.className = 'feature-pinned-version';
      pinned.textContent = `v${feature.pinnedVersion}`;
      policyRow.appendChild(pinned);
    }

    info.appendChild(policyRow);
  }

  card.appendChild(info);

  // Actions — ALWAYS visible
  const actions = document.createElement('div');
  actions.className = 'feature-actions';

  // Update button (if update available)
  if (feature.availableVersion) {
    const updateBtn = document.createElement('button');
    updateBtn.className = 'action-btn primary';
    updateBtn.textContent = 'Update';
    updateBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      applyUpdate(feature.id, feature.name);
    });
    actions.appendChild(updateBtn);
  }

  // Enable/Disable toggle — shown for ALL features, including builtins.
  // The cmd feature is required infrastructure and can never be disabled.
  const isLocked = LOCKED_BUILTIN_IDS.has(feature.id);
  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'action-btn' + (isDisabled ? ' primary' : '');
  toggleBtn.textContent = isLocked ? 'Required' : (isDisabled ? 'Enable' : 'Disable');
  toggleBtn.disabled = isLocked;
  if (isLocked) toggleBtn.title = 'Required infrastructure — cannot be disabled';
  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isLocked) return;
    toggleFeature(feature.id, isDisabled, isBuiltin);
  });
  actions.appendChild(toggleBtn);

  // Remove stays suppressed for builtins: builtins ship with the app and
  // the backend rejects tile:features:remove for them. Non-builtins get a
  // Remove (installed) / Unregister (dev) button.
  if (!isBuiltin) {
    const removeBtn = document.createElement('button');
    removeBtn.className = 'action-btn danger';
    removeBtn.textContent = isDev ? 'Unregister' : 'Remove';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isDev) {
        unregisterDevFeature(feature.id, feature.name);
      } else {
        removeFeature(feature.id, feature.name);
      }
    });
    actions.appendChild(removeBtn);
  }

  // DevTools — available for ALL features (installed or dev-source).
  // Observability: lets a user crack open any running tile's devtools
  // to inspect console logs, network, DOM. Uses the new unified
  // `feature-devtools:open` IPC handler which doesn't require a
  // capability token (it's origin-gated to peek:// callers).
  const openDevtoolsBtn = document.createElement('button');
  openDevtoolsBtn.className = 'action-btn';
  openDevtoolsBtn.textContent = 'DevTools';
  openDevtoolsBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      // Strict path — gated on `features.devtools` capability.
      const result = await api.features.devtoolsOpen(feature.id);
      if (result && result.error) {
        showStatus(result.error, 'error');
        setTimeout(hideStatus, 3000);
      }
    } catch (err) {
      console.error('[features-manager] devtools error:', err);
      showStatus(`DevTools error: ${err.message}`, 'error');
      setTimeout(hideStatus, 3000);
    }
  });
  actions.appendChild(openDevtoolsBtn);

  // Dev-specific actions
  if (isDev) {
    const devActions = document.createElement('div');
    devActions.className = 'feature-dev-actions';

    const reloadBtn = document.createElement('button');
    reloadBtn.className = 'action-btn';
    reloadBtn.textContent = 'Reload';
    reloadBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      reloadBtn.textContent = 'Reloading...';
      reloadBtn.disabled = true;
      try {
        // Strict path — gated on `features.dev` capability.
        const result = await api.features.devReload(feature.id);
        reloadBtn.textContent = result.error ? 'Error' : 'Reloaded';
        if (result.error) console.error('[features-manager] reload error:', result.error);
        setTimeout(() => { reloadBtn.textContent = 'Reload'; reloadBtn.disabled = false; }, 1500);
      } catch (err) {
        console.error('[features-manager] reload error:', err);
        reloadBtn.textContent = 'Reload';
        reloadBtn.disabled = false;
      }
    });
    devActions.appendChild(reloadBtn);

    const validateBtn = document.createElement('button');
    validateBtn.className = 'action-btn';
    validateBtn.textContent = 'Validate';
    validateBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      validateBtn.textContent = 'Validating...';
      validateBtn.disabled = true;
      try {
        // Strict path — gated on `features.dev` capability.
        const result = await api.features.devValidate(feature.id);
        if (result.error) {
          showStatus(result.error, 'error');
        } else if (result.valid) {
          const warnMsg = result.warnings.length > 0
            ? ` (${result.warnings.length} warning${result.warnings.length > 1 ? 's' : ''})`
            : '';
          showStatus(`Validation passed${warnMsg}`, 'success');
          if (result.warnings.length > 0) {
            console.log('[features-manager] Validation warnings:', result.warnings);
          }
        } else {
          showStatus(`Validation failed: ${result.errors.join('; ')}`, 'error');
        }
        setTimeout(hideStatus, 5000);
      } catch (err) {
        console.error('[features-manager] validate error:', err);
        showStatus(`Error: ${err.message}`, 'error');
      } finally {
        validateBtn.textContent = 'Validate';
        validateBtn.disabled = false;
      }
    });
    devActions.appendChild(validateBtn);

    const publishBtn = document.createElement('button');
    publishBtn.className = 'action-btn primary';
    publishBtn.textContent = 'Publish';
    publishBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Open publish.html with featureId pre-selected
      if (hasPeekAPI) {
        api.window.open(`peek://features-manager/publish.html?featureId=${encodeURIComponent(feature.id)}`, {
          key: 'features-publish',
          width: 700,
          height: 600,
          title: 'Publish Feature',
        });
      }
    });
    devActions.appendChild(publishBtn);

    card.appendChild(devActions);
  }

  // Options affordance — only for features that declare a settings schema
  // (prefs or items). Lazy-renders the per-feature config on first expand.
  const schema = feature.settingsSchema;
  const hasOptions = !!(schema && (schema.prefs || schema.item));
  if (hasOptions) {
    const optionsPanel = document.createElement('div');
    optionsPanel.className = 'feature-options-panel';
    optionsPanel.style.display = 'none';

    const optionsBtn = document.createElement('button');
    optionsBtn.className = 'action-btn feature-options-toggle';
    optionsBtn.textContent = 'Options';
    optionsBtn.setAttribute('aria-expanded', 'false');
    let optionsLoaded = false;
    optionsBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const expanded = optionsPanel.style.display !== 'none';
      if (expanded) {
        optionsPanel.style.display = 'none';
        optionsBtn.setAttribute('aria-expanded', 'false');
        return;
      }
      optionsPanel.style.display = '';
      optionsBtn.setAttribute('aria-expanded', 'true');
      if (!optionsLoaded) {
        optionsLoaded = true;
        try {
          const featureForOptions = {
            id: feature.id,
            shortname: feature.id,
            labels: { name: feature.name },
            schemas: { prefs: schema.prefs, item: schema.item },
            storageKeys: schema.storageKeys || { PREFS: 'prefs', ITEMS: 'items' },
            defaults: schema.defaults || {},
          };
          const content = await renderFeatureOptions(featureForOptions);
          optionsPanel.appendChild(content);
        } catch (err) {
          console.error(`[features-manager] Failed to load options for ${feature.id}:`, err);
          const errorMsg = document.createElement('div');
          errorMsg.className = 'help-text feature-options-error';
          errorMsg.textContent = 'Failed to load options: ' + err.message;
          optionsPanel.appendChild(errorMsg);
        }
      }
    });
    actions.appendChild(optionsBtn);

    card.appendChild(actions);
    card.appendChild(optionsPanel);
  } else {
    card.appendChild(actions);
  }

  return card;
}

// ─── Actions ────────────────────────────────────────────────────────

async function toggleFeature(id, currentlyDisabled, isBuiltin = false) {
  if (!hasPeekAPI) return;
  if (LOCKED_BUILTIN_IDS.has(id)) return; // cmd is required infrastructure.

  const newEnabled = currentlyDisabled; // enabling when currently disabled

  try {
    if (isBuiltin) {
      // Builtin path — replicate the legacy Settings contract exactly:
      //   1. Persist the `enabled` flag in the core-store ITEMS list
      //      (feature_settings featureId='core', key='items'), matching by
      //      name (case-insensitive). Entries that don't exist there are
      //      left alone — the registry flag (set by the toggle handler via
      //      api.features.enable/disable) is the boot source of truth.
      //   2. Publish `core:feature:toggle` so the bgWindow orchestrator
      //      (renderer/index.js) loads/unloads the tile-backed feature.
      const coreStore = await createFeatureSettingsStore(CORE_STORE_NAMESPACE);
      const itemsList = coreStore.get(CORE_STORE_ITEMS_KEY) || [];
      const idx = itemsList.findIndex(f => (f.name || '').toLowerCase() === id);
      if (idx >= 0) {
        itemsList[idx].enabled = newEnabled;
        await coreStore.set(CORE_STORE_ITEMS_KEY, itemsList);
      }
      api.publish(FEATURE_TOGGLE_TOPIC, { featureId: id, enabled: newEnabled });
    } else {
      // Non-builtin path — unified registry. enable / disable mark the
      // entry in registry.json + broadcast feature:enabled / feature:disabled;
      // the strict handler launches / unloads tiles as a side-effect.
      const result = newEnabled
        ? await api.features.enable(id)
        : await api.features.disable(id);
      if (result.error) {
        console.error(`[features-manager] toggle error:`, result.error);
        return;
      }
    }

    // Optimistic local update; pubsub refresh (feature:enabled/disabled or
    // a subsequent loadFeatures) reconciles authoritative state.
    const feature = features.find(f => f.id === id);
    if (feature) {
      feature.disabled = !newEnabled;
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
    const result = await api.features.remove(id);
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

async function unregisterDevFeature(id, name) {
  if (!hasPeekAPI) return;

  const confirmed = confirm(`Unregister dev feature "${name}"? Source files on disk will NOT be deleted.`);
  if (!confirmed) return;

  try {
    const result = await api.features.remove(id);
    if (result.error) {
      console.error(`[features-manager] unregister error:`, result.error);
      return;
    }
    features = features.filter(f => f.id !== id);
    render();
  } catch (err) {
    console.error('[features-manager] unregister error:', err);
  }
}

// ─── Create Feature Flow ───────────────────────────────────────────

function showCreateForm() {
  createFeatureForm.style.display = '';
  createDirSelected = null;
  createDirPath.textContent = 'No directory selected';
  createFeatureId.value = '';
  createFeatureName.value = '';
  createSubmitBtn.disabled = true;
}

function hideCreateForm() {
  createFeatureForm.style.display = 'none';
  createDirSelected = null;
}

function updateCreateSubmitState() {
  const hasDir = !!createDirSelected;
  const hasId = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(createFeatureId.value.trim());
  const hasName = createFeatureName.value.trim().length > 0;
  createSubmitBtn.disabled = !(hasDir && hasId && hasName);
}

createFeatureBtn.addEventListener('click', showCreateForm);
createCancelBtn.addEventListener('click', hideCreateForm);

createPickDirBtn.addEventListener('click', async () => {
  if (!hasPeekAPI) return;
  try {
    // Strict path — gated on `features.dev` capability.
    const result = await api.features.devPickDirectory();
    if (result.canceled || result.error) return;
    createDirSelected = result.path;
    createDirPath.textContent = result.path;
    // Auto-suggest feature ID from directory name
    const dirName = result.path.split('/').pop() || '';
    if (!createFeatureId.value && dirName) {
      const suggested = dirName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
      if (suggested.length >= 2) {
        createFeatureId.value = suggested;
      }
    }
    if (!createFeatureName.value && dirName) {
      // Title case from directory name
      createFeatureName.value = dirName
        .replace(/[-_]/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
    }
    updateCreateSubmitState();
  } catch (err) {
    console.error('[features-manager] pick directory error:', err);
  }
});

createFeatureId.addEventListener('input', updateCreateSubmitState);
createFeatureName.addEventListener('input', updateCreateSubmitState);

createSubmitBtn.addEventListener('click', async () => {
  if (!hasPeekAPI || !createDirSelected) return;

  createSubmitBtn.disabled = true;
  createSubmitBtn.textContent = 'Creating...';

  try {
    // Strict path — gated on `features.dev` capability.
    const result = await api.features.devCreate({
      directoryPath: createDirSelected,
      featureId: createFeatureId.value.trim(),
      featureName: createFeatureName.value.trim(),
    });

    if (result.error) {
      showStatus(result.error, 'error');
      setTimeout(hideStatus, 5000);
    } else {
      hideCreateForm();
      showStatus(`Created feature "${result.entry.name}" at ${createDirSelected}`, 'success');
      setTimeout(hideStatus, 5000);
      await loadFeatures();
    }
  } catch (err) {
    console.error('[features-manager] create error:', err);
    showStatus(`Error: ${err.message}`, 'error');
  } finally {
    createSubmitBtn.disabled = false;
    createSubmitBtn.textContent = 'Create';
  }
});

// ─── Update Actions ────────────────────────────────────────────────

async function checkForUpdates() {
  if (!hasPeekAPI) return;

  checkUpdatesBtn.disabled = true;
  checkUpdatesBtn.textContent = 'Checking...';

  try {
    // Strict path — gated on `features.update` capability.
    const result = await api.features.updateCheckAll();

    if (result.error) {
      console.error('[features-manager] Update check error:', result.error);
      showStatus(result.error, 'error');
    } else {
      const count = (result.updates || []).length;
      if (count > 0) {
        showStatus(`${count} update${count > 1 ? 's' : ''} available`, 'info');
      } else {
        showStatus('All features are up to date', 'success');
        setTimeout(hideStatus, 3000);
      }
      // Reload to show updated badges
      await loadFeatures();
    }
  } catch (err) {
    console.error('[features-manager] Update check error:', err);
    showStatus(`Error: ${err.message}`, 'error');
  } finally {
    checkUpdatesBtn.disabled = false;
    checkUpdatesBtn.textContent = 'Check for Updates';
    updateLastCheckedFooter();
  }
}

async function applyUpdate(id, name) {
  if (!hasPeekAPI) return;

  showStatus(`Updating "${name}"...`);

  try {
    // Strict path — gated on `features.update` capability.
    const result = await api.features.updateApply(id, false);

    if (result.capabilitiesChanged) {
      // Show capability review modal
      hideStatus();
      showCapabilityReview(id, name, result.added || [], result.removed || []);
      return;
    }

    if (result.error) {
      showStatus(`Update failed: ${result.error}`, 'error');
      return;
    }

    showStatus(`Updated "${name}" successfully`, 'success');
    setTimeout(hideStatus, 3000);
    await loadFeatures();
  } catch (err) {
    console.error('[features-manager] Update error:', err);
    showStatus(`Error: ${err.message}`, 'error');
  }
}

async function setUpdatePolicy(id, policy) {
  if (!hasPeekAPI) return;

  try {
    // Strict path — gated on `features.update` capability.
    const result = await api.features.updateSetPolicy(id, policy);
    if (result.error) {
      console.error('[features-manager] Set policy error:', result.error);
      return;
    }
    // Update local state
    const feature = features.find(f => f.id === id);
    if (feature) {
      feature.updatePolicy = policy;
      feature.pinnedVersion = result.pinnedVersion;
      render();
    }
  } catch (err) {
    console.error('[features-manager] Set policy error:', err);
  }
}

function showCapabilityReview(id, name, added, removed) {
  pendingCapReviewId = id;
  capReviewTitle.textContent = `Review: ${name}`;
  capReviewDesc.textContent = 'This update requests new capabilities. Review and approve before updating.';

  capReviewChanges.innerHTML = '';

  if (added.length > 0) {
    const addedSection = document.createElement('div');
    addedSection.className = 'cap-review-section';
    const addedTitle = document.createElement('h4');
    addedTitle.textContent = 'New capabilities requested:';
    addedSection.appendChild(addedTitle);
    const list = document.createElement('ul');
    list.className = 'cap-review-list';
    for (const item of added) {
      const li = document.createElement('li');
      li.className = 'cap-review-item added';
      li.textContent = formatCapabilityChange(item);
      list.appendChild(li);
    }
    addedSection.appendChild(list);
    capReviewChanges.appendChild(addedSection);
  }

  if (removed.length > 0) {
    const removedSection = document.createElement('div');
    removedSection.className = 'cap-review-section';
    const removedTitle = document.createElement('h4');
    removedTitle.textContent = 'Capabilities removed:';
    removedSection.appendChild(removedTitle);
    const list = document.createElement('ul');
    list.className = 'cap-review-list';
    for (const item of removed) {
      const li = document.createElement('li');
      li.className = 'cap-review-item removed';
      li.textContent = formatCapabilityChange(item);
      list.appendChild(li);
    }
    removedSection.appendChild(list);
    capReviewChanges.appendChild(removedSection);
  }

  capReviewOverlay.style.display = '';
}

function hideCapabilityReview() {
  capReviewOverlay.style.display = 'none';
  pendingCapReviewId = null;
}

function formatCapabilityChange(item) {
  // Turn 'network:api.example.com' into 'Network: api.example.com'
  // Turn 'pubsub.scope:system' into 'PubSub scope: system'
  // Split on the first ':' to separate the capability key from value,
  // then only replace dots in the key part (not in domain values).
  const colonIdx = item.indexOf(':');
  if (colonIdx === -1) {
    // No colon — just a capability name like 'commands', 'shortcuts'
    return item.replace(/\./g, ' ').replace(/^(\w)/, (m) => m.toUpperCase());
  }
  const key = item.slice(0, colonIdx).replace(/\./g, ' ');
  const value = item.slice(colonIdx + 1);
  return key.replace(/^(\w)/, (m) => m.toUpperCase()) + ': ' + value;
}

async function approveAndUpdate() {
  if (!hasPeekAPI || !pendingCapReviewId) return;

  const id = pendingCapReviewId;
  hideCapabilityReview();
  showStatus('Updating with approved capabilities...');

  try {
    // Strict path — gated on `features.update` capability.
    const result = await api.features.updateApply(id, true);

    if (result.error) {
      showStatus(`Update failed: ${result.error}`, 'error');
      return;
    }

    showStatus('Updated successfully', 'success');
    setTimeout(hideStatus, 3000);
    await loadFeatures();
  } catch (err) {
    showStatus(`Error: ${err.message}`, 'error');
  }
}

function updateLastCheckedFooter() {
  // Show the most recent lastUpdateCheck from any feature
  let latest = null;
  for (const f of features) {
    if (f.lastUpdateCheck) {
      if (!latest || f.lastUpdateCheck > latest) {
        latest = f.lastUpdateCheck;
      }
    }
  }

  if (latest) {
    updateFooter.style.display = '';
    updateFooterText.textContent = `Last checked: ${formatRelativeTime(latest)}`;
  }
}

function formatRelativeTime(isoString) {
  try {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now - date;
    const diffMin = Math.round(diffMs / 60000);

    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin} minute${diffMin !== 1 ? 's' : ''} ago`;
    const diffHours = Math.round(diffMin / 60);
    if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
    const diffDays = Math.round(diffHours / 24);
    return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
  } catch {
    return isoString;
  }
}

// Wire up check updates button
checkUpdatesBtn.addEventListener('click', checkForUpdates);

// Wire up capability review modal buttons
capReviewDismiss.addEventListener('click', hideCapabilityReview);
capReviewApprove.addEventListener('click', approveAndUpdate);

// ─── Search ─────────────────────────────────────────────────────────

searchInput.addEventListener('input', () => {
  searchFilter = searchInput.value.trim();
  render();
});

// ─── Install Flow ───────────────────────────────────────────────────

function showStatus(message, type = 'info') {
  installStatus.style.display = '';
  installStatus.className = 'install-status' + (type !== 'info' ? ` ${type}` : '');
  installStatusText.textContent = message;
}

function hideStatus() {
  installStatus.style.display = 'none';
}

function hidePreview() {
  installPreview.style.display = 'none';
  pendingInstallUri = null;
}

function formatCapabilityName(name) {
  // Turn 'pubsub.system' or 'filesystem' into readable form
  return name.replace(/\./g, ' > ').replace(/([a-z])([A-Z])/g, '$1 $2');
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
  if (capabilities.filesystem) {
    items.push('Filesystem access');
  }
  if (capabilities.commands) items.push('Commands');
  if (capabilities.shortcuts) items.push('Shortcuts');
  if (capabilities.sync) items.push('Sync');
  if (capabilities.theme) items.push('Theme');
  if (capabilities.settings) items.push('Settings');

  return items;
}

async function resolveAtUri(atUri) {
  if (!hasPeekAPI) return;

  hidePreview();
  showStatus('Resolving AT URI...');

  try {
    const result = await api.features.installResolve(atUri);

    if (result.error) {
      showStatus(result.error, 'error');
      return;
    }

    const { manifest, source } = result;

    // Get capability preview
    const capResult = await api.features.previewCapabilities(
      manifest.capabilities,
      manifest.id,
    );

    hideStatus();

    // Show preview
    pendingInstallUri = atUri;
    previewTitle.textContent = manifest.name || manifest.id;

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
          li.textContent = `${formatCapabilityName(item)} (denied)`;
          list.appendChild(li);
        }

        previewCapabilities.appendChild(list);
      }
    }

    installPreview.style.display = '';

  } catch (err) {
    console.error('[features-manager] resolve error:', err);
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
    installUriInput.value = '';

    // Reload feature list
    await loadFeatures();

    // Auto-hide success after 3s
    setTimeout(hideStatus, 3000);

  } catch (err) {
    console.error('[features-manager] install error:', err);
    showStatus(`Error: ${err.message}`, 'error');
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Install bar event listeners
installBtn.addEventListener('click', () => {
  const uri = installUriInput.value.trim();
  if (!uri) return;
  resolveAtUri(uri);
});

installUriInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const uri = installUriInput.value.trim();
    if (!uri) return;
    resolveAtUri(uri);
  }
});

previewCloseBtn.addEventListener('click', hidePreview);
previewCancelBtn.addEventListener('click', () => {
  hidePreview();
  hideStatus();
});
previewInstallBtn.addEventListener('click', confirmInstall);

// ─── PubSub listeners for real-time updates ─────────────────────────

if (hasPeekAPI) {
  const refreshTopics = [
    'feature:disabled',
    'feature:enabled',
    'feature:removed',
    'feature:installed',
    'feature:updated',
    'feature:update-available'
  ];

  for (const topic of refreshTopics) {
    api.pubsub.subscribe(topic, () => {
      loadFeatures();
    });
  }
}

// ─── Install History ────────────────────────────────────────────────

const historySection = document.getElementById('history-section');
const historyToggle = document.getElementById('history-toggle');
const historyContent = document.getElementById('history-content');

function renderHistoryEmpty(message) {
  historyContent.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'history-empty';
  empty.textContent = message || 'No install history yet';
  historyContent.appendChild(empty);
}

function renderHistoryRows(rows) {
  historyContent.innerHTML = '';

  const list = document.createElement('div');
  list.className = 'history-list';

  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'history-row';

    // Event badge (Installed / Updated / Uninstalled / Update failed)
    const eventBadge = document.createElement('span');
    eventBadge.className = `history-event-badge ${r.badgeClass}`;
    eventBadge.textContent = r.label;
    row.appendChild(eventBadge);

    // Feature id + version + source, stacked in the flexible middle column.
    const meta = document.createElement('div');
    meta.className = 'history-meta';

    const primary = document.createElement('div');
    primary.className = 'history-meta-primary';
    primary.textContent = r.version ? `${r.featureId}  v${r.version}` : r.featureId;
    primary.title = r.featureId;
    meta.appendChild(primary);

    if (r.source) {
      const secondary = document.createElement('div');
      secondary.className = 'history-meta-secondary';
      secondary.textContent = r.source;
      secondary.title = r.source;
      meta.appendChild(secondary);
    }

    row.appendChild(meta);

    // Human-readable absolute timestamp (relative on hover via title).
    const time = document.createElement('span');
    time.className = 'history-time';
    time.textContent = r.timestampLabel;
    time.title = r.timestamp ? formatRelativeTime(r.timestamp) : '';
    row.appendChild(time);

    list.appendChild(row);
  }

  historyContent.appendChild(list);
}

async function loadHistory() {
  if (!hasPeekAPI) {
    renderHistoryEmpty('Peek API not available');
    return;
  }

  try {
    // featureId omitted -> all features; cap at 50 most-recent events.
    const result = await api.features.history(null, 50);

    if (result.error) {
      renderHistoryEmpty(`Could not load history: ${result.error}`);
      return;
    }

    const rows = buildHistoryRows(result.entries);
    if (rows.length === 0) {
      renderHistoryEmpty('No install history yet');
      return;
    }

    renderHistoryRows(rows);
  } catch (err) {
    console.error('[features-manager] Failed to load history:', err);
    renderHistoryEmpty('Could not load history');
  }
}

// The history section is always visible (it carries its own empty state).
historySection.style.display = '';

let historyLoaded = false;
historyToggle.addEventListener('click', () => {
  const expanded = historyToggle.getAttribute('aria-expanded') === 'true';
  historyToggle.setAttribute('aria-expanded', String(!expanded));
  historyContent.style.display = expanded ? 'none' : '';
  historyToggle.querySelector('.history-toggle-arrow').style.transform =
    expanded ? '' : 'rotate(90deg)';
  if (!expanded && !historyLoaded) {
    historyLoaded = true;
    loadHistory();
  }
});

// Refresh the history log on any feature lifecycle change, but only if the
// section has already been opened once (avoid eager IPC on every event).
if (hasPeekAPI) {
  for (const topic of [
    'feature:installed',
    'feature:updated',
    'feature:removed',
  ]) {
    api.pubsub.subscribe(topic, () => {
      if (historyLoaded) loadHistory();
    });
  }
}

// ─── Init ───────────────────────────────────────────────────────────

loadFeatures();
