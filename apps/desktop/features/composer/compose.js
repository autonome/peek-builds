/**
 * Composer UI
 *
 * Single-screen item creation with auto-type detection and tag management.
 * Accesses the datastore via window.app (ContextBridge frozen API).
 */

const hasPeekAPI = typeof window.app !== 'undefined';
const api = hasPeekAPI ? window.app : null;

// ── State ──

let selectedTags = [];   // string[] — tag names chosen by the user
let allTags = [];        // { id, name }[] — all tags by frecency
let tagFilter = '';      // current text in the tag input

// ── Helpers ──

/**
 * Detect item type from content string.
 * - URL if content starts with http:// or https://
 * - tagset if entire non-empty content is #hashtag tokens
 * - text otherwise
 */
function detectType(content) {
  const trimmed = content.trim();
  if (!trimmed) return 'text';
  if (/^https?:\/\//i.test(trimmed)) return 'url';
  // tagset: every whitespace-separated token starts with #
  const tokens = trimmed.split(/\s+/);
  if (tokens.length > 0 && tokens.every(t => /^#\S+/.test(t))) return 'tagset';
  return 'text';
}

/**
 * Return tag suggestions: top 20 from allTags not already selected,
 * optionally filtered by tagFilter prefix.
 */
function getSuggestions() {
  const filter = tagFilter.toLowerCase().replace(/^#/, '');
  return allTags
    .filter(t => !selectedTags.includes(t.name))
    .filter(t => !filter || t.name.toLowerCase().includes(filter))
    .slice(0, 20);
}

// ── Render ──

function renderSelectedTags(container) {
  container.innerHTML = '';
  for (const name of selectedTags) {
    const pill = document.createElement('span');
    pill.className = 'tag-pill';
    pill.textContent = '#' + name;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'tag-pill-remove';
    removeBtn.setAttribute('aria-label', 'Remove tag ' + name);
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => {
      removeTag(name);
    });

    pill.appendChild(removeBtn);
    container.appendChild(pill);
  }
}

function renderSuggestions(container) {
  container.innerHTML = '';
  const suggestions = getSuggestions();
  for (const tag of suggestions) {
    const chip = document.createElement('button');
    chip.className = 'tag-chip';
    chip.textContent = '#' + tag.name;
    chip.addEventListener('click', () => {
      addTag(tag.name);
    });
    container.appendChild(chip);
  }
}

// ── Tag operations ──

function addTag(name) {
  const normalized = name.trim().replace(/^#/, '').toLowerCase();
  if (!normalized) return;
  if (selectedTags.includes(normalized)) return;
  selectedTags.push(normalized);
  tagFilter = '';
  document.getElementById('tag-input').value = '';
  updateTagUI();
}

function removeTag(name) {
  selectedTags = selectedTags.filter(t => t !== name);
  updateTagUI();
}

function updateTagUI() {
  renderSelectedTags(document.getElementById('selected-tags'));
  renderSuggestions(document.getElementById('tag-suggestions'));
}

// ── Save ──

async function save() {
  const saveBtn = document.getElementById('save-btn');
  saveBtn.disabled = true;

  const content = document.getElementById('content-textarea').value.trim();
  if (!content) {
    saveBtn.disabled = false;
    return;
  }

  const type = detectType(content);

  try {
    // Create the item
    const result = await api.datastore.addItem(type, { content });
    if (!result.success) {
      console.error('[composer] addItem failed:', result);
      saveBtn.disabled = false;
      return;
    }

    const itemId = result.data.id;

    // Tag the item
    for (const tagName of selectedTags) {
      const tagResult = await api.datastore.getOrCreateTag(tagName);
      if (tagResult.success) {
        const tagId = tagResult.data.tag.id;
        await api.datastore.tagItem(itemId, tagId);
      } else {
        console.error('[composer] getOrCreateTag failed for', tagName, tagResult);
      }
    }

    window.close();
  } catch (err) {
    console.error('[composer] save error:', err);
    saveBtn.disabled = false;
  }
}

// ── Initialize ──

async function init() {
  // Build DOM inside #composer-root
  const root = document.getElementById('composer-root');
  root.innerHTML = `
    <div class="composer-header">
      <button class="btn btn-cancel" id="cancel-btn">Cancel</button>
      <button class="btn btn-save" id="save-btn">Save</button>
    </div>
    <div class="composer-content">
      <textarea
        id="content-textarea"
        placeholder="Write..."
        autofocus
      ></textarea>
    </div>
    <div class="composer-footer">
      <div class="tag-input-row">
        <input
          type="text"
          id="tag-input"
          placeholder="tag input..."
          autocomplete="off"
          spellcheck="false"
        >
        <button class="btn-add-tag" id="add-tag-btn">Add</button>
      </div>
      <div class="selected-tags" id="selected-tags"></div>
      <div class="tag-suggestions" id="tag-suggestions"></div>
    </div>
  `;

  // Wire Cancel
  document.getElementById('cancel-btn').addEventListener('click', () => {
    window.close();
  });

  // Wire Save
  document.getElementById('save-btn').addEventListener('click', save);

  // Wire keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      window.close();
    }
    // Cmd/Ctrl+Enter saves
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      save();
    }
  });

  // Wire tag input
  const tagInput = document.getElementById('tag-input');

  tagInput.addEventListener('input', () => {
    tagFilter = tagInput.value;
    renderSuggestions(document.getElementById('tag-suggestions'));
  });

  tagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const val = tagInput.value.replace(/,$/, '').trim();
      if (val) addTag(val);
    }
  });

  document.getElementById('add-tag-btn').addEventListener('click', () => {
    const val = tagInput.value.trim();
    if (val) addTag(val);
  });

  // Load tag suggestions from datastore
  if (hasPeekAPI) {
    try {
      await api.initialize();
      const tagsResult = await api.datastore.getTagsByFrecency();
      if (tagsResult.success) {
        allTags = tagsResult.data || [];
      } else {
        console.warn('[composer] getTagsByFrecency failed:', tagsResult);
      }
    } catch (err) {
      console.warn('[composer] could not load tags:', err);
    }
  }

  // Initial render
  updateTagUI();

  // Focus textarea
  document.getElementById('content-textarea').focus();
}

init();
