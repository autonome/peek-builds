/**
 * Debug extension background script.
 *
 * Registers two cmd-palette commands:
 *
 *   - `peek debug [on|off]`  — flips the verbose-logging flag. `DEBUG &&
 *     console.log(...)` lines across the main process (~hundreds of call
 *     sites that import DEBUG from backend/electron/config.ts) start
 *     firing as soon as this is on. Output lands in:
 *       <userData>/logs/main.log
 *       <userData>/logs/renderer.log
 *     With no argument, prints the current state.
 *
 *   - `peek devtools [on|off]` — flips the DevTools flag. NEW BrowserWindow
 *     instances are created with `webPreferences.devTools: true`; existing
 *     windows are unaffected (Electron does not allow flipping devTools
 *     post-creation). Cmd+Opt+I works on any window opened after the flip.
 *
 * Both flags are persisted to feature_settings under featureId='debug'
 * and survive restart. Toggling fires `peek:debug:changed` pubsub so
 * other UI surfaces (Settings panel) re-render without polling.
 */

const id = 'debug';
const api = window.app;

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse the user-typed argument into a target boolean state.
 * - 'on' / 'true' / '1' / 'yes' / 'enable'  → true
 * - 'off' / 'false' / '0' / 'no' / 'disable' → false
 * - anything else (including empty) → null  (caller treats null as "show current")
 */
function parseStateArg(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  if (['on', 'true', '1', 'yes', 'enable', 'enabled'].includes(s)) return true;
  if (['off', 'false', '0', 'no', 'disable', 'disabled'].includes(s)) return false;
  return null;
}

/** Read the current flag state from main. */
async function getState() {
  const res = await api.debugFlags.get();
  if (!res?.success) {
    throw new Error(res?.error || 'Failed to read debug flags');
  }
  return res.state;
}

/** Format a state object for display in the cmd-palette result. */
function formatState(state) {
  return `verbose: ${state.verbose ? 'on' : 'off'} · devtools: ${state.devtools ? 'on' : 'off'}`;
}

/**
 * Handle a flip for one named flag. Returns the result the cmd-panel
 * surfaces back to the user.
 *
 * @param {'verbose' | 'devtools'} flag - which flag the command operates on
 * @param {string|null} arg - the raw argument from the cmd-palette search box
 */
async function handleFlagCommand(flag, arg) {
  const requested = parseStateArg(arg);
  if (requested === null && arg && arg.trim()) {
    return {
      success: false,
      error: `Unknown argument "${arg}". Use "on" or "off".`,
    };
  }

  // No arg — just read and report current state.
  if (requested === null) {
    try {
      const state = await getState();
      return {
        success: true,
        message: formatState(state),
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // Flip the requested flag.
  try {
    const res = await api.debugFlags.set({ [flag]: requested });
    if (!res?.success) {
      return { success: false, error: res?.error || 'Failed to update debug flag' };
    }
    return {
      success: true,
      message: formatState(res.state),
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── Init ────────────────────────────────────────────────────────────────────

/**
 * Settings UI bridge. When the user changes the toggles in the Debug
 * settings panel, app/settings/settings.js writes to feature_settings
 * (featureId='debug', key='prefs') and publishes `debug:settings-changed`.
 * We read the new prefs and push them through the main-process IPC
 * handler so the live flags + persistence stay coherent.
 *
 * Without this bridge, the Settings UI change would land in the
 * `feature_settings` row but the in-process `DEBUG` binding would not
 * update until the next launch — defeating the "live toggle" point.
 */
async function syncFromSettingsUI() {
  try {
    const res = await api.settings.get('prefs');
    const prefs = res?.value;
    if (!prefs || typeof prefs !== 'object') return;
    const next = {};
    if (typeof prefs.verbose === 'boolean') next.verbose = prefs.verbose;
    if (typeof prefs.devtools === 'boolean') next.devtools = prefs.devtools;
    if (Object.keys(next).length > 0) {
      await api.debugFlags.set(next);
    }
  } catch (err) {
    console.error('[ext:debug] syncFromSettingsUI failed:', err);
  }
}

const extension = {
  id,
  init: async () => {
    api.pubsub.subscribe('cmd:execute:peek debug', async (msg) => {
      const arg = msg.search?.trim() || null;
      const result = await handleFlagCommand('verbose', arg);
      if (msg.expectResult && msg.resultTopic) {
        api.pubsub.publish(msg.resultTopic, result);
      }
    });
    api.pubsub.publish('cmd:register', {
      name: 'peek debug',
      description: 'Toggle verbose logging (writes to <userData>/logs/main.log + renderer.log)',
      source: id,
      scope: 'global',
      accepts: [],
      produces: [],
      params: [
        {
          name: 'state',
          type: 'string',
          required: false,
          description: 'on | off (omit to show current state)',
        },
      ],
    });

    api.pubsub.subscribe('cmd:execute:peek devtools', async (msg) => {
      const arg = msg.search?.trim() || null;
      const result = await handleFlagCommand('devtools', arg);
      if (msg.expectResult && msg.resultTopic) {
        api.pubsub.publish(msg.resultTopic, result);
      }
    });
    api.pubsub.publish('cmd:register', {
      name: 'peek devtools',
      description: 'Toggle DevTools on newly-opened windows (existing windows unaffected)',
      source: id,
      scope: 'global',
      accepts: [],
      produces: [],
      params: [
        {
          name: 'state',
          type: 'string',
          required: false,
          description: 'on | off (omit to show current state)',
        },
      ],
    });

    api.pubsub.subscribe('debug:settings-changed', syncFromSettingsUI);
  },
  uninit: () => {
    // pubsub subscriptions are torn down automatically on tile shutdown
  },
};

export default extension;
