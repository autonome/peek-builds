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
};
