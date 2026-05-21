/**
 * Active Window Widget — displays title of focused visible window
 */

const api = window.app;

const windowTitle = document.getElementById('window-title');

let currentWindowInfo = null;

const updateDisplay = () => {
  if (!windowTitle) return;

  if (currentWindowInfo && currentWindowInfo.title) {
    windowTitle.textContent = currentWindowInfo.title;
  } else {
    windowTitle.textContent = 'No active window';
  }

};

const refreshWindowInfo = async () => {
  try {
    const [windowsResult, focusedWindowId] = await Promise.all([
      api.window.list({ includeInternal: true }),
      api.window.getFocusedVisibleWindowId()
    ]);

    if (windowsResult.success && windowsResult.windows) {
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

      updateDisplay();
    }
  } catch (error) {
    console.error('[hud:window] Error:', error);
  }
};

const init = async () => {
  if (api.initialize) {
    await api.initialize();
  }

  await refreshWindowInfo();

  // Refresh on window events
  api.subscribe('window:focused', () => refreshWindowInfo());
  api.subscribe('window:opened', () => refreshWindowInfo());
  api.subscribe('window:closed', () => refreshWindowInfo());

  // Periodic fallback
  setInterval(refreshWindowInfo, 5000);
};

init().catch(error => console.error('[hud:window] Init error:', error));
