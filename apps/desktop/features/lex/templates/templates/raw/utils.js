/**
 * Raw template pack — shared utility functions.
 * Extracted from home.js as-is.
 */

export function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Format a datetime string.
 */
export function formatDateTime(isoStr) {
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr;
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return isoStr;
  }
}

/**
 * Extract the rkey (last segment) from an AT URI.
 * at://did:plc:xxx/app.bsky.feed.post/3abc123 -> 3abc123
 */
export function rkeyFromUri(uri) {
  if (!uri) return '';
  const parts = uri.split('/');
  return parts[parts.length - 1] || '';
}

/**
 * Generate a preview string for a record value.
 * Looks for common fields: text, title, name, description, displayName, subject.
 */
export function getRecordPreview(value) {
  if (!value || typeof value !== 'object') return '';

  // Try common text fields
  for (const key of ['text', 'title', 'name', 'displayName', 'description', 'summary']) {
    if (typeof value[key] === 'string' && value[key].trim()) {
      const text = value[key].trim();
      return text.length > 120 ? text.substring(0, 120) + '...' : text;
    }
  }

  // For records with a subject (likes, reposts, etc.)
  if (value.subject) {
    if (typeof value.subject === 'string') return value.subject;
    if (value.subject.uri) return value.subject.uri;
  }

  // For follows
  if (value.subject && typeof value.subject === 'string') {
    return value.subject;
  }

  // $type as fallback context
  if (value.$type) return value.$type;

  return '';
}

/**
 * Format a date from record value (createdAt or indexedAt).
 */
export function getRecordDate(value) {
  if (!value || typeof value !== 'object') return '';

  const dateStr = value.createdAt || value.indexedAt;
  if (!dateStr) return '';

  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return '';
  }
}
