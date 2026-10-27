/**
 * Pure helpers for the sheets commands: reading a name out of a command
 * message, listing sheets as pickable options, and matching and renaming.
 *
 * No DOM or electron dependency, so they are unit tested directly.
 */

export const DEFAULT_SHEET_NAME = 'Untitled Sheet';

/**
 * The text a command message carries after the command name: the search text,
 * else the argument words, else the typed text with the command name removed.
 * Empty when none.
 *
 * @param {object|null|undefined} msg the command execution message
 * @param {string} commandName
 * @returns {string}
 */
export const argsFromCommandMessage = (msg, commandName) => {
  if (!msg) return '';
  const fromSearch = typeof msg.search === 'string' ? msg.search.trim() : '';
  if (fromSearch) return fromSearch;
  const fromParams = Array.isArray(msg.params) ? msg.params.join(' ').trim() : '';
  if (fromParams) return fromParams;
  const lowerName = commandName.toLowerCase();
  for (const text of [msg.typed, msg.value]) {
    if (typeof text !== 'string') continue;
    const trimmed = text.trim();
    if (trimmed.toLowerCase().startsWith(lowerName)) {
      const rest = trimmed.slice(commandName.length).trim();
      if (rest) return rest;
    }
  }
  return '';
};

/** `sheet:<id>` map key to `<id>`. */
export const sheetIdOfKey = (key) => String(key).replace(/^sheet:/, '');

/**
 * Sheets as choices for a command's name parameter. Plain data only: the
 * options cross a process boundary, so no functions.
 *
 * @param {Array<{key: string, name?: string, createdAt?: number, items?: any[]}>} sheets
 * @returns {Array<{value: string, title: string, subtitle?: string}>}
 */
export const sheetNameOptions = (sheets) =>
  (Array.isArray(sheets) ? sheets : [])
    .filter((s) => s && typeof s.name === 'string' && s.name)
    .map((s) => {
      const count = Array.isArray(s.items) ? s.items.length : null;
      const parts = [];
      if (count !== null) parts.push(count === 1 ? '1 card' : `${count} cards`);
      if (typeof s.createdAt === 'number') parts.push(`created ${new Date(s.createdAt).toLocaleDateString()}`);
      return {
        value: s.name,
        title: s.name,
        ...(parts.length ? { subtitle: parts.join(' · ') } : {})
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));

/**
 * Find the sheet a typed name means: exact name (any case), else a name that
 * contains it. Null when the query is empty or nothing matches.
 */
export const findSheetByName = (sheets, query) => {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  const list = Array.isArray(sheets) ? sheets : [];
  const named = (s) => (typeof s?.name === 'string' ? s.name.toLowerCase() : '');
  return list.find((s) => named(s) === q) || list.find((s) => named(s).includes(q)) || null;
};

/**
 * A sheet name from user input: trimmed, whitespace collapsed. Empty input
 * gives the default name.
 */
export const normalizeSheetName = (input) => {
  const name = String(input ?? '').replace(/\s+/g, ' ').trim();
  return name || DEFAULT_SHEET_NAME;
};

/**
 * A copy of a sheet config with a new name. Returns the config unchanged
 * (same object) when the name is blank, so a rename can never erase a name.
 */
export const withSheetName = (config, input) => {
  const name = String(input ?? '').replace(/\s+/g, ' ').trim();
  if (!name) return config;
  return { ...(config || {}), name };
};
