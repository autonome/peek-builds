/**
 * Mode Widget — displays current mode and group context
 */

const api = window.app;
const debug = api.debug;

const modeValue = document.getElementById('mode-value');
const groupAccent = document.getElementById('group-accent');
const groupBanner = document.getElementById('group-banner');
const groupName = document.getElementById('group-name');
const widget = document.querySelector('.widget');

let currentMode = 'default';
let currentModeMetadata = {};

const updateDisplay = () => {
  if (!modeValue) return;

  // Remove old mode classes
  modeValue.classList.remove('mode-default', 'mode-page', 'mode-group', 'mode-settings');

  // Format mode display
  let displayText = currentMode;
  if (currentMode === 'group' && currentModeMetadata.groupName) {
    displayText = `group: ${currentModeMetadata.groupName}`;
  }

  modeValue.textContent = displayText;
  modeValue.classList.add(`mode-${currentMode}`);

  // Update group visual treatment
  if (currentMode === 'group' && currentModeMetadata.groupName) {
    const color = currentModeMetadata.color || '#999';
    groupAccent.style.background = color;
    groupAccent.style.display = '';
    groupName.textContent = currentModeMetadata.groupName;
    groupBanner.style.display = '';
    if (widget) widget.style.setProperty('--group-color', color + '40');
  } else {
    groupAccent.style.display = 'none';
    groupBanner.style.display = 'none';
    if (widget) widget.style.removeProperty('--group-color');
  }

  debug && console.log('[hud:mode] Updated:', displayText);
};

const refreshMode = async () => {
  try {
    const focusedWindowId = await api.window.getFocusedVisibleWindowId();
    const result = await api.context.get('mode', focusedWindowId);
    if (result.success && result.data) {
      currentMode = result.data.value || 'default';
      currentModeMetadata = result.data.metadata || {};
    } else {
      currentMode = 'default';
      currentModeMetadata = {};
    }
    updateDisplay();
  } catch (error) {
    console.error('[hud:mode] Error:', error);
  }
};

const init = async () => {
  await refreshMode();

  // Watch for mode changes
  api.context.watchMode((mode, entry) => {
    if (mode) {
      currentMode = mode;
      currentModeMetadata = entry?.metadata || {};
      updateDisplay();
    }
  });

  // Refresh on window focus changes
  api.subscribe('window:focused', () => refreshMode(), api.scopes.GLOBAL);
  api.subscribe('window:opened', () => refreshMode(), api.scopes.GLOBAL);
  api.subscribe('window:closed', () => refreshMode(), api.scopes.GLOBAL);

  // Periodic fallback
  setInterval(refreshMode, 5000);
};

init().catch(error => console.error('[hud:mode] Init error:', error));
