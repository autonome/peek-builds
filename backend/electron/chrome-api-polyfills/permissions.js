/**
 * chrome.permissions Polyfill for Electron
 *
 * Electron does not implement chrome.permissions. This polyfill provides
 * a no-op implementation that reports all manifest permissions as granted.
 * This is appropriate because Electron extensions are loaded with full
 * permissions and there is no runtime permission prompt mechanism.
 *
 * Note: The service worker also needs a separate inline shim prepended to
 * background.js because the SW loads before polyfill injection can run.
 * This polyfill covers extension UI pages (options, popup, etc).
 *
 * @module permissions
 * @see https://developer.chrome.com/docs/extensions/reference/api/permissions
 */

const API = 'permissions';

/**
 * Set up main process handlers for the permissions polyfill.
 * This is a no-op since permissions is purely client-side.
 *
 * @param {import('electron').Session} _session
 * @param {Object} _options
 * @returns {{ cleanup: () => void }}
 */
export function setupMainProcess(_session, _options = {}) {
  return {
    cleanup() {
      // No-op: permissions polyfill has no main-process state
    },
  };
}

/**
 * Get the preload script source for the permissions polyfill.
 * Injects chrome.permissions and browser.permissions (if browser exists)
 * into the extension page context.
 *
 * @returns {string} JavaScript source to execute in extension contexts
 */
export function getPreloadScript() {
  return `
/* chrome.permissions polyfill for Electron */
(function() {
  if (typeof chrome === 'undefined') return;
  if (chrome.permissions) return;

  function NoopEvent() { this._l = []; }
  NoopEvent.prototype.addListener = function(fn) { this._l.push(fn); };
  NoopEvent.prototype.removeListener = function(fn) {
    this._l = this._l.filter(function(x) { return x !== fn; });
  };
  NoopEvent.prototype.hasListener = function(fn) { return this._l.indexOf(fn) !== -1; };
  NoopEvent.prototype.hasListeners = function() { return this._l.length > 0; };

  function makePermissions() {
    return {
      contains: function(_perms) { return Promise.resolve(true); },
      getAll: function() {
        try {
          var m = chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest() : {};
          return Promise.resolve({ permissions: m.permissions || [], origins: m.host_permissions || [] });
        } catch(e) { return Promise.resolve({ permissions: [], origins: [] }); }
      },
      request: function(_perms) { return Promise.resolve(true); },
      remove: function(_perms) { return Promise.resolve(true); },
      onAdded: new NoopEvent(),
      onRemoved: new NoopEvent()
    };
  }

  chrome.permissions = makePermissions();

  if (typeof browser !== 'undefined' && browser && !browser.permissions) {
    browser.permissions = makePermissions();
  }
})();
`;
}
