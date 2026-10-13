const id = 'peeks';

const labels = {
  name: 'Peeks',
  prefs: {
    keyPrefix: 'Peek shortcut prefix',
  }
};

const prefsSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "peek.peeks.prefs.schema.json",
  "title": "Peeks preferences",
  "description": "Peeks user preferences",
  "type": "object",
  "properties": {
    "shortcutKeyPrefix": {
      "description": "Global OS hotkey prefix to trigger peeks - will be followed by 0-9",
      "type": "string",
      "default": "Option+"
    },
  },
  "required": [ "shortcutKeyPrefix"]
};

const itemSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "peek.peeks.peek.schema.json",
  "title": "Peek - page peek",
  "description": "Peek page peek",
  "type": "object",
  "properties": {
    "keyNum": {
      "description": "Number on keyboard to open this peek, 0-9",
      "type": "integer",
      "minimum": 0,
      "maximum": 9,
      "default": 0
    },
    "title": {
      "description": "Name of the peek - user defined label",
      "type": "string",
      "default": "New Peek"
    },
    "address": {
      "description": "URL to load",
      "type": "string",
      "default": "https://example.com"
    },
    "persistState": {
      "description": "Whether to persist local state or load page into empty container - defaults to false",
      "type": "boolean",
      "default": false
    },
    "keepLive": {
      "description": "Whether to keep page alive in background or load fresh when triggered - defaults to false",
      "type": "boolean",
      "default": false
    },
    "allowSound": {
      "description": "Whether to allow the page to emit sound or not (eg for background music player peeks - defaults to false",
      "type": "boolean",
      "default": false
    },
    "height": {
      "description": "User-defined height of peek page - left empty, the peek opens at a height relative to the display",
      "type": "integer"
    },
    "width": {
      "description": "User-defined width of peek page - left empty, the peek opens at a width relative to the display",
      "type": "integer"
    },
    "enabled": {
      "description": "Whether this peek is enabled or not.",
      "type": "boolean",
      "default": false
    },
  },
  "required": [ "keyNum", "title", "address", "persistState", "keepLive", "allowSound",
                "enabled" ]
};

const listSchema = {
  type: 'array',
  items: { "$ref": "#/$defs/peek" }
};

// TODO: schemaize 0-9 constraints for peeks
const schemas = {
  prefs: prefsSchema,
  item: itemSchema,
  items: listSchema
};

const storageKeys = {
  PREFS: 'prefs',
  ITEMS: 'items',
};

const defaults = {
  prefs: {
    shortcutKeyPrefix: 'Option+'
  },
  items: Array.from(Array(10)),
};

for (var i = 0; i != 10; i++) {
  const address = i == 0 ? 'https://example.com/' : '';
  const enabled = i == 0 ? true : false;
  defaults.items[i] = {
    keyNum: i,
    title: `Peek key ${i}`,
    address: address,
    persistState: false,
    keepLive: false,
    allowSound: false,
    enabled: enabled,
  };
}

// The size a peek opens at when no resize is remembered and Options carries no
// size: a share of the work area of whichever display it opens on. Wider than it
// is tall is deliberate — a peek is a page read in place, not a column.
const relativeSize = {
  widthFraction: 0.60,
  heightFraction: 0.80,
};

export {
  id,
  labels,
  schemas,
  storageKeys,
  defaults,
  relativeSize
};
