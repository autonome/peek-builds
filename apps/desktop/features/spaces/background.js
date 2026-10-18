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
  resolveVividColor, shouldShowBorder, planMoveToSpace, planDeleteSpace, deleteSpacePromptUrl,
  validateNewSpaceName, spaceNameOptions, spaceNameFromCommandMessage,
  emptySpaceWindowOptions, createSerialRunner, countSpaceWindows, liveSpaceWindowIds,
  SPACES_CHROME_URL_PREFIXES
} from './config.js';

const api = window.app;

console.log('[ext:spaces] background loaded');

// ===== Space State =====
let activeSpaceId = null;
let activeSpaceName = null;
let activeSpaceColor = null;

// ===== Active Theme (for the vivid-color fallback palette) =====
// Set from api.theme.getInfo() at init and kept live via api.theme.onChange()
// — this document has the theme capability and IPC access config.js
// deliberately doesn't (see resolveVividColor's doc comment), so this is
// where the live theme id is read and threaded through.
let activeThemeId = 'peek';

// ===== Vivid Colors (for border when tag color is too pale) =====
// Uses shared resolveVividColor from config.js, pinned to the active theme.
const resolveSpaceBorderColor = (color, spaceId) => resolveVividColor(color, spaceId, activeThemeId);

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
  // The open window is hidden because the app is not the focused app. It is
  // kept, not closed, so activation shows it again at once: opening a fresh
  // border window (display lookup, window creation, page load) is slow enough
  // to see.
  hiddenWhileInactive: false,
};
let borderHideTimer = null;
const BORDER_HIDE_DELAY_MS = 600;

async function showBorder(color, name) {
  const safeColor = resolveSpaceBorderColor(color, activeSpaceId);
  cancelHideTimer();

  if (border.state === 'opening') {
    border.pendingUpdate = { color: safeColor, name };
    border.closeRequested = false;
    return;
  }

  if (border.state === 'open') {
    try {
      const exists = await api.window.exists(border.windowId);
      if (exists?.exists) {
        // The window may have been hidden since (the app resigning active
        // hides it); the creation path shows it, so re-show it here
        // too — without activating the app.
        if (!appFocused) {
          concealBorder();
          return;
        }
        border.hiddenWhileInactive = false;
        await api.window.show(border.windowId, { inactive: true });
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
    border.hiddenWhileInactive = false;
    if (border.closeRequested) {
      hideBorder();
      return;
    }
    // The app resigned active while the window was opening.
    if (!appFocused) concealBorder();
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
  border.hiddenWhileInactive = false;
}

// Hides (never closes) the border the moment the app stops being the focused
// app, with no delay: the border and its name chip must not stay on screen
// over another app. A brief resign/activate pair (a desktop switch, a window
// drag) therefore flickers the border, which is the accepted cost. Called
// synchronously from the focus handler so the hide request leaves this tick.
function concealBorder() {
  cancelHideTimer();
  if (border.state !== 'open' || !border.windowId || border.hiddenWhileInactive) return;
  border.hiddenWhileInactive = true;
  try {
    Promise.resolve(api.window.hide(border.windowId)).catch(() => {});
  } catch { /* window gone */ }
}

// Shows the border hidden by concealBorder() again, at once, without
// activating the app. updateBorderVisibility() runs right after and closes it
// if the window that took focus is not a space window.
function revealBorder() {
  if (border.state !== 'open' || !border.windowId || !border.hiddenWhileInactive) return;
  border.hiddenWhileInactive = false;
  try {
    Promise.resolve(api.window.show(border.windowId, { inactive: true })).catch(() => {});
  } catch { /* window gone */ }
}

// The delay absorbs focus moving between Peek's own windows (to a window
// outside the space and back): whatever re-shows the border cancels it first.
// App focus never goes through it — see concealBorder().
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

// Updated from `app:focus-changed`. Starts true: the feature wakes while the
// app is running, and the first focus change corrects it.
let appFocused = true;

async function updateBorderVisibility() {
  if (!shouldShowBorder(appFocused, true)) {
    // Backgrounded: never open the border (it would activate the app).
    concealBorder();
    return;
  }
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
    // The app may have resigned active during the awaits above.
    if (!appFocused) {
      concealBorder();
      return;
    }
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

// The border and its name chip are visible only while Peek is the focused
// app: resigning active hides them at once even when windows of the space are
// still showing behind the other app, and becoming active shows the same
// window again at once, then re-evaluates it from the focused window. Both
// edges issue their window request synchronously, before any await.
function handleAppFocusChanged(msg) {
  appFocused = !!msg?.focused;
  if (appFocused) {
    revealBorder();
    updateBorderVisibility();
  } else {
    concealBorder();
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
// the border) and background pages carry a different role or none
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
 * to the active workspace from here on — the default, or the named workspace
 * a boot restore reopened (see `bootstrapDefaultSpace()`). Runs on every
 * wake, not only the first launch: a window opened before the feature woke
 * (or restored from a snapshot row saved before tagging existed) carries no
 * workspace, or only the URL-detected `page`/`default` placeholder, and would
 * otherwise never be swept. A window that already belongs to a space or a
 * group keeps that membership. Only windows on screen are adopted: a hidden
 * one (the pre-warmed settings singleton, a helper page) is not something
 * the user has open in this workspace. `color` is the color the workspace's
 * windows carry — the same one `enterWorkspace()` gives them.
 */
async function adoptOpenWindowsInto(tag, spaceName, color) {
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
        metadata: { spaceId: tag.id, spaceName, color, url: modeResult?.data?.metadata?.url }
      });
    }
  } catch (err) {
    console.error('[ext:spaces] Failed to adopt open windows into the active workspace:', err);
  }
}

/**
 * The named space tag the main process holds active, or null for the
 * default. A boot restore makes the workspace that was active at quit active
 * again before this feature wakes (`main/session.ts restoreSessionSnapshot`),
 * so the feature follows the main process rather than assuming the default.
 * A key naming no existing space tag — or any failed lookup — answers null,
 * and the default is active as before.
 */
async function restoredNamedSpaceTag() {
  let key;
  try {
    const result = await api.session.getActiveWorkspace();
    key = result?.success ? result.key : null;
  } catch (err) {
    console.error('[ext:spaces] Failed to read the active workspace:', err);
    return null;
  }
  if (!key || key === DEFAULT_WORKSPACE_SNAPSHOT_KEY || key === defaultSpaceId) return null;
  try {
    return (await listSpaceTags()).find((t) => t.id === key) || null;
  } catch (err) {
    console.error('[ext:spaces] Failed to look up the restored workspace:', err);
    return null;
  }
}

async function bootstrapDefaultSpace() {
  const tagResult = await api.datastore.getOrCreateTag(toSpaceTagName(DEFAULT_SPACE_NAME));
  if (!tagResult.success) {
    console.error('[ext:spaces] Failed to get/create the default workspace tag');
    return;
  }
  const { tag: defaultTag } = tagResult.data;
  defaultSpaceId = defaultTag.id;

  const restoredTag = await restoredNamedSpaceTag();
  const tag = restoredTag || defaultTag;
  const spaceName = getSpaceDisplayName(tag);
  // Same colors `enterWorkspace()` uses: the default's windows carry the
  // tag's own color, a named workspace's the accent its border shows.
  const windowColor = restoredTag ? resolveSpaceBorderColor(tag.color, tag.id) : tag.color;

  activeSpaceId = tag.id;
  activeSpaceName = spaceName;
  activeSpaceColor = tag.color;

  await declareActiveWorkspaceForNewWindows(tag.id, spaceName, windowColor);
  await adoptOpenWindowsInto(tag, spaceName, windowColor);

  if (restoredTag) {
    console.log(`[ext:spaces] Woke into restored space "${spaceName}"`);
    showBorder(windowColor, spaceName);
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
  // The default shows no border, so its windows carry the tag's own color;
  // a named workspace's windows carry the resolved accent the border shows.
  const windowColor = isDefault ? tag.color : resolveSpaceBorderColor(tag.color, tag.id);

  // First, before anything is restored or opened: every window born from
  // here on belongs to the workspace being entered (see
  // declareActiveWorkspaceForNewWindows()).
  await declareActiveWorkspaceForNewWindows(tag.id, spaceName, windowColor);

  await switchToSpaceDesktop(tag.id);
  const restoreResult = await api.session.restoreWorkspaceSnapshot(workspaceSnapshotKey(tag.id));
  // `restored` counts the windows that actually opened — not `total`, the
  // number the snapshot asked for, which is set before any open is attempted.
  // A workspace whose saved windows all failed to open has nothing on screen
  // and needs the empty-group fallback below just like one never saved.
  const restored = !!restoreResult?.success && (restoreResult.restored ?? 0) > 0;

  if (!restored && !isDefault) {
    // No saved state, and this isn't the default — open one empty group.
    const homeUrl = `peek://spaces/home.html?spaceId=${encodeURIComponent(tag.id)}&spaceName=${encodeURIComponent(spaceName)}`;
    await api.window.open(homeUrl, emptySpaceWindowOptions(tag, spaceName, windowColor));
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
  }
}

/**
 * Save and close whatever workspace is active now — the default included.
 * Shared by entering a different workspace and by leaving to the default.
 *
 * The save is the same `saveSessionSnapshot` the app's own quit/autosave
 * uses, keyed by the outgoing workspace's snapshot key (see
 * `workspaceSnapshotKey()`).
 *
 * Closing mirrors quit the same way: quit never asks a window to prove it
 * belongs to the session before destroying it — it closes everything, because
 * the app's own design guarantees only one workspace's content windows are
 * ever open at a time. This sweep closes every live content window
 * (`WORKSPACE_CONTENT_ROLES`, same set `adoptOpenWindowsInto()` reads)
 * on that same guarantee, rather than asking `getWindowsInSpace()` which
 * windows carry this space's `mode` tag — a live tag can lag or be
 * overwritten by an unrelated feature (e.g. a tile clobbering the shared
 * `mode` context key), and a window that failed that check before was a
 * window that silently outlived every future switch. A window pinned across
 * every workspace (a global HUD window) is the one exception — it is not
 * scoped to the workspace being left, so it is left out of the sweep
 * (`docs/design/window-rules.md` "Persistent windows"). A workspace-pinned
 * window has no such claim and closes normally; it comes back — pinned,
 * badge intact — from the saved workspace row on re-entry (see
 * `enterWorkspace()`).
 */
// Entering a space may switch macOS to the desktop its windows were saved
// on. The mechanism is main-side: the workspace's snapshot key hands the
// main process the space's recorded per-window desktops; it picks the
// target and raises that DESKTOP's own persistent marker window
// (`main/desktop-marker-manager.ts`, one per visited desktop —
// docs/design/space-desktop-return-plan.md). Raises are reads-only safe —
// no window-server write exists anywhere on this path. The call resolves
// after the window manager has read the resulting switch (or its bounded
// wait passes), so the restore that follows opens the space's windows on
// the switched-to desktop — no fixed sleep.
//
// Diagnostics live in main.log, not here: `raise-requested … named=true` →
// `space-desktop-gate` (the target verdict: `raise`, `skip-no-target`, or
// `skip-no-marker` when the target desktop has not been visited since
// launch) → `raise-named-settled`.
async function switchToSpaceDesktop(spaceId) {
  try {
    await api.window.focus(null, { named: true, snapshotKey: workspaceSnapshotKey(spaceId) });
  } catch (err) {
    console.error('[ext:spaces] space-desktop-switch failed:', err);
  }
}

async function closeCurrentWorkspaceWindows() {
  if (!activeSpaceId) return;

  try {
    await api.session.saveWorkspaceSnapshot(workspaceSnapshotKey(activeSpaceId));
  } catch (err) {
    console.error('[ext:spaces] Failed to save workspace layout on close:', err);
  }

  // Hidden windows too: a hidden window of the workspace being left closes with
  // the rest, rather than surviving into the next workspace.
  const listResult = await api.window.list({ includeHidden: true });
  if (!listResult?.success || !Array.isArray(listResult.windows)) return;
  for (const w of listResult.windows) {
    if (!w?.id || !WORKSPACE_CONTENT_ROLES.has(w.params?.role)) continue;
    try {
      const pinResult = await api.context.get('pin', w.id);
      if (pinResult?.data?.value === 'global') continue;
      await api.window.close(w.id);
    } catch {
    }
  }
}

// Switches run one at a time. A second switch that started while the first was
// still entering its space would save the space still recorded as active
// (`activeSpaceId` only changes in `enterWorkspace()`) after the first had
// closed that space's windows, overwriting its saved windows with an empty
// list, and its close sweep would close the first switch's new window.
const runSwitchExclusively = createSerialRunner();

function openSpace(spaceName) {
  return runSwitchExclusively(() => openSpaceNow(spaceName));
}

async function openSpaceNow(spaceName) {
  if (!spaceName) return { success: false, error: 'Usage: switch space <name>' };
  await defaultSpaceReady;

  const tagName = toSpaceTagName(spaceName.trim());

  // Get or create the space tag
  const tagResult = await api.datastore.getOrCreateTag(tagName);
  if (!tagResult.success) return { success: false, error: 'Failed to get/create space tag' };
  const tag = tagResult.data.tag;

  // Resolve vivid color for spaces with default/grey color and persist it
  const vividColor = resolveVividColor(tag.color, tag.id, activeThemeId);
  if (vividColor !== tag.color) {
    tag.color = vividColor;
    await api.datastore.updateTagColor(tag.id, vividColor);
  }

  const displayName = getSpaceDisplayName(tag);

  // Entering a workspace saves the current workspace's windows — the
  // default included — and closes them (Goal, handoff.md).
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
    await closeCurrentWorkspaceWindows();
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
  // The Spaces UI's card click and the `switch space` command both come
  // through here, so this is where that churn is avoided.
  if (activeSpaceId && activeSpaceName &&
      toSpaceTagName(targetName.trim()) === toSpaceTagName(activeSpaceName)) {
    return { success: true, spaceId: activeSpaceId, spaceName: activeSpaceName, unchanged: true };
  }
  // Switching never creates the target; `create space` does.
  const missing = await missingSpaceError(targetName);
  if (missing) return { success: false, error: missing };
  // Entering any workspace already closes whichever one is active — switching
  // is just entering a different target (see openSpace()).
  return openSpace(targetName);
}

/**
 * Delete a space: its saved windows move into the default space and its tag
 * is deleted (items carrying the tag lose it but are not deleted). The
 * default space cannot be deleted. See `planDeleteSpace` for when the default
 * is reopened and when only the saved rows move. Runs in the same queue as
 * switches, since it may close and reopen windows the same way. Without
 * `confirmed`, nothing changes: the spaces page opens to ask first.
 */
function deleteSpace(spaceName, { confirmed = false } = {}) {
  return runSwitchExclusively(() => deleteSpaceNow(spaceName, confirmed));
}

async function deleteSpaceNow(spaceName, confirmed) {
  await defaultSpaceReady;
  let tags;
  try {
    tags = await listSpaceTags();
  } catch (err) {
    return { success: false, error: err.message };
  }
  const plan = planDeleteSpace({
    targetName: spaceName,
    tags,
    activeSpaceId,
    defaultSpaceId,
    defaultSpaceName: DEFAULT_SPACE_NAME,
  });
  if (plan.action === 'error') return { success: false, error: plan.error };

  if (!confirmed) {
    // Nothing is deleted without the question being answered, and only the
    // spaces page can ask it (see `deleteSpacePromptUrl`). That page sends the
    // request back with `confirmed: true`.
    const opened = await api.window.open(deleteSpacePromptUrl(plan.targetName), {
      role: 'workspace',
      width: 800,
      height: 600,
    });
    if (opened?.success === false) return { success: false, error: opened.error || 'Failed to open the spaces page' };
    return { success: true, spaceId: plan.targetId, spaceName: plan.targetName, prompted: true };
  }

  const defaultTagResult = await api.datastore.getOrCreateTag(toSpaceTagName(DEFAULT_SPACE_NAME));
  if (!defaultTagResult?.success) return { success: false, error: 'Failed to find the default space' };
  const defaultTag = defaultTagResult.data.tag;
  const defaultName = getSpaceDisplayName(defaultTag);
  // The default's windows carry the tag's own color (see enterWorkspace()).
  const targetSpace = { spaceId: defaultTag.id, spaceName: defaultName, color: defaultTag.color };
  const merge = () => api.session.mergeWorkspaceSnapshot(
    workspaceSnapshotKey(plan.targetId), DEFAULT_WORKSPACE_SNAPSHOT_KEY, targetSpace);

  let mergeResult;
  if (plan.action === 'reload-default') {
    // Same bracket as a switch (see openSpaceNow()): no ambient save may
    // rewrite a row between the save below and the default reopening.
    try {
      await api.session.beginWorkspaceSwitch();
    } catch (err) {
      console.error('[ext:spaces] Failed to mark the workspace switch as in progress:', err);
    }
    try {
      // Saves the active workspace's row first, so the merge reads the
      // windows that were on screen, then closes them.
      await closeCurrentWorkspaceWindows();
      try {
        mergeResult = await merge();
      } catch (err) {
        mergeResult = { success: false, error: err?.message || String(err) };
      }
      // Reopen the default either way: the active workspace's windows are
      // already closed, and a failed merge leaves the space and its row intact.
      await enterWorkspace(defaultTag, defaultName);
    } finally {
      try {
        await api.session.setActiveWorkspace(workspaceSnapshotKey(activeSpaceId));
      } catch (err) {
        console.error('[ext:spaces] Failed to report the active workspace:', err);
      }
    }
  } else {
    try {
      mergeResult = await merge();
    } catch (err) {
      mergeResult = { success: false, error: err?.message || String(err) };
    }
  }

  if (!mergeResult?.success) {
    return { success: false, error: `Failed to move the windows of "${plan.targetName}": ${mergeResult?.error || 'unknown error'}` };
  }

  const deleteResult = await api.datastore.deleteTag(plan.targetId);
  if (!deleteResult?.success) {
    return { success: false, error: `Failed to delete space "${plan.targetName}": ${deleteResult?.error || 'unknown error'}` };
  }
  refreshSpaceNameCommands();
  publishMembershipChanged(null, defaultTag.id);
  console.log(`[ext:spaces] Deleted space "${plan.targetName}", ${mergeResult.moved ?? 0} window(s) moved to the default space`);
  return { success: true, spaceId: plan.targetId, spaceName: plan.targetName, moved: mergeResult.moved ?? 0 };
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

/**
 * The space tags. A failed lookup throws rather than answering "no spaces",
 * so a caller never mistakes a datastore error for an empty space list.
 */
async function listSpaceTags() {
  const result = await api.datastore.getTagsByFrecency();
  if (!result?.success || !Array.isArray(result.data)) {
    throw new Error(`Space lookup failed: ${result?.error || 'no tag list returned'}`);
  }
  return result.data.filter((t) => t?.name && isSpaceTag(t.name));
}

/**
 * The error for a space name that matches no existing space (case-insensitive;
 * the default space always exists), or null when the space exists. A failed
 * lookup is reported as its own error rather than as a missing space.
 */
async function missingSpaceError(name) {
  const wanted = typeof name === 'string' ? name.trim().toLowerCase() : '';
  if (wanted === DEFAULT_SPACE_NAME.toLowerCase()) return null;
  let tags;
  try {
    tags = await listSpaceTags();
  } catch (err) {
    return err.message;
  }
  if (tags.some((t) => getSpaceDisplayName(t).trim().toLowerCase() === wanted)) return null;
  return `No space named "${name.trim()}"`;
}

/**
 * Create a space without switching to it. Reports `exists` when the name is
 * already taken (case-insensitive) or is the default space's.
 */
async function createSpace(name) {
  await defaultSpaceReady;
  let existing;
  try {
    existing = (await listSpaceTags()).map((t) => getSpaceDisplayName(t));
  } catch (err) {
    return { success: false, error: err.message };
  }
  const check = validateNewSpaceName(name, existing, DEFAULT_SPACE_NAME);
  if (!check.ok) return { success: false, error: check.error, exists: !!check.exists };

  const tagResult = await api.datastore.getOrCreateTag(toSpaceTagName(check.name));
  if (!tagResult.success) return { success: false, error: 'Failed to create space tag' };
  const tag = tagResult.data.tag;
  const vividColor = resolveVividColor(tag.color, tag.id, activeThemeId);
  if (vividColor !== tag.color) {
    tag.color = vividColor;
    await api.datastore.updateTagColor(tag.id, vividColor);
  }
  return { success: true, spaceId: tag.id, spaceName: getSpaceDisplayName(tag), created: true };
}

// Neither a re-tag nor a snapshot write publishes anything, so the Spaces
// window would keep showing stale window counts without this.
function publishMembershipChanged(windowId, spaceId) {
  api.pubsub.publish('spaces:membership-changed', { windowId, spaceId });
}

/**
 * Put the focused window in the named space. Only the active space is
 * supported (see `planMoveToSpace`); a workspace-pinned window is
 * re-associated, a globally pinned one is refused.
 */
async function moveToSpace(targetName) {
  await defaultSpaceReady;
  const windowId = await api.window.getFocusedVisibleWindowId();
  console.log('[ext:spaces] moveToSpace target:', JSON.stringify(targetName), 'focused window:', windowId, 'active space:', activeSpaceName);
  if (!windowId) return { success: false, error: 'No active window to move' };
  const pinResult = await api.context.get('pin', windowId);
  const plan = planMoveToSpace({
    targetName,
    activeSpaceName,
    pinScope: pinResult?.data?.value || null,
  });
  if (plan.action === 'error') return { success: false, error: plan.error };

  if (plan.action === 'move-to-inactive') {
    // Moving never creates the target space.
    const missing = await missingSpaceError(plan.targetName);
    if (missing) return { success: false, error: missing };
    const tagResult = await api.datastore.getOrCreateTag(toSpaceTagName(plan.targetName));
    if (!tagResult.success) return { success: false, error: 'Failed to get/create space tag' };
    const tag = tagResult.data.tag;
    const displayName = getSpaceDisplayName(tag);
    const color = tag.id === defaultSpaceId ? tag.color : resolveSpaceBorderColor(tag.color, tag.id);
    // Membership first: the snapshot save keeps only windows scoped to the target.
    await api.context.setMode('space', {
      windowId,
      metadata: { spaceId: tag.id, spaceName: displayName, color }
    });
    const added = await api.session.addWindowToWorkspaceSnapshot(workspaceSnapshotKey(tag.id), windowId);
    if (!added?.success) {
      // Put the window back where it was rather than leave it tagged for a space that never recorded it.
      await api.context.setMode('space', {
        windowId,
        metadata: { spaceId: activeSpaceId, spaceName: activeSpaceName, color: activeSpaceColor }
      });
      return { success: false, error: added?.error || 'Failed to add the window to the space' };
    }
    await api.window.close(windowId);
    publishMembershipChanged(windowId, tag.id);
    return { success: true, windowId, spaceId: tag.id, spaceName: displayName, closed: true };
  }

  await api.context.setMode('space', {
    windowId,
    metadata: { spaceId: activeSpaceId, spaceName: activeSpaceName, color: activeSpaceColor }
  });
  publishMembershipChanged(windowId, activeSpaceId);
  return { success: true, windowId, spaceId: activeSpaceId, spaceName: activeSpaceName };
}

// ===== Command Registration =====

// The existing spaces, as suggestion options for the commands that take a
// space name. Re-published on every tag:created / tag:deleted / tag:renamed.
// A failed lookup keeps the last known list; the next tag event retries.
let spaceNameSuggestions = [];

const SPACE_NAME_COMMANDS = [
  // pairPriority: typing a space name offers "switch space <name>" first, ahead of "move to space
  // <name>" whatever their pick history, because moving takes the window away from where it is.
  // `switch space` is the one command for entering a space: entering one closes the current
  // space's windows, so no command offers to open a second space alongside the current one.
  { name: 'switch space', description: 'Close current space and open another', param: 'Target space name', createCommand: 'create space', pairPriority: 1 },
  { name: 'move to space', description: 'Move the active window to a space', param: 'Target space name' },
  { name: 'delete space', description: 'Delete a space; its windows move to the default space', param: 'Space to delete' },
];

function publishSpaceNameCommands() {
  for (const cmd of SPACE_NAME_COMMANDS) {
    api.pubsub.publish('cmd:register', {
      name: cmd.name,
      description: cmd.description,
      source: 'spaces',
      scope: 'global',
      ...(cmd.pairPriority != null ? { pairPriority: cmd.pairPriority } : {}),
      params: [{
        name: 'name',
        type: 'enum',
        options: spaceNameSuggestions,
        required: true,
        description: cmd.param,
        ...(cmd.createCommand ? { createCommand: cmd.createCommand } : {}),
      }],
    });
  }
}

/**
 * Window count per space tag id, the way the Spaces page counts: live windows
 * of the active workspace, else the saved snapshot. A count that cannot be
 * read is left out, so that space shows no subtitle.
 */
async function countWindowsBySpace(tags) {
  const counts = {};
  let windowList = [];
  try {
    const r = await api.window.list();
    if (r?.success && Array.isArray(r.windows)) windowList = r.windows;
  } catch { /* leave empty */ }
  for (const tag of tags) {
    const isDefault = getSpaceDisplayName(tag) === DEFAULT_SPACE_NAME;
    const key = isDefault ? 'default' : tag.id;
    let tagged = [];
    try {
      const r = await api.context.getWindowsInSpace(tag.id);
      if (r?.success && Array.isArray(r.data)) tagged = r.data;
    } catch { /* leave empty */ }
    const live = liveSpaceWindowIds(tagged, windowList);
    let heldCount = 0;
    try {
      const r = await api.session.getHeldWindowCount(key, SPACES_CHROME_URL_PREFIXES);
      if (r?.success && typeof r.count === 'number') heldCount = r.count;
    } catch { /* none held */ }
    let snapshotCount = null;
    if (live.length === 0 && heldCount === 0) {
      try {
        const r = await api.session.getWorkspaceSnapshotWindowCount(key, SPACES_CHROME_URL_PREFIXES);
        if (r?.success && typeof r.count === 'number') snapshotCount = r.count;
      } catch { /* no snapshot */ }
    }
    const count = countSpaceWindows(live, snapshotCount, isDefault, heldCount);
    if (count != null) counts[tag.id] = count;
  }
  return counts;
}

// Refreshes requested while one is running collapse into one rerun, so a burst
// of window closes cannot publish stale counts after fresh ones.
let spaceNameRefreshRunning = false;
let spaceNameRefreshQueued = false;

async function refreshSpaceNameCommands() {
  if (spaceNameRefreshRunning) {
    spaceNameRefreshQueued = true;
    return;
  }
  spaceNameRefreshRunning = true;
  try {
    do {
      spaceNameRefreshQueued = false;
      try {
        const tags = await listSpaceTags();
        spaceNameSuggestions = spaceNameOptions(tags, await countWindowsBySpace(tags));
        publishSpaceNameCommands();
      } catch (err) {
        console.error('[ext:spaces] Failed to refresh space name suggestions:', err);
      }
    } while (spaceNameRefreshQueued);
  } finally {
    spaceNameRefreshRunning = false;
  }
}

const initCommands = () => {
  // "close space"
  api.pubsub.subscribe('cmd:execute:close space', async (msg) => {
    const result = await closeSpace();
    if (!result?.success) {
      // A command invocation has no result surface of its own, so a
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
    const result = await switchSpace(spaceNameFromCommandMessage(msg, 'switch space'));
    if (!result?.success) {
      console.warn('[ext:spaces] switch space refused:', result?.error);
    }
    if (msg.expectResult && msg.resultTopic) {
      api.pubsub.publish(msg.resultTopic, result || { success: true });
    }
  });

  // "create space <name>"
  api.pubsub.subscribe('cmd:execute:create space', async (msg) => {
    const result = await createSpace(spaceNameFromCommandMessage(msg, 'create space'));
    if (!result?.success) {
      console.warn('[ext:spaces] create space refused:', result?.error);
    }
    if (msg.expectResult && msg.resultTopic) {
      api.pubsub.publish(msg.resultTopic, result || { success: true });
    }
  });
  api.pubsub.publish('cmd:register', {
    name: 'create space',
    description: 'Create a space without switching to it',
    source: 'spaces',
    scope: 'global',
    params: [{ name: 'name', type: 'string', required: true, description: 'New space name' }]
  });

  // "move to space <name>"
  api.pubsub.subscribe('cmd:execute:move to space', async (msg) => {
    console.log('[ext:spaces] move to space received:', JSON.stringify({
      search: msg.search, params: msg.params, typed: msg.typed, value: msg.value, name: msg.name,
    }));
    let result;
    try {
      result = await moveToSpace(spaceNameFromCommandMessage(msg, 'move to space'));
    } catch (err) {
      console.error('[ext:spaces] move to space threw:', err?.stack || err);
      result = { success: false, error: String(err?.message || err) };
    }
    if (!result?.success) {
      console.warn('[ext:spaces] move to space refused:', result?.error);
    } else {
      console.log('[ext:spaces] move to space done');
    }
    if (msg.expectResult && msg.resultTopic) {
      api.pubsub.publish(msg.resultTopic, result || { success: true });
    }
  });

  // "delete space <name>" — from the command panel this opens the spaces page
  // to ask first; the spaces page sends `confirmed: true` once answered.
  api.pubsub.subscribe('cmd:execute:delete space', async (msg) => {
    const result = await deleteSpace(spaceNameFromCommandMessage(msg, 'delete space'), {
      confirmed: msg?.confirmed === true,
    });
    if (!result?.success) {
      console.warn('[ext:spaces] delete space refused:', result?.error);
    }
    if (msg.expectResult && msg.resultTopic) {
      api.pubsub.publish(msg.resultTopic, result || { success: true });
    }
  });

  // switch / move / delete take a space name; the panel suggests existing spaces.
  publishSpaceNameCommands();
  refreshSpaceNameCommands();

  // A command invocation has no result surface of its own, so a refused pin
  // would otherwise be indistinguishable from a click that never arrived.
  const finishPinCommand = (commandName, msg, result) => {
    if (!result?.success) {
      console.warn(`[ext:spaces] ${commandName} refused:`, result?.error);
    }
    if (msg.expectResult && msg.resultTopic) {
      api.pubsub.publish(msg.resultTopic, result || { success: true });
    }
  };

  // "pin to this workspace"
  api.pubsub.subscribe('cmd:execute:pin to this workspace', async (msg) => {
    finishPinCommand('pin to this workspace', msg, await pinWindow('workspace'));
  });
  api.pubsub.publish('cmd:register', {
    name: 'pin to this workspace',
    description: 'Keep the active window visible only while this workspace is active',
    source: 'spaces',
    scope: 'global',
  });

  // "pin across workspaces"
  api.pubsub.subscribe('cmd:execute:pin across workspaces', async (msg) => {
    finishPinCommand('pin across workspaces', msg, await pinWindow('global'));
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
    finishPinCommand('unpin window', msg, await unpinWindow());
  });
  api.pubsub.publish('cmd:register', {
    name: 'unpin window',
    description: 'Stop pinning the active window',
    source: 'spaces',
    scope: 'global',
  });

  console.log('[ext:spaces] Commands registered: close space, switch space, ' +
    'move to space, create space, delete space, pin to this workspace, pin across workspaces, unpin window');
};

const uninitCommands = () => {
  for (const name of [
    'close space', 'switch space', 'move to space', 'create space', 'delete space',
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

  // Fire-and-forget: resolves activeSpaceId to the default workspace, or to
  // the named workspace a boot restore reopened.
  // Every command handler above awaits this before touching activeSpaceId,
  // the same guard-the-body pattern lazy tiles use for a settings-load race
  // (see apps/desktop/CLAUDE.md "CRITICAL init-ordering rule for lazy tile
  // authors") — registration itself stays synchronous.
  defaultSpaceReady = bootstrapDefaultSpace();

  // Track the active theme, live, for the vivid-color fallback palette.
  // `activeThemeId` starts at its 'peek' default and is only ever read by
  // color resolution, so there's nothing here to gate behind an awaited
  // promise the way `defaultSpaceReady` is — a border shown before the
  // first getInfo() resolves just uses that default.
  api.theme.onChange?.((info) => {
    if (info?.kind === 'theme' && info.themeId) activeThemeId = info.themeId;
  });
  api.theme.getInfo().then((info) => {
    if (info?.themeId) activeThemeId = info.themeId;
  }).catch(() => {});

  // The space list changes from the Spaces page and from commands alike; the
  // tag events are the one signal both produce.
  api.pubsub.subscribe('tag:created', refreshSpaceNameCommands);
  api.pubsub.subscribe('tag:deleted', refreshSpaceNameCommands);
  api.pubsub.subscribe('tag:renamed', refreshSpaceNameCommands);
  // Window counts in the suggestions change with membership moves and closes.
  api.pubsub.subscribe('spaces:membership-changed', refreshSpaceNameCommands);

  // Subscribe to item:created for auto-tagging
  api.pubsub.subscribe('item:created', handleItemCreated);

  // Subscribe to tag:item-removed for mode reset
  api.pubsub.subscribe('tag:item-removed', handleTagRemoved);

  // Subscribe to focus events for border visibility
  api.pubsub.subscribe('window:focused', () => updateBorderVisibility());
  api.pubsub.subscribe('window:closed', () => {
    updateBorderVisibility();
    refreshSpaceNameCommands();
  });
  api.pubsub.subscribe('app:focus-changed', handleAppFocusChanged);
};

const uninit = () => {
  console.log('[ext:spaces] uninit');
  uninitCommands();
  cancelHideTimer();
  hideBorder();
};

// Seam for tests/unit/spaces-border-reshow.test.js.
export const __test = {
  showBorder,
  border,
  handleAppFocusChanged,
  cancelHideTimer,
  deleteSpace,
  setActiveSpaceId: (id) => { activeSpaceId = id; },
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
