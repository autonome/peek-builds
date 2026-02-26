/**
 * Tag Actions - Settings/Management UI
 *
 * List view: shows all configured tag actions with enable/disable toggle
 * Detail view: create/edit form for a tag action
 *
 * Communicates with background.js via pubsub request/response pattern.
 */

const api = window.app;
const debug = api.debug;

// ==================== Icon SVGs ====================

const ICON_SVGS = {
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  archive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24z"/></svg>'
};

const ICON_NAMES = Object.keys(ICON_SVGS);

// ==================== Action Type Labels ====================

const ACTION_TYPE_LABELS = {
  'icon': 'Icon',
  'publish': 'Publish Event',
  'open-url': 'Open URL',
  'tag': 'Add Tag',
  'toggle': 'Toggle (Tag Pair)'
};

const ACTION_TYPES = Object.keys(ACTION_TYPE_LABELS);

// ==================== Item Types ====================

const ITEM_TYPES = ['url', 'text', 'tagset', 'image'];

// ==================== Preset Actions ====================

const PRESET_ACTIONS = [
  {
    name: 'Read Later Icon',
    triggerTag: 'read-later',
    triggerOn: 'add',
    actionType: 'icon',
    actionConfig: { icon: 'eye', color: '#4a9eff', tooltip: 'Read later' }
  },
  {
    name: 'Archive to Wayback Machine',
    triggerTag: 'archive',
    triggerOn: 'add',
    actionType: 'open-url',
    actionConfig: { urlTemplate: 'https://web.archive.org/save/{url}', openInBackground: true },
    itemTypes: ['url']
  },
  {
    name: 'Todo/Done Checkbox',
    triggerTag: 'todo',
    triggerOn: 'add',
    actionType: 'toggle',
    actionConfig: { activeTag: 'todo', completedTag: 'done', icon: 'unchecked', checkedIcon: 'checked', color: '#007aff', checkedColor: '#34c759' }
  },
  {
    name: 'Reading List',
    triggerTag: 'readme',
    triggerOn: 'add',
    actionType: 'toggle',
    actionConfig: { activeTag: 'readme', completedTag: 'read', icon: 'unchecked', checkedIcon: 'checked', color: '#5856d6', checkedColor: '#34c759' }
  }
];

// ==================== State ====================

const VIEW_LIST = 'list';
const VIEW_DETAIL = 'detail';

let state = {
  view: VIEW_LIST,
  actions: [],
  selectedIndex: 0,
  searchQuery: '',
  editingAction: null, // null = new action, object = editing existing
  formData: {}
};

// ==================== Pubsub Helpers ====================

/**
 * Send a pubsub request and wait for the response
 */
const request = (topic, data = {}) => {
  return new Promise((resolve) => {
    const handler = (msg) => {
      resolve(msg);
    };
    api.subscribe(`${topic}:response`, handler, api.scopes.GLOBAL);
    api.publish(topic, data, api.scopes.GLOBAL);
  });
};

// ==================== Data Loading ====================

const loadActions = async () => {
  const result = await request('tag-actions:get-all');
  if (result.success) {
    state.actions = result.data;
  } else {
    state.actions = [];
  }
  debug && console.log('[tag-actions:home] Loaded actions:', state.actions.length);
};

// ==================== Escape Handler ====================

const handleEscape = () => {
  // If search has content, clear it first
  if (state.searchQuery) {
    state.searchQuery = '';
    const searchInput = document.querySelector('peek-input.search-input');
    if (searchInput) searchInput.value = '';
    renderList();
    return { handled: true };
  }

  if (state.view === VIEW_DETAIL) {
    showListView();
    return { handled: true };
  }

  // At root - let window close
  return { handled: false };
};

// ==================== View Switching ====================

const showListView = async () => {
  state.view = VIEW_LIST;
  state.editingAction = null;
  state.formData = {};
  document.getElementById('list-view').style.display = '';
  document.getElementById('detail-view').style.display = 'none';
  await loadActions();
  renderList();
};

const showDetailView = (action = null) => {
  state.view = VIEW_DETAIL;
  state.editingAction = action;

  if (action) {
    // Editing existing
    state.formData = { ...action };
  } else {
    // Creating new
    state.formData = {
      name: '',
      enabled: true,
      triggerTag: '',
      filterTag: '',
      triggerOn: 'add',
      actionType: 'icon',
      actionConfig: {},
      itemTypes: []
    };
  }

  document.getElementById('list-view').style.display = 'none';
  document.getElementById('detail-view').style.display = '';
  renderDetailForm();
};

// ==================== List View Rendering ====================

const renderList = () => {
  const container = document.querySelector('.actions-list');
  container.innerHTML = '';

  let filtered = state.actions;
  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    filtered = filtered.filter(a =>
      a.name.toLowerCase().includes(q) ||
      a.triggerTag.toLowerCase().includes(q) ||
      a.actionType.toLowerCase().includes(q)
    );
  }

  if (filtered.length === 0 && !state.searchQuery) {
    container.innerHTML = '<div class="empty-state">No tag actions yet. Click + to create one.</div>';
    showPresets();
    return;
  } else if (filtered.length === 0) {
    container.innerHTML = '<div class="empty-state">No actions match your search.</div>';
    hidePresets();
    return;
  }

  filtered.forEach((action, index) => {
    const card = createActionCard(action, index);
    container.appendChild(card);
  });

  // Show presets if there are no actions at all
  if (state.actions.length === 0) {
    showPresets();
  } else {
    hidePresets();
  }
};

const createActionCard = (action, index) => {
  const card = document.createElement('peek-card');
  card.className = 'action-card';
  card.interactive = true;
  card.dataset.actionId = action.id;

  // Header: enabled dot + name + summary
  const header = document.createElement('div');
  header.slot = 'header';
  header.className = 'action-card-header';

  const dot = document.createElement('div');
  dot.className = `action-enabled-dot ${action.enabled ? 'enabled' : 'disabled'}`;

  const name = document.createElement('span');
  name.className = 'action-card-name';
  name.textContent = action.name || 'Untitled';

  const summary = document.createElement('span');
  summary.className = 'action-card-summary';
  summary.textContent = `${action.triggerTag || '?'}`;

  header.appendChild(dot);
  header.appendChild(name);
  header.appendChild(summary);
  card.appendChild(header);

  // Footer: action type badge
  const footer = document.createElement('div');
  footer.slot = 'footer';
  footer.className = 'action-card-footer';

  const badge = document.createElement('span');
  badge.className = 'action-type-badge';
  badge.textContent = ACTION_TYPE_LABELS[action.actionType] || action.actionType;
  footer.appendChild(badge);

  if (action.actionType === 'icon' && action.actionConfig.icon) {
    const iconPreview = document.createElement('span');
    iconPreview.innerHTML = ICON_SVGS[action.actionConfig.icon] || '';
    iconPreview.style.cssText = `display:inline-flex;width:14px;height:14px;color:${action.actionConfig.color || '#999'};`;
    footer.appendChild(iconPreview);
  }

  card.appendChild(footer);

  card.addEventListener('card-click', () => {
    showDetailView(action);
  });

  return card;
};

// ==================== Presets ====================

const showPresets = () => {
  const section = document.querySelector('.presets-section');
  const list = document.querySelector('.presets-list');
  section.style.display = '';
  list.innerHTML = '';

  // Filter out presets that already exist (by name + triggerTag)
  const existingNames = new Set(state.actions.map(a => `${a.name}:${a.triggerTag}`));
  const available = PRESET_ACTIONS.filter(p => !existingNames.has(`${p.name}:${p.triggerTag}`));

  if (available.length === 0) {
    section.style.display = 'none';
    return;
  }

  available.forEach(preset => {
    const card = document.createElement('peek-card');
    card.className = 'preset-card';
    card.interactive = true;

    const header = document.createElement('div');
    header.slot = 'header';
    header.className = 'action-card-header';

    const name = document.createElement('span');
    name.className = 'action-card-name';
    name.textContent = preset.name;

    const summary = document.createElement('span');
    summary.className = 'action-card-summary';
    summary.textContent = `${preset.triggerTag}`;

    header.appendChild(name);
    header.appendChild(summary);
    card.appendChild(header);

    const footer = document.createElement('div');
    footer.slot = 'footer';
    footer.className = 'action-card-footer';

    const badge = document.createElement('span');
    badge.className = 'action-type-badge';
    badge.textContent = ACTION_TYPE_LABELS[preset.actionType] || preset.actionType;
    footer.appendChild(badge);

    const addLabel = document.createElement('span');
    addLabel.style.cssText = 'font-size:11px;color:var(--base0D);';
    addLabel.textContent = 'Click to add';
    footer.appendChild(addLabel);

    card.appendChild(footer);

    card.addEventListener('card-click', async () => {
      await request('tag-actions:create', { ...preset });
      await loadActions();
      renderList();
    });

    list.appendChild(card);
  });
};

const hidePresets = () => {
  document.querySelector('.presets-section').style.display = 'none';
};

// ==================== Detail Form Rendering ====================

const renderDetailForm = () => {
  const container = document.querySelector('.detail-form');
  container.innerHTML = '';

  const fd = state.formData;

  // Name + Enabled row
  const nameGroup = createFormGroup('Name');
  const nameInput = document.createElement('peek-input');
  nameInput.className = 'form-input';
  nameInput.value = fd.name || '';
  nameInput.placeholder = 'Action name';
  nameInput.addEventListener('input', (e) => { fd.name = e.target.value; });
  nameGroup.appendChild(nameInput);
  container.appendChild(nameGroup);

  // Enabled toggle
  const enabledRow = document.createElement('div');
  enabledRow.className = 'enabled-row';
  const enabledLabel = document.createElement('span');
  enabledLabel.className = 'form-label';
  enabledLabel.textContent = 'Enabled';
  const enabledSwitch = document.createElement('peek-switch');
  enabledSwitch.checked = fd.enabled !== false;
  enabledSwitch.addEventListener('change', (e) => {
    fd.enabled = e.target.checked;
  });
  enabledRow.appendChild(enabledLabel);
  enabledRow.appendChild(enabledSwitch);
  container.appendChild(enabledRow);

  // --- Trigger section ---
  const triggerSection = createFormSection('Trigger');

  // Trigger tag
  const tagGroup = createFormGroup('Tag');
  const tagInput = document.createElement('peek-input');
  tagInput.className = 'form-input';
  tagInput.value = fd.triggerTag || '';
  tagInput.placeholder = 'Tag name that triggers this action';
  tagInput.addEventListener('input', (e) => { fd.triggerTag = e.target.value; });
  tagGroup.appendChild(tagInput);
  triggerSection.appendChild(tagGroup);

  // Filter tag (optional AND)
  const filterGroup = createFormGroup('Also requires tag (optional)');
  const filterInput = document.createElement('peek-input');
  filterInput.className = 'form-input';
  filterInput.value = fd.filterTag || '';
  filterInput.placeholder = 'Optional second tag required (AND logic)';
  filterInput.addEventListener('input', (e) => { fd.filterTag = e.target.value || null; });
  filterGroup.appendChild(filterInput);
  triggerSection.appendChild(filterGroup);

  // Trigger on: add / remove / both
  const triggerOnGroup = createFormGroup('Trigger on');
  const radioGroup = document.createElement('div');
  radioGroup.className = 'radio-group';
  ['add', 'remove', 'both'].forEach(val => {
    const label = document.createElement('label');
    label.className = 'radio-option';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'triggerOn';
    radio.value = val;
    radio.checked = fd.triggerOn === val;
    radio.addEventListener('change', () => { fd.triggerOn = val; });
    const text = document.createTextNode(val === 'add' ? 'Tag added' : val === 'remove' ? 'Tag removed' : 'Both');
    label.appendChild(radio);
    label.appendChild(text);
    radioGroup.appendChild(label);
  });
  triggerOnGroup.appendChild(radioGroup);
  triggerSection.appendChild(triggerOnGroup);

  // Item types filter
  const typesGroup = createFormGroup('Item types (leave unchecked for all)');
  const checkboxGroup = document.createElement('div');
  checkboxGroup.className = 'checkbox-group';
  const selectedTypes = fd.itemTypes || [];
  ITEM_TYPES.forEach(type => {
    const label = document.createElement('label');
    label.className = 'checkbox-option';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = type;
    cb.checked = selectedTypes.includes(type);
    cb.addEventListener('change', () => {
      if (cb.checked) {
        if (!fd.itemTypes) fd.itemTypes = [];
        fd.itemTypes.push(type);
      } else {
        fd.itemTypes = (fd.itemTypes || []).filter(t => t !== type);
        if (fd.itemTypes.length === 0) fd.itemTypes = null;
      }
    });
    const text = document.createTextNode(type);
    label.appendChild(cb);
    label.appendChild(text);
    checkboxGroup.appendChild(label);
  });
  typesGroup.appendChild(checkboxGroup);
  triggerSection.appendChild(typesGroup);

  container.appendChild(triggerSection);

  // --- Action section ---
  const actionSection = createFormSection('Action');

  // Action type selector
  const typeGroup = createFormGroup('Type');
  const typeSelect = document.createElement('select');
  typeSelect.className = 'form-select-native';
  typeSelect.style.cssText = 'background:var(--base01);border:1px solid var(--base02);border-radius:4px;color:var(--base05);padding:6px 8px;font-size:13px;width:100%;';
  ACTION_TYPES.forEach(type => {
    const opt = document.createElement('option');
    opt.value = type;
    opt.textContent = ACTION_TYPE_LABELS[type];
    opt.selected = fd.actionType === type;
    typeSelect.appendChild(opt);
  });
  typeSelect.addEventListener('change', () => {
    fd.actionType = typeSelect.value;
    fd.actionConfig = {};
    renderDetailForm(); // Re-render to show type-specific config
  });
  typeGroup.appendChild(typeSelect);
  actionSection.appendChild(typeGroup);

  // Type-specific config
  const configContainer = document.createElement('div');
  renderActionConfig(configContainer, fd);
  actionSection.appendChild(configContainer);

  container.appendChild(actionSection);

  // --- Form actions ---
  const actions = document.createElement('div');
  actions.className = 'form-actions';

  if (state.editingAction) {
    const deleteBtn = document.createElement('peek-button');
    deleteBtn.variant = 'ghost';
    deleteBtn.textContent = 'Delete Action';
    deleteBtn.style.color = 'var(--base08)';
    deleteBtn.addEventListener('click', async () => {
      await request('tag-actions:delete', { actionId: state.editingAction.id });
      showListView();
    });
    actions.appendChild(deleteBtn);
  } else {
    actions.appendChild(document.createElement('div')); // spacer
  }

  const actionsRight = document.createElement('div');
  actionsRight.className = 'form-actions-right';

  const cancelBtn = document.createElement('peek-button');
  cancelBtn.variant = 'ghost';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => showListView());
  actionsRight.appendChild(cancelBtn);

  const saveBtn = document.createElement('peek-button');
  saveBtn.variant = 'primary';
  saveBtn.textContent = 'Save Action';
  saveBtn.addEventListener('click', async () => {
    await saveAction();
  });
  actionsRight.appendChild(saveBtn);

  actions.appendChild(actionsRight);
  container.appendChild(actions);
};

// ==================== Action Config Forms ====================

const renderActionConfig = (container, fd) => {
  const config = fd.actionConfig || {};

  switch (fd.actionType) {
    case 'icon':
      renderIconConfig(container, config, fd);
      break;
    case 'publish':
      renderPublishConfig(container, config, fd);
      break;
    case 'open-url':
      renderOpenUrlConfig(container, config, fd);
      break;
    case 'tag':
      renderTagConfig(container, config, fd);
      break;
    case 'toggle':
      renderToggleConfig(container, config, fd);
      break;
  }
};

const renderIconConfig = (container, config, fd) => {
  // Icon picker
  const iconGroup = createFormGroup('Icon');
  const picker = document.createElement('div');
  picker.className = 'icon-picker';
  ICON_NAMES.forEach(iconName => {
    const btn = document.createElement('button');
    btn.className = `icon-option ${config.icon === iconName ? 'selected' : ''}`;
    btn.innerHTML = ICON_SVGS[iconName];
    btn.title = iconName;
    btn.addEventListener('click', () => {
      if (!fd.actionConfig) fd.actionConfig = {};
      fd.actionConfig.icon = iconName;
      // Update selection visuals
      picker.querySelectorAll('.icon-option').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
    picker.appendChild(btn);
  });
  iconGroup.appendChild(picker);
  container.appendChild(iconGroup);

  // Color picker
  const colorGroup = createFormGroup('Color');
  const colorRow = document.createElement('div');
  colorRow.className = 'color-picker-row';
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = config.color || '#4a9eff';
  const colorPreview = document.createElement('span');
  colorPreview.className = 'color-preview';
  colorPreview.textContent = colorInput.value;
  colorInput.addEventListener('input', () => {
    if (!fd.actionConfig) fd.actionConfig = {};
    fd.actionConfig.color = colorInput.value;
    colorPreview.textContent = colorInput.value;
  });
  colorRow.appendChild(colorInput);
  colorRow.appendChild(colorPreview);
  colorGroup.appendChild(colorRow);
  container.appendChild(colorGroup);

  // Tooltip
  const tooltipGroup = createFormGroup('Tooltip');
  const tooltipInput = document.createElement('peek-input');
  tooltipInput.className = 'form-input';
  tooltipInput.value = config.tooltip || '';
  tooltipInput.placeholder = 'Hover text for the icon';
  tooltipInput.addEventListener('input', (e) => {
    if (!fd.actionConfig) fd.actionConfig = {};
    fd.actionConfig.tooltip = e.target.value;
  });
  tooltipGroup.appendChild(tooltipInput);
  container.appendChild(tooltipGroup);
};

const renderPublishConfig = (container, config, fd) => {
  // Topic
  const topicGroup = createFormGroup('Topic');
  const topicInput = document.createElement('peek-input');
  topicInput.className = 'form-input';
  topicInput.value = config.topic || '';
  topicInput.placeholder = 'Pubsub topic name (e.g. content:fetch-offline)';
  topicInput.addEventListener('input', (e) => {
    if (!fd.actionConfig) fd.actionConfig = {};
    fd.actionConfig.topic = e.target.value;
  });
  topicGroup.appendChild(topicInput);
  container.appendChild(topicGroup);

  // Include item data
  const includeGroup = createFormGroup('');
  const includeLabel = document.createElement('label');
  includeLabel.className = 'checkbox-option';
  const includeCb = document.createElement('input');
  includeCb.type = 'checkbox';
  includeCb.checked = config.includeItemData === true;
  includeCb.addEventListener('change', () => {
    if (!fd.actionConfig) fd.actionConfig = {};
    fd.actionConfig.includeItemData = includeCb.checked;
  });
  const includeText = document.createTextNode('Include item data in payload');
  includeLabel.appendChild(includeCb);
  includeLabel.appendChild(includeText);
  includeGroup.appendChild(includeLabel);
  container.appendChild(includeGroup);
};

const renderOpenUrlConfig = (container, config, fd) => {
  // URL template
  const urlGroup = createFormGroup('URL Template');
  const urlInput = document.createElement('peek-input');
  urlInput.className = 'form-input';
  urlInput.value = config.urlTemplate || '';
  urlInput.placeholder = 'https://example.com/save?url={url}';
  urlInput.addEventListener('input', (e) => {
    if (!fd.actionConfig) fd.actionConfig = {};
    fd.actionConfig.urlTemplate = e.target.value;
  });
  urlGroup.appendChild(urlInput);

  const hint = document.createElement('div');
  hint.className = 'form-hint';
  hint.textContent = 'Placeholders: {url}, {title}, {id}';
  urlGroup.appendChild(hint);
  container.appendChild(urlGroup);

  // Open in background
  const bgGroup = createFormGroup('');
  const bgLabel = document.createElement('label');
  bgLabel.className = 'checkbox-option';
  const bgCb = document.createElement('input');
  bgCb.type = 'checkbox';
  bgCb.checked = config.openInBackground === true;
  bgCb.addEventListener('change', () => {
    if (!fd.actionConfig) fd.actionConfig = {};
    fd.actionConfig.openInBackground = bgCb.checked;
  });
  const bgText = document.createTextNode('Open in background');
  bgLabel.appendChild(bgCb);
  bgLabel.appendChild(bgText);
  bgGroup.appendChild(bgLabel);
  container.appendChild(bgGroup);
};

const renderTagConfig = (container, config, fd) => {
  // Tag name to add
  const tagGroup = createFormGroup('Tag to add');
  const tagInput = document.createElement('peek-input');
  tagInput.className = 'form-input';
  tagInput.value = config.addTagName || '';
  tagInput.placeholder = 'Tag name to automatically add';
  tagInput.addEventListener('input', (e) => {
    if (!fd.actionConfig) fd.actionConfig = {};
    fd.actionConfig.addTagName = e.target.value;
  });
  tagGroup.appendChild(tagInput);

  const hint = document.createElement('div');
  hint.className = 'form-hint';
  hint.textContent = 'This tag will be added to items when the trigger tag is applied. Circular chains are prevented.';
  tagGroup.appendChild(hint);
  container.appendChild(tagGroup);
};


const renderToggleConfig = (container, config, fd) => {
  // Active tag (the "unchecked" state tag)
  const activeGroup = createFormGroup('"Active" tag (unchecked state)');
  const activeInput = document.createElement('peek-input');
  activeInput.className = 'form-input';
  activeInput.value = config.activeTag || fd.triggerTag || '';
  activeInput.placeholder = 'e.g. todo';
  activeInput.addEventListener('input', (e) => {
    if (\!fd.actionConfig) fd.actionConfig = {};
    fd.actionConfig.activeTag = e.target.value;
  });
  activeGroup.appendChild(activeInput);
  container.appendChild(activeGroup);

  // Completed tag (the "checked" state tag)
  const completedGroup = createFormGroup('"Completed" tag (checked state)');
  const completedInput = document.createElement('peek-input');
  completedInput.className = 'form-input';
  completedInput.value = config.completedTag || '';
  completedInput.placeholder = 'e.g. done';
  completedInput.addEventListener('input', (e) => {
    if (\!fd.actionConfig) fd.actionConfig = {};
    fd.actionConfig.completedTag = e.target.value;
  });
  completedGroup.appendChild(completedInput);
  container.appendChild(completedGroup);

  // Color for unchecked state
  const colorGroup = createFormGroup('Unchecked color');
  const colorRow = document.createElement('div');
  colorRow.className = 'color-picker-row';
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = config.color || '#007aff';
  colorInput.addEventListener('input', () => {
    if (\!fd.actionConfig) fd.actionConfig = {};
    fd.actionConfig.color = colorInput.value;
  });
  colorRow.appendChild(colorInput);
  colorGroup.appendChild(colorRow);
  container.appendChild(colorGroup);

  // Color for checked state
  const checkedColorGroup = createFormGroup('Checked color');
  const checkedColorRow = document.createElement('div');
  checkedColorRow.className = 'color-picker-row';
  const checkedColorInput = document.createElement('input');
  checkedColorInput.type = 'color';
  checkedColorInput.value = config.checkedColor || '#34c759';
  checkedColorInput.addEventListener('input', () => {
    if (\!fd.actionConfig) fd.actionConfig = {};
    fd.actionConfig.checkedColor = checkedColorInput.value;
  });
  checkedColorRow.appendChild(checkedColorInput);
  checkedColorGroup.appendChild(checkedColorRow);
  container.appendChild(checkedColorGroup);

  const hint = document.createElement('div');
  hint.className = 'form-hint';
  hint.textContent = 'Items with either tag will show a checkbox on cards. Clicking swaps between the two tags.';
  container.appendChild(hint);
};

// ==================== Form Helpers ====================

const createFormGroup = (labelText) => {
  const group = document.createElement('div');
  group.className = 'form-group';
  if (labelText) {
    const label = document.createElement('div');
    label.className = 'form-label';
    label.textContent = labelText;
    group.appendChild(label);
  }
  return group;
};

const createFormSection = (titleText) => {
  const section = document.createElement('div');
  section.className = 'form-section';
  const title = document.createElement('div');
  title.className = 'form-section-title';
  title.textContent = titleText;
  section.appendChild(title);
  return section;
};

// ==================== Save Action ====================

const saveAction = async () => {
  const fd = state.formData;

  // Basic validation
  if (!fd.triggerTag || !fd.triggerTag.trim()) {
    debug && console.log('[tag-actions:home] Validation: trigger tag required');
    return;
  }

  const actionData = {
    name: fd.name || `${fd.triggerTag} action`,
    enabled: fd.enabled !== false,
    triggerTag: fd.triggerTag.trim(),
    filterTag: fd.filterTag ? fd.filterTag.trim() : null,
    triggerOn: fd.triggerOn || 'add',
    actionType: fd.actionType,
    actionConfig: fd.actionConfig || {},
    itemTypes: fd.itemTypes && fd.itemTypes.length > 0 ? fd.itemTypes : null
  };

  if (state.editingAction) {
    // Update existing
    await request('tag-actions:update', {
      actionId: state.editingAction.id,
      updates: actionData
    });
  } else {
    // Create new
    await request('tag-actions:create', actionData);
  }

  showListView();
};

// ==================== Keyboard Navigation ====================

const handleKeydown = (e) => {
  if (state.view !== VIEW_LIST) return;

  const searchInput = document.querySelector('peek-input.search-input');
  const isSearchFocused = document.activeElement === searchInput ||
    (searchInput && searchInput.shadowRoot?.activeElement);

  // Focus search with / or Cmd+F
  if ((e.key === '/' || (e.key === 'f' && (e.metaKey || e.ctrlKey))) && !isSearchFocused) {
    e.preventDefault();
    searchInput.focus();
    return;
  }

  // Don't intercept when typing in search (except arrow keys and enter)
  if (isSearchFocused && !['ArrowUp', 'ArrowDown', 'Enter'].includes(e.key)) {
    return;
  }

  const cards = Array.from(document.querySelectorAll('.actions-list peek-card'));
  if (cards.length === 0) return;

  switch (e.key) {
    case 'j':
    case 'ArrowDown':
      e.preventDefault();
      if (state.selectedIndex < cards.length - 1) {
        state.selectedIndex++;
        updateSelection(cards);
      }
      break;
    case 'k':
    case 'ArrowUp':
      e.preventDefault();
      if (state.selectedIndex > 0) {
        state.selectedIndex--;
        updateSelection(cards);
      }
      break;
    case 'Enter':
      e.preventDefault();
      if (cards[state.selectedIndex]) {
        cards[state.selectedIndex].click();
      }
      break;
  }
};

const updateSelection = (cards) => {
  if (!cards) cards = Array.from(document.querySelectorAll('.actions-list peek-card'));
  cards.forEach((card, i) => {
    card.selected = (i === state.selectedIndex);
  });
  const selected = cards[state.selectedIndex];
  if (selected) {
    selected.focus();
    selected.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
};

// ==================== Init ====================

const init = async () => {
  debug && console.log('[tag-actions:home] init');

  // Register escape handler
  api.escape.onEscape(handleEscape);

  // Load data
  await loadActions();

  // Search input
  const searchInput = document.querySelector('peek-input.search-input');
  searchInput.addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    state.selectedIndex = 0;
    renderList();
  });

  // Add action button
  document.querySelector('.add-action-btn').addEventListener('click', () => {
    showDetailView(null);
  });

  // Back button
  document.querySelector('.back-btn').addEventListener('click', () => {
    showListView();
  });

  // Keyboard navigation
  document.addEventListener('keydown', handleKeydown);

  // Listen for action changes from background
  api.subscribe('tag-actions:create:response', async () => {
    if (state.view === VIEW_LIST) {
      await loadActions();
      renderList();
    }
  }, api.scopes.GLOBAL);

  api.subscribe('tag-actions:update:response', async () => {
    if (state.view === VIEW_LIST) {
      await loadActions();
      renderList();
    }
  }, api.scopes.GLOBAL);

  api.subscribe('tag-actions:delete:response', async () => {
    if (state.view === VIEW_LIST) {
      await loadActions();
      renderList();
    }
  }, api.scopes.GLOBAL);

  // Render initial list
  renderList();
};

document.addEventListener('DOMContentLoaded', init);
