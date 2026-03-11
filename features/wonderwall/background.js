/**
 * Wonderwall Background Script
 *
 * OAuth account manager for connected services.
 * Registers the "accounts" command to open the management UI.
 */

const hasPeekAPI = typeof window.app !== 'undefined';
const api = hasPeekAPI ? window.app : null;

function openWonderwall() {
  if (hasPeekAPI) {
    api.window.open('peek://ext/wonderwall/home.html', {
      role: 'workspace',
      key: 'wonderwall-home',
      width: 800,
      height: 600,
      title: 'Wonderwall'
    });
  }
}

const extension = {
  id: 'wonderwall',
  labels: {
    name: 'Wonderwall'
  },

  init() {
    if (!hasPeekAPI) return;

    api.commands.register({
      name: 'accounts',
      description: 'Open the connected accounts manager',
      execute: async () => {
        openWonderwall();
        return { success: true, message: 'Opening Wonderwall' };
      }
    });
  },

  uninit() {
    if (hasPeekAPI) {
      api.commands.unregister('accounts');
    }
  }
};

export default extension;
