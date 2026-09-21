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
    if (modeResult.success && modeResult.data?.value === 'space' && modeResult.data.metadata?.spaceId) {
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

// ===== Session Management =====

async function openSpace(spaceName) {
  if (!spaceName) return { success: false, error: 'Usage: open space <name>' };

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

  activeSpaceId = tag.id;
  activeSpaceName = getSpaceDisplayName(tag);
  activeSpaceColor = tag.color;

  // Check for saved workspace state.
  //
  // The row lives under featureId `space-workspaces`, NOT under this tile's own
  // `spaces` namespace: `session.ts saveSpaceWorkspaces()` is the sole writer of
  // `workspace:<spaceId>` and it hardcodes that featureId. Reading it with
  // `api.settings.get` scoped the query to `WHERE featureId = 'spaces'`, where
  // nothing is ever written, so this always came back null and every space fell
  // through to the home-UI branch below. Declared in manifest.json as
  // `settings.readForeign: ["space-workspaces"]`.
  const wsResult = await api.settings.getExtKey('space-workspaces', 'workspace:' + tag.id);
  let restored = false;
  if (!wsResult.error && wsResult.value) {
    const snapshot = typeof wsResult.value === 'string' ? JSON.parse(wsResult.value) : wsResult.value;
    if (snapshot.version === 1 && Array.isArray(snapshot.windows) && snapshot.windows.length > 0) {
      // Restore saved windows
      for (const w of snapshot.windows) {
        if (!w.url) continue;
        const result = await api.window.open(w.url, {
          role: 'content',
          spaceMode: { spaceId: tag.id, spaceName: activeSpaceName, color: tag.color },
          // A workspace-pinned window (w.pinned, see session.ts
          // serializeSpaceWorkspaces) restores at the Pinned layer directly,
          // and carries its pin scope from the moment it opens (ipc.ts
          // windowOpenHandler's `pinScope` option, set before loadURL, the
          // same way `spaceMode` is) — layer is set at open time
          // (window-kernel.ts), so restoring it unpinned and pinning it
          // after the fact would mean a second close+reopen right after
          // this one.
          ...(w.pinned ? { alwaysOnTop: true, pinScope: 'workspace' } : {}),
          ...(w.bounds || {}),
        });
        if (result?.id) {
          await api.context.setMode('space', {
            windowId: result.id,
            metadata: { spaceId: tag.id, spaceName: activeSpaceName, color: tag.color }
          });
        }
      }
      restored = true;
    }
  }

  if (!restored) {
    // No saved state — open spaces home UI
    const homeUrl = `peek://spaces/home.html?spaceId=${encodeURIComponent(tag.id)}&spaceName=${encodeURIComponent(activeSpaceName)}`;
    await api.window.open(homeUrl, {
      role: 'workspace',
      width: 1024,
      height: 768,
      spaceMode: { spaceId: tag.id, spaceName: activeSpaceName, color: tag.color },
    });
  }

  // Show border
  const borderColor = resolveSpaceBorderColor(tag.color, tag.id);
  showBorder(borderColor, activeSpaceName);

  console.log(`[ext:spaces] Opened space "${activeSpaceName}"`);
  return { success: true, spaceId: tag.id, spaceName: activeSpaceName };
}

async function closeSpace() {
  if (!activeSpaceId) {
    return { success: false, error: 'No active space to close' };
  }

  // Save workspace layouts
  try {
    if (api.session?.saveSpaceWorkspaces) {
      await api.session.saveSpaceWorkspaces();
    }
  } catch (err) {
    console.error('[ext:spaces] Failed to save workspace layouts on close:', err);
  }

  // Get all windows in this space and close them — except one pinned across
  // every workspace (a global HUD window): it is not scoped to this space in
  // the first place, so leaving this workspace must not sweep it. A
  // workspace-pinned window has no such claim and closes normally; it comes
  // back — pinned, badge intact — from the saved workspace row on re-entry
  // (see openSpace()).
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

  // Hide border
  cancelHideTimer();
  hideBorder();

  const closedName = activeSpaceName;
  activeSpaceId = null;
  activeSpaceName = null;
  activeSpaceColor = null;

  console.log(`[ext:spaces] Closed space "${closedName}"`);
  return { success: true };
}

async function switchSpace(targetName) {
  if (!targetName) return { success: false, error: 'Usage: switch space <name>' };
  await closeSpace();
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
  if (scope === 'workspace' && !activeSpaceId) {
    return { success: false, error: 'No active workspace — open a space first' };
  }
  const windowId = await api.window.getFocusedVisibleWindowId();
  if (!windowId) return { success: false, error: 'No active window to pin' };
  return setPinState(windowId, scope);
}

async function unpinWindow() {
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
    description: 'Save window state and close all space windows',
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
