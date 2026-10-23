/**
 * Per-sheet keys: pure helpers (no DOM, no electron) so they can be unit tested.
 *
 * A sheet config may carry `hotkey: {keys, scope}`:
 *   - keys:  an Electron accelerator such as "Alt+Shift+1"
 *   - scope: "global" (works while Peek is not the frontmost app) or "app"
 *            (only while a Peek window has focus)
 *
 * The sheets feature is lazy, so global keys are declared to the main process
 * as wake shortcuts: a press publishes SHEET_OPEN_TOPIC with the sheet id and
 * wakes the feature. App-scoped keys are registered locally by the awake
 * feature only.
 */

export const SHEET_OPEN_TOPIC = 'sheets:open';
export const SHEETS_CHANGED_TOPIC = 'sheets:settings-changed';
export const HOTKEY_SCOPES = ['global', 'app'];

const MODIFIER_ALIASES = {
  cmd: 'Command', command: 'Command', meta: 'Command', super: 'Command',
  ctrl: 'Control', control: 'Control',
  alt: 'Alt', option: 'Alt',
  shift: 'Shift',
  commandorcontrol: 'CommandOrControl', cmdorctrl: 'CommandOrControl'
};
const MODIFIER_ORDER = ['CommandOrControl', 'Command', 'Control', 'Alt', 'Shift'];

const KEY_ALIASES = {
  esc: 'Escape', escape: 'Escape', enter: 'Return', return: 'Return',
  arrowup: 'Up', up: 'Up', arrowdown: 'Down', down: 'Down',
  arrowleft: 'Left', left: 'Left', arrowright: 'Right', right: 'Right',
  space: 'Space', spacebar: 'Space', tab: 'Tab', backspace: 'Backspace', delete: 'Delete'
};

/**
 * Canonical form of an accelerator, so equivalent spellings compare equal
 * ("option+1" and "Alt+1"). Returns null when it is not a usable accelerator:
 * empty, no non-modifier key, more than one non-modifier key, or no modifier
 * (a bare letter would steal typing; function keys alone are allowed).
 *
 * @param {unknown} keys
 * @returns {string|null}
 */
export const normalizeAccelerator = (keys) => {
  if (typeof keys !== 'string') return null;
  const parts = keys.split('+').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const mods = new Set();
  let key = null;
  for (const part of parts) {
    const mod = MODIFIER_ALIASES[part.toLowerCase()];
    if (mod) {
      mods.add(mod);
      continue;
    }
    if (key !== null) return null;
    const alias = KEY_ALIASES[part.toLowerCase()];
    if (alias) key = alias;
    else if (/^f([1-9]|1\d|2[0-4])$/i.test(part)) key = part.toUpperCase();
    else if (part.length === 1) key = part.toUpperCase();
    else return null;
  }
  if (key === null) return null;
  const isFunctionKey = /^F\d+$/.test(key);
  if (mods.size === 0 && !isFunctionKey) return null;
  return [...MODIFIER_ORDER.filter(m => mods.has(m)), key].join('+');
};

/**
 * Accelerator for a keydown event, or null while only modifiers are held (or
 * the key is not one an accelerator can use). Uses `code` for letters and
 * digits because Alt changes `key` on macOS ("Alt+1" reports "¡").
 *
 * @param {{key?: string, code?: string, metaKey?: boolean, ctrlKey?: boolean, altKey?: boolean, shiftKey?: boolean}} e
 * @returns {string|null}
 */
export const acceleratorFromKeyEvent = (e) => {
  if (!e) return null;
  let key = null;
  const code = e.code || '';
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^F\d+$/.test(e.key || '')) key = e.key;
  else if (e.key) key = KEY_ALIASES[e.key.toLowerCase()] || (e.key.length === 1 ? e.key.toUpperCase() : null);
  if (!key || key === 'Escape' || key === 'Backspace' || key === 'Delete') return null;
  const mods = [];
  if (e.metaKey) mods.push('Command');
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  return normalizeAccelerator([...mods, key].join('+'));
};

/**
 * A sheet config's hotkey, validated. Never throws.
 * @param {object|null|undefined} config
 * @returns {{keys: string, scope: 'global'|'app'}|null} null means no key
 */
export const resolveSheetHotkey = (config) => {
  const hk = config?.hotkey;
  const keys = normalizeAccelerator(hk?.keys);
  if (!keys) return null;
  return { keys, scope: hk.scope === 'app' ? 'app' : 'global' };
};

/**
 * Return a new config with its hotkey set, or removed when `hotkey` is null.
 */
export const withSheetHotkey = (config, hotkey) => {
  const next = { ...(config || {}) };
  const keys = normalizeAccelerator(hotkey?.keys);
  if (!keys) {
    delete next.hotkey;
    return next;
  }
  next.hotkey = { keys, scope: hotkey.scope === 'app' ? 'app' : 'global' };
  return next;
};

const sheetIdOfKey = (key) => (key.startsWith('sheet:') ? key.slice('sheet:'.length) : key);

/**
 * Another sheet already using the accelerator, if any.
 *
 * @param {object} sheetsMap the `sheets` settings map
 * @param {string} sheetId sheet being edited (ignored in the search)
 * @param {string} keys accelerator to check
 * @returns {{sheetId: string, name: string}|null}
 */
export const findHotkeyConflict = (sheetsMap, sheetId, keys) => {
  const wanted = normalizeAccelerator(keys);
  if (!wanted || !sheetsMap || typeof sheetsMap !== 'object') return null;
  for (const [key, config] of Object.entries(sheetsMap)) {
    const id = sheetIdOfKey(key);
    if (id === sheetId) continue;
    if (resolveSheetHotkey(config)?.keys === wanted) {
      return { sheetId: id, name: typeof config?.name === 'string' ? config.name : id };
    }
  }
  return null;
};

/**
 * Build what the sheets feature registers from the saved sheets map.
 *
 * Two sheets can end up with the same key (edited on another device, or
 * synced). The first one in map order keeps it and later ones are skipped and
 * reported, so a key never opens two sheets.
 *
 * @param {object|null|undefined} sheetsMap the `sheets` settings map
 * @returns {{
 *   wake: Array<{accelerator: string, wakeTopic: string, wakeArgs: string[]}>,
 *   local: Array<{keys: string, sheetId: string}>,
 *   skipped: Array<{sheetId: string, keys: string, keptBy: string}>
 * }}
 */
export const buildSheetShortcuts = (sheetsMap) => {
  const wake = [];
  const local = [];
  const skipped = [];
  const taken = new Map();
  if (!sheetsMap || typeof sheetsMap !== 'object') return { wake, local, skipped };
  for (const [key, config] of Object.entries(sheetsMap)) {
    const hk = resolveSheetHotkey(config);
    if (!hk) continue;
    const sheetId = sheetIdOfKey(key);
    if (taken.has(hk.keys)) {
      skipped.push({ sheetId, keys: hk.keys, keptBy: taken.get(hk.keys) });
      continue;
    }
    taken.set(hk.keys, sheetId);
    if (hk.scope === 'global') {
      wake.push({ accelerator: hk.keys, wakeTopic: SHEET_OPEN_TOPIC, wakeArgs: [sheetId] });
    } else {
      local.push({ keys: hk.keys, sheetId });
    }
  }
  return { wake, local, skipped };
};
