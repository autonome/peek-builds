/**
 * Peek Browser Extension - Command Bar Popup
 *
 * Simple command bar for quick actions:
 * - tag: Add tags to the current page
 * - note: Save a text note about the page
 * - search: Search saved items
 */

// Available commands
const COMMANDS = {
  tag: {
    name: 'tag',
    title: 'Tag this page',
    description: 'Add tags to the current page',
    icon: '#',
    action: 'input',
    inputLabel: 'Enter tags (comma-separated)',
    inputPlaceholder: 'work, reference, read-later'
  },
  note: {
    name: 'note',
    title: 'Save a note',
    description: 'Write a note about this page',
    icon: '📝',
    action: 'input',
    inputLabel: 'Enter your note',
    inputPlaceholder: 'Add a note about this page...'
  },
  search: {
    name: 'search',
    title: 'Search items',
    description: 'Search your saved items',
    icon: '🔍',
    action: 'search'
  }
};

// State
let state = {
  typed: '',
  matches: [],
  selectedIndex: 0,
  currentCommand: null,
  currentTab: null
};

// DOM elements
const commandInput = document.getElementById('command-input');
const commandHint = document.getElementById('command-hint');
const resultsEl = document.getElementById('results');
const inputArea = document.getElementById('input-area');
const inputLabel = document.getElementById('input-label');
const inputText = document.getElementById('input-text');
const inputCancel = document.getElementById('input-cancel');
const inputSubmit = document.getElementById('input-submit');
const statusEl = document.getElementById('status');

// Initialize
async function init() {
  // Get current tab info
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    state.currentTab = tab;
  } catch (err) {
    console.error('Failed to get current tab:', err);
  }

  // Set up event listeners
  commandInput.addEventListener('input', onInput);
  commandInput.addEventListener('keydown', onKeyDown);
  inputCancel.addEventListener('click', cancelInput);
  inputSubmit.addEventListener('click', submitInput);
  inputText.addEventListener('keydown', onInputTextKeyDown);

  // Focus the command input
  commandInput.focus();

  // Show all commands initially
  updateMatches('');
  renderResults();
}

// Handle input changes
function onInput(e) {
  state.typed = e.target.value;
  state.selectedIndex = 0;
  updateMatches(state.typed);
  renderResults();
  updateHint();
}

// Handle keyboard navigation
function onKeyDown(e) {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (state.selectedIndex < state.matches.length - 1) {
      state.selectedIndex++;
      renderResults();
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (state.selectedIndex > 0) {
      state.selectedIndex--;
      renderResults();
    }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    executeSelected();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    window.close();
  } else if (e.key === 'Tab') {
    e.preventDefault();
    // Autocomplete the selected command
    if (state.matches.length > 0) {
      const selected = state.matches[state.selectedIndex];
      commandInput.value = selected.name + ' ';
      state.typed = commandInput.value;
      updateMatches(state.typed);
      renderResults();
    }
  }
}

// Handle Enter in input text area
function onInputTextKeyDown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    cancelInput();
  } else if (e.key === 'Enter' && e.metaKey) {
    e.preventDefault();
    submitInput();
  }
}

// Find matching commands
function updateMatches(text) {
  const query = text.trim().toLowerCase();

  if (!query) {
    // Show all commands
    state.matches = Object.values(COMMANDS);
    return;
  }

  // Check if text starts with a command name (for search queries)
  const parts = query.split(' ');
  const cmdName = parts[0];

  if (COMMANDS[cmdName] && parts.length > 1) {
    // User typed a full command plus query
    state.matches = [COMMANDS[cmdName]];
    return;
  }

  // Filter commands by prefix/substring match
  state.matches = Object.values(COMMANDS).filter(cmd => {
    return cmd.name.includes(query) ||
           cmd.title.toLowerCase().includes(query);
  });
}

// Update hint text
function updateHint() {
  if (state.matches.length > 0 && state.typed) {
    const match = state.matches[state.selectedIndex];
    if (match.name.startsWith(state.typed.toLowerCase())) {
      commandHint.textContent = match.name;
    } else {
      commandHint.textContent = '';
    }
  } else {
    commandHint.textContent = '';
  }
}

// Render results list
function renderResults() {
  resultsEl.innerHTML = '';

  state.matches.forEach((cmd, index) => {
    const item = document.createElement('div');
    item.className = 'result-item' + (index === state.selectedIndex ? ' selected' : '');
    item.innerHTML = `
      <div class="result-icon">${cmd.icon}</div>
      <div class="result-text">
        <div class="result-title">${cmd.title}</div>
        <div class="result-description">${cmd.description}</div>
      </div>
    `;
    item.addEventListener('click', () => {
      state.selectedIndex = index;
      executeSelected();
    });
    resultsEl.appendChild(item);
  });
}

// Execute the selected command
function executeSelected() {
  if (state.matches.length === 0) return;

  const cmd = state.matches[state.selectedIndex];
  state.currentCommand = cmd;

  if (cmd.action === 'input') {
    showInputArea(cmd);
  } else if (cmd.action === 'search') {
    performSearch();
  }
}

// Show input area for tag/note entry
function showInputArea(cmd) {
  inputLabel.textContent = cmd.inputLabel;
  inputText.placeholder = cmd.inputPlaceholder;
  inputText.value = '';
  inputArea.hidden = false;
  resultsEl.innerHTML = '';
  commandInput.disabled = true;
  inputText.focus();
}

// Cancel input and go back
function cancelInput() {
  inputArea.hidden = true;
  commandInput.disabled = false;
  commandInput.value = '';
  state.typed = '';
  state.currentCommand = null;
  updateMatches('');
  renderResults();
  commandInput.focus();
}

// Submit the input
async function submitInput() {
  const value = inputText.value.trim();
  if (!value) {
    showStatus('Please enter a value', 'error');
    return;
  }

  const cmd = state.currentCommand;

  if (cmd.name === 'tag') {
    await saveTag(value);
  } else if (cmd.name === 'note') {
    await saveNote(value);
  }
}

// Save tags for current page
async function saveTag(tagString) {
  const tags = tagString.split(',').map(t => t.trim()).filter(t => t);

  if (tags.length === 0) {
    showStatus('Please enter at least one tag', 'error');
    return;
  }

  try {
    // Send message to background script
    const response = await chrome.runtime.sendMessage({
      type: 'save-tags',
      data: {
        url: state.currentTab?.url,
        title: state.currentTab?.title,
        tags: tags
      }
    });

    if (response?.success) {
      showStatus(`Tagged with: ${tags.join(', ')}`, 'success');
      setTimeout(() => window.close(), 1000);
    } else {
      showStatus(response?.error || 'Failed to save tags', 'error');
    }
  } catch (err) {
    console.error('Failed to save tags:', err);
    showStatus('Failed to save tags', 'error');
  }
}

// Save note for current page
async function saveNote(noteText) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'save-note',
      data: {
        url: state.currentTab?.url,
        title: state.currentTab?.title,
        note: noteText
      }
    });

    if (response?.success) {
      showStatus('Note saved', 'success');
      setTimeout(() => window.close(), 1000);
    } else {
      showStatus(response?.error || 'Failed to save note', 'error');
    }
  } catch (err) {
    console.error('Failed to save note:', err);
    showStatus('Failed to save note', 'error');
  }
}

// Perform search
async function performSearch() {
  const query = state.typed.replace(/^search\s*/i, '').trim();

  if (!query) {
    // Show search input
    showInputArea({
      inputLabel: 'Search your items',
      inputPlaceholder: 'Enter search query...',
      name: 'search-query'
    });
    state.currentCommand = { name: 'search-query' };
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'search-items',
      data: { query }
    });

    if (response?.success && response.data?.length > 0) {
      renderSearchResults(response.data);
    } else if (response?.success) {
      showStatus('No results found', '');
    } else {
      showStatus(response?.error || 'Search failed', 'error');
    }
  } catch (err) {
    console.error('Search failed:', err);
    showStatus('Search failed', 'error');
  }
}

// Render search results
function renderSearchResults(items) {
  resultsEl.innerHTML = '';

  items.forEach(item => {
    const el = document.createElement('div');
    el.className = 'result-item';
    el.innerHTML = `
      <div class="result-icon">${item.type === 'note' ? '📝' : '🔗'}</div>
      <div class="result-text">
        <div class="result-title">${escapeHtml(item.title || item.url)}</div>
        <div class="result-description">${escapeHtml(item.snippet || item.url || '')}</div>
      </div>
    `;
    el.addEventListener('click', () => {
      if (item.url) {
        chrome.tabs.create({ url: item.url });
        window.close();
      }
    });
    resultsEl.appendChild(el);
  });
}

// Show status message
function showStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = 'status' + (type ? ' ' + type : '');

  if (type === 'success') {
    inputArea.hidden = true;
  }
}

// Escape HTML to prevent XSS
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Handle search-query submit differently
const originalSubmitInput = submitInput;
submitInput = async function() {
  if (state.currentCommand?.name === 'search-query') {
    const query = inputText.value.trim();
    if (query) {
      commandInput.value = 'search ' + query;
      state.typed = commandInput.value;
      inputArea.hidden = true;
      await performSearch();
    }
    return;
  }
  await originalSubmitInput();
};

// Initialize when DOM is ready
init();
