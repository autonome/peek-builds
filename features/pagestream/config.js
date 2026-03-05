const id = 'f7a3c1d2-8e4b-4f6a-9d2c-1b3e5a7f9c0d';

const labels = {
  name: 'Pagestream',
  prefs: {
    shortcutKey: 'Pagestream shortcut',
  }
};

const prefsSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "peek.pagestream.prefs.schema.json",
  "title": "Pagestream preferences",
  "description": "Peek app Pagestream user preferences",
  "type": "object",
  "properties": {
    "shortcutKey": {
      "description": "Global OS hotkey to open Pagestream",
      "type": "string",
      "default": "Option+p"
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
    shortcutKey: 'Option+p'
  },
};

export {
  id,
  labels,
  schemas,
  storageKeys,
  defaults
};
