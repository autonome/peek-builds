/**
 * Features Manager — Background tile
 *
 * Provides:
 * - `features` noun registration (query, browse)
 * - Pubsub handlers for feature management events
 * - Commands: list features
 */

import { registerNoun, unregisterNoun } from 'peek://ext/cmd/nouns.js';
// Note: updater.js exports compareSemver/compareCapabilities utilities used by
// browse.js. background.js delegates update checking entirely to the backend
// via api.features.updateCheckAll() + api.features.updateApply(), so no
// direct imports from updater.js are needed here.

const hasPeekAPI = typeof window.app !== 'undefined';
const api = hasPeekAPI ? window.app : null;

/** Cached lex session for publish flow */
let currentLexSession = null;

/** Update check interval handle */
let updateCheckIntervalId = null;

/** Default update check interval in ms (24 hours) */
const DEFAULT_UPDATE_INTERVAL_MS = 1440 * 60 * 1000;

/** Delay before first update check after startup (60 seconds) */
const STARTUP_CHECK_DELAY_MS = 60 * 1000;

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
 * Open the publish feature window
 */
function openPublish() {
  if (hasPeekAPI) {
    api.window.open('peek://ext/features-manager/publish.html', {
      role: 'workspace',
      key: 'features-publish',
      width: 700,
      height: 600,
      title: 'Publish Feature'
    });
  } else {
    window.open('./publish.html', '_blank');
  }
}

/**
 * Open the features browse window
 */
function openBrowse() {
  if (hasPeekAPI) {
    api.window.open('peek://ext/features-manager/browse.html', {
      role: 'workspace',
      key: 'features-browse',
      width: 960,
      height: 720,
      title: 'Browse Features'
    });
  } else {
    window.open('./browse.html', '_blank');
  }
}

/**
 * Query installed non-builtin features via IPC
 */
async function queryFeatures({ search } = {}) {
  if (!hasPeekAPI) return { success: false, error: 'No API' };

  try {
    const result = await api.features.list();
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
      browse: () => { openBrowse(); },
      open: () => { openManage(); },
      produces: 'application/json'
    });

    // Register shortcut
    api.shortcuts.register('CommandOrControl+Shift+X', openManage);

    // Subscribe to feature management request events
    api.pubsub.subscribe('feature:disable-request', async (msg) => {
      if (!msg.id) return;
      try {
        const result = await api.features.disable(msg.id);
        api.pubsub.publish('feature:disable-result', { id: msg.id, ...result }, api.scopes.GLOBAL);
      } catch (err) {
        api.pubsub.publish('feature:disable-result', { id: msg.id, error: err.message }, api.scopes.GLOBAL);
      }
    }, api.scopes.GLOBAL);

    api.pubsub.subscribe('feature:enable-request', async (msg) => {
      if (!msg.id) return;
      try {
        const result = await api.features.enable(msg.id);
        api.pubsub.publish('feature:enable-result', { id: msg.id, ...result }, api.scopes.GLOBAL);
      } catch (err) {
        api.pubsub.publish('feature:enable-result', { id: msg.id, error: err.message }, api.scopes.GLOBAL);
      }
    }, api.scopes.GLOBAL);

    api.pubsub.subscribe('feature:remove-request', async (msg) => {
      if (!msg.id) return;
      try {
        const result = await api.features.remove(msg.id);
        api.pubsub.publish('feature:remove-result', { id: msg.id, ...result }, api.scopes.GLOBAL);
      } catch (err) {
        api.pubsub.publish('feature:remove-result', { id: msg.id, error: err.message }, api.scopes.GLOBAL);
      }
    }, api.scopes.GLOBAL);

    // Listen for lex session changes (used by publish flow)
    api.pubsub.subscribe('lex:session-changed', (msg) => {
      if (msg.session) {
        currentLexSession = msg.session;
        console.log('[features-manager] Lex session updated for', currentLexSession.handle);
      } else {
        currentLexSession = null;
        console.log('[features-manager] Lex session cleared');
      }
    }, api.scopes.GLOBAL);

    // ── Update Checking ──

    /**
     * Run update check for all installed atproto features.
     * For each result, apply auto-update or publish notification.
     */
    async function runUpdateCheck() {
      console.log('[features-manager] Running update check...');
      try {
        // Strict path — gated on `features.update` capability.
        const result = await api.features.updateCheckAll();
        if (result.error) {
          console.error('[features-manager] Update check error:', result.error);
          return [];
        }

        const updates = result.updates || [];
        console.log(`[features-manager] Found ${updates.length} updates`);

        // Get full feature list to check policies and capabilities
        const listResult = await api.features.list();
        const features = listResult.entries || [];
        const featureMap = {};
        for (const f of features) {
          featureMap[f.id] = f;
        }

        for (const update of updates) {
          const feature = featureMap[update.id];
          if (!feature) continue;

          const policy = feature.updatePolicy || 'auto';

          if (policy === 'pinned') continue;

          // For auto-update, we need to check capabilities
          // We don't have the new manifest here directly, but we can
          // attempt the apply and let the IPC handler guard it
          if (policy === 'auto') {
            const applyResult = await api.features.updateApply(update.id, false);

            if (applyResult.capabilitiesChanged) {
              // Capabilities expanded — notify user
              api.pubsub.publish('feature:update-available', {
                featureId: update.id,
                name: update.name,
                currentVersion: update.currentVersion,
                availableVersion: update.availableVersion,
                capabilitiesChanged: true,
                added: applyResult.added,
                removed: applyResult.removed,
              }, api.scopes.GLOBAL);
            } else if (applyResult.error && !applyResult.capabilitiesChanged) {
              console.error(`[features-manager] Auto-update failed for ${update.id}:`, applyResult.error);
            } else if (applyResult.success) {
              console.log(`[features-manager] Auto-updated ${update.id} to ${update.availableVersion}`);
            }
          } else if (policy === 'notify') {
            api.pubsub.publish('feature:update-available', {
              featureId: update.id,
              name: update.name,
              currentVersion: update.currentVersion,
              availableVersion: update.availableVersion,
              capabilitiesChanged: false,
            }, api.scopes.GLOBAL);
          }
        }

        return updates;
      } catch (err) {
        console.error('[features-manager] Update check error:', err);
        return [];
      }
    }

    /**
     * Schedule periodic update checks.
     */
    function scheduleUpdateChecks(intervalMs) {
      if (updateCheckIntervalId) {
        clearInterval(updateCheckIntervalId);
      }
      updateCheckIntervalId = setInterval(runUpdateCheck, intervalMs);
      console.log(`[features-manager] Update checks scheduled every ${Math.round(intervalMs / 60000)} minutes`);
    }

    // Schedule first check after startup delay, then at configured interval
    setTimeout(async () => {
      await runUpdateCheck();

      // Read the configured interval from settings
      let intervalMs = DEFAULT_UPDATE_INTERVAL_MS;
      try {
        const settingsResult = await api.settings.get('features-manager.updateCheckInterval');
        if (settingsResult && settingsResult.value && typeof settingsResult.value === 'number') {
          intervalMs = settingsResult.value * 60 * 1000;
        }
      } catch (e) {
        // Use default
      }
      scheduleUpdateChecks(intervalMs);
    }, STARTUP_CHECK_DELAY_MS);

    // Register update commands
    api.commands.register('check feature updates', async () => {
      const updates = await runUpdateCheck();
      if (updates.length === 0) {
        return {
          output: {
            data: 'All features are up to date.',
            mimeType: 'text/plain',
            title: 'Feature Updates',
          },
        };
      }
      return {
        output: {
          data: updates.map(u => ({
            name: u.name,
            current: u.currentVersion,
            available: u.availableVersion,
          })),
          mimeType: 'application/json',
          title: `Updates Available (${updates.length})`,
        },
      };
    });

    api.commands.register('update feature', {
      params: [{
        name: 'feature',
        description: 'Feature name or ID to update',
        type: 'string',
        required: true,
      }],
      execute: async (params) => {
        const query = (params.feature || '').toLowerCase();
        if (!query) {
          return { error: 'Feature name or ID is required' };
        }

        // Find matching feature
        const listResult = await api.features.list();
        const features = listResult.entries || [];
        const match = features.find(f =>
          f.id.toLowerCase() === query ||
          f.name.toLowerCase() === query ||
          f.name.toLowerCase().includes(query)
        );

        if (!match) {
          return { error: `No feature found matching "${params.feature}"` };
        }

        if (match.source?.type !== 'atproto') {
          return { error: `Feature "${match.name}" is not from AT Protocol and cannot be updated this way` };
        }

        // Apply update (userApproved=true overrides notify/pinned for this action)
        const result = await api.features.updateApply(match.id, true);

        if (result.error) {
          return { error: result.error };
        }

        return {
          output: {
            data: `Updated "${match.name}" to v${result.entry?.source?.version || 'latest'}`,
            mimeType: 'text/plain',
            title: 'Feature Updated',
          },
        };
      },
    });

    // Install flow — orchestrates resolve/preview/install for AT URIs
    api.pubsub.subscribe('feature:install-request', async (msg) => {
      if (!msg.atUri) return;

      try {
        // Step 1: Resolve the AT URI to get metadata
        const resolveResult = await api.features.installResolve(msg.atUri);

        if (resolveResult.error) {
          api.pubsub.publish('feature:install-result', {
            atUri: msg.atUri,
            success: false,
            error: resolveResult.error,
          }, api.scopes.GLOBAL);
          return;
        }

        // Step 2: If userApproved flag is set, proceed directly with install
        if (msg.userApproved) {
          const installResult = await api.features.install(msg.atUri, true);

          api.pubsub.publish('feature:install-result', {
            atUri: msg.atUri,
            success: !installResult.error,
            entry: installResult.entry,
            error: installResult.error,
          }, api.scopes.GLOBAL);
          return;
        }

        // Step 3: Otherwise, publish resolved metadata for UI to show preview
        api.pubsub.publish('feature:install-result', {
          atUri: msg.atUri,
          success: true,
          phase: 'resolved',
          manifest: resolveResult.manifest,
          source: resolveResult.source,
        }, api.scopes.GLOBAL);

      } catch (err) {
        console.error('[features-manager] install-request error:', err);
        api.pubsub.publish('feature:install-result', {
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
    if (updateCheckIntervalId) {
      clearInterval(updateCheckIntervalId);
      updateCheckIntervalId = null;
    }
  }
};

export default extension;
