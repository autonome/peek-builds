/**
 * Tag Actions - Simplified Tag Pairs UI
 *
 * Shows a flat list of tag pairs. Each pair has:
 * - Active tag (e.g. "todo")
 * - Completed tag (e.g. "done")
 * - Icon style (checkbox, eye, star, etc.)
 *
 * Communicates with background.js via pubsub request/response pattern.
 */

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

let pairs = [];

// ==================== Pubsub Helpers ====================

const request = (topic, data = {}) => {
  return new Promise((resolve) => {
    const handler = (msg) => {
      resolve(msg);
    };
    api.subscribe(`${topic}:response`, handler, api.scopes.GLOBAL);
    api.publish(topic, data, api.scopes.GLOBAL);
  });
};

// ==================== Data Loading ====================

const loadPairs = async () => {
  const result = await request('tag-actions:get-pairs');
  if (result.success && Array.isArray(result.data)) {
    pairs = result.data;
  } else {
    pairs = [];
  }
  debug && console.log('[tag-actions:home] Loaded pairs:', pairs.length);
};

const savePairs = async () => {
  await request('tag-actions:set-pairs', { pairs });
  debug && console.log('[tag-actions:home] Saved pairs:', pairs.length);
};

// ==================== Escape Handler ====================

const handleEscape = () => {
  return { handled: false };
};

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
    savePairs();
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
    savePairs();
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
    savePairs();
  });
  row.appendChild(iconSelect);

  // Delete button
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'pair-delete-btn';
  deleteBtn.title = 'Remove pair';
  deleteBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
  deleteBtn.addEventListener('click', async () => {
    pairs.splice(index, 1);
    await savePairs();
    render();
  });
  row.appendChild(deleteBtn);

  return row;
};

// ==================== Init ====================

const init = async () => {
  debug && console.log('[tag-actions:home] init');

  api.escape.onEscape(handleEscape);

  await loadPairs();

  // If no pairs exist, populate defaults
  if (pairs.length === 0) {
    pairs = DEFAULT_PAIRS.map(p => ({ ...p }));
    await savePairs();
  }

  // Add pair button
  document.querySelector('.add-pair-btn').addEventListener('click', async () => {
    pairs.push({ activeTag: '', completedTag: '', iconPair: 'checkbox' });
    await savePairs();
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
};

document.addEventListener('DOMContentLoaded', init);
