/**
 * Lookups — an item tagged `to-watch`, `to-read` or `to-listen` is resolved to
 * the work its typed title names, and carries that work's Wikipedia page, its
 * creator and where to read, watch or listen.
 *
 * The decisions all live in `resolve.js`, which is pure. This file is the
 * wiring: it answers the `lookups:check` schedule, reads the items due a
 * lookup, asks Wikidata about them, and writes the result back.
 *
 * Three requests resolve one title: `wbsearchentities` for candidates,
 * `wbgetentities` for their claims and sitelinks, and one more
 * `wbgetentities` for every candidate creator's label — the creator preference
 * needs those labels before a candidate can be chosen. A request that fails
 * leaves the item without `metadata.lookup`, so the next check tries it again.
 */

import {
  searchAttempts,
  pickCandidate,
  lookupFromEntity,
  unresolvedLookup,
  selectItemsToLookUp,
  lookupTagFor,
  CREATOR_PROPS,
  FOUND_TAG,
  UNRESOLVED_TAG,
  DEFAULT_LIMIT,
} from './resolve.js';

const id = 'lookups';
const api = window.app;

/** Settings key holding the Wikidata API address. */
const API_BASE_KEY = 'apiBase';

/** Wikimedia asks browser clients to name themselves in this header. */
const USER_AGENT = 'Peek/1.0 (peek desktop; lookups feature)';

/** Candidates considered per title, which is what `wbsearchentities` is asked for. */
const SEARCH_LIMIT = 10;

/** The Wikidata API address, mirroring the settings key above. */
let apiBase = 'https://www.wikidata.org/w/api.php';

/**
 * Resolves once settings have been read. Handler bodies wait on it: the
 * publish that wakes this tile lands before async init finishes, and a check
 * that ran first would ask the wrong address.
 */
let settingsLoaded = null;

/** Serialises checks, so a schedule fire landing on a slow check queues behind it. */
let running = Promise.resolve();

async function loadApiBase() {
  try {
    const res = await api.settings.get(API_BASE_KEY);
    const stored = res?.value ?? res?.data;
    if (typeof stored === 'string' && stored) apiBase = stored;
  } catch (error) {
    console.error(`[ext:${id}] Failed to read ${API_BASE_KEY}:`, error);
  }
}

/** `metadata` comes back from the datastore as a JSON string. */
function parseMetadata(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

/** One Wikidata request, as JSON. Throws so the caller can leave the item alone. */
async function askWikidata(params) {
  const url = new URL(apiBase);
  for (const [key, value] of Object.entries({ format: 'json', ...params })) {
    url.searchParams.set(key, value);
  }

  const res = await api.network.fetch(url.toString(), {
    method: 'GET',
    headers: { 'Api-User-Agent': USER_AGENT },
  });
  if (!res || res.error) throw new Error(res?.error || 'network fetch returned nothing');
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Wikidata answered ${res.status} ${res.statusText || ''}`.trim());
  }
  return JSON.parse(res.body);
}

/** Candidate entity ids for a search term, in the order Wikidata ranked them. */
async function searchEntities(term) {
  const body = await askWikidata({
    action: 'wbsearchentities',
    search: term,
    language: 'en',
    uselang: 'en',
    type: 'item',
    limit: String(SEARCH_LIMIT),
  });
  const hits = Array.isArray(body?.search) ? body.search : [];
  return hits.map(hit => hit?.id).filter(Boolean);
}

/** The candidates themselves, kept in search order. */
async function readEntities(ids) {
  if (ids.length === 0) return [];
  const body = await askWikidata({
    action: 'wbgetentities',
    ids: ids.join('|'),
    props: 'claims|sitelinks|labels',
    languages: 'en',
    sitefilter: 'enwiki',
  });
  return ids.map(entityId => body?.entities?.[entityId]).filter(Boolean);
}

/** Every entity a candidate names as its creator, so their labels can be read. */
function creatorIdsIn(entities) {
  const ids = new Set();
  for (const entity of entities) {
    for (const property of CREATOR_PROPS) {
      for (const claim of entity?.claims?.[property] || []) {
        const value = claim?.mainsnak?.datavalue?.value;
        if (value?.id) ids.add(value.id);
      }
    }
  }
  return [...ids];
}

/** The creator labels, in one request. */
async function readLabels(ids) {
  if (ids.length === 0) return {};
  const body = await askWikidata({
    action: 'wbgetentities',
    ids: ids.join('|'),
    props: 'labels',
    languages: 'en',
  });
  return body?.entities || {};
}

/**
 * Resolve one typed title, trying the split title first and the whole text
 * second. Returns the `metadata.lookup` record, found or unresolved.
 */
async function resolveTitle(text, tag, now) {
  for (const { term, creatorHint } of searchAttempts(text)) {
    const ids = await searchEntities(term);
    if (ids.length === 0) continue;

    const entities = await readEntities(ids);
    const labelsById = await readLabels(creatorIdsIn(entities));
    const chosen = pickCandidate(tag, entities, creatorHint, labelsById);
    if (chosen) return lookupFromEntity(chosen, tag, labelsById, now);
  }
  return unresolvedLookup(now);
}

/** Write the lookup onto the item, leaving the rest of its metadata alone. */
async function writeLookup(item, lookup) {
  const metadata = { ...item.metadata, lookup };
  const res = await api.datastore.updateItem(item.id, {
    metadata: JSON.stringify(metadata),
  });
  if (!res?.success) {
    throw new Error(`updateItem failed for ${item.id}: ${res?.error || 'unknown error'}`);
  }
}

/** Add a tag to an item, the way `features/reminders/background.js` does it. */
async function addTag(itemId, name) {
  const tag = await api.datastore.getOrCreateTag(name);
  if (!tag?.success) throw new Error(`getOrCreateTag failed for ${name}`);
  await api.datastore.tagItem(itemId, tag.data.tag.id);
}

async function readItems(itemIds) {
  const itemsById = {};
  for (const itemId of itemIds) {
    try {
      const res = await api.datastore.getItem(itemId);
      if (!res?.success || !res.data) continue;
      itemsById[itemId] = { ...res.data, metadata: parseMetadata(res.data.metadata) };
    } catch (error) {
      console.error(`[ext:${id}] Failed to read item ${itemId}:`, error);
    }
  }
  return itemsById;
}

/**
 * One pass: find the items due a lookup, resolve each, and write the result.
 * Returns one record per item acted on, which the desktop spec and the console
 * both read. An item whose requests failed appears in neither.
 */
async function runCheck(now = Date.now()) {
  const tagsRes = await api.datastore.getAllItemTags();
  if (!tagsRes?.success) {
    console.error(`[ext:${id}] getAllItemTags failed:`, tagsRes?.error);
    return [];
  }
  const allItemTags = tagsRes.data || {};

  const candidates = [];
  for (const [itemId, tags] of Object.entries(allItemTags)) {
    if (lookupTagFor(tags)) candidates.push(itemId);
  }
  if (candidates.length === 0) return [];

  const itemsById = await readItems(candidates);
  const itemTags = {};
  for (const itemId of candidates) itemTags[itemId] = allItemTags[itemId] || [];

  const due = selectItemsToLookUp(itemTags, itemsById, DEFAULT_LIMIT);
  const applied = [];

  for (const itemId of due) {
    const item = itemsById[itemId];
    const tag = lookupTagFor(itemTags[itemId]);
    try {
      const lookup = await resolveTitle(item.content || '', tag, now);
      await writeLookup(item, lookup);
      await addTag(itemId, lookup.unresolved ? UNRESOLVED_TAG : FOUND_TAG);
      if (lookup.links?.tmdb) {
        api.pubsub.publish('lookups:resolved', { itemId, tmdb: lookup.links.tmdb });
      }
      applied.push({ itemId, tag, lookup });
    } catch (error) {
      // No metadata was written, so the next check tries this item again.
      console.error(`[ext:${id}] Lookup failed for ${itemId}:`, error);
    }
  }

  if (applied.length > 0) {
    console.log(`[ext:${id}] Looked up ${applied.length} item(s)`);
  }
  return applied;
}

const init = async () => {
  // Register the wake handlers synchronously, before any await: the publish
  // that woke this tile is delivered on the macrotask after `tile:lifecycle:
  // ready`, so a handler registered after an await misses it.
  api.commands.register({
    name: 'lookups',
    description: 'Look up the items tagged to-watch, to-read or to-listen now',
    execute: async () => {
      await settingsLoaded;
      running = running.then(() => runCheck()).catch(error => {
        console.error(`[ext:${id}] Check failed:`, error);
      });
      return await running;
    },
  });

  api.pubsub.subscribe('lookups:check', async () => {
    await settingsLoaded;
    running = running.then(() => runCheck()).catch(error => {
      console.error(`[ext:${id}] Check failed:`, error);
    });
    await running;
  });

  settingsLoaded = loadApiBase();
  await settingsLoaded;
};

const uninit = () => {};

export default { id, labels: { name: 'Lookups' }, init, uninit };
