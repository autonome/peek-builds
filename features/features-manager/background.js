/**
 * Features Manager — Background tile
 *
 * Provides:
 * - `features` noun registration (query, browse)
 * - Pubsub handlers for feature management events
 * - Commands: list features
 */

import { registerNoun, unregisterNoun } from 'peek://ext/cmd/nouns.js';

const hasPeekAPI = typeof window.app !== 'undefined';
const api = hasPeekAPI ? window.app : null;

/**
 * Open the features manage window
 */
function openManage() {
  if (hasPeekAPI) {
    api.window.open('peek://ext/features-manager/manage.html', {
      role: 'workspace',
      key: 'features-manage',
      width: 900,
      height: 650,
      title: 'Features'
    });
  } else {
    window.open('./manage.html', '_blank');
  }
}

/**
 * Query installed non-builtin features via IPC
 */
async function queryFeatures({ search } = {}) {
  if (!hasPeekAPI) return { success: false, error: 'No API' };

  try {
    const result = await api.ipc.invoke('feature-registry:list');
    if (result.error) return { success: false, error: result.error };

    let entries = result.entries || [];

    if (search) {
      const q = search.toLowerCase();
      entries = entries.filter(e =>
        e.name.toLowerCase().includes(q) ||
        e.id.toLowerCase().includes(q)
      );
    }

    return {
      success: true,
      output: {
        data: entries.map(e => ({
          id: e.id,
          name: e.name,
          version: e.source?.version || 'unknown',
          source: e.source?.type || 'unknown',
          disabled: !!e.disabled
        })),
        mimeType: 'application/json',
        title: `Features (${entries.length})`
      }
    };
  } catch (err) {
    console.error('[features-manager] query error:', err);
    return { success: false, error: err.message };
  }
}

const extension = {
  id: 'features-manager',
  labels: {
    name: 'Features Manager'
  },

  init() {
    if (!hasPeekAPI) return;

    // Register noun
    registerNoun({
      name: 'features',
      singular: 'feature',
      description: 'Installed non-built-in features',
      query: queryFeatures,
      browse: () => { openManage(); },
      produces: 'application/json'
    });

    // Register shortcut
    api.shortcuts.register('CommandOrControl+Shift+X', openManage);

    // Subscribe to feature management request events
    api.subscribe('feature:disable-request', async (msg) => {
      if (!msg.id) return;
      try {
        const result = await api.ipc.invoke('feature-registry:disable', { id: msg.id });
        api.publish('feature:disable-result', { id: msg.id, ...result }, api.scopes.GLOBAL);
      } catch (err) {
        api.publish('feature:disable-result', { id: msg.id, error: err.message }, api.scopes.GLOBAL);
      }
    }, api.scopes.GLOBAL);

    api.subscribe('feature:enable-request', async (msg) => {
      if (!msg.id) return;
      try {
        const result = await api.ipc.invoke('feature-registry:enable', { id: msg.id });
        api.publish('feature:enable-result', { id: msg.id, ...result }, api.scopes.GLOBAL);
      } catch (err) {
        api.publish('feature:enable-result', { id: msg.id, error: err.message }, api.scopes.GLOBAL);
      }
    }, api.scopes.GLOBAL);

    api.subscribe('feature:remove-request', async (msg) => {
      if (!msg.id) return;
      try {
        const result = await api.ipc.invoke('feature-registry:remove', { id: msg.id });
        api.publish('feature:remove-result', { id: msg.id, ...result }, api.scopes.GLOBAL);
      } catch (err) {
        api.publish('feature:remove-result', { id: msg.id, error: err.message }, api.scopes.GLOBAL);
      }
    }, api.scopes.GLOBAL);

    // Install flow — orchestrates resolve/preview/install for AT URIs
    api.subscribe('feature:install-request', async (msg) => {
      if (!msg.atUri) return;

      try {
        // Step 1: Resolve the AT URI to get metadata
        const resolveResult = await api.ipc.invoke('feature-install:resolve', {
          atUri: msg.atUri,
        });

        if (resolveResult.error) {
          api.publish('feature:install-result', {
            atUri: msg.atUri,
            success: false,
            error: resolveResult.error,
          }, api.scopes.GLOBAL);
          return;
        }

        // Step 2: If userApproved flag is set, proceed directly with install
        if (msg.userApproved) {
          const installResult = await api.ipc.invoke('feature-install:install', {
            atUri: msg.atUri,
            userApproved: true,
          });

          api.publish('feature:install-result', {
            atUri: msg.atUri,
            success: !installResult.error,
            entry: installResult.entry,
            error: installResult.error,
          }, api.scopes.GLOBAL);
          return;
        }

        // Step 3: Otherwise, publish resolved metadata for UI to show preview
        api.publish('feature:install-result', {
          atUri: msg.atUri,
          success: true,
          phase: 'resolved',
          manifest: resolveResult.manifest,
          source: resolveResult.source,
        }, api.scopes.GLOBAL);

      } catch (err) {
        console.error('[features-manager] install-request error:', err);
        api.publish('feature:install-result', {
          atUri: msg.atUri,
          success: false,
          error: err.message,
        }, api.scopes.GLOBAL);
      }
    }, api.scopes.GLOBAL);
  },

  uninit() {
    if (!hasPeekAPI) return;
    unregisterNoun('features');
    api.shortcuts.unregister('CommandOrControl+Shift+X');
  }
};

export default extension;
