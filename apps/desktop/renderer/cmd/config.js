const id = 'cmd';

// Default global hotkey is Option+Space everywhere except Linux. On GNOME
// (and several other Linux WMs), Alt+Space is reserved for the window
// options menu — the local-fallback registration would conflict and the
// global registration is rejected by the compositor anyway. Use
// CommandOrControl+Space on Linux so the local fallback works cleanly.
const isLinux = typeof window !== 'undefined' && window.app?.platform?.os === 'linux';
// TEMPORARY live-trace diagnostic: Control+Option+Space so this instance's
// global hotkey does not collide with an installed Peek holding Option+Space.
const defaultShortcutKey = isLinux ? 'CommandOrControl+Space' : 'Control+Option+Space';

const labels = {
  name: 'Cmd',
  prefs: {
    shortcutKey: 'Cmd shortcut',
    showUrlsInResults: 'Show URLs in results',
    enterRunsInlineSuggestion: 'Enter runs the inline suggestion',
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
      "enterRunsInlineSuggestion": {
        "description": "Pressing Enter runs the inline-suggested command even when only a prefix is typed",
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
    showUrlsInResults: true,
    enterRunsInlineSuggestion: true
  },
};

export {
  id,
  labels,
  schemas,
  storageKeys,
  defaults
};
