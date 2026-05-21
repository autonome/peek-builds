/**
 * Sync Extension Background Script
 *
 * Provides sync commands and functionality
 *
 * Runs in isolated extension process (peek://sync/background.html)
 */

const api = window.app;

const id = 'sync';
const labels = {
  name: 'Sync',
  description: 'Sync commands and functionality'
};

// ===== Command definitions =====

const commandDefinitions = [
  {
    name: 'Sync now',
    description: 'Trigger manual sync with server',
    execute: () => {
      if (!api?.sync?.syncAll) {
        console.error('[sync] Sync API not available');
        return { success: false, error: 'Sync API not available' };
      }

      // Fire and forget — don't block the cmd palette
      api.sync.syncAll().then(result => {
        if (!result.success) {
          console.error('[sync] Sync failed:', result.error);
        }
      }).catch(err => {
        console.error('[sync] Error during sync:', err);
      });

      return { success: true, message: 'Sync started' };
    }
  }
];

// ===== Registration =====

let registeredCommands = [];

const initCommands = () => {
  commandDefinitions.forEach(cmd => {
    api.commands.register(cmd);
    registeredCommands.push(cmd.name);
  });
  console.log('[ext:sync] Registered commands:', registeredCommands);
};

const uninitCommands = () => {
  registeredCommands.forEach(name => {
    api.commands.unregister(name);
  });
  registeredCommands = [];
  console.log('[ext:sync] Unregistered commands');
};

const init = () => {
  console.log('[ext:sync] init');

  // Register commands (cmd loads first with its subscribers ready via 100ms head start)
  initCommands();
};

const uninit = () => {
  console.log('[ext:sync] uninit');
  uninitCommands();
};

export default {
  id,
  init,
  uninit,
  labels
};
