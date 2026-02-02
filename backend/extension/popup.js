/**
 * Peek Browser Extension - Command Bar Popup
 * Simple command bar: tag, note, search
 * UI closes immediately - backend saves async
 */

const COMMANDS = ['tag', 'note', 'search'];

let state = {
  typed: '',
  match: null,
  currentTab: null
};

const commandInput = document.getElementById('command-input');
const commandText = document.getElementById('command-text');

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

function executeCommand() {
  const parts = state.typed.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();
  const args = parts.slice(1).join(' ');

  if (cmd === 'tag' && args) {
    saveTag(args);
    window.close();
  } else if (cmd === 'note' && args) {
    saveNote(args);
    window.close();
  } else if (cmd === 'search' && args) {
    performSearch(args);
  } else if (state.match && !args) {
    commandInput.value = state.match + ' ';
    state.typed = commandInput.value;
    updateDisplay();
  }
}

function saveTag(tagString) {
  const tags = tagString.split(',').map(t => t.trim()).filter(t => t);
  if (tags.length === 0) return;

  chrome.runtime.sendMessage({
    type: 'save-tags',
    data: {
      url: state.currentTab?.url,
      title: state.currentTab?.title,
      tags: tags
    }
  }).catch(err => console.error('Failed to save tags:', err));
}

function saveNote(noteText) {
  chrome.runtime.sendMessage({
    type: 'save-note',
    data: {
      url: state.currentTab?.url,
      title: state.currentTab?.title,
      note: noteText
    }
  }).catch(err => console.error('Failed to save note:', err));
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
