/**
 * Tag Action Affordances — shared module for rendering affordances on
 * cards (toggle checkboxes, icon badges) declared by the rule engine.
 *
 * Stage 3 of peek MCP plan 3d7d9239: this module no longer queries the
 * tag-actions feature's own pubsub topics. Instead it asks the rule
 * engine for "every rule with a non-empty `display` block" via
 * api.rules.listAffordances() and renders each row that applies to
 * the item's current tags. On click, it publishes `affordance:click`
 * — which the rule engine routes to the rule's script. The script
 * (e.g. tag-swap, in tag-actions/background.js) does the actual
 * datastore work.
 *
 * Public surface:
 *   resolveAffordances(itemTagNames, rules)
 *     → array of affordance descriptors (icon / toggle)
 *   createAffordanceElements(itemId, itemTagNames, rules, api, options)
 *     → DOM container with per-affordance elements
 *   createActionRulesCache(api)
 *     → { getRules, isLoaded, destroy } — keeps a fresh local cache via
 *       api.rules.listAffordances + a rules:changed subscription
 *
 * Consumers must declare `rules` in their tile manifest's capabilities.
 */

// ── SVG Icons (subset matching tag-actions icon set) ──────────────────────

const ICON_SVGS = {
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
};

const TOGGLE_SVGS = {
  unchecked: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>',
  checked: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><polyline points="9 11 12 14 22 4"></polyline></svg>',
  'eye-open': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  'eye-closed': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>',
  'star-empty': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  'star-filled': '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  'heart-empty': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
  'heart-filled': '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
  'flag-empty': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>',
  'flag-filled': '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>',
  'bookmark-empty': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
  'bookmark-filled': '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
};

// ── Affordance Resolution ─────────────────────────────────────────────────

/**
 * Resolve which affordances apply to an item given its tags and the
 * affordance-rules list (each rule has display + match + scriptId).
 *
 * Stage 1: only tag-swap rules are recognised (the only kind
 * shipping yet). The shape leaves room for other scriptIds — different
 * scripts will produce different affordance shapes (icon, toggle, …).
 *
 * @param {string[]} itemTagNames
 * @param {object[]} rules - Array of rule objects from api.rules.listAffordances
 * @returns {object[]} affordance descriptors
 */
export const resolveAffordances = (itemTagNames, rules) => {
  if (!Array.isArray(rules) || rules.length === 0) return [];
  if (!Array.isArray(itemTagNames) || itemTagNames.length === 0) return [];

  const tagSet = new Set(itemTagNames);
  const affordances = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;

    // tag-swap is the only Stage-1 affordance kind. Future scriptIds
    // (e.g. 'badge', 'open-url') would branch here.
    if (rule.scriptId === 'tag-swap') {
      const config = rule.config || {};
      const display = rule.display || {};
      const activeTag = config.activeTag;
      const completedTag = config.completedTag;
      if (!activeTag || !completedTag) continue;

      const hasActive = tagSet.has(activeTag);
      const hasCompleted = tagSet.has(completedTag);
      if (!hasActive && !hasCompleted) continue;

      affordances.push({
        type: 'toggle',
        ruleId: rule.id,
        checked: hasCompleted,
        activeTag,
        completedTag,
        label: `${activeTag}/${completedTag}`,
        icon: display.icon || 'unchecked',
        checkedIcon: display.checkedIcon || 'checked',
        color: display.color || '#007aff',
        checkedColor: display.checkedColor || '#34c759',
      });
    }
  }

  return affordances;
};

// ── DOM Element Creation ──────────────────────────────────────────────────

/**
 * Create a container with affordance DOM elements for an item.
 *
 * @param {string} itemId
 * @param {string[]} itemTagNames
 * @param {object[]} rules - From api.rules.listAffordances
 * @param {object} api - The window.app API object
 * @param {object} [options]
 * @param {Function} [options.onToggle] - (itemId, affordance) => void
 * @returns {HTMLElement|null}
 */
export const createAffordanceElements = (itemId, itemTagNames, rules, api, options = {}) => {
  const affordances = resolveAffordances(itemTagNames, rules);
  if (affordances.length === 0) return null;

  const container = document.createElement('span');
  container.className = 'tag-action-affordances';
  container.style.cssText = 'display:inline-flex;align-items:center;gap:4px;flex-shrink:0;';

  container.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
  });

  for (const aff of affordances) {
    let el;
    switch (aff.type) {
      case 'toggle':
        el = createToggleButton(itemId, aff, api, options);
        break;
    }
    if (el) container.appendChild(el);
  }

  return container.children.length > 0 ? container : null;
};

/**
 * Create a toggle button. On click, publishes `affordance:click` with
 * { ruleId, itemId, checked, activeTag, completedTag }. The rule
 * engine routes this to the rule's script, which performs the swap.
 *
 * The visual state updates optimistically — the rule's behaviour is
 * deterministic and the script runs in-process, so a failed swap is
 * an exceptional condition (it would have logged in the script).
 */
const createToggleButton = (itemId, aff, api, options = {}) => {
  const btn = document.createElement('button');
  btn.className = 'tag-action-toggle ' + (aff.checked ? 'checked' : '');
  btn.title = aff.label;
  btn.dataset.ruleId = aff.ruleId;
  btn.style.cssText =
    'background:none;border:none;padding:2px;cursor:pointer;' +
    'color:' + (aff.checked ? aff.checkedColor : aff.color) + ';' +
    'flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;' +
    'transition:color 0.15s,opacity 0.15s;opacity:0.85;';

  const iconKey = aff.checked ? aff.checkedIcon : aff.icon;
  btn.innerHTML = TOGGLE_SVGS[iconKey] || ICON_SVGS[iconKey] || TOGGLE_SVGS[aff.checked ? 'checked' : 'unchecked'];

  btn.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
  btn.addEventListener('mouseleave', () => { btn.style.opacity = '0.85'; });

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (btn.dataset.executing === 'true') return;
    btn.dataset.executing = 'true';
    btn.style.opacity = '0.4';

    const nowChecked = !aff.checked;
    api.pubsub.publish('affordance:click', {
      ruleId: aff.ruleId,
      itemId,
      checked: nowChecked,
      activeTag: aff.activeTag,
      completedTag: aff.completedTag,
    });

    // Optimistic visual update.
    btn.className = 'tag-action-toggle ' + (nowChecked ? 'checked' : '');
    btn.style.color = nowChecked ? aff.checkedColor : aff.color;
    const newIconKey = nowChecked ? aff.checkedIcon : aff.icon;
    btn.innerHTML = TOGGLE_SVGS[newIconKey] || ICON_SVGS[newIconKey] || TOGGLE_SVGS[nowChecked ? 'checked' : 'unchecked'];
    aff.checked = nowChecked;

    if (options.onToggle) {
      try { options.onToggle(itemId, aff); }
      catch (err) { console.error('[tag-action-affordances] onToggle threw:', err); }
    }

    btn.dataset.executing = 'false';
    btn.style.opacity = '0.85';
  });

  return btn;
};

// ── Action Rules Cache ────────────────────────────────────────────────────

/**
 * Subscribe to affordance rules and maintain a local cache. Rebuilds
 * when `rules:changed` fires.
 *
 * @param {object} api - The window.app API object
 * @returns {{ getRules: () => object[], isLoaded: () => boolean, destroy: () => void }}
 */
export const createActionRulesCache = (api) => {
  let rules = [];
  let loaded = false;

  const refresh = async () => {
    try {
      const res = await api.rules.listAffordances();
      if (res && Array.isArray(res.rules)) {
        rules = res.rules;
        loaded = true;
      }
    } catch (err) {
      console.error('[tag-action-affordances] refresh failed:', err);
    }
  };

  // Initial fetch.
  refresh();

  // Pubsub subscribe returns an unsubscribe function in this codebase.
  const unsub = api.pubsub.subscribe('rules:changed', () => { refresh(); });

  return {
    getRules: () => rules,
    isLoaded: () => loaded,
    destroy: () => {
      try { if (typeof unsub === 'function') unsub(); }
      catch { /* swallow */ }
    },
  };
};
