/**
 * Chain Editor - popup editor for chain mode text editing
 *
 * Opened by the cmd panel's openChainPopup() as a modal child window.
 * Receives content via pubsub, returns edited content via pubsub.
 *
 * Protocol:
 *   1. Reads sessionId, mimeType, title from URL params
 *   2. Subscribes to 'chain-popup:content' to receive actual content (matched by sessionId)
 *   3. Creates a CodeMirror editor filling the window
 *   4. On close (Escape in vim normal mode, or :q), publishes 'chain-popup:result'
 */

import * as CodeMirror from 'peek://extensions/editor/codemirror.js';
import { StatusLine } from 'peek://extensions/editor/status-line.js';
const { getCM, Vim } = CodeMirror;

const api = window.app;

// Read URL params
const params = new URLSearchParams(window.location.search);
const sessionId = params.get('sessionId');
const mimeType = params.get('mimeType') || 'text/plain';
const title = params.get('title') || 'Edit';

// Editor state
let editor = null;
let statusLine = null;
let vimMode = false;
let resultPublished = false;

/**
 * Load vim mode preference from editor extension settings
 */
async function loadVimPreference() {
  try {
    if (api?.settings?.getExtKey) {
      const result = await api.settings.getExtKey('editor', 'prefs');
      if (result.success && result.data && typeof result.data === 'object') {
        vimMode = !!result.data.vimMode;
        console.log('[chain-editor] vimMode:', vimMode);
      }
    }
  } catch (err) {
    console.log('[chain-editor] Failed to load vim pref:', err);
  }
}

/**
 * Publish the result back to the cmd panel and close
 */
function publishResult() {
  if (resultPublished) return;
  resultPublished = true;

  const data = editor ? CodeMirror.getContent(editor) : '';
  console.log('[chain-editor] Publishing result, sessionId:', sessionId, 'length:', data.length);

  api.publish('chain-popup:result', {
    sessionId,
    data,
    mimeType
  }, api.scopes.GLOBAL);
}

/**
 * Create the CodeMirror editor with the given content
 */
async function createEditor(content) {
  const container = document.getElementById('editor-container');
  const statusLineEl = document.getElementById('status-line');

  // Load vim preference
  await loadVimPreference();

  // Create status line
  if (statusLineEl) {
    statusLine = new StatusLine({ container: statusLineEl });
    if (vimMode) {
      statusLine.show();
      statusLine.updateMode('normal');
    } else {
      statusLine.hide();
      statusLineEl.style.display = 'none';
    }
  }

  editor = CodeMirror.createEditor({
    parent: container,
    content: content || '',
    vimMode: vimMode,
    showLineNumbers: true,
    onSelectionChange: (line, col) => {
      if (statusLine && vimMode) {
        statusLine.updatePosition(line, col);
      }
    },
    onVimModeChange: (mode) => {
      if (statusLine && vimMode) {
        statusLine.updateMode(mode);
      }
    }
  });

  // Register vim :q ex command to publish result and close
  if (vimMode) {
    try {
      Vim.defineEx('q', 'q', () => {
        publishResult();
        // Let the window close via escape handler returning { handled: false }
        // or close directly
        window.close();
      });
      Vim.defineEx('wq', 'wq', () => {
        publishResult();
        window.close();
      });
    } catch (e) {
      console.log('[chain-editor] Failed to define vim ex commands:', e);
    }
  }

  // Focus the editor
  setTimeout(() => {
    if (editor) CodeMirror.focus(editor);
  }, 100);
}

/**
 * Register escape handler for the IZUI escape flow
 */
api.escape.onEscape(() => {
  if (editor && vimMode) {
    try {
      const cm = getCM(editor);
      if (cm && cm.state && cm.state.vim) {
        const vimState = cm.state.vim;
        if (vimState.insertMode || vimState.visualMode) {
          // In insert/visual mode: send Esc to vim, stay in editor
          console.log('[chain-editor] vim insert/visual -> normal');
          Vim.handleKey(cm, '<Esc>');
          return { handled: true };
        }
        // In normal mode: publish result and let window close
        console.log('[chain-editor] vim normal -> publish and close');
        publishResult();
        return { handled: false };
      }
    } catch (e) {
      console.log('[chain-editor] vim escape error:', e);
    }
  }

  // Non-vim mode: publish result and let window close
  publishResult();
  return { handled: false };
});

/**
 * Safety net: publish result if window is closing and we haven't published yet
 */
window.addEventListener('beforeunload', () => {
  publishResult();
});

/**
 * Initialize: subscribe for content, signal readiness, then wait for content.
 * Uses a retry loop because pubsub subscription registration is async —
 * the ready signal might arrive at the panel before our subscribe is processed.
 */
function init() {
  if (!sessionId) {
    console.error('[chain-editor] No sessionId in URL params');
    return;
  }

  console.log('[chain-editor] Waiting for content, sessionId:', sessionId);

  let received = false;

  // Subscribe for content from the cmd panel
  api.subscribe('chain-popup:content', (msg) => {
    if (msg.sessionId !== sessionId) return;
    if (received) return;
    received = true;

    console.log('[chain-editor] Received content, length:', (msg.data || '').length);
    createEditor(msg.data || '');
  }, api.scopes.GLOBAL);
}

init();
