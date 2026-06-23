/**
 * Pure data-shaping helpers for the Install History section of the
 * features-manager Manage page.
 *
 * These have NO DOM / Electron / IPC dependencies so they can be unit-tested
 * directly under `node --test` (see tests/unit/features-manager-history.test.js)
 * and imported by manage.js at renderer runtime.
 *
 * Row shape (from `api.features.history()` -> `{ entries: rows }`), one row per
 * `features_history` table row:
 *   { featureId, event, version, sourceType, sourceUri, publisher,
 *     capabilities, timestamp }
 * `event` is one of: install | update | update-failed | uninstall.
 * `timestamp` is an ISO-8601 string.
 */

// Human-readable label per event type. Unknown events fall through to a
// title-cased version of the raw event string.
const EVENT_LABELS = {
  install: 'Installed',
  update: 'Updated',
  'update-failed': 'Update failed',
  uninstall: 'Uninstalled',
  remove: 'Removed',
};

/**
 * Map a raw event string to a human-readable label.
 * @param {string} event
 * @returns {string}
 */
export function eventLabel(event) {
  if (!event) return 'Unknown';
  if (EVENT_LABELS[event]) return EVENT_LABELS[event];
  // Fallback: 'some-event' -> 'Some event'
  const spaced = String(event).replace(/[-_]/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * CSS modifier class suffix for an event badge. Keeps the badge color logic
 * in one place so renderer + tests agree. Unknown events map to 'default'.
 * @param {string} event
 * @returns {string}
 */
export function eventBadgeClass(event) {
  switch (event) {
    case 'install':
      return 'install';
    case 'update':
      return 'update';
    case 'update-failed':
      return 'update-failed';
    case 'uninstall':
    case 'remove':
      return 'uninstall';
    default:
      return 'default';
  }
}

/**
 * Format an ISO timestamp into a compact, human-readable absolute string.
 * Returns the raw input if it can't be parsed.
 * @param {string} isoString
 * @returns {string}
 */
export function formatHistoryTimestamp(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return isoString;
  // e.g. "Jun 22, 2026, 3:04 PM" — locale-independent enough for a log row.
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const mon = months[date.getMonth()];
  const day = date.getDate();
  const year = date.getFullYear();
  let hours = date.getHours();
  const mins = String(date.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  if (hours === 0) hours = 12;
  return `${mon} ${day}, ${year}, ${hours}:${mins} ${ampm}`;
}

/**
 * Derive a readable source description for a history row.
 * Prefers publisher (a handle/DID) when present, otherwise sourceUri,
 * prefixed by the sourceType. Returns '' when there's nothing to show.
 * @param {{sourceType?: string, sourceUri?: string, publisher?: string}} row
 * @returns {string}
 */
export function formatHistorySource(row) {
  if (!row) return '';
  const type = row.sourceType ? String(row.sourceType) : '';
  const detail = row.publisher
    ? String(row.publisher)
    : row.sourceUri
      ? String(row.sourceUri)
      : '';
  if (type && detail) return `${type} · ${detail}`;
  return type || detail || '';
}

/**
 * Shape one raw history row into the flat object the renderer draws.
 * Pure: no DOM, no side effects.
 * @param {object} row
 * @returns {{
 *   featureId: string,
 *   label: string,
 *   badgeClass: string,
 *   event: string,
 *   version: string,
 *   source: string,
 *   timestamp: string,
 *   timestampLabel: string,
 * }}
 */
export function formatHistoryRow(row) {
  const r = row || {};
  return {
    featureId: r.featureId || '(unknown)',
    label: eventLabel(r.event),
    badgeClass: eventBadgeClass(r.event),
    event: r.event || '',
    version: r.version ? String(r.version) : '',
    source: formatHistorySource(r),
    timestamp: r.timestamp || '',
    timestampLabel: formatHistoryTimestamp(r.timestamp),
  };
}

/**
 * Normalize + sort a list of raw history rows newest-first by timestamp.
 * The backend already orders DESC, but we sort defensively so the renderer
 * never trusts arrival order. Rows with unparseable/missing timestamps sort
 * to the end (treated as oldest), preserving their relative order (stable).
 * @param {object[]} rows
 * @returns {object[]} formatted rows, newest first
 */
export function buildHistoryRows(rows) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  const withKey = list.map((row, i) => {
    const t = row && row.timestamp ? Date.parse(row.timestamp) : NaN;
    return { row, i, t: Number.isNaN(t) ? -Infinity : t };
  });
  withKey.sort((a, b) => {
    if (b.t !== a.t) return b.t - a.t; // newest first
    return a.i - b.i;                  // stable for ties / unparseable
  });
  return withKey.map((x) => formatHistoryRow(x.row));
}
