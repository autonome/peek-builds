/**
 * Spaces Feature Background Script
 *
 * Workspace mode with auto-tagging, screen border, and session management.
 * All space-specific logic lives here — the backend provides only generic primitives.
 *
 * Runs in isolated extension process (peek://spaces/background.html)
 */

import {
  id, labels, schemas, storageKeys, defaults,
  SPACE_TAG_PREFIX, isSpaceTag, getSpaceDisplayName, toSpaceTagName,
  resolveVividColor
} from './config.js';

const api = window.app;

console.log('[ext:spaces] background loaded');

// ===== Space State =====
let activeSpaceId = null;
let activeSpaceName = null;
let activeSpaceColor = null;

// ===== Vivid Colors (for border when tag color is too pale) =====
// Uses shared resolveVividColor from config.js
const resolveSpaceBorderColor = resolveVividColor;

// ===== Screen Border =====
// The border is a feature-owned overlay window showing a colored border
// around the screen when a space is active.

let borderWindowId = null;
let borderHideTimer = null;
const BORDER_HIDE_DELAY_MS = 600;

async function showBorder(color, name) {
  const safeColor = resolveSpaceBorderColor(color, activeSpaceId);

  // If border window exists, just update it
  if (borderWindowId) {
    try {
      const exists = await api.window.exists(borderWindowId);
      if (exists?.exists) {
        // Update color and name via message
        api.pubsub.publish('spaces:border-update', { color: safeColor, name });
        return;
      }
    } catch { /* window gone */ }
    borderWindowId = null;
  }

  // Create border overlay window
  try {
    const displayResult = await api.screen.getPrimaryDisplay();
    if (!displayResult.success) return;
    const { bounds } = displayResult.data;

    const borderHtml = `peek://spaces/border.html?color=${encodeURIComponent(safeColor)}&name=${encodeURIComponent(name)}`;
    const result = await api.window.open(borderHtml, {
      role: 'overlay',
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      transparent: true,
      frame: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // Feature chrome, never part of any snapshot — explicit, not a
      // consequence of `role: 'overlay'` (session-projection.ts serializeSession).
      persist: false,
    });

    if (result?.id) {
      borderWindowId = result.id;
      await api.window.setIgnoreMouseEvents(borderWindowId, true, true);
      await api.window.setVisibleOnAllWorkspaces(borderWindowId, true);
    }
  } catch (err) {
    console.error('[ext:spaces] Failed to create border window:', err);
  }
}

function hideBorder() {
  if (borderWindowId) {
    try {
      api.window.close(borderWindowId);
    } catch { /* ignore */ }
    borderWindowId = null;
  }
}

function scheduleHideBorder() {
  if (!borderHideTimer) {
    borderHideTimer = setTimeout(() => {
      borderHideTimer = null;
      hideBorder();
    }, BORDER_HIDE_DELAY_MS);
  }
}

function cancelHideTimer() {
  if (borderHideTimer) {
    clearTimeout(borderHideTimer);
    borderHideTimer = null;
  }
}

// ===== Workspace Panel =====
// A global HUD window (docs/design/window-rules.md "The workspace panel"):
// names the active workspace and offers close/switch controls. Opened
// already pinned across workspaces — the one case where a window is pinned
// by a feature rather than by the user — so it survives closeSpace()'s sweep
// the same way any other globally-pinned window does, and gets no unpin
// control. Unlike the border, it must stay open and merely update across a
// workspace switch rather than closing and reopening (switchSpace() passes
// `keepPanel: true` to closeSpace() for exactly this reason).

let panelWindowId = null;

async function showPanel(spaceName) {
  if (panelWindowId) {
    try {
      const exists = await api.window.exists(panelWindowId);
      if (exists?.exists) {
        api.pubsub.publish('spaces:panel-update', { spaceName });
        return;
      }
    } catch { /* window gone */ }
    panelWindowId = null;
  }

  try {
    const displayResult = await api.screen.getPrimaryDisplay();
    if (!displayResult.success) return;
    const { bounds } = displayResult.data;
    const width = 260;
    const height = 112;
    const margin = 16;

    const panelHtml = `peek://spaces/panel.html?spaceName=${encodeURIComponent(spaceName)}`;
    const result = await api.window.open(panelHtml, {
      // Chrome, not content: excluded from the Windows switcher by role
      // (features/windows/windows.js loadWindows()'s CHROME_ROLES filter).
      // Deliberately NOT 'overlay' — that's one of izui-roles.ts's
      // TRANSIENT_ROLES, whose OS-Space-follow and blur-sweep treatment is
      // for short-lived chrome (the border, the palette); the panel is
      // pinned and must persist for the life of the workspace instead of
      // being dismissed on a focus change.
      role: 'panel',
      x: bounds.x + bounds.width - width - margin,
      y: bounds.y + bounds.height - height - margin,
      width,
      height,
      resizable: false,
      frame: false,
      transparent: true,
      skipTaskbar: true,
      // Born already pinned across every workspace — the existing pin
      // mechanism (window-kernel.ts Pinned layer + the 'pin' context key),
      // set at open time the same way a restored globally-pinned window is.
      alwaysOnTop: true,
      pinScope: 'global',
      // Feature chrome, never part of any snapshot — explicit (requirement 4,
      // specs/workspace-session-snapshot.md), not inferred from role.
      persist: false,
    });

    if (result?.id) {
      panelWindowId = result.id;
    }
  } catch (err) {
    console.error('[ext:spaces] Failed to create workspace panel window:', err);
  }
}

function hidePanel() {
  if (panelWindowId) {
    try {
      api.window.close(panelWindowId);
    } catch { /* ignore */ }
    panelWindowId = null;
  }
}

// ===== Auto-tagging =====
// Subscribe to item:created — if originating window is in space mode, tag it.

async function handleItemCreated(msg) {
  const windowId = msg?.windowId;
  if (!windowId) return; // No window context (external, cmd palette)

  try {
    const modeResult = await api.context.get('mode', windowId);
    if (!modeResult.success) return;

    const mode = modeResult.data;
    if (mode?.value !== 'space' || !mode.metadata?.spaceId) return;

    const spaceTagId = mode.metadata.spaceId;
    const itemId = msg.itemId;
    if (!itemId) return;

    // Tag the item with the space tag
    const result = await api.datastore.tagItem(itemId, spaceTagId);
    if (result.success && !result.alreadyExists) {
      api.pubsub.publish('tag:item-added', {
        tagId: spaceTagId,
        itemId,
        source: 'spaces-auto-tag'
      });
    }
  } catch {
  }
}

// ===== Tag Removal Mode Reset =====
// When a space tag is removed from an item, reset matching windows to page mode.

async function handleTagRemoved(msg) {
  const { tagId, itemId } = msg || {};
  if (!tagId || !itemId) return;

  try {
    const spaceWindows = await api.context.getWindowsInSpace(tagId);
    if (!spaceWindows.success || !spaceWindows.data || spaceWindows.data.length === 0) return;

    // Get the item URL
    const itemResult = await api.datastore.getItem(itemId);
    if (!itemResult.success || !itemResult.data) return;
    const item = itemResult.data;
    if (item.type !== 'url' || !item.content) return;

    // Check each space window
    for (const windowId of spaceWindows.data) {
      const modeResult = await api.context.get('mode', windowId);
      if (!modeResult.success || !modeResult.data) continue;
      const windowUrl = modeResult.data.metadata?.url;
      if (windowUrl && normalizeUrl(windowUrl) === normalizeUrl(item.content)) {
        await api.context.setMode('page', { windowId, metadata: { url: windowUrl } });
      }
    }
  } catch {
  }
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    let normalized = u.protocol + '//' + u.hostname.toLowerCase();
    if (u.port && u.port !== '80' && u.port !== '443') normalized += ':' + u.port;
    let path = u.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    normalized += path + u.search + u.hash;
    return normalized;
  } catch {
    return url;
  }
}

// ===== Border Visibility (focus-based) =====

async function updateBorderVisibility() {
  if (!activeSpaceId) {
    scheduleHideBorder();
    return;
  }

  try {
    const focusedId = await api.window.getFocusedVisibleWindowId();
    if (!focusedId) {
      scheduleHideBorder();
      return;
    }

    const modeResult = await api.context.get('mode', focusedId);
    // The default workspace shows no border — Goal (handoff.md): it is what
    // is open when nothing else is active, not a workspace the user "enters"
    // — so a window that happens to carry the default's spaceId is treated
    // like any other non-space window here.
    if (
      modeResult.success && modeResult.data?.value === 'space' &&
      modeResult.data.metadata?.spaceId && modeResult.data.metadata.spaceId !== defaultSpaceId
    ) {
      cancelHideTimer();
      const color = modeResult.data.metadata.color || activeSpaceColor;
      const name = modeResult.data.metadata.spaceName || activeSpaceName || 'Space';
      showBorder(color, name);
    } else {
      scheduleHideBorder();
    }
  } catch {
    scheduleHideBorder();
  }
}

// ===== Default Workspace =====
//
// Every workspace is named, and there is one named default workspace — what
// is open when no other workspace is active. It is a real space (a
// `space:<name>` tag plus its saved window session, the same as any
// workspace a user names), not an implicit "no space" state (Goal,
// handoff.md). Resolved once per profile through the same getOrCreateTag()
// every other space uses; `defaultSpaceReady` gates every command below so
// none of them can run before `activeSpaceId` has a value to work with.

const DEFAULT_SPACE_NAME = 'default';

// Session-snapshot key for the default workspace — must match the literal
// `'default'` `main/session.ts` calls `DEFAULT_WORKSPACE_KEY`. The default
// workspace IS the app's own startup/quit snapshot (spec: "one code path
// either way"), so its row has to be the same one `session.ts` and
// `entry.ts`'s quit/boot paths already read and write — never this
// workspace's own tag id, which would create a second, unsynced "default"
// snapshot that the ordinary autosave/before-quit save never touches.
const DEFAULT_WORKSPACE_SNAPSHOT_KEY = 'default';

let defaultSpaceId = null;
let defaultSpaceReady = null;

/**
 * First launch only: whatever windows the general session restore already
 * opened, before this feature ever ran, become the default workspace's
 * membership from here on — the default is a real space from the start, not
 * one adopted piecemeal window-by-window later. Adopts only content windows
 * (`params.role === 'content'`, the same role `features/windows/windows.js
 * loadWindows()` treats as user content) — dedicated chrome (the palette,
 * overlays, the switcher, the workspace panel) and background pages carry a
 * different role or none at all, so they're left alone without a name-list
 * of URLs to skip.
 */
async function adoptOpenWindowsIntoDefault(tag, spaceName) {
  try {
    const listResult = await api.window.list();
    if (!listResult?.success || !Array.isArray(listResult.windows)) return;
    for (const w of listResult.windows) {
      if (!w?.id || w.params?.role !== 'content') continue;
      const modeResult = await api.context.get('mode', w.id);
      if (modeResult?.success && modeResult.data?.value) continue; // already has a mode of its own
      await api.context.setMode('space', {
        windowId: w.id,
        metadata: { spaceId: tag.id, spaceName, color: tag.color }
      });
    }
  } catch (err) {
    console.error('[ext:spaces] Failed to adopt open windows into the default workspace:', err);
  }
}

async function bootstrapDefaultSpace() {
  const tagResult = await api.datastore.getOrCreateTag(toSpaceTagName(DEFAULT_SPACE_NAME));
  if (!tagResult.success) {
    console.error('[ext:spaces] Failed to get/create the default workspace tag');
    return;
  }
  const { tag, created } = tagResult.data;

  defaultSpaceId = tag.id;
  activeSpaceId = tag.id;
  activeSpaceName = getSpaceDisplayName(tag);
  activeSpaceColor = tag.color;

  if (created) {
    await adoptOpenWindowsIntoDefault(tag, activeSpaceName);
  }
}

// ===== Session Management =====

/**
 * The session-snapshot key for a workspace tag: the literal
 * `DEFAULT_WORKSPACE_SNAPSHOT_KEY` for the default workspace (so its row is
 * the SAME one `session.ts`/`entry.ts`'s quit/boot paths read and write —
 * requirement 1's "one code path either way"), the tag id for any named
 * workspace.
 */
function workspaceSnapshotKey(tagId) {
  return tagId === defaultSpaceId ? DEFAULT_WORKSPACE_SNAPSHOT_KEY : tagId;
}

/**
 * Restore a workspace's saved session, or start it empty. Shared by every
 * path that makes a workspace the active one — entering a named workspace
 * and returning to the default are the same operation with a different
 * target (Goal, handoff.md: "leaving...reopens the default workspace's
 * saved session").
 *
 * A workspace is a named session snapshot: entering it restores that
 * snapshot through the same `restoreSessionSnapshot` pipeline the app's own
 * boot/quit restore uses, keyed by this workspace's snapshot key
 * (`api.session.restoreWorkspaceSnapshot`, see `workspaceSnapshotKey()`) —
 * nav history, scroll, focus and z-order all come back the same way they do
 * across a quit/relaunch, since it is literally the same restore. A
 * workspace with no saved snapshot opens one new empty group (a single
 * window) so the user has somewhere to start — except the default: its
 * empty state is genuinely empty, since it is what is left when nothing else
 * is active, not a workspace being entered for the first time.
 */
async function enterWorkspace(tag, spaceName) {
  const isDefault = tag.id === defaultSpaceId;

  const restoreResult = await api.session.restoreWorkspaceSnapshot(workspaceSnapshotKey(tag.id));
  // `restored` counts the windows that actually opened — not `total`, the
  // number the snapshot asked for, which is set before any open is attempted.
  // A workspace whose saved windows all failed to open has nothing on screen
  // and needs the empty-group fallback below just like one never saved.
  const restored = !!restoreResult?.success && (restoreResult.restored ?? 0) > 0;

  if (!restored && !isDefault) {
    // No saved state, and this isn't the default — open one empty group.
    const homeUrl = `peek://spaces/home.html?spaceId=${encodeURIComponent(tag.id)}&spaceName=${encodeURIComponent(spaceName)}`;
    await api.window.open(homeUrl, {
      role: 'workspace',
      width: 1024,
      height: 768,
      spaceMode: { spaceId: tag.id, spaceName, color: tag.color },
    });
  }

  activeSpaceId = tag.id;
  activeSpaceName = spaceName;
  activeSpaceColor = tag.color;

  if (isDefault) {
    // The default shows no chrome — see updateBorderVisibility()'s matching
    // exclusion and the Default Workspace note above.
    cancelHideTimer();
    hideBorder();
  } else {
    const borderColor = resolveSpaceBorderColor(tag.color, tag.id);
    showBorder(borderColor, spaceName);
    // Show or update the workspace panel — it stays open across a switch
    // (closeCurrentWorkspaceWindows() below keeps it alive when the target
    // isn't the default; showPanel() reuses an already-open one instead of
    // recreating it).
    showPanel(spaceName);
  }
}

/**
 * Save and close whatever workspace is active now — the default included.
 * Shared by entering a different workspace and by leaving to the default;
 * the two differ only in whether the panel survives the transition.
 *
 * The save is the same `saveSessionSnapshot` the app's own quit/autosave
 * uses, keyed by the outgoing workspace's snapshot key (see
 * `workspaceSnapshotKey()`). Which windows that key saves is decided by the
 * key alone on the main-process side: a named workspace's row holds its own
 * windows and never one pinned across every workspace — that window is not
 * scoped to the workspace being left, so it is left out of the close sweep
 * below too (`docs/design/window-rules.md` "Persistent windows") — while the
 * default workspace's row holds everything on screen.
 */
async function closeCurrentWorkspaceWindows(options = {}) {
  if (!activeSpaceId) return;

  try {
    await api.session.saveWorkspaceSnapshot(workspaceSnapshotKey(activeSpaceId));
  } catch (err) {
    console.error('[ext:spaces] Failed to save workspace layout on close:', err);
  }

  // Get all windows in the active space and close them — except one pinned
  // across every workspace (a global HUD window): it is not scoped to this
  // space in the first place, so leaving must not sweep it. A
  // workspace-pinned window has no such claim and closes normally; it comes
  // back — pinned, badge intact — from the saved workspace row on re-entry
  // (see enterWorkspace()).
  const result = await api.context.getWindowsInSpace(activeSpaceId);
  if (result.success && result.data) {
    for (const windowId of result.data) {
      try {
        const pinResult = await api.context.get('pin', windowId);
        if (pinResult?.data?.value === 'global') continue;
        await api.window.close(windowId);
      } catch {
      }
    }
  }

  if (!options.keepPanel) hidePanel();
}

async function openSpace(spaceName) {
  if (!spaceName) return { success: false, error: 'Usage: open space <name>' };
  await defaultSpaceReady;

  const tagName = toSpaceTagName(spaceName.trim());

  // Get or create the space tag
  const tagResult = await api.datastore.getOrCreateTag(tagName);
  if (!tagResult.success) return { success: false, error: 'Failed to get/create space tag' };
  const tag = tagResult.data.tag;

  // Resolve vivid color for spaces with default/grey color and persist it
  const vividColor = resolveVividColor(tag.color, tag.id);
  if (vividColor !== tag.color) {
    tag.color = vividColor;
    await api.datastore.updateTagColor(tag.id, vividColor);
  }

  const displayName = getSpaceDisplayName(tag);
  const enteringDefault = tag.id === defaultSpaceId;

  // Entering a workspace saves the current workspace's windows — the
  // default included — and closes them (Goal, handoff.md). The panel
  // carries through the switch unless we're landing on the default, which
  // shows no chrome at all.
  //
  // The main process saves the ACTIVE workspace's row on its own schedule
  // (autosave, quit, and ~500ms after any window closes). Between the save
  // below and the restore that follows it, the outgoing workspace's windows
  // are closed and the target's are not open yet, so any such save would
  // record an empty workspace — the switch is bracketed so none runs, and the
  // main process learns which workspace is active once the switch is done
  // (`main/session.ts` "Active workspace"). The bracket always closes, even
  // if the switch fails part-way, so ambient saves never stay suspended.
  try {
    await api.session.beginWorkspaceSwitch();
  } catch (err) {
    console.error('[ext:spaces] Failed to mark the workspace switch as in progress:', err);
  }
  try {
    await closeCurrentWorkspaceWindows({ keepPanel: !enteringDefault });
    await enterWorkspace(tag, displayName);
  } finally {
    try {
      await api.session.setActiveWorkspace(workspaceSnapshotKey(activeSpaceId));
    } catch (err) {
      console.error('[ext:spaces] Failed to report the active workspace:', err);
    }
  }

  console.log(`[ext:spaces] Opened space "${displayName}"`);
  return { success: true, spaceId: tag.id, spaceName: displayName };
}

/**
 * Leave the active workspace: save and close its windows, then reopen the
 * default workspace's saved session (Goal, handoff.md). Nothing to leave if
 * the default is already active — same as before there was a default, this
 * is an error rather than a silent no-op.
 */
async function closeSpace() {
  await defaultSpaceReady;
  if (!activeSpaceId || activeSpaceId === defaultSpaceId) {
    return { success: false, error: 'No active workspace to close' };
  }
  const closedName = activeSpaceName;
  const result = await openSpace(DEFAULT_SPACE_NAME);
  if (!result.success) return result;
  console.log(`[ext:spaces] Closed space "${closedName}"`);
  return { success: true };
}

async function switchSpace(targetName) {
  if (!targetName) return { success: false, error: 'Usage: switch space <name>' };
  // Entering any workspace already closes whichever one is active — switching
  // is just entering a different target (see openSpace()).
  return openSpace(targetName);
}

// ===== Pin / Unpin =====
//
// A pinned window is an ordinary Pinned window (window-kernel.ts `layer`
// above `BASE_LAYER`, from `alwaysOnTop`) — see docs/design/window-rules.md
// "Persistent windows: workspace-pinned and global HUD". `api.window.setPinned`
// moves an already-open window between the pinned band and the base band in
// place (window-kernel.ts `SetLayer`) — the window is never closed or
// reopened, so it keeps its page state. The 'pin' context key (read by the
// badge, `closeSpace()`, and the save-side projections) is the one source of
// truth for scope — nothing infers it from window flags.

async function setPinState(windowId, scope) {
  const result = await api.window.setPinned(windowId, !!scope);
  if (!result?.success) {
    return { success: false, error: result?.error || (scope ? 'Failed to pin window' : 'Failed to unpin window') };
  }
  // The badge (and everything else that cares about scope) reads this key,
  // not the kernel layer — api.context.set publishes context:changed itself,
  // so the badge updates without a reload.
  await api.context.set('pin', scope || null, {}, windowId);

  if (scope === 'workspace') {
    // Associate with the CURRENT workspace regardless of the window's prior
    // mode — "pin to this workspace" means this one, not wherever it was.
    await api.context.setMode('space', {
      windowId,
      metadata: { spaceId: activeSpaceId, spaceName: activeSpaceName, color: activeSpaceColor }
    });
  }
  // A global pin, or an unpin, leaves whatever space membership the window
  // already had — the window was never recreated, so there is nothing to
  // restore.

  return { success: true, windowId, scope: scope || null };
}

async function pinWindow(scope) {
  await defaultSpaceReady;
  if (scope === 'workspace' && !activeSpaceId) {
    return { success: false, error: 'No active workspace — open a space first' };
  }
  const windowId = await api.window.getFocusedVisibleWindowId();
  if (!windowId) return { success: false, error: 'No active window to pin' };
  return setPinState(windowId, scope);
}

async function unpinWindow() {
  await defaultSpaceReady;
  const windowId = await api.window.getFocusedVisibleWindowId();
  if (!windowId) return { success: false, error: 'No active window to unpin' };
  return setPinState(windowId, null);
}

// ===== Command Registration =====

const initCommands = () => {
  // "open space <name>"
  api.pubsub.subscribe('cmd:execute:open space', async (msg) => {
    const result = await openSpace(msg.search?.trim());
    if (msg.expectResult && msg.resultTopic) {
      api.pubsub.publish(msg.resultTopic, result || { success: true });
    }
  });
  api.pubsub.publish('cmd:register', {
    name: 'open space',
    description: 'Open a space (restore saved state or show home)',
    source: 'spaces',
    scope: 'global',
    params: [{ name: 'name', type: 'string', required: true, description: 'Space name' }]
  });

  // "close space"
  api.pubsub.subscribe('cmd:execute:close space', async (msg) => {
    const result = await closeSpace();
    if (msg.expectResult && msg.resultTopic) {
      api.pubsub.publish(msg.resultTopic, result || { success: true });
    }
  });
  api.pubsub.publish('cmd:register', {
    name: 'close space',
    description: 'Save window state, close the workspace, and return to the default workspace',
    source: 'spaces',
    scope: 'global',
  });

  // "switch space <name>"
  api.pubsub.subscribe('cmd:execute:switch space', async (msg) => {
    const result = await switchSpace(msg.search?.trim());
    if (msg.expectResult && msg.resultTopic) {
      api.pubsub.publish(msg.resultTopic, result || { success: true });
    }
  });
  api.pubsub.publish('cmd:register', {
    name: 'switch space',
    description: 'Close current space and open another',
    source: 'spaces',
    scope: 'global',
    params: [{ name: 'name', type: 'string', required: true, description: 'Target space name' }]
  });

  // "pin to this workspace"
  api.pubsub.subscribe('cmd:execute:pin to this workspace', async (msg) => {
    const result = await pinWindow('workspace');
    if (msg.expectResult && msg.resultTopic) {
      api.pubsub.publish(msg.resultTopic, result || { success: true });
    }
  });
  api.pubsub.publish('cmd:register', {
    name: 'pin to this workspace',
    description: 'Keep the active window visible only while this workspace is active',
    source: 'spaces',
    scope: 'global',
  });

  // "pin across workspaces"
  api.pubsub.subscribe('cmd:execute:pin across workspaces', async (msg) => {
    const result = await pinWindow('global');
    if (msg.expectResult && msg.resultTopic) {
      api.pubsub.publish(msg.resultTopic, result || { success: true });
    }
  });
  api.pubsub.publish('cmd:register', {
    name: 'pin across workspaces',
    description: 'Keep the active window visible in every workspace',
    source: 'spaces',
    scope: 'global',
  });

  // "unpin window" — NOT "unpin": features/groups/home.js already owns a
  // single-word "pin" / "unpin" pair for pinning an ITEM inside a group, an
  // unrelated concept. Reusing that exact name would double-subscribe
  // cmd:execute:unpin and race groups' own result onto this command's
  // result topic.
  api.pubsub.subscribe('cmd:execute:unpin window', async (msg) => {
    const result = await unpinWindow();
    if (msg.expectResult && msg.resultTopic) {
      api.pubsub.publish(msg.resultTopic, result || { success: true });
    }
  });
  api.pubsub.publish('cmd:register', {
    name: 'unpin window',
    description: 'Stop pinning the active window',
    source: 'spaces',
    scope: 'global',
  });

  console.log('[ext:spaces] Commands registered: open space, close space, switch space, ' +
    'pin to this workspace, pin across workspaces, unpin window');
};

const uninitCommands = () => {
  for (const name of [
    'open space', 'close space', 'switch space',
    'pin to this workspace', 'pin across workspaces', 'unpin window',
  ]) {
    api.pubsub.publish('cmd:unregister', { name });
  }
};

// ===== Lifecycle =====

const init = async () => {
  console.log('[ext:spaces] init');

  initCommands();

  // Fire-and-forget: resolves activeSpaceId to the default workspace.
  // Every command handler above awaits this before touching activeSpaceId,
  // the same guard-the-body pattern lazy tiles use for a settings-load race
  // (see apps/desktop/CLAUDE.md "CRITICAL init-ordering rule for lazy tile
  // authors") — registration itself stays synchronous.
  defaultSpaceReady = bootstrapDefaultSpace();

  // Subscribe to item:created for auto-tagging
  api.pubsub.subscribe('item:created', handleItemCreated);

  // Subscribe to tag:item-removed for mode reset
  api.pubsub.subscribe('tag:item-removed', handleTagRemoved);

  // Subscribe to focus events for border visibility
  api.pubsub.subscribe('window:focused', () => updateBorderVisibility());
  api.pubsub.subscribe('window:closed', () => updateBorderVisibility());
  api.pubsub.subscribe('app:focus-changed', (msg) => {
    if (!msg?.focused) {
      // App lost focus — hide border
      scheduleHideBorder();
    } else {
      updateBorderVisibility();
    }
  });
};

const uninit = () => {
  console.log('[ext:spaces] uninit');
  uninitCommands();
  cancelHideTimer();
  hideBorder();
  hidePanel();
};

export default {
  defaults,
  id,
  init,
  uninit,
  labels,
  schemas,
  storageKeys
};
