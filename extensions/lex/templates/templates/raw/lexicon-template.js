/**
 * Raw Lexicon Template — single record detail display.
 *
 * Renders the record detail view with metadata, fields, and raw JSON.
 * Extracted from home.js as-is (the "raw" debugging view).
 *
 * Events emitted:
 *   - 'back' — user clicked back button
 *   - 'delete' — user confirmed delete for a record URI
 */

import { escapeHtml, formatDateTime, rkeyFromUri } from './utils.js';

export class LexiconTemplate {
  /**
   * @param {Object} options
   * @param {Object} options.session — current AT session (for blob URLs)
   */
  constructor(options = {}) {
    this._session = options.session || null;
    this._listeners = {};
    this._deleteTimeout = null;
  }

  /**
   * Register an event listener.
   * @param {string} event — 'back' | 'delete'
   * @param {Function} handler
   */
  on(event, handler) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(handler);
    return this;
  }

  _emit(event, data) {
    const handlers = this._listeners[event] || [];
    for (const h of handlers) h(data);
  }

  /**
   * Update the session reference (e.g. after token refresh).
   */
  setSession(session) {
    this._session = session;
  }

  /**
   * Render a record detail view.
   * @param {Object} params
   * @param {string} params.uri — AT URI of the record
   * @param {string} params.cid — CID of the record
   * @param {Object} params.value — record value object
   * @param {string} params.rkey — record key
   * @returns {DocumentFragment}
   */
  renderDetail({ uri, cid, value, rkey }) {
    const frag = document.createDocumentFragment();

    // Header row
    const headerRow = document.createElement('div');
    headerRow.className = 'panel-header-row';

    const backBtn = document.createElement('button');
    backBtn.className = 'btn-back';
    backBtn.title = 'Back';
    backBtn.innerHTML = '&larr;';
    backBtn.addEventListener('click', () => this._emit('back'));

    const headerContent = document.createElement('div');
    headerContent.className = 'panel-header-content';

    const titleEl = document.createElement('h2');
    titleEl.className = 'panel-title';
    titleEl.textContent = rkey || rkeyFromUri(uri);

    const subtitleEl = document.createElement('p');
    subtitleEl.className = 'panel-subtitle';
    subtitleEl.textContent = uri;

    headerContent.appendChild(titleEl);
    headerContent.appendChild(subtitleEl);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-sm btn-danger';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => this._handleDelete(deleteBtn, uri));

    headerRow.appendChild(backBtn);
    headerRow.appendChild(headerContent);
    headerRow.appendChild(deleteBtn);

    const header = document.createElement('div');
    header.className = 'panel-header';
    header.appendChild(headerRow);
    frag.appendChild(header);

    // Content
    const contentEl = document.createElement('div');
    contentEl.className = 'record-detail-content';

    if (!value) {
      contentEl.innerHTML = '<div class="records-empty">No record data</div>';
    } else {
      contentEl.innerHTML = this._renderRecordContent(uri, cid, value);
    }

    frag.appendChild(contentEl);
    return frag;
  }

  /**
   * Render just the record content (for updating in place).
   */
  renderContent({ uri, cid, value }) {
    if (!value) {
      return '<div class="records-empty">No record data</div>';
    }
    return this._renderRecordContent(uri, cid, value);
  }

  _handleDelete(btn, uri) {
    if (btn.textContent === 'Delete') {
      btn.textContent = 'Confirm Delete';
      btn.classList.add('confirming');
      this._deleteTimeout = setTimeout(() => {
        if (btn.textContent === 'Confirm Delete') {
          btn.textContent = 'Delete';
          btn.classList.remove('confirming');
        }
      }, 3000);
      return;
    }
    // Confirmed
    if (this._deleteTimeout) clearTimeout(this._deleteTimeout);
    btn.disabled = true;
    btn.textContent = 'Deleting...';
    this._emit('delete', { uri, rkey: rkeyFromUri(uri), button: btn });
  }

  _renderRecordContent(uri, cid, value) {
    let html = '';

    // Metadata section
    html += `
      <div class="record-detail-section">
        <div class="record-detail-section-title">Metadata</div>
        <div class="record-detail-meta">
          <div class="record-meta-row">
            <span class="record-meta-label">URI</span>
            <span class="record-meta-value">${escapeHtml(uri)}</span>
          </div>
          ${cid ? `
          <div class="record-meta-row">
            <span class="record-meta-label">CID</span>
            <span class="record-meta-value">${escapeHtml(cid)}</span>
          </div>
          ` : ''}
          ${value.$type ? `
          <div class="record-meta-row">
            <span class="record-meta-label">Type</span>
            <span class="record-meta-value">${escapeHtml(value.$type)}</span>
          </div>
          ` : ''}
          ${value.createdAt ? `
          <div class="record-meta-row">
            <span class="record-meta-label">Created</span>
            <span class="record-meta-value">${escapeHtml(formatDateTime(value.createdAt))}</span>
          </div>
          ` : ''}
        </div>
      </div>
    `;

    // Fields section
    html += `
      <div class="record-detail-section">
        <div class="record-detail-section-title">Fields</div>
        ${this._renderRecordFields(value)}
      </div>
    `;

    // Raw JSON section
    html += `
      <div class="record-detail-section">
        <div class="record-detail-section-title">Raw JSON</div>
        <div class="record-json-view">${escapeHtml(JSON.stringify(value, null, 2))}</div>
      </div>
    `;

    return html;
  }

  /**
   * Render record fields as a structured view.
   * Skips $type and createdAt (shown in metadata).
   */
  _renderRecordFields(value) {
    if (!value || typeof value !== 'object') return '';

    const skipKeys = new Set(['$type', 'createdAt']);
    const entries = Object.entries(value).filter(([k]) => !skipKeys.has(k));

    if (entries.length === 0) {
      return '<div class="records-empty">No fields</div>';
    }

    return entries.map(([key, val]) => {
      return `
        <div class="record-field">
          <span class="record-field-name">${escapeHtml(key)}</span>
          <div class="record-field-value">${this._renderFieldValue(val, key)}</div>
        </div>
      `;
    }).join('');
  }

  /**
   * Render a single field value with appropriate formatting.
   */
  _renderFieldValue(val, key) {
    if (val === null || val === undefined) {
      return '<span style="color: var(--base04); font-style: italic;">null</span>';
    }

    if (typeof val === 'string') {
      if (val.match(/^https?:\/\//)) {
        return `<a href="${escapeHtml(val)}" target="_blank" rel="noopener">${escapeHtml(val)}</a>`;
      }
      if (val.startsWith('at://')) {
        return `<span style="font-family: var(--theme-font-mono, monospace); font-size: 12px;">${escapeHtml(val)}</span>`;
      }
      if (val.startsWith('did:')) {
        return `<span style="font-family: var(--theme-font-mono, monospace); font-size: 12px;">${escapeHtml(val)}</span>`;
      }
      if (val.match(/^\d{4}-\d{2}-\d{2}T/)) {
        return escapeHtml(formatDateTime(val));
      }
      return escapeHtml(val);
    }

    if (typeof val === 'number' || typeof val === 'boolean') {
      return `<span style="color: var(--base0E);">${escapeHtml(String(val))}</span>`;
    }

    if (Array.isArray(val)) {
      if (val.length === 0) {
        return '<span style="color: var(--base04); font-style: italic;">[]</span>';
      }
      return `<div class="record-field-object">${val.map((item, i) => {
        if (typeof item === 'object' && item !== null) {
          return `<div style="margin-bottom: 8px; padding-bottom: 8px; ${i < val.length - 1 ? 'border-bottom: 1px solid var(--base02);' : ''}">${this._renderRecordFields(item)}</div>`;
        }
        return `<div>${this._renderFieldValue(item, String(i))}</div>`;
      }).join('')}</div>`;
    }

    if (typeof val === 'object') {
      // Check for blob ref
      if (val.$type === 'blob' || val.ref?.$link || val.cid) {
        const link = val.ref?.$link || val.cid;
        const mimeType = val.mimeType || '';
        if (link && mimeType.startsWith('image/') && this._session) {
          const blobUrl = `${this._session.pdsUrl}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(this._session.did)}&cid=${encodeURIComponent(link)}`;
          return `<img src="${escapeHtml(blobUrl)}" alt="blob" loading="lazy" />`;
        }
        return `<span style="font-family: var(--theme-font-mono, monospace); font-size: 12px;">${escapeHtml(mimeType)} blob: ${escapeHtml(link || 'unknown')}</span>`;
      }

      return `<div class="record-field-object">${this._renderRecordFields(val)}</div>`;
    }

    return escapeHtml(String(val));
  }
}
