/**
 * Pure helper for the note command's saved notification.
 */

const TYPE_LABELS = { url: 'URL', tagset: 'Tagset', text: 'Note' };

/**
 * Notification title and body shown after `note {str}` saves an item.
 * @param {string} type - saved item type: 'text' | 'url' | 'tagset'
 * @param {string} content - saved content
 * @returns {{title: string, body: string}}
 */
export const noteSavedNotice = (type, content) => {
  const label = TYPE_LABELS[type] || 'Note';
  const body = String(content || '').trim().replace(/\s+/g, ' ');
  return {
    title: `${label} saved`,
    body: body.length > 100 ? body.slice(0, 100) + '...' : body
  };
};
