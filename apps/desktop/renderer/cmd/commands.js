/**
 * Commands manager - loads and provides commands to the command panel
 *
 * Runs in panel window context (peek://cmd/panel.html)
 * Queries cmd extension background for registered commands
 */
import { id, labels, schemas, storageKeys, defaults } from './config.js';
import commandsModule from './commands/index.js';
import { createRegistryMirror } from './registry-state.js';

console.log('[cmd:commands] loaded');

const debug = window.app.debug;
const api = window.app;

// Command registry - uses an object map for legacy compatibility
let commands = {};

// Newest registry state seen, and the names of the commands it supplied
const registryMirror = createRegistryMirror();
let registryNames = new Set();

// Debounce timer for UI updates
let updateTimer = null;
const UPDATE_DELAY_MS = 16; // ~1 frame

/**
 * Notifies the UI that commands have been updated (debounced)
 */
function onCommandsUpdated() {
  clearTimeout(updateTimer);
  updateTimer = setTimeout(() => {
    window.dispatchEvent(new CustomEvent('cmd-update-commands', { detail: commands }));
    debug && console.log('[cmd:commands] cmd-update-commands dispatched, commands:', Object.keys(commands).length);
  }, UPDATE_DELAY_MS);
}

/**
 * Adds a command to the registry
 * @param {Object} command - The command object with name and execute properties
 */
function addCommand(command) {
  commands[command.name] = command;
  onCommandsUpdated();
}

/**
 * Adds a command without triggering update (for batching)
 */
function addCommandSilent(command) {
  commands[command.name] = command;
}

/**
 * Removes a command from the registry
 * @param {string} name - The command name to remove
 */
function removeCommand(name) {
  if (commands[name]) {
    delete commands[name];
    onCommandsUpdated();
    debug && console.log('[cmd:commands] Command removed:', name);
  }
}

/**
 * Initializes all command sources and registers them
 */
let _sourcesInitialized = false;

async function initializeCommandSources() {
  if (_sourcesInitialized) {
    debug && console.log('[cmd:commands] sources already initialized, skipping');
    return;
  }
  _sourcesInitialized = true;
  debug && console.log('[cmd:commands] initializeCommandSources');

  // Load commands from the commands module
  const moduleCommands = commandsModule.commands;
  debug && console.log('[cmd:commands] moduleCommands:', moduleCommands.map(c => c.name));
  moduleCommands.forEach(command => {
    debug && console.log('[cmd:commands] adding command:', command.name);
    addCommandSilent(command); // Use silent add for batch loading
  });

  // Initialize any command sources that dynamically generate commands
  // Pass batch-friendly API so sources can add silently and trigger one update
  if (typeof commandsModule.initializeSources === 'function') {
    await commandsModule.initializeSources(addCommand, {
      addCommandSilent,
      removeCommand,
      flushUpdates: onCommandsUpdated
    });
  }

  // Notify that commands are ready
  onCommandsUpdated();
}

// Initialize commands when the DOM is loaded
window.addEventListener('DOMContentLoaded', () => initializeCommandSources());

/**
 * Create a proxy command that publishes execution back to the registering extension
 *
 * Proxy commands execute via pubsub (fire-and-forget). For chaining support,
 * extensions can subscribe to `cmd:execute:${name}:result` and publish their
 * result, which we capture here and return for the chaining flow.
 */
function createProxyCommand(cmdData) {
  const base = {
    name: cmdData.name,
    description: cmdData.description || '',
    source: cmdData.source,
    // Preserve connector metadata for chaining
    accepts: cmdData.accepts || [],
    produces: cmdData.produces || [],
    // Parameter definitions for completions
    params: cmdData.params || [],
    // Order among top-level rows that pair commands with the same option (object-pairs.js)
    ...(cmdData.pairPriority != null ? { pairPriority: cmdData.pairPriority } : {}),
  };

  // Noun proxy — dispatch via noun:{capability}:{nounName} instead of cmd:execute:{name}
  if (cmdData._nounCapability && cmdData._nounName) {
    const topic = `noun:${cmdData._nounCapability}:${cmdData._nounName}`;
    base.execute = async (ctx) => {
      return new Promise((resolve) => {
        const resultTopic = `noun:result:${cmdData._nounName}:${Date.now()}`;
        let settled = false;

        const unsubscribe = api.subscribe(resultTopic, (result) => {
          if (settled) return;
          settled = true;
          unsubscribe?.();
          resolve(result);
        });

        api.publish(topic, {
          ...ctx,
          expectResult: true,
          resultTopic
        });

        setTimeout(() => {
          if (settled) return;
          settled = true;
          unsubscribe?.();
          resolve(undefined);
        }, 30000);
      });
    };
    return base;
  }

  // Regular command proxy — dispatch via cmd:execute:{name}
  base.execute = async (ctx) => {
    return new Promise((resolve) => {
      // Unique per-invocation topic. A static topic races across repeats:
      // iteration N's fire-and-forget `tile:pubsub:unsubscribe` can arrive
      // at main AFTER iteration N+1's `tile:pubsub:subscribe`, deleting the
      // new subscription and dropping the result publish.
      const resultTopic = `cmd:execute:${cmdData.name}:result:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
      let settled = false;

      const unsubscribe = api.subscribe(resultTopic, (result) => {
        if (settled) return;
        settled = true;
        unsubscribe?.();
        resolve(result);
      });

      api.publish(`cmd:execute:${cmdData.name}`, {
        ...ctx,
        expectResult: true,
        resultTopic
      });

      setTimeout(() => {
        if (settled) return;
        settled = true;
        unsubscribe?.();
        resolve(undefined);
      }, 30000);
    });
  };
  return base;
}

/**
 * Subscribe to dynamic command registration from extensions
 */
function initializeCommandRegistration() {
  // The core registry (background.js) owns command state and publishes its
  // full, versioned state on every change and in reply to our query. The
  // panel applies only state newer than what it has, so registrations,
  // unregistrations and snapshots can arrive in any order.
  api.subscribe('cmd:query-commands-response', (msg) => {
    debug && console.log('[cmd:commands] registry state received', msg.version, msg.commands?.length, 'commands');
    if (!registryMirror.apply(msg)) return;
    // Replace the registry-provided commands wholesale; built-ins stay.
    for (const name of registryNames) delete commands[name];
    registryNames = new Set();
    for (const cmdData of registryMirror.commands) {
      addCommandSilent(createProxyCommand(cmdData));
      registryNames.add(cmdData.name);
    }
    onCommandsUpdated();
  });

  // Query the background process for currently registered commands
  debug && console.log('[cmd:commands] Querying for registered commands...');
  api.publish('cmd:query-commands', {});

  debug && console.log('[cmd:commands] Command registration listeners initialized');
}

// Initialize command registration listeners.
//
// `api.subscribe` / `api.publish` silently no-op before `api.initialize()`
// resolves (`tokenValid` is false in tile-preload). panel.js awaits
// `api.initialize()` *after* importing this module, so we must defer our
// subscription setup until the token is valid — otherwise every feature
// tile's `cmd:register` publish is dropped and the panel sees only the
// built-in commands loaded by `initializeCommandSources()`.
if (api.initialize) {
  api.initialize().then(() => initializeCommandRegistration());
} else {
  initializeCommandRegistration();
}

/**
 * Helper function for notifications (currently unused)
 */
function notify(title, content) {
  if (typeof browser !== 'undefined' && browser.notifications) {
    browser.notifications.create({
      "type": "basic",
      "iconUrl": browser.extension.getURL("images/icon.png"),
      "title": title,
      "message": content
    });
  } else {
    console.log('Notification:', title, content);
  }
}
