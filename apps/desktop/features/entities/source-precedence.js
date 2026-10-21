/**
 * Structured data takes precedence over text pattern matches.
 *
 * Structured data (JSON-LD, microformats, Open Graph, meta tags, a map URL) is
 * what the page states about itself, and its entities come out clean. The text
 * pattern extractors (`regex`, `regex-ner`) guess from wording and produce most
 * of the false positives. When both name the same thing on one page, the
 * structured-data entity is kept and the pattern match is dropped, even when
 * the pattern match claims a higher confidence or a different type: "Acme" as a
 * JSON-LD organization outranks "Acme" as a regex-ner person.
 *
 * Pattern matches that no structured data names are left alone.
 */

export const PATTERN_EXTRACTORS = new Set(['regex', 'regex-ner']);

/**
 * Whether an entity came from a text pattern extractor rather than structured data.
 * @param {Object} entity
 * @returns {boolean}
 */
export function isPatternMatch(entity) {
  return PATTERN_EXTRACTORS.has(entity?.extractor);
}

// Same normalisation as entity-store.js normalizeName(), which the matcher uses to
// decide that two names are one entity. Kept here so this module needs no datastore.
function nameKey(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Drop pattern matches whose name a structured-data entity on the same page also names.
 * @param {Array<Object>} entities - Raw extractor output for one page
 * @returns {Array<Object>}
 */
export function preferStructuredData(entities) {
  if (!Array.isArray(entities)) return entities;
  const structuredNames = new Set();
  for (const e of entities) {
    if (!isPatternMatch(e)) structuredNames.add(nameKey(e.name));
  }
  if (structuredNames.size === 0) return entities;
  return entities.filter(e => !isPatternMatch(e) || !structuredNames.has(nameKey(e.name)));
}
