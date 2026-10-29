/**
 * Commands that open a window, and the window they would open already being open.
 *
 * A command may declare `opensUrl`, the address of the window it opens. When a
 * window showing that address is open, the results list gets a "Switch to window"
 * row right after that command's row; picking the command itself still runs it.
 * `openWindowIds` is a Map of address -> window id (null or missing when no window
 * shows it).
 */

/** Text before the command name on a switch row. */
export const SWITCH_ROW_PREFIX = 'Switch to window: ';

/**
 * The open window a command would switch to: `{ url, id }`, or null when the
 * command opens no window or that window is not open.
 */
export function openWindowForCommand(command, openWindowIds) {
  const url = command && command.opensUrl;
  if (typeof url !== 'string' || url.length === 0) return null;
  const id = openWindowIds && typeof openWindowIds.get === 'function' ? openWindowIds.get(url) : undefined;
  return typeof id === 'number' ? { url, id } : null;
}

/** Addresses of the windows the named commands open, without repeats. */
export function commandOpenUrls(commands, names) {
  const urls = new Set();
  for (const name of names || []) {
    const url = commands && commands[name] && commands[name].opensUrl;
    if (typeof url === 'string' && url.length > 0) urls.add(url);
  }
  return [...urls];
}

/**
 * The row names with a switch row after each command row whose window is open.
 * Rows already in `names` that were switch rows are dropped first, so this can
 * be re-applied when the open windows change.
 *
 * @param {string[]} names - Row names, switch rows from an earlier call allowed
 * @param {Object} commands - Command name -> command
 * @param {Map} openWindowIds - Address -> window id
 * @param {Map} previousRows - Switch rows from the earlier call (row name -> target)
 * @returns {{matches: string[], rows: Map<string, {command: string, url: string}>}}
 */
export function withSwitchRows(names, commands, openWindowIds, previousRows) {
  const rows = new Map();
  const matches = [];
  for (const name of names) {
    if (previousRows && previousRows.has(name)) continue;
    matches.push(name);
    const target = commands && commands[name] ? openWindowForCommand(commands[name], openWindowIds) : null;
    if (!target) continue;
    const rowName = SWITCH_ROW_PREFIX + name;
    rows.set(rowName, { command: name, url: target.url });
    matches.push(rowName);
  }
  return { matches, rows };
}
