/**
 * Scripts Manager UI
 *
 * Three-panel layout:
 * - Left: Scripts list
 * - Center: Editor
 * - Right: Preview/Test
 */

import { scriptExecutor } from './script-executor.js';

const api = window.app;

// ===== BroadcastChannel for intra-extension messaging =====

const scriptsChannel = new BroadcastChannel('scripts');
const scriptsChannelHandlers = {};

scriptsChannel.onmessage = (e) => {
  const { topic, data } = e.data;
  if (scriptsChannelHandlers[topic]) {
    for (const handler of scriptsChannelHandlers[topic]) {
      handler(data);
    }
  }
};

function onChannel(topic, handler) {
  if (!scriptsChannelHandlers[topic]) scriptsChannelHandlers[topic] = [];
  scriptsChannelHandlers[topic].push(handler);
}

function emitChannel(topic, data) {
  scriptsChannel.postMessage({ topic, data });
}

// UI Elements
let scriptsList;
let editorForm;
let scriptName;
let scriptDescription;
let matchPattern;
let runAt;
let codeEditor;
let testUrl;
let previewContent;
let saveBtn;
let revertBtn;
let deleteBtn;
let testBtn;
let newScriptBtn;

// State
let scripts = [];
let currentScript = null;
let originalScript = null; // For revert

/**
 * Initialize UI
 */
async function init() {
  console.log('[scripts-manager] Initializing...');

  // Get DOM elements
  scriptsList = document.getElementById('scriptsList');
  editorForm = document.getElementById('editorForm');
  scriptName = document.getElementById('scriptName');
  scriptDescription = document.getElementById('scriptDescription');
  matchPattern = document.getElementById('matchPattern');
  runAt = document.getElementById('runAt');
  codeEditor = document.getElementById('codeEditor');
  testUrl = document.getElementById('testUrl');
  previewContent = document.getElementById('previewContent');
  saveBtn = document.getElementById('saveBtn');
  revertBtn = document.getElementById('revertBtn');
  deleteBtn = document.getElementById('deleteBtn');
  testBtn = document.getElementById('testBtn');
  newScriptBtn = document.getElementById('newScriptBtn');

  // Attach event listeners
  newScriptBtn.addEventListener('click', handleNewScript);
  saveBtn.addEventListener('click', handleSave);
  revertBtn.addEventListener('click', handleRevert);
  deleteBtn.addEventListener('click', handleDelete);
  testBtn.addEventListener('click', handleTest);

  // Load scripts from backend
  await loadScripts();

  // Subscribe to updates via BroadcastChannel
  onChannel('scripts:created', () => loadScripts());
  onChannel('scripts:updated', () => loadScripts());
  onChannel('scripts:deleted', () => loadScripts());

  // Check URL params for scriptId
  const params = new URLSearchParams(window.location.search);
  const scriptId = params.get('scriptId');
  if (scriptId) {
    const script = scripts.find(s => s.id === scriptId);
    if (script) {
      selectScript(script);
    }
  }

  console.log('[scripts-manager] Initialized with', scripts.length, 'scripts');
}

/**
 * Load all scripts from backend
 */
async function loadScripts() {
  return new Promise((resolve) => {
    onChannel('scripts:get-all:response', (msg) => {
      if (msg.success) {
        scripts = msg.data || [];
        renderScriptsList();
        resolve();
      }
    });

    emitChannel('scripts:get-all', {});
  });
}

/**
 * Render scripts list in left panel
 */
function renderScriptsList() {
  if (scripts.length === 0) {
    scriptsList.innerHTML = '<div class="empty-state">No scripts yet. Click "+ New Script" to create one.</div>';
    return;
  }

  scriptsList.innerHTML = scripts.map(script => {
    const status = script.lastExecutedAt
      ? (script.enabled ? 'success' : 'disabled')
      : 'never';

    const lastRun = script.lastExecutedAt
      ? formatTime(script.lastExecutedAt)
      : 'Never run';

    const isActive = currentScript && currentScript.id === script.id;

    return `
      <div class="script-item ${isActive ? 'active' : ''}" data-script-id="${script.id}">
        <div class="script-item-header">
          <input type="checkbox" class="script-checkbox" ${script.enabled ? 'checked' : ''} data-script-id="${script.id}">
          <span class="script-name">${escapeHtml(script.name)}</span>
          <span class="script-status ${status}"></span>
        </div>
        <div class="script-meta">${lastRun}</div>
      </div>
    `;
  }).join('');

  // Attach click handlers
  scriptsList.querySelectorAll('.script-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('script-checkbox')) {
        return; // Handle checkbox separately
      }
      const scriptId = item.dataset.scriptId;
      const script = scripts.find(s => s.id === scriptId);
      if (script) {
        selectScript(script);
      }
    });
  });

  // Attach checkbox handlers
  scriptsList.querySelectorAll('.script-checkbox').forEach(checkbox => {
    checkbox.addEventListener('change', async (e) => {
      e.stopPropagation();
      const scriptId = checkbox.dataset.scriptId;
      const enabled = checkbox.checked;

      await updateScriptField(scriptId, { enabled });
    });
  });
}

/**
 * Select a script to edit
 */
function selectScript(script) {
  currentScript = script;
  originalScript = JSON.parse(JSON.stringify(script)); // Deep clone for revert

  // Populate form
  scriptName.value = script.name;
  scriptDescription.value = script.description || '';
  matchPattern.value = script.matchPatterns[0] || '';
  runAt.value = script.runAt;
  codeEditor.value = script.code;

  // Enable actions
  deleteBtn.disabled = false;

  // Re-render to show active state
  renderScriptsList();
}

/**
 * Handle new script creation
 */
async function handleNewScript() {
  return new Promise((resolve) => {
    onChannel('scripts:create:response', async (msg) => {
      if (msg.success) {
        await loadScripts();
        selectScript(msg.data);
        resolve();
      }
    });

    emitChannel('scripts:create', {
      name: 'New Script',
      code: '// Your script here\nconst h1 = document.querySelector(\'h1\');\nreturn { title: h1?.textContent || \'No h1 found\' };'
    });
  });
}

/**
 * Handle save
 */
async function handleSave() {
  if (!currentScript) return;

  const updates = {
    name: scriptName.value,
    description: scriptDescription.value,
    matchPatterns: [matchPattern.value],
    runAt: runAt.value,
    code: codeEditor.value
  };

  await updateScriptField(currentScript.id, updates);
}

/**
 * Handle revert
 */
function handleRevert() {
  if (!originalScript) return;
  selectScript(originalScript);
}

/**
 * Handle delete
 */
async function handleDelete() {
  if (!currentScript) return;

  if (!confirm(`Delete script "${currentScript.name}"?`)) {
    return;
  }

  return new Promise((resolve) => {
    onChannel('scripts:delete:response', async (msg) => {
      if (msg.success) {
        currentScript = null;
        originalScript = null;
        await loadScripts();

        // Clear form
        scriptName.value = '';
        scriptDescription.value = '';
        matchPattern.value = '';
        codeEditor.value = '';
        deleteBtn.disabled = true;

        resolve();
      }
    });

    emitChannel('scripts:delete', {
      scriptId: currentScript.id
    });
  });
}

/**
 * Handle test execution
 */
async function handleTest() {
  if (!currentScript) {
    showPreviewError('No script selected');
    return;
  }

  const url = testUrl.value.trim();
  if (!url) {
    showPreviewError('Please enter a test URL');
    return;
  }

  testBtn.disabled = true;
  testBtn.loading = true;

  try {
    // Use current form values (not saved script)
    const testScript = {
      ...currentScript,
      name: scriptName.value,
      code: codeEditor.value,
      matchPatterns: [matchPattern.value],
      runAt: runAt.value
    };

    const result = await scriptExecutor.executeScript(testScript, {
      url: url,
      pageDOM: document,
      pageWindow: window
    });

    showPreviewResult(result);
  } catch (error) {
    showPreviewError(error.message);
  } finally {
    testBtn.disabled = false;
    testBtn.loading = false;
  }
}

/**
 * Update script field
 */
async function updateScriptField(scriptId, updates) {
  return new Promise((resolve) => {
    onChannel('scripts:update:response', async (msg) => {
      if (msg.success) {
        await loadScripts();
        if (currentScript && currentScript.id === scriptId) {
          const updatedScript = scripts.find(s => s.id === scriptId);
          if (updatedScript) {
            currentScript = updatedScript;
            originalScript = JSON.parse(JSON.stringify(updatedScript));
          }
        }
        resolve();
      }
    });

    emitChannel('scripts:update', {
      scriptId,
      updates
    });
  });
}

/**
 * Show preview result
 */
function showPreviewResult(result) {
  let html = '';

  if (result.status === 'success') {
    html = `
      <div class="result-box">
        <div class="result-status success">Success</div>
        <div class="result-time">Execution time: ${result.executionTime}ms</div>
        ${result.result !== undefined ? `
          <div>
            <div class="result-label">Result:</div>
            <div class="result-data">${JSON.stringify(result.result, null, 2)}</div>
          </div>
        ` : ''}
        ${result.output && result.output.length > 0 ? `
          <div class="console-output">
            <h3>Console Output:</h3>
            ${result.output.map(log => `
              <div class="console-line ${log.level}">${escapeHtml(log.message)}</div>
            `).join('')}
          </div>
        ` : ''}
      </div>
    `;
  } else if (result.status === 'error') {
    html = `
      <div class="result-box">
        <div class="result-status error">Error</div>
        <div class="result-data">${escapeHtml(result.error)}</div>
        ${result.stack ? `
          <div class="result-stack">
            <strong>Stack:</strong>
            <pre>${escapeHtml(result.stack)}</pre>
          </div>
        ` : ''}
      </div>
    `;
  } else if (result.status === 'skipped') {
    html = `
      <div class="result-box">
        <div class="result-status skipped">Skipped</div>
        <div class="result-reason">${escapeHtml(result.reason)}</div>
      </div>
    `;
  }

  previewContent.innerHTML = html;
}

/**
 * Show preview error
 */
function showPreviewError(message) {
  previewContent.innerHTML = `
    <div class="result-box">
      <div class="result-status error">Error</div>
      <div class="result-data">${escapeHtml(message)}</div>
    </div>
  `;
}

/**
 * Format timestamp
 */
function formatTime(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  if (seconds > 0) return `${seconds}s ago`;
  return 'Just now';
}

/**
 * Escape HTML
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Initialize on load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
