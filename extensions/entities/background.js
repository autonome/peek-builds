/**
 * Entities Extension - Entity Recognition
 *
 * Automatically extracts and indexes entities (people, places, organizations,
 * events, emails, phones, dates) from visited pages using regex, microformat,
 * and JSON-LD extractors.
 *
 * Phase 1: Structured data extraction (regex + microformats + JSON-LD)
 */

import { extractRegexEntities } from './extractors/regex.js';
import { extractMicroformatEntities } from './extractors/microformats.js';
import { extractStructuredDataEntities, extractPageMetadata } from './extractors/structured-data.js';
import { processEntities } from './entity-matcher.js';
import { getEntities, getObservations, setEntityFeedback } from './entity-store.js';
import { ensureNameDatabase } from './name-validator.js';
import { registerNoun, unregisterNoun } from 'peek://ext/cmd/nouns.js';

const api = window.app;

// Configuration
const REEXTRACT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const EXTRACTION_DELAY_MS = 2000; // Wait for page to finish rendering
const CONFIDENCE_THRESHOLD = 0.7;

// In-memory cache of recently extracted URLs
const extractionCache = new Map();

// Pending extraction timers
const pendingExtractions = new Map();

// ==================== Content Extraction ====================

/**
 * Extract page metadata by requesting content from the main process.
 * Uses the page's HTML content (meta tags, JSON-LD, microformats).
 * @param {string} url - URL to extract from
 * @returns {Promise<{html: string, text: string, title: string} | null>}
 */
async function getPageContent(url) {
  // Request page content extraction via IPC
  // The main process has access to webContents and can run executeJavaScript
  try {
    const result = await api.datastore.extractPageContent(url);
    if (result && result.success) {
      return result.data;
    }
  } catch {
    // IPC not available or failed - fall back to fetch for metadata
  }

  // Fallback: fetch the URL directly for metadata extraction
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const html = await response.text();
    // Extract basic text (strip tags)
    const textContent = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      html,
      text: textContent.slice(0, 50000), // Limit text extraction
      title: ''
    };
  } catch {
    return null;
  }
}

// ==================== URL Item Enrichment ====================

/**
 * Enrich a URL item with page metadata (OG tags, title, etc.)
 * @param {string} url - Page URL
 * @param {Object} pageMetadata - Extracted metadata from extractPageMetadata()
 */
async function enrichUrlItem(url, pageMetadata) {
  try {
    const items = await api.datastore.queryItems({ type: 'url', search: url, limit: 5 });
    if (!items.success || !items.data) return;

    // Match by exact URL or by normalized form (content is stored normalized)
    // Also try stripping/adding trailing slash for root paths
    const urlVariants = new Set([url]);
    try {
      const parsed = new URL(url);
      urlVariants.add(parsed.toString()); // canonical form
      if (parsed.pathname === '/') {
        // Try with and without trailing slash
        const withSlash = parsed.origin + '/' + parsed.search + parsed.hash;
        const withoutSlash = parsed.origin + parsed.search + parsed.hash;
        urlVariants.add(withSlash);
        urlVariants.add(withoutSlash);
      }
    } catch { /* invalid URL */ }

    const item = items.data.find(i => urlVariants.has(i.content));
    if (!item) return;

    // Update title if empty or "Loading..."
    if (pageMetadata.title && (!item.title || item.title === 'Loading...')) {
      await api.datastore.updateItemTitle(url, pageMetadata.title);
    }

    // Update metadata with _og data (skip if already enriched)
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

/**
 * Run the full extraction pipeline on a URL
 * @param {string} url - Page URL
 * @param {string} [title] - Page title
 * @returns {Promise<Array<Object>>} Processed entities
 */
async function extractEntities(url, title = '') {
  const content = await getPageContent(url);
  if (!content) return [];

  const html = content.html || '';
  const text = content.text || '';
  const pageTitle = title || content.title || '';

  // Enrich the URL item with page metadata (OG tags, etc.)
  try {
    const pageMetadata = extractPageMetadata(html, url);
    if (pageMetadata) {
      await enrichUrlItem(url, pageMetadata);
    }
  } catch (err) {
    console.warn('[entities] Page metadata enrichment failed:', err.message);
  }

  // Run all extractors in parallel
  const [regexEntities, microformatEntities, structuredDataEntities] = await Promise.all([
    Promise.resolve(extractRegexEntities(text, url)),
    Promise.resolve(extractMicroformatEntities(html, url)),
    Promise.resolve(extractStructuredDataEntities(html, url)),
  ]);

  const allRaw = [
    ...structuredDataEntities,  // Highest confidence first
    ...microformatEntities,
    ...regexEntities,
  ];

  if (allRaw.length === 0) return [];

  // Process through matcher (dedup + store)
  const processed = await processEntities(allRaw, {
    url,
    title: pageTitle
  }, CONFIDENCE_THRESHOLD);

  return processed;
}

/**
 * Handle a page load event - schedule extraction
 * @param {Object} msg - Event message
 * @param {string} msg.url - Page URL
 * @param {string} [msg.title] - Page title
 */
function handlePageLoad(msg) {
  const url = msg.content || msg.url;
  if (!url || typeof url !== 'string') return;

  // Skip internal URLs
  if (url.startsWith('peek://') || url.startsWith('about:') || url.startsWith('chrome://')) return;
  if (!url.startsWith('http://') && !url.startsWith('https://')) return;

  // Check cooldown
  const lastExtracted = extractionCache.get(url);
  if (lastExtracted && Date.now() - lastExtracted < REEXTRACT_COOLDOWN_MS) {
    return;
  }

  // Cancel any pending extraction for this URL
  if (pendingExtractions.has(url)) {
    clearTimeout(pendingExtractions.get(url));
  }

  // Schedule extraction with delay (let page finish rendering)
  const timer = setTimeout(async () => {
    pendingExtractions.delete(url);

    try {
      const entities = await extractEntities(url, msg.title || '');
      extractionCache.set(url, Date.now());

      if (entities.length > 0) {
        // Publish extraction results
        api.publish('entities:extracted', {
          url,
          entities: entities.map(e => ({
            id: e.id,
            name: e.name,
            type: e.entityType,
            confidence: e.confidence,
            isNew: e.isNew
          }))
        }, api.scopes.GLOBAL);

        // Update context if context API is available
        if (api.context && api.context.set) {
          try {
            await api.context.set('entities', entities.map(e => ({
              id: e.id,
              name: e.name,
              type: e.entityType,
              confidence: e.confidence
            })), {
              metadata: { url, extractedAt: Date.now() }
            });
          } catch (err) {
            console.warn('[entities] Context update failed:', err.message);
          }
        }
      }
    } catch (err) {
      console.error('[entities] Extraction failed for:', url, err);
    }
  }, EXTRACTION_DELAY_MS);

  pendingExtractions.set(url, timer);
}

/**
 * Manual extraction from current page
 */
async function extractCurrentPage() {
  // Get the focused window
  const windowList = await api.window.list({ includeInternal: false });
  if (!windowList.success || !windowList.windows.length) return;

  // Use the last focused visible window (not just first in list)
  let activeWindow = windowList.windows[0];
  const focusedId = await api.window.getFocusedVisibleWindowId();
  if (focusedId) {
    const focused = windowList.windows.find(w => w.id === focusedId);
    if (focused) activeWindow = focused;
  }
  const url = activeWindow.url;

  if (!url || !url.startsWith('http')) return;

  // Clear cooldown for manual extraction
  extractionCache.delete(url);

  const entities = await extractEntities(url, activeWindow.title || '');

  return entities;
}

// ==================== UI ====================

function openEntityBrowser() {
  api.window.open('peek://ext/entities/home.html', {
    role: 'workspace',
    key: 'entities-browser',
    width: 900,
    height: 700,
    title: 'Entities'
  });
}

// ==================== Extension Lifecycle ====================

const extension = {
  id: 'entities',
  labels: {
    name: 'Entity Recognition'
  },

  registerCommands() {
    // Register noun for auto-generated browse/list commands
    registerNoun({
      name: 'entities',
      singular: 'entity',
      description: 'Extracted people, places, organizations, and more',
      skipBare: true, // "entities" bare command should browse, but we want the noun to generate "open entities" and "list entities"

      query: async ({ search }) => {
        const entities = await getEntities({
          search: search || undefined,
          limit: 50
        });
        if (entities.length === 0) {
          return { output: 'No entities found.', mimeType: 'text/plain' };
        }
        return {
          success: true,
          output: {
            data: entities.map(e => {
              let meta = {};
              try { meta = JSON.parse(e.metadata || '{}'); } catch {}
              return {
                id: e.id,
                name: e.content,
                type: meta.entityType,
                confidence: meta.confidence
              };
            }),
            mimeType: 'application/json',
            title: `Entities (${entities.length})`
          }
        };
      },

      browse: async () => { openEntityBrowser(); },
      produces: 'application/json'
    });

    // Extract is a specialized verb action — keep as regular command
    api.commands.register({
      name: 'extract entities',
      description: 'Extract entities from current page',
      execute: async () => {
        const entities = await extractCurrentPage();
        if (entities && entities.length > 0) {
          openEntityBrowser();
        }
      }
    });

  },

  init() {
    // Eagerly load the name database so regex NER can use it from the first extraction
    ensureNameDatabase();

    // Register commands (cmd loads first with its subscribers ready via 100ms head start)
    this.registerCommands();

    // Listen for page loads (item:created events for URL items)
    api.subscribe('item:created', (msg) => {
      if (msg.itemType === 'url') {
        handlePageLoad(msg);
      }
    }, api.scopes.GLOBAL);

    // Listen for page content ready events from the main process.
    // Fires when page-title-updated occurs, meaning the page has loaded
    // enough for content extraction. This catches pages that already exist
    // in history (no item:created) and provides a reliable extraction signal.
    api.subscribe('page:content-ready', (msg) => {
      if (msg.url && msg.url.startsWith('http')) {
        handlePageLoad({ content: msg.url, title: msg.title || '' });
      }
    }, api.scopes.GLOBAL);

    // Listen for manual extraction requests via pubsub
    api.subscribe('entities:extract', async (msg) => {
      if (msg.url) {
        extractionCache.delete(msg.url);
        const entities = await extractEntities(msg.url, msg.title || '');
        api.publish('entities:extract:response', {
          url: msg.url,
          entities
        }, api.scopes.GLOBAL);
      }
    }, api.scopes.GLOBAL);

    // Listen for entity queries
    api.subscribe('entities:search', async (msg) => {
      const entities = await getEntities({
        entityType: msg.type,
        search: msg.query,
        limit: msg.limit || 50
      });
      api.publish('entities:search:response', {
        query: msg.query,
        entities
      }, api.scopes.GLOBAL);
    }, api.scopes.GLOBAL);

    // Listen for get-for-url requests
    api.subscribe('entities:get-for-url', async (msg) => {
      if (!msg.url) return;
      // Query item_events where content = url to find entity observations
      const events = await api.datastore.queryItemEvents({
        limit: 100,
        order: 'desc'
      });
      if (events.success) {
        const entityIds = new Set();
        for (const evt of events.data) {
          if (evt.content === msg.url) {
            entityIds.add(evt.itemId);
          }
        }
        const entities = [];
        for (const id of entityIds) {
          const item = await api.datastore.getItem(id);
          if (item.success && item.data && item.data.type === 'entity') {
            entities.push(item.data);
          }
        }
        api.publish('entities:get-for-url:response', {
          url: msg.url,
          entities
        }, api.scopes.GLOBAL);
      }
    }, api.scopes.GLOBAL);

  },

  uninit() {

    // Clear pending extraction timers
    for (const timer of pendingExtractions.values()) {
      clearTimeout(timer);
    }
    pendingExtractions.clear();

    // Unregister commands
    unregisterNoun('entities');
    api.commands.unregister('extract entities');
  }
};

export default extension;

// Export for UI
export { getEntities, getObservations, extractCurrentPage, setEntityFeedback };
