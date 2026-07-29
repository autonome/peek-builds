const id = 'groups';

const labels = {
  name: 'Groups',
  prefs: {}
};

const prefsSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "peek.groups.prefs.schema.json",
  "title": "Groups preferences",
  "description": "Peek app Groups user preferences",
  "type": "object",
  "properties": {}
};

const schemas = {
  prefs: prefsSchema,
};

const storageKeys = {
  PREFS: 'prefs',
};

const defaults = {
  prefs: {},
};

export {
  id,
  labels,
  schemas,
  storageKeys,
  defaults
};
