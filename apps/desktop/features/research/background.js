/**
 * Research — keep or drop the page you are looking at, with a one-line note.
 *
 * Commands:
 *   keep [note]   — mark the active page kept; a note replaces the page's note
 *   drop [note]   — mark the active page dropped; a note replaces the page's note
 *   unjudge       — clear the state, leaving the note alone
 *
 * The state is a tag on the page's URL item (`kept` / `dropped`) and the note is that
 * item's `metadata.notes`. Every rule about which tag goes and which stays lives in
 * `renderer/lib/page-state.js`; this tile only resolves the page and applies the plan.
 *
 * Lazy background tile: the three commands are registered synchronously in `init()`
 * before any `await`, so the `cmd:execute:*` publish that woke the tile is not missed
 * (apps/desktop/CLAUDE.md, lazy tile init-order rule).
 */

import { planPageState, stateFromTags } from 'peek://app/lib/page-state.js';

const api = window.app;

/**
 * The page the user is acting on, resolved the way `features/tags/background.js`
 * does: the window-state machine's arbitrated front window, or null rather than a
 * guess (tagging the wrong page is worse than reporting no active window).
 */
const getActiveWindow = async () => {
  const result = await api.window.list({ includeInternal: false });
  if (!result.success || !result.windows.length) return null;
  const focusedId = await api.window.getFocusedVisibleWindowId();
  if (!focusedId) return null;
  return result.windows.find((w) => w.id === focusedId) ?? null;
};

/** The URL item for `url`, matched on the canonical normalized form. */
const findItemByUrl = async (url) => {
  const result = await api.datastore.findUrlItem(url);
  if (!result.success) return null;
  return result.data || null;
};

/** The URL item for the active window, created when the page has never been saved. */
const resolveUrlItem = async (activeWindow) => {
  const existing = await findItemByUrl(activeWindow.url);
  if (existing) return existing;

  const created = await api.datastore.addItem('url', {
    content: activeWindow.url,
    metadata: JSON.stringify({ title: activeWindow.title || '' }),
  });
  if (!created.success || !created.data?.id) {
    console.error('[research] failed to create item for', activeWindow.url, created.error);
    return null;
  }
  return { id: created.data.id };
};

/**
 * Resolve the active page and apply `action` to it.
 *
 * @param {'keep'|'drop'|'clear'} action
 * @param {string|undefined} note the command's search text; blank leaves the note alone
 */
const applyAction = async (action, note) => {
  const activeWindow = await getActiveWindow();
  if (!activeWindow) {
    return { success: false, error: 'No active window' };
  }

  const item = await resolveUrlItem(activeWindow);
  if (!item) {
    return { success: false, error: 'Failed to create item' };
  }

  const tagsResult = await api.datastore.getItemTags(item.id);
  const currentTags = (tagsResult.success && tagsResult.data) ? tagsResult.data : [];
  const plan = planPageState(currentTags.map((t) => t.name), action, note);

  for (const name of plan.removeTags) {
    const tag = currentTags.find((t) => t.name.toLowerCase() === name);
    if (!tag) continue;
    const untagged = await api.datastore.untagItem(item.id, tag.id);
    if (!untagged.success) {
      console.error('[research] failed to remove tag', name, untagged.error);
    }
  }

  if (plan.addTag) {
    const tagResult = await api.datastore.getOrCreateTag(plan.addTag);
    if (!tagResult.success || !tagResult.data) {
      return { success: false, error: `Failed to create tag ${plan.addTag}` };
    }
    const tagged = await api.datastore.tagItem(item.id, tagResult.data.tag.id);
    if (!tagged.success) {
      return { success: false, error: `Failed to apply tag ${plan.addTag}` };
    }
  }

  if (plan.notes !== undefined) {
    // updateItem merges metadata shallowly, so this replaces `notes` and leaves the
    // title and everything else the item already carries.
    const updated = await api.datastore.updateItem(item.id, {
      metadata: JSON.stringify({ notes: plan.notes }),
    });
    if (!updated.success) {
      console.error('[research] failed to write note', updated.error);
    }
  }

  // Report the state the page ends in, read from the plan rather than re-queried.
  const endTags = currentTags
    .map((t) => t.name)
    .filter((name) => !plan.removeTags.includes(name.toLowerCase()));
  if (plan.addTag) endTags.push(plan.addTag);

  return {
    success: true,
    itemId: item.id,
    url: activeWindow.url,
    state: stateFromTags(endTags),
    note: plan.notes,
  };
};

const extension = {
  id: 'research',
  labels: {
    name: 'Research',
  },

  registerCommands() {
    api.commands.register({
      name: 'keep',
      description: 'Keep the active page, with an optional one-line note',
      execute: (ctx) => applyAction('keep', ctx?.search),
    });

    api.commands.register({
      name: 'drop',
      description: 'Drop the active page, with an optional one-line note',
      execute: (ctx) => applyAction('drop', ctx?.search),
    });

    api.commands.register({
      name: 'unjudge',
      description: "Clear the active page's kept or dropped state, keeping its note",
      execute: () => applyAction('clear'),
    });
  },

  init() {
    if (!api) return;
    // Synchronous, before any await — see the file header.
    this.registerCommands();
  },

  uninit() {
    if (!api) return;
    api.commands.unregister('keep');
    api.commands.unregister('drop');
    api.commands.unregister('unjudge');
  },
};

export default extension;
