/**
 * Pure helpers for the cmd panel's note and edit commands.
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

/**
 * Pub/sub topic and payload for opening the editor from a command's output.
 * Returns null when the output does not describe an editor to open.
 * @param {{data: any, mimeType: string, isNew?: boolean}} output
 * @returns {{topic: string, payload: object, alsoChanged?: object}|null}
 */
export const editorMessageForOutput = (output) => {
  if (!output) return null;
  const { data, mimeType } = output;
  if (mimeType === 'tag-query') {
    return { topic: 'editor:open', payload: { tags: data.tags } };
  }
  if (mimeType === 'new-item') {
    // Starting content opens the editor pre-filled; nothing is saved until
    // the user saves from the editor
    if (data && typeof data.content === 'string' && data.content.length > 0) {
      return { topic: 'editor:open', payload: { content: data.content } };
    }
    return { topic: 'editor:add', payload: { type: (data && data.type) || 'text' } };
  }
  if (data && data.id) {
    const message = { topic: 'editor:open', payload: { itemId: data.id } };
    if (output.isNew) {
      message.alsoChanged = { topic: 'editor:changed', payload: { action: 'add', itemId: data.id } };
    }
    return message;
  }
  return null;
};
