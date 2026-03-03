const id = 'lists';

const labels = {
  name: 'Lists',
  prefs: {
    shortcutKey: 'Lists shortcut',
  }
};

const prefsSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "peek.lists.prefs.schema.json",
  "title": "Lists preferences",
  "description": "Peek app Lists user preferences",
  "type": "object",
  "properties": {
    "shortcutKey": {
      "description": "Global OS hotkey to open lists window",
      "type": "string",
      "default": "Option+f"
    },
  },
  "required": ["shortcutKey"]
};

const schemas = {
  prefs: prefsSchema,
};

const storageKeys = {
  PREFS: 'prefs',
};

const defaults = {
  prefs: {
    shortcutKey: 'Option+f'
  },
};

export {
  id,
  labels,
  schemas,
  storageKeys,
  defaults
};
