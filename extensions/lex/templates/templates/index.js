/**
 * Template Pack Registry
 *
 * Manages available template packs and provides the active pack.
 * The "raw" pack is always available as the default.
 */

import * as rawPack from './raw/index.js';

const packs = new Map();

// Register the built-in raw pack
packs.set('raw', rawPack);

/**
 * Get a template pack by name.
 * @param {string} name
 * @returns {Object|null} — { AppTemplate, ListTemplate, LexiconTemplate, FormTemplate, metadata }
 */
export function getTemplatePack(name) {
  return packs.get(name) || null;
}

/**
 * Get the default template pack.
 * @returns {Object}
 */
export function getDefaultPack() {
  return rawPack;
}

/**
 * Register a new template pack.
 * @param {string} name
 * @param {Object} pack — { AppTemplate, ListTemplate, LexiconTemplate, FormTemplate, metadata }
 */
export function registerTemplatePack(name, pack) {
  packs.set(name, pack);
}

/**
 * List all registered template pack names.
 * @returns {string[]}
 */
export function listTemplatePacks() {
  return [...packs.keys()];
}

/**
 * Get metadata for all registered packs.
 * @returns {Array<{name: string, description: string, version: string}>}
 */
export function listTemplatePackMetadata() {
  return [...packs.entries()].map(([name, pack]) => ({
    name,
    ...(pack.metadata || {}),
  }));
}
