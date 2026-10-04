/**
 * Todo item decisions — pure functions, no `window` access.
 *
 * The handlers in `background.js` need `window.app`, so the choices they make
 * live here instead and are tested directly by node.
 */

/**
 * Split the `todo` command's argument text into the todo body and the extra
 * tags that end it. `splitTrailing` is `splitTrailingTags` from
 * `peek://app/lib/note-tags.js`, passed in so this module stays free of
 * `peek://` imports and runs under node. Tags earlier in the text stay in the
 * body. Input with only tags (or nothing) has an empty body.
 */
export const parseTodoArgs = (raw, splitTrailing) => {
  const { body, tags } = splitTrailing(raw || '');
  return { body: body.trim(), extraTags: tags };
};

/**
 * Keep the items whose title or content contains `needle` (case-insensitive
 * substring), in input order. A blank needle keeps everything.
 */
export const matchTodos = (items, needle) => {
  const list = Array.isArray(items) ? items : [];
  const text = (needle || '').trim().toLowerCase();
  if (!text) return list.slice();
  return list.filter((it) => {
    const title = (it?.title || '').toLowerCase();
    const content = (it?.content || '').toLowerCase();
    return title.includes(text) || content.includes(text);
  });
};

/** A copy of `items` sorted by `updatedAt` descending. Does not mutate input. */
export const sortNewestFirst = (items) => {
  const list = Array.isArray(items) ? items : [];
  return list.slice().sort((a, b) => {
    const at = new Date(a?.updatedAt || 0).getTime() || 0;
    const bt = new Date(b?.updatedAt || 0).getTime() || 0;
    return bt - at;
  });
};

/**
 * The cmd result for the `todos` command. One or more items become output with
 * `mimeType: 'item'`, which puts the panel into its output selection list.
 *
 * No items is a failure message rather than empty output data: the panel's
 * chain-mode guard reads an empty array as chainable output.
 */
export const todosListResult = (items) => {
  const ordered = sortNewestFirst(items);
  if (ordered.length === 0) {
    return { success: false, message: 'No outstanding todos' };
  }
  return {
    success: true,
    output: {
      data: ordered,
      mimeType: 'item',
      title: ordered.length === 1 ? '1 todo' : `${ordered.length} todos`
    }
  };
};

/**
 * The item the `done` command should act on: the panel's selection when it
 * carries an id, else the first text match, else nothing.
 */
export const pickDoneTarget = (items, { selectedItem, match } = {}) => {
  if (selectedItem && typeof selectedItem === 'object' && selectedItem.id) {
    return selectedItem;
  }
  return matchTodos(items, match)[0] || null;
};
