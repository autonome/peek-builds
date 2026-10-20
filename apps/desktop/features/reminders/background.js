/**
 * Reminders — a `remind:<duration>` tag brings an item back when it comes due.
 *
 * The decisions all live in `remind.js`, which is pure. This file is the wiring:
 * it answers the `reminders:check` schedule, reads the tags and items the check
 * needs, and applies the actions the plan returns.
 *
 * Finding the items whose stored reminder must be dropped needs a set that tag
 * data cannot supply — once the `remind:` tag is gone there is nothing to find
 * the item by. `queryItems` has no filter on `metadata` (`ItemFilter` in
 * `apps/desktop/types/index.ts` covers type, flags, domain and a content
 * search), so the ids of items with a started reminder are kept in this
 * feature's settings and read back on each check.
 */

import {
  planReminders,
  itemIdsWithRemindTags,
  REMIND_DUE_TAG,
  REMIND_DUE_QUERY,
} from './remind.js';

const id = 'reminders';
const api = window.app;

/** Settings key holding the ids of items with a stored `metadata.reminder`. */
const STARTED_KEY = 'startedItemIds';

/** Ids with a started reminder, mirroring the settings key above. */
let startedItemIds = new Set();

/**
 * Resolves once settings have been read. Handler bodies wait on it: the
 * publish that wakes this tile lands before async init finishes, and a check
 * that ran against an empty started set would drop live reminders.
 */
let settingsLoaded = null;

/** Serialises checks, so a schedule fire landing on a slow check queues behind it. */
let running = Promise.resolve();

async function loadStartedItemIds() {
  try {
    const res = await api.settings.get(STARTED_KEY);
    const stored = res?.value ?? res?.data;
    startedItemIds = new Set(Array.isArray(stored) ? stored : []);
  } catch (error) {
    console.error(`[ext:${id}] Failed to read ${STARTED_KEY}:`, error);
    startedItemIds = new Set();
  }
}

async function saveStartedItemIds() {
  try {
    await api.settings.set(STARTED_KEY, Array.from(startedItemIds));
  } catch (error) {
    console.error(`[ext:${id}] Failed to write ${STARTED_KEY}:`, error);
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

async function writeReminder(itemId, reminder) {
  const res = await api.datastore.updateItem(itemId, {
    metadata: JSON.stringify({ reminder }),
  });
  if (!res?.success) {
    throw new Error(`updateItem failed for ${itemId}: ${res?.error || 'unknown error'}`);
  }
}

/**
 * Swap one tag for another, the way `features/tag-actions/background.js
 * runTagSwap()` does it: resolve both tag ids, drop the old link, add the new.
 */
async function swapTag(itemId, fromName, toName) {
  const from = await api.datastore.getOrCreateTag(fromName);
  const to = await api.datastore.getOrCreateTag(toName);
  if (!from?.success || !to?.success) {
    throw new Error(`getOrCreateTag failed for ${fromName} or ${toName}`);
  }
  await api.datastore.untagItem(itemId, from.data.tag.id);
  await api.datastore.tagItem(itemId, to.data.tag.id);
}

async function applyAction(action) {
  switch (action.kind) {
    case 'start':
      await writeReminder(action.itemId, action.reminder);
      startedItemIds.add(action.itemId);
      return true;
    case 'due':
      // The metadata is kept, so `dueAt` stays visible on the due item.
      await swapTag(action.itemId, action.fromTag, REMIND_DUE_TAG);
      return false;
    case 'clear':
      await writeReminder(action.itemId, null);
      startedItemIds.delete(action.itemId);
      return true;
    default:
      console.warn(`[ext:${id}] Unknown action kind: ${action.kind}`);
      return false;
  }
}

/**
 * One pass: read every item that carries a `remind:` tag or holds a started
 * reminder, plan, and apply. Returns the actions applied, which the desktop
 * spec and the console both read.
 */
async function runCheck(now = Date.now()) {
  const tagsRes = await api.datastore.getAllItemTags();
  if (!tagsRes?.success) {
    console.error(`[ext:${id}] getAllItemTags failed:`, tagsRes?.error);
    return [];
  }
  const allItemTags = tagsRes.data || {};

  const candidates = new Set(itemIdsWithRemindTags(allItemTags));
  for (const itemId of startedItemIds) candidates.add(itemId);
  if (candidates.size === 0) return [];

  const itemTags = {};
  for (const itemId of candidates) itemTags[itemId] = allItemTags[itemId] || [];

  const itemsById = await readItems(candidates);
  const actions = planReminders(itemTags, itemsById, now);

  let startedSetChanged = false;
  for (const action of actions) {
    try {
      startedSetChanged = (await applyAction(action)) || startedSetChanged;
    } catch (error) {
      console.error(`[ext:${id}] Failed to apply ${action.kind} for ${action.itemId}:`, error);
    }
  }
  if (startedSetChanged) await saveStartedItemIds();

  if (actions.length > 0) {
    console.log(`[ext:${id}] Applied ${actions.length} reminder action(s)`);
  }
  return actions;
}

const init = async () => {
  // Register the wake handlers synchronously, before any await: the publish
  // that woke this tile is delivered on the macrotask after `tile:lifecycle:
  // ready`, so a handler registered after an await misses it.
  api.commands.register({
    name: 'reminders',
    description: 'List items whose reminder has come due',
    execute: async () => {
      // Two listeners in the search tile answer this topic — the `search`
      // command it registers, which reads `text`, and its own subscribe, which
      // reads `data.query` — and the first window open wins, so both keys
      // carry the query (`features/search/background.js`).
      api.pubsub.publish('cmd:execute:search', {
        text: REMIND_DUE_QUERY,
        data: { query: REMIND_DUE_QUERY },
      });
    },
  });

  api.pubsub.subscribe('reminders:check', async () => {
    await settingsLoaded;
    running = running.then(() => runCheck()).catch(error => {
      console.error(`[ext:${id}] Check failed:`, error);
    });
    await running;
  });

  settingsLoaded = loadStartedItemIds();
  await settingsLoaded;
};

const uninit = () => {};

export default { id, labels: { name: 'Reminders' }, init, uninit };
