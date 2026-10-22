/**
 * Research — the page you are looking at, and the research you are in.
 *
 * Commands:
 *   keep [note]    — mark the active page kept; a note replaces the page's note
 *   drop [note]    — mark the active page dropped; a note replaces the page's note
 *   unjudge        — clear the state, leaving the note alone
 *   research view  — open this research's view of its pages (`home.js`)
 *
 * Keep and drop: the state is a tag on the page's URL item (`kept` / `dropped`) and
 * the note is that item's `metadata.notes`. Every rule about which tag goes and which
 * stays lives in `renderer/lib/page-state.js`; this tile only resolves the page and
 * applies the plan.
 *
 * The research view: a research is a space, so the command resolves the space of the
 * front content window and opens one maximized, see-through window per research. The
 * view itself reads nothing from here — it resolves and follows the space itself.
 *
 * Lazy background tile: every command is registered synchronously in `init()` before
 * any `await`, so the `cmd:execute:*` publish that woke the tile is not missed
 * (apps/desktop/CLAUDE.md, lazy tile init-order rule).
 */

import { planPageState, stateFromTags } from 'peek://app/lib/page-state.js';

const api = window.app;

/** The window the research view opens as, one per research. */
const VIEW_URL = 'peek://research/home.html';
const VIEW_WIDTH = 900;
const VIEW_HEIGHT = 700;

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

/**
 * The research the front content window belongs to, or null when it belongs to
 * none.
 *
 * A research is a space, and the space is the mode of the front content window
 * — the same question `features/websearch/search-rounds.js spaceOfFrontWindow()`
 * asks, and asked the same way: `getFocusedVisibleWindowId()` skips the palette,
 * and the mode's metadata carries the space. Answering null rather than guessing
 * matters here too: the view of the wrong research is worse than no view.
 *
 * @returns {Promise<{spaceId: string, spaceName: string}|null>}
 */
const researchOfFrontWindow = async () => {
  const windowId = await api.window.getFocusedVisibleWindowId();
  if (windowId == null) return null;

  const result = await api.context.get('mode', windowId);
  const mode = result && result.success ? result.data : null;
  if (!mode || mode.value !== 'space') return null;

  const metadata = mode.metadata;
  if (!metadata || !metadata.spaceId || !metadata.spaceName) return null;

  return { spaceId: metadata.spaceId, spaceName: metadata.spaceName };
};

/**
 * Open the view of the research the user is in.
 *
 * One view per research: the window key carries the space name, so running the
 * command again in the same research raises the view that is already open
 * instead of opening a second one.
 *
 * The see-through look is asked for twice over, and both halves are needed. The
 * open passes `seeThrough: true`, so the window's own param says the switch is
 * on before the view paints and the frosted look is never applied late. The
 * `setSeeThrough` call afterwards is what maximizes the window and records that
 * the switch is what maximized it, so a later `see-through view` puts the window
 * back where it was (docs/design/window-rules.md G15). It is skipped on a reuse:
 * the window is already maximized, and asking again would tell main the switch
 * had not maximized it.
 */
const openResearchView = async () => {
  const research = await researchOfFrontWindow();
  if (!research) {
    return { success: false, error: 'Not in a research space' };
  }

  const url = `${VIEW_URL}?space=${encodeURIComponent(research.spaceName)}`;
  const opened = await api.window.open(url, {
    role: 'workspace',
    key: `research-view:${research.spaceName}`,
    width: VIEW_WIDTH,
    height: VIEW_HEIGHT,
    title: `Research: ${research.spaceName}`,
    transparent: true,
    seeThrough: true,
  });
  if (!opened || opened.success !== true) {
    return { success: false, error: opened?.error || 'Failed to open the research view' };
  }

  const reused = opened.reused === true;
  if (!reused && typeof opened.id === 'number') {
    const applied = await api.window.setSeeThrough(opened.id, true);
    if (!applied || applied.success !== true) {
      // The view is open and readable; only the maximize and the frosted
      // look are missing, so this is reported rather than undone.
      console.error('[research] the research view could not be made see-through:', applied?.error);
    }
  }

  return {
    success: true,
    windowId: opened.id ?? null,
    space: research.spaceName,
    reused,
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

    api.commands.register({
      name: 'research view',
      description: "Show this research's pages, the ones that held attention longest first",
      execute: () => openResearchView(),
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
    api.commands.unregister('research view');
  },
};

export default extension;
