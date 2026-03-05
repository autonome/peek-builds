/**
 * Page Extension Background Script
 *
 * Page and window-related commands (open, modal)
 *
 * Runs in isolated extension process (peek://ext/page/background.html)
 */

const api = window.app;

const id = 'page';
const labels = {
  name: 'Page',
  description: 'Page and window commands'
};

// ===== URL Validation =====

/**
 * Validates and normalizes a URL string
 * @param {string} str - The string to check
 * @returns {Object} - Object with valid flag and normalized URL
 */
function getValidURL(str) {
  // Quick check for empty string
  if (!str) return { valid: false };

  // Check if it starts with a valid protocol
  const hasValidProtocol = /^(https?|ftp|file|peek):\/\//.test(str);

  if (!hasValidProtocol) {
    // Check if it looks like a domain (e.g., "example.com", "example.com/path", "localhost")
    // Pattern: domain.tld or domain.tld/path (with optional port for localhost)
    const isDomainPattern = /^([a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}(\/.*)?$/.test(str);
    const isLocalhost = /^localhost(:\d+)?(\/.*)?$/.test(str);

    if (isDomainPattern || isLocalhost) {
      // It's a domain without protocol, add https://
      const urlWithProtocol = 'https://' + str;
      try {
        // Validate the URL with added protocol
        new URL(urlWithProtocol);
        return { valid: true, url: urlWithProtocol };
      } catch (e) {
        return { valid: false };
      }
    }
    return { valid: false };
  }

  try {
    // Already has protocol, just validate
    new URL(str);
    return { valid: true, url: str };
  } catch (e) {
    return { valid: false };
  }
}

// ===== Command definitions =====

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

      // Check if the input is a valid URL and get the normalized version
      const urlResult = getValidURL(address);
      if (!urlResult.valid) {
        return { error: 'Invalid URL. Must be a valid URL starting with http://, https://, or other valid protocol.' };
      }

      // Use the normalized URL (with protocol added if needed)
      const normalizedAddress = urlResult.url;

      try {
        await api.window.open(normalizedAddress, {
          width: 1024,
          height: 768,
          trackingSource: 'cmd',
          trackingSourceId: 'open'
        });

        return {
          command: 'open',
          address: normalizedAddress,
          success: true
        };
      } catch (error) {
        console.error('[ext:page] Failed to open window:', error);
        return {
          error: 'Failed to open window: ' + error.message,
          address: normalizedAddress
        };
      }
    }
  },
  {
    name: 'modal',
    description: 'Open a URL in a modal window that hides on blur or escape',
    execute: async (ctx) => {
      const parts = ctx.typed.split(' ');
      parts.shift();

      const address = parts.shift();

      if (!address) {
        return { error: 'No address provided' };
      }

      try {
        await api.window.openModal(address, {
          width: 700,
          height: 500
        });
      } catch (error) {
        console.error('[ext:page] Failed to open modal window:', error);
        return { error: 'Failed to open modal window: ' + error.message };
      }

      return {
        command: 'modal',
        address
      };
    }
  }
];

// ===== Registration =====

let registeredCommands = [];

const initCommands = () => {
  commandDefinitions.forEach(cmd => {
    api.commands.register(cmd);
    registeredCommands.push(cmd.name);
  });
};

const uninitCommands = () => {
  registeredCommands.forEach(name => {
    api.commands.unregister(name);
  });
  registeredCommands = [];
};

const init = async () => {
  // Register commands (cmd loads first with its subscribers ready via 100ms head start)
  initCommands();
};

const uninit = () => {
  uninitCommands();
};

export default {
  id,
  init,
  uninit,
  labels
};
