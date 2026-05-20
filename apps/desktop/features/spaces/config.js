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

// Vivid colors for spaces (used for border overlay and UI dots)
const VIVID_SPACE_COLORS = [
  '#ff3b30', '#ff9500', '#34c759', '#007aff',
  '#af52de', '#5ac8fa', '#ff2d55', '#ff9f0a',
];

/**
 * Resolve a vivid color for a space.
 * If the current color is grey/desaturated (#999, low chroma), pick a vivid one
 * deterministically based on spaceId hash.
 */
const resolveVividColor = (color, spaceId) => {
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
  if (spaceId) {
    let hash = 0;
    for (let i = 0; i < spaceId.length; i++) {
      hash = ((hash << 5) - hash + spaceId.charCodeAt(i)) | 0;
    }
    return VIVID_SPACE_COLORS[Math.abs(hash) % VIVID_SPACE_COLORS.length];
  }
  return '#007aff';
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
  resolveVividColor,
};
