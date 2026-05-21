/**
 * Stats Widget — displays window counts and pubsub metrics
 */

const api = window.app;

const statsContent = document.getElementById('stats-content');

let visibleWindows = 0;
let backgroundWindows = 0;
let totalWindows = 0;
let pubsubTopicsUsed = 0;
let pubsubTopicsRegistered = 0;
let pubsubPublished = 0;
let pubsubDelivered = 0;

const formatNum = (n) => {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
};

const updateDisplay = () => {
  if (!statsContent) return;

  statsContent.innerHTML = [
    row('Visible', visibleWindows),
    row('Background', backgroundWindows),
    row('Total windows', totalWindows),
    row('Topics', `${pubsubTopicsUsed}/${pubsubTopicsRegistered}`),
    row('Published', formatNum(pubsubPublished)),
    row('Delivered', formatNum(pubsubDelivered)),
  ].join('');

};

const row = (label, value) =>
  `<span class="stat-label">${label}</span><span class="stat-value">${value}</span>`;

const refreshStats = async () => {
  try {
    // Fetch window list with internal windows included
    const windowsResult = await api.window.list({ includeInternal: true });
    if (windowsResult.success && windowsResult.windows) {
      const wins = windowsResult.windows;
      totalWindows = wins.length;
      visibleWindows = wins.filter(w => w.visible).length;
      backgroundWindows = totalWindows - visibleWindows;
    }

    // Fetch pubsub stats
    const pubsubResult = await api.pubsub.stats();
    if (pubsubResult.success && pubsubResult.data) {
      const ps = pubsubResult.data;
      pubsubTopicsUsed = ps.topicsUsedThisSession;
      pubsubTopicsRegistered = ps.topicsRegistered;
      pubsubPublished = ps.messagesPublished;
      pubsubDelivered = ps.messagesDelivered;
    }

    updateDisplay();
  } catch (error) {
    console.error('[hud:stats] Error:', error);
  }
};

const init = async () => {
  if (api.initialize) {
    await api.initialize();
  }

  await refreshStats();

  // Refresh on window events
  api.subscribe('window:opened', () => refreshStats());
  api.subscribe('window:closed', () => refreshStats());

  // Poll every 3 seconds for pubsub stats (they change frequently)
  setInterval(refreshStats, 3000);
};

init().catch(error => console.error('[hud:stats] Init error:', error));
