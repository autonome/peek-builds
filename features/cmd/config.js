const id = 'cmd';

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
        "default": "Option+Space"
      },
      "showUrlsInResults": {
        "description": "Show visited URLs inline in command results",
        "type": "boolean",
        "default": false
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
    shortcutKey: 'Option+Space',
    showUrlsInResults: false
  },
};

export {
  id,
  labels,
  schemas,
  storageKeys,
  defaults
};
