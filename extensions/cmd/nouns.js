/**
 * Noun Registration API — portable, zero platform dependencies
 *
 * Extensions import this to declare what data they manage.
 * Uses only window.app pubsub (works on Electron, Tauri, browser extension).
 *
 * Usage:
 *   import { registerNoun, unregisterNoun } from 'peek://ext/cmd/nouns.js';
 */

const api = window.app;

// Local handler storage (per-window, same as window._cmdHandlers pattern)
const nounHandlers = {};

// Batching (same debounce pattern as preload command batching)
let pending = [];
let timer = null;
const BATCH_DELAY = 16;

function flush() {
  if (!pending.length) return;
  const batch = pending;
  pending = [];
  timer = null;
  api.publish('noun:register-batch', { nouns: batch }, api.scopes.GLOBAL);
}

/**
 * Register a noun with the command system
 *
 * @param {Object} nounDef
 * @param {string} nounDef.name - Plural name (e.g. 'groups')
 * @param {string} nounDef.singular - Singular name (e.g. 'group')
 * @param {string} [nounDef.description] - Human description
 * @param {string} [nounDef.source] - Source identifier
 * @param {Function} [nounDef.query] - async ({search, params}) => items
 * @param {Function} [nounDef.browse] - async () => open UI
 * @param {Function} [nounDef.open] - async ({search}) => open instance
 * @param {Function} [nounDef.create] - async ({search, params}) => result
 * @param {string} [nounDef.produces] - MIME type for chaining
 * @param {Array} [nounDef.params] - Parameter definitions
 * @param {Array} [nounDef.modes] - Required major modes
 * @param {boolean} [nounDef.skipBare] - If true, don't generate bare "{name}" command
 */
export function registerNoun(nounDef) {
  if (!nounDef.name || !nounDef.singular) {
    console.error('[nouns] name and singular are required');
    return;
  }

  nounHandlers[nounDef.name] = {};
  const capabilities = ['query', 'browse', 'open', 'create'];

  for (const cap of capabilities) {
    if (typeof nounDef[cap] !== 'function') continue;
    nounHandlers[nounDef.name][cap] = nounDef[cap];

    // Subscribe to capability execution via platform-agnostic pubsub
    api.subscribe(`noun:${cap}:${nounDef.name}`, async (msg) => {
      const handler = nounHandlers[nounDef.name]?.[cap];
      if (!handler) return;
      try {
        const result = await handler(msg);
        if (msg.expectResult && msg.resultTopic) {
          api.publish(msg.resultTopic, result || { success: true }, api.scopes.GLOBAL);
        }
      } catch (err) {
        console.error('[nouns] Error in', cap, nounDef.name, err);
        if (msg.expectResult && msg.resultTopic) {
          api.publish(msg.resultTopic, { error: err.message }, api.scopes.GLOBAL);
        }
      }
    }, api.scopes.GLOBAL);
  }

  // Queue metadata (booleans, not functions) for batched publish
  pending.push({
    name: nounDef.name,
    singular: nounDef.singular,
    description: nounDef.description || '',
    source: nounDef.source || '',
    hasQuery: typeof nounDef.query === 'function',
    hasBrowse: typeof nounDef.browse === 'function',
    hasOpen: typeof nounDef.open === 'function',
    hasCreate: typeof nounDef.create === 'function',
    produces: nounDef.produces || null,
    params: nounDef.params || [],
    modes: nounDef.modes || [],
    skipBare: nounDef.skipBare || false,
  });

  clearTimeout(timer);
  timer = setTimeout(flush, BATCH_DELAY);
}

/**
 * Unregister a noun and its generated commands
 * @param {string} name - The plural noun name
 */
export function unregisterNoun(name) {
  delete nounHandlers[name];
  api.publish('noun:unregister', { name }, api.scopes.GLOBAL);
}

/**
 * Flush pending noun registrations immediately
 */
export function flushNouns() { flush(); }
