import appConfig from '../config.js';
import { createDatastoreStore } from '../utils.js';
import api from '../api.js';
const DEBUG = api.debug;
const clear = false;

// Helper: Create text/number input
const createInput = (label, value, onChange, options = {}) => {
  const group = document.createElement('div');
  group.className = 'form-group';

  const labelEl = document.createElement('label');
  labelEl.textContent = label;

  const input = document.createElement('input');
  input.type = options.type || 'text';
  input.value = value || '';
  input.disabled = options.disabled || false;
  if (options.placeholder) input.placeholder = options.placeholder;

  if (options.type === 'number') {
    if (options.step) input.step = options.step;
    if (options.min !== undefined) input.min = options.min;
    if (options.max !== undefined) input.max = options.max;
  }

  input.addEventListener('change', (e) => {
    const val = options.type === 'number' ? parseFloat(e.target.value) : e.target.value;
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
};

// Helper: Create checkbox
const createCheckbox = (label, value, onChange, options = {}) => {
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

  input.addEventListener('change', (e) => {
    onChange(e.target.checked);
  });

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
};

// Helper: Create select dropdown
const createSelect = (label, value, options, onChange, extraOptions = {}) => {
  const group = document.createElement('div');
  group.className = 'form-group';

  const labelEl = document.createElement('label');
  labelEl.textContent = label;

  const select = document.createElement('select');
  select.disabled = extraOptions.disabled || false;

  options.forEach(opt => {
    const optionEl = document.createElement('option');
    optionEl.value = opt.value;
    optionEl.textContent = opt.label;
    if (opt.value === value) {
      optionEl.selected = true;
    }
    select.appendChild(optionEl);
  });

  select.addEventListener('change', (e) => {
    onChange(e.target.value);
  });

  group.appendChild(labelEl);
  group.appendChild(select);

  if (extraOptions.helpText) {
    const help = document.createElement('div');
    help.className = 'help-text';
    help.textContent = extraOptions.helpText;
    group.appendChild(help);
  }

  return group;
};

// Create a settings section (supports async contentFn)
const createSection = async (sectionId, title, contentFn) => {
  const section = document.createElement('div');
  section.className = 'section';
  section.id = `section-${sectionId}`;

  if (title) {
    const titleEl = document.createElement('h2');
    titleEl.className = 'section-title';
    titleEl.textContent = title;
    section.appendChild(titleEl);
  }

  const content = await contentFn();
  if (content) {
    section.appendChild(content);
  }

  return section;
};

// Helper: Create a settings group with optional label
const createSettingsGroup = (label) => {
  const group = document.createElement('div');
  group.className = 'settings-group';

  if (label) {
    const groupLabel = document.createElement('div');
    groupLabel.className = 'settings-group-label';
    groupLabel.textContent = label;
    group.appendChild(groupLabel);
  }

  return group;
};

// Helper: Create backup directory input with Browse button
const createBackupDirInput = (label, value, onChange, options = {}) => {
  const group = document.createElement('div');
  group.className = 'form-group';

  const labelEl = document.createElement('label');
  labelEl.textContent = label;

  const inputRow = document.createElement('div');
  inputRow.className = 'input-with-button';

  const input = document.createElement('input');
  input.type = 'text';
  input.value = value || '';
  if (options.placeholder) input.placeholder = options.placeholder;

  input.addEventListener('change', (e) => {
    onChange(e.target.value);
  });

  const browseBtn = document.createElement('button');
  browseBtn.className = 'btn browse-btn';
  browseBtn.textContent = 'Browse';
  browseBtn.addEventListener('click', async () => {
    try {
      const result = await api.features.devPickDirectory();
      if (result && !result.canceled && !result.error && result.path) {
        input.value = result.path;
        onChange(result.path);
      }
    } catch (err) {
      console.error('Folder picker error:', err);
    }
  });

  inputRow.appendChild(input);
  inputRow.appendChild(browseBtn);

  group.appendChild(labelEl);
  group.appendChild(inputRow);

  if (options.helpText) {
    const help = document.createElement('div');
    help.className = 'help-text';
    help.textContent = options.helpText;
    group.appendChild(help);
  }

  return group;
};

// Render core settings
const renderCoreSettings = async () => {
  const { id, labels, schemas, storageKeys, defaults } = appConfig;

  // Load from datastore
  const store = await createDatastoreStore('core', defaults);

  let prefs = store.get(storageKeys.PREFS);
  let features = store.get(storageKeys.ITEMS);

  const container = document.createElement('div');

  const save = async () => {
    await store.set(storageKeys.PREFS, prefs);
    await store.set(storageKeys.ITEMS, features);
    // Notify main process of prefs change for live updates (quit shortcut, dock visibility, etc.)
    api.publish('topic:core:prefs', { id, prefs });
  };

  const pProps = schemas.prefs.properties;
  const getVal = (k) => (prefs && prefs.hasOwnProperty(k)) ? prefs[k] : pProps[k]?.default;
  const getLabel = (k) => (labels.prefs && labels.prefs[k]) || k;


  // --- Group 1: System ---
  const systemGroup = createSettingsGroup('System');

  systemGroup.appendChild(createCheckbox(getLabel('showTrayIcon'), getVal('showTrayIcon'), (newVal) => {
    prefs.showTrayIcon = newVal;
    save();
  }, {
    helpText: pProps.showTrayIcon.description
  }));

  systemGroup.appendChild(createCheckbox(getLabel('showInDockAndSwitcher'), getVal('showInDockAndSwitcher'), (newVal) => {
    prefs.showInDockAndSwitcher = newVal;
    save();
  }, {
    helpText: pProps.showInDockAndSwitcher.description
  }));

  // Default browser button
  const defaultBrowserGroup = document.createElement('div');
  defaultBrowserGroup.className = 'form-group';

  const defaultBrowserLabel = document.createElement('label');
  defaultBrowserLabel.textContent = 'Default HTTP handler';
  defaultBrowserGroup.appendChild(defaultBrowserLabel);

  const defaultBrowserRow = document.createElement('div');
  defaultBrowserRow.style.cssText = 'display: flex; align-items: center; gap: 12px;';

  const defaultBrowserBtn = document.createElement('button');
  defaultBrowserBtn.textContent = 'Set as default handler for HTTP addresses and HTML documents';
  defaultBrowserBtn.style.cssText = `
    padding: 8px 16px;
    font-size: 13px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-primary);
    border-radius: 6px;
    color: var(--text-primary);
    cursor: pointer;
  `;
  defaultBrowserBtn.addEventListener('mouseenter', () => { defaultBrowserBtn.style.background = 'var(--bg-hover)'; });
  defaultBrowserBtn.addEventListener('mouseleave', () => { defaultBrowserBtn.style.background = 'var(--bg-tertiary)'; });

  const defaultBrowserStatus = document.createElement('span');
  defaultBrowserStatus.style.cssText = 'font-size: 12px; color: var(--text-secondary);';

  // Check current status
  (async () => {
    try {
      const result = await api.app.getDefaultBrowserStatus();
      if (result.isDefault) {
        defaultBrowserBtn.textContent = 'Already the default handler';
        defaultBrowserBtn.disabled = true;
        defaultBrowserBtn.style.opacity = '0.6';
        defaultBrowserBtn.style.cursor = 'default';
        defaultBrowserStatus.textContent = '\u2713 Peek is the default handler';
      }
    } catch { /* ignore */ }
  })();

  defaultBrowserBtn.addEventListener('click', async () => {
    defaultBrowserBtn.disabled = true;
    defaultBrowserBtn.textContent = 'Setting...';
    try {
      const result = await api.app.setDefaultBrowser();
      if (result.success) {
        defaultBrowserBtn.textContent = 'Already the default handler';
        defaultBrowserBtn.style.opacity = '0.6';
        defaultBrowserBtn.style.cursor = 'default';
        defaultBrowserStatus.textContent = '\u2713 Peek is the default handler';
      } else {
        defaultBrowserBtn.textContent = 'Set as default handler for HTTP addresses and HTML documents';
        defaultBrowserBtn.disabled = false;
        defaultBrowserStatus.textContent = result.error || 'Could not set as default';
      }
    } catch (err) {
      defaultBrowserBtn.textContent = 'Set as default handler for HTTP addresses and HTML documents';
      defaultBrowserBtn.disabled = false;
      defaultBrowserStatus.textContent = 'Error: ' + err.message;
    }
  });

  defaultBrowserRow.appendChild(defaultBrowserBtn);
  defaultBrowserRow.appendChild(defaultBrowserStatus);
  defaultBrowserGroup.appendChild(defaultBrowserRow);

  const defaultBrowserHelp = document.createElement('div');
  defaultBrowserHelp.className = 'help-text';
  defaultBrowserHelp.textContent = 'Register Peek as the default handler for http and https URLs.';
  defaultBrowserGroup.appendChild(defaultBrowserHelp);

  systemGroup.appendChild(defaultBrowserGroup);

  container.appendChild(systemGroup);

  // --- Group 2: Data & Backup ---
  const dataGroup = createSettingsGroup('Data & Backup');

  dataGroup.appendChild(createBackupDirInput(getLabel('backupDir'), getVal('backupDir'), (newVal) => {
    prefs.backupDir = newVal;
    save();
  }, {
    helpText: pProps.backupDir.description,
    placeholder: 'Select a backup folder...'
  }));

  dataGroup.appendChild(createCheckbox(getLabel('restoreSession'), getVal('restoreSession'), (newVal) => {
    prefs.restoreSession = newVal;
    save();
  }, {
    helpText: pProps.restoreSession.description
  }));

  dataGroup.appendChild(createInput(getLabel('sessionAutosaveInterval'), getVal('sessionAutosaveInterval'), (newVal) => {
    prefs.sessionAutosaveInterval = newVal;
    save();
  }, {
    type: 'number',
    step: 1,
    min: 0,
    helpText: pProps.sessionAutosaveInterval.description
  }));

  container.appendChild(dataGroup);

  // --- Group 3: Windows ---
  const windowsGroup = createSettingsGroup('Windows');

  windowsGroup.appendChild(createCheckbox(getLabel('persistWindowBounds'), getVal('persistWindowBounds'), (newVal) => {
    prefs.persistWindowBounds = newVal;
    save();
  }, {
    helpText: pProps.persistWindowBounds.description
  }));

  windowsGroup.appendChild(createInput(getLabel('defaultWindowWidth'), getVal('defaultWindowWidth'), (newVal) => {
    prefs.defaultWindowWidth = newVal;
    save();
  }, {
    type: 'number',
    step: 1,
    min: 200,
    helpText: pProps.defaultWindowWidth.description
  }));

  windowsGroup.appendChild(createInput(getLabel('defaultWindowHeight'), getVal('defaultWindowHeight'), (newVal) => {
    prefs.defaultWindowHeight = newVal;
    save();
  }, {
    type: 'number',
    step: 1,
    min: 200,
    helpText: pProps.defaultWindowHeight.description
  }));

  windowsGroup.appendChild(createCheckbox(getLabel('hideTitleBar'), getVal('hideTitleBar'), (newVal) => {
    prefs.hideTitleBar = newVal;
    save();
  }, {
    helpText: pProps.hideTitleBar.description
  }));

  windowsGroup.appendChild(createInput(getLabel('dragHoldDelay'), getVal('dragHoldDelay'), (newVal) => {
    prefs.dragHoldDelay = newVal;
    save();
  }, {
    type: 'number',
    step: 0.1,
    min: 0,
    helpText: pProps.dragHoldDelay.description
  }));

  container.appendChild(windowsGroup);

  // --- Group 4: Keyboard Shortcuts ---
  const shortcutsGroup = createSettingsGroup('Keyboard Shortcuts');

  shortcutsGroup.appendChild(createInput(getLabel('shortcutKey'), getVal('shortcutKey'), (newVal) => {
    prefs.shortcutKey = newVal;
    save();
  }, {
    helpText: pProps.shortcutKey.description,
    placeholder: 'e.g. CommandOrControl+,'
  }));

  shortcutsGroup.appendChild(createInput(getLabel('quitShortcut'), getVal('quitShortcut'), (newVal) => {
    prefs.quitShortcut = newVal;
    save();
  }, {
    helpText: pProps.quitShortcut.description,
    placeholder: 'e.g. CommandOrControl+Q'
  }));

  container.appendChild(shortcutsGroup);

  return container;
};

// Render themes settings
const renderThemesSettings = async () => {
  const container = document.createElement('div');

  // Get current theme state
  const themeState = await api.theme.get();
  const activeThemeId = themeState?.themeId || 'peek';
  const colorScheme = themeState?.colorScheme || 'system';

  // Color scheme selector at top
  const schemeSection = document.createElement('div');
  schemeSection.className = 'form-section';
  schemeSection.style.marginBottom = '24px';

  const schemeTitle = document.createElement('h3');
  schemeTitle.className = 'form-section-title';
  schemeTitle.textContent = 'Color Scheme';
  schemeSection.appendChild(schemeTitle);

  const schemeGroup = document.createElement('div');
  schemeGroup.style.cssText = 'display: flex; gap: 8px;';

  ['system', 'light', 'dark'].forEach(scheme => {
    const btn = document.createElement('button');
    btn.textContent = scheme.charAt(0).toUpperCase() + scheme.slice(1);
    const isActive = colorScheme === scheme;
    btn.style.cssText = `
      padding: 8px 16px;
      font-size: 13px;
      background: ${isActive ? 'var(--base0D)' : 'var(--bg-tertiary)'};
      border: 2px solid ${isActive ? 'var(--base0D)' : 'var(--base03)'};
      border-radius: 6px;
      color: ${isActive ? 'white' : 'var(--text-primary)'};
      cursor: pointer;
      flex: 1;
      font-weight: ${isActive ? '600' : '400'};
    `;
    btn.addEventListener('click', async () => {
      const result = await api.theme.setColorScheme(scheme);
      if (result.success) {
        // Update button styles
        schemeGroup.querySelectorAll('button').forEach(b => {
          const btnIsActive = b.textContent.toLowerCase() === scheme;
          b.style.background = btnIsActive ? 'var(--base0D)' : 'var(--bg-tertiary)';
          b.style.borderColor = btnIsActive ? 'var(--base0D)' : 'var(--base03)';
          b.style.color = btnIsActive ? 'white' : 'var(--text-primary)';
          b.style.fontWeight = btnIsActive ? '600' : '400';
        });
      }
    });
    schemeGroup.appendChild(btn);
  });

  schemeSection.appendChild(schemeGroup);

  const schemeHelp = document.createElement('div');
  schemeHelp.className = 'help-text';
  schemeHelp.style.marginTop = '8px';
  schemeHelp.textContent = 'System follows your OS preference. Light/Dark forces that mode.';
  schemeSection.appendChild(schemeHelp);

  container.appendChild(schemeSection);

  // Add Theme button
  const addSection = document.createElement('div');
  addSection.className = 'form-section';
  addSection.style.marginBottom = '24px';

  const addBtn = document.createElement('button');
  addBtn.textContent = '+ Add Theme';
  addBtn.style.cssText = `
    padding: 10px 16px;
    font-size: 13px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-primary);
    border-radius: 6px;
    color: var(--text-primary);
    cursor: pointer;
    width: 100%;
  `;
  addBtn.addEventListener('mouseenter', () => {
    addBtn.style.background = 'var(--bg-hover)';
  });
  addBtn.addEventListener('mouseleave', () => {
    addBtn.style.background = 'var(--bg-tertiary)';
  });
  addBtn.addEventListener('click', async () => {
    addBtn.textContent = 'Selecting folder...';
    addBtn.disabled = true;

    try {
      // Open folder picker
      const pickResult = await api.theme.pickFolder();
      if (!pickResult.success || pickResult.canceled) {
        addBtn.textContent = '+ Add Theme';
        addBtn.disabled = false;
        return;
      }

      const folderPath = pickResult.data.path;
      addBtn.textContent = 'Validating...';

      // Validate folder
      const validateResult = await api.theme.validateFolder(folderPath);

      if (!validateResult.success) {
        addBtn.textContent = `Error: ${validateResult.error}`;
        setTimeout(() => {
          addBtn.textContent = '+ Add Theme';
          addBtn.disabled = false;
        }, 3000);
        return;
      }

      addBtn.textContent = 'Adding...';

      // Add to datastore
      const addResult = await api.theme.add(folderPath);

      if (addResult.success) {
        addBtn.textContent = 'Added!';

        // Refresh the list
        setTimeout(() => {
          addBtn.textContent = '+ Add Theme';
          addBtn.disabled = false;
          refreshThemesList();
        }, 1500);
      } else {
        addBtn.textContent = `Error: ${addResult.error}`;
        setTimeout(() => {
          addBtn.textContent = '+ Add Theme';
          addBtn.disabled = false;
        }, 3000);
      }
    } catch (err) {
      console.error('Add theme error:', err);
      addBtn.textContent = 'Error adding theme';
      setTimeout(() => {
        addBtn.textContent = '+ Add Theme';
        addBtn.disabled = false;
      }, 2000);
    }
  });
  addSection.appendChild(addBtn);
  container.appendChild(addSection);

  // Themes list container
  const listContainer = document.createElement('div');
  listContainer.id = 'themes-list-container';
  container.appendChild(listContainer);

  // Function to refresh themes list
  const refreshThemesList = async () => {
    listContainer.innerHTML = '';

    const loading = document.createElement('div');
    loading.className = 'help-text';
    loading.textContent = 'Loading themes...';
    listContainer.appendChild(loading);

    try {
      const result = await api.theme.getAll();
      const currentTheme = await api.theme.get();
      const activeId = currentTheme?.themeId || 'peek';

      loading.remove();

      if (!result.success || !result.data || result.data.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'help-text';
        empty.textContent = 'No themes found.';
        listContainer.appendChild(empty);
        return;
      }

      const themes = result.data;

      const themeSection = document.createElement('div');
      themeSection.className = 'form-section';

      const title = document.createElement('h3');
      title.className = 'form-section-title';
      title.textContent = 'Installed Themes';
      themeSection.appendChild(title);

      themes.forEach(theme => {
        const isActive = theme.id === activeId;
        const isBuiltin = theme.builtin;

        const card = document.createElement('div');
        card.className = 'item-card';

        const header = document.createElement('div');
        header.className = 'item-card-header';

        // Left side: radio + name
        const leftSide = document.createElement('div');
        leftSide.style.cssText = 'display: flex; align-items: center; gap: 12px;';

        // Radio button for selection
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'active-theme';
        radio.checked = isActive;
        radio.style.cssText = 'width: 16px; height: 16px; cursor: pointer;';
        radio.addEventListener('change', async () => {
          if (radio.checked) {
            const result = await api.theme.setTheme(theme.id);
            if (result.success) {
              // Refresh to update UI
              refreshThemesList();
            }
          }
        });
        leftSide.appendChild(radio);

        const cardTitle = document.createElement('div');
        cardTitle.className = 'item-card-title';
        cardTitle.style.margin = '0';

        const nameSpan = document.createElement('span');
        nameSpan.textContent = theme.name || theme.id;
        cardTitle.appendChild(nameSpan);

        if (theme.version) {
          const versionSpan = document.createElement('span');
          versionSpan.style.cssText = 'margin-left: 8px; font-size: 11px; color: var(--text-tertiary);';
          versionSpan.textContent = `v${theme.version}`;
          cardTitle.appendChild(versionSpan);
        }

        if (isBuiltin) {
          const badge = document.createElement('span');
          badge.style.cssText = 'margin-left: 8px; font-size: 10px; padding: 2px 6px; background: var(--bg-tertiary); border-radius: 4px; color: var(--text-tertiary);';
          badge.textContent = 'built-in';
          cardTitle.appendChild(badge);
        }

        if (isActive) {
          const activeBadge = document.createElement('span');
          activeBadge.style.cssText = 'margin-left: 8px; font-size: 10px; padding: 2px 6px; background: #22c55e; border-radius: 4px; color: white;';
          activeBadge.textContent = 'active';
          cardTitle.appendChild(activeBadge);
        }

        leftSide.appendChild(cardTitle);
        header.appendChild(leftSide);

        // Right side: actions
        const actions = document.createElement('div');
        actions.style.cssText = 'display: flex; gap: 8px; align-items: center;';

        // Reload button
        const reloadBtn = document.createElement('button');
        reloadBtn.textContent = 'Reload';
        reloadBtn.style.cssText = `
          padding: 4px 8px;
          font-size: 11px;
          background: var(--bg-tertiary);
          border: 1px solid var(--border-primary);
          border-radius: 4px;
          color: var(--text-secondary);
          cursor: pointer;
        `;
        reloadBtn.addEventListener('click', async () => {
          reloadBtn.textContent = '...';
          reloadBtn.disabled = true;
          try {
            const result = await api.theme.reload(theme.id);
            reloadBtn.textContent = result.success ? '✓' : '✗';
          } catch (err) {
            reloadBtn.textContent = '✗';
          }
          setTimeout(() => {
            reloadBtn.textContent = 'Reload';
            reloadBtn.disabled = false;
          }, 1000);
        });
        actions.appendChild(reloadBtn);

        // Remove button (only for external themes)
        if (!isBuiltin) {
          const removeBtn = document.createElement('button');
          removeBtn.textContent = 'Remove';
          removeBtn.style.cssText = `
            padding: 4px 8px;
            font-size: 11px;
            background: var(--bg-tertiary);
            border: 1px solid #ef4444;
            border-radius: 4px;
            color: #ef4444;
            cursor: pointer;
          `;
          removeBtn.addEventListener('click', async () => {
            if (!confirm(`Remove theme "${theme.name || theme.id}"?`)) return;

            removeBtn.textContent = '...';
            removeBtn.disabled = true;

            const result = await api.theme.remove(theme.id);
            if (result.success) {
              refreshThemesList();
            } else {
              removeBtn.textContent = 'Error';
              setTimeout(() => {
                removeBtn.textContent = 'Remove';
                removeBtn.disabled = false;
              }, 2000);
            }
          });
          actions.appendChild(removeBtn);
        }

        header.appendChild(actions);
        card.appendChild(header);

        // Body
        const body = document.createElement('div');
        body.className = 'item-card-body';

        if (theme.description) {
          const desc = document.createElement('div');
          desc.className = 'help-text';
          desc.style.marginBottom = '8px';
          desc.textContent = theme.description;
          body.appendChild(desc);
        }

        if (theme.author) {
          const authorInfo = document.createElement('div');
          authorInfo.className = 'help-text';
          authorInfo.style.marginBottom = '4px';
          authorInfo.textContent = `Author: ${theme.author}`;
          body.appendChild(authorInfo);
        }

        // Show path for external themes
        if (theme.path && !isBuiltin) {
          const pathInfo = document.createElement('div');
          pathInfo.className = 'help-text';
          pathInfo.style.cssText = 'font-family: monospace; font-size: 11px;';
          pathInfo.textContent = theme.path;
          body.appendChild(pathInfo);
        }

        card.appendChild(body);
        themeSection.appendChild(card);
      });

      listContainer.appendChild(themeSection);
    } catch (err) {
      loading.remove();
      const error = document.createElement('div');
      error.className = 'help-text';
      error.textContent = `Error loading themes: ${err.message}`;
      listContainer.appendChild(error);
    }
  };

  // Initial load
  await refreshThemesList();

  // Store refresh function for external access
  window._refreshThemesList = refreshThemesList;

  return container;
};

// Render extensions settings (bundled webextensions: ad blocker, consent-o-matic, etc.)
const renderPrivacySettings = async () => {
  const container = document.createElement('div');

  const extSection = document.createElement('div');
  extSection.className = 'form-section';

  const extSectionTitle = document.createElement('h3');
  extSectionTitle.className = 'form-section-title';
  extSectionTitle.textContent = 'Bundled Web Extensions';
  extSection.appendChild(extSectionTitle);

  const extSectionDesc = document.createElement('p');
  extSectionDesc.className = 'help-text';
  extSectionDesc.style.marginBottom = '16px';
  extSectionDesc.textContent = 'Web extensions bundled with Peek. These run in isolated processes for security.';
  extSection.appendChild(extSectionDesc);

  // ========== Ghostery Ad Blocker ==========
  let adBlockerEnabled = true;
  let blockedCount = 0;

  try {
    const statusResult = await api.adblocker.getStatus();
    if (statusResult.success && statusResult.data) {
      adBlockerEnabled = statusResult.data.enabled;
      blockedCount = statusResult.data.blockedCount || 0;
    }
  } catch (err) {
    console.error('[settings] Failed to load adblocker status:', err);
  }

  const adBlockerCard = document.createElement('div');
  adBlockerCard.className = 'item-card no-collapse';

  const adBlockerHeader = document.createElement('div');
  adBlockerHeader.className = 'item-card-header';

  // Left side: checkbox + name
  const adBlockerLeft = document.createElement('div');
  adBlockerLeft.style.cssText = 'display: flex; align-items: center; gap: 12px;';

  const adBlockerCheckbox = document.createElement('input');
  adBlockerCheckbox.type = 'checkbox';
  adBlockerCheckbox.checked = adBlockerEnabled;
  adBlockerCheckbox.style.cssText = 'width: 16px; height: 16px; cursor: pointer;';
  adBlockerCheckbox.addEventListener('change', async (e) => {
    try {
      if (e.target.checked) {
        await api.adblocker.enable();
      } else {
        await api.adblocker.disable();
      }
    } catch (err) {
      console.error('[settings] Failed to toggle adblocker:', err);
      e.target.checked = !e.target.checked;
    }
  });
  adBlockerLeft.appendChild(adBlockerCheckbox);

  const adBlockerTitle = document.createElement('div');
  adBlockerTitle.className = 'item-card-title';
  adBlockerTitle.style.margin = '0';

  const adBlockerName = document.createElement('span');
  adBlockerName.textContent = 'Ghostery Ad Blocker';
  adBlockerTitle.appendChild(adBlockerName);

  const adBlockerSourceLink = document.createElement('a');
  adBlockerSourceLink.href = 'https://github.com/ghostery/adblocker';
  adBlockerSourceLink.target = '_blank';
  adBlockerSourceLink.textContent = 'source';
  adBlockerSourceLink.style.cssText = 'margin-left: 8px; font-size: 11px; color: var(--text-muted); text-decoration: none; font-weight: 400;';
  adBlockerSourceLink.addEventListener('mouseenter', () => { adBlockerSourceLink.style.color = 'var(--text-primary)'; });
  adBlockerSourceLink.addEventListener('mouseleave', () => { adBlockerSourceLink.style.color = 'var(--text-muted)'; });
  adBlockerTitle.appendChild(adBlockerSourceLink);

  adBlockerLeft.appendChild(adBlockerTitle);
  adBlockerHeader.appendChild(adBlockerLeft);
  adBlockerCard.appendChild(adBlockerHeader);

  // Body
  const adBlockerBody = document.createElement('div');
  adBlockerBody.className = 'item-card-body';

  const adBlockerDesc = document.createElement('div');
  adBlockerDesc.className = 'help-text';
  adBlockerDesc.style.marginBottom = '4px';
  adBlockerDesc.textContent = 'Block ads and trackers for faster, cleaner browsing.';
  adBlockerBody.appendChild(adBlockerDesc);

  const adBlockerStats = document.createElement('div');
  adBlockerStats.className = 'help-text';
  adBlockerStats.style.marginBottom = '4px';
  adBlockerStats.innerHTML = `<strong>${blockedCount.toLocaleString()}</strong> requests blocked this session`;
  adBlockerBody.appendChild(adBlockerStats);

  const adBlockerAttr = document.createElement('div');
  adBlockerAttr.className = 'help-text';
  adBlockerAttr.style.fontSize = '11px';
  adBlockerAttr.innerHTML = 'Powered by <a href="https://github.com/ghostery/adblocker" target="_blank" style="color: var(--text-muted);">@ghostery/adblocker</a> (MPL-2.0). Filter lists: <a href="https://easylist.to/" target="_blank" style="color: var(--text-muted);">EasyList</a> and <a href="https://easylist.to/easylist/easyprivacy.txt" target="_blank" style="color: var(--text-muted);">EasyPrivacy</a>.';
  adBlockerBody.appendChild(adBlockerAttr);

  adBlockerCard.appendChild(adBlockerBody);
  extSection.appendChild(adBlockerCard);

  // ========== Bundled Chrome Extensions ==========
  try {
    const result = await api.chromeExtensions.list();
    if (result.success && result.data && result.data.length > 0) {
      // Also fetch UI entries to know which extensions have options pages
      let uiEntries = [];
      try {
        const uiResult = await api.chromeExtensions.getUiEntries();
        if (uiResult.success && uiResult.data) {
          uiEntries = uiResult.data;
        }
      } catch (err) {
        console.error('[settings] Failed to load chrome extension UI entries:', err);
      }

      for (const ext of result.data) {
        const card = document.createElement('div');
        card.className = 'item-card no-collapse';

        const header = document.createElement('div');
        header.className = 'item-card-header';

        // Left side: checkbox + name + source link
        const leftSide = document.createElement('div');
        leftSide.style.cssText = 'display: flex; align-items: center; gap: 12px;';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = ext.enabled;
        checkbox.style.cssText = 'width: 16px; height: 16px; cursor: pointer;';
        checkbox.addEventListener('change', async (e) => {
          try {
            if (e.target.checked) {
              await api.chromeExtensions.enable(ext.id);
            } else {
              await api.chromeExtensions.disable(ext.id);
            }
          } catch (err) {
            console.error('[settings] Failed to toggle chrome extension:', err);
            e.target.checked = !e.target.checked;
          }
        });
        leftSide.appendChild(checkbox);

        const cardTitle = document.createElement('div');
        cardTitle.className = 'item-card-title';
        cardTitle.style.margin = '0';

        const nameSpan = document.createElement('span');
        nameSpan.textContent = ext.name;
        cardTitle.appendChild(nameSpan);

        if (ext.version) {
          const versionSpan = document.createElement('span');
          versionSpan.style.cssText = 'margin-left: 8px; font-size: 11px; color: var(--text-tertiary); font-weight: 400;';
          versionSpan.textContent = `v${ext.version}`;
          cardTitle.appendChild(versionSpan);
        }

        // Source code link (path to extension directory)
        if (ext.path) {
          const sourceLink = document.createElement('span');
          sourceLink.textContent = 'source';
          sourceLink.title = ext.path;
          sourceLink.style.cssText = 'margin-left: 8px; font-size: 11px; color: var(--text-muted); font-weight: 400; cursor: help; border-bottom: 1px dotted var(--text-muted);';
          cardTitle.appendChild(sourceLink);
        }

        leftSide.appendChild(cardTitle);
        header.appendChild(leftSide);

        card.appendChild(header);

        // Body: description + attribution
        const body = document.createElement('div');
        body.className = 'item-card-body';

        if (ext.description) {
          const desc = document.createElement('div');
          desc.className = 'help-text';
          desc.style.marginBottom = '4px';
          desc.textContent = ext.description;
          body.appendChild(desc);
        }

        // Inline attribution
        if (ext.attribution) {
          const attrDiv = document.createElement('div');
          attrDiv.className = 'help-text';
          attrDiv.style.fontSize = '11px';
          // Check if attribution contains a URL and make it a link
          const urlMatch = ext.attribution.match(/(https?:\/\/[^\s]+)/);
          if (urlMatch) {
            const beforeUrl = ext.attribution.substring(0, ext.attribution.indexOf(urlMatch[1]));
            const url = urlMatch[1];
            const afterUrl = ext.attribution.substring(ext.attribution.indexOf(urlMatch[1]) + urlMatch[1].length);
            attrDiv.innerHTML = `${beforeUrl}<a href="${url}" target="_blank" style="color: var(--text-muted);">${url}</a>${afterUrl}`;
          } else {
            attrDiv.textContent = ext.attribution;
          }
          body.appendChild(attrDiv);
        }


        // Action buttons at the bottom of the card
        if (ext.enabled) {
          const extEntries = uiEntries.filter(e => e.extensionId === ext.id && e.openable);
          if (extEntries.length > 0) {
            const actions = document.createElement('div');
            actions.style.cssText = 'display: flex; gap: 6px; margin-top: 8px;';
            const entryTypeLabels = {
              popup: 'Popup', options: 'Options', background: 'Background',
              newtab: 'New Tab', history: 'History', bookmarks: 'Bookmarks',
              devtools: 'DevTools', sidepanel: 'Side Panel',
            };
            for (const entry of extEntries) {
              const btn = document.createElement('button');
              btn.textContent = entryTypeLabels[entry.type] || entry.type;
              btn.title = entry.title;
              btn.style.cssText = `
                padding: 4px 8px;
                font-size: 11px;
                background: var(--bg-tertiary);
                border: 1px solid var(--border-primary);
                border-radius: 4px;
                color: var(--text-secondary);
                cursor: pointer;
              `;
              btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--bg-hover)'; });
              btn.addEventListener('mouseleave', () => { btn.style.background = 'var(--bg-tertiary)'; });
              btn.addEventListener('click', async () => {
                try {
                  await api.chromeExtensions.openPage(ext.id, entry.type);
                } catch (err) {
                  console.error(`[settings] Failed to open extension ${entry.type}:`, err);
                }
              });
              actions.appendChild(btn);
            }
            body.appendChild(actions);
          }
        }
        card.appendChild(body);
        extSection.appendChild(card);
      }
    }
  } catch (err) {
    console.error('[settings] Failed to load chrome extensions:', err);
    const errorMsg = document.createElement('p');
    errorMsg.className = 'help-text';
    errorMsg.style.color = 'var(--error-color, #f44)';
    errorMsg.textContent = 'Failed to load extensions: ' + err.message;
    extSection.appendChild(errorMsg);
  }

  container.appendChild(extSection);

  return container;
};

// Render dark mode settings for web pages
const renderDarkModeSettings = async () => {
  const container = document.createElement('div');

  // Description
  const desc = document.createElement('p');
  desc.className = 'help-text';
  desc.style.marginBottom = '16px';
  desc.textContent = 'Control how dark mode is applied to web pages loaded in Peek.';
  container.appendChild(desc);

  // Load current setting
  let currentMode = 'system';
  let tier2Active = false;

  try {
    const result = await api.darkMode.get();
    if (result.success && result.data) {
      currentMode = result.data.mode;
      tier2Active = result.data.tier2Active;
    }
  } catch (err) {
    console.error('[settings] Failed to load dark mode setting:', err);
  }

  // Mode selector (button group like color scheme)
  const modeSection = document.createElement('div');
  modeSection.className = 'form-section';

  const modeTitle = document.createElement('h3');
  modeTitle.className = 'form-section-title';
  modeTitle.textContent = 'Dark Mode for Web Pages';
  modeSection.appendChild(modeTitle);

  const modeGroup = document.createElement('div');
  modeGroup.style.cssText = 'display: flex; gap: 8px;';

  const modes = [
    { value: 'off', label: 'Off', desc: 'Pages render as-is' },
    { value: 'system', label: 'System', desc: 'Sites that support dark mode will use it' },
    { value: 'force', label: 'Force', desc: 'Force dark mode on all sites' },
  ];

  // Restart notice (hidden by default)
  const restartNotice = document.createElement('div');
  restartNotice.className = 'help-text';
  restartNotice.style.cssText = 'margin-top: 8px; color: var(--base09); display: none;';
  restartNotice.textContent = 'Restart required for this change to take full effect.';

  const updateButtons = (activeValue) => {
    modeGroup.querySelectorAll('button').forEach(btn => {
      const isActive = btn.dataset.mode === activeValue;
      btn.style.background = isActive ? 'var(--base0D)' : 'var(--bg-tertiary)';
      btn.style.borderColor = isActive ? 'var(--base0D)' : 'var(--base03)';
      btn.style.color = isActive ? 'white' : 'var(--text-primary)';
      btn.style.fontWeight = isActive ? '600' : '400';
    });
  };

  modes.forEach(mode => {
    const btn = document.createElement('button');
    btn.textContent = mode.label;
    btn.dataset.mode = mode.value;
    const isActive = currentMode === mode.value;
    btn.style.cssText = `
      padding: 8px 16px;
      font-size: 13px;
      background: ${isActive ? 'var(--base0D)' : 'var(--bg-tertiary)'};
      border: 2px solid ${isActive ? 'var(--base0D)' : 'var(--base03)'};
      border-radius: 6px;
      color: ${isActive ? 'white' : 'var(--text-primary)'};
      cursor: pointer;
      flex: 1;
      font-weight: ${isActive ? '600' : '400'};
    `;
    btn.addEventListener('click', async () => {
      try {
        const result = await api.darkMode.set(mode.value);
        if (result.success) {
          currentMode = mode.value;
          updateButtons(mode.value);
          // Update description
          modeDesc.textContent = modes.find(m => m.value === mode.value)?.desc || '';
          // Show restart notice if Tier 2 changed
          if (result.data?.restartRequired) {
            restartNotice.style.display = 'block';
          } else {
            restartNotice.style.display = 'none';
          }
        }
      } catch (err) {
        console.error('[settings] Failed to set dark mode:', err);
      }
    });
    modeGroup.appendChild(btn);
  });

  modeSection.appendChild(modeGroup);

  // Current mode description
  const modeDesc = document.createElement('div');
  modeDesc.className = 'help-text';
  modeDesc.style.marginTop = '8px';
  modeDesc.textContent = modes.find(m => m.value === currentMode)?.desc || '';
  modeSection.appendChild(modeDesc);

  modeSection.appendChild(restartNotice);

  container.appendChild(modeSection);

  // Tier explanation
  const tierSection = document.createElement('div');
  tierSection.className = 'form-section';
  tierSection.style.marginTop = '24px';

  const tierTitle = document.createElement('h3');
  tierTitle.className = 'form-section-title';
  tierTitle.textContent = 'How It Works';
  tierSection.appendChild(tierTitle);

  const tierDesc = document.createElement('div');
  tierDesc.className = 'help-text';
  tierDesc.innerHTML = `
    <p style="margin-bottom: 8px;"><strong>System</strong> sets <code>prefers-color-scheme: dark</code> so sites with built-in dark mode support switch automatically. Zero performance cost.</p>
    <p style="margin-bottom: 8px;"><strong>Force</strong> additionally enables Chromium's auto-dark mode, which uses CIELAB-based color inversion in the rendering pipeline. This forces dark mode on all sites, including those without native support. Images are preserved. Changing this requires an app restart.</p>
    <p><strong>Per-site dark mode</strong> (via Dark Reader) is planned for a future update.</p>
  `;
  tierSection.appendChild(tierDesc);

  container.appendChild(tierSection);

  return container;
};

// Render sync settings
const renderSyncSettings = async () => {
  const container = document.createElement('div');

  // State
  let config = { serverUrl: '', apiKey: '', autoSync: false };
  let status = { configured: false, lastSync: 0, pendingCount: 0 };
  let isSyncing = false;

  // Load initial config and status
  try {
    const configResult = await api.sync.getConfig();
    if (configResult.success && configResult.data) {
      config = { ...config, ...configResult.data };
    }

    const statusResult = await api.sync.getStatus();
    if (statusResult.success && statusResult.data) {
      status = { ...status, ...statusResult.data };
    }
  } catch (err) {
    console.error('[settings] Failed to load sync config:', err);
  }

  // Server Configuration section
  const configSection = document.createElement('div');
  configSection.className = 'form-section';

  const configTitle = document.createElement('h3');
  configTitle.className = 'form-section-title';
  configTitle.textContent = 'Server Configuration';
  configSection.appendChild(configTitle);

  // Server URL input
  const serverUrlGroup = createInput('Server URL', config.serverUrl, async (val) => {
    config.serverUrl = val;
    await api.sync.setConfig({ serverUrl: val });
    updateStatus();
  }, { type: 'url', helpText: 'Full URL to sync server (e.g., https://peek.example.com)' });
  configSection.appendChild(serverUrlGroup);

  // API Key input with show/hide toggle
  const apiKeyGroup = document.createElement('div');
  apiKeyGroup.className = 'form-group';

  const apiKeyLabel = document.createElement('label');
  apiKeyLabel.textContent = 'API Key';
  apiKeyGroup.appendChild(apiKeyLabel);

  const apiKeyWrapper = document.createElement('div');
  apiKeyWrapper.style.cssText = 'display: flex; gap: 8px;';

  const apiKeyInput = document.createElement('input');
  apiKeyInput.type = 'password';
  apiKeyInput.value = config.apiKey || '';
  apiKeyInput.style.cssText = 'flex: 1;';
  apiKeyInput.addEventListener('change', async (e) => {
    config.apiKey = e.target.value;
    await api.sync.setConfig({ apiKey: e.target.value });
    updateStatus();
  });
  apiKeyWrapper.appendChild(apiKeyInput);

  const toggleBtn = document.createElement('button');
  toggleBtn.textContent = 'Show';
  toggleBtn.style.cssText = `
    padding: 6px 12px;
    font-size: 12px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    color: var(--text-secondary);
    cursor: pointer;
    min-width: 50px;
  `;
  toggleBtn.addEventListener('click', () => {
    if (apiKeyInput.type === 'password') {
      apiKeyInput.type = 'text';
      toggleBtn.textContent = 'Hide';
    } else {
      apiKeyInput.type = 'password';
      toggleBtn.textContent = 'Show';
    }
  });
  apiKeyWrapper.appendChild(toggleBtn);
  apiKeyGroup.appendChild(apiKeyWrapper);

  const apiKeyHelp = document.createElement('div');
  apiKeyHelp.className = 'help-text';
  apiKeyHelp.textContent = 'API key for authenticating with the sync server';
  apiKeyGroup.appendChild(apiKeyHelp);

  configSection.appendChild(apiKeyGroup);

  // Auto-sync checkbox
  const autoSyncCheckbox = createCheckbox('Auto-sync', config.autoSync, async (val) => {
    config.autoSync = val;
    await api.sync.setConfig({ autoSync: val });
  }, { helpText: 'Automatically sync when items are added or modified' });
  configSection.appendChild(autoSyncCheckbox);

  container.appendChild(configSection);

  // Sync Status section
  const statusSection = document.createElement('div');
  statusSection.className = 'form-section';
  statusSection.style.marginTop = '24px';

  const statusTitle = document.createElement('h3');
  statusTitle.className = 'form-section-title';
  statusTitle.textContent = 'Sync Status';
  statusSection.appendChild(statusTitle);

  const statusContainer = document.createElement('div');
  statusContainer.style.cssText = 'padding: 12px; background: var(--bg-tertiary); border-radius: 6px; margin-bottom: 16px;';

  const statusLine = document.createElement('div');
  statusLine.className = 'help-text';
  statusLine.style.marginBottom = '4px';
  statusContainer.appendChild(statusLine);

  const lastSyncLine = document.createElement('div');
  lastSyncLine.className = 'help-text';
  lastSyncLine.style.marginBottom = '4px';
  statusContainer.appendChild(lastSyncLine);

  const pendingLine = document.createElement('div');
  pendingLine.className = 'help-text';
  statusContainer.appendChild(pendingLine);

  statusSection.appendChild(statusContainer);

  // Function to update status display
  const updateStatus = async () => {
    try {
      const statusResult = await api.sync.getStatus();
      if (statusResult.success && statusResult.data) {
        status = statusResult.data;
      }
    } catch (err) {
      console.error('[settings] Failed to get sync status:', err);
    }

    const isConfigured = config.serverUrl && config.apiKey;
    statusLine.textContent = `Status: ${isConfigured ? 'Configured' : 'Not configured'}`;
    statusLine.style.color = isConfigured ? 'var(--text-primary)' : 'var(--text-tertiary)';

    if (status.lastSyncTime && status.lastSyncTime > 0) {
      const lastSyncDate = new Date(status.lastSyncTime);
      lastSyncLine.textContent = `Last sync: ${lastSyncDate.toLocaleString()}`;
    } else {
      lastSyncLine.textContent = 'Last sync: Never';
    }

    pendingLine.textContent = `Pending items: ${status.pendingCount || 0}`;
  };

  // Initial status update
  await updateStatus();

  container.appendChild(statusSection);

  // Manual Sync section
  const syncSection = document.createElement('div');
  syncSection.className = 'form-section';
  syncSection.style.marginTop = '24px';

  const syncTitle = document.createElement('h3');
  syncTitle.className = 'form-section-title';
  syncTitle.textContent = 'Manual Sync';
  syncSection.appendChild(syncTitle);

  // Result display area
  const resultArea = document.createElement('div');
  resultArea.style.cssText = 'padding: 12px; border-radius: 6px; margin-bottom: 16px; display: none;';
  syncSection.appendChild(resultArea);

  // Function to show result message
  const showResult = (message, isError = false) => {
    resultArea.textContent = message;
    resultArea.style.display = 'block';
    resultArea.style.background = isError ? 'var(--error-bg, #fef2f2)' : 'var(--success-bg, #f0fdf4)';
    resultArea.style.border = isError ? '1px solid var(--error-border, #fecaca)' : '1px solid var(--success-border, #bbf7d0)';
    resultArea.style.color = isError ? 'var(--error-text, #dc2626)' : 'var(--success-text, #16a34a)';

    // Auto-hide after 5 seconds
    setTimeout(() => {
      resultArea.style.display = 'none';
    }, 5000);
  };

  // Button container
  const buttonContainer = document.createElement('div');
  buttonContainer.style.cssText = 'display: flex; gap: 8px; flex-wrap: wrap;';

  // Helper to create action buttons
  const createActionButton = (text, action) => {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.style.cssText = `
      padding: 10px 16px;
      font-size: 13px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-primary);
      border-radius: 6px;
      color: var(--text-primary);
      cursor: pointer;
      flex: 1;
      min-width: 120px;
    `;
    btn.addEventListener('mouseenter', () => {
      if (!btn.disabled) btn.style.background = 'var(--bg-hover)';
    });
    btn.addEventListener('mouseleave', () => {
      if (!btn.disabled) btn.style.background = 'var(--bg-tertiary)';
    });
    btn.addEventListener('click', async () => {
      if (isSyncing) return;

      // Check if configured
      if (!config.serverUrl || !config.apiKey) {
        showResult('Please configure server URL and API key first', true);
        return;
      }

      isSyncing = true;
      const originalText = btn.textContent;
      btn.textContent = 'Syncing...';
      btn.disabled = true;
      btn.style.opacity = '0.6';
      btn.style.cursor = 'not-allowed';

      // Disable all buttons during operation
      buttonContainer.querySelectorAll('button').forEach(b => {
        b.disabled = true;
        b.style.opacity = '0.6';
        b.style.cursor = 'not-allowed';
      });

      try {
        const result = await action();
        if (result.success) {
          const data = result.data || {};
          let message = '';
          if (data.pulled !== undefined && data.pushed !== undefined) {
            message = `Synced: ${data.pulled} pulled, ${data.pushed} pushed`;
            if (data.conflicts) message += `, ${data.conflicts} conflicts`;
          } else if (data.pulled !== undefined) {
            message = `Pulled ${data.pulled} items`;
            if (data.conflicts) message += ` (${data.conflicts} conflicts)`;
          } else if (data.pushed !== undefined) {
            message = `Pushed ${data.pushed} items`;
            if (data.skipped) message += ` (${data.skipped} skipped)`;
          } else {
            message = 'Sync completed';
          }
          showResult(message, false);
        } else {
          showResult(result.error || 'Sync failed', true);
        }
      } catch (err) {
        showResult(err.message || 'Sync error', true);
      } finally {
        isSyncing = false;
        btn.textContent = originalText;

        // Re-enable all buttons
        buttonContainer.querySelectorAll('button').forEach(b => {
          b.disabled = false;
          b.style.opacity = '1';
          b.style.cursor = 'pointer';
          b.style.background = 'var(--bg-tertiary)';
        });

        // Update status after sync
        await updateStatus();
      }
    });
    return btn;
  };

  // Pull button
  const pullBtn = createActionButton('Pull from Server', () => api.sync.pull());
  buttonContainer.appendChild(pullBtn);

  // Push button
  const pushBtn = createActionButton('Push to Server', () => api.sync.push());
  buttonContainer.appendChild(pushBtn);

  // Sync All button
  const syncAllBtn = createActionButton('Sync All', () => api.sync.syncAll());
  syncAllBtn.style.background = 'var(--base0D)';
  syncAllBtn.style.color = 'white';
  syncAllBtn.style.border = '1px solid var(--base0D)';
  syncAllBtn.addEventListener('mouseenter', () => {
    if (!syncAllBtn.disabled) syncAllBtn.style.background = 'var(--base0D)';
  });
  syncAllBtn.addEventListener('mouseleave', () => {
    if (!syncAllBtn.disabled) syncAllBtn.style.background = 'var(--base0D)';
  });
  buttonContainer.appendChild(syncAllBtn);

  syncSection.appendChild(buttonContainer);

  // Help text
  const helpText = document.createElement('div');
  helpText.className = 'help-text';
  helpText.style.marginTop = '12px';
  helpText.textContent = 'Pull downloads new items from the server. Push uploads local items. Sync All does both.';
  syncSection.appendChild(helpText);

  container.appendChild(syncSection);

  // Profile Sync section
  const profileSyncSection = document.createElement('div');
  profileSyncSection.className = 'form-section';
  profileSyncSection.style.marginTop = '24px';

  const profileSyncTitle = document.createElement('h3');
  profileSyncTitle.className = 'form-section-title';
  profileSyncTitle.textContent = 'Profiles';
  profileSyncSection.appendChild(profileSyncTitle);

  const profileSyncDesc = document.createElement('div');
  profileSyncDesc.className = 'help-text';
  profileSyncDesc.style.marginBottom = '12px';
  profileSyncDesc.textContent = 'Enable or disable sync for each profile and configure its server profile ID.';
  profileSyncSection.appendChild(profileSyncDesc);

  const profileSyncList = document.createElement('div');
  profileSyncList.style.cssText = 'display: flex; flex-direction: column; gap: 12px;';

  // Load profiles and their sync configs
  try {
    const listResult = await api.profiles.list();
    const profiles = (listResult.success && listResult.data) ? listResult.data : [];

    for (const profile of profiles) {
      let syncConfig = null;
      try {
        const configResult = await api.profiles.getSyncConfig(profile.id);
        if (configResult.success && configResult.data) {
          syncConfig = configResult.data;
        }
      } catch (err) {
        console.error('[settings] Failed to get sync config for profile:', err);
      }

      const row = document.createElement('div');
      row.style.cssText = `
        padding: 12px;
        background: var(--bg-secondary);
        border: 1px solid var(--border-primary);
        border-radius: 6px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      `;

      const rowHeader = document.createElement('div');
      rowHeader.style.cssText = 'display: flex; align-items: center; justify-content: space-between;';

      const profileName = document.createElement('span');
      profileName.textContent = profile.name;
      profileName.style.cssText = 'font-weight: 500;';
      rowHeader.appendChild(profileName);

      if (syncConfig) {
        // Sync enabled — show status and disable button
        const statusBadge = document.createElement('span');
        statusBadge.textContent = 'Enabled';
        statusBadge.style.cssText = 'font-size: 12px; color: var(--success-text, #16a34a); font-weight: 500;';
        rowHeader.appendChild(statusBadge);
        row.appendChild(rowHeader);

        const detailsRow = document.createElement('div');
        detailsRow.style.cssText = 'font-size: 12px; color: var(--text-secondary);';
        detailsRow.textContent = `Server profile: ${syncConfig.serverProfileId}`;
        row.appendChild(detailsRow);

        const disableBtn = document.createElement('button');
        disableBtn.textContent = 'Disable Sync';
        disableBtn.style.cssText = `
          padding: 4px 12px;
          background: var(--bg-tertiary);
          border: 1px solid var(--border-primary);
          border-radius: 4px;
          color: var(--text-secondary);
          font-size: 12px;
          cursor: pointer;
          align-self: flex-start;
        `;
        disableBtn.addEventListener('click', async () => {
          if (confirm(`Disable sync for profile "${profile.name}"?`)) {
            const result = await api.profiles.disableSync(profile.id);
            if (result.success) {
              // Refresh the sync pane
              const newContent = await renderSyncSettings();
              container.replaceWith(newContent);
            } else {
              alert(`Failed to disable sync: ${result.error}`);
            }
          }
        });
        row.appendChild(disableBtn);
      } else {
        // Sync not enabled — show enable button
        const statusBadge = document.createElement('span');
        statusBadge.textContent = 'Disabled';
        statusBadge.style.cssText = 'font-size: 12px; color: var(--text-tertiary);';
        rowHeader.appendChild(statusBadge);
        row.appendChild(rowHeader);

        // Inline enable form (hidden by default)
        const enableForm = document.createElement('div');
        enableForm.style.cssText = 'display: none; flex-direction: column; gap: 8px;';

        const formApiKeyInput = document.createElement('input');
        formApiKeyInput.type = 'password';
        formApiKeyInput.placeholder = 'API Key';
        formApiKeyInput.style.cssText = `
          width: 100%;
          padding: 8px;
          border: 1px solid var(--border-primary);
          border-radius: 4px;
          background: var(--bg-tertiary);
          color: var(--text-primary);
          font-size: 13px;
        `;
        enableForm.appendChild(formApiKeyInput);

        const formProfileIdInput = document.createElement('input');
        formProfileIdInput.type = 'text';
        formProfileIdInput.placeholder = 'Server profile ID (UUID from server)';
        formProfileIdInput.style.cssText = `
          width: 100%;
          padding: 8px;
          border: 1px solid var(--border-primary);
          border-radius: 4px;
          background: var(--bg-tertiary);
          color: var(--text-primary);
          font-size: 13px;
        `;
        enableForm.appendChild(formProfileIdInput);

        const formButtons = document.createElement('div');
        formButtons.style.cssText = 'display: flex; gap: 8px;';

        const formSaveBtn = document.createElement('button');
        formSaveBtn.textContent = 'Enable';
        formSaveBtn.style.cssText = `
          padding: 6px 14px;
          background: var(--accent-primary);
          border: none;
          border-radius: 4px;
          color: white;
          font-size: 12px;
          cursor: pointer;
        `;
        formSaveBtn.addEventListener('click', async () => {
          const apiKey = formApiKeyInput.value.trim();
          const serverProfileId = formProfileIdInput.value.trim();
          if (!apiKey) { alert('Please enter an API key'); return; }
          if (!serverProfileId) { alert('Please enter a server profile ID'); return; }
          const result = await api.profiles.enableSync(profile.id, apiKey, serverProfileId);
          if (result.success) {
            const newContent = await renderSyncSettings();
            container.replaceWith(newContent);
          } else {
            alert(`Failed to enable sync: ${result.error}`);
          }
        });
        formButtons.appendChild(formSaveBtn);

        const formCancelBtn = document.createElement('button');
        formCancelBtn.textContent = 'Cancel';
        formCancelBtn.style.cssText = `
          padding: 6px 14px;
          background: var(--bg-tertiary);
          border: 1px solid var(--border-primary);
          border-radius: 4px;
          color: var(--text-secondary);
          font-size: 12px;
          cursor: pointer;
        `;
        formCancelBtn.addEventListener('click', () => {
          enableForm.style.display = 'none';
          enableBtn.style.display = '';
        });
        formButtons.appendChild(formCancelBtn);

        enableForm.appendChild(formButtons);
        row.appendChild(enableForm);

        const enableBtn = document.createElement('button');
        enableBtn.textContent = 'Enable Sync';
        enableBtn.style.cssText = `
          padding: 4px 12px;
          background: var(--accent-primary);
          border: none;
          border-radius: 4px;
          color: white;
          font-size: 12px;
          cursor: pointer;
          align-self: flex-start;
        `;
        enableBtn.addEventListener('click', () => {
          enableBtn.style.display = 'none';
          enableForm.style.display = 'flex';
          formApiKeyInput.focus();
        });
        row.appendChild(enableBtn);
      }

      profileSyncList.appendChild(row);
    }

    if (profiles.length === 0) {
      const emptyNote = document.createElement('div');
      emptyNote.className = 'help-text';
      emptyNote.textContent = 'No profiles found.';
      profileSyncList.appendChild(emptyNote);
    }
  } catch (err) {
    console.error('[settings] Failed to load profiles for sync section:', err);
    const errorNote = document.createElement('div');
    errorNote.className = 'help-text';
    errorNote.textContent = 'Failed to load profiles.';
    profileSyncList.appendChild(errorNote);
  }

  profileSyncSection.appendChild(profileSyncList);
  container.appendChild(profileSyncSection);

  return container;
};

// Render features settings (Peek's own features: cmd, groups, peeks, slides, windows)
const renderFeaturesSettings = async () => {
  const container = document.createElement('div');

  // Note: feature install (Add Feature) is now handled by the dedicated
  // features-manager UI, which uses tile:features:install (atproto) +
  // tile:features:dev-create (local scaffold). The settings pane only
  // surfaces enable/disable/reload/remove for already-registered features.
  const installNote = document.createElement('div');
  installNote.className = 'help-text';
  installNote.style.cssText = 'margin-bottom: 16px;';
  installNote.textContent = 'To install or develop new features, open the Features Manager.';
  container.appendChild(installNote);

  // Features list container (for refresh)
  const listContainer = document.createElement('div');
  listContainer.id = 'features-list-container';
  container.appendChild(listContainer);

  // Function to refresh features list
  const refreshFeaturesList = async () => {
    listContainer.innerHTML = '';

    const loading = document.createElement('div');
    loading.className = 'help-text';
    loading.textContent = 'Loading features...';
    listContainer.appendChild(loading);

    try {
      // The features storage list still drives builtin enable/disable persistence
      // (the toggle handler in app/index.js subscribes to core:feature:toggle and
      // reads from this list to decide whether the feature is currently enabled).
      const coreStore = _coreStore || await createDatastoreStore('core', appConfig.defaults);
      const features = coreStore.get(appConfig.storageKeys.ITEMS) || [];

      // Pull non-builtin features (default filter) and builtins separately,
      // then merge. tile:features:list filters out builtins unless an
      // explicit sourceType is passed, so we issue both calls.
      const [nonBuiltinResult, builtinResult] = await Promise.all([
        api.features.list(),
        api.features.list('builtin'),
      ]);

      loading.remove();

      const allEntries = [
        ...(nonBuiltinResult?.entries || []),
        ...(builtinResult?.entries || []),
      ];

      // Fetch each feature's settings-schema JSON in parallel so the
      // Options accordion can render. The registry's flat entry shape
      // doesn't include `settingsSchema` — without this round-trip the
      // accordion gate is always false and per-feature options never appear.
      const schemaResults = await Promise.all(
        allEntries.map(entry =>
          api.features.settingsSchema(entry.id)
            .then(r => r?.success ? r.data : null)
            .catch(() => null)
        )
      );

      const allFeatures = allEntries.map((entry, i) => {
        const isBuiltin = entry.source?.type === 'builtin';
        const feature = features.find(f => f.name.toLowerCase() === entry.id);
        // Builtins respect the local features-list "enabled" flag
        // (defaults true). Non-builtins use the registry's `disabled` flag.
        const enabled = isBuiltin
          ? (feature ? feature.enabled !== false : true)
          : !entry.disabled;

        const schemaJson = schemaResults[i];

        // The registry stores a flat entry — adapt to the manifest-shaped
        // object the renderer below expects.
        const manifest = {
          id: entry.id,
          name: entry.name || entry.id,
          shortname: entry.id,
          description: '',
          version: entry.source?.version || '',
          builtin: isBuiltin,
          author: entry.source?.publisherName || entry.source?.publisher || '',
          // Schema fields surface the per-feature Options accordion below.
          // `schemas` / `storageKeys` / `defaults` are pulled out of the
          // settings-schema.json that the manifest's `settingsSchema` field
          // points at (loaded server-side via api.features.settingsSchema).
          schemas: schemaJson ? { prefs: schemaJson.prefs, item: schemaJson.item } : null,
          storageKeys: schemaJson?.storageKeys || { PREFS: 'prefs', ITEMS: 'items' },
          defaults: schemaJson?.defaults || {},
        };

        return {
          id: entry.id,
          manifest,
          path: entry.path,
          source: isBuiltin ? 'builtin' : 'datastore',
          // Without windowList we can't tell whether the feature has a live
          // tile window — surface it as not-running so we don't show a
          // misleading Reload button. Reload still works on demand via the
          // dev-reload IPC, which gracefully reports "no active tiles".
          isRunning: false,
          enabled,
          status: entry.disabled ? 'disabled' : 'installed',
          lastError: null,
        };
      });

      if (allFeatures.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'help-text';
        empty.textContent = 'No features installed. Click "Add Feature" to install one.';
        listContainer.appendChild(empty);
        return;
      }

      const featuresSection = document.createElement('div');
      featuresSection.className = 'form-section';

      const title = document.createElement('h3');
      title.className = 'form-section-title';
      title.textContent = 'Installed Features';
      featuresSection.appendChild(title);

      allFeatures.filter(feat => !(feat.manifest || {}).hidden).forEach(feat => {
        const manifest = feat.manifest || {};
        const isBuiltin = manifest.builtin || feat.source === 'builtin';

        const card = document.createElement('div');
        card.className = 'item-card no-collapse';

        const header = document.createElement('div');
        header.className = 'item-card-header';
        header.style.cssText = 'border-bottom: none; margin-bottom: 4px; padding-bottom: 0;';

        // Left side: checkbox + name
        const leftSide = document.createElement('div');
        leftSide.style.cssText = 'display: flex; align-items: center; gap: 12px;';

        // Enable/disable checkbox.
        // The cmd feature is required infrastructure — can't be disabled.
        const isCmdFeature = feat.id === 'cmd';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = feat.enabled;
        checkbox.disabled = isCmdFeature;
        checkbox.title = isCmdFeature ? 'Required - cannot be disabled' : '';
        checkbox.style.cssText = `width: 16px; height: 16px; cursor: ${isCmdFeature ? 'not-allowed' : 'pointer'}; ${isCmdFeature ? 'opacity: 0.5;' : ''}`;
        checkbox.addEventListener('change', async (e) => {
          const newEnabled = e.target.checked;
          checkbox.disabled = true;

          if (isBuiltin) {
            // Update features storage for persistence
            const coreStore = _coreStore || await createDatastoreStore('core', appConfig.defaults);
            const featuresList = coreStore.get(appConfig.storageKeys.ITEMS) || [];
            const featureIndex = featuresList.findIndex(f => f.name.toLowerCase() === feat.id);
            if (featureIndex >= 0) {
              featuresList[featureIndex].enabled = newEnabled;
              await coreStore.set(appConfig.storageKeys.ITEMS, featuresList);
            }

            // Use the feature toggle mechanism to load/unload
            // This triggers the core:feature:toggle handler in app/index.js
            api.publish('core:feature:toggle', {
              featureId: feat.id,
              enabled: newEnabled
            });
          } else if (feat.source === 'datastore') {
            // Toggle via the unified registry — enable / disable mark the
            // entry in registry.json and broadcast feature:enabled /
            // feature:disabled. Tile windows are launched / unloaded by
            // the main process side-effect inside the strict handler.
            const toggleResult = newEnabled
              ? await api.features.enable(feat.id)
              : await api.features.disable(feat.id);
            if (toggleResult?.error) {
              console.error(`[settings] Feature ${feat.id} toggle failed:`, toggleResult.error);
            }
          }

          checkbox.disabled = false;
          // Refresh to show current state
          setTimeout(refreshFeaturesList, 300);
        });
        leftSide.appendChild(checkbox);

        const cardTitle = document.createElement('div');
        cardTitle.className = 'item-card-title';
        cardTitle.style.margin = '0';

        const nameSpan = document.createElement('span');
        nameSpan.textContent = manifest.name || feat.id;
        cardTitle.appendChild(nameSpan);

        if (manifest.version) {
          const versionSpan = document.createElement('span');
          versionSpan.style.cssText = 'margin-left: 8px; font-size: 11px; color: var(--text-tertiary);';
          versionSpan.textContent = `v${manifest.version}`;
          cardTitle.appendChild(versionSpan);
        }

        if (manifest.author) {
          const authorSpan = document.createElement('span');
          authorSpan.style.cssText = 'margin-left: 8px; font-size: 11px; color: var(--text-tertiary);';
          authorSpan.textContent = manifest.author;
          cardTitle.appendChild(authorSpan);
        }

        // Show "required" badge for the cmd feature (cannot be disabled).
        if (isCmdFeature) {
          const requiredBadge = document.createElement('span');
          requiredBadge.style.cssText = 'margin-left: 8px; font-size: 10px; padding: 2px 6px; background: var(--base0E, #c678dd); border-radius: 4px; color: white;';
          requiredBadge.textContent = 'required';
          cardTitle.appendChild(requiredBadge);
        }

        leftSide.appendChild(cardTitle);
        header.appendChild(leftSide);

        // Right side: actions
        const actions = document.createElement('div');
        actions.style.cssText = 'display: flex; gap: 8px; align-items: center;';

        // Reload button (only when running)
        if (feat.isRunning) {
          const reloadBtn = document.createElement('button');
          reloadBtn.textContent = 'Reload';
          reloadBtn.style.cssText = `
            padding: 4px 8px;
            font-size: 11px;
            background: var(--bg-tertiary);
            border: 1px solid var(--border-primary);
            border-radius: 4px;
            color: var(--text-secondary);
            cursor: pointer;
          `;
          reloadBtn.addEventListener('click', async () => {
            reloadBtn.textContent = '...';
            reloadBtn.disabled = true;
            try {
              const result = await api.features.devReload(feat.id);
              reloadBtn.textContent = result && !result.error ? '✓' : '✗';
            } catch (err) {
              reloadBtn.textContent = '✗';
            }
            setTimeout(() => {
              reloadBtn.textContent = 'Reload';
              reloadBtn.disabled = false;
              refreshFeaturesList();
            }, 1000);
          });
          actions.appendChild(reloadBtn);
        }

        // Remove button (only for external features).
        if (!isBuiltin) {
          const removeBtn = document.createElement('button');
          removeBtn.textContent = 'Remove';
          removeBtn.style.cssText = `
            padding: 4px 8px;
            font-size: 11px;
            background: var(--bg-tertiary);
            border: 1px solid #ef4444;
            border-radius: 4px;
            color: #ef4444;
            cursor: pointer;
          `;
          removeBtn.addEventListener('click', async () => {
            if (!confirm(`Remove feature "${manifest.name || feat.id}"?`)) return;

            removeBtn.textContent = '...';
            removeBtn.disabled = true;

            // Remove from the unified registry — the strict handler
            // tears down any running tile windows before deleting files.
            const result = await api.features.remove(feat.id);
            if (result && !result.error) {
              refreshFeaturesList();
            } else {
              removeBtn.textContent = 'Error';
              setTimeout(() => {
                removeBtn.textContent = 'Remove';
                removeBtn.disabled = false;
              }, 2000);
            }
          });
          actions.appendChild(removeBtn);
        }

        header.appendChild(actions);
        card.appendChild(header);

        // Body
        const body = document.createElement('div');
        body.className = 'item-card-body';

        if (manifest.description) {
          const desc = document.createElement('div');
          desc.className = 'help-text';
          desc.textContent = manifest.description;
          body.appendChild(desc);
        }

        // Show path for external features.
        if (feat.path && !isBuiltin) {
          const pathInfo = document.createElement('div');
          pathInfo.className = 'help-text';
          pathInfo.style.cssText = 'font-family: monospace; font-size: 11px; margin-bottom: 4px;';
          pathInfo.textContent = feat.path;
          body.appendChild(pathInfo);
        }

        // Show error if any.
        if (feat.lastError) {
          const errorInfo = document.createElement('div');
          errorInfo.className = 'feature-error';
          errorInfo.style.cssText = 'margin-top: 8px; padding: 8px; background: var(--error-bg, #fef2f2); border: 1px solid var(--error-border, #fecaca); border-radius: 4px; font-size: 12px; color: var(--error-text, #dc2626);';
          errorInfo.textContent = `Error: ${feat.lastError}`;
          body.appendChild(errorInfo);
        }

        // Inline Options accordion for features with settings schemas.
        if (manifest.schemas && (manifest.schemas.prefs || manifest.schemas.item)) {
          const optionsAccordion = document.createElement('div');
          optionsAccordion.className = 'ext-options-accordion';
          optionsAccordion.style.cssText = 'margin-top: 12px; border-top: 1px solid var(--border-light);';

          const optionsToggle = document.createElement('div');
          optionsToggle.className = 'ext-options-toggle';
          optionsToggle.style.cssText = 'padding: 8px 0; cursor: pointer; user-select: none; font-size: 13px; font-weight: 500; color: var(--text-secondary);';
          optionsToggle.textContent = '\u25B6 Options';
          optionsAccordion.appendChild(optionsToggle);

          const optionsContent = document.createElement('div');
          optionsContent.className = 'ext-options-content';
          optionsContent.style.cssText = 'display: none; padding: 8px 0;';
          optionsAccordion.appendChild(optionsContent);

          let optionsLoaded = false;

          optionsToggle.addEventListener('click', async () => {
            const isExpanded = optionsContent.style.display !== 'none';
            if (isExpanded) {
              optionsContent.style.display = 'none';
              optionsToggle.textContent = '\u25B6 Options';
            } else {
              optionsContent.style.display = 'block';
              optionsToggle.textContent = '\u25BC Options';

              // Lazy-load settings content on first expand
              if (!optionsLoaded) {
                optionsLoaded = true;
                try {
                  const feature = {
                    id: manifest.id,
                    shortname: manifest.shortname || feat.id || manifest.id,
                    labels: { name: manifest.name, ...(manifest.labels || {}) },
                    schemas: manifest.schemas,
                    storageKeys: manifest.storageKeys || { PREFS: 'prefs', ITEMS: 'items' },
                    defaults: manifest.defaults || {}
                  };
                  const settingsContent = await renderFeatureSettings(feature);
                  optionsContent.appendChild(settingsContent);
                } catch (err) {
                  console.error(`[settings] Failed to load options for ${feat.id}:`, err);
                  const errorMsg = document.createElement('div');
                  errorMsg.className = 'help-text';
                  errorMsg.style.color = 'var(--error-text, #dc2626)';
                  errorMsg.textContent = 'Failed to load options: ' + err.message;
                  optionsContent.appendChild(errorMsg);
                }
              }
            }
          });

          body.appendChild(optionsAccordion);
        }

        card.appendChild(body);
        featuresSection.appendChild(card);
      });

      listContainer.appendChild(featuresSection);
    } catch (err) {
      loading.remove();
      const error = document.createElement('div');
      error.className = 'help-text';
      error.textContent = `Error loading features: ${err.message}`;
      listContainer.appendChild(error);
    }
  };

  // Initial load (may be incomplete if features are still loading).
  await refreshFeaturesList();

  // Store refresh function for external access (feature:all-loaded is subscribed once in main init)
  window._refreshFeaturesList = refreshFeaturesList;

  return container;
};

// Render feature settings (Peeks, Slides, etc.)
// Reads/writes from datastore feature_settings table
const renderFeatureSettings = async (feature) => {
  const { id, labels, schemas, storageKeys, defaults } = feature;

  // Use the feature's shortname for the datastore key (e.g. 'peeks', 'slides', 'websearch').
  // Must match what api.settings uses (derived from peek://{shortname}/... URL).
  const featureId = feature.shortname || labels.name.toLowerCase();

  // Load from datastore.
  const store = await createDatastoreStore(featureId, defaults);

  let prefs = store.get(storageKeys.PREFS);
  let items = store.get(storageKeys.ITEMS);

  const container = document.createElement('div');

  // Topic for notifying the feature of settings changes (e.g. 'peeks:settings-changed').
  // Uses the feature's shortname so the topic matches what features subscribe to.
  const settingsChangedTopic = `${featureId}:settings-changed`;

  const save = async () => {
    // Save to datastore
    await store.set(storageKeys.PREFS, prefs);
    if (items) {
      await store.set(storageKeys.ITEMS, items);
    }

    // Notify feature to hot-reload with new settings (GLOBAL for cross-process)
    api.publish(settingsChangedTopic, {});
  };

  // Preferences
  if (schemas.prefs && schemas.prefs.properties && Object.keys(schemas.prefs.properties).length > 0) {
    const prefsSection = document.createElement('div');
    prefsSection.className = 'form-section';

    const pProps = schemas.prefs.properties;

    // Helper: convert camelCase to human-readable label (e.g., "enableSuggestions" -> "Enable suggestions")
    const camelToLabel = (str) => {
      const result = str.replace(/([A-Z])/g, ' $1').toLowerCase();
      return result.charAt(0).toUpperCase() + result.slice(1);
    };

    Object.keys(pProps).forEach(k => {
      const s = pProps[k];
      const v = (prefs && prefs.hasOwnProperty(k)) ? prefs[k] : s.default;
      const displayLabel = (labels.prefs && labels.prefs[k]) || camelToLabel(k);

      if (s.type === 'boolean') {
        const checkbox = createCheckbox(displayLabel, v, (newVal) => {
          prefs[k] = newVal;
          save();
        }, {
          helpText: s.description
        });
        prefsSection.appendChild(checkbox);
      } else if (s.type === 'integer' || s.type === 'number') {
        const input = createInput(displayLabel, v, (newVal) => {
          prefs[k] = newVal;
          save();
        }, {
          type: 'number',
          step: s.type === 'integer' ? 1 : 0.1,
          helpText: s.description
        });
        prefsSection.appendChild(input);
      } else if (s.enum && Array.isArray(s.enum)) {
        // Render as select dropdown when enum values are specified
        const selectOptions = s.enum.map(val => ({
          value: val,
          label: (s.enumLabels && s.enumLabels[val]) || val
        }));
        const select = createSelect(displayLabel, v, selectOptions, (newVal) => {
          prefs[k] = newVal;
          save();
        }, {
          helpText: s.description
        });
        prefsSection.appendChild(select);
      } else {
        const input = createInput(displayLabel, v, (newVal) => {
          prefs[k] = newVal;
          save();
        }, {
          helpText: s.description
        });
        prefsSection.appendChild(input);
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

      // Toggle collapse on header click
      header.addEventListener('click', (e) => {
        if (e.target === checkbox) return;
        card.classList.toggle('collapsed');
      });

      const body = document.createElement('div');
      body.className = 'item-card-body';

      // Render item fields based on schema
      const itemProps = schemas.item?.properties || {};
      Object.keys(itemProps).forEach(k => {
        // Skip enabled (already in header) and id/version
        if (k === 'enabled' || k === 'id' || k === 'version') return;

        const s = itemProps[k];
        const v = item[k];

        if (s.type === 'boolean') {
          const checkbox = createCheckbox(k, v, (newVal) => {
            items[i][k] = newVal;
            save();
          });
          body.appendChild(checkbox);
        } else if (s.type === 'integer' || s.type === 'number') {
          const input = createInput(k, v, (newVal) => {
            items[i][k] = newVal;
            save();
          }, {
            type: 'number',
            step: s.type === 'integer' ? 1 : 0.1,
            helpText: s.description,
            disabled: s.readOnly
          });
          body.appendChild(input);
        } else {
          const input = createInput(k, v, (newVal) => {
            items[i][k] = newVal;
            save();
          }, {
            type: k.includes('address') || k.includes('url') ? 'url' : 'text',
            helpText: s.description,
            disabled: s.readOnly
          });
          body.appendChild(input);
        }
      });

      card.appendChild(body);
      itemsSection.appendChild(card);
    });

    container.appendChild(itemsSection);
  }

  return container;
};

// Navigation handling
const showSection = (sectionId) => {
  // Hide all sections
  document.querySelectorAll('.section').forEach(s => {
    s.classList.remove('active');
  });

  // Remove active from all nav items
  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.remove('active');
  });

  // Show selected section
  const section = document.getElementById(`section-${sectionId}`);
  if (section) {
    section.classList.add('active');
  }

  // Mark nav item as active
  const navItem = document.querySelector(`[data-section="${sectionId}"]`);
  if (navItem) {
    navItem.classList.add('active');
  }

  // Persist pane in URL hash so session restore reopens the same pane
  if (location.hash !== `#${sectionId}`) {
    history.replaceState(null, '', `#${sectionId}`);
  }
};

// Cached core store for feature state lookups
let _coreStore = null;

// Render profiles settings
const renderProfilesSettings = async () => {
  const container = document.createElement('div');

  // Get current profile and all profiles
  let currentProfile = null;
  let profiles = [];

  try {
    const currentResult = await api.profiles.getCurrent();
    if (currentResult.success && currentResult.data) {
      currentProfile = currentResult.data;
    }

    const listResult = await api.profiles.list();
    if (listResult.success && listResult.data) {
      profiles = listResult.data;
    }
  } catch (err) {
    console.error('[settings] Failed to load profiles:', err);
  }

  // Current profile section
  const currentSection = document.createElement('div');
  currentSection.className = 'form-section';

  const currentTitle = document.createElement('h3');
  currentTitle.className = 'form-section-title';
  currentTitle.textContent = 'Current Profile';
  currentSection.appendChild(currentTitle);

  const currentName = document.createElement('p');
  currentName.textContent = currentProfile ? currentProfile.name : 'Unknown';
  currentName.style.cssText = 'margin: 8px 0; font-weight: 500;';
  currentSection.appendChild(currentName);

  container.appendChild(currentSection);

  // Add Profile button
  const addSection = document.createElement('div');
  addSection.className = 'form-section';
  addSection.style.cssText = 'border-top: 1px solid var(--border-primary); padding-top: 16px;';

  const addBtn = document.createElement('button');
  addBtn.textContent = 'Add Profile';
  addBtn.className = 'btn-primary';
  addBtn.style.cssText = `
    padding: 8px 16px;
    background: var(--accent-primary);
    border: none;
    border-radius: 4px;
    color: white;
    font-size: 13px;
    cursor: pointer;
  `;
  addBtn.addEventListener('click', () => showAddProfileDialog(container));
  addSection.appendChild(addBtn);

  container.appendChild(addSection);

  // Profiles list section
  const listSection = document.createElement('div');
  listSection.className = 'form-section';
  listSection.style.cssText = 'border-top: 1px solid var(--border-primary); padding-top: 16px;';

  const listTitle = document.createElement('h3');
  listTitle.className = 'form-section-title';
  listTitle.textContent = 'All Profiles';
  listSection.appendChild(listTitle);

  const profilesList = document.createElement('div');
  profilesList.className = 'profiles-list';
  profilesList.style.cssText = 'display: flex; flex-direction: column; gap: 12px;';

  for (const profile of profiles) {
    const card = document.createElement('div');
    card.style.cssText = `
      padding: 12px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-primary);
      border-radius: 6px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    `;

    // Profile header (radio + name + delete)
    const header = document.createElement('div');
    header.style.cssText = 'display: flex; align-items: center; gap: 8px;';

    // Radio button for switching
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'profile-switch';
    const isCurrentProfile = currentProfile && profile.id === currentProfile.id;
    radio.checked = isCurrentProfile;
    radio.style.cursor = 'pointer';
    radio.addEventListener('change', () => {
      if (radio.checked) {
        console.log(`[profiles] Switching to profile: ${profile.name} (folder: ${profile.folder})`);

        // Double check we're not already on this profile
        if (isCurrentProfile) {
          console.log('[profiles] Already on this profile, skipping switch');
          return;
        }

        if (confirm(`Switch to "${profile.name}"?\n\nThe app will restart to apply the change.`)) {
          console.log('[profiles] User confirmed switch');
          api.profiles.switch(profile.folder).then(result => {
            if (!result.success) {
              console.error('[profiles] Switch failed:', result.error);
              alert(`Failed to switch profile: ${result.error}`);
              radio.checked = false;
            }
          });
        } else {
          console.log('[profiles] User cancelled switch');
          radio.checked = false;
        }
      }
    });
    header.appendChild(radio);

    // Profile name
    const nameEl = document.createElement('span');
    nameEl.textContent = profile.name;
    nameEl.style.cssText = 'flex: 1; font-weight: 500;';
    header.appendChild(nameEl);

    // Delete button (disabled for default or active)
    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Delete';
    deleteBtn.disabled = profile.isDefault || (currentProfile && profile.id === currentProfile.id);
    deleteBtn.style.cssText = `
      padding: 4px 12px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-primary);
      border-radius: 4px;
      color: var(--text-secondary);
      font-size: 12px;
      cursor: pointer;
    `;
    if (deleteBtn.disabled) {
      deleteBtn.style.opacity = '0.5';
      deleteBtn.style.cursor = 'not-allowed';
    }
    deleteBtn.addEventListener('click', async () => {
      if (confirm(`Delete profile "${profile.name}"? Data will be preserved but the profile record will be removed.`)) {
        const result = await api.profiles.delete(profile.id);
        if (result.success) {
          card.remove();
        } else {
          alert(`Failed to delete profile: ${result.error}`);
        }
      }
    });
    header.appendChild(deleteBtn);

    card.appendChild(header);

    // Sync link — config is now in the Sync pane
    const syncNote = document.createElement('div');
    syncNote.style.cssText = `
      padding: 8px;
      background: var(--bg-tertiary);
      border-radius: 4px;
      font-size: 12px;
      color: var(--text-secondary);
      display: flex;
      align-items: center;
      gap: 6px;
    `;
    const syncLabel = document.createElement('span');
    syncLabel.textContent = 'Sync:';
    syncNote.appendChild(syncLabel);
    const syncLink = document.createElement('a');
    syncLink.textContent = 'configure in Sync section';
    syncLink.href = '#';
    syncLink.style.cssText = 'color: var(--accent-primary); cursor: pointer; text-decoration: none;';
    syncLink.addEventListener('click', (e) => {
      e.preventDefault();
      showSection('sync');
    });
    syncNote.appendChild(syncLink);

    card.appendChild(syncNote);
    profilesList.appendChild(card);
  }

  listSection.appendChild(profilesList);
  container.appendChild(listSection);

  return container;
};

// Show add profile dialog
const showAddProfileDialog = async (parentContainer) => {
  const dialog = document.createElement('div');
  dialog.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
  `;

  const content = document.createElement('div');
  content.style.cssText = `
    background: var(--bg-primary);
    padding: 24px;
    border-radius: 8px;
    width: 400px;
    max-width: 90%;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  `;

  const title = document.createElement('h3');
  title.textContent = 'Add Profile';
  title.style.cssText = 'margin: 0 0 16px 0;';
  content.appendChild(title);

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Profile name (e.g., Work, Personal)';
  input.style.cssText = `
    width: 100%;
    padding: 8px;
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: 14px;
    margin-bottom: 16px;
  `;
  content.appendChild(input);

  const buttons = document.createElement('div');
  buttons.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end;';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = `
    padding: 8px 16px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    color: var(--text-secondary);
    font-size: 13px;
    cursor: pointer;
  `;
  cancelBtn.addEventListener('click', () => dialog.remove());
  buttons.appendChild(cancelBtn);

  const createBtn = document.createElement('button');
  createBtn.textContent = 'Create';
  createBtn.style.cssText = `
    padding: 8px 16px;
    background: var(--accent-primary);
    border: none;
    border-radius: 4px;
    color: white;
    font-size: 13px;
    cursor: pointer;
  `;
  createBtn.addEventListener('click', async () => {
    const name = input.value.trim();
    if (!name) {
      alert('Please enter a profile name');
      return;
    }

    const result = await api.profiles.create(name);
    if (result.success) {
      dialog.remove();
      // Refresh the profiles section
      const newContent = await renderProfilesSettings();
      parentContainer.replaceWith(newContent);
    } else {
      alert(`Failed to create profile: ${result.error}`);
    }
  });
  buttons.appendChild(createBtn);

  content.appendChild(buttons);
  dialog.appendChild(content);
  document.body.appendChild(dialog);

  input.focus();
};

// Render datastore settings (inline pane instead of separate window)
const renderDatastoreSettings = async () => {
  const container = document.createElement('div');

  // Overview stats
  const statsSection = document.createElement('div');
  statsSection.className = 'form-section';

  const statsTitle = document.createElement('h3');
  statsTitle.className = 'form-section-title';
  statsTitle.textContent = 'Overview';
  statsSection.appendChild(statsTitle);

  const statsGrid = document.createElement('div');
  statsGrid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 16px; margin-bottom: 16px;';

  // Load stats
  let stats = {};
  try {
    const result = await api.datastore.getStats();
    if (result && result.success && result.data) {
      stats = result.data;
    }
  } catch (e) {
    console.error('[settings] Error getting datastore stats:', e);
  }

  const statItems = [
    { label: 'Items', value: stats.totalItems || 0 },
    { label: 'URLs', value: stats.totalAddresses || 0 },
    { label: 'Visits', value: stats.totalVisits || 0 },
    { label: 'Tags', value: stats.totalTags || 0 },
    { label: 'Content', value: stats.totalContent || 0 },
    { label: 'Synced', value: stats.syncedItems || 0 },
  ];

  statItems.forEach(({ label, value }) => {
    const stat = document.createElement('div');
    stat.style.cssText = 'text-align: center; padding: 16px; background: var(--bg-tertiary); border-radius: 6px;';
    stat.innerHTML = `
      <div style="font-size: 24px; font-weight: 600; color: var(--text-primary);">${value}</div>
      <div style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">${label}</div>
    `;
    statsGrid.appendChild(stat);
  });

  statsSection.appendChild(statsGrid);
  container.appendChild(statsSection);

  // Table browser
  const tableGroups = [
    { label: 'Core Data', tables: ['items', 'tags', 'content', 'blobs'] },
    { label: 'Relationships', tables: ['item_tags', 'item_visits', 'item_events', 'item_groups', 'item_group_members'] },
    { label: 'Features', tables: ['feature_settings', 'scripts_data', 'feeds'] },
    { label: 'System', tables: ['settings', 'migrations', 'themes'] },
  ];

  const tableDescriptions = {
    items: 'All stored items (URLs, text, tagsets, images, series, feeds)',
    tags: 'Tag definitions with frecency scores',
    item_tags: 'Item-to-tag associations',
    item_visits: 'Page visit history',
    item_events: 'Time-series events for series and feed items',
    item_groups: 'Item group/collection definitions',
    item_group_members: 'Group membership associations',
    content: 'Cached page content (legacy)',
    blobs: 'Binary data storage',
    scripts_data: 'Script feature data',
    feeds: 'Feed subscription data',
    feature_settings: 'Per-feature settings and preferences',
    settings: 'Global application settings',
    migrations: 'Schema migration history',
    themes: 'Installed color themes',
  };

  const tableSection = document.createElement('div');
  tableSection.className = 'form-section';
  tableSection.style.marginTop = '24px';

  const tableTitle = document.createElement('h3');
  tableTitle.className = 'form-section-title';
  tableTitle.textContent = 'Tables';
  tableSection.appendChild(tableTitle);

  const tableList = document.createElement('div');
  tableList.style.cssText = 'display: flex; flex-direction: column; gap: 12px; margin-bottom: 16px;';

  const tableDataContainer = document.createElement('div');
  tableDataContainer.style.cssText = 'margin-top: 16px; max-height: 400px; overflow: auto; border: 1px solid var(--border-primary); border-radius: 6px;';

  // Helper: format timestamp if value looks like ms epoch
  const formatTimestamp = (value) => {
    if (typeof value === 'number' && value > 1000000000000) {
      try {
        const date = new Date(value);
        return `${String(value)} (${date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')})`;
      } catch (e) { /* ignore */ }
    }
    return null;
  };

  // Load counts for all tables upfront
  const tableCounts = {};
  const allTables = tableGroups.flatMap(g => g.tables);
  await Promise.all(allTables.map(async (tableName) => {
    try {
      const result = await api.datastore.getTable(tableName);
      if (result && result.success && result.data) {
        tableCounts[tableName] = Object.keys(result.data).length;
      } else {
        tableCounts[tableName] = 0;
      }
    } catch (e) {
      tableCounts[tableName] = 0;
    }
  }));

  // Build grouped table buttons
  for (const group of tableGroups) {
    const groupContainer = document.createElement('div');

    const groupLabel = document.createElement('div');
    groupLabel.style.cssText = 'font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px;';
    groupLabel.textContent = group.label;
    groupContainer.appendChild(groupLabel);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display: flex; flex-wrap: wrap; gap: 6px;';

    for (const tableName of group.tables) {
      const count = tableCounts[tableName] || 0;
      const btn = document.createElement('button');
      btn.style.cssText = `
        padding: 6px 12px;
        font-size: 12px;
        background: var(--bg-tertiary);
        border: 1px solid var(--border-primary);
        border-radius: 4px;
        color: var(--text-secondary);
        cursor: pointer;
      `;
      btn.textContent = `${tableName} (${count.toLocaleString()})`;
      btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--bg-hover)'; });
      btn.addEventListener('mouseleave', () => { if (!btn.classList.contains('active-table')) btn.style.background = 'var(--bg-tertiary)'; });

      btn.addEventListener('click', async () => {
        // Update active state across all groups
        tableList.querySelectorAll('button').forEach(b => {
          b.classList.remove('active-table');
          b.style.background = 'var(--bg-tertiary)';
          b.style.borderColor = 'var(--border-primary)';
          b.style.color = 'var(--text-secondary)';
        });
        btn.classList.add('active-table');
        btn.style.background = 'var(--base0D)';
        btn.style.borderColor = 'var(--base0D)';
        btn.style.color = 'white';

        // Load table data
        tableDataContainer.innerHTML = '<div style="padding: 16px; color: var(--text-muted);">Loading...</div>';
        try {
          const result = await api.datastore.getTable(tableName);
          if (result && result.success && result.data) {
            const rows = Object.entries(result.data);

            // Table description header
            const desc = tableDescriptions[tableName] || '';
            let html = '';
            if (desc) {
              html += `<div style="padding: 10px 12px; font-size: 12px; color: var(--text-muted); background: var(--bg-secondary); border-bottom: 1px solid var(--border-primary);">${desc}</div>`;
            }

            if (rows.length === 0) {
              html += '<div style="padding: 16px; color: var(--text-muted);">Table is empty.</div>';
              tableDataContainer.innerHTML = html;
              return;
            }

            const columns = ['id', ...Object.keys(rows[0][1]).filter(c => c !== 'id')];
            html += '<table style="width: 100%; border-collapse: collapse; font-size: 12px;">';
            html += '<thead><tr>';
            columns.forEach(col => {
              html += `<th style="text-align: left; padding: 8px 10px; background: var(--bg-secondary); border-bottom: 1px solid var(--border-primary); font-weight: 600; color: var(--text-primary); position: sticky; top: 0;">${col}</th>`;
            });
            html += '</tr></thead><tbody>';

            rows.slice(0, 100).forEach(([id, row]) => {
              html += '<tr>';
              columns.forEach(col => {
                const value = col === 'id' ? id : row[col];
                let display = value === null || value === undefined ? '-' : String(value);
                const tsFormatted = formatTimestamp(typeof value === 'string' ? Number(value) : value);
                if (tsFormatted) display = tsFormatted;
                if (display.length > 120) display = display.substring(0, 120) + '...';
                const escaped = display.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                html += `<td style="padding: 6px 10px; border-bottom: 1px solid var(--border-light, var(--border-primary)); color: var(--text-secondary); max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escaped}">${escaped}</td>`;
              });
              html += '</tr>';
            });

            if (rows.length > 100) {
              html += `<tr><td colspan="${columns.length}" style="padding: 8px 10px; color: var(--text-muted); text-align: center;">Showing first 100 of ${rows.length} rows</td></tr>`;
            }

            html += '</tbody></table>';
            tableDataContainer.innerHTML = html;
          } else {
            tableDataContainer.innerHTML = '<div style="padding: 16px; color: var(--text-muted);">Failed to load table data.</div>';
          }
        } catch (e) {
          tableDataContainer.innerHTML = `<div style="padding: 16px; color: var(--error-text, #dc2626);">Error: ${e.message}</div>`;
        }
      });

      btnRow.appendChild(btn);
    }

    groupContainer.appendChild(btnRow);
    tableList.appendChild(groupContainer);
  }

  tableSection.appendChild(tableList);
  tableSection.appendChild(tableDataContainer);
  container.appendChild(tableSection);

  // Refresh button
  const refreshSection = document.createElement('div');
  refreshSection.className = 'form-section';
  refreshSection.style.marginTop = '24px';

  const refreshBtn = document.createElement('button');
  refreshBtn.textContent = 'Refresh All';
  refreshBtn.style.cssText = `
    padding: 8px 16px;
    font-size: 13px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-primary);
    border-radius: 6px;
    color: var(--text-primary);
    cursor: pointer;
  `;
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.textContent = 'Refreshing...';
    refreshBtn.disabled = true;
    // Re-render the entire section
    const newContent = await renderDatastoreSettings();
    container.replaceWith(newContent);
  });
  refreshSection.appendChild(refreshBtn);
  container.appendChild(refreshSection);

  return container;
};

// Render diagnostics settings (inline pane instead of separate window)
const renderDiagnosticsSettings = async () => {
  const container = document.createElement('div');

  const desc = document.createElement('p');
  desc.className = 'help-text';
  desc.style.marginBottom = '16px';
  desc.textContent = 'Inspect localStorage and datastore contents for debugging.';
  container.appendChild(desc);

  // Button row
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px;';

  const outputArea = document.createElement('pre');
  outputArea.style.cssText = 'background: var(--bg-tertiary); padding: 16px; border-radius: 6px; overflow: auto; max-height: 500px; font-size: 12px; font-family: monospace; color: var(--text-secondary); white-space: pre-wrap; word-break: break-all;';
  outputArea.textContent = 'Click a button above to inspect data.';

  const makeBtn = (text, fn) => {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.style.cssText = `
      padding: 8px 16px;
      font-size: 13px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-primary);
      border-radius: 6px;
      color: var(--text-primary);
      cursor: pointer;
    `;
    btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--bg-hover)'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'var(--bg-tertiary)'; });
    btn.addEventListener('click', fn);
    return btn;
  };

  // Dump localStorage
  btnRow.appendChild(makeBtn('Dump localStorage', () => {
    const items = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const value = localStorage.getItem(key);
      items.push({ key, value });
    }
    items.sort((a, b) => a.key.localeCompare(b.key));

    let text = `localStorage: ${items.length} items\n\n`;
    items.forEach(item => {
      let displayValue = item.value;
      try {
        const parsed = JSON.parse(item.value);
        displayValue = JSON.stringify(parsed, null, 2);
      } catch {}
      text += `${item.key}:\n  ${displayValue}\n\n`;
    });
    outputArea.textContent = text;
  }));

  // Dump feature_settings
  btnRow.appendChild(makeBtn('Dump feature_settings', async () => {
    try {
      const result = await api.datastore.getTable('feature_settings');
      if (result.success) {
        const data = result.data || {};
        const entries = Object.entries(data);
        let text = `feature_settings: ${entries.length} rows\n\n`;
        entries.forEach(([rowId, row]) => {
          let displayValue = row.value;
          try {
            displayValue = JSON.stringify(JSON.parse(row.value), null, 2);
          } catch {}
          text += `${rowId} (${row.featureId}:${row.key}):\n  ${displayValue}\n\n`;
        });
        outputArea.textContent = text;
      } else {
        outputArea.textContent = `Error: ${result.error}`;
      }
    } catch (err) {
      outputArea.textContent = `Error: ${err.message}`;
    }
  }));

  // Copy results
  btnRow.appendChild(makeBtn('Copy Results', () => {
    navigator.clipboard.writeText(outputArea.textContent).then(() => {
      const origText = outputArea.textContent;
      outputArea.textContent = 'Copied to clipboard!';
      setTimeout(() => { outputArea.textContent = origText; }, 1000);
    });
  }));

  container.appendChild(btnRow);

  // Backup tools section
  const backupSection = document.createElement('div');
  backupSection.className = 'form-section';
  backupSection.style.marginTop = '24px';

  const backupTitle = document.createElement('h3');
  backupTitle.className = 'form-section-title';
  backupTitle.textContent = 'Backup Tools';
  backupSection.appendChild(backupTitle);

  const backupDesc = document.createElement('p');
  backupDesc.className = 'help-text';
  backupDesc.style.marginBottom = '12px';
  backupDesc.textContent = 'Create and manage database backups.';
  backupSection.appendChild(backupDesc);

  const backupBtnRow = document.createElement('div');
  backupBtnRow.style.cssText = 'display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px;';

  const backupOutput = document.createElement('div');
  backupOutput.style.cssText = 'padding: 12px; background: var(--bg-tertiary); border-radius: 6px; font-size: 12px; font-family: monospace; color: var(--text-secondary); white-space: pre-wrap;';
  backupOutput.textContent = '';

  backupBtnRow.appendChild(makeBtn('Backup Now', async () => {
    backupOutput.textContent = 'Creating backup...';
    try {
      const result = await api.backup.create();
      backupOutput.textContent = result.success
        ? `Backup created:\n${result.path}`
        : `Failed: ${result.error}`;
    } catch (err) {
      backupOutput.textContent = `Error: ${err.message}`;
    }
  }));

  backupBtnRow.appendChild(makeBtn('List Backups', async () => {
    backupOutput.textContent = 'Loading...';
    try {
      const result = await api.backup.list();
      if (result.success) {
        const { backups, backupDir } = result.data;
        if (!backupDir) {
          backupOutput.textContent = 'Backup directory not configured.\nSet it in Core settings.';
          return;
        }
        if (backups.length === 0) {
          backupOutput.textContent = `No backups found in:\n${backupDir}`;
          return;
        }
        let text = `Backup directory: ${backupDir}\n${backups.length} backup(s):\n\n`;
        backups.forEach((b, i) => {
          const size = b.size > 1024 * 1024 ? `${(b.size / (1024 * 1024)).toFixed(2)} MB` : `${(b.size / 1024).toFixed(1)} KB`;
          text += `${i + 1}. ${b.name}  (${size}, ${new Date(b.date).toLocaleString()})\n`;
        });
        backupOutput.textContent = text;
      } else {
        backupOutput.textContent = `Failed: ${result.error}`;
      }
    } catch (err) {
      backupOutput.textContent = `Error: ${err.message}`;
    }
  }));

  backupBtnRow.appendChild(makeBtn('Open Backup Folder', async () => {
    try {
      const configResult = await api.backup.getConfig();
      if (!configResult.success) {
        backupOutput.textContent = `Error: ${configResult.error}`;
        return;
      }
      const backupDir = configResult.data.backupDir;
      if (!backupDir) {
        backupOutput.textContent = 'Backup directory not configured.\nSet it in Core settings.';
        return;
      }
      await api.shell.openPath(backupDir);
      backupOutput.textContent = `Opened: ${backupDir}`;
    } catch (err) {
      backupOutput.textContent = `Error: ${err.message}`;
    }
  }));

  backupSection.appendChild(backupBtnRow);
  backupSection.appendChild(backupOutput);
  container.appendChild(backupSection);

  container.appendChild(outputArea);

  return container;
};

// Initialize
const init = async () => {
  // Initialize the tile-preload surface before any API calls. Without this,
  // `tokenValid` is false and api.datastore / api.theme / api.subscribe all
  // silently no-op or reject — createDatastoreStore returns empty, theme
  // CSS is never injected, and --theme-font-sans is absent.
  if (api.initialize) {
    await api.initialize();
  }

  const sidebarNav = document.getElementById('sidebarNav');
  const contentArea = document.getElementById('settingsContent');

  // Pre-load core store for isFeatureEnabled checks
  _coreStore = await createDatastoreStore('core', appConfig.defaults);

  // Add Core section
  const coreNav = document.createElement('a');
  coreNav.className = 'nav-item active';
  coreNav.textContent = 'Core';
  coreNav.dataset.section = 'core';
  coreNav.addEventListener('click', () => showSection('core'));
  sidebarNav.appendChild(coreNav);

  const coreSection = await createSection('core', '', renderCoreSettings);
  coreSection.classList.add('active');
  contentArea.appendChild(coreSection);

  // Listen for feature toggle events (refresh Features list when toggled)
  api.subscribe('core:feature:toggle', () => {
    if (window._refreshFeaturesList) {
      window._refreshFeaturesList();
    }
  });

  // Add Features management section (tile-backed features: peeks, slides, groups, etc.).
  const featuresNav = document.createElement('a');
  featuresNav.className = 'nav-item';
  featuresNav.textContent = 'Features';
  featuresNav.dataset.section = 'features';
  featuresNav.addEventListener('click', () => showSection('features'));
  sidebarNav.appendChild(featuresNav);

  // Create features section with async content.
  const featuresSection = document.createElement('div');
  featuresSection.className = 'section';
  featuresSection.id = 'section-features';

  const featuresTitle = document.createElement('h2');
  featuresTitle.className = 'section-title';
  featuresTitle.textContent = 'Features';
  featuresSection.appendChild(featuresTitle);

  // Load features content async.
  renderFeaturesSettings().then(content => {
    featuresSection.appendChild(content);
  });

  contentArea.appendChild(featuresSection);

  // Feature settings schemas are loaded inline in the Features pane (via Options accordion).
  // No separate nav items or panes needed.

  // Listen for feature:all-loaded to refresh the Features list.
  // NOTE: Only ONE feature:all-loaded subscription per source — pubsub overwrites duplicates.
  api.subscribe('feature:all-loaded', () => {
    if (window._refreshFeaturesList) {
      window._refreshFeaturesList();
    }
  });

  // Add Extensions section (bundled chrome browser extensions: ad blocker, consent-o-matic, etc.)
  const privacyNav = document.createElement('a');
  privacyNav.className = 'nav-item';
  privacyNav.textContent = 'Extensions';
  privacyNav.dataset.section = 'privacy';
  privacyNav.addEventListener('click', () => showSection('privacy'));
  sidebarNav.appendChild(privacyNav);

  // Create extensions (webextensions) section with async content
  const privacySection = document.createElement('div');
  privacySection.className = 'section';
  privacySection.id = 'section-privacy';

  const privacyTitle = document.createElement('h2');
  privacyTitle.className = 'section-title';
  privacyTitle.textContent = 'Extensions';
  privacySection.appendChild(privacyTitle);

  // Load extensions content async
  renderPrivacySettings().then(content => {
    privacySection.appendChild(content);
  });

  contentArea.appendChild(privacySection);

  // Add Dark Mode section (between Privacy and Sync)
  const darkModeNav = document.createElement('a');
  darkModeNav.className = 'nav-item';
  darkModeNav.textContent = 'Dark Mode';
  darkModeNav.dataset.section = 'dark-mode';
  darkModeNav.addEventListener('click', () => showSection('dark-mode'));
  sidebarNav.appendChild(darkModeNav);

  // Create dark mode section with async content
  const darkModeSection = document.createElement('div');
  darkModeSection.className = 'section';
  darkModeSection.id = 'section-dark-mode';

  const darkModeTitle = document.createElement('h2');
  darkModeTitle.className = 'section-title';
  darkModeTitle.textContent = 'Dark Mode';
  darkModeSection.appendChild(darkModeTitle);

  // Load dark mode content async
  renderDarkModeSettings().then(content => {
    darkModeSection.appendChild(content);
  });

  contentArea.appendChild(darkModeSection);

  // Add Sync management section (between Dark Mode and Themes)
  const syncNav = document.createElement('a');
  syncNav.className = 'nav-item';
  syncNav.textContent = 'Sync';
  syncNav.dataset.section = 'sync';
  syncNav.addEventListener('click', () => showSection('sync'));
  sidebarNav.appendChild(syncNav);

  // Create sync section with async content
  const syncSection = document.createElement('div');
  syncSection.className = 'section';
  syncSection.id = 'section-sync';

  const syncTitle = document.createElement('h2');
  syncTitle.className = 'section-title';
  syncTitle.textContent = 'Sync';
  syncSection.appendChild(syncTitle);

  // Load sync content async
  renderSyncSettings().then(content => {
    syncSection.appendChild(content);
  });

  contentArea.appendChild(syncSection);

  // Add Profiles management section
  const profilesNav = document.createElement('a');
  profilesNav.className = 'nav-item';
  profilesNav.textContent = 'Profiles';
  profilesNav.dataset.section = 'profiles';
  profilesNav.addEventListener('click', () => showSection('profiles'));
  sidebarNav.appendChild(profilesNav);

  // Create profiles section with async content
  const profilesSection = document.createElement('div');
  profilesSection.className = 'section';
  profilesSection.id = 'section-profiles';

  const profilesTitle = document.createElement('h2');
  profilesTitle.className = 'section-title';
  profilesTitle.textContent = 'Profiles';
  profilesSection.appendChild(profilesTitle);

  // Load profiles content async
  renderProfilesSettings().then(content => {
    profilesSection.appendChild(content);
  });

  contentArea.appendChild(profilesSection);

  // Add Themes management section
  const themesNav = document.createElement('a');
  themesNav.className = 'nav-item';
  themesNav.textContent = 'Themes';
  themesNav.dataset.section = 'themes';
  themesNav.addEventListener('click', () => showSection('themes'));
  sidebarNav.appendChild(themesNav);

  // Create themes section with async content
  const themesSection = document.createElement('div');
  themesSection.className = 'section';
  themesSection.id = 'section-themes';

  const themesTitle = document.createElement('h2');
  themesTitle.className = 'section-title';
  themesTitle.textContent = 'Themes';
  themesSection.appendChild(themesTitle);

  // Load themes content async
  renderThemesSettings().then(content => {
    themesSection.appendChild(content);
  });

  contentArea.appendChild(themesSection);

  // Add Datastore section (inline pane)
  const datastoreNav = document.createElement('a');
  datastoreNav.className = 'nav-item';
  datastoreNav.textContent = 'Datastore';
  datastoreNav.dataset.section = 'datastore';
  datastoreNav.addEventListener('click', () => showSection('datastore'));
  sidebarNav.appendChild(datastoreNav);

  const datastoreSection = document.createElement('div');
  datastoreSection.className = 'section';
  datastoreSection.id = 'section-datastore';

  const datastoreSectionTitle = document.createElement('h2');
  datastoreSectionTitle.className = 'section-title';
  datastoreSectionTitle.textContent = 'Datastore';
  datastoreSection.appendChild(datastoreSectionTitle);

  renderDatastoreSettings().then(content => {
    datastoreSection.appendChild(content);
  });

  contentArea.appendChild(datastoreSection);

  // Add Diagnostics section (inline pane)
  const diagnosticNav = document.createElement('a');
  diagnosticNav.className = 'nav-item';
  diagnosticNav.textContent = 'Diagnostics';
  diagnosticNav.dataset.section = 'diagnostics';
  diagnosticNav.addEventListener('click', () => showSection('diagnostics'));
  sidebarNav.appendChild(diagnosticNav);

  const diagnosticsSection = document.createElement('div');
  diagnosticsSection.className = 'section';
  diagnosticsSection.id = 'section-diagnostics';

  const diagnosticsSectionTitle = document.createElement('h2');
  diagnosticsSectionTitle.className = 'section-title';
  diagnosticsSectionTitle.textContent = 'Diagnostics';
  diagnosticsSection.appendChild(diagnosticsSectionTitle);

  renderDiagnosticsSettings().then(content => {
    diagnosticsSection.appendChild(content);
  });

  contentArea.appendChild(diagnosticsSection);

  // Add Quit button at the very bottom
  const quitBtn = document.createElement('button');
  quitBtn.textContent = 'Quit';
  quitBtn.style.cssText = `
    margin: auto 20px 20px 20px;
    padding: 8px 16px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    color: var(--text-secondary);
    font-size: 13px;
    cursor: pointer;
    width: calc(100% - 40px);
  `;
  quitBtn.addEventListener('mouseenter', () => {
    quitBtn.style.background = 'var(--bg-hover)';
  });
  quitBtn.addEventListener('mouseleave', () => {
    quitBtn.style.background = 'var(--bg-tertiary)';
  });
  quitBtn.addEventListener('click', () => {
    api.quit();
  });
  sidebarNav.appendChild(quitBtn);

  // Restore pane from URL hash (persisted by showSection for session restore)
  const hashSection = location.hash ? location.hash.slice(1) : '';
  if (hashSection && document.getElementById(`section-${hashSection}`)) {
    showSection(hashSection);
  }
};

window.addEventListener('load', init);

// No IZUI init needed — backend handles focus restoration and ESC policy via roles.

// Listen for navigation requests from commands. Wrap in an async IIFE so
// `api.initialize()` completes before `api.subscribe` runs — otherwise the
// subscribe silently no-ops when `tokenValid=false`.
(async () => {
  if (api.initialize) {
    await api.initialize();
  }
  api.subscribe('settings:navigate', (msg) => {
    if (msg.section) {
      showSection(msg.section);
    }
  });
})();

// Expose showSection for external navigation
window.showSettingsSection = showSection;
