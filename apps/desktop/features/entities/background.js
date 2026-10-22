/**
 * Entities — background script handler.
 *
 * Stage 4a of peek MCP plan 3d7d9239: extraction work moves out of
 * the resident home tile. This bg tile is `lazy: true` with
 * `lazyEvents` covering every topic that drives it:
 *
 *   scripts:execute:entities-extract  ← rule engine, fired by manifest
 *                                       rules on page:content-ready /
 *                                       item:created (URL items only)
 *   entities:extract                  ← imperative request from page
 *                                       widget / "extract entities" cmd
 *   entities:search                   ← query API
 *   entities:get-for-url              ← lookup API
 *
 * The pipeline itself is unchanged from the previous resident
 * implementation — we just wired its ignition mechanism through the
 * rule engine (for reactive triggers) and lazyEvents (for direct
 * imperative requests).
 */

import { extractRegexEntities } from './extractors/regex.js';
import { extractMicroformatEntities } from './extractors/microformats.js';
import { extractStructuredDataEntities, extractPageMetadata } from './extractors/structured-data.js';
import { extractMapUrlEntities, isMapShortLink } from './extractors/map-url.js';
import { processEntities } from './entity-matcher.js';
import { filterFeedPageEntities } from './feed-filter.js';
import { preferStructuredData } from './source-precedence.js';
import { getEntities } from './entity-store.js';
import { ensureNameDatabase } from './name-validator.js';

const api = window.app;

// Configuration
const REEXTRACT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const EXTRACTION_DELAY_MS = 2000; // Wait for page to finish rendering
const CONFIDENCE_THRESHOLD = 0.7;

// In-memory cache of recently extracted URLs
const extractionCache = new Map();
// Pending extraction timers (deduped per URL)
const pendingExtractions = new Map();

// ==================== Content Extraction ====================

async function getPageContent(url) {
  try {
    const result = await api.datastore.extractPageContent(url);
    if (result && result.success) {
      return result.data;
    }
  } catch {
    // fall through to fetch
  }
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const html = await response.text();
    const textContent = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { html, text: textContent.slice(0, 50000), title: '' };
  } catch {
    return null;
  }
}

// ==================== URL Item Enrichment ====================

async function enrichUrlItem(url, pageMetadata) {
  try {
    const found = await api.datastore.findUrlItem(url);
    if (!found?.success || !found.data) return;
    const item = found.data;

    const fallbackTitle = pageMetadata.title || (() => {
      try { return new URL(url).hostname; } catch { return ''; }
    })();
    if (fallbackTitle && (!item.title || item.title === 'Loading...')) {
      await api.datastore.updateItemTitle(url, fallbackTitle);
    }

    if (pageMetadata.favicon) {
      await api.datastore.updateItemFavicon(url, pageMetadata.favicon);
    }

    const existingMeta = item.metadata ? JSON.parse(item.metadata) : {};
    if (existingMeta._og) return;

    const enrichedMeta = {
      ...existingMeta,
      _og: {
        title: pageMetadata.title || '',
        description: pageMetadata.description || '',
        image: pageMetadata.ogImage || '',
        siteName: pageMetadata.siteName || '',
        type: pageMetadata.ogType || '',
        extractedAt: Date.now()
      }
    };
    await api.datastore.updateItem(item.id, { metadata: JSON.stringify(enrichedMeta) });
  } catch (err) {
    console.warn('[entities] Failed to enrich URL item:', err.message);
  }
}

// ==================== Extraction Pipeline ====================

function safeExtract(fn, name) {
  try {
    const result = fn();
    return Array.isArray(result) ? result : [];
  } catch (err) {
    console.warn(`[entities] ${name} extractor threw:`, err.message);
    return [];
  }
}

/**
 * Follow a map short link's redirect once and report where it lands. Returns null when
 * the expansion fails, in which case no place is read and nothing else changes.
 */
async function expandShortLink(url) {
  try {
    const response = await fetch(url, { redirect: 'follow' });
    return response?.url || null;
  } catch {
    return null;
  }
}

/**
 * Read the place a map URL names, if it names one. This runs before the page fetch, so a
 * map link yields a place even when the page cannot be read at all.
 */
async function extractMapPlace(url) {
  const mapUrl = isMapShortLink(url) ? await expandShortLink(url) : url;
  if (!mapUrl) return [];
  return safeExtract(() => extractMapUrlEntities(mapUrl), 'map-url');
}

async function extractEntities(url, title = '') {
  const mapRaw = await extractMapPlace(url);

  const content = await getPageContent(url);
  if (!content) {
    if (mapRaw.length === 0) return [];
    // The URL alone named a place; the page adds nothing to it.
    return await processEntities(mapRaw, { url, title }, CONFIDENCE_THRESHOLD);
  }

  const html = content.html || '';
  const text = content.text || '';
  const pageTitle = title || content.title || '';

  try {
    const pageMetadata = extractPageMetadata(html, url);
    if (pageMetadata) await enrichUrlItem(url, pageMetadata);
  } catch (err) {
    console.warn('[entities] Page metadata enrichment failed:', err.message);
  }

  const [regexEntities, microformatEntities, structuredDataEntities] = await Promise.all([
    Promise.resolve(safeExtract(() => extractRegexEntities(text, url), 'regex')),
    Promise.resolve(safeExtract(() => extractMicroformatEntities(html, url), 'microformats')),
    Promise.resolve(safeExtract(() => extractStructuredDataEntities(html, url), 'structured-data')),
  ]);

  const pageRaw = filterFeedPageEntities(
    [...structuredDataEntities, ...microformatEntities, ...regexEntities],
    { title: pageTitle },
  );
  const allRaw = preferStructuredData([...mapRaw, ...pageRaw]);
  if (allRaw.length === 0) return [];

  return await processEntities(allRaw, { url, title: pageTitle }, CONFIDENCE_THRESHOLD);
}

// ==================== Trigger Plumbing ====================

/**
 * Schedule extraction for a URL (debounced + cooldowned). Used by
 * both the rule-engine entry point and the imperative entities:extract
 * topic.
 */
function schedulePageExtraction(msg) {
  const url = msg.content || msg.url;
  if (!url || typeof url !== 'string') return;
  if (url.startsWith('peek://') || url.startsWith('about:') || url.startsWith('chrome://')) return;
  if (!url.startsWith('http://') && !url.startsWith('https://')) return;

  const lastExtracted = extractionCache.get(url);
  if (lastExtracted && Date.now() - lastExtracted < REEXTRACT_COOLDOWN_MS) return;

  if (pendingExtractions.has(url)) clearTimeout(pendingExtractions.get(url));

  const timer = setTimeout(async () => {
    pendingExtractions.delete(url);
    try {
      const entities = await extractEntities(url, msg.title || '');
      extractionCache.set(url, Date.now());
      if (entities.length > 0) {
        api.pubsub.publish('entities:extracted', {
          url,
          entities: entities.map(e => ({
            id: e.id,
            name: e.name,
            type: e.entityType,
            confidence: e.confidence,
            isNew: e.isNew
          }))
        });
        try {
          await api.context.set('entities', entities.map(e => ({
            id: e.id,
            name: e.name,
            type: e.entityType,
            confidence: e.confidence
          })), { metadata: { url, extractedAt: Date.now() } });
        } catch (err) {
          console.warn('[entities] Context update failed:', err.message);
        }
      }
    } catch (err) {
      console.error('[entities] Extraction failed for:', url, err);
    }
  }, EXTRACTION_DELAY_MS);

  pendingExtractions.set(url, timer);
}

// ==================== Lifecycle ====================

const init = async () => {
  ensureNameDatabase();

  // Rule-driven: the engine fires this on page:content-ready and
  // item:created (URL only) per the manifest's rules block.
  api.pubsub.subscribe('scripts:execute:entities-extract', (msg) => {
    const event = (msg && msg.context && msg.context.event) || {};
    schedulePageExtraction({
      url: event.url || event.content,
      content: event.content,
      title: event.title,
    });
  });

  // Imperative request — bypasses the cooldown so a user-initiated
  // "extract this page" always re-runs.
  api.pubsub.subscribe('entities:extract', async (msg) => {
    if (!msg || !msg.url) return;
    let entities = [];
    try {
      extractionCache.delete(msg.url);
      entities = await extractEntities(msg.url, msg.title || '') || [];
    } catch (err) {
      console.error('[entities] entities:extract handler failed:', err);
    }
    api.pubsub.publish('entities:extracted', {
      url: msg.url,
      entities: entities.map(e => ({
        id: e.id, name: e.name, type: e.entityType, confidence: e.confidence, isNew: e.isNew
      }))
    });
    api.pubsub.publish('entities:extract:response', { url: msg.url, entities });
  });

  api.pubsub.subscribe('entities:search', async (msg) => {
    const entities = await getEntities({
      entityType: msg.type, search: msg.query, limit: msg.limit || 50
    });
    api.pubsub.publish('entities:search:response', { query: msg.query, entities });
  });

  api.pubsub.subscribe('entities:get-for-url', async (msg) => {
    if (!msg.url) return;
    const events = await api.datastore.queryItemEvents({ limit: 100, order: 'desc' });
    if (!events.success) return;
    const entityIds = new Set();
    for (const evt of events.data) {
      if (evt.content === msg.url) entityIds.add(evt.itemId);
    }
    const entities = [];
    for (const id of entityIds) {
      const item = await api.datastore.getItem(id);
      if (item.success && item.data && item.data.type === 'entity') {
        entities.push(item.data);
      }
    }
    api.pubsub.publish('entities:get-for-url:response', { url: msg.url, entities });
  });
};

const uninit = () => {
  for (const timer of pendingExtractions.values()) clearTimeout(timer);
  pendingExtractions.clear();
};

export default {
  id: 'entities',
  labels: { name: 'Entity Recognition' },
  init,
  uninit,
};
