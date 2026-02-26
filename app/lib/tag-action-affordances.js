/**
 * Tag Action Affordances - Shared module for rendering tag action UI elements on cards.
 *
 * Queries the tag-actions extension for applicable affordances given an item's tags,
 * and renders the appropriate DOM elements (icon badges, toggle checkboxes, etc.).
 *
 * Usage:
 *   import { createAffordanceElements, resolveAffordances } from 'peek://app/lib/tag-action-affordances.js';
 *
 *   // Get affordance descriptors for an item
 *   const affordances = resolveAffordances(itemTags, actionRules);
 *
 *   // Or create DOM elements directly
 *   const elements = createAffordanceElements(itemId, itemTags, actionRules, api);
 *
 * The module is loosely coupled: it receives action rules as data, doesn't import
 * the tag-actions extension, and works with any action type the config defines.
 */

// ── SVG Icons (subset matching tag-actions icon set) ──────────────────────

const ICON_SVGS = {
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  archive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24z"/></svg>'
};

// Toggle-specific SVGs (checkbox style, matching mobile pattern)
const TOGGLE_SVGS = {
  unchecked: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>',
  checked: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><polyline points="9 11 12 14 22 4"></polyline></svg>'
};

// ── Affordance Resolution ─────────────────────────────────────────────────

/**
 * Resolve which affordances apply to an item given its tags and the action rules.
 *
 * @param {string[]} itemTagNames - Array of tag name strings on the item
 * @param {object[]} actionRules - Array of tag action rule objects from the extension
 * @returns {object[]} Array of affordance descriptors
 *
 * Affordance descriptor shapes:
 *   { type: 'icon', icon: string, color: string, tooltip: string }
 *   { type: 'toggle', checked: boolean, activeTag: string, completedTag: string,
 *     label: string, icon: string, checkedIcon: string, color: string, checkedColor: string }
 */
export const resolveAffordances = (itemTagNames, actionRules) => {
  if (!actionRules || !Array.isArray(actionRules) || actionRules.length === 0) return [];
  if (!itemTagNames || itemTagNames.length === 0) return [];

  const tagSet = new Set(itemTagNames);
  const affordances = [];

  for (const action of actionRules) {
    if (!action.enabled) continue;

    switch (action.actionType) {
      case 'icon': {
        if (tagSet.has(action.triggerTag)) {
          const config = action.actionConfig || {};
          affordances.push({
            type: 'icon',
            actionId: action.id,
            icon: config.icon || 'star',
            color: config.color || '#999999',
            tooltip: config.tooltip || action.triggerTag
          });
        }
        break;
      }

      case 'toggle': {
        const config = action.actionConfig || {};
        const activeTag = config.activeTag || action.triggerTag;
        const completedTag = config.completedTag || '';
        if (!completedTag) break;

        const hasActive = tagSet.has(activeTag);
        const hasCompleted = tagSet.has(completedTag);
        if (!hasActive && !hasCompleted) break;

        affordances.push({
          type: 'toggle',
          actionId: action.id,
          checked: hasCompleted,
          activeTag,
          completedTag,
          label: action.name || activeTag + '/' + completedTag,
          icon: config.icon || 'unchecked',
          checkedIcon: config.checkedIcon || 'checked',
          color: config.color || '#007aff',
          checkedColor: config.checkedColor || '#34c759'
        });
        break;
      }

      // Other action types (publish, open-url, tag) don't produce visual affordances on cards
    }
  }

  return affordances;
};

// ── DOM Element Creation ──────────────────────────────────────────────────

/**
 * Create a container with affordance DOM elements for an item.
 *
 * @param {string} itemId - The item's ID
 * @param {string[]} itemTagNames - Tag names on the item
 * @param {object[]} actionRules - Tag action rules from the extension
 * @param {object} api - The window.app API object
 * @param {object} [options] - Options
 * @param {Function} [options.onToggle] - Callback after a toggle executes: (itemId, affordance) => void
 * @returns {HTMLElement|null} A container element with affordance elements, or null if none
 */
export const createAffordanceElements = (itemId, itemTagNames, actionRules, api, options = {}) => {
  const affordances = resolveAffordances(itemTagNames, actionRules);
  if (affordances.length === 0) return null;

  const container = document.createElement('span');
  container.className = 'tag-action-affordances';
  container.style.cssText = 'display:inline-flex;align-items:center;gap:4px;flex-shrink:0;';

  for (const aff of affordances) {
    let el;
    switch (aff.type) {
      case 'icon':
        el = createIconBadge(aff);
        break;
      case 'toggle':
        el = createToggleButton(itemId, aff, api, options);
        break;
    }
    if (el) container.appendChild(el);
  }

  return container.children.length > 0 ? container : null;
};

/**
 * Create an icon badge element for an icon affordance.
 */
const createIconBadge = (aff) => {
  const badge = document.createElement('span');
  badge.className = 'tag-action-icon';
  badge.title = aff.tooltip;
  badge.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;color:' + aff.color + ';flex-shrink:0;';
  badge.innerHTML = ICON_SVGS[aff.icon] || ICON_SVGS.star;
  // Scale the SVG down
  const svg = badge.querySelector('svg');
  if (svg) {
    svg.style.width = '14px';
    svg.style.height = '14px';
  }
  return badge;
};

/**
 * Create a toggle button element for a toggle affordance.
 * Handles click to swap tags (remove one, add the other) via the datastore API.
 */
const createToggleButton = (itemId, aff, api, options = {}) => {
  const btn = document.createElement('button');
  btn.className = 'tag-action-toggle ' + (aff.checked ? 'checked' : '');
  btn.title = aff.label;
  btn.dataset.actionId = aff.actionId;
  btn.style.cssText =
    'background:none;border:none;padding:2px;cursor:pointer;' +
    'color:' + (aff.checked ? aff.checkedColor : aff.color) + ';' +
    'flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;' +
    'transition:color 0.15s,opacity 0.15s;opacity:0.85;';

  // Use toggle-specific SVGs or fall back to icon library
  const iconKey = aff.checked ? aff.checkedIcon : aff.icon;
  btn.innerHTML = TOGGLE_SVGS[iconKey] || ICON_SVGS[iconKey] || TOGGLE_SVGS[aff.checked ? 'checked' : 'unchecked'];

  btn.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
  btn.addEventListener('mouseleave', () => { btn.style.opacity = '0.85'; });

  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    e.preventDefault();

    // Prevent double-click
    if (btn.dataset.executing === 'true') return;
    btn.dataset.executing = 'true';
    btn.style.opacity = '0.4';

    try {
      const removeTag = aff.checked ? aff.completedTag : aff.activeTag;
      const addTag = aff.checked ? aff.activeTag : aff.completedTag;

      // Get or create the tag to add
      const addTagResult = await api.datastore.getOrCreateTag(addTag);
      if (!addTagResult.success) {
        console.error('[tag-action-affordances] Failed to get/create tag:', addTag, addTagResult.error);
        return;
      }

      // Get tag ID of the tag to remove
      const removeTagResult = await api.datastore.getOrCreateTag(removeTag);
      if (!removeTagResult.success) {
        console.error('[tag-action-affordances] Failed to get tag for removal:', removeTag, removeTagResult.error);
        return;
      }

      // Remove old tag, add new tag
      await api.datastore.untagItem(itemId, removeTagResult.data.tag.id);
      await api.datastore.tagItem(itemId, addTagResult.data.tag.id);

      // Update visual state immediately
      const nowChecked = !aff.checked;
      btn.className = 'tag-action-toggle ' + (nowChecked ? 'checked' : '');
      btn.style.color = nowChecked ? aff.checkedColor : aff.color;
      const newIconKey = nowChecked ? aff.checkedIcon : aff.icon;
      btn.innerHTML = TOGGLE_SVGS[newIconKey] || ICON_SVGS[newIconKey] || TOGGLE_SVGS[nowChecked ? 'checked' : 'unchecked'];
      aff.checked = nowChecked;

      // Notify caller
      if (options.onToggle) {
        options.onToggle(itemId, aff);
      }
    } catch (err) {
      console.error('[tag-action-affordances] Toggle failed:', err);
    } finally {
      btn.dataset.executing = 'false';
      btn.style.opacity = '0.85';
    }
  });

  return btn;
};

// ── Action Rules Cache ────────────────────────────────────────────────────

/**
 * Subscribe to tag action rules from the extension and maintain a local cache.
 * Returns an object with `getRules()` to access cached rules, and `destroy()` to clean up.
 *
 * @param {object} api - The window.app API object
 * @returns {{ getRules: () => object[], destroy: () => void }}
 */
export const createActionRulesCache = (api) => {
  let rules = [];
  let loaded = false;

  // Listen for rules broadcast from the tag-actions extension
  const unsubRules = api.subscribe('tag-actions:get-all:response', (msg) => {
    if (msg.success && Array.isArray(msg.data)) {
      rules = msg.data;
      loaded = true;
    }
  }, api.scopes.GLOBAL);

  // Listen for changes (create/update/delete)
  const unsubCreate = api.subscribe('tag-actions:create:response', () => {
    api.publish('tag-actions:get-all', {}, api.scopes.GLOBAL);
  }, api.scopes.GLOBAL);

  const unsubUpdate = api.subscribe('tag-actions:update:response', () => {
    api.publish('tag-actions:get-all', {}, api.scopes.GLOBAL);
  }, api.scopes.GLOBAL);

  const unsubDelete = api.subscribe('tag-actions:delete:response', () => {
    api.publish('tag-actions:get-all', {}, api.scopes.GLOBAL);
  }, api.scopes.GLOBAL);

  // Initial fetch
  api.publish('tag-actions:get-all', {}, api.scopes.GLOBAL);

  return {
    getRules: () => rules,
    isLoaded: () => loaded,
    destroy: () => {
      if (unsubRules) unsubRules();
      if (unsubCreate) unsubCreate();
      if (unsubUpdate) unsubUpdate();
      if (unsubDelete) unsubDelete();
    }
  };
};
