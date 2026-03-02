/**
 * Raw List Template — collections list, records list, explore lexicons, recent lexicons.
 *
 * Renders all list views from the raw UI as-is.
 * Extracted from home.js.
 *
 * Events emitted:
 *   - 'collection-click' { nsid } — user clicked a collection
 *   - 'explore-click' { nsid } — user clicked an explore lexicon (Create action)
 *   - 'record-click' { uri, rkey } — user clicked a record
 *   - 'recent-click' { nsid } — user clicked a recent lexicon
 *   - 'recent-remove' { nsid } — user clicked remove on a recent lexicon
 *   - 'load-more' — user clicked load more button
 *   - 'back' — user clicked back button (records list)
 *   - 'create-from-records' { nsid } — user clicked "+ Create" from records panel
 *   - 'refresh' — user clicked refresh button in records panel
 */

import { escapeHtml, rkeyFromUri, getRecordPreview, getRecordDate } from './utils.js';
import { nsidToFriendlyName } from '../../lexicon-ui.js';

export class ListTemplate {
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
  // Collections list (My Lexicons)
  // =========================================================================

  /**
   * Render the collections list into a target element.
   * @param {HTMLElement} targetEl — element to render into
   * @param {Object} params
   * @param {Array|null} params.collections — array of { nsid, count, hasMore }
   * @param {string} params.filter — current filter text
   */
  renderCollections(targetEl, { collections, filter }) {
    if (!collections || collections.length === 0) {
      targetEl.innerHTML = '<div class="collections-empty">No collections found</div>';
      return;
    }

    const filtered = filter
      ? collections.filter(col => col.nsid.toLowerCase().includes(filter))
      : collections;

    if (filtered.length === 0) {
      targetEl.innerHTML = `<div class="collections-empty">No lexicons matching "${escapeHtml(filter)}"</div>`;
      return;
    }

    targetEl.innerHTML = filtered.map(col => {
      const countLabel = col.hasMore ? `${col.count}+` : String(col.count);
      const friendly = nsidToFriendlyName(col.nsid);
      return `
        <div class="collection-item clickable" data-nsid="${escapeHtml(col.nsid)}" title="${escapeHtml(col.nsid)}">
          <div class="collection-info">
            <span class="collection-friendly">${escapeHtml(friendly)}</span>
            <span class="collection-nsid">${escapeHtml(col.nsid)}</span>
          </div>
          <div class="collection-right">
            <span class="collection-count">${countLabel}</span>
            <span class="collection-action">View</span>
          </div>
        </div>
      `;
    }).join('');

    // Attach click handlers to browse records
    targetEl.querySelectorAll('.collection-item.clickable').forEach(el => {
      el.addEventListener('click', () => {
        const nsid = el.dataset.nsid;
        if (nsid) this._emit('collection-click', { nsid });
      });
    });
  }

  // =========================================================================
  // Explore lexicons list
  // =========================================================================

  /**
   * Render the explore lexicons list into a target element.
   * @param {HTMLElement} targetEl
   * @param {Object} params
   * @param {boolean} params.loading
   * @param {string|null} params.error
   * @param {Array|null} params.lexicons
   * @param {string} params.filter
   */
  renderExploreLexicons(targetEl, { loading, error, lexicons, filter }) {
    if (loading) {
      targetEl.innerHTML = '<div class="loading">Loading lexicon directory...</div>';
      return;
    }

    if (error) {
      targetEl.innerHTML = `<div class="error">${escapeHtml(error)}</div>`;
      return;
    }

    if (!lexicons || lexicons.length === 0) {
      targetEl.innerHTML = '<div class="collections-empty">No lexicons found</div>';
      return;
    }

    const filtered = filter
      ? lexicons.filter(lex => lex.nsid.toLowerCase().includes(filter))
      : lexicons;

    if (filtered.length === 0) {
      targetEl.innerHTML = `<div class="collections-empty">No lexicons matching "${escapeHtml(filter)}"</div>`;
      return;
    }

    // Group by domain
    const groups = {};
    for (const lex of filtered) {
      const domain = lex.domain || 'unknown';
      if (!groups[domain]) groups[domain] = [];
      groups[domain].push(lex);
    }

    const statsHtml = `<div class="explore-stats">${filtered.length} lexicon${filtered.length !== 1 ? 's' : ''}${filter ? ' matched' : ' loaded'}</div>`;

    const groupsHtml = Object.entries(groups).map(([domain, domainLexicons]) => {
      const items = domainLexicons.map(lex => {
        const friendly = nsidToFriendlyName(lex.nsid);
        return `
          <div class="collection-item clickable" data-nsid="${escapeHtml(lex.nsid)}" title="${escapeHtml(lex.nsid)}">
            <div class="collection-info">
              <span class="collection-friendly">${escapeHtml(friendly)}</span>
              <span class="collection-nsid">${escapeHtml(lex.nsid)}</span>
            </div>
            <span class="collection-action">Create</span>
          </div>
        `;
      }).join('');

      return `
        <div class="domain-group-label">${escapeHtml(domain)}</div>
        ${items}
      `;
    }).join('');

    targetEl.innerHTML = statsHtml + groupsHtml;

    // Attach click handlers for "Create" action
    targetEl.querySelectorAll('.collection-item.clickable').forEach(el => {
      el.addEventListener('click', () => {
        const nsid = el.dataset.nsid;
        if (nsid) this._emit('explore-click', { nsid });
      });
    });
  }

  // =========================================================================
  // Records list
  // =========================================================================

  /**
   * Render the records list into a target element.
   * @param {HTMLElement} targetEl
   * @param {Object} params
   * @param {Array} params.records
   * @param {string|null} params.cursor — if truthy, show load more
   * @param {HTMLElement} params.paginationEl — the pagination container
   */
  renderRecordsList(targetEl, { records, cursor, paginationEl }) {
    if (!records || records.length === 0) {
      targetEl.innerHTML = '<div class="records-empty">No records in this collection</div>';
      if (paginationEl) paginationEl.style.display = 'none';
      return;
    }

    targetEl.innerHTML = records.map(rec => {
      const uri = rec.uri || '';
      const rkey = rkeyFromUri(uri);
      const preview = getRecordPreview(rec.value);
      const dateStr = getRecordDate(rec.value);

      return `
        <div class="record-item" data-uri="${escapeHtml(uri)}" data-rkey="${escapeHtml(rkey)}">
          <div class="record-item-main">
            <span class="record-item-rkey">${escapeHtml(rkey)}</span>
            ${preview ? `<span class="record-item-preview">${escapeHtml(preview)}</span>` : ''}
          </div>
          <div class="record-item-meta">
            ${dateStr ? `<span class="record-item-date">${escapeHtml(dateStr)}</span>` : ''}
          </div>
        </div>
      `;
    }).join('');

    // Show/hide pagination
    if (paginationEl) {
      paginationEl.style.display = cursor ? '' : 'none';
    }

    // Click handlers
    targetEl.querySelectorAll('.record-item').forEach(el => {
      el.addEventListener('click', () => {
        const uri = el.dataset.uri;
        const rkey = el.dataset.rkey;
        if (uri && rkey) this._emit('record-click', { uri, rkey });
      });
    });
  }

  // =========================================================================
  // Recent lexicons sidebar
  // =========================================================================

  /**
   * Render the recent lexicons sidebar section.
   * @param {HTMLElement} targetEl
   * @param {Object} params
   * @param {Array<string>} params.recentLexicons — array of NSIDs
   */
  renderRecentLexicons(targetEl, { recentLexicons }) {
    if (!recentLexicons || recentLexicons.length === 0) {
      targetEl.innerHTML = `
        <div class="recent-label"><span class="nav-icon">&#8986;</span> Recent</div>
        <div class="recent-empty">No recent lexicons yet</div>
      `;
      return;
    }

    targetEl.innerHTML = `
      <div class="recent-label">Recent Lexicons</div>
      ${recentLexicons.map(nsid => {
        const friendly = nsidToFriendlyName(nsid);
        return `
          <div class="recent-item" data-nsid="${escapeHtml(nsid)}" title="${escapeHtml(nsid)}">
            <span class="recent-item-name">${escapeHtml(friendly)}</span>
            <button class="recent-item-remove" data-nsid="${escapeHtml(nsid)}" title="Remove">&times;</button>
          </div>
        `;
      }).join('')}
    `;

    // Click to open create panel with that lexicon
    targetEl.querySelectorAll('.recent-item').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('recent-item-remove')) return;
        const nsid = el.dataset.nsid;
        this._emit('recent-click', { nsid });
      });
    });

    // Remove button
    targetEl.querySelectorAll('.recent-item-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._emit('recent-remove', { nsid: btn.dataset.nsid });
      });
    });
  }

  // =========================================================================
  // Picker results (for create panel lexicon picker)
  // =========================================================================

  /**
   * Render picker dropdown results.
   * @param {HTMLElement} targetEl — the picker results container
   * @param {Object} params
   * @param {Array} params.items — { nsid, inRepo }
   * @param {string} params.filter
   * @param {boolean} params.loading — whether explore data is loading
   * @returns {boolean} whether the picker should be visible
   */
  renderPickerResults(targetEl, { items, filter, loading }) {
    if (items.length === 0 && !filter) {
      if (loading) {
        targetEl.innerHTML = '<div class="loading" style="padding: 12px 14px;">Loading lexicons...</div>';
        targetEl.classList.add('visible');
        return true;
      } else {
        targetEl.classList.remove('visible');
        return false;
      }
    }

    if (items.length === 0) {
      targetEl.innerHTML = `<div style="padding: 12px 14px; color: var(--base04); font-size: 13px;">No lexicons matching "${escapeHtml(filter)}"</div>`;
      targetEl.classList.add('visible');
      return true;
    }

    // Separate into groups
    const inRepo = items.filter(i => i.inRepo);
    const other = items.filter(i => !i.inRepo);

    let html = '';

    if (inRepo.length > 0) {
      html += '<div class="picker-group-label">In your repo</div>';
      html += inRepo.map(item => {
        const friendly = nsidToFriendlyName(item.nsid);
        return `
          <div class="picker-item" data-nsid="${escapeHtml(item.nsid)}" title="${escapeHtml(item.nsid)}">
            <div class="picker-item-info">
              <span class="picker-item-friendly">${escapeHtml(friendly)}</span>
              <span class="picker-item-nsid">${escapeHtml(item.nsid)}</span>
            </div>
            <span class="picker-item-badge">yours</span>
          </div>
        `;
      }).join('');
    }

    if (other.length > 0) {
      const shown = other.slice(0, 50);
      html += '<div class="picker-group-label">All lexicons</div>';
      html += shown.map(item => {
        const friendly = nsidToFriendlyName(item.nsid);
        return `
          <div class="picker-item" data-nsid="${escapeHtml(item.nsid)}" title="${escapeHtml(item.nsid)}">
            <div class="picker-item-info">
              <span class="picker-item-friendly">${escapeHtml(friendly)}</span>
              <span class="picker-item-nsid">${escapeHtml(item.nsid)}</span>
            </div>
          </div>
        `;
      }).join('');
      if (other.length > 50) {
        html += `<div style="padding: 8px 14px; color: var(--base04); font-size: 12px;">${other.length - 50} more — type to filter</div>`;
      }
    }

    targetEl.innerHTML = html;
    targetEl.classList.add('visible');

    // Click handlers — emit 'picker-select' via callback
    targetEl.querySelectorAll('.picker-item').forEach(el => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const nsid = el.dataset.nsid;
        if (nsid) this._emit('picker-select', { nsid });
      });
    });

    return true;
  }

  /**
   * Update active item highlight in picker.
   * @param {NodeList} items
   * @param {number} activeIndex
   */
  updatePickerActiveItem(items, activeIndex) {
    items.forEach((el, i) => {
      el.classList.toggle('active', i === activeIndex);
    });
    if (activeIndex >= 0 && items[activeIndex]) {
      items[activeIndex].scrollIntoView({ block: 'nearest' });
    }
  }
}
