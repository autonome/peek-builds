/**
 * Frecency scoring algorithm for ranking items by recency and frequency.
 *
 * Frecency combines "frequency" and "recency" into a single score.
 * Recent visits contribute more than older ones via time decay,
 * and interactive visits (clicks, edits) count more than passive ones.
 *
 * The decay function uses a square-root curve: score halves after ~7 days,
 * then decays more slowly. This keeps frequently-visited items relevant
 * even if not visited today.
 *
 * @module frecency
 */

/**
 * Half-life in days for the decay curve.
 * After this many days, a visit's contribution is halved.
 */
export const DECAY_HALF_LIFE_DAYS = 7;

/**
 * Weight multipliers for different visit types.
 */
export const VISIT_WEIGHTS = {
  /** User interacted with the page (clicked, scrolled, typed) */
  interacted: 2,
  /** Direct navigation (typed URL, bookmark) */
  direct: 0.5,
  /** Default weight (link click, redirect, etc.) */
  default: 1
};

/**
 * Calculate frecency score for an item based on its visit history.
 *
 * Each visit contributes a weighted, time-decayed value to the total score.
 * The decay function is: 1 / (1 + sqrt(ageDays / 7))
 *
 * @param {Array<{ timestamp: number, interacted: number, source: string }>} visits
 *   Array of visit records. Each visit has:
 *   - timestamp: Unix epoch milliseconds of the visit
 *   - interacted: 1 if user interacted with the page, 0 otherwise
 *   - source: visit source string ('direct' gets lower weight)
 * @returns {number} Integer frecency score (higher = more relevant)
 */
export function calculateItemFrecency(visits) {
  let score = 0;
  for (const visit of visits) {
    const ageDays = (Date.now() - visit.timestamp) / (1000 * 60 * 60 * 24);
    const decay = 1 / (1 + Math.pow(ageDays / DECAY_HALF_LIFE_DAYS, 0.5));
    const weight = visit.interacted
      ? VISIT_WEIGHTS.interacted
      : (visit.source === 'direct' ? VISIT_WEIGHTS.direct : VISIT_WEIGHTS.default);
    score += weight * decay;
  }
  return Math.round(score * 10);
}

export default calculateItemFrecency;
