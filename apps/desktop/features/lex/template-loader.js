/**
 * Template Loader — Discovers, loads, and manages template packs for Lexicon Studio.
 *
 * Template packs live in `extensions/lex/templates/<packId>/` and contain:
 *   - template.json  — metadata (id, name, description, targets, etc.)
 *   - render.js      — rendering logic (renderList, renderDetail, renderEdit)
 *   - styles.css     — scoped styles for the template
 *
 * Usage:
 *   import { loadTemplates, getTemplate, getActiveTemplate, setActiveTemplate, getAvailableTemplates } from './template-loader.js';
 *   await loadTemplates();
 *   const tpl = getActiveTemplate();
 *   const html = tpl.renderDetail(record, context);
 */

// ============================================================================
// State
// ============================================================================

/** @type {Map<string, TemplatePack>} Loaded template packs keyed by id */
const templates = new Map();

/** @type {string|null} Currently active template id */
let activeTemplateId = null;

/** @type {string|null} Default template id (the one marked "default": true) */
let defaultTemplateId = null;

/** @type {Set<string>} CSS stylesheets that have been injected */
const injectedStyles = new Set();

const ACTIVE_TEMPLATE_KEY = 'activeTemplatePack';

// ============================================================================
// Known template packs
// ============================================================================

/**
 * Static registry of built-in template packs.
 * Each entry maps a pack id to its base URL path.
 * New packs are added here as they are created.
 */
const BUILT_IN_PACKS = [
  'raw',
];

// ============================================================================
// Loading
// ============================================================================

/**
 * Load all available template packs.
 * Discovers built-in packs and loads their metadata and render modules.
 *
 * @returns {Promise<void>}
 */
export async function loadTemplates() {
  const loadPromises = BUILT_IN_PACKS.map(packId => loadPack(packId));
  const results = await Promise.allSettled(loadPromises);

  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn('[template-loader] Failed to load a template pack:', result.reason);
    }
  }

  // Restore the user's active template preference
  await restoreActiveTemplate();

  // If no active template set, fall back to the default
  if (!activeTemplateId || !templates.has(activeTemplateId)) {
    activeTemplateId = defaultTemplateId || BUILT_IN_PACKS[0];
  }

  // Inject the active template's styles
  const active = templates.get(activeTemplateId);
  if (active) {
    injectStyles(active);
  }

  console.log(`[template-loader] Loaded ${templates.size} template pack(s), active: ${activeTemplateId}`);
}

/**
 * Load a single template pack by id.
 *
 * @param {string} packId - The pack directory name
 * @returns {Promise<void>}
 */
async function loadPack(packId) {
  const basePath = `./templates/${packId}`;

  // Load metadata
  const metaResponse = await fetch(`${basePath}/template.json`);
  if (!metaResponse.ok) {
    throw new Error(`Failed to load template.json for pack "${packId}": ${metaResponse.status}`);
  }
  const metadata = await metaResponse.json();

  // Load render module
  const renderModule = await import(`${basePath}/render.js`);

  // Load styles (as text, we inject it lazily)
  let stylesText = '';
  try {
    const stylesResponse = await fetch(`${basePath}/styles.css`);
    if (stylesResponse.ok) {
      stylesText = await stylesResponse.text();
    }
  } catch {
    // Styles are optional
  }

  const pack = {
    id: metadata.id || packId,
    metadata,
    renderList: renderModule.renderList,
    renderDetail: renderModule.renderDetail,
    renderEdit: renderModule.renderEdit,
    stylesText,
    basePath,
  };

  templates.set(pack.id, pack);

  if (metadata.default) {
    defaultTemplateId = pack.id;
  }
}

// ============================================================================
// Style injection
// ============================================================================

/**
 * Inject a template pack's styles into the document.
 *
 * @param {object} pack - The template pack
 */
function injectStyles(pack) {
  if (!pack.stylesText || injectedStyles.has(pack.id)) return;

  const style = document.createElement('style');
  style.dataset.templatePack = pack.id;
  style.textContent = pack.stylesText;
  document.head.appendChild(style);
  injectedStyles.add(pack.id);
}

/**
 * Remove a template pack's styles from the document.
 *
 * @param {string} packId - The template pack id
 */
function removeStyles(packId) {
  const el = document.querySelector(`style[data-template-pack="${packId}"]`);
  if (el) {
    el.remove();
    injectedStyles.delete(packId);
  }
}

// ============================================================================
// Active template management
// ============================================================================

/**
 * Get the currently active template pack.
 *
 * @returns {object|null} The active template pack, or null if none loaded
 */
export function getActiveTemplate() {
  return templates.get(activeTemplateId) || null;
}

/**
 * Get the active template id.
 *
 * @returns {string|null}
 */
export function getActiveTemplateId() {
  return activeTemplateId;
}

/**
 * Set the active template pack by id.
 * Injects the new template's styles and persists the preference.
 *
 * @param {string} packId - The template pack id to activate
 * @returns {boolean} True if the template was found and activated
 */
export function setActiveTemplate(packId) {
  const pack = templates.get(packId);
  if (!pack) {
    console.warn(`[template-loader] Template pack "${packId}" not found`);
    return false;
  }

  activeTemplateId = packId;
  injectStyles(pack);
  persistActiveTemplate(packId);
  return true;
}

/**
 * Get a specific template pack by id.
 *
 * @param {string} packId - The template pack id
 * @returns {object|null}
 */
export function getTemplate(packId) {
  return templates.get(packId) || null;
}

/**
 * Get all available template packs as an array.
 *
 * @returns {Array<object>} Array of { id, metadata } objects
 */
export function getAvailableTemplates() {
  return Array.from(templates.values()).map(pack => ({
    id: pack.id,
    metadata: pack.metadata,
  }));
}

// ============================================================================
// Persistence
// ============================================================================

/**
 * Persist the active template preference to extension settings.
 *
 * @param {string} packId
 */
async function persistActiveTemplate(packId) {
  try {
    if (window.app?.settings) {
      await window.app.settings.set(ACTIVE_TEMPLATE_KEY, packId);
    }
  } catch (err) {
    console.warn('[template-loader] Failed to persist active template:', err);
  }
}

/**
 * Restore the active template preference from extension settings.
 */
async function restoreActiveTemplate() {
  try {
    if (window.app?.settings) {
      const result = await window.app.settings.get(ACTIVE_TEMPLATE_KEY);
      if (result && !result.error && typeof result.value === 'string' && templates.has(result.value)) {
        activeTemplateId = result.value;
      }
    }
  } catch {
    // Ignore — will fall back to default
  }
}
