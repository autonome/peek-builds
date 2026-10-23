/**
 * Memory HUD page — Peek's total memory across every process, plus window
 * and pubsub counts. Opened pinned across workspaces by the `hud` command
 * (renderer/index.js registerCoreCommands()). Reads `api.app.metrics()`
 * (main/process-metrics.ts summarizeMemory()), which needs the trustedBuiltin
 * grant this page gets from main/pseudo-tiles.ts PSEUDO_TILES.
 */

const api = window.app;

const POLL_MS = 3000;

const totalEl = document.getElementById('memory-total');
const countEl = document.getElementById('process-count');
const byTypeEl = document.getElementById('by-type');
const otherEl = document.getElementById('other-stats');

/** Kilobytes as "123 MB" or "1.2 GB". */
const formatKb = (kb) => {
  const mb = kb / 1024;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
};

const formatNum = (n) => {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
};

// Chromium's process-type names (ProcessMetric.type) in plain words. Chromium
// calls every renderer a "Tab", but here those are pages, tiles and app chrome.
const TYPE_LABELS = {
  Browser: 'Main process',
  Tab: 'Web content',
  GPU: 'Graphics',
  Utility: 'Utility',
};

const rows = (pairs) => pairs.map(([label, value]) => {
  const l = document.createElement('span');
  l.className = 'label';
  l.textContent = label;
  const v = document.createElement('span');
  v.className = 'value';
  v.textContent = value;
  return [l, v];
}).flat();

const refreshMemory = async () => {
  const result = await api.app.metrics();
  if (!result?.success || !result.data) return;
  const { totalKb, processCount, byType } = result.data;
  totalEl.textContent = formatKb(totalKb);
  countEl.textContent = String(processCount);
  const types = Object.entries(byType || {})
    .sort((a, b) => b[1] - a[1])
    .map(([type, kb]) => [TYPE_LABELS[type] || type, formatKb(kb)]);
  byTypeEl.replaceChildren(...rows(types));
};

const refreshOther = async () => {
  const pairs = [];
  // Hidden windows too: the HUD reports how many of all live windows are visible.
  const windows = await api.window.list({ includeInternal: true, includeHidden: true });
  if (windows?.success && windows.windows) {
    const visible = windows.windows.filter(w => w.visible).length;
    pairs.push(['Windows visible', String(visible)]);
    pairs.push(['Windows total', String(windows.windows.length)]);
  }
  const pubsub = await api.pubsub.stats();
  if (pubsub?.success && pubsub.data) {
    const ps = pubsub.data;
    pairs.push(['Topics', `${ps.topicsUsedThisSession}/${ps.topicsRegistered}`]);
    pairs.push(['Published', formatNum(ps.messagesPublished)]);
    pairs.push(['Delivered', formatNum(ps.messagesDelivered)]);
  }
  otherEl.replaceChildren(...rows(pairs));
};

const refresh = async () => {
  try {
    await refreshMemory();
    await refreshOther();
  } catch (error) {
    console.error('[hud] refresh failed:', error);
  }
};

// Close this window. Force, so it is gone for good and does not come back at
// the next launch.
document.getElementById('close-hud').addEventListener('click', () => {
  api.window.close(undefined, { force: true });
});

const init = async () => {
  if (api.initialize) await api.initialize();
  await refresh();
  setInterval(refresh, POLL_MS);
};

init().catch(error => console.error('[hud] init failed:', error));
