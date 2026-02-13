/**
 * Entity Store - CRUD operations for entity items
 *
 * Uses api.datastore to manage entity items (type='entity') and
 * entity observations (item_events on entity items).
 */

const api = window.app;

/**
 * Create a new entity item
 * @param {Object} entity - Entity data
 * @param {string} entity.name - Canonical name
 * @param {string} entity.entityType - Entity type (person, place, org, etc.)
 * @param {number} entity.confidence - Overall confidence score
 * @param {Object} entity.attributes - Type-specific attributes
 * @param {string[]} [entity.aliases] - Alternative names
 * @returns {Promise<{success: boolean, data?: Object, error?: string}>}
 */
export async function createEntity(entity) {
  const metadata = {
    entityType: entity.entityType,
    aliases: entity.aliases || [],
    attributes: entity.attributes || {},
    confidence: entity.confidence || 0.5,
    mergedFrom: [],
    extractor: entity.extractor || 'unknown'
  };

  const result = await api.datastore.addItem('entity', {
    content: entity.name,
    metadata: JSON.stringify(metadata)
  });

  if (result.success) {
    // Auto-tag with entity type
    try {
      const tagResult = await api.datastore.getOrCreateTag(`entity:${entity.entityType}`);
      if (tagResult.success) {
        await api.datastore.tagItem(result.data.id, tagResult.data.tag.id);
      }
    } catch (err) {
      console.warn('[entities:store] Failed to auto-tag entity:', err.message);
    }
  }

  return result;
}

/**
 * Record an observation: entity X was seen on page Y
 * @param {string} entityId - Entity item ID
 * @param {Object} observation - Observation data
 * @param {string} observation.url - Source page URL
 * @param {number} observation.confidence - Extraction confidence for this observation
 * @param {string} observation.extractor - Which extractor found it
 * @param {string} [observation.pageTitle] - Title of the source page
 * @param {string} [observation.extractedText] - Text snippet around the entity
 * @returns {Promise<{success: boolean, data?: Object, error?: string}>}
 */
export async function addObservation(entityId, observation) {
  // Check for dedup: one observation per entity per URL per day
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dayStart = today.getTime();

  const existing = await api.datastore.queryItemEvents({
    itemId: entityId,
    limit: 50,
    order: 'desc'
  });

  if (existing.success) {
    const alreadyObserved = existing.data.some(evt => {
      return evt.content === observation.url && evt.occurredAt >= dayStart;
    });
    if (alreadyObserved) {
      return { success: true, data: { deduplicated: true } };
    }
  }

  const result = await api.datastore.addItemEvent(entityId, {
    content: observation.url,
    value: observation.confidence || 0,
    occurredAt: Date.now(),
    metadata: JSON.stringify({
      extractor: observation.extractor || 'unknown',
      pageTitle: observation.pageTitle || '',
      extractedText: (observation.extractedText || '').slice(0, 300),
      context: observation.context || ''
    })
  });

  // Update entity item's visitCount, lastVisitAt, and frecencyScore
  if (result.success && (!result.data || !result.data.deduplicated)) {
    try {
      const item = await api.datastore.getItem(entityId);
      if (item.success && item.data) {
        const newVisitCount = (item.data.visitCount || 0) + 1;
        const nowMs = Date.now();
        // Calculate frecency: frequency * 10 * decay (matches calculateFrecency in datastore.ts)
        const daysSinceUse = 0; // just used now
        const decayFactor = 1 / (1 + daysSinceUse / 7);
        const frecencyScore = Math.round(newVisitCount * 10 * decayFactor);
        await api.datastore.updateItem(entityId, {
          visitCount: newVisitCount,
          lastVisitAt: nowMs,
          frecencyScore
        });
      }
    } catch (err) {
      console.warn('[entities:store] Failed to update entity frecency:', err.message);
    }
  }

  return result;
}

/**
 * Find an existing entity by name and type
 * @param {string} name - Entity name to search for
 * @param {string} entityType - Entity type to match
 * @returns {Promise<Object|null>} Matching entity or null
 */
export async function findEntity(name, entityType) {
  const result = await api.datastore.queryItems({ type: 'entity' });
  if (!result.success) return null;

  const normalized = normalizeName(name);

  for (const item of result.data) {
    // Skip deleted items
    if (item.deletedAt > 0) continue;

    let metadata = {};
    try { metadata = JSON.parse(item.metadata || '{}'); } catch {}

    // Must match entity type
    if (metadata.entityType !== entityType) continue;

    // Check exact name match (normalized)
    if (normalizeName(item.content) === normalized) {
      return item;
    }

    // Check aliases
    const aliases = metadata.aliases || [];
    if (aliases.some(a => normalizeName(a) === normalized)) {
      return item;
    }
  }

  return null;
}

/**
 * Get all entities, optionally filtered by type
 * @param {Object} [options] - Query options
 * @param {string} [options.entityType] - Filter by entity type
 * @param {number} [options.limit] - Max results
 * @param {string} [options.search] - Search term
 * @returns {Promise<Array<Object>>}
 */
export async function getEntities(options = {}) {
  const result = await api.datastore.queryItems({ type: 'entity' });
  if (!result.success) return [];

  let entities = result.data.filter(item => item.deletedAt === 0);

  // Parse metadata and filter by entityType
  entities = entities.map(item => {
    let metadata = {};
    try { metadata = JSON.parse(item.metadata || '{}'); } catch {}
    return { ...item, _meta: metadata };
  });

  if (options.entityType) {
    entities = entities.filter(e => e._meta.entityType === options.entityType);
  }

  if (options.search) {
    const search = options.search.toLowerCase();
    entities = entities.filter(e => {
      if (e.content && e.content.toLowerCase().includes(search)) return true;
      const aliases = e._meta.aliases || [];
      return aliases.some(a => a.toLowerCase().includes(search));
    });
  }

  // Sort by frecencyScore (desc), then createdAt (desc)
  entities.sort((a, b) => {
    if (b.frecencyScore !== a.frecencyScore) return b.frecencyScore - a.frecencyScore;
    return b.createdAt - a.createdAt;
  });

  if (options.limit) {
    entities = entities.slice(0, options.limit);
  }

  return entities;
}

/**
 * Get observations for an entity
 * @param {string} entityId - Entity item ID
 * @param {Object} [options] - Query options
 * @param {number} [options.limit] - Max results
 * @returns {Promise<Array<Object>>}
 */
export async function getObservations(entityId, options = {}) {
  const result = await api.datastore.queryItemEvents({
    itemId: entityId,
    limit: options.limit || 50,
    order: 'desc'
  });
  if (!result.success) return [];

  return result.data.map(evt => {
    let metadata = {};
    try { metadata = JSON.parse(evt.metadata || '{}'); } catch {}
    return {
      id: evt.id,
      url: evt.content,
      confidence: evt.value,
      occurredAt: evt.occurredAt,
      ...metadata
    };
  });
}

/**
 * Update an entity's metadata
 * @param {string} entityId - Entity item ID
 * @param {Object} updates - Fields to update in metadata
 * @returns {Promise<{success: boolean}>}
 */
export async function updateEntityMetadata(entityId, updates) {
  const item = await api.datastore.getItem(entityId);
  if (!item.success || !item.data) {
    return { success: false, error: 'Entity not found' };
  }

  let metadata = {};
  try { metadata = JSON.parse(item.data.metadata || '{}'); } catch {}

  // Merge updates into metadata
  Object.assign(metadata, updates);

  return api.datastore.updateItem(entityId, {
    metadata: JSON.stringify(metadata)
  });
}

/**
 * Normalize a name for comparison
 * Lowercases, trims whitespace, removes diacritics
 */
export function normalizeName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
    .replace(/\s+/g, ' '); // Collapse whitespace
}
