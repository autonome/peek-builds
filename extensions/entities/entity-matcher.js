/**
 * Entity Matcher - Deduplication and matching
 *
 * Handles matching extracted entities against existing entities in the store.
 * Uses exact name matching and alias matching for Phase 1.
 */

import { findEntity, createEntity, addObservation, normalizeName, isEntitySuppressed } from './entity-store.js';

// Generic names that should never be stored as entities
const BLOCKLIST = new Set([
  'event', 'article', 'person', 'organization', 'product', 'news',
  'home', 'about', 'contact', 'menu', 'search', 'loading', 'unknown',
  'untitled', 'none', 'n/a', 'tbd', 'lorem ipsum', 'test', 'example',
  'admin', 'user', 'guest', 'anonymous', 'null', 'undefined',
  'website', 'page', 'site', 'blog', 'shop', 'store', 'app',
  'privacy policy', 'terms of service', 'cookie policy', 'subscribe',
  'sign in', 'sign up', 'log in', 'register', 'learn more', 'read more',
  'click here', 'view more', 'see more', 'show more', 'load more',
]);

/**
 * Check if an entity name should be blocked (too generic or noise)
 */
function isBlocklisted(name) {
  if (!name) return true;
  const n = name.trim();
  // Too short
  if (n.length < 2) return true;
  // All numbers
  if (/^\d+$/.test(n)) return true;
  // All punctuation/symbols
  if (/^[\d\s.,;:!?$%/\-@#&*()[\]{}|\\<>]+$/.test(n)) return true;
  // Generic blocklist
  if (BLOCKLIST.has(n.toLowerCase())) return true;
  return false;
}

/**
 * Process a batch of extracted entities from a page.
 * For each entity: find existing match or create new, then add observation.
 *
 * @param {Array<Object>} rawEntities - Entities from extractors
 * @param {Object} pageContext - Page context
 * @param {string} pageContext.url - Source page URL
 * @param {string} [pageContext.title] - Page title
 * @param {number} [confidenceThreshold=0.7] - Minimum confidence to store
 * @returns {Promise<Array<Object>>} Processed entities with IDs
 */
export async function processEntities(rawEntities, pageContext, confidenceThreshold = 0.7) {
  const processed = [];

  // Deduplicate within the batch by name+type
  const seen = new Map();
  const dedupedEntities = [];

  for (const entity of rawEntities) {
    // Filter by confidence threshold
    if (entity.confidence < confidenceThreshold) continue;

    // Filter blocklisted names
    if (isBlocklisted(entity.name)) continue;

    // Filter entities suppressed by user feedback
    if (await isEntitySuppressed(entity.name, entity.entityType)) continue;

    const key = `${normalizeName(entity.name)}:${entity.entityType}`;

    if (seen.has(key)) {
      // Keep higher confidence version
      const existing = seen.get(key);
      if (entity.confidence > existing.confidence) {
        seen.set(key, entity);
        // Update in deduped array
        const idx = dedupedEntities.findIndex(e =>
          `${normalizeName(e.name)}:${e.entityType}` === key
        );
        if (idx >= 0) dedupedEntities[idx] = entity;
      }
    } else {
      seen.set(key, entity);
      dedupedEntities.push(entity);
    }
  }

  // Process each deduplicated entity
  for (const entity of dedupedEntities) {
    try {
      // Try to find existing entity
      const existing = await findEntity(entity.name, entity.entityType);

      if (existing) {
        // Add observation to existing entity
        await addObservation(existing.id, {
          url: pageContext.url,
          confidence: entity.confidence,
          extractor: entity.extractor,
          pageTitle: pageContext.title || '',
          context: entity.context || ''
        });

        processed.push({
          id: existing.id,
          name: existing.content,
          entityType: entity.entityType,
          confidence: entity.confidence,
          isNew: false
        });
      } else {
        // Create new entity
        const result = await createEntity(entity);

        if (result.success) {
          // Add first observation
          await addObservation(result.data.id, {
            url: pageContext.url,
            confidence: entity.confidence,
            extractor: entity.extractor,
            pageTitle: pageContext.title || '',
            context: entity.context || ''
          });

          processed.push({
            id: result.data.id,
            name: entity.name,
            entityType: entity.entityType,
            confidence: entity.confidence,
            isNew: true
          });
        }
      }
    } catch (err) {
      console.warn('[entities:matcher] Failed to process entity:', entity.name, err.message);
    }
  }

  return processed;
}
