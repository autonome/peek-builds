/**
 * Stats Widget — displays window count and other statistics
 */

const api = window.app;
const debug = api.debug;

const statsValue = document.getElementById('stats-value');

let windowCount = 0;

const updateDisplay = () => {
  if (!statsValue) return;

  const parts = [];
  parts.push(`${windowCount} window${windowCount !== 1 ? 's' : ''}`);

  statsValue.textContent = parts.join(' \u2022 ');

  debug && console.log('[hud:stats] Updated:', windowCount);
};

const refreshStats = async () => {
  try {
    const windowsResult = await api.window.list();
    if (windowsResult.success && windowsResult.windows) {
      windowCount = windowsResult.windows.length;
      updateDisplay();
    }
  } catch (error) {
    console.error('[hud:stats] Error:', error);
  }
};

const init = async () => {
  await refreshStats();

  // Refresh on window events
  api.subscribe('window:opened', () => refreshStats(), api.scopes.GLOBAL);
  api.subscribe('window:closed', () => refreshStats(), api.scopes.GLOBAL);

  // Periodic fallback
  setInterval(refreshStats, 5000);
};

init().catch(error => console.error('[hud:stats] Init error:', error));
