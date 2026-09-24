/**
 * Page — `open` and `modal` command registration.
 *
 * Runs INSIDE the core background renderer (app/index.js imports this
 * module and awaits initPage()). Previously this ran in a separate
 * `peek://page/background.html` resident BrowserWindow created by
 * page-glue.ts; that window is gone — the logic moved into the core
 * renderer alongside cmd.
 *
 * The fullscreen-transparent canvas page windows (one per URL) are
 * created on demand by `api.window.open(...)` from the `open` / `modal`
 * command handlers below. That canvas architecture (in
 * app/page/index.html + app/page/page.js) is FROZEN — unchanged by
 * this consolidation.
 */

import { isLoopbackAddress, withDefaultScheme } from '../cmd/url-completion.js';

const api = window.app;

/**
 * Validate and normalize a URL string.
 */
function getValidURL(str) {
  if (!str) return { valid: false };

  const hasValidProtocol = /^(https?|ftp|file|peek):\/\//.test(str);

  if (!hasValidProtocol) {
    const isDomainPattern = /^([a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}(\/.*)?$/.test(str);

    if (isDomainPattern || isLoopbackAddress(str)) {
      const urlWithProtocol = withDefaultScheme(str);
      try {
        new URL(urlWithProtocol);
        return { valid: true, url: urlWithProtocol };
      } catch {
        return { valid: false };
      }
    }
    return { valid: false };
  }

  try {
    new URL(str);
    return { valid: true, url: str };
  } catch {
    return { valid: false };
  }
}

const commandDefinitions = [
  {
    name: 'open',
    description: 'Open a URL in a new window',
    execute: async (ctx) => {
      const parts = ctx.typed.split(' ');
      parts.shift();
      const address = parts.shift();

      if (!address) {
        return { error: 'No address provided' };
      }

      const urlResult = getValidURL(address);
      if (!urlResult.valid) {
        return { error: 'Invalid URL. Must be a valid URL starting with http://, https://, or other valid protocol.' };
      }

      const normalizedAddress = urlResult.url;

      try {
        await api.window.open(normalizedAddress, {
          width: 1024,
          height: 768,
          trackingSource: 'cmd',
          trackingSourceId: 'open',
        });

        return {
          command: 'open',
          address: normalizedAddress,
          success: true,
        };
      } catch (error) {
        console.error('[page] Failed to open window:', error);
        return {
          error: 'Failed to open window: ' + error.message,
          address: normalizedAddress,
        };
      }
    },
  },
];

const registeredCommands = [];

export const init = async () => {
  for (const cmd of commandDefinitions) {
    api.commands.register(cmd);
    registeredCommands.push(cmd.name);
  }
};

export const uninit = async () => {
  for (const name of registeredCommands) {
    api.commands.unregister(name);
  }
  registeredCommands.length = 0;
};

export { init as initPage, uninit as uninitPage };
