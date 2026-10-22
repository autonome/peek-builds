/**
 * Ranking for the research view: a research's pages, the ones that held
 * attention longest first.
 *
 * Time on page is the only signal. `item_visits.duration` holds the
 * milliseconds a page was in front (`main/visit-dwell.ts`), so a page's weight
 * is the sum of that column over its visits. Ties go to the page visited more
 * often: equal time spread over more returns is the stronger interest.
 *
 * Visit count is counted from the same visit rows rather than read from
 * `items.visitCount`, so the order and the number on the row can never
 * disagree with each other.
 *
 * Pure — no datastore, no DOM, no tile API — so the order is decided in
 * `tests/unit/research-view-rank.test.js`.
 */

/**
 * A research's pages in display order.
 *
 * @param {Array<{id: string}>} items the space's page items, any order
 * @param {Array<{itemId: string, duration: number}>} visits every visit row for
 *   those items; rows for other items are ignored, and a row with no usable
 *   duration counts as a visit of zero time
 * @returns {Array<{item: object, totalMs: number, visitCount: number}>} longest
 *   total time first, then most visits. Pages that tie on both keep the order
 *   they arrived in, so a stable input gives a stable list.
 */
export const rankPagesByTimeOnPage = (items, visits) => {
  const safeItems = Array.isArray(items) ? items.filter((item) => item && item.id) : [];
  const safeVisits = Array.isArray(visits) ? visits : [];

  const totals = new Map();
  const counts = new Map();
  for (const visit of safeVisits) {
    if (!visit || !visit.itemId) continue;
    const ms = typeof visit.duration === 'number' && isFinite(visit.duration) && visit.duration > 0
      ? visit.duration
      : 0;
    totals.set(visit.itemId, (totals.get(visit.itemId) || 0) + ms);
    counts.set(visit.itemId, (counts.get(visit.itemId) || 0) + 1);
  }

  return safeItems
    .map((item) => ({
      item,
      totalMs: totals.get(item.id) || 0,
      visitCount: counts.get(item.id) || 0,
    }))
    .sort((a, b) => (b.totalMs - a.totalMs) || (b.visitCount - a.visitCount));
};

/**
 * Time on page as a row reads it: `4m 12s`, `38s`, `1h 7m`. A page with no
 * recorded time answers `—` rather than `0s`, because zero here means the
 * visit never ended (a visit open when the process died keeps 0) as often as
 * it means the page was closed at once.
 *
 * @param {number} ms
 * @returns {string}
 */
export const formatTimeOnPage = (ms) => {
  if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${Math.max(seconds, 1)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours}h ${restMinutes}m` : `${hours}h`;
};
