/**
 * Sync command - manually trigger a full bidirectional sync
 */

const api = window.app;

export default {
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
};
