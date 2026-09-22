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

// The border has exactly one window at a time, tracked as an explicit state
// rather than a bare window id:
//
//   closed  --showBorder()-->  opening  --open resolved-->  open
//   open    --hideBorder() / window gone-->  closed
//
// `opening` is the state that matters. `showBorder()` is called from several
// places at once — `enterWorkspace()` directly, and `updateBorderVisibility()`
// on every `window:focused` / `window:closed` event — and `api.window.open`
// takes tens of milliseconds to resolve. With only an id to check, every call
// arriving before the first open resolved saw "no border" and opened another
// one. That is not just wasteful: the border is a transient overlay, and the
// window kernel dismisses a transient when a sibling window appears
// (`window-kernel.ts selectTransientAutoclose`; a border is exempt only once
// its click-through flag has landed). Each extra border dismissed the one
// before it, the dismissal's `window:closed` re-ran `updateBorderVisibility()`,
// which opened yet another border — a self-sustaining loop of one new border
// every ~100 ms that also dismissed every transient window opened meanwhile,
// the command palette included, so every command after the first workspace
// switch appeared to do nothing (specs/spaces-workspace-switch-regressions.md,
// symptom 3). While `opening`, a show only records the latest color/name to
// apply when the open resolves, and a hide only records that the window
// should be closed as soon as it exists.
const border = {
  state: 'closed',   // 'closed' | 'opening' | 'open'
  windowId: null,
  pendingUpdate: null, // { color, name } received while opening
  closeRequested: false,
};
let borderHideTimer = null;
const BORDER_HIDE_DELAY_MS = 600;

async function showBorder(color, name) {
  const safeColor = resolveSpaceBorderColor(color, activeSpaceId);

  if (border.state === 'opening') {
    border.pendingUpdate = { color: safeColor, name };
    border.closeRequested = false;
    return;
  }

  if (border.state === 'open') {
    try {
      const exists = await api.window.exists(border.windowId);
      if (exists?.exists) {
        api.pubsub.publish('spaces:border-update', { color: safeColor, name });
        return;
      }
    } catch { /* window gone */ }
    // Closed from outside (the kernel dismissed it, or the user closed it).
    border.state = 'closed';
    border.windowId = null;
  }

  border.state = 'opening';
  border.pendingUpdate = null;
  border.closeRequested = false;
  try {
    const displayResult = await api.screen.getPrimaryDisplay();
    if (!displayResult.success) {
      border.state = 'closed';
      return;
    }
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

    if (!result?.id) {
      border.state = 'closed';
      return;
    }
    border.windowId = result.id;
    border.state = 'open';
    if (border.closeRequested) {
      hideBorder();
      return;
    }
    await api.window.setIgnoreMouseEvents(border.windowId, true, true);
    await api.window.setVisibleOnAllWorkspaces(border.windowId, true);
    if (border.pendingUpdate) {
      api.pubsub.publish('spaces:border-update', border.pendingUpdate);
      border.pendingUpdate = null;
    }
  } catch (err) {
    console.error('[ext:spaces] Failed to create border window:', err);
    border.state = 'closed';
    border.windowId = null;
  }
}

function hideBorder() {
  if (border.state === 'opening') {
    // Honored by showBorder() the moment the open resolves.
    border.closeRequested = true;
    border.pendingUpdate = null;
    return;
  }
  if (border.windowId) {
    try {
      api.window.close(border.windowId);
    } catch { /* ignore */ }
  }
  border.state = 'closed';
  border.windowId = null;
  border.pendingUpdate = null;
  border.closeRequested = false;
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

/**
 * Show the panel for the active workspace, or update the one already open.
 * `color` is the workspace's accent — the same resolved color the screen
 * border uses — and travels both ways the panel learns its workspace: the
 * URL on creation and `spaces:panel-update` on a later switch, so the panel
 * is themed on every switch, not only the first (`panel.js applyAccent`).
 */
async function showPanel(spaceName, color) {
  if (panelWindowId) {
    try {
      const exists = await api.window.exists(panelWindowId);
      if (exists?.exists) {
        api.pubsub.publish('spaces:panel-update', { spaceName, color });
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

    const panelHtml = `peek://spaces/panel.html?spaceName=${encodeURIComponent(spaceName)}&color=${encodeURIComponent(color || '')}`;
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

// Roles a window can carry and still be user content that belongs to a
// workspace — the window kernel's own content set (`window-kernel.ts
// CONTENT_ROLES`): pages, their popups, and feature pages like the Spaces
// browse-all list. Dedicated chrome (the palette, overlays, the switcher,
// the workspace panel) and background pages carry a different role or none
// at all, so they're left alone without a name-list of URLs to skip.
const WORKSPACE_CONTENT_ROLES = new Set(['content', 'child-content', 'workspace']);

/**
 * Declare the active workspace as the mode every content window opened from
 * now on is born with when its opener passes no `spaceMode` of its own —
 * the command palette, a page's popup, a declarative `window` command such
 * as `open spaces`, a restored snapshot row that predates tagging. This is
 * the one mechanism behind "every window belongs to exactly one workspace"
 * (docs/design/window-rules.md "Workspace membership"): the main process
 * stamps the mode at open time through `ipc.ts inheritedModeForNewWindow`,
 * which is what lets the per-workspace sweep in
 * `closeCurrentWorkspaceWindows()` find the window on the next switch and
 * the session projection save it under this workspace's row. Declared
 * BEFORE a workspace's snapshot is restored (see `enterWorkspace()`), so a
 * restored window that carries no saved mode lands in the workspace being
 * entered, never the one being left.
 */
async function declareActiveWorkspaceForNewWindows(spaceId, spaceName, color) {
  try {
    await api.context.setDefault('mode', 'space', { spaceId, spaceName, color });
  } catch (err) {
    console.error('[ext:spaces] Failed to declare the active workspace for new windows:', err);
  }
}

/**
 * Whatever content windows are already open when this feature wakes belong
 * to the default workspace from here on — the default is a real space from
 * the start, not one adopted piecemeal window-by-window later. Runs on every
 * wake, not only the first launch: a window opened before the feature woke
 * (or restored from a snapshot row saved before tagging existed) carries no
 * workspace, or only the URL-detected `page`/`default` placeholder, and would
 * otherwise never be swept. A window that already belongs to a space or a
 * group keeps that membership. Only windows on screen are adopted: a hidden
 * one (the pre-warmed settings singleton, a helper page) is not something
 * the user has open in this workspace.
 */
async function adoptOpenWindowsIntoDefault(tag, spaceName) {
  try {
    const listResult = await api.window.list();
    if (!listResult?.success || !Array.isArray(listResult.windows)) return;
    for (const w of listResult.windows) {
      if (!w?.id || !w.visible || !WORKSPACE_CONTENT_ROLES.has(w.params?.role)) continue;
      const modeResult = await api.context.get('mode', w.id);
      const mode = modeResult?.success ? modeResult.data?.value : null;
      if (mode === 'space' || mode === 'group') continue; // already has a membership of its own
      await api.context.setMode('space', {
        windowId: w.id,
        metadata: { spaceId: tag.id, spaceName, color: tag.color, url: modeResult?.data?.metadata?.url }
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
  const { tag } = tagResult.data;

  defaultSpaceId = tag.id;
  activeSpaceId = tag.id;
  activeSpaceName = getSpaceDisplayName(tag);
  activeSpaceColor = tag.color;

  await declareActiveWorkspaceForNewWindows(tag.id, activeSpaceName, tag.color);
  await adoptOpenWindowsIntoDefault(tag, activeSpaceName);
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
  // The default shows no border, so its windows carry the tag's own color;
  // a named workspace's windows carry the resolved accent the border shows.
  const windowColor = isDefault ? tag.color : resolveSpaceBorderColor(tag.color, tag.id);

  // First, before anything is restored or opened: every window born from
  // here on belongs to the workspace being entered (see
  // declareActiveWorkspaceForNewWindows()).
  await declareActiveWorkspaceForNewWindows(tag.id, spaceName, windowColor);

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
      spaceMode: { spaceId: tag.id, spaceName, color: windowColor },
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
    // recreating it), themed with the same accent as the border.
    showPanel(spaceName, borderColor);
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
  await defaultSpaceReady;
  // Switching to the workspace that is already active is a no-op: re-entering
  // it would save, close and reopen its own windows for no visible change.
  // The Spaces UI's card click and the panel's switch control both come
  // through here, so this is where that churn is avoided; `open space` keeps
  // its re-enter semantics.
  if (activeSpaceId && activeSpaceName &&
      toSpaceTagName(targetName.trim()) === toSpaceTagName(activeSpaceName)) {
    return { success: true, spaceId: activeSpaceId, spaceName: activeSpaceName, unchanged: true };
  }
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
    if (!result?.success) {
      // The panel's Close control has no result surface of its own, so a
      // refused close (e.g. the default already active) would otherwise be
      // indistinguishable from a click that never arrived.
      console.warn('[ext:spaces] close space refused:', result?.error, 'active:', activeSpaceName);
    }
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

  // Wake topic (manifest `lazyEvents`): this tile is lazy and normally wakes
  // only on a `cmd:execute:*` command, but `open spaces` is a declarative
  // `window` command — the lazy-dispatch hook (`main/tile-lazy.ts
  // handleCommandDispatch`) turns it into a `window:reopen-request` and never
  // delivers a `cmd:execute:open spaces`, so opening the Spaces UI alone
  // could not wake this tile, and the default workspace's tag did not exist
  // until some other command ran. The Spaces UI (`home.js init()`) publishes
  // this topic instead; being woken by it is the whole effect — `init` below
  // already bootstraps the default, so the handler only has to exist and
  // let the publish resolve once the bootstrap is done.
  api.pubsub.subscribe('spaces:ensure-default', async () => {
    await defaultSpaceReady;
  });

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
