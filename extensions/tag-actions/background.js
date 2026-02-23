/**
 * Tag Actions Extension - Background Script
 *
 * Listens to tag:item-added and tag:item-removed pubsub events,
 * matches against configured tag-action rules, and executes actions.
 *
 * Action types:
 * - icon: Visual badge on items (broadcast rules for other UIs to render)
 * - publish: Fire a custom pubsub event
 * - open-url: Open a URL template with item data substituted
 * - tag: Automatically add another tag
 *
 * Runs in isolated extension process (peek://ext/tag-actions/background.html)
 */

import { registerNoun, unregisterNoun } from 'peek://ext/cmd/nouns.js';

const api = window.app;
const debug = api.debug;

// Default settings
const defaults = {
  prefs: { autoExecute: true },
  actions: []
};

// In-memory cache
let currentActions = [];
let currentPrefs = { autoExecute: true };

// Circular trigger prevention: tracks action IDs currently being executed
// within a single event chain to prevent infinite loops
let executingActionIds = new Set();

// ==================== Settings ====================

/**
 * Load actions and prefs from extension settings
 */
const loadSettings = async () => {
  const result = await api.settings.get();
  if (result.success && result.data) {
    currentActions = result.data.actions || defaults.actions;
    currentPrefs = result.data.prefs || defaults.prefs;
  } else {
    currentActions = defaults.actions;
    currentPrefs = defaults.prefs;
  }
  debug && console.log('[tag-actions] Loaded settings:', currentActions.length, 'actions');
};

/**
 * Save current state to extension settings
 */
const saveSettings = async () => {
  const result = await api.settings.set({
    prefs: currentPrefs,
    actions: currentActions
  });
  if (!result.success) {
    console.error('[tag-actions] Failed to save settings:', result.error);
  }
  return result;
};

/**
 * Generate unique ID for a tag action
 */
const generateId = () => {
  return `ta_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
};

// ==================== Icon Rules ====================

/**
 * Broadcast current icon rules via pubsub so other UIs can render them.
 * Called on init and whenever icon actions change.
 */
const broadcastIconRules = () => {
  const rules = currentActions
    .filter(a => a.enabled && a.actionType === 'icon')
    .map(a => ({
      tag: a.triggerTag,
      icon: a.actionConfig.icon || 'star',
      color: a.actionConfig.color || '#999999',
      tooltip: a.actionConfig.tooltip || ''
    }));

  api.publish('tag-actions:icon-rules', { rules }, api.scopes.GLOBAL);
  debug && console.log('[tag-actions] Broadcast icon rules:', rules.length);
};

// ==================== Event Handling ====================

/**
 * Handle a tag event (add or remove) by matching against configured actions
 */
const handleTagEvent = async (eventType, msg) => {
  if (!currentPrefs.autoExecute) return;

  const { tagName, itemId, itemType } = msg;
  debug && console.log(`[tag-actions] Tag event: ${eventType}`, tagName, itemId);

  for (const action of currentActions) {
    if (!action.enabled) continue;
    if (action.triggerTag !== tagName) continue;
    if (action.triggerOn !== 'both' && action.triggerOn !== eventType) continue;

    // Item type filter
    if (action.itemTypes && action.itemTypes.length > 0 && !action.itemTypes.includes(itemType)) continue;

    // Filter tag (AND logic) - item must also have this second tag
    if (action.filterTag) {
      const itemTags = await api.datastore.getItemTags(itemId);
      if (!itemTags.success || !itemTags.data.some(t => t.name === action.filterTag)) continue;
    }

    // Circular trigger prevention
    if (executingActionIds.has(action.id)) {
      debug && console.log('[tag-actions] Skipping circular trigger:', action.name);
      continue;
    }

    await executeAction(action, msg);
  }
};

/**
 * Execute a single action
 */
const executeAction = async (action, msg) => {
  debug && console.log('[tag-actions] Executing action:', action.name, action.actionType);

  executingActionIds.add(action.id);

  try {
    switch (action.actionType) {
      case 'icon':
        // Icons are rendered by list UIs based on broadcast rules.
        // Publish a change event so UIs can refresh.
        api.publish('tag-actions:icon-changed', {
          itemId: msg.itemId,
          actionId: action.id
        }, api.scopes.GLOBAL);
        break;

      case 'publish':
        await executePublish(action, msg);
        break;

      case 'open-url':
        await executeOpenUrl(action, msg);
        break;

      case 'tag':
        await executeAddTag(action, msg);
        break;

      default:
        console.warn('[tag-actions] Unknown action type:', action.actionType);
    }
  } catch (err) {
    console.error('[tag-actions] Action execution error:', action.name, err);
  } finally {
    executingActionIds.delete(action.id);
  }
};

/**
 * Execute a "publish" action - fire a custom pubsub event
 */
const executePublish = async (action, msg) => {
  const config = action.actionConfig || {};
  const payload = {
    itemId: msg.itemId,
    tagName: msg.tagName,
    actionId: action.id
  };

  if (config.includeItemData) {
    const item = await api.datastore.getItem(msg.itemId);
    if (item.success && item.data) {
      payload.item = item.data;
    }
  }

  api.publish(config.topic || 'tag-actions:event', payload, api.scopes.GLOBAL);
  debug && console.log('[tag-actions] Published event:', config.topic);
};

/**
 * Execute an "open-url" action - open a URL template with item data substituted
 */
const executeOpenUrl = async (action, msg) => {
  const config = action.actionConfig || {};
  const item = await api.datastore.getItem(msg.itemId);

  if (!item.success || !item.data) {
    console.error('[tag-actions] Could not load item for open-url:', msg.itemId);
    return;
  }

  let url = config.urlTemplate || '';
  url = url.replace('{url}', encodeURIComponent(item.data.content || ''));
  url = url.replace('{id}', encodeURIComponent(msg.itemId));

  // Extract title from metadata
  let title = '';
  if (item.data.metadata) {
    try {
      const meta = typeof item.data.metadata === 'string'
        ? JSON.parse(item.data.metadata)
        : item.data.metadata;
      title = meta.title || '';
    } catch {}
  }
  url = url.replace('{title}', encodeURIComponent(title));

  api.window.open(url, {
    role: 'content',
    width: 800,
    height: 600
  });
  debug && console.log('[tag-actions] Opened URL:', url);
};

/**
 * Execute an "add tag" action - automatically add another tag to the item
 */
const executeAddTag = async (action, msg) => {
  const config = action.actionConfig || {};
  const addTagName = config.addTagName;

  if (!addTagName) {
    console.warn('[tag-actions] Add-tag action has no addTagName configured');
    return;
  }

  const tagResult = await api.datastore.getOrCreateTag(addTagName);
  if (tagResult.success) {
    await api.datastore.tagItem(msg.itemId, tagResult.data.tag.id);
    debug && console.log('[tag-actions] Added tag:', addTagName, 'to item:', msg.itemId);
  } else {
    console.error('[tag-actions] Failed to add tag:', addTagName, tagResult.error);
  }
};

// ==================== CRUD API ====================

/**
 * Create a new tag action
 */
const createAction = async (actionData) => {
  const now = Date.now();
  const action = {
    id: generateId(),
    name: actionData.name || 'Untitled Action',
    enabled: actionData.enabled !== undefined ? actionData.enabled : true,
    triggerTag: actionData.triggerTag || '',
    filterTag: actionData.filterTag || null,
    triggerOn: actionData.triggerOn || 'add',
    actionType: actionData.actionType || 'publish',
    actionConfig: actionData.actionConfig || {},
    itemTypes: actionData.itemTypes || null,
    createdAt: now,
    updatedAt: now
  };

  currentActions.push(action);
  await saveSettings();

  // Re-broadcast icon rules if this is an icon action
  if (action.actionType === 'icon') {
    broadcastIconRules();
  }

  return { success: true, data: action };
};

/**
 * Update an existing tag action
 */
const updateAction = async (actionId, updates) => {
  const index = currentActions.findIndex(a => a.id === actionId);
  if (index === -1) {
    return { success: false, error: 'Action not found' };
  }

  currentActions[index] = {
    ...currentActions[index],
    ...updates,
    updatedAt: Date.now()
  };

  await saveSettings();

  // Re-broadcast icon rules if relevant
  if (currentActions[index].actionType === 'icon' || updates.actionType === 'icon') {
    broadcastIconRules();
  }

  return { success: true, data: currentActions[index] };
};

/**
 * Delete a tag action
 */
const deleteAction = async (actionId) => {
  const index = currentActions.findIndex(a => a.id === actionId);
  if (index === -1) {
    return { success: false, error: 'Action not found' };
  }

  const wasIcon = currentActions[index].actionType === 'icon';
  currentActions.splice(index, 1);
  await saveSettings();

  if (wasIcon) {
    broadcastIconRules();
  }

  return { success: true };
};

/**
 * Get all tag actions
 */
const getActions = () => {
  return { success: true, data: currentActions };
};

/**
 * Get a single tag action by ID
 */
const getAction = (actionId) => {
  const action = currentActions.find(a => a.id === actionId);
  if (!action) {
    return { success: false, error: 'Action not found' };
  }
  return { success: true, data: action };
};

// ==================== UI ====================

/**
 * Open the tag actions home UI
 */
const openTagActions = () => {
  api.window.open('peek://ext/tag-actions/home.html', {
    role: 'workspace',
    key: 'tag-actions-home',
    width: 800,
    height: 600,
    title: 'Tag Actions'
  });
};

// ==================== Commands ====================

const registerCommands = () => {
  registerNoun({
    name: 'tag actions',
    singular: 'tag action',
    description: 'Custom actions triggered by tags',

    query: async ({ search }) => {
      const result = getActions();
      if (!result.success) return { success: false };
      let actions = result.data;
      if (search) {
        const s = search.toLowerCase();
        actions = actions.filter(a =>
          a.name.toLowerCase().includes(s) ||
          a.triggerTag.toLowerCase().includes(s)
        );
      }
      if (actions.length === 0) {
        return { output: 'No tag actions found.', mimeType: 'text/plain' };
      }
      return {
        success: true,
        output: {
          data: actions.map(a => ({
            id: a.id,
            name: a.name,
            enabled: a.enabled,
            triggerTag: a.triggerTag,
            actionType: a.actionType
          })),
          mimeType: 'application/json',
          title: `Tag Actions (${actions.length})`
        }
      };
    },

    browse: async () => { openTagActions(); },

    create: async ({ search }) => {
      const result = await createAction({ name: search || undefined });
      if (result.success) {
        openTagActions();
      }
      return result;
    },

    produces: 'application/json'
  });
};

// ==================== Extension Lifecycle ====================

const init = async () => {
  debug && console.log('[tag-actions] init');

  // Load settings from datastore
  await loadSettings();

  // Register commands
  registerCommands();

  // Subscribe to tag events
  api.subscribe('tag:item-added', async (msg) => {
    await handleTagEvent('add', msg);
  }, api.scopes.GLOBAL);

  api.subscribe('tag:item-removed', async (msg) => {
    await handleTagEvent('remove', msg);
  }, api.scopes.GLOBAL);

  // Respond to icon rule queries from other extensions
  api.subscribe('tag-actions:get-icons', async (msg) => {
    const { itemIds } = msg;
    if (!itemIds || !Array.isArray(itemIds)) return;

    const iconActions = currentActions.filter(a => a.enabled && a.actionType === 'icon');
    const icons = {};

    for (const itemId of itemIds) {
      const itemTags = await api.datastore.getItemTags(itemId);
      if (!itemTags.success) continue;

      const tagNames = new Set(itemTags.data.map(t => t.name));
      const matchingIcons = iconActions
        .filter(a => tagNames.has(a.triggerTag))
        .map(a => ({
          icon: a.actionConfig.icon || 'star',
          color: a.actionConfig.color || '#999999',
          tooltip: a.actionConfig.tooltip || ''
        }));

      if (matchingIcons.length > 0) {
        icons[itemId] = matchingIcons;
      }
    }

    api.publish('tag-actions:icons-response', { icons }, api.scopes.GLOBAL);
  }, api.scopes.GLOBAL);

  // Pubsub API for the home UI to communicate with background
  api.subscribe('tag-actions:get-all', () => {
    api.publish('tag-actions:get-all:response', getActions(), api.scopes.GLOBAL);
  }, api.scopes.GLOBAL);

  api.subscribe('tag-actions:get', (msg) => {
    api.publish('tag-actions:get:response', getAction(msg.actionId), api.scopes.GLOBAL);
  }, api.scopes.GLOBAL);

  api.subscribe('tag-actions:create', async (msg) => {
    const result = await createAction(msg);
    api.publish('tag-actions:create:response', result, api.scopes.GLOBAL);
  }, api.scopes.GLOBAL);

  api.subscribe('tag-actions:update', async (msg) => {
    const result = await updateAction(msg.actionId, msg.updates);
    api.publish('tag-actions:update:response', result, api.scopes.GLOBAL);
  }, api.scopes.GLOBAL);

  api.subscribe('tag-actions:delete', async (msg) => {
    const result = await deleteAction(msg.actionId);
    api.publish('tag-actions:delete:response', result, api.scopes.GLOBAL);
  }, api.scopes.GLOBAL);

  api.subscribe('tag-actions:get-prefs', () => {
    api.publish('tag-actions:get-prefs:response', {
      success: true,
      data: currentPrefs
    }, api.scopes.GLOBAL);
  }, api.scopes.GLOBAL);

  api.subscribe('tag-actions:set-prefs', async (msg) => {
    currentPrefs = { ...currentPrefs, ...msg };
    await saveSettings();
    api.publish('tag-actions:set-prefs:response', {
      success: true,
      data: currentPrefs
    }, api.scopes.GLOBAL);
  }, api.scopes.GLOBAL);

  // Broadcast icon rules on init so any currently-open UIs get them
  broadcastIconRules();

  debug && console.log('[tag-actions] initialized with', currentActions.length, 'actions');
};

const uninit = () => {
  unregisterNoun('tag actions');
};

export default {
  id: 'tag-actions',
  labels: {
    name: 'Tag Actions'
  },
  init,
  uninit
};
