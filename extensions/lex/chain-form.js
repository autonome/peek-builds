/**
 * Chain Form — compact lexicon record form popup for cmd palette chaining.
 *
 * Opened by the cmd panel's openChainPopup() as a modal child window.
 * Receives content (nsid) via pubsub, resolves the lexicon schema,
 * generates a dynamic form, and creates the record directly via atproto.js.
 *
 * Protocol:
 *   1. Reads sessionId, mimeType, title from URL params
 *   2. Subscribes to 'chain-popup:content' to receive { nsid } (matched by sessionId)
 *   3. Resolves the lexicon schema and generates the form
 *   4. On submit, calls xrpcPost directly (no background needed)
 *   5. On success, publishes 'chain-popup:result' to signal completion
 *   6. On Escape, closes without creating
 */

import {
  resolveLexicon,
  getRecordSchema,
  generateForm,
  collectFormData,
  createRawJsonEditor,
  parseRawJson,
  nsidToFriendlyName,
} from './lexicon-ui.js';

import {
  xrpcPost,
} from './atproto.js';

const api = window.app;

// Read URL params
const params = new URLSearchParams(window.location.search);
const sessionId = params.get('sessionId');
const mimeType = params.get('mimeType') || 'application/x-lexicon-form';
const title = params.get('title') || 'New Record';

// Session state — loaded from extension storage
let currentSession = null;

const STORAGE_KEY = 'session';

async function loadSession() {
  if (!api) return;
  try {
    const result = await api.settings.getKey(STORAGE_KEY);
    if (result.success && result.data) {
      currentSession = result.data;
      console.log('[chain-form] Restored session for', currentSession.handle);
    }
  } catch (err) {
    console.warn('[chain-form] Failed to load session:', err);
  }
}

async function saveSession() {
  if (!api || !currentSession) return;
  try {
    await api.settings.setKey(STORAGE_KEY, currentSession);
  } catch (err) {
    console.warn('[chain-form] Failed to save session:', err);
  }
}

function onSessionRefresh(refreshedSession) {
  currentSession = refreshedSession;
  saveSession();
}

// State
let currentNsid = null;
let currentLexicon = null;
let currentSchema = null;
let currentForm = null;
let resultPublished = false;
let submitting = false;

// DOM elements
const headerTitle = document.getElementById('header-title');
const headerNsid = document.getElementById('header-nsid');
const formContainer = document.getElementById('form-container');
const loadingEl = document.getElementById('loading');
const statusEl = document.getElementById('status');
const btnSubmit = document.getElementById('btn-submit');
const btnCancel = document.getElementById('btn-cancel');

/**
 * Show a status message
 */
function showStatus(message, type) {
  statusEl.className = type; // 'error' or 'success'
  statusEl.innerHTML = message;
  statusEl.style.display = 'block';
}

/**
 * Hide the status message
 */
function hideStatus() {
  statusEl.style.display = 'none';
  statusEl.className = '';
  statusEl.innerHTML = '';
}

/**
 * Publish result back to the cmd panel and close
 */
function publishResult(data) {
  if (resultPublished) return;
  resultPublished = true;

  console.log('[chain-form] Publishing result, sessionId:', sessionId);

  api.publish('chain-popup:result', {
    sessionId,
    data: data || null,
    mimeType: 'application/json',
    done: true,
  }, api.scopes.GLOBAL);
}

/**
 * Load the lexicon schema and render the form
 */
async function loadForm(nsid) {
  currentNsid = nsid;
  const friendlyName = nsidToFriendlyName(nsid);

  // Update header
  headerTitle.textContent = `New ${friendlyName}`;
  headerNsid.textContent = nsid;

  loadingEl.style.display = 'block';
  hideStatus();

  try {
    // Resolve the lexicon schema
    currentLexicon = await resolveLexicon(nsid);

    if (!currentLexicon) {
      // No schema found — show raw JSON editor
      loadingEl.style.display = 'none';
      const rawEditor = createRawJsonEditor(nsid);
      formContainer.appendChild(rawEditor);
      currentForm = rawEditor;
      btnSubmit.disabled = false;
      return;
    }

    currentSchema = getRecordSchema(currentLexicon);

    if (!currentSchema) {
      // Schema exists but no record definition
      loadingEl.style.display = 'none';
      const rawEditor = createRawJsonEditor(nsid);
      formContainer.appendChild(rawEditor);
      currentForm = rawEditor;
      btnSubmit.disabled = false;
      return;
    }

    // Generate the dynamic form
    currentForm = await generateForm(nsid, currentSchema, currentLexicon, {
      autoFillCreatedAt: true,
    });

    loadingEl.style.display = 'none';
    formContainer.appendChild(currentForm);
    btnSubmit.disabled = false;

    // Focus the first visible input
    setTimeout(() => {
      const firstInput = currentForm.querySelector('input:not([type="hidden"]), textarea, select');
      if (firstInput) firstInput.focus();
    }, 100);

  } catch (err) {
    loadingEl.style.display = 'none';
    showStatus(`Failed to load schema: ${err.message}`, 'error');
    console.error('[chain-form] Schema load error:', err);
  }
}

/**
 * Handle form submission — calls xrpcPost directly.
 */
async function handleSubmit() {
  if (submitting || !currentNsid) return;

  if (!currentSession) {
    showStatus('Error: Not logged in. Open Lexicon Studio to connect your account.', 'error');
    return;
  }

  submitting = true;
  btnSubmit.disabled = true;
  btnSubmit.textContent = 'Creating...';
  hideStatus();

  try {
    let record;

    if (currentForm && currentSchema) {
      // Dynamic form — collect structured data
      record = await collectFormData(currentForm, currentSchema, currentLexicon, currentNsid);
    } else if (currentForm) {
      // Raw JSON editor fallback
      record = parseRawJson(currentForm, currentNsid);
    } else {
      throw new Error('No form data to submit');
    }

    console.log('[chain-form] Creating record:', currentNsid, record);

    // Create record directly via atproto
    const result = await xrpcPost(currentSession, 'com.atproto.repo.createRecord', {
      repo: currentSession.did,
      collection: currentNsid,
      record,
    }, onSessionRefresh);

    await saveSession();

    // Show success
    let successMsg = 'Record created successfully!';
    if (result.uri) {
      successMsg += `<div class="record-uri">${result.uri}</div>`;
    }
    showStatus(successMsg, 'success');
    btnSubmit.textContent = 'Created!';

    console.log('[chain-form] Record created:', result.uri);

    // Notify home UI to update recent lexicons
    api.publish('lex:recent-lexicons-changed', { nsids: [currentNsid] }, api.scopes.GLOBAL);

    // Publish result to cmd panel and auto-close after delay
    setTimeout(() => {
      publishResult({
        collection: currentNsid,
        uri: result.uri,
        cid: result.cid,
      });
      window.close();
    }, 1500);

  } catch (err) {
    showStatus(`Error: ${err.message}`, 'error');
    btnSubmit.textContent = 'Create';
    btnSubmit.disabled = false;
    submitting = false;
    console.error('[chain-form] Submit error:', err);
  }
}

// ============================================================================
// Event handlers
// ============================================================================

// Submit button
btnSubmit.addEventListener('click', handleSubmit);

// Cancel button
btnCancel.addEventListener('click', () => {
  publishResult(null);
  window.close();
});

// Escape handler
api.escape.onEscape(() => {
  publishResult(null);
  return { handled: false }; // Let the window close
});

// Safety net: publish result on unload
window.addEventListener('beforeunload', () => {
  publishResult(null);
});

// Ctrl/Cmd+Enter to submit
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    handleSubmit();
  }
});

// ============================================================================
// Initialize
// ============================================================================

async function init() {
  if (!sessionId) {
    console.error('[chain-form] No sessionId in URL params');
    showStatus('Missing session ID', 'error');
    return;
  }

  // Load session from storage first
  await loadSession();

  if (!currentSession) {
    showStatus('Not logged in. Open Lexicon Studio to connect your account.', 'error');
    return;
  }

  console.log('[chain-form] Waiting for content, sessionId:', sessionId);

  let received = false;

  // Subscribe for content from the cmd panel
  api.subscribe('chain-popup:content', (msg) => {
    if (msg.sessionId !== sessionId) return;
    if (received) return;
    received = true;

    console.log('[chain-form] Received content:', msg.data);

    const nsid = msg.data?.nsid;
    if (!nsid) {
      loadingEl.style.display = 'none';
      showStatus('No lexicon NSID provided', 'error');
      return;
    }

    loadForm(nsid);
  }, api.scopes.GLOBAL);
}

init();
