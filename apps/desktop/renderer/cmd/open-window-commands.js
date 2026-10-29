/**
 * Commands that open a window, and the window they would open already being open.
 *
 * A command may declare `opensUrl`, the address of the window it opens. When a
 * window showing that address is open, the command's row carries the "Switch to
 * window" marker; picking the command itself still runs it. `openWindowIds` is a
 * Map of address -> window id (null or missing when no window shows it).
 */

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
