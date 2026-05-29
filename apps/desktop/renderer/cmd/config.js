const id = 'cmd';

// Default global hotkey is Option+Space everywhere except Linux. On GNOME
// (and several other Linux WMs), Alt+Space is reserved for the window
// options menu — the local-fallback registration would conflict and the
// global registration is rejected by the compositor anyway. Use
// CommandOrControl+Space on Linux so the local fallback works cleanly.
const isLinux = typeof window !== 'undefined' && window.app?.platform?.os === 'linux';
const defaultShortcutKey = isLinux ? 'CommandOrControl+Space' : 'Option+Space';

const labels = {
  name: 'Cmd',
  prefs: {
    shortcutKey: 'Cmd shortcut',
    showUrlsInResults: 'Show URLs in results',
  }
};

const schemas = {
  prefs: {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "peek.cmd.prefs.schema.json",
    "title": "Cmd preferences",
    "description": "Peek app Cmd user preferences",
    "type": "object",
    "properties": {
      "shortcutKey": {
        "description": "Global OS hotkey to open command panel",
        "type": "string",
        "default": defaultShortcutKey
      },
      "showUrlsInResults": {
        "description": "Show visited URLs inline in command results",
        "type": "boolean",
        "default": true
      },
    },
    "required": ["shortcutKey"]
  }
};

const storageKeys = {
  PREFS: 'prefs',
};

const defaults = {
  prefs: {
    shortcutKey: defaultShortcutKey,
    showUrlsInResults: true
  },
};

export {
  id,
  labels,
  schemas,
  storageKeys,
  defaults
};
