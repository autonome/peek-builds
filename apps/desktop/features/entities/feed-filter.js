/**
 * Feed page filtering for pattern-matched entities.
 *
 * A feed page (social timeline, mail inbox, calendar) lists many people, and
 * each of them is a name from the feed's contents rather than something the page
 * is about. Pattern matches on such a page are kept only when they also appear in
 * the page title ("Maria Garcia (@mgarcia) / Social" keeps Maria Garcia).
 *
 * A page counts as a feed when its text names more distinct people than an
 * ordinary article does. Counting names needs no list of feed sites and covers
 * self-hosted mail and calendar apps the same way as large ones.
 *
 * Only entities from the text pattern extractors are filtered: structured data
 * (JSON-LD, microformats, Open Graph) describes the page itself, typically the
 * site's own brand, and stays.
 *
 * The page's lead text is not used as evidence: on a feed it is the first item
 * of the feed, so its author would survive the filter.
 */

// Distinct pattern-matched person names above which a page is treated as a feed.
const FEED_PERSON_THRESHOLD = 10;

const PATTERN_EXTRACTORS = new Set(['regex', 'regex-ner']);

/**
 * Whether a set of extracted entities looks like it came from a feed page.
 * @param {Array<Object>} entities - Raw extractor output
 * @returns {boolean}
 */
export function isFeedPage(entities) {
  const names = new Set();
  for (const e of entities) {
    if (e.entityType === 'person' && PATTERN_EXTRACTORS.has(e.extractor)) {
      names.add(String(e.name).toLowerCase());
    }
  }
  return names.size > FEED_PERSON_THRESHOLD;
}

/**
 * Drop pattern-matched entities a feed page lists, unless the page title names them.
 * Returns the input unchanged for a page that is not a feed.
 * @param {Array<Object>} entities - Raw extractor output
 * @param {{ title?: string }} page - The page the entities came from
 * @returns {Array<Object>}
 */
export function filterFeedPageEntities(entities, page = {}) {
  if (!Array.isArray(entities) || !isFeedPage(entities)) return entities;
  const title = String(page.title || '').toLowerCase();
  return entities.filter(e => {
    if (!PATTERN_EXTRACTORS.has(e.extractor)) return true;
    const name = String(e.name || '').toLowerCase();
    return name.length > 0 && title.includes(name);
  });
}
