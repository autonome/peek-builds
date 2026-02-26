/**
 * chrome.permissions Polyfill for Electron
 *
 * Electron does not implement chrome.permissions. This polyfill provides
 * a no-op implementation that reports all manifest permissions as granted.
 * This is appropriate because Electron extensions are loaded with full
 * permissions and there is no runtime permission prompt mechanism.
 *
 * Supports both Promise and callback invocation styles because
 * webextension-polyfill calls Chrome APIs with callbacks.
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
 * into the extension page context. Supports both callback and Promise styles.
 *
 * Unlike a simple "if (!chrome.permissions)" guard, this polyfill forcibly
 * patches all permission methods. Electron may provide a native
 * chrome.permissions binding with a broken request() that always returns
 * denied. We must override those methods regardless of whether the object
 * already exists, and defend against the native binding arriving later
 * (race condition similar to chrome.storage).
 *
 * @returns {string} JavaScript source to execute in extension contexts
 */
export function getPreloadScript() {
  return `
/* chrome.permissions polyfill for Electron — completely replaces chrome.permissions.
 * Saves a reference to the real chrome object, creates a complete permissions object,
 * and installs it as non-configurable to prevent overwrites by native bindings or
 * extension code (e.g. Proton Pass Proxy replacement). No polling needed. */
(function() {
  if (typeof chrome === 'undefined') return;

  var DEBUG_PERMISSIONS = false;
  function _log() { if (DEBUG_PERMISSIONS) console.log.apply(console, ['[peek:permissions:preload]'].concat(Array.prototype.slice.call(arguments))); }

  function NoopEvent() { this._l = []; }
  NoopEvent.prototype.addListener = function(fn) { this._l.push(fn); };
  NoopEvent.prototype.removeListener = function(fn) {
    this._l = this._l.filter(function(x) { return x !== fn; });
  };
  NoopEvent.prototype.hasListener = function(fn) { return this._l.indexOf(fn) !== -1; };
  NoopEvent.prototype.hasListeners = function() { return this._l.length > 0; };

  /* Save reference to the REAL chrome object */
  var _chrome = chrome;

  var _permsObj = {
    contains: function(perms, callback) {
      _log('contains called with:', JSON.stringify(perms));
      try { delete _chrome.runtime.lastError; } catch(e) {}
      _log('contains returning true');
      if (typeof callback === 'function') callback(true);
      return Promise.resolve(true);
    },
    getAll: function(callback) {
      _log('getAll called');
      var result = { permissions: [], origins: [] };
      try {
        if (_chrome.runtime && _chrome.runtime.getManifest) {
          var m = _chrome.runtime.getManifest();
          result = { permissions: m.permissions || [], origins: m.host_permissions || [] };
        }
      } catch(e) {}
      try { delete _chrome.runtime.lastError; } catch(e) {}
      _log('getAll returning:', JSON.stringify(result));
      if (typeof callback === 'function') callback(result);
      return Promise.resolve(result);
    },
    request: function(perms, callback) {
      _log('request called with:', JSON.stringify(perms));
      try { delete _chrome.runtime.lastError; } catch(e) {}
      _log('request returning true');
      if (typeof callback === 'function') callback(true);
      return Promise.resolve(true);
    },
    remove: function(perms, callback) {
      _log('remove called with:', JSON.stringify(perms));
      try { delete _chrome.runtime.lastError; } catch(e) {}
      _log('remove returning true');
      if (typeof callback === 'function') callback(true);
      return Promise.resolve(true);
    },
    onAdded: new NoopEvent(),
    onRemoved: new NoopEvent()
  };

  /* Save backup ref for verification */
  globalThis.__peekPermissions = _permsObj;

  /**
   * Install our permissions object on a root object, making it non-configurable.
   * Three attempts: defineProperty, delete+defineProperty, direct assignment.
   */
  function installPermissions(root, name) {
    if (!root || typeof root !== 'object') return false;
    try {
      Object.defineProperty(root, name, { value: _permsObj, writable: false, configurable: false, enumerable: true });
      _log('installed on', name, 'via defineProperty (non-configurable)');
      return true;
    } catch(e) { _log('defineProperty failed on', name, ':', e.message); }
    try {
      delete root[name];
      Object.defineProperty(root, name, { value: _permsObj, writable: false, configurable: false, enumerable: true });
      _log('installed on', name, 'via delete+defineProperty');
      return true;
    } catch(e) { _log('delete+defineProperty failed on', name, ':', e.message); }
    try {
      root[name] = _permsObj;
      _log('installed on', name, 'via direct assignment');
      return true;
    } catch(e) { _log('direct assignment failed on', name, ':', e.message); }
    return false;
  }

  var installed = installPermissions(_chrome, 'permissions');
  _log('shim installed on chrome.permissions:', installed, 'chrome.permissions.request:', typeof _chrome.permissions.request);

  // Also patch browser.permissions if browser object exists
  if (typeof browser !== 'undefined' && browser) {
    installPermissions(browser, 'permissions');
  }
})();
`;
}
