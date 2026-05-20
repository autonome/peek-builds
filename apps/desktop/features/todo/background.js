/**
 * Todo Extension Background Script
 *
 * Two cmd-panel commands:
 *   - `todo {text} [#tag …]`  — creates a text item, auto-tags with `todo`
 *     plus any inline `#tag` words.
 *   - `done {match}`          — finds the first `todo`-tagged item whose
 *     title/content contains `match` (case-insensitive), swaps the `todo`
 *     tag for `done`, records a `done` item event.
 *
 * Lazy-loaded: tile boots on first `cmd:execute:todo` / `cmd:execute:done`.
 *
 * Runs in isolated extension process (peek://todo/background.html).
 */

import { id, labels, schemas, storageKeys, defaults } from './config.js';

const api = window.app;
const debug = api.debug;

const TODO_TAG = 'todo';
const DONE_TAG = 'done';

// ===== Parsing =====

/**
 * Split a `todo` command argument string into the body text and any
 * trailing `#tag` words. Inline tags can appear anywhere — the body is
 * non-tag tokens concatenated by single spaces.
 */
const parseTodoArgs = (raw) => {
  const text = (raw || '').trim();
  if (!text) return { body: '', extraTags: [] };
  const extraTags = [];
  const bodyParts = [];
  for (const tok of text.split(/\s+/)) {
    if (tok.startsWith('#') && tok.length > 1) {
      extraTags.push(tok.slice(1));
    } else {
      bodyParts.push(tok);
    }
  }
  return { body: bodyParts.join(' ').trim(), extraTags };
};

// ===== Tag helpers (mirrors features/tags/background.js patterns) =====

const ensureTag = async (name) => {
  const r = await api.datastore.getOrCreateTag(name);
  if (!r.success) {
    console.error('[ext:todo] getOrCreateTag failed:', name, r.error);
    return null;
  }
  return r.data.tag;
};

const tagWithName = async (itemId, name) => {
  const tag = await ensureTag(name);
  if (!tag) return false;
  const link = await api.datastore.tagItem(itemId, tag.id);
  if (!link.success) {
    console.error('[ext:todo] tagItem failed:', name, link.error);
    return false;
  }
  return true;
};

const untagWithName = async (itemId, name) => {
  // Find the tag on this item by name (case-insensitive).
  const tagsResult = await api.datastore.getItemTags(itemId);
  if (!tagsResult.success) return false;
  const tag = tagsResult.data.find(t => t.name.toLowerCase() === name.toLowerCase());
  if (!tag) return false;
  const r = await api.datastore.untagItem(itemId, tag.id);
  return r.success;
};

// ===== Command handlers =====

const handleTodo = async (rawArgs) => {
  const { body, extraTags } = parseTodoArgs(rawArgs);
  if (!body) {
    return { output: 'Usage: todo <text> [#tag ...]', mimeType: 'text/plain' };
  }

  const result = await api.datastore.addItem('text', {
    title: body,
    content: body
  });
  if (!result.success) {
    console.error('[ext:todo] addItem failed:', result.error);
    return { output: 'Failed to create todo', mimeType: 'text/plain' };
  }
  const itemId = result.data.id;

  // Always tag #todo, then any extras the user named inline.
  await tagWithName(itemId, TODO_TAG);
  for (const t of extraTags) {
    await tagWithName(itemId, t);
  }

  api.pubsub.publish('todo:created', { id: itemId, title: body, extraTags });

  const tagSummary = extraTags.length > 0
    ? ` (#${TODO_TAG}, #${extraTags.join(', #')})`
    : ` (#${TODO_TAG})`;
  return {
    output: `Added: ${body}${tagSummary}`,
    mimeType: 'text/plain'
  };
};

const handleDone = async (rawArgs) => {
  const match = (rawArgs || '').trim();
  if (!match) {
    return { output: 'Usage: done <text-substring-of-todo>', mimeType: 'text/plain' };
  }

  // Resolve the #todo tag so we can scope the search.
  const todoTag = await ensureTag(TODO_TAG);
  if (!todoTag) {
    return { output: 'No #todo tag exists yet — nothing to mark done', mimeType: 'text/plain' };
  }

  const itemsResult = await api.datastore.getItemsByTag(todoTag.id);
  if (!itemsResult.success) {
    console.error('[ext:todo] getItemsByTag failed:', itemsResult.error);
    return { output: 'Failed to query todos', mimeType: 'text/plain' };
  }

  const needle = match.toLowerCase();
  const matches = itemsResult.data.filter(it => {
    const t = (it.title || '').toLowerCase();
    const c = (it.content || '').toLowerCase();
    return t.includes(needle) || c.includes(needle);
  });

  if (matches.length === 0) {
    return { output: `No #todo item matches "${match}"`, mimeType: 'text/plain' };
  }

  const target = matches[0];
  await untagWithName(target.id, TODO_TAG);
  await tagWithName(target.id, DONE_TAG);

  // Record an event so audit trails / activity views see the transition.
  try {
    await api.datastore.recordItemEvent?.(target.id, 'completed', match);
  } catch {
    // Older datastore surfaces don't expose recordItemEvent — ignore.
  }

  api.pubsub.publish('todo:done', { id: target.id, title: target.title });

  const overflow = matches.length > 1
    ? ` (${matches.length - 1} other match${matches.length === 2 ? '' : 'es'} skipped)`
    : '';
  return {
    output: `Done: ${target.title || target.content || target.id}${overflow}`,
    mimeType: 'text/plain'
  };
};

// ===== Registration =====

const init = async () => {
  debug && console.log('[ext:todo] init');

  api.pubsub.subscribe('cmd:execute:todo', async (msg) => {
    const result = await handleTodo(msg.search?.trim() || msg.data?.text || '');
    if (msg.expectResult && msg.resultTopic) {
      api.pubsub.publish(msg.resultTopic, result || { success: true });
    }
  });

  api.pubsub.subscribe('cmd:execute:done', async (msg) => {
    const result = await handleDone(msg.search?.trim() || msg.data?.text || '');
    if (msg.expectResult && msg.resultTopic) {
      api.pubsub.publish(msg.resultTopic, result || { success: true });
    }
  });

  // Manifest declares both commands; no need to publish cmd:register here.
  debug && console.log('[ext:todo] cmd:execute handlers wired (todo, done)');
};

const uninit = () => {
  debug && console.log('[ext:todo] uninit');
};

export default {
  defaults,
  id,
  init,
  uninit,
  labels,
  schemas,
  storageKeys
};
