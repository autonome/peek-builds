/**
 * Commands that open a window, and the window they would open already being open.
 *
 * A command may declare `opensUrl`, the address of the window it opens. When a
 * window showing that address is open, the command's row carries the "Switch to
 * window" marker; picking the command itself still runs it. `openWindowIds` is a
 * Map of address -> window id (null or missing when no window shows it).
 */

/** Only web pages and peek pages can be "open in a window". */
export function isSwitchableUrl(url) {
  return typeof url === 'string' && /^(https?|peek):\/\//.test(url);
}

/**
 * The one key a page is known by in `openWindowIds`: the same page maps to the
 * same key whatever form its address was written in. Web addresses ignore the
 * scheme, a leading `www.`, host case, default ports, a trailing slash, empty
 * query/fragment and query order (`wikipedia.org`, `https://wikipedia.org/`
 * and `http://www.Wikipedia.org` are one key). peek:// addresses ignore a
 * trailing slash. Null for an address that cannot be open in a window.
 */
export function addressKey(address) {
  if (!isSwitchableUrl(address)) return null;
  const raw = address.trim();
  if (raw.startsWith('peek://')) return 'peek:' + raw.slice('peek://'.length).replace(/\/+$/, '');
  try {
    const u = new URL(raw);
    let host = u.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    const port = u.port && !((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443'))
      ? ':' + u.port
      : '';
    const path = u.pathname.replace(/\/+$/, '');
    const search = new URLSearchParams([...new URLSearchParams(u.search).entries()].sort()).toString();
    return 'web:' + host + port + path + (search ? '?' + search : '') + (u.hash.length > 1 ? u.hash : '');
  } catch {
    return null;
  }
}

/** The id of the window showing `address`, or null when none is open (or not yet asked). */
export function openWindowIdFor(address, openWindowIds) {
  const key = addressKey(address);
  const id = key !== null && openWindowIds && typeof openWindowIds.get === 'function' ? openWindowIds.get(key) : undefined;
  return typeof id === 'number' ? id : null;
}

/** Whether `openWindowIds` already holds an answer (open or not) for `address`. */
export function hasOpenWindowAnswer(address, openWindowIds) {
  const key = addressKey(address);
  return key !== null && openWindowIds.has(key);
}

/**
 * A copy of `openWindowIds` with the answers in `ids` (address -> window id or
 * null, as main returns for the addresses asked about) folded in. Addresses
 * that share a key count as one page: open if any of them is.
 */
export function withOpenWindowAnswers(openWindowIds, askedUrls, ids) {
  const answers = new Map();
  for (const url of askedUrls) {
    const key = addressKey(url);
    if (key === null) continue;
    const id = ids && typeof ids[url] === 'number' ? ids[url] : null;
    if (id !== null || !answers.has(key)) answers.set(key, id);
  }
  const next = new Map(openWindowIds);
  for (const [key, id] of answers) next.set(key, id);
  return next;
}

/**
 * The address of the thing plain Enter would act on right now, in the order
 * Enter picks among them. Each argument is an address string or null:
 * `highlighted` is { active, address } for a row picked by arrowing into the list
 * (decisive when active, even without an address); then the shown inline
 * completion, the typed address, the auto-selected row, and the command a
 * fully-typed name would run. Used by the input-bar button, the lookup set,
 * and Cmd+Enter alike.
 */
export function inputTargetAddress({ highlighted, completion, typed, selectedRow, command }) {
  if (highlighted && highlighted.active) return highlighted.address || null;
  return completion || typed || selectedRow || command || null;
}

/**
 * The open window a command would switch to: `{ url, id }`, or null when the
 * command opens no window or that window is not open.
 */
export function openWindowForCommand(command, openWindowIds) {
  const url = command && command.opensUrl;
  if (typeof url !== 'string' || url.length === 0) return null;
  const id = openWindowIdFor(url, openWindowIds);
  return id !== null ? { url, id } : null;
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
