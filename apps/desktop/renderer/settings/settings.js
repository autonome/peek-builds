import appConfig from '../config.js';
import { defaults as cmdConfigDefaults } from '../cmd/config.js';
import { createDatastoreStore } from '../utils.js';
import api from '../api.js';
const DEBUG = api.debug;
const clear = false;

// Helper: Create text/number input
//
// `options.default` (any type, optional) is used both at render time
// (when the supplied `value` is null/undefined/NaN) and on change (if
// the user clears a number input — `parseFloat('')` is NaN — the
// field snaps back to default rather than persisting NaN to settings).
// Without this, clearing a number field used to silently save NaN,
// which then displayed as a blank input on next load.
const createInput = (label, value, onChange, options = {}) => {
  const group = document.createElement('div');
  group.className = 'form-group';

  const labelEl = document.createElement('label');
  labelEl.textContent = label;

  const input = document.createElement('peek-input');
  input.type = options.type || 'text';
  const isMissing = (v) => v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v));
  const renderValue = isMissing(value) && options.default !== undefined ? options.default : value;
  input.value = (renderValue === null || renderValue === undefined) ? '' : String(renderValue);
  input.disabled = options.disabled || false;
  if (options.placeholder) input.placeholder = options.placeholder;

  // <peek-input> has no min/max/step, so number bounds are enforced here.
  input.addEventListener('change', () => {
    let val = options.type === 'number' ? parseFloat(input.value) : input.value;
    if (options.type === 'number') {
      if (Number.isNaN(val) && options.default !== undefined) val = options.default;
      if (!Number.isNaN(val)) {
        if (options.min !== undefined) val = Math.max(options.min, val);
        if (options.max !== undefined) val = Math.min(options.max, val);
      }
      input.value = Number.isNaN(val) ? '' : String(val);
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
};

// Helper: run one async action behind a button, showing `busyLabel` on it and
// keeping it disabled until the action settles — so a slow server round trip
// can't be double-clicked into two requests, and the label always comes back
// even when the action throws. Errors propagate to the caller, which decides
// where to show them. Works for a plain <button> and a <peek-button> alike
// (both expose `disabled` and `textContent`).
const runWithBusyButton = async (btn, busyLabel, action) => {
  const idleLabel = btn.textContent;
  btn.textContent = busyLabel;
  btn.disabled = true;
  try {
    return await action();
  } finally {
    btn.textContent = idleLabel;
    btn.disabled = false;
  }
};

// Helper: Create checkbox
const createCheckbox = (label, value, onChange, options = {}) => {
  const group = document.createElement('div');
  group.className = 'form-group-inline';

  const labelEl = document.createElement('label');
  labelEl.textContent = label;

  const wrapper = document.createElement('div');
  wrapper.className = 'checkbox-wrapper';

  const input = document.createElement('peek-switch');
  input.checked = value || false;
  input.disabled = options.disabled || false;
  input.setAttribute('aria-label', label);

  input.addEventListener('change', (e) => {
    onChange(e.detail.checked);
  });

  // The switch carries no label of its own here (the text sits beside it),
  // so clicking the text toggles it.
  labelEl.addEventListener('click', () => input.toggle());

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

  const select = document.createElement('peek-select');
  select.disabled = extraOptions.disabled || false;
  select.options = options.map(opt => ({ value: opt.value, label: opt.label }));
  select.value = value;

  select.addEventListener('change', (e) => {
    onChange(e.detail.value);
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

  const input = document.createElement('peek-input');
  input.type = 'text';
  input.value = value || '';
  if (options.placeholder) input.placeholder = options.placeholder;

  input.addEventListener('change', () => {
    onChange(input.value);
  });

  const browseBtn = document.createElement('peek-button');
  browseBtn.className = 'browse-btn';
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
  const getVal = (k) => {
    if (prefs && prefs.hasOwnProperty(k)) {
      const v = prefs[k];
      // Stored null/undefined/NaN means "no real preference set" —
      // fall through to the schema default. Without this, a corrupt
      // / cleared / never-validated stored value displays as empty
      // forever.
      if (v !== null && v !== undefined && !(typeof v === 'number' && Number.isNaN(v))) return v;
    }
    return pProps[k]?.default;
  };
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
  defaultBrowserRow.className = 'default-browser-row';

  const defaultBrowserBtn = document.createElement('peek-button');
  defaultBrowserBtn.setAttribute('variant', 'secondary');
  defaultBrowserBtn.textContent = 'Set as default handler for HTTP addresses and HTML documents';

  const defaultBrowserStatus = document.createElement('span');
  defaultBrowserStatus.className = 'default-browser-status';

  // Check current status
  (async () => {
    try {
      const result = await api.app.getDefaultBrowserStatus();
      if (result.isDefault) {
        defaultBrowserBtn.textContent = 'Already the default handler';
        defaultBrowserBtn.disabled = true;
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
    default: pProps.sessionAutosaveInterval.default,
    helpText: pProps.sessionAutosaveInterval.description
  }));

  container.appendChild(dataGroup);

  // --- Group: Memory (idle feature unloading) ---
  const memoryGroup = createSettingsGroup('Memory');

  memoryGroup.appendChild(createCheckbox(getLabel('tileSuspensionEnabled'), getVal('tileSuspensionEnabled'), (newVal) => {
    prefs.tileSuspensionEnabled = newVal;
    save();
  }, {
    helpText: pProps.tileSuspensionEnabled.description
  }));

  memoryGroup.appendChild(createInput(getLabel('tileSuspensionIdleMinutes'), getVal('tileSuspensionIdleMinutes'), (newVal) => {
    prefs.tileSuspensionIdleMinutes = newVal;
    save();
  }, {
    type: 'number',
    step: 1,
    min: 1,
    default: pProps.tileSuspensionIdleMinutes.default,
    helpText: pProps.tileSuspensionIdleMinutes.description
  }));

  container.appendChild(memoryGroup);

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
    default: pProps.defaultWindowWidth.default,
    helpText: pProps.defaultWindowWidth.description
  }));

  windowsGroup.appendChild(createInput(getLabel('defaultWindowHeight'), getVal('defaultWindowHeight'), (newVal) => {
    prefs.defaultWindowHeight = newVal;
    save();
  }, {
    type: 'number',
    step: 1,
    min: 200,
    default: pProps.defaultWindowHeight.default,
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
    default: pProps.dragHoldDelay.default,
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

  // Cmd panel shortcut. Cmd was consolidated into the core background
  // renderer but its prefs still persist to feature_settings row 'cmd_prefs'
  // (see app/cmd/background.js CMD_PREFS_ROW_ID). Read/write that row
  // directly and publish cmd:settings-changed so the cmd module reinits.
  const CMD_PREFS_ROW_ID = 'cmd_prefs';
  // Default is platform-aware (CommandOrControl+Space on Linux, Option+Space
  // elsewhere) — see app/cmd/config.js for the rationale.
  let cmdPrefs = { ...cmdConfigDefaults.prefs };
  try {
    const r = await api.datastore.getRow('feature_settings', CMD_PREFS_ROW_ID);
    if (r?.success && r.data?.value) {
      cmdPrefs = { ...cmdConfigDefaults.prefs, ...JSON.parse(r.data.value) };
    }
  } catch { /* fall back to defaults */ }

  shortcutsGroup.appendChild(createInput('Cmd shortcut', cmdPrefs.shortcutKey, async (newVal) => {
    cmdPrefs.shortcutKey = newVal;
    await api.datastore.setRow('feature_settings', CMD_PREFS_ROW_ID, {
      featureId: 'cmd',
      key: 'prefs',
      value: JSON.stringify(cmdPrefs),
      updatedAt: Date.now(),
    });
    api.publish('cmd:settings-changed', {});
  }, {
    helpText: 'Global OS hotkey to open the command panel',
    placeholder: cmdConfigDefaults.prefs.shortcutKey
  }));

  shortcutsGroup.appendChild(createCheckbox(
    'Show visited URLs in results',
    cmdPrefs.showUrlsInResults ?? cmdConfigDefaults.prefs.showUrlsInResults,
    async (newVal) => {
      cmdPrefs.showUrlsInResults = newVal;
      await api.datastore.setRow('feature_settings', CMD_PREFS_ROW_ID, {
        featureId: 'cmd',
        key: 'prefs',
        value: JSON.stringify(cmdPrefs),
        updatedAt: Date.now(),
      });
      api.publish('cmd:settings-changed', {});
    },
    { helpText: 'Suggest frequently/recently visited URLs inline as you type, ranked by frecency' }
  ));

  // CLI dispatch socket toggle (Linux only). The pref itself is platform-
  // agnostic — backed by core prefs.cliSocketEnabled — but the UI control
  // is only shown on Linux, where the socket is the answer for Wayland's
  // lack of global hotkeys. macOS / Windows have working OS-level global
  // hotkey APIs so we hide the toggle to keep the prefs surface minimal.
  // The daemon still honors whatever value is persisted; non-Linux users
  // who need the socket can flip it via direct datastore edit. See
  // cli-socket.ts and docs/global-hotkeys-on-wayland.md.
  let cliVerbBlock = null;
  const updateVerbBlockEnabled = (enabled) => {
    if (!cliVerbBlock) return;
    cliVerbBlock.classList.toggle('disabled', !enabled);
  };

  if (api.platform?.os === 'linux') {
    shortcutsGroup.appendChild(createCheckbox(
      getLabel('cliSocketEnabled'),
      getVal('cliSocketEnabled'),
      (newVal) => {
        prefs.cliSocketEnabled = newVal;
        updateVerbBlockEnabled(newVal);
        save();
      },
      { helpText: pProps.cliSocketEnabled.description }
    ));
  }

  // On Wayland, list the verbs prominently as the user-facing answer
  // for global hotkeys. On other platforms the socket is mostly for
  // scripting and we don't surface it here.
  if (api.platform?.isWayland) {
    const block = document.createElement('div');
    block.className = 'cli-verb-block';
    cliVerbBlock = block;
    updateVerbBlockEnabled(getVal('cliSocketEnabled'));

    const intro = document.createElement('div');
    intro.className = 'cli-verb-intro';
    intro.textContent = 'Wayland blocks apps from grabbing global hotkeys directly. Bind these commands in GNOME Settings → Keyboard → Custom Shortcuts (or your desktop’s equivalent):';
    block.appendChild(intro);

    // Each entry's `args` is the verb-arg list as it appears in the
    // command (placeholder strings users replace by hand for the
    // bind, e.g. <n> → 0).
    const verbs = [
      { verb: 'cmd-open',   args: [],         label: 'Open command panel' },
      { verb: 'peek-open',  args: ['<n>'],    label: 'Open peek N (0–9)' },
      { verb: 'slide-open', args: ['<edge>'], label: 'Open slide on edge (Up|Down|Left|Right)' },
    ];

    // Resolve each command via the daemon so the executor + helper
    // paths are correct for the current packaging (source / asar /
    // AppImage shadow). Returned commands are sh -c '…' wrapped and
    // include ELECTRON_RUN_AS_NODE=1 so users don't need a system Node.
    Promise.all(
      verbs.map(({ verb, args }) => api.app.getCliCommand(verb, args).then(r => r?.data?.command))
    ).then(commands => {
      verbs.forEach(({ verb, label }, i) => {
        const cmdText = commands[i] || `<could not resolve ${verb} command>`;

        const row = document.createElement('div');
        row.className = 'cli-verb-row';

        const code = document.createElement('span');
        code.textContent = cmdText;
        code.className = 'cli-verb-code';
        code.title = label;

        const copy = document.createElement('peek-button');
        copy.setAttribute('variant', 'secondary');
        copy.setAttribute('size', 'sm');
        copy.textContent = 'copy';
        copy.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(cmdText);
            const orig = copy.textContent;
            copy.textContent = 'copied';
            setTimeout(() => { copy.textContent = orig; }, 1200);
          } catch { /* clipboard denied or unavailable */ }
        });

        row.appendChild(code);
        row.appendChild(copy);
        block.appendChild(row);
      });
    });

    shortcutsGroup.appendChild(block);
  }

  container.appendChild(shortcutsGroup);

  return container;
};

// Render Integrations settings — currently houses the MCP server toggle.
// New integrations (other agents, webhooks, etc.) land here as additional
// groups inside this section.
const renderIntegrationsSettings = async () => {
  const container = document.createElement('div');

  const intro = document.createElement('p');
  intro.className = 'help-text';
  intro.classList.add('section-intro');
  intro.textContent = 'Connect Peek to external tools.';
  container.appendChild(intro);

  // --- MCP server ---
  //
  // Writes/removes the `mcpServers.peek` entry in ~/.claude/settings.json.
  // Off by default — checking opts Peek into agents' MCP tool surface.
  // Profile dropdown picks which Peek profile's datastore the snippet
  // points at; "Allow writes" controls whether mutating tools are
  // exposed (defaults to off).
  const mcpGroup = createSettingsGroup('MCP server');

  let mcpState = {
    enabled: false, profile: 'default', readonly: true, scopeTag: '',
    expectedCommand: '', configuredCommand: null, stale: false,
    settingsPath: '~/.claude/settings.json', profiles: [], configuredAt: null,
  };
  try {
    const res = await api.mcp?.getStatus?.();
    if (res?.success) mcpState = res.state;
  } catch { /* fall back to defaults */ }

  let profileSelect = null;
  let scopeTagInput = null;
  let allowWritesInput = null;
  let statusLine = null;

  // Claude Code (and other MCP clients) don't respawn peek-mcp when
  // settings change — only a full client restart picks up new env.
  let restartBanner = null;
  const stateKey = (s) => JSON.stringify({
    enabled: !!s.enabled, profile: s.profile || '',
    readonly: !!s.readonly, scopeTag: s.scopeTag || '',
  });
  let lastAcknowledgedKey = stateKey(mcpState);
  const showRestartBanner = () => {
    if (!restartBanner) return;
    if (stateKey(mcpState) === lastAcknowledgedKey) return;
    restartBanner.classList.add('visible');
  };

  const renderStatus = () => {
    if (!statusLine) return;
    if (!mcpState.enabled) {
      statusLine.textContent = `Not configured. Will write to ${mcpState.settingsPath} when enabled.`;
      return;
    }
    const when = mcpState.configuredAt ? new Date(mcpState.configuredAt).toLocaleString() : 'unknown';
    let text = `Configured at ${mcpState.settingsPath} (last updated ${when}).`;
    if (mcpState.stale) {
      text += ' ⚠ The saved command is from a previous install — toggle off and on to update it.';
    }
    statusLine.textContent = text;
  };

  const syncUI = () => {
    if (profileSelect) {
      profileSelect.disabled = !mcpState.enabled;
      if (profileSelect.value !== mcpState.profile) profileSelect.value = mcpState.profile;
    }
    if (scopeTagInput) {
      scopeTagInput.disabled = !mcpState.enabled;
      if (scopeTagInput.value !== (mcpState.scopeTag || '')) scopeTagInput.value = mcpState.scopeTag || '';
    }
    if (allowWritesInput) {
      allowWritesInput.disabled = !mcpState.enabled;
      allowWritesInput.checked = !mcpState.readonly;
    }
    renderStatus();
  };

  mcpGroup.appendChild(createCheckbox(
    'Expose Peek to Agents (MCP)',
    mcpState.enabled,
    async (newVal) => {
      try {
        const res = await api.mcp?.setConfig?.({ enabled: newVal });
        if (res?.success) mcpState = res.state;
      } catch { /* ignore */ }
      syncUI();
      showRestartBanner();
    },
    { helpText: 'Lets agents query your Peek items and tasks via the Model Context Protocol. Off by default.' },
  ));

  // Profile dropdown
  const profileGroup = document.createElement('div');
  profileGroup.className = 'form-group';
  profileGroup.classList.add('mcp-indent');
  const profileLabel = document.createElement('label');
  profileLabel.textContent = 'Profile to expose';
  profileLabel.className = 'mcp-field-label';
  profileGroup.appendChild(profileLabel);
  profileSelect = document.createElement('peek-select');
  const profileOptions = mcpState.profiles.length ? mcpState.profiles : [mcpState.profile];
  profileSelect.options = profileOptions.map(p => ({ value: p, label: p }));
  profileSelect.value = mcpState.profile;
  profileSelect.addEventListener('change', async (e) => {
    try {
      const res = await api.mcp?.setConfig?.({ profile: e.detail.value });
      if (res?.success) mcpState = res.state;
    } catch { /* ignore */ }
    syncUI();
    showRestartBanner();
  });
  profileGroup.appendChild(profileSelect);
  const profileHelp = document.createElement('p');
  profileHelp.className = 'help-text';
  profileHelp.textContent = 'Which Peek profile\'s datastore the MCP server reads. Defaults to "default" (prod data).';
  profileGroup.appendChild(profileHelp);
  mcpGroup.appendChild(profileGroup);

  // Scope tag input — hard-fence the session to items tagged <scope> or
  // <scope>:*. Empty = no scope (agent sees everything).
  const scopeGroup = document.createElement('div');
  scopeGroup.className = 'form-group';
  scopeGroup.classList.add('mcp-indent');
  const scopeLabel = document.createElement('label');
  scopeLabel.textContent = 'Scope tag (optional)';
  scopeLabel.className = 'mcp-field-label';
  scopeGroup.appendChild(scopeLabel);
  scopeTagInput = document.createElement('peek-input');
  scopeTagInput.type = 'text';
  scopeTagInput.placeholder = 'e.g. peek';
  scopeTagInput.value = mcpState.scopeTag || '';
  scopeTagInput.addEventListener('change', async () => {
    try {
      const res = await api.mcp?.setConfig?.({ scopeTag: (scopeTagInput.value || '').trim() });
      if (res?.success) mcpState = res.state;
    } catch { /* ignore */ }
    syncUI();
    showRestartBanner();
  });
  scopeGroup.appendChild(scopeTagInput);
  const scopeHelp = document.createElement('p');
  scopeHelp.className = 'help-text';
  scopeHelp.textContent = 'Confines this MCP session to items tagged <scope> or <scope>:* — reads filter, writes are auto-tagged, foreign namespaces rejected. Leave blank to expose everything.';
  scopeGroup.appendChild(scopeHelp);
  mcpGroup.appendChild(scopeGroup);

  // "Allow writes" checkbox — OFF by default. Checking opts in to
  // mutating tools. Framed positively so the safe state is the
  // unchecked one and the destructive action requires an explicit add.
  const allowWritesGroup = createCheckbox(
    'Allow writes',
    !mcpState.readonly,
    async (newVal) => {
      try {
        const res = await api.mcp?.setConfig?.({ readonly: !newVal });
        if (res?.success) mcpState = res.state;
      } catch { /* ignore */ }
      syncUI();
      showRestartBanner();
    },
    { helpText: 'Exposes the create / update / delete / tag / complete-task / record-event tools. Off by default — querying always works.' },
  );
  allowWritesGroup.classList.add('mcp-indent');
  allowWritesInput = allowWritesGroup.querySelector('peek-switch');
  mcpGroup.appendChild(allowWritesGroup);

  // Destructive-action warning — red treatment. Always visible so the
  // user reads it before opting in, not only after.
  const readonlyWarning = document.createElement('p');
  readonlyWarning.className = 'mcp-warning';
  readonlyWarning.innerHTML = '<strong>Warning:</strong> enabling writes lets any connected agent create, update, tag, and <strong>permanently delete</strong> your Peek items. Only do this if you trust every agent that will connect.';
  mcpGroup.appendChild(readonlyWarning);

  // Restart-required banner — hidden until first effective change.
  restartBanner = document.createElement('div');
  restartBanner.className = 'mcp-restart-banner';
  const restartText = document.createElement('span');
  restartText.className = 'mcp-restart-text';
  restartText.innerHTML = '<strong>Restart Claude Code to apply.</strong> The change is saved, but any MCP client already running won\'t pick it up until you fully quit and reopen it. Re-approving in <code>/mcp</code> is not enough.';
  restartBanner.appendChild(restartText);
  const restartDismiss = document.createElement('peek-button');
  restartDismiss.variant = 'ghost';
  restartDismiss.size = 'sm';
  restartDismiss.textContent = '×';
  restartDismiss.setAttribute('aria-label', 'Dismiss');
  restartDismiss.addEventListener('click', () => {
    lastAcknowledgedKey = stateKey(mcpState);
    restartBanner.classList.remove('visible');
  });
  restartBanner.appendChild(restartDismiss);
  mcpGroup.appendChild(restartBanner);

  // Status line + Open link
  const statusRow = document.createElement('div');
  statusRow.className = 'mcp-status-row';
  statusLine = document.createElement('span');
  statusRow.appendChild(statusLine);
  const openLink = document.createElement('a');
  openLink.textContent = 'Open';
  openLink.href = '#';
  openLink.className = 'mcp-status-link';
  openLink.addEventListener('click', async (e) => {
    e.preventDefault();
    try { await api.shell?.openPath?.(mcpState.settingsPath); } catch { /* ignore */ }
  });
  statusRow.appendChild(openLink);
  mcpGroup.appendChild(statusRow);

  syncUI();

  // ── Project scopes subsection ─────────────────────────────────────
  // Per-project .mcp.json scaffolder — same job as the peek-mcp-init
  // CLI but from inside the app. Each scoped project pins a Claude
  // Code session in that directory to a specific tag.
  const scopesHeader = document.createElement('h4');
  scopesHeader.textContent = 'Project scopes';
  scopesHeader.className = 'mcp-scopes-header';
  mcpGroup.appendChild(scopesHeader);

  const scopesHelp = document.createElement('p');
  scopesHelp.className = 'help-text mcp-scopes-help';
  scopesHelp.textContent = 'Write a .mcp.json into a project directory so a Claude Code session there only sees items tagged <scope> or <scope>:*. Useful for per-repo task triage.';
  mcpGroup.appendChild(scopesHelp);

  const addScopeBtn = document.createElement('peek-button');
  addScopeBtn.textContent = '+ Add project scope';
  addScopeBtn.className = 'mcp-add-scope-btn';
  mcpGroup.appendChild(addScopeBtn);

  // Inline form (hidden until Add / Edit clicked).
  let formExistingPath = null;
  const form = document.createElement('div');
  form.className = 'mcp-scope-form';

  const pathRow = document.createElement('div');
  pathRow.className = 'mcp-scope-form-row';
  const pathLabel = document.createElement('span');
  pathLabel.className = 'mcp-scope-form-label';
  pathLabel.textContent = 'Directory:';
  pathRow.appendChild(pathLabel);
  const pickBtn = document.createElement('peek-button');
  pickBtn.size = 'sm';
  pickBtn.textContent = 'Pick…';
  pathRow.appendChild(pickBtn);
  const pathDisplay = document.createElement('span');
  pathDisplay.className = 'mcp-scope-path';
  pathDisplay.textContent = '(none selected)';
  pathRow.appendChild(pathDisplay);
  form.appendChild(pathRow);

  const tagRow = document.createElement('div');
  tagRow.className = 'mcp-scope-form-row';
  const tagLabel = document.createElement('span');
  tagLabel.className = 'mcp-scope-form-label';
  tagLabel.textContent = 'Scope tag:';
  tagRow.appendChild(tagLabel);
  const tagInput = document.createElement('peek-input');
  tagInput.type = 'text';
  tagInput.placeholder = 'e.g. myproject';
  tagRow.appendChild(tagInput);
  form.appendChild(tagRow);

  const formProfileRow = document.createElement('div');
  formProfileRow.className = 'mcp-scope-form-row';
  const formProfileLabel = document.createElement('span');
  formProfileLabel.className = 'mcp-scope-form-label';
  formProfileLabel.textContent = 'Profile:';
  formProfileRow.appendChild(formProfileLabel);
  const formProfileSelect = document.createElement('peek-select');
  const formProfileOptions = mcpState.profiles.length ? mcpState.profiles : [mcpState.profile];
  formProfileSelect.options = formProfileOptions.map(p => ({ value: p, label: p }));
  formProfileSelect.value = mcpState.profile;
  formProfileRow.appendChild(formProfileSelect);
  form.appendChild(formProfileRow);

  const writesRow = document.createElement('div');
  writesRow.className = 'mcp-scope-form-row mcp-scope-form-row-writes';
  const writesCheck = document.createElement('peek-switch');
  writesCheck.setAttribute('aria-label', 'Allow writes');
  writesRow.appendChild(writesCheck);
  const writesLabel = document.createElement('label');
  writesLabel.className = 'mcp-scope-form-label-inline';
  writesLabel.textContent = 'Allow writes';
  writesLabel.addEventListener('click', () => writesCheck.toggle());
  writesRow.appendChild(writesLabel);
  form.appendChild(writesRow);

  const formError = document.createElement('p');
  formError.className = 'mcp-scope-form-error';
  form.appendChild(formError);

  const formButtons = document.createElement('div');
  formButtons.className = 'mcp-scope-form-buttons';
  const saveBtn = document.createElement('peek-button');
  saveBtn.variant = 'primary';
  saveBtn.size = 'sm';
  saveBtn.textContent = 'Save';
  formButtons.appendChild(saveBtn);
  const cancelBtn = document.createElement('peek-button');
  cancelBtn.size = 'sm';
  cancelBtn.textContent = 'Cancel';
  formButtons.appendChild(cancelBtn);
  form.appendChild(formButtons);
  mcpGroup.appendChild(form);

  const scopesList = document.createElement('div');
  scopesList.className = 'mcp-scopes-list';
  mcpGroup.appendChild(scopesList);

  const showScopeForm = (existing) => {
    formExistingPath = existing?.path || null;
    pathDisplay.textContent = existing?.path || '(none selected)';
    pickBtn.disabled = !!existing;
    tagInput.value = existing?.scopeTag || '';
    formProfileSelect.value = existing?.profile || mcpState.profile;
    writesCheck.checked = existing ? !existing.readonly : false;
    formError.classList.remove('visible');
    form.classList.add('visible');
    addScopeBtn.disabled = true;
    tagInput.focus();
  };
  const hideScopeForm = () => {
    form.classList.remove('visible');
    addScopeBtn.disabled = false;
  };
  const setFormError = (msg) => {
    formError.textContent = msg;
    formError.classList.add('visible');
  };

  addScopeBtn.addEventListener('click', () => showScopeForm(null));
  cancelBtn.addEventListener('click', () => hideScopeForm());

  pickBtn.addEventListener('click', async () => {
    try {
      const res = await api.mcp?.pickDirectory?.();
      if (res?.success && res.path) pathDisplay.textContent = res.path;
    } catch { /* ignore */ }
  });

  const refreshScopesList = async () => {
    let projects = [];
    try {
      const res = await api.mcp?.listScopedProjects?.();
      if (res?.success) projects = res.projects || [];
    } catch { /* ignore */ }
    scopesList.replaceChildren();
    if (projects.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'mcp-scopes-empty';
      empty.textContent = 'No project scopes yet.';
      scopesList.appendChild(empty);
      return;
    }
    for (const p of projects) {
      const row = document.createElement('div');
      row.className = 'mcp-scope-row';
      const info = document.createElement('div');
      info.className = 'mcp-scope-info';
      const pathEl = document.createElement('div');
      pathEl.className = 'mcp-scope-row-path';
      pathEl.textContent = p.path;
      info.appendChild(pathEl);
      const meta = document.createElement('div');
      meta.className = 'mcp-scope-row-meta';
      if (!p.exists) {
        meta.textContent = 'missing — .mcp.json not found';
      } else {
        const writesText = p.readonly ? 'read-only' : 'writes ENABLED';
        meta.textContent = `scope: ${p.scopeTag || '(none)'} · profile: ${p.profile} · ${writesText}`;
      }
      info.appendChild(meta);
      row.appendChild(info);
      if (p.exists) {
        const editBtn = document.createElement('peek-button');
        editBtn.size = 'sm';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', () => showScopeForm(p));
        row.appendChild(editBtn);
      }
      const removeBtn = document.createElement('peek-button');
      removeBtn.variant = 'danger';
      removeBtn.size = 'sm';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', async () => {
        if (!confirm(`Remove MCP scope from ${p.path}?\n\nThe .mcp.json file (or its peek entry) will be deleted.`)) return;
        try {
          const res = await api.mcp?.removeScopedProject?.(p.path);
          if (res?.success) await refreshScopesList();
        } catch { /* ignore */ }
      });
      row.appendChild(removeBtn);
      scopesList.appendChild(row);
    }
  };

  saveBtn.addEventListener('click', async () => {
    const dirPath = formExistingPath || (pathDisplay.textContent === '(none selected)' ? '' : pathDisplay.textContent);
    if (!dirPath) { setFormError('Pick a directory first.'); return; }
    const scopeTag = (tagInput.value || '').trim();
    if (!scopeTag) { setFormError('Scope tag is required.'); return; }
    try {
      const res = await api.mcp?.scaffoldProject?.({
        dirPath, scopeTag,
        profile: formProfileSelect.value,
        readonly: !writesCheck.checked,
      });
      if (!res?.success) { setFormError(res?.error || 'Save failed.'); return; }
      hideScopeForm();
      await refreshScopesList();
    } catch (e) {
      setFormError(e?.message || 'Save failed.');
    }
  });

  refreshScopesList();

  container.appendChild(mcpGroup);
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
  schemeSection.className = 'form-section spaced';

  const schemeTitle = document.createElement('h3');
  schemeTitle.className = 'form-section-title';
  schemeTitle.textContent = 'Color Scheme';
  schemeSection.appendChild(schemeTitle);

  const schemeGroup = document.createElement('div');
  schemeGroup.className = 'button-row fill';

  ['system', 'light', 'dark'].forEach(scheme => {
    const btn = document.createElement('peek-button');
    btn.textContent = scheme.charAt(0).toUpperCase() + scheme.slice(1);
    btn.dataset.scheme = scheme;
    btn.variant = colorScheme === scheme ? 'primary' : 'secondary';
    btn.addEventListener('click', async () => {
      const result = await api.theme.setColorScheme(scheme);
      if (result.success) {
        schemeGroup.querySelectorAll('peek-button').forEach(b => {
          b.variant = b.dataset.scheme === scheme ? 'primary' : 'secondary';
        });
      }
    });
    schemeGroup.appendChild(btn);
  });

  schemeSection.appendChild(schemeGroup);

  const schemeHelp = document.createElement('div');
  schemeHelp.className = 'help-text gap-above';
  schemeHelp.textContent = 'System follows your OS preference. Light/Dark forces that mode.';
  schemeSection.appendChild(schemeHelp);

  container.appendChild(schemeSection);

  // Add Theme button
  const addSection = document.createElement('div');
  addSection.className = 'form-section spaced';

  const addBtn = document.createElement('peek-button');
  addBtn.textContent = '+ Add Theme';
  addBtn.className = 'block-button';
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

        const card = document.createElement('peek-card');
        card.className = 'list-card';
        card.dataset.themeId = theme.id;

        const header = document.createElement('div');
        header.className = 'item-card-header';

        // Left side: name (no radio component exists; inactive themes get a Use button)
        const leftSide = document.createElement('div');
        leftSide.className = 'item-card-left';

        const cardTitle = document.createElement('div');
        cardTitle.className = 'item-card-title';

        const nameSpan = document.createElement('span');
        nameSpan.textContent = theme.name || theme.id;
        cardTitle.appendChild(nameSpan);

        if (theme.version) {
          const versionSpan = document.createElement('span');
          versionSpan.className = 'item-version';
          versionSpan.textContent = `v${theme.version}`;
          cardTitle.appendChild(versionSpan);
        }

        if (isBuiltin) {
          const badge = document.createElement('span');
          badge.className = 'item-badge';
          badge.textContent = 'built-in';
          cardTitle.appendChild(badge);
        }

        if (isActive) {
          const activeBadge = document.createElement('span');
          activeBadge.className = 'item-badge item-badge-active';
          activeBadge.textContent = 'active';
          cardTitle.appendChild(activeBadge);
        }

        leftSide.appendChild(cardTitle);
        header.appendChild(leftSide);

        // Right side: actions
        const actions = document.createElement('div');
        actions.className = 'button-row centered';

        if (!isActive) {
          const useBtn = document.createElement('peek-button');
          useBtn.variant = 'primary';
          useBtn.size = 'sm';
          useBtn.textContent = 'Use';
          useBtn.addEventListener('click', async () => {
            useBtn.disabled = true;
            const result = await api.theme.setTheme(theme.id);
            if (result.success) {
              refreshThemesList();
            } else {
              useBtn.disabled = false;
            }
          });
          actions.appendChild(useBtn);
        }

        // Reload button
        const reloadBtn = document.createElement('peek-button');
        reloadBtn.size = 'sm';
        reloadBtn.textContent = 'Reload';
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
          const removeBtn = document.createElement('peek-button');
          removeBtn.variant = 'danger';
          removeBtn.size = 'sm';
          removeBtn.textContent = 'Remove';
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
          desc.className = 'help-text gap-below';
          desc.textContent = theme.description;
          body.appendChild(desc);
        }

        if (theme.author) {
          const authorInfo = document.createElement('div');
          authorInfo.className = 'help-text gap-below-sm';
          authorInfo.textContent = `Author: ${theme.author}`;
          body.appendChild(authorInfo);
        }

        // Show path for external themes
        if (theme.path && !isBuiltin) {
          const pathInfo = document.createElement('div');
          pathInfo.className = 'help-text mono-small';
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
  extSectionDesc.className = 'help-text section-intro';
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

  const adBlockerCard = document.createElement('peek-card');
  adBlockerCard.className = 'list-card';

  const adBlockerHeader = document.createElement('div');
  adBlockerHeader.className = 'item-card-header';

  // Left side: checkbox + name
  const adBlockerLeft = document.createElement('div');
  adBlockerLeft.className = 'item-card-left';

  const adBlockerCheckbox = document.createElement('peek-switch');
  adBlockerCheckbox.checked = adBlockerEnabled;
  adBlockerCheckbox.setAttribute('aria-label', 'Ghostery Ad Blocker');
  adBlockerCheckbox.addEventListener('change', async (e) => {
    const checked = e.detail.checked;
    try {
      if (checked) {
        await api.adblocker.enable();
      } else {
        await api.adblocker.disable();
      }
    } catch (err) {
      console.error('[settings] Failed to toggle adblocker:', err);
      adBlockerCheckbox.checked = !checked;
    }
  });
  adBlockerLeft.appendChild(adBlockerCheckbox);

  const adBlockerTitle = document.createElement('div');
  adBlockerTitle.className = 'item-card-title';

  const adBlockerName = document.createElement('span');
  adBlockerName.textContent = 'Ghostery Ad Blocker';
  adBlockerTitle.appendChild(adBlockerName);

  const adBlockerSourceLink = document.createElement('a');
  adBlockerSourceLink.href = 'https://github.com/ghostery/adblocker';
  adBlockerSourceLink.target = '_blank';
  adBlockerSourceLink.textContent = 'source';
  adBlockerSourceLink.className = 'item-card-meta muted';
  adBlockerTitle.appendChild(adBlockerSourceLink);

  adBlockerLeft.appendChild(adBlockerTitle);
  adBlockerHeader.appendChild(adBlockerLeft);
  adBlockerCard.appendChild(adBlockerHeader);

  // Body
  const adBlockerBody = document.createElement('div');
  adBlockerBody.className = 'item-card-body';

  const adBlockerDesc = document.createElement('div');
  adBlockerDesc.className = 'help-text gap-below-sm';
  adBlockerDesc.textContent = 'Block ads and trackers for faster, cleaner browsing.';
  adBlockerBody.appendChild(adBlockerDesc);

  const adBlockerStats = document.createElement('div');
  adBlockerStats.className = 'help-text gap-below-sm';
  adBlockerStats.innerHTML = `<strong>${blockedCount.toLocaleString()}</strong> requests blocked this session`;
  adBlockerBody.appendChild(adBlockerStats);

  const adBlockerAttr = document.createElement('div');
  adBlockerAttr.className = 'help-text small attribution';
  adBlockerAttr.innerHTML = 'Powered by <a href="https://github.com/ghostery/adblocker" target="_blank">@ghostery/adblocker</a> (MPL-2.0). Filter lists: <a href="https://easylist.to/" target="_blank">EasyList</a> and <a href="https://easylist.to/easylist/easyprivacy.txt" target="_blank">EasyPrivacy</a>.';
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
        const card = document.createElement('peek-card');
        card.className = 'list-card';

        const header = document.createElement('div');
        header.className = 'item-card-header';

        // Left side: checkbox + name + source link
        const leftSide = document.createElement('div');
        leftSide.className = 'item-card-left';

        const checkbox = document.createElement('peek-switch');
        checkbox.checked = ext.enabled;
        checkbox.setAttribute('aria-label', ext.name);
        checkbox.addEventListener('change', async (e) => {
          const checked = e.detail.checked;
          try {
            if (checked) {
              await api.chromeExtensions.enable(ext.id);
            } else {
              await api.chromeExtensions.disable(ext.id);
            }
          } catch (err) {
            console.error('[settings] Failed to toggle chrome extension:', err);
            checkbox.checked = !checked;
          }
        });
        leftSide.appendChild(checkbox);

        const cardTitle = document.createElement('div');
        cardTitle.className = 'item-card-title';

        const nameSpan = document.createElement('span');
        nameSpan.textContent = ext.name;
        cardTitle.appendChild(nameSpan);

        if (ext.version) {
          const versionSpan = document.createElement('span');
          versionSpan.className = 'item-card-meta';
          versionSpan.textContent = `v${ext.version}`;
          cardTitle.appendChild(versionSpan);
        }

        // Source code link (path to extension directory)
        if (ext.path) {
          const sourceLink = document.createElement('span');
          sourceLink.textContent = 'source';
          sourceLink.title = ext.path;
          sourceLink.className = 'item-card-meta muted help-cursor';
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
          desc.className = 'help-text gap-below-sm';
          desc.textContent = ext.description;
          body.appendChild(desc);
        }

        // Inline attribution
        if (ext.attribution) {
          const attrDiv = document.createElement('div');
          attrDiv.className = 'help-text small attribution';
          // Check if attribution contains a URL and make it a link
          const urlMatch = ext.attribution.match(/(https?:\/\/[^\s]+)/);
          if (urlMatch) {
            const beforeUrl = ext.attribution.substring(0, ext.attribution.indexOf(urlMatch[1]));
            const url = urlMatch[1];
            const afterUrl = ext.attribution.substring(ext.attribution.indexOf(urlMatch[1]) + urlMatch[1].length);
            attrDiv.innerHTML = `${beforeUrl}<a href="${url}" target="_blank">${url}</a>${afterUrl}`;
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
            actions.className = 'card-actions';
            const entryTypeLabels = {
              popup: 'Popup', options: 'Options', background: 'Background',
              newtab: 'New Tab', history: 'History', bookmarks: 'Bookmarks',
              devtools: 'DevTools', sidepanel: 'Side Panel',
            };
            for (const entry of extEntries) {
              const btn = document.createElement('peek-button');
              btn.setAttribute('variant', 'secondary');
              btn.textContent = entryTypeLabels[entry.type] || entry.type;
              btn.title = entry.title;
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
    errorMsg.className = 'help-text error';
    errorMsg.textContent = 'Failed to load extensions: ' + err.message;
    extSection.appendChild(errorMsg);
  }

  container.appendChild(extSection);

  return container;
};

// ─── Permissions ────────────────────────────────────────────────────
//
// Lists per-origin web permission decisions persisted by the page-host
// permission handler (geolocation, camera/mic, midi, display-capture, etc.)
// and lets the user revoke them. Backed by `tile:permissions:list/forget/
// forgetAll` IPC; trustedBuiltin gated so only this page can read/clear.
//
// Exposes `window._refreshPermissionsList` so re-entry into the section
// (and external mutations like a fresh prompt landing while the page is
// open) re-fetches the live state — initial render alone is insufficient.
const renderPermissionsSettings = async () => {
  const container = document.createElement('div');

  const desc = document.createElement('p');
  desc.className = 'help-text section-intro';
  desc.textContent = 'Sites you have allowed or denied for sensors, media, screen capture, MIDI, etc. Revoking a decision means the next request from that site will prompt again.';
  container.appendChild(desc);

  const list = document.createElement('div');
  list.className = 'permissions-list';
  container.appendChild(list);

  const emptyMsg = document.createElement('p');
  emptyMsg.className = 'help-text italic is-hidden';
  emptyMsg.textContent = 'No saved permission decisions.';
  container.appendChild(emptyMsg);

  // Friendly labels — keep in sync with apps/desktop/main/permission-policy.ts
  // PERMISSION_LABELS. Falls back to the raw permission name if missing.
  const PERMISSION_LABELS = {
    geolocation: 'Location',
    media: 'Camera & microphone',
    midi: 'MIDI devices',
    midiSysex: 'MIDI System Exclusive',
    'display-capture': 'Screen capture',
    notifications: 'Notifications',
    'clipboard-read': 'Clipboard read',
    'clipboard-sanitized-write': 'Clipboard write',
    pointerLock: 'Pointer lock',
    fullscreen: 'Fullscreen',
    openExternal: 'Open external apps',
  };

  // Visual scan helper — emoji glyph by permission type. Same set as the
  // page-host prompt overlay (app/page/page.js PERMISSION_GLYPHS) so the
  // visual identity is consistent across both surfaces.
  const PERMISSION_GLYPHS = {
    geolocation: '\u{1F4CD}',          // 📍
    media: '\u{1F3A4}',                // 🎤
    midi: '\u{1F3B9}',                 // 🎹
    midiSysex: '\u{1F3B9}',
    'display-capture': '\u{1F4FA}',    // 📺
    notifications: '\u{1F514}',        // 🔔
    'clipboard-read': '\u{1F4CB}',     // 📋
    'clipboard-sanitized-write': '\u{1F4CB}',
    pointerLock: '\u{1F5B1}',          // 🖱️
    fullscreen: '\u{2922}',            // ⤢
    openExternal: '\u{1F517}',         // 🔗
  };

  // Globe-emoji SVG fallback used when the favicon service is unreachable
  // for an origin (offline, blocked, weird URL). Same data-URI used in the
  // page-host prompt + cards.
  const FALLBACK_FAVICON = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">\u{1F310}</text></svg>';

  const hostFromOrigin = (origin) => {
    if (!origin) return null;
    try { return new URL(origin).hostname || null; } catch { return null; }
  };

  // Human-readable relative timestamp. "just now" / "5 minutes ago" /
  // "3 hours ago" / "2 days ago" — falls back to the absolute date for
  // anything older than a week so the user can still see the exact day.
  const relativeTime = (ms) => {
    if (!ms) return '';
    const diff = Date.now() - ms;
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) {
      const m = Math.floor(diff / 60_000);
      return m === 1 ? '1 minute ago' : `${m} minutes ago`;
    }
    if (diff < 86_400_000) {
      const h = Math.floor(diff / 3_600_000);
      return h === 1 ? '1 hour ago' : `${h} hours ago`;
    }
    if (diff < 604_800_000) {
      const d = Math.floor(diff / 86_400_000);
      return d === 1 ? '1 day ago' : `${d} days ago`;
    }
    return new Date(ms).toLocaleDateString();
  };

  const renderRow = (decision) => {
    const row = document.createElement('peek-card');
    row.classList.add('list-card');

    const header = document.createElement('div');
    header.className = 'permissions-row-header';

    const left = document.createElement('div');
    left.className = 'permissions-row-left';

    // Favicon — Google s2 favicon service with globe-emoji fallback. Same
    // pattern used in the page-host permission prompt + search-result cards.
    const favicon = document.createElement('img');
    favicon.className = 'permissions-row-favicon';
    favicon.alt = '';
    const host = hostFromOrigin(decision.origin);
    favicon.src = host ? `https://www.google.com/s2/favicons?domain=${host}&sz=32` : FALLBACK_FAVICON;
    favicon.onerror = () => { favicon.src = FALLBACK_FAVICON; favicon.onerror = null; };
    left.appendChild(favicon);

    const textCol = document.createElement('div');
    textCol.className = 'permissions-row-text';

    const originEl = document.createElement('div');
    originEl.className = 'permissions-row-origin';
    originEl.textContent = decision.origin;
    textCol.appendChild(originEl);

    const meta = document.createElement('div');
    meta.className = 'help-text meta-line';
    const label = PERMISSION_LABELS[decision.permission] || decision.permission;
    const glyph = PERMISSION_GLYPHS[decision.permission] || '\u{1F512}';
    const verdict = decision.allowed ? 'Allowed' : 'Denied';
    const when = relativeTime(decision.timestamp);
    meta.textContent = `${glyph} ${label} · ${verdict}${when ? ' · ' + when : ''}`;
    textCol.appendChild(meta);
    left.appendChild(textCol);

    const revokeBtn = document.createElement('peek-button');
    revokeBtn.setAttribute('variant', 'secondary');
    revokeBtn.textContent = 'Revoke';
    revokeBtn.className = 'permissions-row-revoke';
    revokeBtn.addEventListener('click', async () => {
      revokeBtn.disabled = true;
      try {
        const res = await api.permissions.forget(decision.origin, decision.permission);
        if (res?.success) {
          row.remove();
          if (list.children.length === 0) {
            emptyMsg.classList.remove('is-hidden');
            clearAllBtn.classList.add('is-hidden');
          }
          if (typeof window._setPermissionsNavCount === 'function') {
            window._setPermissionsNavCount(list.children.length);
          }
        } else {
          revokeBtn.disabled = false;
          console.error('[settings] permissions.forget failed:', res?.error);
        }
      } catch (err) {
        revokeBtn.disabled = false;
        console.error('[settings] permissions.forget threw:', err);
      }
    });

    header.appendChild(left);
    header.appendChild(revokeBtn);
    row.appendChild(header);
    return row;
  };

  const clearAllWrap = document.createElement('div');
  clearAllWrap.className = 'permissions-clear-all';
  const clearAllBtn = document.createElement('peek-button');
  clearAllBtn.setAttribute('variant', 'secondary');
  clearAllBtn.textContent = 'Clear all';
  clearAllBtn.addEventListener('click', async () => {
    if (!confirm('Clear all saved permission decisions? Sites will be prompted again next time they request a permission.')) return;
    clearAllBtn.disabled = true;
    try {
      const res = await api.permissions.forgetAll();
      if (res?.success) {
        list.replaceChildren();
        emptyMsg.classList.remove('is-hidden');
        clearAllBtn.classList.add('is-hidden');
        if (typeof window._setPermissionsNavCount === 'function') {
          window._setPermissionsNavCount(0);
        }
      } else {
        clearAllBtn.disabled = false;
        console.error('[settings] permissions.forgetAll failed:', res?.error);
      }
    } catch (err) {
      clearAllBtn.disabled = false;
      console.error('[settings] permissions.forgetAll threw:', err);
    }
  });
  clearAllWrap.appendChild(clearAllBtn);
  container.appendChild(clearAllWrap);

  // Reusable refresh — called both on initial load and on every visit
  // to the section (so external mutations show up).
  //
  // Sorts the list by origin first, then by permission within origin —
  // grouping every saved decision for a single site together makes the
  // common case ("revoke everything I gave example.com") two clicks
  // away instead of scattered through the list.
  //
  // Also updates the sidebar nav badge so the user sees how many
  // saved decisions exist without having to enter the section.
  const updateNavCount = (n) => {
    if (typeof window._setPermissionsNavCount === 'function') {
      window._setPermissionsNavCount(n);
    }
  };
  const refresh = async () => {
    try {
      const res = await api.permissions.list();
      list.replaceChildren();
      const data = (res?.success && Array.isArray(res.data)) ? res.data : [];
      if (data.length > 0) {
        const sorted = [...data].sort((a, b) => {
          if (a.origin !== b.origin) return a.origin.localeCompare(b.origin);
          return a.permission.localeCompare(b.permission);
        });
        for (const decision of sorted) list.appendChild(renderRow(decision));
        emptyMsg.classList.add('is-hidden');
        clearAllBtn.classList.remove('is-hidden');
        clearAllBtn.disabled = false;
      } else {
        emptyMsg.classList.remove('is-hidden');
        clearAllBtn.classList.add('is-hidden');
        clearAllBtn.disabled = false;
      }
      updateNavCount(data.length);
    } catch (err) {
      console.error('[settings] permissions.list threw:', err);
      list.replaceChildren();
      emptyMsg.textContent = 'Failed to load permissions.';
      emptyMsg.classList.remove('is-hidden');
      clearAllBtn.classList.add('is-hidden');
      updateNavCount(0);
    }
  };

  window._refreshPermissionsList = refresh;
  await refresh();

  return container;
};

// Render dark mode settings for web pages
const renderDarkModeSettings = async () => {
  const container = document.createElement('div');

  // Description
  const desc = document.createElement('p');
  desc.className = 'help-text section-intro';
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
  modeGroup.className = 'button-row fill';

  const modes = [
    { value: 'off', label: 'Off', desc: 'Pages render as-is' },
    { value: 'system', label: 'System', desc: 'Sites that support dark mode will use it' },
    { value: 'force', label: 'Force', desc: 'Force dark mode on all sites' },
  ];

  // Restart notice (hidden by default)
  const restartNotice = document.createElement('div');
  restartNotice.className = 'help-text warning gap-above is-hidden';
  restartNotice.textContent = 'Restart required for this change to take full effect.';

  const updateButtons = (activeValue) => {
    modeGroup.querySelectorAll('peek-button').forEach(btn => {
      btn.variant = btn.dataset.mode === activeValue ? 'primary' : 'secondary';
    });
  };

  modes.forEach(mode => {
    const btn = document.createElement('peek-button');
    btn.textContent = mode.label;
    btn.dataset.mode = mode.value;
    btn.variant = currentMode === mode.value ? 'primary' : 'secondary';
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
            restartNotice.classList.remove('is-hidden');
          } else {
            restartNotice.classList.add('is-hidden');
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
  modeDesc.className = 'help-text gap-above';
  modeDesc.textContent = modes.find(m => m.value === currentMode)?.desc || '';
  modeSection.appendChild(modeDesc);

  modeSection.appendChild(restartNotice);

  container.appendChild(modeSection);

  // Tier explanation
  const tierSection = document.createElement('div');
  tierSection.className = 'form-section spaced-above';

  const tierTitle = document.createElement('h3');
  tierTitle.className = 'form-section-title';
  tierTitle.textContent = 'How It Works';
  tierSection.appendChild(tierTitle);

  const tierDesc = document.createElement('div');
  tierDesc.className = 'help-text';
  tierDesc.innerHTML = `
    <p class="gap-below"><strong>System</strong> sets <code>prefers-color-scheme: dark</code> so sites with built-in dark mode support switch automatically. Zero performance cost.</p>
    <p class="gap-below"><strong>Force</strong> additionally enables Chromium's auto-dark mode, which uses CIELAB-based color inversion in the rendering pipeline. This forces dark mode on all sites, including those without native support. Images are preserved. Changing this requires an app restart.</p>
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
  // Entries loaded from the main-process ring buffer (tile:sync:get-log) plus
  // any that arrive live over the `sync:progress` pubsub topic — see the
  // log section built further down.
  const logEntries = [];

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
  apiKeyWrapper.className = 'field-row';

  const apiKeyInput = document.createElement('peek-input');
  apiKeyInput.type = 'password';
  apiKeyInput.value = config.apiKey || '';
  apiKeyInput.addEventListener('change', async () => {
    config.apiKey = apiKeyInput.value;
    await api.sync.setConfig({ apiKey: apiKeyInput.value });
    updateStatus();
  });
  apiKeyWrapper.appendChild(apiKeyInput);

  const toggleBtn = document.createElement('peek-button');
  toggleBtn.setAttribute('variant', 'secondary');
  toggleBtn.setAttribute('size', 'sm');
  toggleBtn.textContent = 'Show';
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

  // Enroll with a code — an alternative to pasting an existing key: a code
  // minted by an already-enrolled device's Settings → Devices → "Add a
  // device" button, traded here for this device's own key via POST /enrol.
  // The exchanged key is stored exactly where a pasted key goes (setConfig
  // below, same apiKeyInput/config.apiKey the field above writes to).
  const enrolGroup = document.createElement('div');
  enrolGroup.className = 'form-group';
  enrolGroup.dataset.role = 'enrol-group';

  const enrolLabel = document.createElement('label');
  enrolLabel.textContent = 'Enrolment Code';
  enrolGroup.appendChild(enrolLabel);

  const enrolLabelInput = document.createElement('peek-input');
  enrolLabelInput.dataset.role = 'enrol-label-input';
  enrolLabelInput.placeholder = 'Device name (optional)';
  enrolLabelInput.className = 'stacked-input';
  enrolGroup.appendChild(enrolLabelInput);

  const enrolWrapper = document.createElement('div');
  enrolWrapper.className = 'field-row';

  const enrolInput = document.createElement('peek-input');
  enrolInput.dataset.role = 'enrol-code-input';
  enrolInput.placeholder = 'Code from another device';
  enrolWrapper.appendChild(enrolInput);

  const enrolBtn = document.createElement('peek-button');
  enrolBtn.dataset.role = 'enrol-button';
  enrolBtn.setAttribute('variant', 'secondary');
  enrolBtn.setAttribute('size', 'sm');
  enrolBtn.textContent = 'Enroll';
  enrolWrapper.appendChild(enrolBtn);
  enrolGroup.appendChild(enrolWrapper);

  const enrolStatus = document.createElement('div');
  enrolStatus.className = 'help-text';
  enrolStatus.dataset.role = 'enrol-status';
  enrolStatus.textContent = "Enter this device's server URL above and a code from an already-enrolled device to get its own key.";
  enrolGroup.appendChild(enrolStatus);

  const showEnrolError = (message) => {
    enrolStatus.textContent = message;
    enrolStatus.classList.add('error');
  };

  enrolBtn.addEventListener('click', async () => {
    const code = (enrolInput.value || '').trim();
    const label = (enrolLabelInput.value || '').trim();
    if (!config.serverUrl) {
      showEnrolError('Enter a server URL above first.');
      return;
    }
    if (!code) {
      showEnrolError('Enter a code first.');
      return;
    }
    try {
      const result = await runWithBusyButton(enrolBtn, 'Enrolling…', () =>
        api.sync.enrol(config.serverUrl, code, label || undefined));
      if (!result.success) {
        showEnrolError(result.error || 'Failed to enroll');
        return;
      }
      const newKey = result.data?.apiKey || '';
      config.apiKey = newKey;
      apiKeyInput.value = newKey;
      const persistResult = await api.sync.setConfig({ apiKey: newKey });
      if (!persistResult.success) {
        showEnrolError(persistResult.error || 'Enrolled, but failed to save the new key. Try again.');
        return;
      }
      enrolInput.value = '';
      enrolLabelInput.value = '';
      enrolStatus.textContent = 'Enrolled — this device now has its own key.';
      enrolStatus.classList.remove('error');
      updateStatus();
    } catch (err) {
      showEnrolError(err.message || 'Failed to enroll');
    }
  });

  configSection.appendChild(enrolGroup);

  // Auto-sync checkbox
  const autoSyncCheckbox = createCheckbox('Auto-sync', config.autoSync, async (val) => {
    config.autoSync = val;
    await api.sync.setConfig({ autoSync: val });
  }, { helpText: 'Automatically sync when items are added or modified' });
  configSection.appendChild(autoSyncCheckbox);

  container.appendChild(configSection);

  // Sync Status section
  const statusSection = document.createElement('div');
  statusSection.className = 'form-section spaced-above';

  const statusTitle = document.createElement('h3');
  statusTitle.className = 'form-section-title';
  statusTitle.textContent = 'Sync Status';
  statusSection.appendChild(statusTitle);

  const statusContainer = document.createElement('div');
  statusContainer.className = 'status-block';

  const statusLine = document.createElement('div');
  statusLine.className = 'help-text gap-below-sm';
  statusContainer.appendChild(statusLine);

  const lastSyncLine = document.createElement('div');
  lastSyncLine.className = 'help-text gap-below-sm';
  statusContainer.appendChild(lastSyncLine);

  const pendingLine = document.createElement('div');
  pendingLine.className = 'help-text';
  statusContainer.appendChild(pendingLine);

  // Live status line — the CURRENT stage of an in-flight run (e.g.
  // "Now: Pushing items — 4,213 / 11,355"), driven by the `sync:progress`
  // pubsub events sync.ts publishes at each stage boundary and at throttled
  // intervals during the item push. Hidden whenever no run is in flight —
  // set by handleSyncProgressEntry() below, seeded from the on-load log
  // fetch so opening the panel mid-run shows the current stage immediately.
  const liveStatusLine = document.createElement('div');
  liveStatusLine.className = 'help-text live-status-line is-hidden';
  statusContainer.appendChild(liveStatusLine);

  // Error line — only shown when the most recent syncAll threw. The
  // background color of the whole status block also goes red so the
  // failure is hard to miss without having to scan text.
  const errorLine = document.createElement('div');
  errorLine.className = 'help-text status-error-line is-hidden';
  statusContainer.appendChild(errorLine);

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
    statusLine.classList.toggle('status-line-ok', !!isConfigured);
    statusLine.classList.toggle('status-line-off', !isConfigured);

    if (status.lastSyncTime && status.lastSyncTime > 0) {
      const lastSyncDate = new Date(status.lastSyncTime);
      lastSyncLine.textContent = `Last sync: ${lastSyncDate.toLocaleString()}`;
    } else {
      lastSyncLine.textContent = 'Last sync: Never';
    }

    pendingLine.textContent = `Pending items: ${status.pendingCount || 0}`;

    // Surface sync errors prominently — the block goes red and an error
    // line appears below pending. Cleared on the next successful sync.
    if (status.lastError) {
      const at = status.lastErrorAt ? new Date(status.lastErrorAt).toLocaleString() : '';
      errorLine.textContent = at
        ? `Last error (${at}): ${status.lastError}`
        : `Last error: ${status.lastError}`;
      errorLine.classList.remove('is-hidden');
      statusContainer.classList.add('error');
    } else {
      errorLine.classList.add('is-hidden');
      errorLine.textContent = '';
      statusContainer.classList.remove('error');
    }
  };

  // Initial status update
  await updateStatus();

  // Re-read the stored config into this panel's inputs and status. The
  // Devices panel changes the stored key from outside this closure — a
  // device revoking itself drops it (tile:sync:revoke-device) — and without
  // this the field would keep showing a key the server now refuses. Exposed
  // on window like _refreshDevicesList / _refreshPermissionsList.
  window._refreshSyncConfig = async () => {
    try {
      const configResult = await api.sync.getConfig();
      if (configResult.success && configResult.data) {
        config = { ...config, ...configResult.data };
        serverUrlGroup.querySelector('peek-input').value = config.serverUrl || '';
        apiKeyInput.value = config.apiKey || '';
      }
    } catch (err) {
      console.error('[settings] Failed to reload sync config:', err);
    }
    await updateStatus();
  };

  // Reflects one `sync:progress` entry in the live status line. A run
  // finishing or failing leaves its own message showing (dropping the "Now:"
  // prefix, since it is no longer in progress) rather than hiding the line —
  // this is the panel's only immediate feedback for a completed Sync All run
  // now that the transient toast no longer duplicates it (see the Sync All
  // result handler below) — and refreshes the static status block above so
  // pending count / last sync / last error don't wait for the next manual
  // button press. It stays up until the next run's own `start` entry
  // overwrites it.
  const handleSyncProgressEntry = (entry) => {
    const isRunEnd = entry.stage === 'run' && (entry.phase === 'finish' || entry.phase === 'error');
    liveStatusLine.textContent = isRunEnd ? entry.message : `Now: ${entry.message}`;
    liveStatusLine.classList.remove('is-hidden');
    if (isRunEnd) {
      updateStatus();
    }
  };

  container.appendChild(statusSection);

  // Manual Sync section
  const syncSection = document.createElement('div');
  syncSection.className = 'form-section spaced-above';

  const syncTitle = document.createElement('h3');
  syncTitle.className = 'form-section-title';
  syncTitle.textContent = 'Manual Sync';
  syncSection.appendChild(syncTitle);

  // Result display area
  const resultArea = document.createElement('div');
  resultArea.className = 'result-banner';
  syncSection.appendChild(resultArea);

  // Function to show result message
  const showResult = (message, isError = false) => {
    resultArea.textContent = message;
    resultArea.className = `result-banner visible ${isError ? 'error' : 'success'}`;

    // Auto-hide after 5 seconds
    setTimeout(() => {
      resultArea.classList.remove('visible');
    }, 5000);
  };

  // Button container
  const buttonContainer = document.createElement('div');
  buttonContainer.className = 'button-row fill wrap';

  // Helper to create action buttons
  const createActionButton = (text, action, primary = false) => {
    const btn = document.createElement('peek-button');
    btn.setAttribute('variant', primary ? 'primary' : 'secondary');
    btn.textContent = text;
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

      // Disable all buttons during operation
      buttonContainer.querySelectorAll('peek-button').forEach(b => {
        b.disabled = true;
      });

      try {
        const result = await action();
        if (result.success) {
          const data = result.data || {};
          // A result with both `pulled` and `pushed` only comes from Sync
          // All (Pull returns just `pulled`, Push just `pushed`) — that
          // summary now duplicates the log's own run-complete entry and the
          // live status line above (handleSyncProgressEntry), so it skips
          // the auto-clearing toast rather than showing the same numbers
          // twice, once permanent and once about to vanish.
          if (data.pulled !== undefined && data.pushed !== undefined) {
            // No showResult() here — see comment above.
          } else if (data.pulled !== undefined) {
            let message = `Pulled ${data.pulled} items`;
            if (data.conflicts) message += ` (${data.conflicts} conflicts)`;
            showResult(message, false);
          } else if (data.pushed !== undefined) {
            let message = `Pushed ${data.pushed} items`;
            if (data.skipped) message += ` (${data.skipped} skipped)`;
            showResult(message, false);
          } else {
            showResult('Sync completed', false);
          }
        } else {
          showResult(result.error || 'Sync failed', true);
        }
      } catch (err) {
        showResult(err.message || 'Sync error', true);
      } finally {
        isSyncing = false;
        btn.textContent = originalText;

        // Re-enable all buttons
        buttonContainer.querySelectorAll('peek-button').forEach(b => {
          b.disabled = false;
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
  const syncAllBtn = createActionButton('Sync All', () => api.sync.syncAll(), true);
  buttonContainer.appendChild(syncAllBtn);

  syncSection.appendChild(buttonContainer);

  // Help text
  const helpText = document.createElement('div');
  helpText.className = 'help-text gap-above-md';
  helpText.textContent = 'Pull downloads new items from the server. Push uploads local items. Sync All does both.';
  syncSection.appendChild(helpText);

  // Per-run sync log — collapsed by default. One timestamped line per stage
  // start/finish, throttled item-push progress, dropped events, and stage
  // failures — everything sync.ts's `sync:progress` events carry. Backed by
  // the main process's bounded ring buffer for the CURRENT run
  // (tile:sync:get-log), so opening this panel mid-run shows what already
  // happened instead of an empty log; a run that has never happened (or a
  // restart mid-run, which clears the buffer) just shows an empty log.
  const logWrap = document.createElement('div');
  logWrap.className = 'sync-log';

  const logToggle = document.createElement('peek-button');
  logToggle.setAttribute('variant', 'ghost');
  logToggle.setAttribute('size', 'sm');
  logWrap.appendChild(logToggle);

  const logList = document.createElement('div');
  logList.className = 'sync-log-list is-hidden';
  logWrap.appendChild(logList);

  let logExpanded = false;
  const updateLogToggleLabel = () => {
    logToggle.textContent = logExpanded
      ? 'Hide sync log ▾'
      : `Show sync log (${logEntries.length}) ▸`;
  };
  updateLogToggleLabel();

  logToggle.addEventListener('click', () => {
    logExpanded = !logExpanded;
    logList.classList.toggle('is-hidden', !logExpanded);
    updateLogToggleLabel();
    if (logExpanded) logList.scrollTop = logList.scrollHeight;
  });

  // sync.ts's resetSyncLog() drops the main-process buffer at the start of
  // every run, but that reset is silent — it doesn't publish anything, so a
  // panel already open from a PRIOR run would otherwise keep showing that
  // run's entries with the new run's just appended after them. The run's own
  // first entry (`run`/`start`) is the signal that a new run has begun; clear
  // the visible log at that point so it mirrors the main process buffer
  // instead of accumulating across runs.
  const clearLogDisplay = () => {
    logEntries.length = 0;
    logList.textContent = '';
    updateLogToggleLabel();
  };

  // Appends one entry to both the in-memory array and the visible list.
  // Auto-scrolls only while expanded — an operator scrolled up to read an
  // earlier line shouldn't get yanked to the bottom by a background run.
  const appendLogEntry = (entry) => {
    logEntries.push(entry);

    const line = document.createElement('div');
    const time = new Date(entry.ts).toLocaleTimeString();
    line.textContent = `[${time}] ${entry.stage}: ${entry.message}`;
    line.className = 'sync-log-line';
    if (entry.phase === 'error') {
      line.classList.add('error');
    } else if (entry.phase === 'dropped') {
      line.classList.add('dropped');
    }
    logList.appendChild(line);

    updateLogToggleLabel();
    if (logExpanded) logList.scrollTop = logList.scrollHeight;
  };

  syncSection.appendChild(logWrap);

  container.appendChild(syncSection);

  // Load whatever the current run's log already holds (empty if no run has
  // happened yet, or if the app restarted mid-run — the ring buffer is
  // in-memory only), then subscribe for live updates. The last loaded entry
  // seeds the live status line too, so a panel opened mid-run shows the
  // current stage immediately rather than waiting for the next event.
  try {
    const logResult = await api.sync.getLog();
    if (logResult.success && Array.isArray(logResult.data)) {
      logResult.data.forEach(appendLogEntry);
      if (logEntries.length > 0) {
        handleSyncProgressEntry(logEntries[logEntries.length - 1]);
      }
    }
  } catch (err) {
    console.error('[settings] Failed to load sync log:', err);
  }

  api.subscribe('sync:progress', (entry) => {
    if (entry.stage === 'run' && entry.phase === 'start') {
      clearLogDisplay();
    }
    appendLogEntry(entry);
    handleSyncProgressEntry(entry);
  });

  // Profile Sync section
  const profileSyncSection = document.createElement('div');
  profileSyncSection.className = 'form-section spaced-above';

  const profileSyncTitle = document.createElement('h3');
  profileSyncTitle.className = 'form-section-title';
  profileSyncTitle.textContent = 'Profiles';
  profileSyncSection.appendChild(profileSyncTitle);

  const profileSyncDesc = document.createElement('div');
  profileSyncDesc.className = 'help-text gap-below-md';
  profileSyncDesc.textContent = 'Enable or disable sync for each profile and configure its server profile ID.';
  profileSyncSection.appendChild(profileSyncDesc);

  const profileSyncList = document.createElement('div');
  profileSyncList.className = 'profile-sync-list';

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
      row.className = 'profile-sync-row';

      const rowHeader = document.createElement('div');
      rowHeader.className = 'profile-sync-header';

      const profileName = document.createElement('span');
      profileName.textContent = profile.name;
      profileName.className = 'profile-sync-name';
      rowHeader.appendChild(profileName);

      if (syncConfig) {
        // Sync enabled — show status and disable button
        const statusBadge = document.createElement('span');
        statusBadge.textContent = 'Enabled';
        statusBadge.className = 'profile-sync-badge on';
        rowHeader.appendChild(statusBadge);
        row.appendChild(rowHeader);

        const detailsRow = document.createElement('div');
        detailsRow.className = 'profile-sync-details';
        detailsRow.textContent = `Server profile: ${syncConfig.serverProfileId}`;
        row.appendChild(detailsRow);

        const disableBtn = document.createElement('peek-button');
        disableBtn.setAttribute('variant', 'secondary');
        disableBtn.setAttribute('size', 'sm');
        disableBtn.textContent = 'Disable Sync';
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
        statusBadge.className = 'profile-sync-badge off';
        rowHeader.appendChild(statusBadge);
        row.appendChild(rowHeader);

        // Inline enable form (hidden by default)
        const enableForm = document.createElement('div');
        enableForm.className = 'profile-sync-form is-hidden';

        const formApiKeyInput = document.createElement('peek-input');
        formApiKeyInput.type = 'password';
        formApiKeyInput.placeholder = 'API Key';
        enableForm.appendChild(formApiKeyInput);

        const formProfileIdInput = document.createElement('peek-input');
        formProfileIdInput.type = 'text';
        formProfileIdInput.placeholder = 'Server profile ID (UUID from server)';
        enableForm.appendChild(formProfileIdInput);

        const formButtons = document.createElement('div');
        formButtons.className = 'button-row';

        const formSaveBtn = document.createElement('peek-button');
        formSaveBtn.setAttribute('variant', 'primary');
        formSaveBtn.setAttribute('size', 'sm');
        formSaveBtn.textContent = 'Enable';
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

        const formCancelBtn = document.createElement('peek-button');
        formCancelBtn.setAttribute('variant', 'secondary');
        formCancelBtn.setAttribute('size', 'sm');
        formCancelBtn.textContent = 'Cancel';
        formCancelBtn.addEventListener('click', () => {
          enableForm.classList.add('is-hidden');
          enableBtn.classList.remove('is-hidden');
        });
        formButtons.appendChild(formCancelBtn);

        enableForm.appendChild(formButtons);
        row.appendChild(enableForm);

        const enableBtn = document.createElement('peek-button');
        enableBtn.setAttribute('variant', 'primary');
        enableBtn.setAttribute('size', 'sm');
        enableBtn.textContent = 'Enable Sync';
        enableBtn.addEventListener('click', () => {
          enableBtn.classList.add('is-hidden');
          enableForm.classList.remove('is-hidden');
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

// Render the account-holder device panel: lists, renames and revokes the
// devices sync-enrolled on this account via the server's account-holder
// /devices routes (apps/server/index.js — GET/PATCH/DELETE /devices, keyed
// off the same serverUrl/apiKey the Sync panel above configures). Uses the
// shared <peek-*> component library rather than this file's hand-rolled
// style — see apps/desktop/CLAUDE.md "the <peek-*> component system is the
// DEFAULT". The "Add a device" card mints a single-use enrolment code via
// api.sync.createEnrolmentCode() (server route: POST /devices/enrolment-codes),
// which a new device exchanges for its own key at POST /enrol.
const renderDevicesSettings = async () => {
  const container = document.createElement('div');
  container.className = 'devices-panel';

  const newDeviceCard = document.createElement('peek-card');
  const newDeviceHeader = document.createElement('span');
  newDeviceHeader.slot = 'header';
  newDeviceHeader.textContent = 'Add a device';
  newDeviceCard.appendChild(newDeviceHeader);
  const newDeviceBody = document.createElement('p');
  newDeviceBody.style.cssText = 'margin: 0; color: var(--text-tertiary); font-size: 13px;';
  newDeviceBody.textContent =
    "Create a one-time code, then enter it — along with this server's URL — on the new " +
    "device's Sync panel.";
  newDeviceCard.appendChild(newDeviceBody);

  const codeDisplay = document.createElement('p');
  codeDisplay.dataset.role = 'enrolment-code-display';
  codeDisplay.style.cssText = 'margin: 8px 0 0; font-family: monospace; font-size: 14px; color: var(--text-primary); display: none;';
  newDeviceCard.appendChild(codeDisplay);

  const newDeviceFooter = document.createElement('div');
  newDeviceFooter.slot = 'footer';
  const addDeviceBtn = document.createElement('peek-button');
  addDeviceBtn.dataset.role = 'add-device-button';
  addDeviceBtn.setAttribute('variant', 'primary');
  addDeviceBtn.setAttribute('size', 'sm');
  addDeviceBtn.textContent = 'Create code';
  const showCodeError = (message) => {
    codeDisplay.textContent = `Failed to create code: ${message}`;
    codeDisplay.style.color = 'var(--error-text, #dc2626)';
    codeDisplay.style.display = '';
  };
  addDeviceBtn.addEventListener('click', async () => {
    try {
      const result = await runWithBusyButton(addDeviceBtn, 'Creating…', () => api.sync.createEnrolmentCode());
      if (!result.success) {
        showCodeError(result.error);
        return;
      }
      const { code, expiresAt } = result.data || {};
      const expires = expiresAt ? new Date(expiresAt).toLocaleString() : 'unknown';
      codeDisplay.textContent = `Code: ${code} — expires ${expires}`;
      codeDisplay.style.color = '';
      codeDisplay.style.display = '';
    } catch (err) {
      showCodeError(err.message || String(err));
    }
  });
  newDeviceFooter.appendChild(addDeviceBtn);
  newDeviceCard.appendChild(newDeviceFooter);
  container.appendChild(newDeviceCard);

  const statusLine = document.createElement('p');
  statusLine.className = 'devices-panel-status';
  statusLine.style.cssText = 'color: var(--text-tertiary); font-size: 13px;';
  container.appendChild(statusLine);

  const listContainer = document.createElement('div');
  listContainer.className = 'devices-panel-list';
  listContainer.style.cssText = 'display: flex; flex-direction: column; gap: 12px; margin-top: 12px;';
  container.appendChild(listContainer);

  const renderDeviceCard = (device) => {
    const card = document.createElement('peek-card');
    card.dataset.deviceId = device.id;
    if (device.revoked_at) {
      card.dataset.revoked = 'true';
    }

    const header = document.createElement('div');
    header.slot = 'header';
    header.style.cssText = 'display: flex; align-items: center; justify-content: space-between; width: 100%;';
    const labelSpan = document.createElement('span');
    labelSpan.className = 'device-label';
    labelSpan.textContent = device.label || '(unnamed device)';
    header.appendChild(labelSpan);
    const badge = document.createElement('span');
    badge.className = 'device-badge';
    badge.style.cssText = device.revoked_at
      ? 'font-size: 12px; color: var(--text-tertiary);'
      : 'font-size: 12px; color: var(--accent-primary);';
    // `current` is the server's word for "the key that made this request" —
    // i.e. this install. Named, since revoking it disconnects this very app.
    badge.textContent = device.revoked_at ? 'Revoked' : device.current ? 'This device' : 'Active';
    if (device.current) {
      card.dataset.current = 'true';
    }
    header.appendChild(badge);
    card.appendChild(header);

    const meta = document.createElement('div');
    meta.className = 'device-meta';
    meta.style.cssText = 'display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--text-secondary);';
    const created = document.createElement('div');
    created.textContent = `Created: ${device.created_at ? new Date(device.created_at).toLocaleString() : 'unknown'}`;
    meta.appendChild(created);
    const lastSeen = document.createElement('div');
    lastSeen.textContent = `Last seen: ${device.last_seen_at ? new Date(device.last_seen_at).toLocaleString() : 'never'}`;
    meta.appendChild(lastSeen);
    card.appendChild(meta);

    if (!device.revoked_at) {
      const footer = document.createElement('div');
      footer.slot = 'footer';
      footer.style.cssText = 'display: flex; gap: 8px; align-items: center;';

      const renameInput = document.createElement('peek-input');
      renameInput.dataset.role = 'rename-input';
      renameInput.placeholder = 'Device name';
      renameInput.value = device.label || '';
      renameInput.style.cssText = 'flex: 1;';
      footer.appendChild(renameInput);

      const renameBtn = document.createElement('peek-button');
      renameBtn.dataset.role = 'rename-button';
      renameBtn.setAttribute('variant', 'secondary');
      renameBtn.setAttribute('size', 'sm');
      renameBtn.textContent = 'Rename';
      renameBtn.addEventListener('click', async () => {
        const label = (renameInput.value || '').trim();
        if (!label) {
          alert('Device name cannot be empty');
          return;
        }
        const result = await runWithBusyButton(renameBtn, 'Renaming…', () => api.sync.renameDevice(device.id, label));
        if (!result.success) {
          alert(`Failed to rename device: ${result.error}`);
          return;
        }
        await loadDevices();
      });
      footer.appendChild(renameBtn);

      const revokeBtn = document.createElement('peek-button');
      revokeBtn.dataset.role = 'revoke-button';
      revokeBtn.setAttribute('variant', 'danger');
      revokeBtn.setAttribute('size', 'sm');
      revokeBtn.textContent = 'Revoke';
      revokeBtn.addEventListener('click', async () => {
        const name = device.label || 'this device';
        const prompt = device.current
          ? `Revoke "${name}" — the device you are using right now? Sync on this computer stops ` +
            'until you enroll again with a code from another device.'
          : `Revoke "${name}"? It will lose sync access immediately.`;
        if (!confirm(prompt)) return;
        const result = await runWithBusyButton(revokeBtn, 'Revoking…', () => api.sync.revokeDevice(device.id));
        if (!result.success) {
          alert(`Failed to revoke device: ${result.error}`);
          return;
        }
        if (result.data?.current) {
          // This install just revoked its own key. The main process has
          // already dropped the stored key (tile:sync:revoke-device), so
          // reloading the list here would only 401 — say what happened
          // instead, and bring the Sync panel's fields in line.
          listContainer.innerHTML = '';
          statusLine.textContent =
            "This device's key was revoked and removed from the Sync panel. To reconnect, " +
            'enroll again from the Sync panel with a code created on another device.';
          if (window._refreshSyncConfig) await window._refreshSyncConfig();
          return;
        }
        await loadDevices();
      });
      footer.appendChild(revokeBtn);

      card.appendChild(footer);
    }

    return card;
  };

  const loadDevices = async () => {
    listContainer.innerHTML = '';
    statusLine.textContent = '';

    // One round trip: the handler checks the config itself and says so with
    // `notConfigured` rather than making this read the config first.
    const result = await api.sync.listDevices();
    if (!result.success) {
      statusLine.textContent = result.notConfigured
        ? 'Configure sync (Server URL and API Key, above) to manage devices.'
        : `Failed to load devices: ${result.error}`;
      return;
    }

    const devices = result.data || [];
    if (devices.length === 0) {
      statusLine.textContent = 'No devices yet.';
      return;
    }

    devices.forEach((device) => listContainer.appendChild(renderDeviceCard(device)));
  };

  // Exposed so the sidebar nav click handler can refresh this panel — the
  // Sync panel above may change serverUrl/apiKey after this panel already
  // rendered once, same pattern as window._refreshPermissionsList.
  window._refreshDevicesList = loadDevices;

  await loadDevices();

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

  const addBtn = document.createElement('peek-button');
  addBtn.variant = 'primary';
  addBtn.textContent = 'Add Profile';
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
    const card = document.createElement('peek-card');

    // Profile header (name + switch + delete)
    const header = document.createElement('div');
    header.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 8px;';

    const isCurrentProfile = currentProfile && profile.id === currentProfile.id;

    // Profile name
    const nameEl = document.createElement('span');
    nameEl.textContent = isCurrentProfile ? `${profile.name} (current)` : profile.name;
    nameEl.style.cssText = 'flex: 1; font-weight: 500;';
    header.appendChild(nameEl);

    // No radio component exists; non-current profiles get a Switch button
    if (!isCurrentProfile) {
      const switchBtn = document.createElement('peek-button');
      switchBtn.size = 'sm';
      switchBtn.variant = 'primary';
      switchBtn.textContent = 'Switch';
      switchBtn.addEventListener('click', () => {
        console.log(`[profiles] Switching to profile: ${profile.name} (folder: ${profile.folder})`);
        if (confirm(`Switch to "${profile.name}"?\n\nThe app will restart to apply the change.`)) {
          console.log('[profiles] User confirmed switch');
          api.profiles.switch(profile.folder).then(result => {
            if (!result.success) {
              console.error('[profiles] Switch failed:', result.error);
              alert(`Failed to switch profile: ${result.error}`);
            }
          });
        } else {
          console.log('[profiles] User cancelled switch');
        }
      });
      header.appendChild(switchBtn);
    }

    // Delete button (disabled for default or active)
    const deleteBtn = document.createElement('peek-button');
    deleteBtn.size = 'sm';
    deleteBtn.variant = 'danger';
    deleteBtn.textContent = 'Delete';
    deleteBtn.disabled = !!(profile.isDefault || isCurrentProfile);
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
  const dialog = document.createElement('peek-dialog');
  dialog.modal = true;
  dialog.size = 'sm';

  const title = document.createElement('span');
  title.slot = 'header';
  title.textContent = 'Add Profile';
  dialog.appendChild(title);

  const input = document.createElement('peek-input');
  input.type = 'text';
  input.placeholder = 'Profile name (e.g., Work, Personal)';
  dialog.appendChild(input);

  const footer = document.createElement('div');
  footer.slot = 'footer';
  footer.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end;';

  const cancelBtn = document.createElement('peek-button');
  cancelBtn.variant = 'secondary';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => dialog.close());
  footer.appendChild(cancelBtn);

  const createBtn = document.createElement('peek-button');
  createBtn.variant = 'primary';
  createBtn.textContent = 'Create';
  createBtn.addEventListener('click', async () => {
    const name = input.value.trim();
    if (!name) {
      alert('Please enter a profile name');
      return;
    }

    const result = await api.profiles.create(name);
    if (result.success) {
      dialog.close();
      // Refresh the profiles section
      const newContent = await renderProfilesSettings();
      parentContainer.replaceWith(newContent);
    } else {
      alert(`Failed to create profile: ${result.error}`);
    }
  });
  footer.appendChild(createBtn);
  dialog.appendChild(footer);

  dialog.addEventListener('close', () => dialog.remove());
  document.body.appendChild(dialog);
  dialog.open = true;

  // peek-input.focus() forwards to its inner field, which exists only after
  // the first render.
  await input.updateComplete;
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
    stat.className = 'stat-tile';
    stat.innerHTML = `
      <div class="stat-tile-value">${value}</div>
      <div class="stat-tile-label">${label}</div>
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
      const btn = document.createElement('peek-button');
      btn.variant = 'secondary';
      btn.size = 'sm';
      btn.textContent = `${tableName} (${count.toLocaleString()})`;

      btn.addEventListener('click', async () => {
        // Update active state across all groups
        tableList.querySelectorAll('peek-button').forEach(b => {
          b.variant = 'secondary';
        });
        btn.variant = 'primary';

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

  const refreshBtn = document.createElement('peek-button');
  refreshBtn.variant = 'secondary';
  refreshBtn.textContent = 'Refresh All';
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

  // ── Runtime debug toggles (top of pane) ──────────────────────────────
  //
  // Two flags toggleable without a restart:
  //   - verbose: enables the codebase's `DEBUG && console.log(...)` lines
  //     in the main process. Output goes to <userData>/logs/main.log and
  //     renderer.log.
  //   - devtools: NEW BrowserWindows are created with devTools enabled.
  //     Existing windows are unaffected (Electron does not allow flipping
  //     devTools post-creation — close and reopen to inspect).
  //
  // Backed by the same `peek debug` / `peek devtools` cmd-palette commands.
  // The change listener subscribes to `peek:debug:changed` so toggles
  // stay in sync if the flag was flipped from elsewhere.
  const debugSection = document.createElement('div');
  debugSection.className = 'form-section';
  debugSection.style.marginBottom = '24px';

  const debugTitle = document.createElement('h3');
  debugTitle.className = 'form-section-title';
  debugTitle.textContent = 'Debug toggles';
  debugSection.appendChild(debugTitle);

  let debugState = { verbose: false, devtools: false };
  try {
    const res = await api.debugFlags?.get?.();
    if (res?.success) debugState = res.state;
  } catch { /* fall back to defaults */ }

  let verboseInput = null;
  let devtoolsInput = null;

  const verboseGroup = createCheckbox(
    'Verbose logging',
    debugState.verbose,
    async (newVal) => {
      try {
        const res = await api.debugFlags?.set?.({ verbose: newVal });
        if (res?.success) debugState = res.state;
      } catch { /* ignore */ }
    },
    { helpText: 'Enables DEBUG-gated logging across the main process. Output lands in <userData>/logs/main.log and renderer.log.' }
  );
  // Track the checkbox input so the pubsub listener can re-sync it
  // without re-rendering the whole pane.
  verboseInput = verboseGroup.querySelector('peek-switch');
  debugSection.appendChild(verboseGroup);

  const devtoolsGroup = createCheckbox(
    'DevTools on new windows',
    debugState.devtools,
    async (newVal) => {
      try {
        const res = await api.debugFlags?.set?.({ devtools: newVal });
        if (res?.success) debugState = res.state;
      } catch { /* ignore */ }
    },
    { helpText: 'New windows are created with DevTools enabled (Cmd+Opt+I). Existing windows are unaffected — close and reopen to inspect.' }
  );
  devtoolsInput = devtoolsGroup.querySelector('peek-switch');
  debugSection.appendChild(devtoolsGroup);

  // Keep checkboxes in sync if the flag is flipped from somewhere else
  // (cmd palette, another window). Subscription auto-tears-down when
  // the settings tile shuts down.
  if (api.pubsub?.subscribe) {
    api.pubsub.subscribe('peek:debug:changed', (state) => {
      if (!state || typeof state !== 'object') return;
      debugState = { verbose: !!state.verbose, devtools: !!state.devtools };
      if (verboseInput) verboseInput.checked = debugState.verbose;
      if (devtoolsInput) devtoolsInput.checked = debugState.devtools;
    });
  }

  container.appendChild(debugSection);

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
    const btn = document.createElement('peek-button');
    btn.variant = 'secondary';
    btn.textContent = text;
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

  // Feature management (enable/disable, install, per-feature Options) lives
  // ENTIRELY in the dedicated Features Manager now — Settings no longer owns
  // a Features pane. This nav item is just a discoverability pointer that
  // opens the Features Manager window instead of switching to a local pane.
  const featuresNav = document.createElement('a');
  featuresNav.className = 'nav-item';
  featuresNav.textContent = 'Features ↗';
  featuresNav.title = 'Manage features in the Features Manager';
  featuresNav.addEventListener('click', (e) => {
    e.preventDefault();
    api.window.open('peek://features-manager/manage.html', {
      key: 'features-manage',
      width: 900,
      height: 650,
      title: 'Features',
    });
  });
  sidebarNav.appendChild(featuresNav);

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

  // Re-render the Extensions section when chrome extensions finish loading.
  // loadEnabledChromeExtensions() is async and fires without await at startup,
  // so a settings window opened before it completes would see empty
  // getChromeExtensionUiEntries() → no popup/options buttons. The
  // chrome-extensions:loaded event (published by entry.ts after the async
  // load completes) triggers a full re-render of the section content so
  // the buttons always appear regardless of open-vs-load ordering.
  api.subscribe('chrome-extensions:loaded', async () => {
    // Clear and re-render privacy section content.
    while (privacySection.childNodes.length > 1) {
      // Keep the first child (the h2 title); remove everything else.
      privacySection.removeChild(privacySection.lastChild);
    }
    const refreshed = await renderPrivacySettings();
    privacySection.appendChild(refreshed);
  });

  // Add Permissions section (between Extensions and Dark Mode).
  // Lists per-origin web permission decisions persisted by the page-host
  // permission handler (geolocation, camera/mic, etc.) and lets the user
  // revoke them. See apps/desktop/main/permission-handler.ts +
  // permission-store.ts.
  const permissionsNav = document.createElement('a');
  permissionsNav.className = 'nav-item';
  permissionsNav.dataset.section = 'permissions';
  // Label + live count badge — reads "Permissions (3)" when there are 3
  // stored decisions, just "Permissions" when there are none. Updated by
  // window._refreshPermissionsCount whenever the list changes.
  const permissionsNavLabel = document.createElement('span');
  permissionsNavLabel.textContent = 'Permissions';
  permissionsNav.appendChild(permissionsNavLabel);
  const permissionsNavCount = document.createElement('span');
  permissionsNavCount.style.cssText = 'margin-left: 6px; opacity: 0.6;';
  permissionsNav.appendChild(permissionsNavCount);
  window._setPermissionsNavCount = (n) => {
    permissionsNavCount.textContent = (typeof n === 'number' && n > 0) ? `(${n})` : '';
  };
  permissionsNav.addEventListener('click', () => {
    showSection('permissions');
    if (window._refreshPermissionsList) {
      window._refreshPermissionsList();
    }
  });
  sidebarNav.appendChild(permissionsNav);

  const permissionsSection = document.createElement('div');
  permissionsSection.className = 'section';
  permissionsSection.id = 'section-permissions';

  const permissionsTitle = document.createElement('h2');
  permissionsTitle.className = 'section-title';
  permissionsTitle.textContent = 'Permissions';
  permissionsSection.appendChild(permissionsTitle);

  renderPermissionsSettings().then(content => {
    permissionsSection.appendChild(content);
  });

  contentArea.appendChild(permissionsSection);

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

  // Add Devices management section (between Sync and Profiles)
  const devicesNav = document.createElement('a');
  devicesNav.className = 'nav-item';
  devicesNav.textContent = 'Devices';
  devicesNav.dataset.section = 'devices';
  devicesNav.addEventListener('click', () => {
    showSection('devices');
    if (window._refreshDevicesList) {
      window._refreshDevicesList();
    }
  });
  sidebarNav.appendChild(devicesNav);

  const devicesSection = document.createElement('div');
  devicesSection.className = 'section';
  devicesSection.id = 'section-devices';

  const devicesTitle = document.createElement('h2');
  devicesTitle.className = 'section-title';
  devicesTitle.textContent = 'Devices';
  devicesSection.appendChild(devicesTitle);

  // Load devices content async
  renderDevicesSettings().then(content => {
    devicesSection.appendChild(content);
  });

  contentArea.appendChild(devicesSection);

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

  // Add Integrations section (MCP server toggle + future external-tool wiring)
  const integrationsNav = document.createElement('a');
  integrationsNav.className = 'nav-item';
  integrationsNav.textContent = 'Integrations';
  integrationsNav.dataset.section = 'integrations';
  integrationsNav.addEventListener('click', () => showSection('integrations'));
  sidebarNav.appendChild(integrationsNav);

  const integrationsSection = document.createElement('div');
  integrationsSection.className = 'section';
  integrationsSection.id = 'section-integrations';

  const integrationsSectionTitle = document.createElement('h2');
  integrationsSectionTitle.className = 'section-title';
  integrationsSectionTitle.textContent = 'Integrations';
  integrationsSection.appendChild(integrationsSectionTitle);

  renderIntegrationsSettings().then(content => {
    integrationsSection.appendChild(content);
  });

  contentArea.appendChild(integrationsSection);

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
  const quitBtn = document.createElement('peek-button');
  quitBtn.variant = 'secondary';
  quitBtn.className = 'quit-btn';
  quitBtn.textContent = 'Quit';
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
