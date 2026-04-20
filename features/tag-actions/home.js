/**
 * Tag Actions - Single Resident Tile
 *
 * Combines background state management and UI in one tile (resident: true).
 * State (pairs, action rules), settings I/O, command registration, and
 * external pubsub handlers (tag-actions:get-all, :create, :update, :delete)
 * all live here. Internal get-pairs/set-pairs request-response replaced with
 * direct function calls.
 *
 * Shows a flat list of tag pairs. Each pair has:
 * - Active tag (e.g. "todo")
 * - Completed tag (e.g. "done")
 * - Icon style (checkbox, eye, star, etc.)
 *
 * External consumers (tag-action-affordances.js) still use:
 *   tag-actions:get-all / tag-actions:get-all:response
 *   tag-actions:create:response, :update:response, :delete:response
 */

import { registerNoun, unregisterNoun } from 'peek://cmd/nouns.js';

const api = window.app;
const debug = api.debug;

// ==================== Icon Style Definitions ====================

const ICON_STYLES = {
  checkbox: {
    label: 'Checkbox',
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>'
  },
  eye: {
    label: 'Eye',
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
  },
  star: {
    label: 'Star',
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>'
  },
  heart: {
    label: 'Heart',
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>'
  },
  flag: {
    label: 'Flag',
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>'
  },
  bookmark: {
    label: 'Bookmark',
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>'
  }
};

// ==================== Default Pairs ====================

const DEFAULT_PAIRS = [
  { activeTag: 'todo', completedTag: 'done', iconPair: 'checkbox' },
  { activeTag: 'readme', completedTag: 'read', iconPair: 'eye' }
];

// ==================== State ====================

let currentPairs = [];
let currentActions = []; // derived from pairs

// ==================== Settings ====================

const loadSettings = async () => {
  const result = await api.settings.get('data');
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
  const result = await api.settings.set('data', { pairs: currentPairs });
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

// ==================== Commands ====================

const openTagActions = () => {
  api.window.open('peek://tag-actions/home.html', {
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

// ==================== External Pubsub Handlers ====================
// These topics are consumed by tag-action-affordances.js (external shared lib)
// and must remain as pubsub even in the single-tile model.

const registerExternalHandlers = () => {
  // tag-action-affordances.js queries for action rules
  api.pubsub.subscribe('tag-actions:get-all', () => {
    api.pubsub.publish('tag-actions:get-all:response', {
      success: true,
      data: currentActions
    }, api.scopes.GLOBAL);
  }, api.scopes.GLOBAL);

  // Legacy CRUD endpoints -- respond gracefully; pairs is the source of truth
  api.pubsub.subscribe('tag-actions:create', async (msg) => {
    // If it looks like a toggle action, convert to pair
    if (msg.actionType === 'toggle' && msg.actionConfig) {
      currentPairs.push({
        activeTag: msg.actionConfig.activeTag || msg.triggerTag || '',
        completedTag: msg.actionConfig.completedTag || '',
        iconPair: 'checkbox'
      });
      await saveSettings();
    }
    api.pubsub.publish('tag-actions:create:response', { success: true }, api.scopes.GLOBAL);
  }, api.scopes.GLOBAL);

  api.pubsub.subscribe('tag-actions:update', async (_msg) => {
    api.pubsub.publish('tag-actions:update:response', { success: true }, api.scopes.GLOBAL);
  }, api.scopes.GLOBAL);

  api.pubsub.subscribe('tag-actions:delete', async (_msg) => {
    api.pubsub.publish('tag-actions:delete:response', { success: true }, api.scopes.GLOBAL);
  }, api.scopes.GLOBAL);
};

// ==================== Escape Handler ====================

const handleEscape = () => {
  return { handled: false };
};

// ==================== Rendering ====================

const render = () => {
  const container = document.querySelector('.pairs-list');
  container.innerHTML = '';

  if (currentPairs.length === 0) {
    container.innerHTML = '<div class="empty-state">No tag pairs yet. Click + to create one.</div>';
    return;
  }

  currentPairs.forEach((pair, index) => {
    container.appendChild(createPairRow(pair, index));
  });
};

const createPairRow = (pair, index) => {
  const row = document.createElement('div');
  row.className = 'pair-row';

  // Icon preview
  const iconPreview = document.createElement('div');
  iconPreview.className = 'pair-icon-preview';
  const style = ICON_STYLES[pair.iconPair] || ICON_STYLES.checkbox;
  iconPreview.innerHTML = style.svg;
  row.appendChild(iconPreview);

  // Tags area
  const tagsArea = document.createElement('div');
  tagsArea.className = 'pair-tags';

  // Active tag input
  const activeInput = document.createElement('peek-input');
  activeInput.className = 'pair-tag-input';
  activeInput.value = pair.activeTag || '';
  activeInput.placeholder = 'active tag';
  activeInput.addEventListener('change', (e) => {
    pair.activeTag = e.target.value.trim();
    saveSettings();
  });
  tagsArea.appendChild(activeInput);

  // Arrow
  const arrow = document.createElement('span');
  arrow.className = 'pair-arrow';
  arrow.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>';
  tagsArea.appendChild(arrow);

  // Completed tag input
  const completedInput = document.createElement('peek-input');
  completedInput.className = 'pair-tag-input';
  completedInput.value = pair.completedTag || '';
  completedInput.placeholder = 'completed tag';
  completedInput.addEventListener('change', (e) => {
    pair.completedTag = e.target.value.trim();
    saveSettings();
  });
  tagsArea.appendChild(completedInput);

  row.appendChild(tagsArea);

  // Icon style selector
  const iconSelect = document.createElement('select');
  iconSelect.className = 'pair-icon-select';
  for (const [key, def] of Object.entries(ICON_STYLES)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = def.label;
    opt.selected = pair.iconPair === key;
    iconSelect.appendChild(opt);
  }
  iconSelect.addEventListener('change', () => {
    pair.iconPair = iconSelect.value;
    // Update icon preview
    const newStyle = ICON_STYLES[pair.iconPair] || ICON_STYLES.checkbox;
    iconPreview.innerHTML = newStyle.svg;
    saveSettings();
  });
  row.appendChild(iconSelect);

  // Delete button
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'pair-delete-btn';
  deleteBtn.title = 'Remove pair';
  deleteBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
  deleteBtn.addEventListener('click', async () => {
    currentPairs.splice(index, 1);
    await saveSettings();
    render();
  });
  row.appendChild(deleteBtn);

  return row;
};

// ==================== Init ====================

const init = async () => {
  debug && console.log('[tag-actions] init');

  await loadSettings();
  registerCommands();
  registerExternalHandlers();

  api.escape.onEscape(handleEscape);

  // If no pairs exist, populate defaults
  if (currentPairs.length === 0) {
    currentPairs = DEFAULT_PAIRS.map(p => ({ ...p }));
    await saveSettings();
  }

  // Add pair button
  document.querySelector('.add-pair-btn').addEventListener('click', async () => {
    currentPairs.push({ activeTag: '', completedTag: '', iconPair: 'checkbox' });
    await saveSettings();
    render();
    // Focus the first empty input in the new row
    requestAnimationFrame(() => {
      const rows = document.querySelectorAll('.pair-row');
      const lastRow = rows[rows.length - 1];
      if (lastRow) {
        const input = lastRow.querySelector('peek-input');
        if (input) input.focus();
      }
    });
  });

  render();

  debug && console.log('[tag-actions] initialized with', currentPairs.length, 'pairs');
};

const uninit = () => {
  unregisterNoun('tag actions');
};

document.addEventListener('DOMContentLoaded', init);
