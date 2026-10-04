/**
 * Todo Extension Background Script
 *
 * Three cmd-panel commands:
 *   - `todo {text} [#tag …]`  — creates a text item, auto-tags with `todo`
 *     plus any `#tag` words that end the text (removed from the text).
 *   - `todos`                 — lists the outstanding `todo`-tagged items,
 *     newest first, as `item` output the panel turns into a selection list.
 *   - `done {match}`          — marks one `todo`-tagged item done: the item
 *     picked from the panel's suggestion list when there is one, otherwise
 *     the first whose title/content contains `match` (case-insensitive).
 *     Swaps the `todo` tag for `done`, records a `done` item event.
 *
 * Lazy-loaded: tile boots on first `cmd:execute:todo` / `cmd:execute:todos` /
 * `cmd:execute:done`.
 *
 * Runs in isolated extension process (peek://todo/background.html).
 */

import { id, labels, schemas, storageKeys, defaults } from './config.js';
import { splitTrailingTags } from 'peek://app/lib/note-tags.js';
import { matchTodos, parseTodoArgs, pickDoneTarget, todosListResult } from './todo-items.js';

const api = window.app;

const TODO_TAG = 'todo';
const DONE_TAG = 'done';

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
  const { body, extraTags } = parseTodoArgs(rawArgs, splitTrailingTags);
  if (!body) {
    return { output: 'Usage: todo <text> [#tag ...]', mimeType: 'text/plain' };
  }

  // Text items store only `content`; a `title` field is dropped by the datastore.
  const result = await api.datastore.addItem('text', { content: body });
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

const handleTodos = async () => {
  const todoTag = await ensureTag(TODO_TAG);
  if (!todoTag) {
    return { output: 'Failed to query todos', mimeType: 'text/plain' };
  }

  const itemsResult = await api.datastore.getItemsByTag(todoTag.id);
  if (!itemsResult.success) {
    console.error('[ext:todo] getItemsByTag failed:', itemsResult.error);
    return { output: 'Failed to query todos', mimeType: 'text/plain' };
  }

  return todosListResult(itemsResult.data);
};

const handleDone = async (rawArgs, selectedItem) => {
  const match = (rawArgs || '').trim();
  // A row picked in the panel's suggestion list carries the whole item, so
  // there is nothing left for the user to type.
  const picked = selectedItem && typeof selectedItem === 'object' && selectedItem.id;
  if (!match && !picked) {
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

  const target = pickDoneTarget(itemsResult.data, { selectedItem, match });
  if (!target) {
    return { output: `No #todo item matches "${match}"`, mimeType: 'text/plain' };
  }

  await untagWithName(target.id, TODO_TAG);
  await tagWithName(target.id, DONE_TAG);

  // Record an event so audit trails / activity views see the transition.
  try {
    await api.datastore.recordItemEvent?.(target.id, 'completed', match);
  } catch {
    // Older datastore surfaces don't expose recordItemEvent — ignore.
  }

  api.pubsub.publish('todo:done', { id: target.id, title: target.title });

  // Only a text match can be ambiguous — a picked row names its item exactly.
  const matches = picked ? [] : matchTodos(itemsResult.data, match);
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
  api.pubsub.subscribe('cmd:execute:todo', async (msg) => {
    const result = await handleTodo(msg.search?.trim() || msg.data?.text || '');
    if (msg.expectResult && msg.resultTopic) {
      api.pubsub.publish(msg.resultTopic, result || { success: true });
    }
  });

  api.pubsub.subscribe('cmd:execute:todos', async (msg) => {
    const result = await handleTodos();
    if (msg.expectResult && msg.resultTopic) {
      api.pubsub.publish(msg.resultTopic, result || { success: true });
    }
  });

  api.pubsub.subscribe('cmd:execute:done', async (msg) => {
    const result = await handleDone(
      msg.search?.trim() || msg.data?.text || '',
      msg.selectedItem
    );
    if (msg.expectResult && msg.resultTopic) {
      api.pubsub.publish(msg.resultTopic, result || { success: true });
    }
  });

  // Manifest declares every command; no need to publish cmd:register here.
};

const uninit = () => {
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
