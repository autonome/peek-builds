const id = 'pagestream';

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
