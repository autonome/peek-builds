/**
 * Shared PubSub Engine
 *
 * Platform-agnostic topic-based publish/subscribe with scope filtering.
 * Works in any web context (Electron renderer, Tauri webview, plain browser).
 *
 * Cross-window messaging uses BroadcastChannel API (supported in Electron,
 * Tauri webviews, and modern browsers). Each window runs its own PubSub
 * instance; BroadcastChannel synchronizes GLOBAL-scoped messages across windows.
 *
 * Scope semantics:
 *   SYSTEM (1) - Privileged; only system-address subscribers receive
 *   SELF (2)   - Same pseudo-host only (e.g., peek://app/* to peek://app/*)
 *   GLOBAL (3) - All subscribers in all windows
 *
 * @example
 *   import { createPubSub, scopes } from './pubsub.js';
 *   const ps = createPubSub({ source: window.location.href });
 *   ps.subscribe('item:created', (data) => console.log(data));
 *   ps.publish('item:created', { id: 42 }, scopes.GLOBAL);
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const scopes = Object.freeze({
  SYSTEM: 1,
  SELF: 2,
  GLOBAL: 3,
});

const SYSTEM_ADDRESS = 'peek://system/';
const BROADCAST_CHANNEL_NAME = 'peek:pubsub';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract pseudo-host from a peek:// URL.
 * e.g., 'peek://app/foo.html' -> 'app'
 */
function getPseudoHost(str) {
  return (str || '').split('/')[2] || '';
}

/**
 * Check if a subscriber should receive a message based on scope.
 *
 * @param {string} pubSource  - Publisher's source address
 * @param {string} subSource  - Subscriber's source address
 * @param {number} scope      - One of scopes.SYSTEM / SELF / GLOBAL
 * @returns {boolean}
 */
function scopeCheck(pubSource, subSource, scope) {
  // System address receives everything
  if (subSource === SYSTEM_ADDRESS) {
    return true;
  }
  // GLOBAL scope sends to everyone
  if (scope === scopes.GLOBAL) {
    return true;
  }
  // SELF scope only sends to same pseudo-host
  if (getPseudoHost(subSource) === getPseudoHost(pubSource)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// PubSub class
// ---------------------------------------------------------------------------

class PubSub {
  /**
   * @param {object}  opts
   * @param {string}  opts.source          - This window's source address (e.g., window.location.href)
   * @param {boolean} [opts.broadcast=true] - Enable BroadcastChannel for cross-window GLOBAL messages
   * @param {function} [opts.onBroadcast]  - Optional hook called when a message is broadcast to other windows
   */
  constructor(opts = {}) {
    this.source = opts.source || '';
    /** @type {Map<string, Map<string, Function>>} topic -> Map<subscriberSource, callback> */
    this._topics = new Map();
    /** @type {BroadcastChannel|null} */
    this._channel = null;
    /** @type {function|null} */
    this._extensionBroadcaster = null;

    if (opts.broadcast !== false && typeof BroadcastChannel !== 'undefined') {
      this._initBroadcastChannel();
    }
  }

  // -----------------------------------------------------------------------
  // BroadcastChannel (cross-window)
  // -----------------------------------------------------------------------

  _initBroadcastChannel() {
    try {
      this._channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
      this._channel.onmessage = (event) => {
        const { topic, data, source, scope } = event.data || {};
        if (!topic) return;
        // Deliver to local subscribers (the sender's window already delivered locally)
        this._deliverLocal(source || '', scope || scopes.GLOBAL, topic, data);
      };
    } catch {
      // BroadcastChannel not available — single-window mode
      this._channel = null;
    }
  }

  // -----------------------------------------------------------------------
  // Core pub/sub
  // -----------------------------------------------------------------------

  /**
   * Deliver a message to local (in-window) subscribers only.
   */
  _deliverLocal(pubSource, scope, topic, data) {
    const subscribers = this._topics.get(topic);
    if (!subscribers) return;
    for (const [subSource, cb] of subscribers) {
      if (scopeCheck(pubSource, subSource, scope)) {
        try {
          cb(data);
        } catch (err) {
          console.error(`[PubSub] Error in subscriber for '${topic}':`, err);
        }
      }
    }
  }

  /**
   * Publish a message to a topic.
   *
   * @param {string} topic - Topic name
   * @param {*}      data  - Message payload
   * @param {number} [scope=scopes.SELF] - Scope (SYSTEM, SELF, or GLOBAL)
   * @param {string} [source] - Override source address (defaults to instance source)
   */
  publish(topic, data, scope = scopes.SELF, source) {
    const pubSource = source || this.source;

    // Deliver to local subscribers
    this._deliverLocal(pubSource, scope, topic, data);

    // Broadcast GLOBAL messages to other windows via BroadcastChannel
    if (scope === scopes.GLOBAL && this._channel) {
      this._channel.postMessage({ topic, data, source: pubSource, scope });
    }

    // Route to extension broadcaster if set (Electron main-process compatibility)
    if (scope === scopes.GLOBAL && this._extensionBroadcaster) {
      this._extensionBroadcaster(topic, data, pubSource);
    }
  }

  /**
   * Subscribe to a topic.
   *
   * @param {string}   topic    - Topic name
   * @param {function} callback - Handler receiving (data)
   * @param {number}   [scope]  - Unused for subscribe (kept for API compat)
   * @param {string}   [source] - Subscriber source address (defaults to instance source)
   * @returns {{ unsubscribe: () => void }} Subscription handle
   */
  subscribe(topic, callback, scope, source) {
    const subSource = source || this.source;
    if (!this._topics.has(topic)) {
      this._topics.set(topic, new Map());
    }
    // Use a unique key so the same source can subscribe multiple times
    const key = `${subSource}:${Math.random().toString(16).slice(2)}`;
    this._topics.get(topic).set(key, callback);

    return {
      unsubscribe: () => {
        const subs = this._topics.get(topic);
        if (subs) {
          subs.delete(key);
          if (subs.size === 0) {
            this._topics.delete(topic);
          }
        }
      },
    };
  }

  /**
   * Unsubscribe all callbacks for a given source from a specific topic.
   *
   * @param {string} source - Source address
   * @param {string} topic  - Topic name
   * @returns {boolean} Whether any subscriptions were removed
   */
  unsubscribe(source, topic) {
    const subscribers = this._topics.get(topic);
    if (!subscribers) return false;
    let removed = false;
    for (const [key] of subscribers) {
      if (key.startsWith(source + ':')) {
        subscribers.delete(key);
        removed = true;
      }
    }
    if (subscribers.size === 0) {
      this._topics.delete(topic);
    }
    return removed;
  }

  /**
   * Unsubscribe a source from all topics.
   *
   * @param {string} source - Source address
   */
  unsubscribeAll(source) {
    for (const [topic, subscribers] of this._topics) {
      for (const [key] of subscribers) {
        if (key.startsWith(source + ':')) {
          subscribers.delete(key);
        }
      }
      if (subscribers.size === 0) {
        this._topics.delete(topic);
      }
    }
  }

  /**
   * Set the callback for broadcasting to extension windows.
   * This provides an escape hatch for Electron's main-process extension
   * broadcasting, where BroadcastChannel doesn't reach extension iframes
   * in separate webContents.
   *
   * @param {function|null} broadcaster - (topic, data, source) => void
   */
  setExtensionBroadcaster(broadcaster) {
    this._extensionBroadcaster = broadcaster;
  }

  /**
   * Get the system address constant.
   * @returns {string}
   */
  getSystemAddress() {
    return SYSTEM_ADDRESS;
  }

  /**
   * Destroy this PubSub instance, closing the BroadcastChannel.
   */
  destroy() {
    if (this._channel) {
      this._channel.close();
      this._channel = null;
    }
    this._topics.clear();
    this._extensionBroadcaster = null;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new PubSub instance.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.source]     - Source address for this instance
 * @param {boolean} [opts.broadcast]  - Enable BroadcastChannel (default: true)
 * @returns {PubSub}
 */
export function createPubSub(opts) {
  return new PubSub(opts);
}

// ---------------------------------------------------------------------------
// Convenience exports matching the Electron backend API surface
// ---------------------------------------------------------------------------

export { SYSTEM_ADDRESS, getPseudoHost, scopeCheck };

export default {
  createPubSub,
  scopes,
  SYSTEM_ADDRESS,
  getPseudoHost,
  scopeCheck,
};
