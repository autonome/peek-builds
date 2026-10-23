/**
 * Window kinds for the HUD "Windows" section: turns the entries of
 * `api.window.list()` into plain-words kinds with a visible/hidden count each.
 * Pure, so it runs under node --test.
 *
 * Each feature's background window gets its own kind ("Feature: slides"), so
 * the section shows which features have woken and stayed alive.
 */

/** Plain-words kind of one window-list entry ({ url, visible, params }). */
export function classifyWindow(entry) {
  const url = typeof entry?.url === 'string' ? entry.url : '';
  const params = entry?.params || {};

  if (params.role === 'palette') return 'Command palette';
  if (url === 'peek://app/background.html') return 'Peek core';
  if (url.startsWith('peek://app/page/overlay.html')) return 'Page chrome';
  if (url.startsWith('chrome-extension://')) return 'Extension helper';

  const feature = /^peek:\/\/(?:ext\/)?([^/]+)\/background\.html(?:[?#].*)?$/.exec(url);
  if (feature && feature[1] !== 'app') return `Feature: ${feature[1]}`;

  if (params.keepLive === true) return 'Kept-alive peek/slide';
  if (url.startsWith('http://') || url.startsWith('https://')) return 'Web page';
  if (url.startsWith('peek://')) return 'App window';
  return 'Other';
}

/**
 * One row per kind: { kind, visible, hidden, total }, largest total first
 * (ties by name). Entries no rule matches are counted under "Other" and
 * passed to `onUnmatched` so the caller can log their URL.
 */
export function summarizeWindows(entries, onUnmatched) {
  const byKind = new Map();
  for (const entry of entries || []) {
    const kind = classifyWindow(entry);
    if (kind === 'Other' && onUnmatched) onUnmatched(entry);
    const row = byKind.get(kind) || { kind, visible: 0, hidden: 0, total: 0 };
    if (entry?.visible) row.visible += 1; else row.hidden += 1;
    row.total += 1;
    byKind.set(kind, row);
  }
  return [...byKind.values()].sort((a, b) => b.total - a.total || a.kind.localeCompare(b.kind));
}
