/**
 * Sync Extension Background Script
 *
 * Provides sync commands and functionality
 *
 * Runs in isolated extension process (peek://ext/sync/background.html)
 */

const api = window.app;

const id = 'sync';
const labels = {
  name: 'Sync',
  description: 'Sync commands and functionality'
};

console.log('[ext:sync] background', labels.name);

// ===== Command definitions =====

const commandDefinitions = [
  {
    name: 'Sync now',
    description: 'Trigger manual sync with server',
    execute: async () => {
      console.log('[sync] Triggering manual sync...');

      // Check if sync API is available
      if (!api?.sync?.syncAll) {
        console.error('[sync] Sync API not available');
        return {
          success: false,
          error: 'Sync API not available'
        };
      }

      try {
        const result = await api.sync.syncAll();

        if (result.success) {
          const { pulled, pushed, conflicts } = result.data || {};
          console.log('[sync] Sync completed:', result.data);

          let message = 'Sync completed';
          const details = [];
          if (pulled) details.push(`${pulled} pulled`);
          if (pushed) details.push(`${pushed} pushed`);
          if (conflicts) details.push(`${conflicts} conflicts`);
          if (details.length) message += `: ${details.join(', ')}`;

          return {
            success: true,
            command: 'sync',
            message,
            data: result.data
          };
        } else {
          console.error('[sync] Sync failed:', result.error);
          return {
            success: false,
            command: 'sync',
            error: result.error || 'Sync failed'
          };
        }
      } catch (err) {
        console.error('[sync] Error during sync:', err);
        return {
          success: false,
          command: 'sync',
          error: err.message
        };
      }
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
