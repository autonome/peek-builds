/**
 * Tag Actions — pair management UI.
 *
 * Stage 3 of peek MCP plan 3d7d9239: pairs are NOT stored in settings
 * any more. Each pair is one row in the `rules` table:
 *   topic   : 'affordance:click'
 *   scriptId: 'tag-swap'
 *   match   : { activeTag, completedTag }       — fires this rule only
 *   config  : { activeTag, completedTag }       — passed to tag-swap
 *   display : { icon, checkedIcon, color, ..., iconPair }
 *
 * The card UI (app/lib/tag-action-affordances.js) reads these via
 * api.rules.listAffordances() and publishes affordance:click on user
 * interaction; the rule engine (backend) routes that to
 * scripts:execute:tag-swap, which the background tile handles.
 */

import { registerNoun, unregisterNoun } from 'peek://cmd/nouns.js';

const api = window.app;

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

const ICON_PAIR_MAP = {
  checkbox: { icon: 'unchecked', checkedIcon: 'checked' },
  eye:      { icon: 'eye-open', checkedIcon: 'eye-closed' },
  star:     { icon: 'star-empty', checkedIcon: 'star-filled' },
  heart:    { icon: 'heart-empty', checkedIcon: 'heart-filled' },
  flag:     { icon: 'flag-empty', checkedIcon: 'flag-filled' },
  bookmark: { icon: 'bookmark-empty', checkedIcon: 'bookmark-filled' }
};

// ==================== State ====================

// In-memory mirror of the rules table for this feature. Each entry:
//   { id, suffix, activeTag, completedTag, iconPair }
// where suffix is the per-row stable id passed to api.rules.register.
let pairs = [];

const buildDisplay = (iconPair) => {
  const icons = ICON_PAIR_MAP[iconPair] || ICON_PAIR_MAP.checkbox;
  return {
    icon: icons.icon,
    checkedIcon: icons.checkedIcon,
    color: '#007aff',
    checkedColor: '#34c759',
    iconPair, // home UI reads this to populate the icon-style dropdown
  };
};

const ruleToPair = (rule) => ({
  id: rule.id,
  suffix: rule.id.startsWith('rule_tag-actions_')
    ? rule.id.slice('rule_tag-actions_'.length)
    : rule.id,
  activeTag: (rule.config && rule.config.activeTag) || '',
  completedTag: (rule.config && rule.config.completedTag) || '',
  iconPair: (rule.display && rule.display.iconPair) || 'checkbox',
});

const generateSuffix = () => `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// ==================== Rules I/O ====================

const loadPairsFromRules = async () => {
  const res = await api.rules.list({ topic: 'affordance:click' });
  if (!res || !Array.isArray(res.rules)) {
    pairs = [];
    return;
  }
  pairs = res.rules
    .filter(r => r.scriptId === 'tag-swap')
    .map(ruleToPair);
};

const upsertPair = async (pair) => {
  if (!pair.suffix) pair.suffix = generateSuffix();
  const args = {
    id: pair.suffix,
    topic: 'affordance:click',
    scriptId: 'tag-swap',
    match: { activeTag: pair.activeTag, completedTag: pair.completedTag },
    config: { activeTag: pair.activeTag, completedTag: pair.completedTag },
    display: buildDisplay(pair.iconPair),
    enabled: true,
  };
  const res = await api.rules.register(args);
  if (res && res.rule) pair.id = res.rule.id;
  else if (res && res.error) console.error('[tag-actions] register failed:', res.error);
};

const deletePair = async (pair) => {
  if (!pair.id) return;
  const res = await api.rules.unregister(pair.id);
  if (res && res.error) console.error('[tag-actions] unregister failed:', res.error);
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
      let filtered = pairs;
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
          data: filtered.map(p => ({ activeTag: p.activeTag, completedTag: p.completedTag, iconPair: p.iconPair })),
          mimeType: 'application/json',
          title: `Tag Pairs (${filtered.length})`
        }
      };
    },

    browse: async () => { openTagActions(); },

    create: async ({ search }) => {
      const np = {
        suffix: generateSuffix(),
        activeTag: search || '',
        completedTag: '',
        iconPair: 'checkbox',
      };
      pairs.push(np);
      await upsertPair(np);
      openTagActions();
      return { success: true };
    },

    produces: 'application/json'
  });
};

// ==================== Escape Handler ====================

const handleEscape = () => ({ handled: false });

// ==================== Rendering ====================

const render = () => {
  const container = document.querySelector('.pairs-list');
  container.innerHTML = '';

  if (pairs.length === 0) {
    container.innerHTML = '<div class="empty-state">No tag pairs yet. Click + to create one.</div>';
    return;
  }

  pairs.forEach((pair, index) => {
    container.appendChild(createPairRow(pair, index));
  });
};

const createPairRow = (pair, index) => {
  const row = document.createElement('div');
  row.className = 'pair-row';

  const iconPreview = document.createElement('div');
  iconPreview.className = 'pair-icon-preview';
  const style = ICON_STYLES[pair.iconPair] || ICON_STYLES.checkbox;
  iconPreview.innerHTML = style.svg;
  row.appendChild(iconPreview);

  const tagsArea = document.createElement('div');
  tagsArea.className = 'pair-tags';

  const activeInput = document.createElement('peek-input');
  activeInput.className = 'pair-tag-input';
  activeInput.value = pair.activeTag || '';
  activeInput.placeholder = 'active tag';
  activeInput.addEventListener('change', async (e) => {
    pair.activeTag = e.target.value.trim();
    await upsertPair(pair);
  });
  tagsArea.appendChild(activeInput);

  const arrow = document.createElement('span');
  arrow.className = 'pair-arrow';
  arrow.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>';
  tagsArea.appendChild(arrow);

  const completedInput = document.createElement('peek-input');
  completedInput.className = 'pair-tag-input';
  completedInput.value = pair.completedTag || '';
  completedInput.placeholder = 'completed tag';
  completedInput.addEventListener('change', async (e) => {
    pair.completedTag = e.target.value.trim();
    await upsertPair(pair);
  });
  tagsArea.appendChild(completedInput);

  row.appendChild(tagsArea);

  const iconSelect = document.createElement('select');
  iconSelect.className = 'pair-icon-select';
  for (const [key, def] of Object.entries(ICON_STYLES)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = def.label;
    opt.selected = pair.iconPair === key;
    iconSelect.appendChild(opt);
  }
  iconSelect.addEventListener('change', async () => {
    pair.iconPair = iconSelect.value;
    const newStyle = ICON_STYLES[pair.iconPair] || ICON_STYLES.checkbox;
    iconPreview.innerHTML = newStyle.svg;
    await upsertPair(pair);
  });
  row.appendChild(iconSelect);

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'pair-delete-btn';
  deleteBtn.title = 'Remove pair';
  deleteBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
  deleteBtn.addEventListener('click', async () => {
    const removed = pairs.splice(index, 1)[0];
    if (removed) await deletePair(removed);
    render();
  });
  row.appendChild(deleteBtn);

  return row;
};

// ==================== Init ====================

const init = async () => {
  await loadPairsFromRules();
  registerCommands();

  api.escape.onEscape(handleEscape);

  // First-run defaults are shipped via tag-actions/manifest.json's
  // top-level `rules: [...]` block (source='manifest', reconciled at
  // boot) — no UI-driven seed needed.

  document.querySelector('.add-pair-btn').addEventListener('click', async () => {
    const np = {
      suffix: generateSuffix(),
      activeTag: '',
      completedTag: '',
      iconPair: 'checkbox',
    };
    pairs.push(np);
    await upsertPair(np);
    render();
    requestAnimationFrame(() => {
      const rows = document.querySelectorAll('.pair-row');
      const lastRow = rows[rows.length - 1];
      if (lastRow) {
        const input = lastRow.querySelector('peek-input');
        if (input) input.focus();
      }
    });
  });

  // Keep the UI in sync with external rule changes (other windows, future
  // user-facing rule editor). Rebuild from the table when something flips.
  api.pubsub.subscribe('rules:changed', async () => {
    await loadPairsFromRules();
    render();
  });

  render();
};

const uninit = () => {
  unregisterNoun('tag actions');
};

document.addEventListener('DOMContentLoaded', init);
