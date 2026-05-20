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
 * "typed" = user typed the URL from memory (strongest intent signal).
 * "bookmark" = opened via bookmark (explicit save, moderate signal).
 * "direct" = legacy source, treated as typed for backwards compat.
 */
export const VISIT_WEIGHTS = {
  /** User interacted with the page (clicked, scrolled, typed) */
  interacted: 2,
  /** User typed the URL directly (strongest navigation intent) */
  typed: 3,
  /** Opened via bookmark */
  bookmark: 1.5,
  /** Legacy "direct" source — treat as typed */
  direct: 3,
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
 *   - source: visit source string ('typed', 'bookmark', 'direct', etc.)
 * @param {number} [totalVisitCount] - Total visits (for extrapolation when sampling)
 * @returns {number} Integer frecency score (higher = more relevant)
 */
export function calculateItemFrecency(visits, totalVisitCount) {
  const SAMPLE_CAP = 20;
  const GRACE_PERIOD_DAYS = 3;

  // Cap sample size for performance; extrapolate if needed
  const sample = visits.length > SAMPLE_CAP ? visits.slice(0, SAMPLE_CAP) : visits;
  const total = totalVisitCount || visits.length;

  let score = 0;
  for (const visit of sample) {
    const rawAgeDays = (Date.now() - visit.timestamp) / (1000 * 60 * 60 * 24);
    // 3-day grace period: visits within grace period get full relevance
    const ageDays = Math.max(0, rawAgeDays - GRACE_PERIOD_DAYS);
    const decay = 1 / (1 + Math.pow(ageDays / DECAY_HALF_LIFE_DAYS, 0.5));
    const weight = visit.interacted
      ? VISIT_WEIGHTS.interacted
      : (VISIT_WEIGHTS[visit.source] || VISIT_WEIGHTS.default);
    score += weight * decay;
  }

  // Extrapolate if we sampled fewer than total visits
  if (sample.length < total && sample.length > 0) {
    score = score * total / sample.length;
  }

  return Math.round(score * 10);
}

export default calculateItemFrecency;
