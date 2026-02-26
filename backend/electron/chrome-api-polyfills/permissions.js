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
/* chrome.permissions polyfill for Electron — force-patches all methods */
(function() {
  if (typeof chrome === 'undefined') return;

  function NoopEvent() { this._l = []; }
  NoopEvent.prototype.addListener = function(fn) { this._l.push(fn); };
  NoopEvent.prototype.removeListener = function(fn) {
    this._l = this._l.filter(function(x) { return x !== fn; });
  };
  NoopEvent.prototype.hasListener = function(fn) { return this._l.indexOf(fn) !== -1; };
  NoopEvent.prototype.hasListeners = function() { return this._l.length > 0; };

  var _onAdded = new NoopEvent();
  var _onRemoved = new NoopEvent();

  var _methods = {
    contains: function(perms, callback) {
      try { delete chrome.runtime.lastError; } catch(e) {}
      if (typeof callback === 'function') callback(true);
      return Promise.resolve(true);
    },
    getAll: function(callback) {
      var result = { permissions: [], origins: [] };
      try {
        if (chrome.runtime && chrome.runtime.getManifest) {
          var m = chrome.runtime.getManifest();
          result = { permissions: m.permissions || [], origins: m.host_permissions || [] };
        }
      } catch(e) {}
      try { delete chrome.runtime.lastError; } catch(e) {}
      if (typeof callback === 'function') callback(result);
      return Promise.resolve(result);
    },
    request: function(perms, callback) {
      try { delete chrome.runtime.lastError; } catch(e) {}
      if (typeof callback === 'function') callback(true);
      return Promise.resolve(true);
    },
    remove: function(perms, callback) {
      try { delete chrome.runtime.lastError; } catch(e) {}
      if (typeof callback === 'function') callback(true);
      return Promise.resolve(true);
    }
  };

  /**
   * Force-patch a permissions object: override every method with our shim
   * using non-configurable defineProperty so native bindings cannot replace them.
   */
  function patchPermissions(obj) {
    if (!obj || typeof obj !== 'object') return;
    var keys = Object.keys(_methods);
    for (var i = 0; i < keys.length; i++) {
      var name = keys[i];
      try {
        Object.defineProperty(obj, name, {
          value: _methods[name],
          writable: false,
          configurable: false,
          enumerable: true,
        });
      } catch(e) {
        // Fallback: direct assignment if defineProperty is rejected
        try { obj[name] = _methods[name]; } catch(e2) { /* give up */ }
      }
    }
    // Ensure event objects exist
    if (!obj.onAdded) {
      try { Object.defineProperty(obj, 'onAdded', { value: _onAdded, writable: false, configurable: false, enumerable: true }); } catch(e) { try { obj.onAdded = _onAdded; } catch(e2) {} }
    }
    if (!obj.onRemoved) {
      try { Object.defineProperty(obj, 'onRemoved', { value: _onRemoved, writable: false, configurable: false, enumerable: true }); } catch(e) { try { obj.onRemoved = _onRemoved; } catch(e2) {} }
    }
  }

  function ensurePermissions() {
    if (!chrome.permissions) {
      // No native binding — install our full object
      try {
        Object.defineProperty(chrome, 'permissions', {
          value: {},
          writable: true,
          configurable: true,
          enumerable: true,
        });
      } catch(e) {
        try { chrome.permissions = {}; } catch(e2) { return; }
      }
    }
    patchPermissions(chrome.permissions);

    // Also patch browser.permissions if browser object exists
    if (typeof browser !== 'undefined' && browser) {
      if (!browser.permissions) {
        try { browser.permissions = {}; } catch(e) {}
      }
      if (browser.permissions) patchPermissions(browser.permissions);
    }
  }

  // Patch immediately
  ensurePermissions();

  // Defend against native binding arriving later (race condition).
  // Electron's C++ binding may override chrome.permissions after our script
  // runs. Poll briefly to re-patch if the native binding replaces our methods.
  var _pollCount = 0;
  var _maxPolls = 60; // ~1 second at 60fps
  function _pollForNativeOverride() {
    _pollCount++;
    // Check if our request shim was replaced (native binding would not return Promise.resolve(true))
    if (chrome.permissions && chrome.permissions.request !== _methods.request) {
      patchPermissions(chrome.permissions);
    }
    if (_pollCount < _maxPolls) {
      if (typeof requestAnimationFrame !== 'undefined') {
        requestAnimationFrame(_pollForNativeOverride);
      } else {
        setTimeout(_pollForNativeOverride, 16);
      }
    }
  }
  if (typeof requestAnimationFrame !== 'undefined') {
    requestAnimationFrame(_pollForNativeOverride);
  } else if (typeof setTimeout !== 'undefined') {
    setTimeout(_pollForNativeOverride, 16);
  }
})();
`;
}
