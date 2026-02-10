const id = 'search';

const labels = {
  name: 'Search',
  prefs: {
    shortcutKey: 'Search shortcut',
  }
};

const prefsSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "peek.search.prefs.schema.json",
  "title": "Search preferences",
  "description": "Peek app Search user preferences",
  "type": "object",
  "properties": {
    "shortcutKey": {
      "description": "Global OS hotkey to open search window",
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
