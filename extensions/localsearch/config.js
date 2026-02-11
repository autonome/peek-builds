const id = 'localsearch';

const labels = {
  name: 'Local Search',
  prefs: {
    shortcutKey: 'Local search shortcut',
  }
};

const prefsSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "peek.localsearch.prefs.schema.json",
  "title": "Local Search preferences",
  "description": "Peek app Local Search user preferences",
  "type": "object",
  "properties": {
    "shortcutKey": {
      "description": "Global OS hotkey to open local search window",
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
