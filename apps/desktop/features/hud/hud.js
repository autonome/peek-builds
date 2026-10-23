/**
 * Memory HUD page — Peek's total memory across every process, plus window
 * and pubsub counts. Opened pinned across workspaces by the `hud` command
 * (features/hud/background.js). Reads `api.app.metrics()`
 * (main/process-metrics.ts summarizeMemory()) and `api.pubsub.stats()`, which
 * the manifest's `diagnostics` capability allows.
 */

import {
  HUD_BOUNDS_KEY, parseSavedBounds, visibleHudBounds, boundsChanged,
} from './hud-geometry.js';
import { summarizeWindows } from './hud-windows.js';

const api = window.app;

const POLL_MS = 3000;

const totalEl = document.getElementById('memory-total');
const countEl = document.getElementById('process-count');
const byTypeEl = document.getElementById('by-type');
const otherEl = document.getElementById('other-stats');
const windowsEl = document.getElementById('window-kinds');
const windowsTitleEl = document.getElementById('windows-title');
const loggedUnmatched = new Set();

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
    const total = windows.windows.length;
    const visible = windows.windows.filter(w => w.visible).length;
    pairs.push(['Windows', String(total)]);
    pairs.push(['Windows Shown/Hidden', `${visible}/${total - visible}`]);
  }
  if (windows?.success && windows.windows) {
    const kinds = summarizeWindows(windows.windows, (w) => {
      if (!loggedUnmatched.has(w?.url)) {
        loggedUnmatched.add(w?.url);
        console.warn('[hud] window matched no kind:', w?.url);
      }
    });
    windowsEl.replaceChildren(...rows(kinds.map(k => [k.kind, `${k.visible}/${k.hidden}`])));
    windowsTitleEl.hidden = kinds.length === 0;
  }
  const pubsub = await api.pubsub.stats();
  if (pubsub?.success && pubsub.data) {
    const ps = pubsub.data;
    // Topics used this session / topics registered.
    pairs.push(['Msg Topics Used/Known', `${ps.topicsUsedThisSession}/${ps.topicsRegistered}`]);
    pairs.push(['Msg Published', formatNum(ps.messagesPublished)]);
    pairs.push(['Msg Delivered', formatNum(ps.messagesDelivered)]);
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

// Size and position, kept so the next open (the `hud` command in
// renderer/index.js) starts where the user left it. There is no move event, so
// the bounds are polled and written only when they change.
const BOUNDS_POLL_MS = 500;
let lastSaved = null;

const saveBounds = async () => {
  const result = await api.window.getBounds();
  const b = parseSavedBounds(result?.bounds || result?.data || result);
  if (!b || !boundsChanged(b, lastSaved)) return;
  lastSaved = b;
  try { localStorage.setItem(HUD_BOUNDS_KEY, JSON.stringify(b)); } catch { /* storage unavailable */ }
};

// If the OS put the HUD where no display shows it, move it back to the default spot.
const ensureVisible = async () => {
  const result = await api.window.getBounds();
  const current = parseSavedBounds(result?.bounds || result?.data || result);
  const display = await api.window.getDisplayInfo();
  const displayBounds = display?.bounds || display?.data?.bounds;
  if (!current || !displayBounds) return;
  const fixed = visibleHudBounds(current, displayBounds);
  if (boundsChanged(fixed, current)) await api.window.setBounds(fixed);
};

// Close this window. Force, so it is gone for good and does not come back at
// the next launch.
document.getElementById('close-hud').addEventListener('click', async () => {
  try { await saveBounds(); } catch { /* close anyway */ }
  api.window.close(undefined, { force: true });
});

const init = async () => {
  if (api.initialize) await api.initialize();
  try { await ensureVisible(); } catch (error) { console.error('[hud] visibility check failed:', error); }
  setInterval(() => saveBounds().catch(() => {}), BOUNDS_POLL_MS);
  await refresh();
  setInterval(refresh, POLL_MS);
};

init().catch(error => console.error('[hud] init failed:', error));
