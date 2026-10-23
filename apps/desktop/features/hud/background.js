/**
 * HUD feature background: registers the `hud` command.
 *
 * The HUD is an ordinary window pinned across workspaces
 * (docs/design/window-rules.md "Persistent windows"). The `key` makes a
 * second run focus the open HUD instead of opening another. Pinning uses
 * the same two steps as the "pin across workspaces" command
 * (features/spaces/background.js setPinState()): move the window to the
 * pinned band, then record scope in the 'pin' context key, which the badge
 * and closeSpace() read. No Cmd+H shortcut: macOS reserves it for Hide.
 */

import { HUD_BOUNDS_KEY, chooseHudBounds } from './hud-geometry.js';

const id = 'hud';
const api = window.app;
const HUD_URL = 'peek://hud/hud.html';

const toggleHud = async () => {
  // Toggle: running the command while the HUD is on screen closes it.
  const existing = await api.window.findByUrl(HUD_URL);
  if (existing?.success && existing.id != null) {
    api.window.close(existing.id, { force: true });
    return { success: true, closed: true };
  }
  // Saved size and position (written by hud.js), else the defaults.
  // localStorage is per origin, so this is the peek://hud origin's copy.
  let savedBounds = null;
  try { savedBounds = localStorage.getItem(HUD_BOUNDS_KEY); } catch { /* storage unavailable */ }
  const bounds = chooseHudBounds(savedBounds);
  const opened = await api.window.open(HUD_URL, {
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    key: 'hud-stats',
    title: 'Peek HUD',
  });
  const windowId = opened?.id;
  if (!opened?.success || windowId == null) {
    return { success: false, error: opened?.error || 'Failed to open the HUD window' };
  }
  const pinned = await api.window.setPinned(windowId, true);
  if (!pinned?.success) {
    return { success: false, error: pinned?.error || 'Failed to pin the HUD window', windowId };
  }
  await api.context.set('pin', 'global', {}, windowId);
  return { success: true, windowId, scope: 'global' };
};

const extension = {
  id,
  init: async () => {
    api.commands.register({
      name: 'hud',
      description: 'Show or hide Peek memory and stats, pinned across workspaces',
      execute: toggleHud,
    });
  },
  uninit: () => {},
};

export default extension;
