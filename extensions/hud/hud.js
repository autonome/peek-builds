/**
 * HUD Display Script
 *
 * Reactive display showing current mode, IZUI state, and window context.
 */

const api = window.app;
const debug = api.debug;

console.log('[hud] Display script loaded');

// DOM elements
const modeValue = document.getElementById('mode-value');
const izuiValue = document.getElementById('izui-value');
const windowTitle = document.getElementById('window-title');
const statsValue = document.getElementById('stats-value');

// Current state
let currentMode = 'default';
let currentModeMetadata = {};
let currentIzuiState = 'idle';
let currentWindowInfo = null;
let windowCount = 0;

/**
 * Update mode display
 */
const updateModeDisplay = () => {
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

  debug && console.log('[hud] Updated mode display:', displayText);
};

/**
 * Update IZUI state display
 */
const updateIzuiDisplay = () => {
  if (!izuiValue) return;

  // Remove old state classes
  izuiValue.classList.remove('izui-idle', 'izui-transient', 'izui-active', 'izui-overlay');

  izuiValue.textContent = currentIzuiState;
  izuiValue.classList.add(`izui-${currentIzuiState}`);

  debug && console.log('[hud] Updated IZUI display:', currentIzuiState);
};

/**
 * Update active window display
 */
const updateWindowDisplay = () => {
  if (!windowTitle) return;

  if (currentWindowInfo && currentWindowInfo.title) {
    let displayText = currentWindowInfo.title;

    // Add URL if available (for web pages)
    if (currentWindowInfo.url &&
        !currentWindowInfo.url.startsWith('peek://') &&
        currentWindowInfo.url !== currentWindowInfo.title) {
      displayText = currentWindowInfo.title;
    }

    windowTitle.textContent = displayText;
  } else {
    windowTitle.textContent = 'No active window';
  }

  debug && console.log('[hud] Updated window display:', currentWindowInfo?.title);
};

/**
 * Update stats display
 */
const updateStatsDisplay = () => {
  if (!statsValue) return;

  const parts = [];
  parts.push(`${windowCount} window${windowCount !== 1 ? 's' : ''}`);

  statsValue.textContent = parts.join(' • ');

  debug && console.log('[hud] Updated stats display:', windowCount);
};

/**
 * Refresh all window info
 */
const refreshWindowInfo = async () => {
  try {
    // Get list of windows
    const windowsResult = await api.window.list();
    if (windowsResult.success && windowsResult.data) {
      windowCount = windowsResult.data.length;

      // Find focused window (excluding HUD itself)
      const focusedWindow = windowsResult.data.find(w =>
        w.focused && !w.url?.includes('hud/hud.html')
      );

      if (focusedWindow) {
        currentWindowInfo = {
          title: focusedWindow.label || 'Untitled',
          url: focusedWindow.url || focusedWindow.source
        };
      } else {
        currentWindowInfo = null;
      }

      updateWindowDisplay();
      updateStatsDisplay();
    }
  } catch (error) {
    console.error('[hud] Error refreshing window info:', error);
  }
};

/**
 * Refresh IZUI state
 */
const refreshIzuiState = async () => {
  try {
    const state = await api.izui.getState();
    if (state) {
      currentIzuiState = state;
      updateIzuiDisplay();
    }
  } catch (error) {
    console.error('[hud] Error getting IZUI state:', error);
  }
};

/**
 * Refresh mode
 */
const refreshMode = async () => {
  try {
    const result = await api.context.get('mode');
    if (result.success && result.data) {
      currentMode = result.data.value || 'default';
      currentModeMetadata = result.data.metadata || {};
      updateModeDisplay();
    }
  } catch (error) {
    console.error('[hud] Error getting mode:', error);
  }
};

/**
 * Refresh all data
 */
const refreshAll = async () => {
  await Promise.all([
    refreshMode(),
    refreshIzuiState(),
    refreshWindowInfo()
  ]);
};

/**
 * Initialize HUD
 */
const init = async () => {
  console.log('[hud] Initializing display');

  // Initial data fetch
  await refreshAll();

  // Watch for mode changes
  api.context.watchMode((mode, entry) => {
    if (mode) {
      currentMode = mode;
      currentModeMetadata = entry?.metadata || {};
      updateModeDisplay();
    }
  });

  // Subscribe to IZUI state changes
  api.subscribe('izui:state-changed', (msg) => {
    if (msg.state) {
      currentIzuiState = msg.state;
      updateIzuiDisplay();
    }
  }, api.scopes.GLOBAL);

  // Subscribe to window focus changes
  api.subscribe('window:focused', () => {
    refreshWindowInfo();
  }, api.scopes.GLOBAL);

  // Subscribe to window open/close events
  api.subscribe('window:opened', () => {
    refreshWindowInfo();
  }, api.scopes.GLOBAL);

  api.subscribe('window:closed', () => {
    refreshWindowInfo();
  }, api.scopes.GLOBAL);

  // Periodic refresh (fallback for events we might miss)
  setInterval(() => {
    refreshAll();
  }, 5000);

  console.log('[hud] Display initialized');
};

// Start initialization
init().catch(error => {
  console.error('[hud] Initialization error:', error);
});
