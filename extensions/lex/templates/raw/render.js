/**
 * Raw Template Pack — Developer debug view for Lexicon Studio.
 *
 * This is the default template that preserves the original Lexicon Studio UI.
 * It renders all fields, metadata, and raw JSON in a developer-friendly format.
 *
 * Template packs export three render functions:
 *   - renderList(records, context)   — renders a collection of records
 *   - renderDetail(record, context)  — renders a single record detail view
 *   - renderEdit(schema, context)    — returns config for the edit/create form
 *
 * The `context` object provides:
 *   - nsid: string           — the collection NSID
 *   - session: object|null   — current AT Protocol session (has .did, .pdsUrl)
 *   - escapeHtml(str)        — HTML escape utility
 *   - formatDateTime(str)    — format ISO datetime string
 *   - getRecordPreview(val)  — extract preview text from a record value
 *   - getRecordDate(val)     — extract formatted date from a record value
 *   - rkeyFromUri(uri)       — extract rkey from an AT URI
 */

// ============================================================================
// List View — renders collection of records as a simple list
// ============================================================================

/**
 * Render a list of records.
 *
 * @param {Array} records - Array of record objects with { uri, value, cid }
 * @param {object} context - Template context with utilities
 * @returns {string} HTML string for the records list
 */
export function renderList(records, context) {
  const { escapeHtml, getRecordPreview, getRecordDate, rkeyFromUri } = context;

  if (!records || records.length === 0) {
    return '<div class="raw-records-empty">No records in this collection</div>';
  }

  return records.map(rec => {
    const uri = rec.uri || '';
    const rkey = rkeyFromUri(uri);
    const preview = getRecordPreview(rec.value);
    const dateStr = getRecordDate(rec.value);

    return `
      <div class="raw-record-item" data-uri="${escapeHtml(uri)}" data-rkey="${escapeHtml(rkey)}">
        <div class="raw-record-item-main">
          <span class="raw-record-item-rkey">${escapeHtml(rkey)}</span>
          ${preview ? `<span class="raw-record-item-preview">${escapeHtml(preview)}</span>` : ''}
        </div>
        <div class="raw-record-item-meta">
          ${dateStr ? `<span class="raw-record-item-date">${escapeHtml(dateStr)}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

// ============================================================================
// Detail View — renders a single record with metadata, fields, and raw JSON
// ============================================================================

/**
 * Render a single record detail view.
 *
 * @param {object} record - Record object with { uri, value, cid }
 * @param {object} context - Template context with utilities
 * @returns {string} HTML string for the record detail
 */
export function renderDetail(record, context) {
  const { escapeHtml, formatDateTime } = context;
  const { uri, value, cid } = record;

  if (!value) {
    return '<div class="raw-records-empty">No record data</div>';
  }

  let html = '';

  // Metadata section
  html += `
    <div class="raw-detail-section">
      <div class="raw-detail-section-title">Metadata</div>
      <div class="raw-detail-meta">
        <div class="raw-meta-row">
          <span class="raw-meta-label">URI</span>
          <span class="raw-meta-value">${escapeHtml(uri)}</span>
        </div>
        ${cid ? `
        <div class="raw-meta-row">
          <span class="raw-meta-label">CID</span>
          <span class="raw-meta-value">${escapeHtml(cid)}</span>
        </div>
        ` : ''}
        ${value.$type ? `
        <div class="raw-meta-row">
          <span class="raw-meta-label">Type</span>
          <span class="raw-meta-value">${escapeHtml(value.$type)}</span>
        </div>
        ` : ''}
        ${value.createdAt ? `
        <div class="raw-meta-row">
          <span class="raw-meta-label">Created</span>
          <span class="raw-meta-value">${escapeHtml(formatDateTime(value.createdAt))}</span>
        </div>
        ` : ''}
      </div>
    </div>
  `;

  // Fields section
  html += `
    <div class="raw-detail-section">
      <div class="raw-detail-section-title">Fields</div>
      ${renderFields(value, context)}
    </div>
  `;

  // Raw JSON section
  html += `
    <div class="raw-detail-section">
      <div class="raw-detail-section-title">Raw JSON</div>
      <div class="raw-json-view">${escapeHtml(JSON.stringify(value, null, 2))}</div>
    </div>
  `;

  return html;
}

// ============================================================================
// Edit View — configuration for the form generator
// ============================================================================

/**
 * Return edit template configuration.
 * The raw template uses the default form generation with no overrides —
 * it passes through to lexicon-ui.js generateForm() as-is.
 *
 * @param {object} schema - The lexicon schema
 * @param {object} context - Template context
 * @returns {object} Edit configuration (empty overrides = use defaults)
 */
export function renderEdit(schema, context) {
  // Raw template: no overrides, use default form generation from lexicon-ui.js
  return {
    templateOverrides: null,
    useDefaultForm: true,
  };
}

// ============================================================================
// Field rendering helpers (for detail view)
// ============================================================================

/**
 * Render record fields as a structured view.
 * Skips $type and createdAt (shown in metadata section).
 */
function renderFields(value, context) {
  const { escapeHtml } = context;

  if (!value || typeof value !== 'object') return '';

  const skipKeys = new Set(['$type', 'createdAt']);
  const entries = Object.entries(value).filter(([k]) => !skipKeys.has(k));

  if (entries.length === 0) {
    return '<div class="raw-records-empty">No fields</div>';
  }

  return entries.map(([key, val]) => {
    return `
      <div class="raw-field">
        <span class="raw-field-name">${escapeHtml(key)}</span>
        <div class="raw-field-value">${renderFieldValue(val, key, context)}</div>
      </div>
    `;
  }).join('');
}

/**
 * Render a single field value with appropriate formatting.
 */
function renderFieldValue(val, key, context) {
  const { escapeHtml, formatDateTime, session } = context;

  if (val === null || val === undefined) {
    return '<span class="raw-null">null</span>';
  }

  if (typeof val === 'string') {
    // URL
    if (val.match(/^https?:\/\//)) {
      return `<a href="${escapeHtml(val)}" target="_blank" rel="noopener">${escapeHtml(val)}</a>`;
    }
    // AT URI
    if (val.startsWith('at://')) {
      return `<span class="raw-mono">${escapeHtml(val)}</span>`;
    }
    // DID
    if (val.startsWith('did:')) {
      return `<span class="raw-mono">${escapeHtml(val)}</span>`;
    }
    // Datetime
    if (val.match(/^\d{4}-\d{2}-\d{2}T/)) {
      return escapeHtml(formatDateTime(val));
    }
    // Regular string
    return escapeHtml(val);
  }

  if (typeof val === 'number' || typeof val === 'boolean') {
    return `<span class="raw-primitive">${escapeHtml(String(val))}</span>`;
  }

  if (Array.isArray(val)) {
    if (val.length === 0) {
      return '<span class="raw-null">[]</span>';
    }
    return `<div class="raw-field-object">${val.map((item, i) => {
      if (typeof item === 'object' && item !== null) {
        return `<div class="raw-array-item${i < val.length - 1 ? ' raw-array-item-border' : ''}">${renderFields(item, context)}</div>`;
      }
      return `<div>${renderFieldValue(item, String(i), context)}</div>`;
    }).join('')}</div>`;
  }

  if (typeof val === 'object') {
    // Blob reference
    if (val.$type === 'blob' || val.ref?.$link || val.cid) {
      const link = val.ref?.$link || val.cid;
      const mimeType = val.mimeType || '';
      if (link && mimeType.startsWith('image/') && session) {
        const blobUrl = `${session.pdsUrl}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(session.did)}&cid=${encodeURIComponent(link)}`;
        return `<img src="${escapeHtml(blobUrl)}" alt="blob" loading="lazy" class="raw-blob-image" />`;
      }
      return `<span class="raw-mono">${escapeHtml(mimeType)} blob: ${escapeHtml(link || 'unknown')}</span>`;
    }

    // Nested object
    return `<div class="raw-field-object">${renderFields(val, context)}</div>`;
  }

  return escapeHtml(String(val));
}
