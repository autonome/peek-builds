/**
 * Raw App Template — app shell, login view, account info, search, nav.
 *
 * Renders the login flow, account display, search results, and nav panel switching.
 * Extracted from home.js as-is.
 *
 * Events emitted:
 *   - 'actor-selected' { actor } — user selected a search result
 *   - 'actor-cleared' — user cleared actor selection
 *   - 'logout' — user clicked disconnect
 *   - 'panel-switch' { panel } — user clicked a nav item
 */

import { escapeHtml } from './utils.js';

export class AppTemplate {
  constructor() {
    this._listeners = {};
  }

  on(event, handler) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(handler);
    return this;
  }

  _emit(event, data) {
    const handlers = this._listeners[event] || [];
    for (const h of handlers) h(data);
  }

  // =========================================================================
  // Login view
  // =========================================================================

  /**
   * Show the login view and hide account view.
   * @param {Object} refs — DOM refs
   */
  showLoginView(refs) {
    const { loginView, accountView, handleInput, selectedAccountEl, loginError, loginLoading } = refs;

    loginView.style.display = '';
    accountView.style.display = 'none';

    // Reset login form
    handleInput.value = '';
    handleInput.style.display = '';
    selectedAccountEl.style.display = 'none';
    loginError.style.display = 'none';
    loginLoading.style.display = 'none';
  }

  /**
   * Show the account view and hide login.
   * @param {Object} refs
   */
  showAccountView(refs) {
    const { loginView, accountView } = refs;
    loginView.style.display = 'none';
    accountView.style.display = '';
  }

  // =========================================================================
  // Search results
  // =========================================================================

  /**
   * Render search results dropdown.
   * @param {HTMLElement} targetEl — search results container
   * @param {Object} params
   * @param {boolean} params.visible
   * @param {Array} params.results
   * @param {number} params.activeIndex
   */
  renderSearchResults(targetEl, { visible, results, activeIndex }) {
    if (!visible || results.length === 0) {
      targetEl.classList.remove('visible');
      targetEl.innerHTML = '';
      return;
    }

    targetEl.classList.add('visible');
    targetEl.innerHTML = results.map((actor, i) => {
      const initial = ((actor.handle || '?')[0]).toUpperCase();
      const avatarHtml = actor.avatar
        ? `<img class="search-result-avatar" src="${escapeHtml(actor.avatar)}" alt="">`
        : `<span class="search-result-placeholder">${initial}</span>`;

      return `
        <div class="search-result-item ${i === activeIndex ? 'active' : ''}" data-index="${i}">
          ${avatarHtml}
          <div class="search-result-info">
            <div class="search-result-name">${escapeHtml(actor.displayName || actor.handle)}</div>
            <div class="search-result-handle">@${escapeHtml(actor.handle)}</div>
          </div>
        </div>
      `;
    }).join('');

    // Click handlers for results
    targetEl.querySelectorAll('.search-result-item').forEach(el => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault(); // Prevent blur
        const idx = parseInt(el.dataset.index, 10);
        this._emit('actor-selected', { actor: results[idx] });
      });
    });
  }

  /**
   * Render the selected account display.
   * @param {HTMLElement} targetEl — selected account container
   * @param {HTMLElement} handleInput — handle input element (hidden when selected)
   * @param {Object} actor — selected actor
   */
  renderSelectedAccount(targetEl, handleInput, actor) {
    if (!actor) return;

    const initial = ((actor.handle || '?')[0]).toUpperCase();
    const avatarHtml = actor.avatar
      ? `<img class="selected-account-avatar" src="${escapeHtml(actor.avatar)}" alt="">`
      : `<span class="selected-account-placeholder">${initial}</span>`;

    targetEl.innerHTML = `
      ${avatarHtml}
      <div class="selected-account-info">
        <div class="selected-account-name">${escapeHtml(actor.displayName || actor.handle)}</div>
        <div class="selected-account-handle">@${escapeHtml(actor.handle)}</div>
      </div>
      <button class="selected-account-clear" title="Clear selection">&times;</button>
    `;

    targetEl.querySelector('.selected-account-clear').addEventListener('click', () => {
      this._emit('actor-cleared');
    });

    // Show selected account, hide search input
    handleInput.style.display = 'none';
    targetEl.style.display = 'flex';
  }

  /**
   * Clear actor selection and restore the search input.
   * @param {Object} refs
   */
  clearActorSelection(refs) {
    const { handleInput, selectedAccountEl, loginError } = refs;
    handleInput.value = '';
    handleInput.style.display = '';
    selectedAccountEl.style.display = 'none';
    loginError.style.display = 'none';
    handleInput.focus();
  }

  // =========================================================================
  // Login state
  // =========================================================================

  /**
   * Render the login loading/error state.
   * @param {Object} refs
   * @param {Object} params
   * @param {boolean} params.loading
   * @param {string|null} params.error
   */
  renderLoginState(refs, { loading, error }) {
    const { loginLoading, loginError } = refs;

    if (loading) {
      loginLoading.style.display = '';
      loginError.style.display = 'none';
    } else {
      loginLoading.style.display = 'none';
    }

    if (error) {
      loginError.textContent = error;
      loginError.style.display = '';
    } else {
      loginError.style.display = 'none';
    }
  }

  // =========================================================================
  // Account info
  // =========================================================================

  /**
   * Render the account info section in the sidebar.
   * @param {HTMLElement} targetEl — account-info container
   * @param {Object} params
   * @param {Object|null} params.profile
   * @param {string} params.handle
   * @param {string} params.did
   */
  renderAccountInfo(targetEl, { profile, handle, did }) {
    const p = profile || {};
    const displayName = p.displayName || handle;
    const initial = ((handle || '?')[0]).toUpperCase();

    const avatarHtml = p.avatar
      ? `<img class="account-avatar" src="${escapeHtml(p.avatar)}" alt="">`
      : `<span class="account-placeholder">${initial}</span>`;

    targetEl.innerHTML = `
      ${avatarHtml}
      <div class="account-details">
        <div class="account-name">${escapeHtml(displayName)}</div>
        <div class="account-handle">@${escapeHtml(handle)}</div>
        <div class="account-did">${escapeHtml(did)}</div>
      </div>
    `;
  }

  // =========================================================================
  // Navigation
  // =========================================================================

  /**
   * Switch the active panel.
   * Updates nav items and panel visibility.
   * @param {string} panel — panel name
   */
  switchPanel(panel) {
    // Update nav items (don't highlight for create-record -- it's a sub-panel)
    document.querySelectorAll('.nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.panel === panel);
    });

    // Update panels
    document.querySelectorAll('.panel').forEach(p => {
      p.classList.remove('active');
      p.style.display = 'none';
    });

    const panelEl = document.getElementById(`panel-${panel}`);
    if (panelEl) {
      panelEl.classList.add('active');
      panelEl.style.display = '';
    }
  }

  /**
   * Set up nav item click handlers.
   */
  setupNav() {
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', () => {
        const panel = item.dataset.panel;
        this._emit('panel-switch', { panel });
      });
    });
  }

  // =========================================================================
  // Sync indicator
  // =========================================================================

  /**
   * Update the "last synced" indicator text.
   * @param {HTMLElement} el — the sync status element
   * @param {number} lastSyncTime — timestamp of last sync
   */
  updateSyncIndicator(el, lastSyncTime) {
    if (!el) return;

    if (!lastSyncTime) {
      el.textContent = '';
      return;
    }

    const ago = Date.now() - lastSyncTime;
    let text;
    if (ago < 60000) {
      text = 'just now';
    } else if (ago < 3600000) {
      const mins = Math.floor(ago / 60000);
      text = `${mins} min${mins !== 1 ? 's' : ''} ago`;
    } else {
      const hrs = Math.floor(ago / 3600000);
      text = `${hrs} hr${hrs !== 1 ? 's' : ''} ago`;
    }
    el.textContent = `synced ${text}`;
  }
}
