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

export {
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
