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

// Auto-resize window to fit content
let resizeTimer = null;
const autoResizeWindow = () => {
  // Debounce to avoid excessive resize calls
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const container = document.getElementById('hud-container');
    if (!container) return;
    // Measure the actual rendered height of the container content
    const contentHeight = container.scrollHeight + 2; // +2 for border
    const contentWidth = 300;
    api.window.resize(contentWidth, contentHeight);
    debug && console.log('[hud] Auto-resized window to:', contentWidth, contentHeight);
  }, 50);
};

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
  autoResizeWindow();

  debug && console.log('[hud] Updated stats display:', windowCount);
};

/**
 * Refresh all window info
 */
const refreshWindowInfo = async () => {
  try {
    // Get list of windows and the focused visible window ID
    const [windowsResult, focusedWindowId] = await Promise.all([
      api.window.list(),
      api.window.getFocusedVisibleWindowId()
    ]);

    if (windowsResult.success && windowsResult.windows) {
      windowCount = windowsResult.windows.length;

      // Find the focused visible window in the list
      const focusedWindow = focusedWindowId
        ? windowsResult.windows.find(w => w.id === focusedWindowId)
        : null;

      if (focusedWindow) {
        currentWindowInfo = {
          title: focusedWindow.title || 'Untitled',
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
    // Get the focused visible window's mode (not the HUD's own mode)
    const focusedWindowId = await api.window.getFocusedVisibleWindowId();
    const result = await api.context.get('mode', focusedWindowId);
    if (result.success && result.data) {
      currentMode = result.data.value || 'default';
      currentModeMetadata = result.data.metadata || {};
    } else {
      // No focused window or no mode set — show "default"
      currentMode = 'default';
      currentModeMetadata = {};
    }
    updateModeDisplay();
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

  // Auto-resize window to fit initial content
  autoResizeWindow();

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

  // Subscribe to window focus changes — refresh mode + window info
  api.subscribe('window:focused', () => {
    refreshMode();
    refreshWindowInfo();
  }, api.scopes.GLOBAL);

  // Subscribe to window open/close events
  api.subscribe('window:opened', () => {
    refreshMode();
    refreshWindowInfo();
  }, api.scopes.GLOBAL);

  api.subscribe('window:closed', () => {
    refreshMode();
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
