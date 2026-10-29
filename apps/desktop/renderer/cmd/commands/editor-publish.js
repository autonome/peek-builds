/**
 * Builders for the `publish` field of a command's output.
 *
 * A command that wants the editor opened returns `output.publish`, a list of
 * `{ topic, payload }` messages. The panel publishes them in order, skips
 * output selection and closes; it knows nothing about the topics.
 */

/** Open the editor on an existing item. */
export const openItemMessages = (itemId, { isNew = false } = {}) => {
  const messages = [{ topic: 'editor:open', payload: { itemId } }];
  if (isNew) {
    messages.push({ topic: 'editor:changed', payload: { action: 'add', itemId } });
  }
  return messages;
};

/** Open the tag query view for a list of tag names. */
export const openTagQueryMessages = (tags) => [
  { topic: 'editor:open', payload: { tags } }
];

/**
 * Open the editor on a new, unsaved item. Starting content opens it
 * pre-filled; nothing is saved until the user saves from the editor.
 */
export const openNewItemMessages = ({ type = 'text', content } = {}) => {
  if (typeof content === 'string' && content.length > 0) {
    return [{ topic: 'editor:open', payload: { content } }];
  }
  return [{ topic: 'editor:add', payload: { type } }];
};
