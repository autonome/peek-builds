/**
 * Peek Browser Extension - Command Bar Popup
 * Simple command bar: tag, note, search
 * Shows success/error feedback before closing
 */

const COMMANDS = ['tag', 'note', 'search'];

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
    commandText.textContent = 'tag, note, or search...';
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

init();
