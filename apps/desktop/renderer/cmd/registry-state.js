/**
 * Versioned mirror of the core command registry, for the command panel.
 *
 * The registry in background.js stamps a version on its full state. The panel
 * keeps the newest state it has seen and drops anything older or equal, so a
 * late snapshot cannot overwrite newer command metadata (e.g. param options).
 */
export function createRegistryMirror() {
  let version = 0;
  let commands = [];
  return {
    /**
     * @param {{version: number, commands: Array}} state - full registry state
     * @returns {boolean} true when the state was newer and replaced the mirror
     */
    apply(state) {
      if (!state || typeof state.version !== 'number' || state.version <= version) return false;
      if (!Array.isArray(state.commands)) return false;
      version = state.version;
      commands = state.commands;
      return true;
    },
    get version() { return version; },
    get commands() { return commands; },
  };
}
