/**
 * Peek Browser Extension - Command Bar Popup
 *
 * A minimal command bar for quick actions. Shows success/error feedback
 * before auto-closing. Includes sync status bar at bottom.
 *
 * Commands:
 *   tag <tags>      - Tag current URL with comma-separated tags
 *   note <text>     - Save a text note (attached to current page as metadata)
 *   search <query>  - Search saved items (results logged to console)
 *   server          - Show current sync server URL
 *   server <url>    - Set sync server URL (auto-adds https://)
 *   key             - Show masked API key (last 4 chars visible)
 *   key <apikey>    - Set API key for sync
 *   sync            - Trigger sync, shows pull/push counts (e.g., "↓3 ↑2")
 *
 * UI:
 *   - Command input with tab-completion for command names
 *   - Feedback area replaces input on success/error
 *   - Status bar shows sync state, pending count, manual sync button
 *   - Escape closes popup, Enter executes command
 */

const COMMANDS = ['tag', 'note', 'search', 'server', 'key', 'sync'];

let state = {
  typed: '',
  match: null,
  currentTab: null
};

const commandInput = document.getElementById('command-input');
const commandText = document.getElementById('command-text');
const commandDisplay = document.getElementById('command-display');
const feedbackEl = document.getElementById('feedback');
const feedbackIcon = document.getElementById('feedback-icon');
const feedbackText = document.getElementById('feedback-text');
const syncStatusEl = document.getElementById('sync-status');
const syncTextEl = document.getElementById('sync-text');
const pendingBadge = document.getElementById('pending-badge');
const syncBtn = document.getElementById('sync-btn');

async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    state.currentTab = tab;
  } catch (err) {
    console.error('Failed to get current tab:', err);
  }

  commandInput.addEventListener('input', onInput);
  commandInput.addEventListener('keydown', onKeyDown);
  commandInput.focus();

  // Load sync status
  loadSyncStatus();

  // Sync button handler
  syncBtn.addEventListener('click', triggerSync);
}

function onInput(e) {
  state.typed = e.target.value;
  state.match = findMatch(state.typed);
  updateDisplay();
}

function onKeyDown(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    executeCommand();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    window.close();
  } else if (e.key === 'Tab' && state.match) {
    e.preventDefault();
    commandInput.value = state.match + ' ';
    state.typed = commandInput.value;
    updateDisplay();
  }
}

function findMatch(text) {
  if (!text) return null;
  const lower = text.toLowerCase().split(' ')[0];
  return COMMANDS.find(cmd => cmd.startsWith(lower)) || null;
}

function updateDisplay() {
  commandText.innerHTML = '';
  commandText.classList.remove('placeholder');

  if (!state.typed) {
    commandText.classList.add('placeholder');
    commandText.textContent = 'tag, note, server, key, sync...';
    return;
  }

  const typedSpan = document.createElement('span');
  typedSpan.className = 'typed';
  typedSpan.textContent = state.typed;
  commandText.appendChild(typedSpan);

  if (state.match && state.match.startsWith(state.typed.toLowerCase().split(' ')[0])) {
    const cmdPart = state.typed.split(' ')[0];
    if (state.match.length > cmdPart.length && !state.typed.includes(' ')) {
      const restSpan = document.createElement('span');
      restSpan.textContent = state.match.substring(cmdPart.length);
      commandText.appendChild(restSpan);
    }
  }
}

function showFeedback(type, message) {
  commandDisplay.classList.add('hidden');
  feedbackEl.classList.remove('success', 'error');
  feedbackEl.classList.add('visible', type);
  feedbackIcon.textContent = type === 'success' ? '✓' : '✗';
  feedbackText.textContent = message;
}

function executeCommand() {
  const parts = state.typed.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();
  const args = parts.slice(1).join(' ');

  if (cmd === 'tag' && args) {
    saveTag(args);
  } else if (cmd === 'note' && args) {
    saveNote(args);
  } else if (cmd === 'search' && args) {
    performSearch(args);
  } else if (cmd === 'server') {
    if (args) {
      setServer(args);
    } else {
      showServer();
    }
  } else if (cmd === 'key') {
    if (args) {
      setApiKey(args);
    } else {
      showApiKey();
    }
  } else if (cmd === 'sync') {
    runSync();
  } else if (state.match && !args) {
    commandInput.value = state.match + ' ';
    state.typed = commandInput.value;
    updateDisplay();
  }
}

async function saveTag(tagString) {
  const tags = tagString.split(',').map(t => t.trim()).filter(t => t);
  if (tags.length === 0) return;

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'save-tags',
      data: {
        url: state.currentTab?.url,
        title: state.currentTab?.title,
        tags: tags
      }
    });

    if (response?.success) {
      const tagList = tags.length === 1 ? tags[0] : `${tags.length} tags`;
      showFeedback('success', `Tagged: ${tagList}`);
      setTimeout(() => window.close(), 600);
    } else {
      showFeedback('error', response?.error || 'Failed to save tags');
    }
  } catch (err) {
    console.error('Failed to save tags:', err);
    showFeedback('error', 'Failed to save tags');
  }
}

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
      showFeedback('success', 'Note saved');
      setTimeout(() => window.close(), 600);
    } else {
      showFeedback('error', response?.error || 'Failed to save note');
    }
  } catch (err) {
    console.error('Failed to save note:', err);
    showFeedback('error', 'Failed to save note');
  }
}

function performSearch(query) {
  chrome.runtime.sendMessage({
    type: 'search-items',
    data: { query }
  }).then(response => {
    console.log('Search results:', response);
  }).catch(err => console.error('Search failed:', err));
}

async function setServer(url) {
  // Normalize URL
  let serverUrl = url.trim();
  if (serverUrl && !serverUrl.startsWith('http')) {
    serverUrl = 'https://' + serverUrl;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'set-server',
      data: { serverUrl }
    });

    if (response?.success) {
      showFeedback('success', 'Server set');
      setTimeout(() => {
        loadSyncStatus();
        window.close();
      }, 600);
    } else {
      showFeedback('error', response?.error || 'Failed to set server');
    }
  } catch (err) {
    console.error('Failed to set server:', err);
    showFeedback('error', 'Failed to set server');
  }
}

async function setApiKey(apiKey) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'set-api-key',
      data: { apiKey: apiKey.trim() }
    });

    if (response?.success) {
      showFeedback('success', 'API key set');
      setTimeout(() => {
        loadSyncStatus();
        window.close();
      }, 600);
    } else {
      showFeedback('error', response?.error || 'Failed to set API key');
    }
  } catch (err) {
    console.error('Failed to set API key:', err);
    showFeedback('error', 'Failed to set API key');
  }
}

async function showServer() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'get-sync-config' });
    if (response?.success && response.data?.serverUrl) {
      showFeedback('success', response.data.serverUrl);
    } else {
      showFeedback('error', 'Not set');
    }
  } catch (err) {
    showFeedback('error', 'Failed to get server');
  }
}

async function showApiKey() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'get-sync-config' });
    if (response?.success && response.data?.apiKey) {
      // Mask the key, showing only last 4 chars
      const key = response.data.apiKey;
      const masked = key.length > 4
        ? '•'.repeat(key.length - 4) + key.slice(-4)
        : '•'.repeat(key.length);
      showFeedback('success', masked);
    } else {
      showFeedback('error', 'Not set');
    }
  } catch (err) {
    showFeedback('error', 'Failed to get key');
  }
}

async function runSync() {
  showFeedback('success', 'Syncing...');

  try {
    const response = await chrome.runtime.sendMessage({ type: 'sync-now' });

    if (response?.success) {
      const data = response.data || {};
      const pulled = data.pulled || 0;
      const pushed = data.pushed || 0;
      showFeedback('success', `Synced: ↓${pulled} ↑${pushed}`);
      setTimeout(() => window.close(), 1200);
    } else {
      showFeedback('error', response?.error || 'Sync failed');
    }
  } catch (err) {
    console.error('Sync failed:', err);
    showFeedback('error', 'Sync failed');
  }
}

// ==================== Sync Status ====================

async function loadSyncStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'get-diagnostics' });

    if (!response?.success) {
      updateSyncDisplay('warning', 'Error loading status');
      return;
    }

    const { syncStatus } = response.data;

    if (!syncStatus?.configured) {
      updateSyncDisplay('warning', 'Not configured');
      syncBtn.style.display = 'none';
      return;
    }

    // Show pending count if any
    if (syncStatus.pendingCount > 0) {
      pendingBadge.textContent = syncStatus.pendingCount;
      pendingBadge.style.display = 'inline';
    }

    // Format last sync time
    if (syncStatus.lastSyncTime) {
      const ago = formatTimeAgo(new Date(syncStatus.lastSyncTime));
      updateSyncDisplay('', `Synced ${ago}`);
    } else {
      updateSyncDisplay('warning', 'Never synced');
    }
  } catch (err) {
    console.error('Failed to load sync status:', err);
    updateSyncDisplay('warning', 'Error');
  }
}

function updateSyncDisplay(statusClass, text) {
  syncStatusEl.className = 'sync-status' + (statusClass ? ` ${statusClass}` : '');
  syncTextEl.textContent = text;
}

function formatTimeAgo(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

async function triggerSync() {
  syncBtn.disabled = true;
  updateSyncDisplay('syncing', 'Syncing...');

  try {
    const response = await chrome.runtime.sendMessage({ type: 'sync-now' });

    if (response?.success) {
      pendingBadge.style.display = 'none';
      updateSyncDisplay('', 'Synced just now');
    } else {
      updateSyncDisplay('warning', response?.error || 'Sync failed');
    }
  } catch (err) {
    console.error('Sync failed:', err);
    updateSyncDisplay('warning', 'Sync failed');
  } finally {
    syncBtn.disabled = false;
  }
}

init();
