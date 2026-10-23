/**
 * Where a sheet's config lives.
 *
 * Every sheet's config is one entry in the `sheets` settings map, keyed
 * `sheet:<id>`. The map is the home because listing sheets needs a single
 * key to enumerate (the settings API cannot list keys), and the opener
 * already reads window options from it.
 *
 * Earlier builds also saved the sheet page's edits (cards) under a separate
 * settings key `sheet:<id>`, while the map only held the name. The first load
 * folds those separate keys into the map (see mergeLegacySheets).
 *
 * The pure helpers have no DOM or electron dependency; the async functions
 * take the settings api as an argument so they can be tested with a fake.
 */

export const SHEETS_KEY = 'sheets';

export const sheetKey = (sheetId) => `sheet:${sheetId}`;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Fold legacy per-sheet configs into the map.
 *
 * - Only sheets already in the map are considered (the legacy keys cannot be
 *   enumerated, and every sheet was created through the map).
 * - An entry already marked `legacyMerged` is left alone, so a stale legacy
 *   key never overwrites newer edits. Legacy keys are not deleted.
 * - Cards come from the legacy config when it has any (that is where they
 *   were saved); every other field keeps the map's value, with the legacy
 *   value filling gaps.
 *
 * @param {object|null|undefined} map the `sheets` map
 * @param {Record<string, object|null|undefined>} legacy legacy configs by `sheet:<id>` key
 * @returns {{map: object, changed: boolean}} new map (input is not mutated)
 */
export const mergeLegacySheets = (map, legacy) => {
  const out = {};
  let changed = false;
  for (const [key, entry] of Object.entries(isObject(map) ? map : {})) {
    const old = legacy?.[key];
    if (!isObject(entry) || entry.legacyMerged === true) {
      out[key] = entry;
      continue;
    }
    const merged = isObject(old) ? { ...old, ...entry } : { ...entry };
    if (isObject(old) && Array.isArray(old.items) && old.items.length > 0) {
      merged.items = old.items;
    }
    if (!Array.isArray(merged.items)) merged.items = [];
    merged.legacyMerged = true;
    out[key] = merged;
    changed = true;
  }
  return { map: out, changed };
};

const readValue = (result) => (result && !result.error ? (result.data ?? result.value ?? null) : null);

/**
 * Read the sheets map, migrating legacy per-sheet configs first if needed.
 * @returns {Promise<object>} map of `sheet:<id>` to config ({} if none)
 */
export const loadSheetsMap = async (api) => {
  const map = readValue(await api.settings.get(SHEETS_KEY));
  if (!isObject(map)) return {};
  const pending = Object.keys(map).filter(k => isObject(map[k]) && map[k].legacyMerged !== true);
  if (pending.length === 0) return map;

  const legacy = {};
  for (const key of pending) {
    legacy[key] = readValue(await api.settings.get(key));
  }
  const { map: merged, changed } = mergeLegacySheets(map, legacy);
  if (changed) {
    const result = await api.settings.set(SHEETS_KEY, merged);
    if (result && result.error) {
      console.error('[ext:sheets] Failed to save migrated sheets:', result.error);
    }
  }
  return merged;
};

/** @returns {Promise<object|null>} one sheet's config, or null */
export const loadSheet = async (api, sheetId) => {
  const map = await loadSheetsMap(api);
  return map[sheetKey(sheetId)] ?? null;
};

/**
 * Save one sheet's config into the map. Re-reads the map first so concurrent
 * edits to other sheets are not clobbered.
 */
export const saveSheet = async (api, sheetId, config) => {
  const map = await loadSheetsMap(api);
  map[sheetKey(sheetId)] = { ...config, legacyMerged: true };
  return api.settings.set(SHEETS_KEY, map);
};
