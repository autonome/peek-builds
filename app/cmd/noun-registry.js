/**
 * Noun Registry — pure command generation from noun definitions
 *
 * No side effects, no imports. Used by background.js to convert noun metadata
 * (with boolean capability flags) into standard command metadata objects.
 */

/**
 * Validate a noun definition has required fields and at least one capability
 * @param {Object} def - Noun definition with boolean capability flags
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateNounDef(def) {
  if (!def.name) return { valid: false, error: 'name is required' };
  if (!def.singular) return { valid: false, error: 'singular is required' };
  if (!def.hasQuery && !def.hasBrowse && !def.hasOpen && !def.hasCreate) {
    return { valid: false, error: 'at least one capability is required' };
  }
  return { valid: true };
}

/**
 * Generate command metadata objects from a noun definition
 *
 * @param {Object} noun - Noun metadata (boolean flags, not functions):
 *   - name: string (plural, e.g. 'groups')
 *   - singular: string (e.g. 'group')
 *   - description: string
 *   - source: string
 *   - hasQuery, hasBrowse, hasOpen, hasCreate: boolean
 *   - produces: string|null
 *   - params: Array
 *   - modes: Array
 *   - skipBare: boolean
 * @returns {Array<Object>} Command metadata objects
 */
export function generateCommandsFromNoun(noun) {
  const commands = [];
  const base = {
    source: noun.source || '',
    params: noun.params || [],
    modes: noun.modes || [],
  };

  // Bare noun command: "{name}" (e.g. "groups")
  // Uses browse if available, else query
  if (!noun.skipBare && (noun.hasBrowse || noun.hasQuery)) {
    const capability = noun.hasBrowse ? 'browse' : 'query';
    commands.push({
      ...base,
      name: noun.name,
      description: noun.description || `${noun.hasBrowse ? 'Open' : 'List'} ${noun.name}`,
      accepts: [],
      produces: capability === 'query' ? (noun.produces ? [noun.produces] : ['application/json']) : [],
      _nounName: noun.name,
      _nounCapability: capability,
    });
  }

  // "list {name}" — requires query
  if (noun.hasQuery) {
    commands.push({
      ...base,
      name: `list ${noun.name}`,
      description: `List ${noun.name}`,
      accepts: [],
      produces: noun.produces ? [noun.produces] : ['application/json'],
      _nounName: noun.name,
      _nounCapability: 'query',
    });
  }

  // "open {name}" — requires browse
  if (noun.hasBrowse) {
    commands.push({
      ...base,
      name: `open ${noun.name}`,
      description: `Open ${noun.name}`,
      accepts: [],
      produces: [],
      _nounName: noun.name,
      _nounCapability: 'browse',
    });
  }

  // "open {singular}" — requires query AND open
  if (noun.hasQuery && noun.hasOpen) {
    commands.push({
      ...base,
      name: `open ${noun.singular}`,
      description: `Open a ${noun.singular} by name`,
      accepts: [],
      produces: [],
      _nounName: noun.name,
      _nounCapability: 'open',
    });
  }

  // "new {singular}" — requires create
  if (noun.hasCreate) {
    commands.push({
      ...base,
      name: `new ${noun.singular}`,
      description: `Create a new ${noun.singular}`,
      accepts: [],
      produces: noun.produces ? [noun.produces] : [],
      _nounName: noun.name,
      _nounCapability: 'create',
    });
  }

  return commands;
}
