/**
 * Tag Actions Extension - Background Script
 *
 * Stores a simplified "tag pairs" config and converts it to action rules
 * for the affordances renderer. Each pair defines two tags that toggle
 * on item cards with a chosen icon style.
 *
 * Data model (stored in settings):
 *   pairs: [
 *     { activeTag: "todo", completedTag: "done", iconPair: "checkbox" },
 *     { activeTag: "readme", completedTag: "read", iconPair: "eye" }
 *   ]
 *
 * Internally converts pairs to action rules so resolveAffordances() works unchanged.
 */

import { registerNoun, unregisterNoun } from 'peek://ext/cmd/nouns.js';

const api = window.app;
const debug = api.debug;

// ==================== State ====================

let currentPairs = [];
let currentActions = []; // derived from pairs

// ==================== Settings ====================

const loadSettings = async () => {
  const result = await api.settings.get();
  if (result.success && result.data) {
    // Support new pairs format
    if (Array.isArray(result.data.pairs)) {
      currentPairs = result.data.pairs;
    }
    // Migration: convert old actions format to pairs
    else if (Array.isArray(result.data.actions) && result.data.actions.length > 0) {
      currentPairs = migrateActionsToToPairs(result.data.actions);
    } else {
      currentPairs = [];
    }
  } else {
    currentPairs = [];
  }

  // Derive action rules from pairs
  currentActions = pairsToActionRules(currentPairs);
  debug && console.log('[tag-actions] Loaded', currentPairs.length, 'pairs ->', currentActions.length, 'action rules');
};

const saveSettings = async () => {
  const result = await api.settings.set({ pairs: currentPairs });
  if (!result.success) {
    console.error('[tag-actions] Failed to save settings:', result.error);
  }
  // Regenerate action rules
  currentActions = pairsToActionRules(currentPairs);
  return result;
};

// ==================== Migration ====================

/**
 * Convert old-format actions array to new pairs format.
 * Only migrates toggle-type actions (the visual affordance type).
 */
const migrateActionsToToPairs = (actions) => {
  const pairs = [];
  for (const action of actions) {
    if (action.actionType === 'toggle' && action.actionConfig) {
      const config = action.actionConfig;
      // Map old icon names to new iconPair names
      let iconPair = 'checkbox';
      if (config.icon === 'eye' || config.checkedIcon === 'eye') iconPair = 'eye';
      else if (config.icon === 'star' || config.checkedIcon === 'star') iconPair = 'star';
      else if (config.icon === 'heart' || config.checkedIcon === 'heart') iconPair = 'heart';
      else if (config.icon === 'flag' || config.checkedIcon === 'flag') iconPair = 'flag';
      else if (config.icon === 'bookmark' || config.checkedIcon === 'bookmark') iconPair = 'bookmark';

      pairs.push({
        activeTag: config.activeTag || action.triggerTag || '',
        completedTag: config.completedTag || '',
        iconPair
      });
    }
  }
  return pairs;
};

// ==================== Pairs to Action Rules ====================

/**
 * Icon pair name to the icon/checkedIcon names used by tag-action-affordances.js
 */
const ICON_PAIR_MAP = {
  checkbox: { icon: 'unchecked', checkedIcon: 'checked' },
  eye:      { icon: 'eye-open', checkedIcon: 'eye-closed' },
  star:     { icon: 'star-empty', checkedIcon: 'star-filled' },
  heart:    { icon: 'heart-empty', checkedIcon: 'heart-filled' },
  flag:     { icon: 'flag-empty', checkedIcon: 'flag-filled' },
  bookmark: { icon: 'bookmark-empty', checkedIcon: 'bookmark-filled' }
};

/**
 * Convert simplified pairs to action rule objects compatible with resolveAffordances().
 */
const pairsToActionRules = (pairs) => {
  return pairs
    .filter(p => p.activeTag && p.completedTag)
    .map((pair, i) => {
      const icons = ICON_PAIR_MAP[pair.iconPair] || ICON_PAIR_MAP.checkbox;
      return {
        id: `pair_${i}`,
        name: `${pair.activeTag}/${pair.completedTag}`,
        enabled: true,
        triggerTag: pair.activeTag,
        triggerOn: 'add',
        actionType: 'toggle',
        actionConfig: {
          activeTag: pair.activeTag,
          completedTag: pair.completedTag,
          icon: icons.icon,
          checkedIcon: icons.checkedIcon,
          color: '#007aff',
          checkedColor: '#34c759'
        },
        itemTypes: null
      };
    });
};

const generateId = () => {
  return `ta_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
};

// ==================== Event Handling ====================

// Toggle actions are purely UI affordances rendered by card UIs.
// No auto-execution needed for tag events -- the user clicks the toggle.

// ==================== Commands ====================

const openTagActions = () => {
  api.window.open('peek://ext/tag-actions/home.html', {
    role: 'workspace',
    key: 'tag-actions-home',
    width: 560,
    height: 400,
    title: 'Tag Pairs'
  });
};

const registerCommands = () => {
  registerNoun({
    name: 'tag actions',
    singular: 'tag action',
    description: 'Tag pair toggles on item cards',

    query: async ({ search }) => {
      let filtered = currentPairs;
      if (search) {
        const s = search.toLowerCase();
        filtered = filtered.filter(p =>
          p.activeTag.toLowerCase().includes(s) ||
          p.completedTag.toLowerCase().includes(s)
        );
      }
      if (filtered.length === 0) {
        return { output: 'No tag pairs found.', mimeType: 'text/plain' };
      }
      return {
        success: true,
        output: {
          data: filtered,
          mimeType: 'application/json',
          title: `Tag Pairs (${filtered.length})`
        }
      };
    },

    browse: async () => { openTagActions(); },

    create: async ({ search }) => {
      currentPairs.push({ activeTag: search || '', completedTag: '', iconPair: 'checkbox' });
      await saveSettings();
      openTagActions();
      return { success: true };
    },

    produces: 'application/json'
  });
};

// ==================== Extension Lifecycle ====================

const init = async () => {
  debug && console.log('[tag-actions] init');

  await loadSettings();
  registerCommands();

  // Respond to pairs CRUD from the home UI
  api.subscribe('tag-actions:get-pairs', () => {
    api.publish('tag-actions:get-pairs:response', {
      success: true,
      data: currentPairs
    }, api.scopes.GLOBAL);
  }, api.scopes.GLOBAL);

  api.subscribe('tag-actions:set-pairs', async (msg) => {
    if (Array.isArray(msg.pairs)) {
      currentPairs = msg.pairs;
      await saveSettings();
    }
    api.publish('tag-actions:set-pairs:response', {
      success: true,
      data: currentPairs
    }, api.scopes.GLOBAL);
  }, api.scopes.GLOBAL);

  // Backward-compatible: respond to get-all with derived action rules
  // so tag-action-affordances.js cache still works
  api.subscribe('tag-actions:get-all', () => {
    api.publish('tag-actions:get-all:response', {
      success: true,
      data: currentActions
    }, api.scopes.GLOBAL);
  }, api.scopes.GLOBAL);

  // Legacy CRUD endpoints -- respond gracefully but pairs is the source of truth now
  api.subscribe('tag-actions:create', async (msg) => {
    // If it looks like a toggle action, convert to pair
    if (msg.actionType === 'toggle' && msg.actionConfig) {
      currentPairs.push({
        activeTag: msg.actionConfig.activeTag || msg.triggerTag || '',
        completedTag: msg.actionConfig.completedTag || '',
        iconPair: 'checkbox'
      });
      await saveSettings();
    }
    api.publish('tag-actions:create:response', { success: true }, api.scopes.GLOBAL);
  }, api.scopes.GLOBAL);

  api.subscribe('tag-actions:update', async (msg) => {
    api.publish('tag-actions:update:response', { success: true }, api.scopes.GLOBAL);
  }, api.scopes.GLOBAL);

  api.subscribe('tag-actions:delete', async (msg) => {
    api.publish('tag-actions:delete:response', { success: true }, api.scopes.GLOBAL);
  }, api.scopes.GLOBAL);

  debug && console.log('[tag-actions] initialized with', currentPairs.length, 'pairs');
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
