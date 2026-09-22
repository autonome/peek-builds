/**
 * Workspace Panel — a global HUD window (docs/design/window-rules.md "The
 * workspace panel"). Names the active workspace and offers close/switch
 * controls. Opened already pinned across workspaces by
 * `features/spaces/background.js` (`showPanel`), never by a user pin action,
 * and carries no unpin control.
 *
 * Stays open for the life of the panel window: `showPanel()` reuses it across
 * a workspace switch (`spaces:panel-update`) rather than closing/reopening,
 * so this script only ever runs its `init()` once per window.
 */

import { getSpaceDisplayName, SPACE_TAG_PREFIX } from './config.js';

const api = window.app;

const params = new URLSearchParams(window.location.search);
let currentSpaceName = params.get('spaceName') || '';
let currentColor = params.get('color') || '';

const nameEl = () => document.getElementById('panel-name');
const selectEl = () => document.querySelector('peek-select.panel-switch');
const closeEl = () => document.querySelector('peek-button.panel-close');

function renderName() {
  const el = nameEl();
  if (el) el.textContent = currentSpaceName || 'Workspace';
}

/**
 * Theme the panel to the active workspace's accent color — the resolved
 * color `background.js showPanel()` passes (the same one the screen border
 * uses), read by `panel.css` through the `--panel-accent` custom property.
 */
function applyAccent() {
  const root = document.documentElement;
  if (currentColor) {
    root.style.setProperty('--panel-accent', currentColor);
  } else {
    root.style.removeProperty('--panel-accent');
  }
}

async function loadSwitchOptions() {
  const select = selectEl();
  if (!select || !api?.datastore?.getTagsByFrecency) return;
  const result = await api.datastore.getTagsByFrecency();
  if (!result.success) return;
  const options = result.data
    .filter((tag) => tag.name && tag.name.startsWith(SPACE_TAG_PREFIX))
    .map((tag) => getSpaceDisplayName(tag))
    .filter((name) => name && name !== currentSpaceName)
    .map((name) => ({ value: name, label: name }));
  select.options = [{ value: '', label: 'Switch to…', disabled: true }, ...options];
  select.value = '';
}

async function init() {
  renderName();
  applyAccent();
  await loadSwitchOptions();

  selectEl()?.addEventListener('change', (e) => {
    const target = e.detail?.value;
    if (!target) return;
    api.pubsub.publish('cmd:execute:switch space', { search: target });
  });

  closeEl()?.addEventListener('click', () => {
    api.pubsub.publish('cmd:execute:close space', {});
  });

  // Live update on workspace switch — the window itself is never closed or
  // reopened (see file header), so a reload-based refresh would be wrong.
  api.pubsub.subscribe('spaces:panel-update', (msg) => {
    if (msg?.spaceName) {
      currentSpaceName = msg.spaceName;
      currentColor = msg.color || '';
      renderName();
      applyAccent();
      loadSwitchOptions();
    }
  });
}

if (window.app) {
  (async () => {
    if (typeof api.initialize === 'function') {
      await api.initialize();
    }
    // See handoff.md's home.js DOMContentLoaded lesson: under load,
    // DOMContentLoaded can already have fired by the time this listener
    // registers, so it would never fire again — guard on readyState.
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  })();
}
