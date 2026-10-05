const id = 'spaces';

const labels = {
  name: 'Spaces',
};

const schemas = {};

const storageKeys = {
  WORKSPACES: 'workspaces',
};

const defaults = {};

// Machine tag prefix for space identification
const SPACE_TAG_PREFIX = 'space:';

/**
 * Check if a tag name is a space machine tag
 */
const isSpaceTag = (name) => {
  return typeof name === 'string' && name.startsWith(SPACE_TAG_PREFIX);
};

/**
 * Get display name for a space tag
 * If metadata has displayName, use it. Otherwise strip the space: prefix.
 */
const getSpaceDisplayName = (tag) => {
  if (tag.metadata) {
    const meta = typeof tag.metadata === 'object' ? tag.metadata : (() => { try { return JSON.parse(tag.metadata); } catch { return {}; } })();
    if (meta.displayName) return meta.displayName;
  }
  if (isSpaceTag(tag.name)) {
    return tag.name.slice(SPACE_TAG_PREFIX.length);
  }
  return tag.name;
};

/**
 * Get the machine tag name for a space
 */
const toSpaceTagName = (name) => {
  if (name.startsWith(SPACE_TAG_PREFIX)) return name;
  return SPACE_TAG_PREFIX + name;
};

// Vivid colors for spaces (used for border overlay and UI dots) — one
// palette per named theme, lifted from that theme's own light-mode accent
// swatches (apps/desktop/themes/<id>/variables.css `base08`.."base0E"),
// rather than one fixed eight-color set baked in at build time. This module
// stays a plain ESM module with no import of renderer/theme code (see
// background.js/home.js, the two callers that can read the live active
// theme and pass its id in); a caller without theme access — or an
// unrecognized theme id — gets the 'peek' palette, matching
// main/protocol.ts's own default active theme.
const THEME_PALETTES = {
  peek: ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#5ac8fa', '#007aff', '#af52de'],
  basic: ['#d73a49', '#e36209', '#c08b00', '#22863a', '#1b7c83', '#0066cc', '#6f42c1'],
};

// Back-compat alias: the flat list this module exported before per-theme
// palettes existed.
const VIVID_SPACE_COLORS = THEME_PALETTES.peek;

/**
 * Convert a #rrggbb hex color to { h, s, l } (degrees, percent, percent).
 */
const hexToHsl = (hex) => {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16) / 255;
  const g = parseInt(clean.substring(2, 4), 16) / 255;
  const b = parseInt(clean.substring(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return { h, s: s * 100, l: l * 100 };
};

/**
 * Convert { h, s, l } (degrees, percent, percent) back to a #rrggbb hex color.
 */
const hslToHex = (h, s, l) => {
  const sat = s / 100;
  const light = l / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = light - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  const toHex = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
};

/**
 * Push a color toward the saturated/extreme end of its own hue. A theme's
 * accent swatch is tuned to sit quietly in ordinary UI chrome; a workspace
 * indicator meant to read at a glance from across the screen needs more than
 * that swatch used as-is.
 */
const pushVivid = (hex) => {
  const { h, s, l } = hexToHsl(hex);
  return hslToHex(h, Math.max(s, 85), Math.min(60, Math.max(45, l)));
};

/**
 * Resolve a vivid color for a space.
 * If the current color is grey/desaturated (#999, low chroma), pick a vivid
 * one deterministically based on spaceId hash from the given theme's
 * palette (default: 'peek'), pushed toward that palette's saturated end.
 */
const resolveVividColor = (color, spaceId, themeId = 'peek') => {
  if (color && color !== '#999' && color !== '#999999') {
    const hex = color.replace('#', '');
    if (hex.length >= 6) {
      const r = parseInt(hex.substring(0, 2), 16);
      const g = parseInt(hex.substring(2, 4), 16);
      const b = parseInt(hex.substring(4, 6), 16);
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      if (chroma > 40) return color;
    }
  }
  const palette = THEME_PALETTES[themeId] || THEME_PALETTES.peek;
  if (spaceId) {
    let hash = 0;
    for (let i = 0; i < spaceId.length; i++) {
      hash = ((hash << 5) - hash + spaceId.charCodeAt(i)) | 0;
    }
    return pushVivid(palette[Math.abs(hash) % palette.length]);
  }
  return pushVivid(palette[0]);
};

/**
 * Whether the screen border should be open. Opening the border window while
 * the app is in the background brings the app to the front: with the app
 * inactive, the last-focused window still reads as focused, so a close of the
 * border (on app resign) re-opened it a moment later, each time activating the
 * app again and stealing focus from whatever the user had switched to.
 */
const shouldShowBorder = (appFocused, focusedWindowInNamedSpace) =>
  appFocused === true && focusedWindowInNamedSpace === true;

/**
 * Whether a scheduled border hide should go ahead. An inactive app keeps the
 * border while a window of the active space is still visible (the app resigns
 * active on every desktop switch or window move); otherwise it hides.
 */
const shouldHideBorder = (appFocused, spaceWindowVisible) =>
  !(appFocused === false && spaceWindowVisible === true);

/**
 * Number of windows a space holds. Open windows win (the active workspace);
 * otherwise the saved workspace snapshot's window list. A space with no saved
 * snapshot holds none, so it counts 0. `null` only for the default workspace
 * with nothing open and no readable snapshot (tiles cannot read its snapshot
 * while another workspace is active), so the caller shows no count rather
 * than a wrong 0.
 */
const countSpaceWindows = (liveWindowIds, snapshotCount, isDefaultSpace = false) => {
  if (Array.isArray(liveWindowIds) && liveWindowIds.length > 0) return liveWindowIds.length;
  if (typeof snapshotCount === 'number') return snapshotCount;
  return isDefaultSpace ? null : 0;
};

/**
 * Index of the card to select when the window opens: the active space's, else
 * the first. `spaceIds` is the rendered card order.
 */
const initialSelectedIndex = (spaceIds, activeSpaceId) => {
  if (activeSpaceId == null) return 0;
  const i = spaceIds.findIndex((id) => String(id) === String(activeSpaceId));
  return i >= 0 ? i : 0;
};

const formatWindowCount = (count) => {
  if (count == null) return '';
  return `${count} ${count === 1 ? 'window' : 'windows'}`;
};

/**
 * What `move to space` does with the focused window. The active space only needs
 * its membership set; an inactive one also needs the window added to its saved
 * snapshot and closed, so it reappears when that space is next opened. A
 * globally pinned window belongs to every space already, so it is left alone.
 */
const planMoveToSpace = ({ targetName, activeSpaceName, pinScope }) => {
  const target = typeof targetName === 'string' ? targetName.trim() : '';
  if (!target) return { action: 'error', error: 'Usage: move to space <name>' };
  if (pinScope === 'global') {
    return { action: 'error', error: 'This window is pinned across every workspace; unpin it first to move it' };
  }
  if (!activeSpaceName || toSpaceTagName(target) !== toSpaceTagName(activeSpaceName)) {
    return { action: 'move-to-inactive', targetName: target };
  }
  return { action: 'set-membership' };
};

/**
 * Check a name for a new space. `existingNames` are the display names of the
 * spaces that exist; the default space's name is always taken.
 */
const validateNewSpaceName = (name, existingNames, defaultName) => {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) return { ok: false, error: 'Usage: create space <name>' };
  const lower = trimmed.toLowerCase();
  const taken = [defaultName, ...(existingNames || [])].some(
    (n) => typeof n === 'string' && n.trim().toLowerCase() === lower
  );
  if (taken) return { ok: false, exists: true, error: `Space "${trimmed}" already exists` };
  return { ok: true, name: trimmed };
};

/**
 * Command-panel suggestions for a space-name argument: one entry per space tag,
 * shown by display name (no internal tag prefix), sorted by name.
 */
const spaceNameOptions = (tags) =>
  (Array.isArray(tags) ? tags : [])
    .filter((t) => t && isSpaceTag(t.name))
    .map((t) => getSpaceDisplayName(t))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ value: name, title: name }));

/**
 * The space name a command message carries: the search text, else the argument
 * words, else the typed text with the command name removed. Empty when none.
 */
const spaceNameFromCommandMessage = (msg, commandName) => {
  if (!msg) return '';
  const fromSearch = typeof msg.search === 'string' ? msg.search.trim() : '';
  if (fromSearch) return fromSearch;
  const fromParams = Array.isArray(msg.params) ? msg.params.join(' ').trim() : '';
  if (fromParams) return fromParams;
  const lowerName = commandName.toLowerCase();
  for (const text of [msg.typed, msg.value]) {
    if (typeof text !== 'string') continue;
    const trimmed = text.trim();
    if (trimmed.toLowerCase().startsWith(lowerName)) {
      const rest = trimmed.slice(commandName.length).trim();
      if (rest) return rest;
    }
  }
  return '';
};

/**
 * Options for the one window opened when a space with no saved windows is
 * entered. It answers a deliberate switch, so it is `regular`: not registered
 * as a transient window (which the kernel dismisses once the app comes
 * forward, since the close sweep before it leaves the app inactive) and it
 * brings the app forward with user intent.
 */
const emptySpaceWindowOptions = (tag, spaceName, color) => ({
  role: 'workspace',
  regular: true,
  width: 1024,
  height: 768,
  spaceMode: { spaceId: tag.id, spaceName, color },
});

/**
 * Returns a function that runs the async callbacks it is given one at a time,
 * in call order. A failure rejects only its own call; later calls still run.
 * Used so two switch commands arriving together do not interleave.
 */
const createSerialRunner = () => {
  let tail = Promise.resolve();
  return (fn) => {
    const result = tail.then(fn);
    tail = result.catch(() => {});
    return result;
  };
};

export {
  createSerialRunner,
  emptySpaceWindowOptions,
  spaceNameFromCommandMessage,
  validateNewSpaceName,
  spaceNameOptions,
  planMoveToSpace,
  shouldShowBorder,
  shouldHideBorder,
  countSpaceWindows,
  initialSelectedIndex,
  formatWindowCount,
  id,
  labels,
  schemas,
  storageKeys,
  defaults,
  SPACE_TAG_PREFIX,
  isSpaceTag,
  getSpaceDisplayName,
  toSpaceTagName,
  VIVID_SPACE_COLORS,
  THEME_PALETTES,
  pushVivid,
  resolveVividColor,
};
